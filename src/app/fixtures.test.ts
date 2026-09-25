/**
 * Two REAL stored logs, replayed and read keylessly inside `pnpm check`:
 * `minidsh-1.0.0.jsonl` written by the published `minidsh@1.0.0` (the only
 * released writer) and `minidsh-s16.jsonl` by this build, each one headless
 * DeepSeek turn in a WSL `/tmp` workspace (`src/test-support/fixtures/sessions`).
 *
 * What this proves, and only this: the current runtime reads, verifies,
 * inspects, repairs and salvages real bytes from both writers, and replays
 * their recorded model output and tool answers through today's loop with the
 * same step structure and turn endings, touching nothing. Replayed content
 * equals recorded content BY CONSTRUCTION in `recorded` mode, so the checks
 * that carry weight are the others: every recorded answer was asked for, and
 * the replay wrote no `tool/dispatch` and no `effect/recorded` — no body ran.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context } from '../kernel/index.ts'
import { persistenceJsonlPlugin } from '../capabilities/persistence-jsonl/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { PERSISTENCE, type StoredSession } from '../core/persistence/index.ts'
import { matches, TOOL_CALL, TOOL_RESULT, TURN_END, USER_MESSAGE, type EventEnvelope } from '../core/session/index.ts'
import { messageText, restoreMessage } from '../core/llm/message.ts'
import { coreHarness, type CoreHarness } from '../test-support/harness.ts'
import { installLlmReplay, recordedAnswers, type ReplayHandle } from '../test-support/llm-replay.ts'
import { runTask } from './headless.ts'
import { inspectStored, verifyStored } from './inspect.ts'

const FIXTURES = join(import.meta.dirname, '..', 'test-support', 'fixtures', 'sessions')

interface Fixture {
  readonly name: string
  /** The writer declared synced checkpoints and dispatch recording (S16+). */
  readonly synced: boolean
  /** The build its composition record names; absent for one that names none. */
  readonly writer?: string
  /** The recorded bytes: a fixture is evidence, and re-recording one is a reviewed change to this line. */
  readonly sha256: string
}

const FIXTURE_LIST: readonly Fixture[] = [
  { name: 'minidsh-1.0.0.jsonl', synced: false, sha256: 'ebc66550f4143d9edc239664bd3940b98df68f4dc889d4d89a42398cbcedb667' },
  { name: 'minidsh-s16.jsonl', synced: true, writer: 'minidsh 1.1.0-dev', sha256: '0fdee43ba7b08f289c9612f6d532a8d02e42840b0ba7f48b912f71992af25e08' },
]

let dirs: string[] = []
let roots: Context[] = []
let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  for (const root of roots) await root.dispose()
  roots = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** The fixture's own lines, and a store holding a copy of it under its session id. */
function staged(fixture: Fixture, transform: (lines: string[]) => string[] = (lines) => lines): { store: string; id: string; lines: string[]; file: string } {
  const lines = readFileSync(join(FIXTURES, fixture.name), 'utf8').split('\n').filter((line) => line.length > 0)
  const id = (JSON.parse(lines[0]!) as { id: string }).id
  const store = tempDir('minidsh-fixture-store-')
  const file = join(store, `${encodeURIComponent(id)}.jsonl`)
  writeFileSync(file, `${transform([...lines]).join('\n')}\n`)
  return { store, id, lines, file }
}

async function load(store: string, id: string): Promise<StoredSession> {
  const root = createRoot({ logger: { warn: () => {}, error: () => {} } })
  roots.push(root)
  root.plugin(persistenceJsonlPlugin, { root: store })
  await root.settle()
  return root.get(PERSISTENCE).load(id)!
}

const events = (lines: readonly string[]): EventEnvelope[] => lines.slice(1).map((line) => JSON.parse(line) as EventEnvelope)

describe.each(FIXTURE_LIST)('the stored log $name', (fixture) => {
  it('reads intact, and inspects to what its writer could claim', async () => {
    const { store, id } = staged(fixture)
    const stored = await load(store, id)
    expect({ damaged: stored.damaged, tail: stored.integrity?.tail }).toEqual({ damaged: undefined, tail: 'none' })
    const verification = verifyStored(stored)
    expect({ verdict: verification.verdict, findings: verification.findings }).toEqual({ verdict: 'ok', findings: [] })
    const inspection = inspectStored(stored, verification)
    // 1.0.0 wrote no lifecycle record: its segment claims nothing, so repair reads it conservatively.
    expect(inspection.lifecycles[0]?.record).toEqual(fixture.synced ? { origin: 'new', dispatch: true, durability: 'synced' } : undefined)
    // And names the build that wrote it, which 1.0.0 did not record.
    expect(inspection.lifecycles[0]?.writer).toBe(fixture.writer)
    expect(inspection.turns).toEqual({ total: 1, notCompleted: [] })
    expect(inspection.authority.mode).toBe('workspace-write')
  })

  it('repairs a crash cut after its last tool/call the way its writer earned: not started only when synced', async () => {
    const { lines } = staged(fixture)
    const all = events(lines)
    const lastCall = all.findLast((event) => matches(event, TOOL_CALL))!
    // A real crash shape: every line up to and including the call survived.
    const { store, id, file } = staged(fixture, (kept) => kept.slice(0, lastCall.seq + 2))
    const stored = await load(store, id)
    const verification = verifyStored(stored)
    expect(verification.verdict).toBe('interrupted')
    const result = verification.closers.find((event) => matches(event, TOOL_RESULT))!
    expect((result.data as { error: { code: string } }).error.code).toBe(fixture.synced ? 'TOOL_NOT_STARTED' : 'TOOL_OUTCOME_UNKNOWN')

    // And the resume writes, byte for byte, what verify predicted.
    harness = await coreHarness()
    harness.root.plugin(persistenceJsonlPlugin, { root: store })
    await harness.root.settle()
    const before = readFileSync(file)
    const resumed = await harness.root.get(AGENTS).resume(harness.root, stored.header.id, { agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    const appended = resumed.agent.session.events.slice(stored.events.length, stored.events.length + verification.closers.length)
    expect(appended.map((event) => JSON.stringify(event))).toEqual(verification.closers.map((event) => JSON.stringify(event)))
    await resumed.dispose()
    expect(readFileSync(file).subarray(0, before.length).equals(before)).toBe(true)
  })

  it('reads a torn tail as intact, and salvages a corrupted middle without touching it', async () => {
    const torn = staged(fixture)
    appendFileSync(torn.file, '{"type":"assistant/chu')
    expect(verifyStored(await load(torn.store, torn.id)).verdict).toBe('torn')

    const { lines } = staged(fixture)
    const firstResult = events(lines).find((event) => matches(event, TOOL_RESULT))!
    const damaged = staged(fixture, (kept) => kept.map((line, index) => (index === firstResult.seq + 1 ? line.slice(0, -3) : line)))
    const stored = await load(damaged.store, damaged.id)
    expect(verifyStored(stored).verdict).toBe('damaged')
    expect(stored.integrity?.stop).toMatchObject({ line: firstResult.seq + 2, reason: 'not JSON' })

    const before = readFileSync(damaged.file)
    harness = await coreHarness()
    harness.root.plugin(persistenceJsonlPlugin, { root: damaged.store })
    await harness.root.settle()
    // A fork never starts a turn, and its recorded cwd need not exist here.
    const fork = await harness.root.get(AGENTS).fork(harness.root, stored.header.id, undefined, {
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      salvage: true,
    })
    const owed = fork.agent.session.events.filter((event) => matches(event, TOOL_RESULT) && (event.data as { error?: { name: string } }).error?.name === 'SalvagedError')
    expect(owed.length).toBeGreaterThan(0)
    expect(owed.every((event) => (event.data as { error: { code: string } }).error.code === 'TOOL_OUTCOME_UNKNOWN')).toBe(true)
    await fork.dispose()
    expect(readFileSync(damaged.file).equals(before)).toBe(true)
  })

  it('replays keylessly with no effects: every recorded answer asked for, no body run', async () => {
    const recorded = events(staged(fixture).lines)
    const prompt = recorded.find((event) => matches(event, USER_MESSAGE) && restoreMessage(event.data.message).source.kind === 'user')!
    const task = messageText(restoreMessage((prompt.data as { message: Parameters<typeof restoreMessage>[0] }).message))
    const sessionsRoot = tempDir('minidsh-fixture-replay-')
    let replay: ReplayHandle | undefined
    const result = await runTask({
      task,
      cwd: tempDir('minidsh-fixture-ws-'),
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
      sessionsRoot,
      // The recording's tool names are the recording host's: a `bash` call on
      // a Windows runner would be UNKNOWN_TOOL before any answer is served. No
      // body runs in this mode, so the shell is never spawned.
      dialect: 'bash',
      confinement: 'none',
      logger: { warn: () => {}, error: () => {} },
      patches: [
        { id: 'llm-deepseek', disabled: true },
        { id: 'llm-anthropic', disabled: true },
      ],
      prepare: (root) => {
        replay = installLlmReplay(root, { events: recorded, effects: 'recorded' })
      },
    })
    replay!.assertConsumed()
    expect(result.exitCode).toBe(0)
    const replayed = events(readFileSync(join(sessionsRoot, `${encodeURIComponent(result.sessionId)}.jsonl`), 'utf8').split('\n').filter((line) => line.length > 0))
    expect(replayed.filter((event) => event.type === 'tool/dispatch' || event.type === 'effect/recorded')).toEqual([])
    const answers = (log: readonly EventEnvelope[]) =>
      log.filter((event) => matches(event, TOOL_RESULT)).map((event) => {
        const data = event.data as { turn: number; step: number; callId: string; error?: { code: string } }
        return `${data.turn}:${data.step}:${data.callId}:${data.error?.code ?? 'ok'}`
      })
    expect(answers(replayed)).toEqual(answers(recorded))
    const endings = (log: readonly EventEnvelope[]) => log.filter((event) => matches(event, TURN_END)).map((event) => (event.data as { reason: { kind: string } }).reason.kind)
    expect(endings(replayed)).toEqual(endings(recorded))
  })
})

describe('the fixtures themselves', () => {
  it('carry no path or name of the machine that recorded them', () => {
    for (const { name } of FIXTURE_LIST) {
      const text = readFileSync(join(FIXTURES, name), 'utf8')
      expect(text).not.toMatch(/\/home\/|\/mnt\/c|Users[\\/]A|earthwalker/i)
    }
  })

  it('are left exactly as recorded: a fixture is evidence, never edited', () => {
    for (const fixture of FIXTURE_LIST) {
      expect(createHash('sha256').update(readFileSync(join(FIXTURES, fixture.name))).digest('hex'), fixture.name).toBe(fixture.sha256)
    }
  })

  it('are read cold without a byte, a lease or a sidecar changing', async () => {
    // A store that normalized a real log on read, or took its lease, would be
    // rewriting evidence: load, verify and inspect a staged copy and compare.
    for (const fixture of FIXTURE_LIST) {
      const { store, id, file } = staged(fixture)
      const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs }
      const stored = await load(store, id)
      inspectStored(stored, verifyStored(stored))
      expect(readFileSync(file).equals(before.bytes)).toBe(true)
      expect(statSync(file).mtimeMs).toBe(before.mtime)
      expect({ lock: existsSync(`${file}.lock`), torn: existsSync(`${file}.torn`) }).toEqual({ lock: false, torn: false })
    }
  })

  it('decide per lifecycle whether a result proves a body ran, so a later build resuming 1.0.0 changes nothing before it', () => {
    // 1.0.0 recorded no dispatches, so its results are judged the old way; a
    // later segment that does record them must not reclassify those as "no".
    const old = events(staged(FIXTURE_LIST[0]!).lines)
    const before = recordedAnswers(old)
    const n = old.length
    const later: EventEnvelope[] = [
      ...old,
      { type: 'session/end-seed', seq: n, time: 1, data: {} },
      { type: 'session/lifecycle', seq: n + 1, time: 1, data: { origin: 'resumed', dispatch: true, durability: 'synced' } },
      { type: 'tool/dispatch', seq: n + 2, time: 1, data: { turn: 9, step: 1, callId: 'later' } },
    ]
    const after = recordedAnswers(later)
    expect(before.size).toBeGreaterThan(0)
    for (const [key, answer] of before) expect(after.get(key)?.bodied, key).toBe(answer.bodied)
  })
})
