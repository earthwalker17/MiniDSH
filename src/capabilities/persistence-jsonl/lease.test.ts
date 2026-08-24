/**
 * The per-session write lease: single-writer per stored log, enforced by the
 * provider. Two roots in one process share nothing but the filesystem (each
 * `sessionPlugin` owns its own store Map), so the lock file is the only guard
 * these tests exercise — exactly the cross-process shape.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    await expect(blocked.flush()).rejects.toSatisfy(flushError(/locked by pid/))
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
    expect(() => rootA.get(PERSISTENCE).load('future')).toThrow(/format version 1.*at most 0/)

    const versionless = { kind: 'session', id: 'older', createdAt: 1, cwd: '/w' }
    writeFileSync(join(base(), 'older.jsonl'), `${JSON.stringify(versionless)}\n`)
    expect(rootA.get(PERSISTENCE).load('older')).toBeUndefined()
  })
})
