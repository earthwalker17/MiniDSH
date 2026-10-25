/**
 * The S2 live end-to-end: the real MiniDSH runtime, the real DeepSeek API, a
 * real workspace outside the repo, over the real wire — `minidsh serve` runs
 * as a child process and everything below speaks newline-delimited JSON-RPC to
 * its stdio, exactly as an external client would.
 *
 * Arc: task A completes → task B is killed mid-turn (SIGKILL) → a second serve
 * process resumes the stored session over the wire (crash repair + append-only
 * attach, byte-prefix asserted) and finishes the work → a fresh session's log
 * replays keylessly (the log is its own oracle). Assertions are about the
 * WORLD (file bytes, decoy untouched), never the agent's self-report.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay, recordedRoute } from '../test-support/llm-replay.ts'
import { coldRead, killSpawnedServes, ServeProcess, validPrefix } from '../test-support/serve-process.ts'
import { runTask } from './headless.ts'
import { skillRootsFor } from './home.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
const HOLD_PLUGIN = fileURLToPath(new URL('../test-support/fixtures/hold-plugin.ts', import.meta.url))
let dirs: string[] = []
afterAll(() => {
  killSpawnedServes()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe.skipIf(!KEY)('S2 live E2E: kill, resume, and replay over the real wire', () => {
  it('a session survives a hard kill and finishes its work in a second process', { timeout: 480_000 }, async () => {
    const workspace = tempDir('minidsh-e2e-ws-')
    const home = tempDir('minidsh-e2e-home-')
    const decoy = join(workspace, 'decoy.txt')
    writeFileSync(decoy, 'must never change\n', 'utf8')
    const decoyBytes = readFileSync(decoy)
    // A disk-loaded tool whose body waits for this file: the kill below lands
    // inside a dispatched call every run, not when a poll happens to catch one.
    const release = join(home, 'release-hold')
    writeFileSync(
      join(home, 'composition.json'),
      JSON.stringify({ patches: [{ insert: [{ id: 'tool-hold', plugin: HOLD_PLUGIN, config: { releaseFile: release } }] }] }),
      'utf8',
    )

    // ---- lifecycle 1: complete task A, then die mid-task-B ----------------
    const first = new ServeProcess(workspace, home, { approve: true })
    const init = await first.request<{ serverInfo: { name: string }; providers: { id: string }[] }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')
    expect(init.providers.some((provider) => provider.id === 'deepseek')).toBe(true)

    const { sessionId } = await first.request<{ sessionId: string }>('session/prompt', {
      text: 'Create a file named greeting.txt in the workspace containing exactly this single line: hello from minidsh',
    })
    await first.waitForCompletedTurn(sessionId, 1)
    expect(readFileSync(join(workspace, 'greeting.txt'), 'utf8').trim()).toBe('hello from minidsh')

    await first.request('session/prompt', {
      sessionId,
      text: 'First call the hold tool once. Then append a second line to greeting.txt reading exactly: resumed and finished',
    })
    // Die mid-turn, INSIDE a call: once the hold call is dispatched — durable
    // before its body runs, and its body cannot finish until released.
    const held = await first.waitFor(() => {
      const call = first.events('tool/call', sessionId).find((event) => (event.data as { turn: number; name: string }).turn === 2 && (event.data as { name: string }).name === 'hold')
      if (call === undefined) return undefined
      const callId = (call.data as { callId: string }).callId
      return first.events('tool/dispatch', sessionId).some((event) => (event.data as { callId: string }).callId === callId) ? callId : undefined
    }, 'the hold call of turn 2 to be dispatched')
    await first.kill()
    // Released before the resume, so a model that calls hold again is not held.
    writeFileSync(release, '')

    const sessionFile = join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`)
    const beforeResume = validPrefix(sessionFile)
    expect(beforeResume.length).toBeGreaterThan(0)

    // ---- between the lifecycles: a COLD read by another process ------------
    // Nobody holds the log now (its writer is dead, its lock still names it).
    // A separate `minidsh sessions verify` must read it without taking or
    // reclaiming that lock, and say what a resume will append.
    const lockFile = `${sessionFile}.lock`
    const lockBefore = readFileSync(lockFile, 'utf8')
    const cold = coldRead(home, ['verify', sessionId, '--json'])
    expect(cold.code, `cold verify of the killed log: ${cold.out}${cold.err}`).toBe(0)
    const coldVerdict = cold.json as { verdict: string; closers: EventEnvelope[]; findings: { check: string; message: string }[] }
    expect(['interrupted', 'torn']).toContain(coldVerdict.verdict)
    expect(readFileSync(lockFile, 'utf8'), 'a cold read touched the lease').toBe(lockBefore)
    expect(readFileSync(sessionFile).subarray(0, beforeResume.length).equals(beforeResume)).toBe(true)

    // ---- lifecycle 2: resume over the wire, repair, finish ----------------
    const second = new ServeProcess(workspace, home, { approve: true })
    const resumed = await second.request<{ sessionId: string }>('session/prompt', {
      sessionId,
      text: 'The previous attempt was interrupted. Ensure greeting.txt ends with the exact second line: resumed and finished',
    })
    expect(resumed.sessionId).toBe(sessionId)
    await second.waitFor(
      () =>
        second
          .events('turn/end', sessionId)
          .find((event) => (event.data as { turn: number; reason: { kind: string } }).turn >= 3 && (event.data as { reason: { kind: string } }).reason.kind === 'completed'),
      'the resumed turn to complete',
    )

    // The WORLD: the file is finished, the decoy is untouched.
    const lines = readFileSync(join(workspace, 'greeting.txt'), 'utf8').trim().split(/\r?\n/)
    expect(lines[0]).toBe('hello from minidsh')
    expect(lines.at(-1)).toBe('resumed and finished')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)

    // The LOG: append-only attach (byte prefix), crash repair recorded.
    const afterResume = readFileSync(sessionFile)
    expect(afterResume.subarray(0, beforeResume.length).equals(beforeResume)).toBe(true)
    const storedEvents = readFileSync(sessionFile, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line) as EventEnvelope)
    const interrupted = storedEvents.filter(
      (event) => event.type === 'turn/end' && (event.data as { reason: { kind: string } }).reason.kind === 'interrupted',
    )
    expect(interrupted).toHaveLength(1)
    expect((interrupted[0]!.data as { turn: number }).turn).toBe(2)
    expect(storedEvents.some((event) => event.type === 'session/end-seed')).toBe(true)

    // What the cold read predicted is, byte for byte, what the second process
    // appended: repair is deterministic across processes (§4).
    const firstCloser = coldVerdict.closers[0]!.seq
    const appended = storedEvents.slice(firstCloser, firstCloser + coldVerdict.closers.length)
    expect(appended.map((event) => JSON.stringify(event))).toEqual(coldVerdict.closers.map((event) => JSON.stringify(event)))
    // Two lifecycles, each stating what its writer guaranteed.
    const lifecycles = storedEvents.filter((event) => event.type === 'session/lifecycle').map((event) => event.data)
    expect(lifecycles).toEqual([
      { origin: 'new', dispatch: true, durability: 'synced' },
      { origin: 'resumed', dispatch: true, durability: 'synced' },
    ])
    console.log(`[live arc] cold verify at the kill: ${coldVerdict.verdict}; predicted ${coldVerdict.closers.length} closer(s), and the resume appended exactly those`)

    /**
     * THE RECOVERY CONTRACT, against a real kill, in two assertions — one that
     * every run exercises and one that only a kill inside the call window does.
     *
     * The first is the invariant the whole rule rests on: a call that PRODUCED
     * a result ran its body, so the log must carry its `tool/dispatch`. If that
     * ever failed, repair would read a successful call's absence of a dispatch
     * as "never started" and tell a resumed model to redo work that was done.
     * It holds on every call of every turn here, killed or not.
     *
     * The second is the equivalence, and it is exercised on EVERY run: the kill
     * lands while the hold call's body waits for its release file, after its
     * `tool/dispatch` and before any result, so repair must synthesize
     * TOOL_OUTCOME_UNKNOWN for it. (It used to SIGKILL on a 50 ms poll of the
     * `tool/call` frame, and the call usually finished inside that window, so
     * the loop below ran over nothing.) The killed lifecycle's record claims
     * `dispatch` and `synced` (asserted below), so a synthetic result here is
     * decided by the synced-writer row, not the 1.0.0 fallback.
     */
    const dispatched = new Set(
      storedEvents.filter((event) => event.type === 'tool/dispatch').map((event) => (event.data as { callId: string }).callId),
    )
    expect(dispatched.size, 'turn 1 ran a tool, so this log records dispatches').toBeGreaterThan(0)
    const results = storedEvents.filter((event) => event.type === 'tool/result')
    for (const result of results) {
      const { callId, error } = result.data as { callId: string; error?: { code: string } }
      if (error === undefined) {
        expect({ callId, dispatched: true }, 'a call that produced a result ran its body').toEqual({ callId, dispatched: dispatched.has(callId) })
      }
    }
    const synthetic = results.filter((event) => {
      const code = (event.data as { error?: { code: string } }).error?.code
      return code === 'TOOL_OUTCOME_UNKNOWN' || code === 'TOOL_NOT_STARTED'
    })
    console.log(`[live arc] ${dispatched.size} dispatch(es), ${results.length} result(s), ${synthetic.length} synthesized by repair`)
    const heldResult = synthetic.find((event) => (event.data as { callId: string }).callId === held)
    expect(heldResult, `repair synthesized no result for the held call ${held}`).toBeDefined()
    expect((heldResult!.data as { error: { code: string } }).error.code).toBe('TOOL_OUTCOME_UNKNOWN')
    for (const result of synthetic) {
      const { callId, error } = result.data as { callId: string; error: { code: string } }
      expect({ callId, unknown: error.code === 'TOOL_OUTCOME_UNKNOWN' }).toEqual({ callId, unknown: dispatched.has(callId) })
    }
    /**
     * Brackets, in BOTH directions. This arc neither delegates nor compacts,
     * so "nothing is left open" holds vacuously — and an invented closer would
     * pass it too, by deleting a key that was never there. So the ends are
     * counted against the starts as well: repair must close what the log
     * opened and must not close what it did not.
     */
    const openSubagents = new Set<string>()
    const openCompactions = new Set<number>()
    const orphanEnds: string[] = []
    for (const event of storedEvents) {
      const data = event.data as { childId?: string; startSeq?: number }
      if (event.type === 'subagent/start') openSubagents.add(String(data.childId))
      else if (event.type === 'subagent/end') {
        if (!openSubagents.delete(String(data.childId))) orphanEnds.push(`subagent/end ${String(data.childId)}`)
        // A compaction bracket is keyed by the START's own seq, which its end cites.
      } else if (event.type === 'compaction/start') openCompactions.add(event.seq)
      else if (event.type === 'compaction/end') {
        if (!openCompactions.delete(Number(data.startSeq))) orphanEnds.push(`compaction/end ${String(data.startSeq)}`)
      }
    }
    expect([...openSubagents], 'a bracket the crash left open').toEqual([])
    expect([...openCompactions], 'a bracket the crash left open').toEqual([])
    expect(orphanEnds, 'a closer that ended a bracket nothing opened').toEqual([])

    // The WIRE: history reads back over the protocol, seqs contiguous.
    const history = await second.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    expect(history.events.every((event, index) => event.seq === index)).toBe(true)

    // ---- lifecycle 2 continued: a fresh session for the replay oracle -----
    const fresh = await second.request<{ sessionId: string }>('session/prompt', {
      text: 'Read greeting.txt and reply with its second line, exactly, and nothing else.',
    })
    await second.waitForCompletedTurn(fresh.sessionId, 1)
    const freshLog = await second.request<{ events: EventEnvelope[] }>('session/events', { sessionId: fresh.sessionId })
    await second.shutdown()

    // ---- keyless replay: the fresh log is its own oracle ------------------
    const recordedText = lastAssistantText(freshLog.events)
    expect(recordedText).toContain('resumed and finished')
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayed = await runTask(
      {
        task: 'Read greeting.txt and reply with its second line, exactly, and nothing else.',
        cwd: workspace,
        // The route the recording ran on, never a literal (A8-11).
        ...recordedRoute(freshLog.events),
        sessionsRoot: tempDir('minidsh-e2e-replay-'),
        // What `serve` mounted: the recorded requests carry its skill list.
        skillRoots: skillRootsFor(home),
        browserProfileRoot: join(home, 'browser-replay'),
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events: freshLog.events })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    expect(replayed.text).toBe(recordedText)
    replayHandle!.assertConsumed()
  })
})

function lastAssistantText(events: readonly EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'assistant/message') continue
    const message = event.data as { message: { content: { type: string; text?: string }[] } }
    const text = message.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    if (text.length > 0) return text
  }
  return ''
}
