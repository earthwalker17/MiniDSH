/**
 * The per-session write lease: single-writer per stored log, enforced by the
 * provider. Two roots in one process share nothing but the filesystem (each
 * `sessionPlugin` owns its own store Map), so the lock file is the only guard
 * these tests exercise — exactly the cross-process shape.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { PERSISTENCE } from '../../core/persistence/index.ts'
import { SESSIONS, TURN_END, TURN_START, USER_MESSAGE, sessionPlugin, type Session, type Sessions } from '../../core/session/index.ts'
import { persistenceJsonlPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

let dir: string | undefined
let roots: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.toReversed()) await root.dispose()
  roots = []
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

function base(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'minidsh-lease-'))
  return dir
}

async function mountRoot(): Promise<Context> {
  const root = createRoot({ logger: silent })
  root.plugin(sessionPlugin)
  root.plugin(persistenceJsonlPlugin, { root: base() })
  await root.settle()
  roots.push(root)
  return root
}

function appendTurn(sessions: Sessions, id: string, turn: number): void {
  const session = sessions.get(asSessionId(id))!
  session.append(TURN_START, { turn })
  session.append(USER_MESSAGE, { message: createUserMessage(`prompt ${turn}`) }, { surfaceOp: { op: 'append' } })
  session.append(TURN_END, { turn, reason: { kind: 'completed' } })
}

function fileFor(id: string): string {
  return join(base(), `${encodeURIComponent(id)}.jsonl`)
}

function resumeStored(root: Context, id: string): Session {
  const stored = root.get(PERSISTENCE).load(id)!
  return root.get(SESSIONS).create({
    cwd: stored.header.cwd,
    id: stored.header.id,
    createdAt: stored.header.createdAt,
    seed: stored.events,
    origin: 'resumed',
  })
}

const flushError = (pattern: RegExp) => (error: unknown) => {
  const first = (error as AggregateError).errors?.[0] as Error | undefined
  return pattern.test(first?.message ?? '')
}

describe('persistence-jsonl: the session write lease', () => {
  it('a live holder refuses a second archive, leaving the stored bytes untouched; release hands over', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('held') })
    appendTurn(rootA.get(SESSIONS), 'held', 1)
    const before = readFileSync(fileFor('held'))

    const rootB = await mountRoot()
    const refused = resumeStored(rootB, 'held')
    await expect(refused.flush()).rejects.toSatisfy(flushError(/locked by pid/))
    // The refusal is permanent for this publication, the stored log untouched,
    // and the lock still names the live holder (this process).
    await expect(refused.flush()).rejects.toSatisfy(flushError(/locked by pid/))
    expect(readFileSync(fileFor('held')).equals(before)).toBe(true)
    expect(JSON.parse(readFileSync(`${fileFor('held')}.lock`, 'utf8')).pid).toBe(process.pid)
    await rootB.get(SESSIONS).detach(refused)
    expect(readFileSync(fileFor('held')).equals(before)).toBe(true)

    // Disposal releases the lease; a fresh resumed publication then succeeds.
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('held'))!)
    expect(existsSync(`${fileFor('held')}.lock`)).toBe(false)
    const resumed = resumeStored(rootB, 'held')
    await expect(resumed.flush()).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(`${fileFor('held')}.lock`, 'utf8')).pid).toBe(process.pid)
  })

  it('reclaims a provably dead same-host holder', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('stale') })
    appendTurn(rootA.get(SESSIONS), 'stale', 1)
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('stale'))!)
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(`${fileFor('stale')}.lock`, JSON.stringify({ pid: deadPid, host: hostname(), acquiredAt: 1 }))

    const resumed = resumeStored(rootA, 'stale')
    await expect(resumed.flush()).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(`${fileFor('stale')}.lock`, 'utf8')).pid).toBe(process.pid)
  })

  // A hard-killed runtime leaves its lock, and after a reboot its pid often
  // names an unrelated LIVE process: the probe alone read that as a holder
  // forever. The parent of this test process is alive for the whole test.
  it('reclaims a holder that took its lease before this boot, even when its pid is alive now', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('reboot') })
    appendTurn(rootA.get(SESSIONS), 'reboot', 1)
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('reboot'))!)
    const lock = `${fileFor('reboot')}.lock`
    const livePid = process.ppid
    expect(() => process.kill(livePid, 0), `pid ${livePid} must be alive for this test to mean anything`).not.toThrow()

    // The same live pid, taken during THIS boot (uptime then <= uptime now): refused, so the rule never steals a live holder.
    writeFileSync(lock, JSON.stringify({ pid: livePid, host: hostname(), acquiredAt: Date.now(), uptime: Math.max(0, uptime() - 5) }))
    const refused = resumeStored(rootA, 'reboot')
    await expect(refused.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${livePid} on `)))
    await rootA.get(SESSIONS).detach(refused)

    // A wall clock moved FORWARD by a day since the lease must not read as a reboot: refused.
    writeFileSync(lock, JSON.stringify({ pid: livePid, host: hostname(), acquiredAt: Date.now() - 86_400_000, uptime: Math.max(0, uptime() - 5) }))
    const stepped = resumeStored(rootA, 'reboot')
    await expect(stepped.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${livePid} on `)))
    await rootA.get(SESSIONS).detach(stepped)

    // Taken when the machine had been up LONGER than it has now: it rebooted since. Reclaimed.
    writeFileSync(lock, JSON.stringify({ pid: livePid, host: hostname(), acquiredAt: Date.now(), uptime: uptime() + 3_600 }))
    const resumed = resumeStored(rootA, 'reboot')
    if (process.platform === 'darwin') {
      // macOS derives uptime from the wall clock, so the rule is off there: the pid rule alone, and the pid is alive.
      await expect(resumed.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${livePid} on `)))
    } else {
      await expect(resumed.flush()).resolves.toBeUndefined()
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid)
    }
    await rootA.get(SESSIONS).detach(resumed)

    // No recorded uptime (an older writer): the pid rule alone, and the pid is alive.
    writeFileSync(lock, JSON.stringify({ pid: livePid, host: hostname(), acquiredAt: 0 }))
    const legacy = resumeStored(rootA, 'reboot')
    await expect(legacy.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${livePid} on `)))
  })

  it('refuses a foreign-host holder even when its pid is locally dead', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('afar') })
    appendTurn(rootA.get(SESSIONS), 'afar', 1)
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('afar'))!)
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(`${fileFor('afar')}.lock`, JSON.stringify({ pid: deadPid, host: 'another-machine', acquiredAt: 1 }))

    const refused = resumeStored(rootA, 'afar')
    await expect(refused.flush()).rejects.toSatisfy(flushError(/locked by pid \d+ on another-machine/))
  })

  /** A stored, closed session `id` whose lock file the case then writes by hand. */
  async function storedAndReleased(id: string): Promise<{ root: Context; lock: string }> {
    const root = await mountRoot()
    root.get(SESSIONS).create({ cwd: '/w', id: asSessionId(id) })
    appendTurn(root.get(SESSIONS), id, 1)
    await root.get(SESSIONS).detach(root.get(SESSIONS).get(asSessionId(id))!)
    return { root, lock: `${fileFor(id)}.lock` }
  }

  it('records which platform, and on Linux which boot, the holder runs in', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('fields') })
    const holder = JSON.parse(readFileSync(`${fileFor('fields')}.lock`, 'utf8')) as { platform?: string; bootId?: string }
    expect(holder.platform).toBe(process.platform)
    if (process.platform === 'linux') expect(holder.bootId).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
    else expect(holder.bootId).toBeUndefined()
  })

  // Only ESRCH proves a pid dead. EPERM is the answer for a process that is
  // there and not this user's to signal (another account's, an elevated one):
  // alive, so refused. The pid is a dead one, so a probe that escaped the stub
  // would answer ESRCH and reclaim.
  it('reads a holder whose pid answers EPERM as alive, and refuses', async () => {
    const { root, lock } = await storedAndReleased('other-user')
    const pid = spawnSync(process.execPath, ['-e', '']).pid
    const payload = JSON.stringify({ pid, host: hostname(), acquiredAt: 1 })
    writeFileSync(lock, payload)
    const probes: string[] = []
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target !== pid || signal !== 0) return kill(target, signal)
      probes.push(`kill(${target}, ${signal})`)
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })

    expect(root.get(PERSISTENCE).load('other-user')!.lease).toMatchObject({ pid, alive: true })
    const refused = resumeStored(root, 'other-user')
    await expect(refused.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${pid} on `)))
    expect(probes.length, probes.join('; ')).toBeGreaterThan(0)
    expect(readFileSync(lock, 'utf8')).toBe(payload)
  })

  // WSL 2 reports its Windows host's name, and the two have separate pid
  // spaces and separate uptimes: by hostname alone each reads the other's LIVE
  // holder as dead. A holder that recorded another platform is another
  // machine as far as a probe goes, whatever its pid and uptime say here.
  it('never reclaims from a holder on another platform that shares this hostname', async () => {
    const { root, lock } = await storedAndReleased('other-os')
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    const elsewhere = process.platform === 'win32' ? 'linux' : 'win32'
    // Dead by BOTH of this host's rules: the pid answers ESRCH and the uptime is far ahead of ours.
    const payload = JSON.stringify({ pid: deadPid, host: hostname(), acquiredAt: 1, uptime: uptime() + 86_400, platform: elsewhere })
    writeFileSync(lock, payload)

    expect(root.get(PERSISTENCE).load('other-os')!.lease).toMatchObject({ pid: deadPid, alive: 'unknown' })
    const refused = resumeStored(root, 'other-os')
    await expect(refused.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${deadPid} on .* \\(a ${elsewhere} process, which this ${process.platform} one cannot probe\\); if that process is gone, remove `)))
    expect(readFileSync(lock, 'utf8')).toBe(payload)
    await root.get(SESSIONS).detach(refused)

    // The field is evidence only when it differs: the same dead holder on THIS platform is reclaimed.
    writeFileSync(lock, JSON.stringify({ pid: deadPid, host: hostname(), acquiredAt: 1, platform: process.platform }))
    const resumed = resumeStored(root, 'other-os')
    await expect(resumed.flush()).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid)
  })

  // The uptime rule cannot see a reboot once the new boot has run longer than
  // the old one had when the lock was taken. Linux's boot id can: two ids that
  // differ are two boots, and two that match are one, whatever the uptimes say.
  it('on Linux decides a reboot by the boot id, and elsewhere ignores one', async () => {
    const { root, lock } = await storedAndReleased('boot')
    const livePid = process.ppid
    expect(() => process.kill(livePid, 0), `pid ${livePid} must be alive for this test to mean anything`).not.toThrow()
    const held = (fields: Record<string, unknown>): void => writeFileSync(lock, JSON.stringify({ pid: livePid, host: hostname(), acquiredAt: 1, platform: process.platform, ...fields }))

    // Another boot's id, a live pid, and an uptime that says "same boot": only the id can call this one dead.
    held({ bootId: '00000000-0000-4000-8000-000000000000', uptime: Math.max(0, uptime() - 5) })
    const other = resumeStored(root, 'boot')
    if (process.platform === 'linux') {
      await expect(other.flush()).resolves.toBeUndefined()
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid)
    } else {
      // No boot id of our own to compare with: the uptime and pid rules, and the pid is alive.
      await expect(other.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${livePid} on `)))
    }
    await root.get(SESSIONS).detach(other)

    if (process.platform === 'linux') {
      // THIS boot's id with an uptime far ahead of ours: one boot, so the uptime rule is not asked and the live pid refuses.
      held({ bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), uptime: uptime() + 3_600 })
      const same = resumeStored(root, 'boot')
      await expect(same.flush()).rejects.toSatisfy(flushError(new RegExp(`locked by pid ${livePid} on `)))
    }
  })

  it('releases every lock it holds when the provider row is unloaded', async () => {
    const root = createRoot({ logger: silent })
    root.plugin(sessionPlugin)
    const handle = root.plugin(persistenceJsonlPlugin, { root: base() })
    await root.settle()
    roots.push(root)
    root.get(SESSIONS).create({ cwd: '/w', id: asSessionId('unload') })
    appendTurn(root.get(SESSIONS), 'unload', 1)
    expect(existsSync(`${fileFor('unload')}.lock`)).toBe(true)

    // Unloading the row kills the listener that would have released it, so the
    // provider must unwind its own leases — otherwise the lock outlives the
    // process's interest in the session and every later resume is refused.
    await handle.dispose()
    expect(existsSync(`${fileFor('unload')}.lock`)).toBe(false)
  })

  it('never removes a lock another process has since taken', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('stolen') })
    appendTurn(rootA.get(SESSIONS), 'stolen', 1)
    const lock = `${fileFor('stolen')}.lock`
    // Simulate the documented manual-cleanup edge: someone removed our lock and
    // another process took it. Releasing must not delete THEIR lock.
    const foreign = JSON.stringify({ pid: 999_999, host: 'another-machine', acquiredAt: 2 })
    writeFileSync(lock, foreign)
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('stolen'))!)
    expect(readFileSync(lock, 'utf8')).toBe(foreign)
  })

  it('serializes a steal, so two reclaimers of one dead holder cannot both acquire', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('race') })
    appendTurn(rootA.get(SESSIONS), 'race', 1)
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('race'))!)
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid
    const lock = `${fileFor('race')}.lock`
    writeFileSync(lock, JSON.stringify({ pid: deadPid, host: hostname(), acquiredAt: 1 }))
    // A reclaimer that died inside its steal leaves the mutex behind: reclaim
    // is blocked (fail-safe) rather than racing a second deleter.
    writeFileSync(`${lock}.steal`, JSON.stringify({ pid: deadPid, host: hostname(), acquiredAt: 1 }))
    const blocked = resumeStored(rootA, 'race')
    // Named, as the lease's comment promises: removing only the lock recovers
    // this once, and leaves every later reclaim blocked (S20.5 audit).
    await expect(blocked.flush()).rejects.toSatisfy(flushError(/locked by pid .*remove .*\.lock and .*\.lock\.steal, a reclaim's mutex/))
    await rootA.get(SESSIONS).detach(blocked)

    // With the mutex cleared, the same reclaim succeeds.
    rmSync(`${lock}.steal`)
    const resumed = resumeStored(rootA, 'race')
    await expect(resumed.flush()).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid)
    expect(existsSync(`${lock}.steal`)).toBe(false)
  })

  it('refuses to attach when the stored log grew after it was loaded', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('grew') })
    appendTurn(rootA.get(SESSIONS), 'grew', 1)
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('grew'))!)

    // Read as resume does, THEN let a foreign writer append into the gap
    // before publication takes the lease — the events-so-far guard used to
    // tolerate this because the resumed session had already grown.
    const stored = rootA.get(PERSISTENCE).load('grew')!
    appendFileSync(fileFor('grew'), `${JSON.stringify({ type: 'turn/start', seq: stored.events.length, time: 1, data: { turn: 2 } })}\n`)
    const resumed = rootA.get(SESSIONS).create({
      cwd: stored.header.cwd,
      id: stored.header.id,
      createdAt: stored.header.createdAt,
      seed: stored.events,
      origin: 'resumed',
    })
    await expect(resumed.flush()).rejects.toSatisfy(flushError(/grew past what this session resumed from/))
  })

  it('refuses an unreadable lock file, pointing at manual cleanup', async () => {
    const rootA = await mountRoot()
    rootA.get(SESSIONS).create({ cwd: '/w', id: asSessionId('junk') })
    appendTurn(rootA.get(SESSIONS), 'junk', 1)
    await rootA.get(SESSIONS).detach(rootA.get(SESSIONS).get(asSessionId('junk'))!)
    writeFileSync(`${fileFor('junk')}.lock`, 'not json')

    const refused = resumeStored(rootA, 'junk')
    await expect(refused.flush()).rejects.toSatisfy(flushError(/an unreadable holder.*remove/))
  })
})

describe('persistence-jsonl: format version at the read boundary', () => {
  it('refuses a stored log written by a newer format, and treats a version-less header as foreign', async () => {
    const rootA = await mountRoot()
    const future = { kind: 'session', version: 1, id: 'future', createdAt: 1, cwd: '/w' }
    writeFileSync(join(base(), 'future.jsonl'), `${JSON.stringify(future)}\n`)
    // A format refusal, not damage: nothing is wrong with the log, and the error says which way to go.
    expect(() => rootA.get(PERSISTENCE).load('future')).toThrow(/format 1, and this MiniDSH reads format 0 — it was written by a newer MiniDSH/)
    expect(() => rootA.get(PERSISTENCE).load('future')).toThrow(expect.objectContaining({ code: 'SESSION_FORMAT_UNSUPPORTED', found: 1 }))

    const versionless = { kind: 'session', id: 'older', createdAt: 1, cwd: '/w' }
    writeFileSync(join(base(), 'older.jsonl'), `${JSON.stringify(versionless)}\n`)
    expect(rootA.get(PERSISTENCE).load('older')).toBeUndefined()
  })
})
