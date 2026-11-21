/**
 * The lease's race windows, held open by hand. `lease.test.ts` drives the
 * lease against a real filesystem, where these windows are a few microseconds
 * wide: a lock released between a refused create and the read of its holder, a
 * faster reclaimer replacing a dead holder's lock, and Windows answering EPERM
 * for a name it has not let go of yet. Here `node:fs` is wrapped so each one
 * happens exactly when the test says, and everything else is the real disk.
 */
import { spawnSync } from 'node:child_process'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import type * as Fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({
  /** What the next exclusive creates of a session lock answer, first to last; then the real filesystem answers. */
  lockCreateErrors: [] as string[],
  /** The same answer for EVERY exclusive create of a session lock, each one moving the (faked) clock on by this much. */
  lockCreateAlways: undefined as { code: string; advanceMs: number } | undefined,
  /** One entry per exclusive create of a session lock: the code it answered, or `created`. */
  lockCreates: [] as string[],
  /** Run once, when an exclusive create of a session lock has just answered EEXIST and before its caller sees that. */
  onLockExists: undefined as ((lock: string) => void) | undefined,
  /** Run before each read of a session lock, with how many reads of one came before it. */
  beforeLockRead: undefined as ((lock: string, readsBefore: number) => void) | undefined,
  lockReads: 0,
}))

const real = await vi.importActual<typeof Fs>('node:fs')

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  const isLock = (path: Fs.PathOrFileDescriptor): boolean => String(path).endsWith('.jsonl.lock')
  return {
    ...actual,
    writeFileSync: (path: Fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: Fs.WriteFileOptions) => {
      const exclusive = typeof options === 'object' && options !== null && options.flag === 'wx'
      if (!exclusive || !isLock(path)) return actual.writeFileSync(path, data, options)
      const code = control.lockCreateAlways?.code ?? control.lockCreateErrors.shift()
      if (code !== undefined) {
        control.lockCreates.push(code)
        if (control.lockCreateAlways !== undefined) vi.setSystemTime(Date.now() + control.lockCreateAlways.advanceMs)
        throw Object.assign(new Error(`${code}: operation not permitted, open '${String(path)}'`), { code })
      }
      try {
        actual.writeFileSync(path, data, options)
        control.lockCreates.push('created')
      } catch (error) {
        const answered = (error as NodeJS.ErrnoException).code ?? 'unknown'
        control.lockCreates.push(answered)
        if (answered === 'EEXIST') {
          const hook = control.onLockExists
          control.onLockExists = undefined
          hook?.(String(path))
        }
        throw error
      }
    },
    readFileSync: (path: Fs.PathOrFileDescriptor, options?: unknown) => {
      if (isLock(path)) {
        const readsBefore = control.lockReads
        control.lockReads += 1
        control.beforeLockRead?.(String(path), readsBefore)
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, options)
    },
  }
})

const { createRoot } = await import('../../kernel/index.ts')
const { asSessionId } = await import('../../core/ids.ts')
const { createUserMessage } = await import('../../core/llm/message.ts')
const { PERSISTENCE } = await import('../../core/persistence/index.ts')
const { SESSIONS, sessionPlugin, TURN_END, TURN_START, USER_MESSAGE } = await import('../../core/session/index.ts')
const { persistenceJsonlPlugin } = await import('./index.ts')

type Root = Awaited<ReturnType<typeof createRoot>>
let dir: string | undefined
let root: Root | undefined

beforeEach(() => {
  control.lockCreateErrors = []
  control.lockCreateAlways = undefined
  control.lockCreates = []
  control.onLockExists = undefined
  control.beforeLockRead = undefined
  control.lockReads = 0
})

afterEach(async () => {
  vi.useRealTimers()
  control.lockCreateErrors = []
  control.lockCreateAlways = undefined
  control.onLockExists = undefined
  control.beforeLockRead = undefined
  await root?.dispose()
  root = undefined
  if (dir) real.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

/** A stored, closed session `id` with one balanced turn, and the root that will resume it; `arm` sets a fault for the acquisition alone. */
async function stored(id: string): Promise<{ lock: string; resume: (arm?: () => void) => { flush(): Promise<void> } }> {
  dir = real.mkdtempSync(join(tmpdir(), 'minidsh-lease-faults-'))
  root = createRoot({ logger: { warn: () => {}, error: () => {} } })
  root.plugin(sessionPlugin)
  root.plugin(persistenceJsonlPlugin, { root: dir })
  await root.settle()
  const sessions = root.get(SESSIONS)
  const session = sessions.create({ cwd: '/w', id: asSessionId(id) })
  session.append(TURN_START, { turn: 1 })
  session.append(USER_MESSAGE, { message: createUserMessage('go') }, { surfaceOp: { op: 'append' } })
  session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
  await sessions.detach(session)
  const lock = join(dir, `${id}.jsonl.lock`)
  expect(real.existsSync(lock), 'the first lifecycle released its lease').toBe(false)
  const persistence = root.get(PERSISTENCE)
  return {
    lock,
    resume: (arm) => {
      // The cold read comes first, as `agents.resume` does it, and reads the
      // lock too: the counters and the fault start at the acquisition itself.
      const read = persistence.load(id)!
      control.lockCreates = []
      control.lockReads = 0
      arm?.()
      return sessions.create({ cwd: read.header.cwd, id: read.header.id, createdAt: read.header.createdAt, seed: read.events, origin: 'resumed' })
    },
  }
}

/** A flush rejects with the listener failures aggregated; the provider's own words are the first. */
const refusal = async (flushing: Promise<void>): Promise<string> => {
  const error = await flushing.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  if (error === undefined) return 'the flush resolved'
  return ((error as AggregateError).errors?.[0] as Error | undefined)?.message ?? String(error)
}

const holderOf = (lock: string): { pid?: number; acquiredAt?: number } => JSON.parse(real.readFileSync(lock, 'utf8')) as { pid?: number; acquiredAt?: number }

describe('persistence-jsonl: the lease, where the filesystem answers late', () => {
  /**
   * Windows keeps a removed name DELETE-PENDING while any handle is open on it
   * (a cold reader's read of the lease, an antivirus scan), and creating it
   * again answers EPERM, EACCES or EBUSY rather than EEXIST. Nobody holds such
   * a lock, so the acquisition waits it out. Everywhere else those codes mean
   * what they say and are not retried.
   */
  it('waits out a lock name Windows has not let go of yet, and nowhere else', async () => {
    const { lock, resume } = await stored('pending')
    const outcome = await refusal(resume(() => (control.lockCreateErrors = ['EPERM', 'EACCES', 'EBUSY'])).flush())
    if (process.platform === 'win32') {
      expect({ outcome, creates: control.lockCreates }).toEqual({ outcome: 'the flush resolved', creates: ['EPERM', 'EACCES', 'EBUSY', 'created'] })
      expect(holderOf(lock).pid).toBe(process.pid)
    } else {
      expect(control.lockCreates).toEqual(['EPERM'])
      expect(outcome).toMatch(/could not be persisted: EPERM/)
      expect(real.existsSync(lock)).toBe(false)
    }
  })

  it.skipIf(process.platform !== 'win32')('gives up on a name that never frees, with the real error, once its bound has passed', async () => {
    const { lock, resume } = await stored('stuck')
    // Only the clock is faked: each refused create moves it on, so the bound
    // passes in three or four asks instead of a real second.
    vi.useFakeTimers({ toFake: ['Date'] })
    const outcome = await refusal(resume(() => (control.lockCreateAlways = { code: 'EPERM', advanceMs: 400 })).flush())
    expect(outcome).toMatch(/could not be persisted: EPERM/)
    expect(control.lockCreates.every((code) => code === 'EPERM'), control.lockCreates.join(',')).toBe(true)
    // More than one ask (it waited), and a bounded number of them (it stopped).
    expect(control.lockCreates.length, control.lockCreates.join(',')).toBeGreaterThan(1)
    expect(control.lockCreates.length, control.lockCreates.join(',')).toBeLessThan(10)
    expect(real.existsSync(lock)).toBe(false)
  })

  it('asks again for a lock its holder released between the refused create and the read of who held it', async () => {
    const { lock, resume } = await stored('released')
    // A live holder (this process, an earlier lease) that lets go at the worst moment.
    real.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: 1, uptime: uptime(), platform: process.platform }))
    const outcome = await refusal(resume(() => (control.onLockExists = (path) => real.unlinkSync(path))).flush())
    // Not "locked by an unreadable holder; remove <a file that is not there>".
    expect({ outcome, creates: control.lockCreates }).toEqual({ outcome: 'the flush resolved', creates: ['EEXIST', 'created'] })
    expect(holderOf(lock).acquiredAt).not.toBe(1)
    expect(holderOf(lock).pid).toBe(process.pid)
  })

  /**
   * Two reclaimers of one dead holder. The faster one has already replaced the
   * dead lock with its own live one by the time this one holds the steal
   * mutex: the re-probe under the mutex is what stops this one from deleting
   * that live lock, and the refusal has to name the holder that is there NOW.
   * Naming the dead one would tell a person to remove a live lease.
   */
  it('leaves a faster reclaimer\'s live lock alone, and names that holder in the refusal', async () => {
    const { lock, resume } = await stored('raced')
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    real.writeFileSync(lock, JSON.stringify({ pid: deadPid, host: hostname(), acquiredAt: 1 }))
    const winner = JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: 2, uptime: uptime(), platform: process.platform })
    const reads: string[] = []
    const winnerArrives = (path: string, readsBefore: number): void => {
      // Read 0 finds the dead holder; read 1 is the re-probe under the mutex.
      if (readsBefore !== 1) return
      reads.push(`mutex held: ${real.existsSync(`${path}.steal`)}`)
      real.writeFileSync(path, winner)
    }
    const outcome = await refusal(resume(() => (control.beforeLockRead = winnerArrives)).flush())
    expect(reads, 'the winner took the lock while this reclaimer held the steal mutex').toEqual(['mutex held: true'])
    expect(outcome).toMatch(new RegExp(`locked by pid ${process.pid} on `))
    expect(outcome).not.toContain(`pid ${deadPid} `)
    expect(outcome).not.toContain('.steal')
    // The winner's lock, byte for byte, and no mutex left behind.
    expect(real.readFileSync(lock, 'utf8')).toBe(winner)
    expect(real.existsSync(`${lock}.steal`)).toBe(false)
  })
})
