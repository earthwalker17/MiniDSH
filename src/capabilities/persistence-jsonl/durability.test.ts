/**
 * `session/flush` is on stable storage when it resolves (`durability: 'synced'`),
 * and crash repair leans on exactly that (§4). These tests hold the sync in
 * their hand: `node:fs`'s `fdatasync` is replaced by one that waits to be
 * released, so each ordering claim in `onFlush` is observed, not assumed.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface HeldSync {
  readonly fd: number
  /** The file's size when the sync STARTED: what it can possibly cover. */
  readonly sizeAtStart: number
  release(error?: NodeJS.ErrnoException): void
}

const control = vi.hoisted(() => ({
  hold: false,
  held: [] as HeldSync[],
  calls: 0,
  dirSyncs: 0,
  log: [] as string[],
  /** Descriptors opened on a `.torn` sidecar, and whether their writes come back short (a full disk). */
  sidecars: new Set<number>(),
  shortSidecar: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fdatasync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      control.calls += 1
      control.log.push('fdatasync')
      const sizeAtStart = actual.fstatSync(fd).size
      const release = (error?: NodeJS.ErrnoException): void => {
        if (error) callback(error)
        else actual.fdatasync(fd, callback)
      }
      if (control.hold) control.held.push({ fd, sizeAtStart, release })
      else release()
    },
    fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      if (actual.fstatSync(fd).isDirectory()) control.dirSyncs += 1
      actual.fsync(fd, callback)
    },
    fsyncSync: (fd: number) => {
      control.log.push(actual.fstatSync(fd).isDirectory() ? 'fsyncSync:dir' : 'fsyncSync')
      actual.fsyncSync(fd)
    },
    openSync: (path: realFs.PathLike, flags?: realFs.OpenMode, mode?: realFs.Mode) => {
      const fd = actual.openSync(path, flags ?? 'r', mode)
      if (String(path).endsWith('.torn')) control.sidecars.add(fd)
      return fd
    },
    writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      // libuv returns the partial total, not an error, when ENOSPC hits mid-buffer.
      if (control.shortSidecar && control.sidecars.has(fd) && rest.length === 0) return actual.writeSync(fd, (buffer as Buffer).subarray(0, 40))
      return (actual.writeSync as (...args: unknown[]) => number)(fd, buffer, ...rest)
    },
    truncateSync: (path: realFs.PathLike, length?: number) => {
      control.log.push('truncateSync')
      actual.truncateSync(path, length)
    },
    closeSync: (fd: number) => {
      control.log.push(`closeSync:${fd}`)
      actual.closeSync(fd)
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
  control.hold = false
  control.held = []
  control.calls = 0
  control.dirSyncs = 0
  control.log = []
  control.sidecars = new Set()
  control.shortSidecar = false
})

afterEach(async () => {
  control.hold = false
  for (const held of control.held.splice(0)) held.release()
  await root?.dispose()
  root = undefined
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

async function mount() {
  dir = mkdtempSync(join(tmpdir(), 'minidsh-durable-'))
  root = createRoot({ logger: { warn: () => {}, error: () => {} } })
  root.plugin(sessionPlugin)
  root.plugin(persistenceJsonlPlugin, { root: dir })
  await root.settle()
  return { sessions: root.get(SESSIONS), base: dir }
}

/** A session with its file materialized (a conversation fact appended). */
async function materialized(id = 's') {
  const { sessions, base } = await mount()
  const session = sessions.create({ cwd: '/w', id: asSessionId(id) })
  session.append(TURN_START, { turn: 1 })
  session.append(USER_MESSAGE, { message: createUserMessage('go') }, { surfaceOp: { op: 'append' } })
  return { sessions, session, file: join(base, `${id}.jsonl`) }
}

/** Listeners run a turn of the loop after dispatch, so a flush's sync starts a few ticks later. */
const ticks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A flush rejects with the listener failures aggregated; the provider's own words are the first. */
const persistFailure = (pattern: RegExp) => (error: unknown): boolean => pattern.test(((error as AggregateError).errors?.[0] as Error | undefined)?.message ?? '')

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  return done
}

describe('persistence-jsonl: a resolved flush is on stable storage', () => {
  it('declares it, syncs what was written, and skips a sync nothing needs', async () => {
    const { session } = await materialized()
    expect(root!.get(PERSISTENCE).durability).toBe('synced')
    await session.flush()
    expect(control.calls).toBe(1)
    await session.flush()
    expect(control.calls).toBe(1) // nothing written since the last completed sync
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    await session.flush()
    expect(control.calls).toBe(2)
  })

  it('does not resolve a flush on a sync that started before its write', async () => {
    const { session, file } = await materialized()
    control.hold = true
    const first = session.flush()
    await ticks()
    expect(control.held).toHaveLength(1)
    // A write lands while that sync is in flight — the dispatch of the next
    // call, say — and its flush must wait for a sync that covers it.
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    const sizeWithWrite = readFileSync(file).length
    const second = session.flush()
    await ticks()
    // It waits for the sync in flight to finish rather than starting another beside it.
    expect(control.held).toHaveLength(1)
    control.held.shift()!.release()
    await first
    expect(await settled(second)).toBe(false)
    // Syncs of one file are serialized, and the next one STARTED after the write.
    expect(control.held).toHaveLength(1)
    expect(control.held[0]!.sizeAtStart).toBe(sizeWithWrite)
    control.held.shift()!.release()
    await second
    expect(control.calls).toBe(2)
  })

  it('never closes a descriptor under a sync in flight', async () => {
    const { sessions, session } = await materialized()
    control.hold = true
    const flushing = session.flush()
    await ticks()
    const held = control.held[0]!
    await sessions.detach(session)
    // Disposal asked for the close; it waits for the sync, so the number is
    // never reused under a queued fdatasync.
    expect(control.log.filter((entry) => entry === `closeSync:${held.fd}`)).toHaveLength(0)
    held.release()
    await flushing
    await new Promise((resolve) => setImmediate(resolve))
    expect(control.log.filter((entry) => entry === `closeSync:${held.fd}`)).toHaveLength(1)
  })

  it('refuses a flush whose write no sync covered before the session was detached', async () => {
    const { sessions, session } = await materialized()
    control.hold = true
    const first = session.flush()
    await ticks()
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    const second = session.flush()
    await ticks()
    await sessions.detach(session)
    control.held.shift()!.release()
    await first
    // The sync it waited on started before its write, and the file is closed now.
    await expect(second).rejects.toSatisfy(persistFailure(/detached before its writes were synced/))
  })

  it('remembers a failed sync, quarantines the file, and fails every later flush', async () => {
    const { session, file } = await materialized()
    control.hold = true
    const flushing = session.flush()
    await ticks()
    control.held.shift()!.release(Object.assign(new Error('EIO: i/o error, fdatasync'), { code: 'EIO' }))
    await expect(flushing).rejects.toSatisfy(persistFailure(/could not be persisted: EIO/))
    control.hold = false
    const before = readFileSync(file).length
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    // No retry: after an fsync error the pages may be marked clean, so a second
    // sync could "succeed" over data that never reached the disk.
    await expect(session.flush()).rejects.toSatisfy(persistFailure(/could not be persisted: EIO/))
    expect(readFileSync(file).length).toBe(before)
    expect(control.calls).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('syncs a new log\'s directory entry once, on POSIX', async () => {
    const { session } = await materialized()
    await session.flush()
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    await session.flush()
    expect(control.dirSyncs).toBe(1)
  })

  it('syncs a torn fragment into its sidecar before truncating the log', async () => {
    const { sessions, session, file } = await materialized('torn')
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    await sessions.detach(session)
    appendFileSync(file, '{"type":"assistant/chu')
    const stored = root!.get(PERSISTENCE).load('torn')!
    control.log = []
    sessions.create({ cwd: stored.header.cwd, id: stored.header.id, createdAt: stored.header.createdAt, seed: stored.events, origin: 'resumed' })
    const order = control.log.filter((entry) => entry.startsWith('fsyncSync') || entry === 'truncateSync')
    // The fragment, then (POSIX) the new sidecar's name, then the truncate.
    expect(order).toEqual(process.platform === 'win32' ? ['fsyncSync', 'truncateSync'] : ['fsyncSync', 'fsyncSync:dir', 'truncateSync'])
    expect(readFileSync(`${file}.torn`, 'utf8')).toContain('{"type":"assistant/chu')
  })

  it('leaves the log untouched when the sidecar write comes back short', async () => {
    const { sessions, session, file } = await materialized('short')
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    await sessions.detach(session)
    appendFileSync(file, '{"type":"assistant/chunk","seq":3,"time":1,"data":{"text":"the fragment a reader would want back"}')
    const before = readFileSync(file)
    const stored = root!.get(PERSISTENCE).load('short')!
    control.shortSidecar = true
    const resumed = sessions.create({ cwd: stored.header.cwd, id: stored.header.id, createdAt: stored.header.createdAt, seed: stored.events, origin: 'resumed' })
    await expect(resumed.flush()).rejects.toSatisfy(persistFailure(/wrote 40 of \d+ bytes of the torn tail/))
    expect(readFileSync(file).equals(before)).toBe(true)
  })
})
