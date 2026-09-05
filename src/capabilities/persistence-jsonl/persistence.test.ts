import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { PERSISTENCE } from '../../core/persistence/index.ts'
import { SESSIONS, SESSION_TITLE, TURN_END, TURN_START, USER_MESSAGE, foldSessionTitle, type Sessions } from '../../core/session/index.ts'
import { sessionPlugin } from '../../core/session/index.ts'
import { persistenceJsonlPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

let dir: string | undefined
let root: Context | undefined

afterEach(async () => {
  await root?.dispose()
  root = undefined
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

async function mount(): Promise<{ sessions: Sessions; base: string }> {
  dir = mkdtempSync(join(tmpdir(), 'minidsh-persist-'))
  root = createRoot({ logger: silent })
  root.plugin(sessionPlugin)
  root.plugin(persistenceJsonlPlugin, { root: dir })
  await root.settle()
  return { sessions: root.get(SESSIONS), base: dir }
}

/** One balanced turn with a user message, appended live. */
function appendTurn(sessions: Sessions, id: string, turn: number): void {
  const session = sessions.get(asSessionId(id))!
  session.append(TURN_START, { turn })
  session.append(USER_MESSAGE, { message: createUserMessage(`prompt ${turn}`) }, { surfaceOp: { op: 'append' } })
  session.append(TURN_END, { turn, reason: { kind: 'completed' } })
}

function fileFor(base: string, id: string): string {
  return join(base, `${encodeURIComponent(id)}.jsonl`)
}

describe('persistence-jsonl: write modes', () => {
  it('snapshots a fresh session at publication and appends live events', async () => {
    const { sessions, base } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('fresh') })
    appendTurn(sessions, 'fresh', 1)
    const lines = readFileSync(fileFor(base, 'fresh'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(4) // header + 3 events
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'session', id: 'fresh', cwd: '/w' })
    expect(JSON.parse(lines[1]!).type).toBe('turn/start')
  })

  it('writes provenance for a seeded (fork) session as a fresh snapshot once the branch acts', async () => {
    const { sessions, base } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('parent') })
    appendTurn(sessions, 'parent', 1)
    const parent = sessions.get(asSessionId('parent'))!
    const seed = parent.forkSeed()
    const child = sessions.create({ cwd: '/w', id: asSessionId('child'), parentId: parent.id, seed, seedLength: seed.length })
    expect(child.origin).toBe('seeded')
    // A branch that has not acted is not stored: creating it leaves nothing.
    expect(existsSync(fileFor(base, 'child'))).toBe(false)
    appendTurn(sessions, 'child', 2)
    const lines = readFileSync(fileFor(base, 'child'), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ parentId: 'parent', seedLength: seed.length })
    // Seed + the end-seed marker + the branch's own turn are all there.
    expect(lines).toHaveLength(1 + seed.length + 1 + 3)
    expect(JSON.parse(lines[seed.length + 1]!).type).toBe('session/end-seed')
  })

  it('materializes on the first conversation fact: publication and log-only records write nothing', async () => {
    const { sessions, base } = await mount()
    const session = sessions.create({ cwd: '/w', id: asSessionId('quiet'), publish: false })
    session.append(TURN_START, { turn: 1 })
    expect(existsSync(fileFor(base, 'quiet'))).toBe(false)
    sessions.publish(session)
    // Published and leased, but nothing has happened yet: no file.
    expect(existsSync(fileFor(base, 'quiet'))).toBe(false)
    expect(existsSync(`${fileFor(base, 'quiet')}.lock`)).toBe(true)
    session.append(USER_MESSAGE, { message: createUserMessage('now') }, { surfaceOp: { op: 'append' } })
    const lines = readFileSync(fileFor(base, 'quiet'), 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).type ?? JSON.parse(line).kind)).toEqual(['session', 'turn/start', 'user/message'])
  })

  it('a session that never records a conversation fact leaves nothing behind, and its lease is released', async () => {
    const { sessions, base } = await mount()
    const session = sessions.create({ cwd: '/w', id: asSessionId('abandoned') })
    session.append(TURN_START, { turn: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'blocked' } })
    await sessions.detach(session)
    expect(existsSync(fileFor(base, 'abandoned'))).toBe(false)
    expect(existsSync(`${fileFor(base, 'abandoned')}.lock`)).toBe(false)
    expect(root!.get(PERSISTENCE).list()).toEqual([])
  })
})

describe('persistence-jsonl: resume attach', () => {
  it('attaches append-only: the stored bytes are a byte-identical prefix of the resumed file', async () => {
    const { sessions, base } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('r1') })
    appendTurn(sessions, 'r1', 1)
    const original = sessions.get(asSessionId('r1'))!
    await sessions.detach(original)
    const before = readFileSync(fileFor(base, 'r1'))

    const stored = root!.get(PERSISTENCE).load('r1')!
    expect(stored.damaged).toBeUndefined()
    const resumed = sessions.create({
      cwd: stored.header.cwd,
      id: stored.header.id,
      createdAt: stored.header.createdAt,
      seed: stored.events,
      origin: 'resumed',
    })
    expect(resumed.origin).toBe('resumed')
    const after = readFileSync(fileFor(base, 'r1'))
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    // Exactly the delta was appended: the new lifecycle's end-seed marker.
    const deltaLines = after.subarray(before.length).toString('utf8').trim().split('\n')
    expect(deltaLines.map((line) => JSON.parse(line).type)).toEqual(['session/end-seed'])
    // Live appends continue on the same file.
    appendTurn(sessions, 'r1', 2)
    const final = readFileSync(fileFor(base, 'r1'))
    expect(final.subarray(0, after.length).equals(after)).toBe(true)
  })

  it('moves a torn final line to a sidecar instead of destroying it', async () => {
    const { sessions, base } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('torn') })
    appendTurn(sessions, 'torn', 1)
    await sessions.detach(sessions.get(asSessionId('torn'))!)
    const intact = readFileSync(fileFor(base, 'torn'))
    appendFileSync(fileFor(base, 'torn'), '{"type":"assistant/chu') // crash artifact: no newline

    const stored = root!.get(PERSISTENCE).load('torn')!
    expect(stored.damaged).toBeUndefined() // a torn final line is readable-prefix, not damage
    sessions.create({
      cwd: stored.header.cwd,
      id: stored.header.id,
      createdAt: stored.header.createdAt,
      seed: stored.events,
      origin: 'resumed',
    })
    const sidecar = readFileSync(`${fileFor(base, 'torn')}.torn`, 'utf8')
    expect(sidecar).toContain('{"type":"assistant/chu')
    expect(sidecar).toMatch(/^# torn .+ \(22 bytes\)\n/) // fragments stay individually recoverable
    const after = readFileSync(fileFor(base, 'torn'))
    expect(after.subarray(0, intact.length).equals(intact)).toBe(true)
  })

  it('marks deeper corruption as damaged and refuses to attach, surfacing at flush', async () => {
    const { sessions, base } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('bad') })
    appendTurn(sessions, 'bad', 1)
    await sessions.detach(sessions.get(asSessionId('bad'))!)
    appendFileSync(fileFor(base, 'bad'), '{"not":"an event"}\n{"type":"x","seq":99,"time":1,"data":{}}\n')

    const stored = root!.get(PERSISTENCE).load('bad')!
    expect(stored.damaged).toBe(true)
    expect(stored.events.map((event) => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    const resumed = sessions.create({
      cwd: stored.header.cwd,
      id: stored.header.id,
      createdAt: stored.header.createdAt,
      seed: stored.events,
      origin: 'resumed',
    })
    const damagedFlush = (error: unknown): boolean => {
      const first = (error as AggregateError).errors?.[0] as Error
      return /damaged/.test(first?.message ?? '')
    }
    await expect(resumed.flush()).rejects.toSatisfy(damagedFlush)
    // A failed publication is permanent: EVERY flush keeps failing, not just the first.
    await expect(resumed.flush()).rejects.toSatisfy(damagedFlush)
  })

  it('refuses to snapshot over an existing stored log (only resume may touch it)', async () => {
    const { sessions } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('dup') })
    appendTurn(sessions, 'dup', 1)
    await sessions.detach(sessions.get(asSessionId('dup'))!)

    const clobber = sessions.create({ cwd: '/w', id: asSessionId('dup') }) // fresh, same id, NOT resumed
    // The refusal happens at materialization — the first conversation fact.
    clobber.append(USER_MESSAGE, { message: createUserMessage('overwrite?') }, { surfaceOp: { op: 'append' } })
    await expect(clobber.flush()).rejects.toSatisfy((error: unknown) => {
      const first = (error as AggregateError).errors?.[0] as Error
      return /already exists/.test(first?.message ?? '')
    })
    // The stored log is intact.
    const stored = root!.get(PERSISTENCE).load('dup')!
    expect(stored.events.map((event) => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
  })
})

describe('persistence-jsonl: the read Definition', () => {
  it('lists stored headers newest first, loads by id, and skips foreign .jsonl files', async () => {
    const { sessions, base } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('older'), createdAt: 1000 })
    appendTurn(sessions, 'older', 1)
    sessions.create({ cwd: '/w', id: asSessionId('newer'), createdAt: 2000 })
    appendTurn(sessions, 'newer', 1)
    // A stray .jsonl whose first line is valid JSON but no session header.
    appendFileSync(join(base, 'notes.jsonl'), '{"type":"turn/start","seq":0,"time":1,"data":{}}\n')
    const persistence = root!.get(PERSISTENCE)
    expect(persistence.list().map((summary) => summary.header.id)).toEqual(['newer', 'older'])
    expect(persistence.load('missing')).toBeUndefined()
    expect(persistence.load('notes')).toBeUndefined()
    expect(persistence.load('older')!.events).toHaveLength(3)
  })
})

describe('persistence-jsonl: names in a listing', () => {
  it('reads a name out of the bounded prefix — the recorded one, else the first prompt', async () => {
    const { sessions } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('derived'), createdAt: 1000 })
    appendTurn(sessions, 'derived', 1)

    sessions.create({ cwd: '/w', id: asSessionId('recorded'), createdAt: 2000 })
    const recorded = sessions.get(asSessionId('recorded'))!
    recorded.append(USER_MESSAGE, { message: createUserMessage('the first prompt') }, { surfaceOp: { op: 'append' } })
    recorded.append(SESSION_TITLE, { title: 'what it is really about', messageSeqs: [0], source: { kind: 'user' } })

    const listed = new Map(root!.get(PERSISTENCE).list().map((summary) => [String(summary.header.id), summary.title]))
    // Nothing wrote a title for this one, and it still lists under a name.
    expect(listed.get('derived')).toBe('prompt 1')
    // …and where one was recorded, the record wins.
    expect(listed.get('recorded')).toBe('what it is really about')
  })

  it('lists a session whose first prompt is bigger than the prefix, without a name and without a stall', async () => {
    const { sessions } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('huge'), createdAt: 3000 })
    const session = sessions.get(asSessionId('huge'))!
    // One line past the 64 KiB the listing reads: there is no COMPLETE line
    // after the header to parse, so the prefix yields nothing to name it by.
    session.append(USER_MESSAGE, { message: createUserMessage('x'.repeat(80_000)) }, { surfaceOp: { op: 'append' } })

    const [summary] = root!.get(PERSISTENCE).list()
    expect(String(summary!.header.id)).toBe('huge')
    expect(summary!.title).toBeUndefined()
    // The whole log still reads, so `sessions show` names it where a listing cannot.
    expect(foldSessionTitle(root!.get(PERSISTENCE).load('huge')!.events)).toBe(`${'x'.repeat(79)}…`)
  })
})
