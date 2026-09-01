/**
 * The S6 delegation live end-to-end: a real subagent doing real work under an
 * authority it cannot widen.
 *
 * One arc, over real stdio JSON-RPC to `minidsh serve` against the real
 * DeepSeek API, with NO `--approve`: every consent is a real decision, and
 * the point of the arc is that the child never gets to ask for one.
 *
 *   delegation   the parent delegates a bounded search; the child completes
 *                it in its own session and its answer reaches the parent
 *   the ceiling  the child opens under `read-only` + `never` with
 *                `reason: 'delegation'`, its shell escalation is refused
 *                without anyone being asked, and a wire attempt to widen the
 *                child is refused too
 *   the world    the parent then writes the file the child could not have
 *   replay       the parent's log replays keylessly
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { effectiveSandboxMode } from '../core/sandbox/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { auditLines } from './present.ts'
import { runTask } from './headless.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }

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

function storedEvents(home: string, id: string): EventEnvelope[] {
  return readFileSync(join(home, 'sessions', `${encodeURIComponent(id)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

function storedHeader(home: string, id: string): Record<string, unknown> {
  const first = readFileSync(join(home, 'sessions', `${encodeURIComponent(id)}.jsonl`), 'utf8').split('\n')[0]!
  return JSON.parse(first) as Record<string, unknown>
}

describe.skipIf(!KEY)('S6 live E2E: a delegated child does real work under an authority it cannot widen', () => {
  it('delegates, refuses the child every escalation, and finishes the job in the parent', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-e2e6d-ws-')
    const home = tempDir('minidsh-e2e6d-home-')
    // The needle lives in one of three files; finding it is the delegated task.
    writeFileSync(join(workspace, 'one.txt'), 'nothing here\nmove along\n', 'utf8')
    writeFileSync(join(workspace, 'two.txt'), 'still nothing\nTHE ANSWER IS PLUM-42\nnor here\n', 'utf8')
    writeFileSync(join(workspace, 'three.txt'), 'empty of answers\n', 'utf8')
    const decoy = join(workspace, 'decoy.txt')
    writeFileSync(decoy, 'must never change\n', 'utf8')
    const decoyBytes = readFileSync(decoy)

    // No --approve: an escalation would need a real answer, and none is coming.
    const serve = new ServeProcess(workspace, home, {})
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', {
      text:
        'Use the subagent tool exactly once. Give it this task: "Read one.txt, two.txt and three.txt in the working directory and reply with the single line that contains the answer token, and nothing else." ' +
        'Then reply with only the token the subagent reported.',
    })
    await serve.waitForCompletedTurn(sessionId, 1)

    const parentLog = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    const start = parentLog.events.find((event) => event.type === 'subagent/start')
    expect(start, 'the model did not delegate').toBeDefined()
    const startData = start!.data as { childId: string; depth: number; sandbox: string; approval: string }
    const childId = startData.childId
    expect(startData).toMatchObject({ depth: 1, approval: 'never' })
    const end = parentLog.events.find((event) => event.type === 'subagent/end')!.data as { reason: { kind: string } }
    expect(end.reason.kind).toBe('completed')

    // ---- the child did the work, in its own session ------------------------
    const childEvents = storedEvents(home, childId)
    expect(storedHeader(home, childId)).toMatchObject({ delegatedBy: sessionId, delegationDepth: 1 })
    expect(childEvents.some((event) => event.type === 'tool/call')).toBe(true)
    // Its opening stamps say it was delegated, and nothing widened them.
    const stamps = childEvents.filter((event) => event.type === 'sandbox/mode').map((event) => event.data as { mode: string; reason: string })
    expect(stamps[0]).toMatchObject({ reason: 'delegation' })
    expect(effectiveSandboxMode(childEvents)).toBe(stamps[0]!.mode)
    expect(childEvents.filter((event) => event.type === 'approval/policy').map((event) => event.data)).toEqual([{ policy: 'never', reason: 'delegation' }])
    // The audit of the CHILD opens with the delegation, and of the PARENT names it.
    expect(auditLines(childEvents)[0]).toContain('(delegation')
    expect(auditLines(parentLog.events).some((line) => line.includes('delegated') && line.includes(childId))).toBe(true)
    // Every approval the child asked for — if it asked at all — was refused
    // without a client ever being consulted.
    const decided = childEvents.filter((event) => event.type === 'approval/decided').map((event) => (event.data as { outcome: string }).outcome)
    expect(decided.every((outcome) => outcome === 'rejected')).toBe(true)

    // ---- a wire attempt to widen the child is refused ----------------------
    // The child is disposed with the call, so a resumed one is the only way to
    // reach it — and it is still fenced by what it opened under.
    await serve.request('session/prompt', { sessionId: childId, text: 'Say ok.' })
    const widened = await serve.request<{ sandbox: string }>('session/authority', { sessionId: childId, sandbox: 'danger-full-access' }).catch((error: Error) => error)
    expect(widened, 'widening a delegated child must be refused').toBeInstanceOf(Error)
    expect((widened as Error).message).toMatch(/ceiling|cannot be widened/i)
    const pinned = await serve.request<{ approval: string }>('session/authority', { sessionId: childId, approval: 'ask' }).catch((error: Error) => error)
    expect(pinned).toBeInstanceOf(Error)

    // ---- the parent finishes the job ---------------------------------------
    await serve.request('session/prompt', { sessionId, text: 'Now write the token you reported into found.txt in the working directory, on one line.' })
    await serve.waitForCompletedTurn(sessionId, 2)
    const final = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    await serve.shutdown()

    // The WORLD: the parent wrote the file, the decoy is untouched, and the
    // child — which never had the authority to write — wrote nothing.
    expect(readFileSync(join(workspace, 'found.txt'), 'utf8')).toContain('PLUM-42')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)
    expect(existsSync(join(workspace, 'one.txt'))).toBe(true)

    // ---- both logs replay, each as its own session's oracle -----------------
    // The child is a DIFFERENT session making its own model calls, so it
    // replays from its own log. One shared cursor used to serve it the parent's
    // next recorded step — every assistant message from the delegation onward
    // was then a different message, and `assertConsumed` passed on arithmetic
    // alone, because the child ate exactly the steps the parent never reached.
    //
    // The replay drives ONE turn, so it is measured against ONE turn's
    // recording: the parent's first, which is the turn the delegation is in.
    // That is what makes `assertConsumed` an assertion rather than a coincidence.
    const parentTurnOne = final.events.slice(0, final.events.findIndex((event) => event.type === 'turn/end') + 1)
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayWorkspace = tempDir('minidsh-e2e6d-replay-ws-')
    writeFileSync(join(replayWorkspace, 'two.txt'), 'still nothing\nTHE ANSWER IS PLUM-42\nnor here\n', 'utf8')
    const replayed = await runTask(
      {
        task: 'Use the subagent tool exactly once.',
        cwd: replayWorkspace,
        model: 'deepseek-v4-flash',
        approve: true,
        sessionsRoot: tempDir('minidsh-e2e6d-replay-'),
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (context) => {
          replayHandle = installLlmReplay(context, { events: parentTurnOne, children: [childEvents] })
        },
      },
      undefined,
    )
    // Both sessions replayed their own recording, in the order the recording
    // delegated in, and both were drained.
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
  })
})
