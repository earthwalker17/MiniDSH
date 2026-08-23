import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { PERSISTENCE } from '../../core/persistence/index.ts'
import { SESSIONS, TURN_END, TURN_START, USER_MESSAGE, type Sessions } from '../../core/session/index.ts'
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

  it('writes provenance for a seeded (fork) session as a fresh snapshot', async () => {
    const { sessions, base } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('parent') })
    appendTurn(sessions, 'parent', 1)
    const parent = sessions.get(asSessionId('parent'))!
    const seed = parent.forkSeed()
    const child = sessions.create({ cwd: '/w', id: asSessionId('child'), parentId: parent.id, seed, seedLength: seed.length })
    expect(child.origin).toBe('seeded')
    const lines = readFileSync(fileFor(base, 'child'), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ parentId: 'parent', seedLength: seed.length })
    // Seed + the end-seed marker are all in the snapshot.
    expect(lines).toHaveLength(1 + seed.length + 1)
    expect(JSON.parse(lines.at(-1)!).type).toBe('session/end-seed')
  })

  it('an unpublished session writes nothing; publication writes everything so far', async () => {
    const { sessions, base } = await mount()
    const session = sessions.create({ cwd: '/w', id: asSessionId('quiet'), publish: false })
    session.append(TURN_START, { turn: 1 })
    expect(existsSync(fileFor(base, 'quiet'))).toBe(false)
    sessions.publish(session)
    const lines = readFileSync(fileFor(base, 'quiet'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2) // header + the pre-publication event
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
    expect(readFileSync(`${fileFor(base, 'torn')}.torn`, 'utf8')).toBe('{"type":"assistant/chu')
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
    await expect(resumed.flush()).rejects.toSatisfy((error: unknown) => {
      const first = (error as AggregateError).errors?.[0] as Error
      return /damaged/.test(first?.message ?? '')
    })
  })
})

describe('persistence-jsonl: the read Definition', () => {
  it('lists stored headers newest first and loads by id', async () => {
    const { sessions } = await mount()
    sessions.create({ cwd: '/w', id: asSessionId('older'), createdAt: 1000 })
    appendTurn(sessions, 'older', 1)
    sessions.create({ cwd: '/w', id: asSessionId('newer'), createdAt: 2000 })
    appendTurn(sessions, 'newer', 1)
    const persistence = root!.get(PERSISTENCE)
    expect(persistence.list().map((header) => header.id)).toEqual(['newer', 'older'])
    expect(persistence.load('missing')).toBeUndefined()
    expect(persistence.load('older')!.events).toHaveLength(3)
  })
})
