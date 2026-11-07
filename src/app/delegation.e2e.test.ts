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
 *   the ceiling  the child opens under its parent's mode (`workspace-write`
 *                in the default composition: the row sets no narrower one) with
 *                approvals pinned `never`, `reason: 'delegation'`; its task
 *                demands one escalated shell command, which on every host
 *                reaches the approval seam and is refused by the pin without
 *                anyone being asked, and a wire attempt to widen the child is
 *                refused too
 *   narrowing    the subagent row denies the job tools and gives the child a
 *                marked persona (S21.1); the child opens with that narrowing
 *                recorded, and the wire RESUME of it below runs a step that
 *                is still narrow — the factory re-applied the record
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
import { foldRequestHeader, type EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay, recordedRoute } from '../test-support/llm-replay.ts'
import { coldRead, killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { auditLines } from './present.ts'
import { runTask } from './headless.ts'
import { skillRootsFor } from './home.ts'

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

/**
 * What the arc's composition narrows a child to (S21.1): the job tools denied,
 * and a persona whose marker a request header can be searched for. Neither
 * touches the task, which needs only the shell and the editor.
 */
const PERSONA_MARK = 'NARROW-PERSONA-7'
const NARROWED_ROW = {
  id: 'tool-subagent',
  config: {
    persona: `You are a delegated MiniDSH subagent (${PERSONA_MARK}). Work in the user's workspace with the provided tools, do exactly the task you were given, and answer in one short reply.`,
    toolFilter: { deny: ['job_start', 'job_output', 'job_cancel'] },
  },
}
const DENIED = NARROWED_ROW.config.toolFilter.deny

/** The child's effective request header after `events`: a step that ran wider would have written a new one. */
function narrowHeader(events: readonly EventEnvelope[], what: string): void {
  const header = foldRequestHeader(events)
  expect(header, `${what}: no request header`).toBeDefined()
  const tools = header!.tools.map((tool) => tool.name)
  for (const name of DENIED) expect(tools, `${what}: ${name}`).not.toContain(name)
  expect(tools, what).toContain('str_replace_editor')
  expect(header!.system, `${what}: the persona`).toContain(PERSONA_MARK)
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

    writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [NARROWED_ROW] }))
    // No --approve: an escalation would need a real answer, and none is coming.
    const serve = new ServeProcess(workspace, home, {})
    // The child's task REQUIRES a consent: a named command, explicitly
    // escalated. Reading files alone never reached the shell's escalation path —
    // 0 asks in 6 of 6 S16.5 runs — so the refusal leg exercised nothing on
    // any host. An escalation to `danger-full-access` is viable on every host
    // (it needs no confinement), so it always reaches the approval seam, and
    // the child's pinned `never` must refuse it without asking anyone.
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', {
      text:
        'Use the subagent tool exactly once. Give it this task, word for word: "First, use the shell tool to run the command `echo ESCALATION-PROBE` ' +
        'with sandbox_permissions set to danger-full-access and justification set to \'the task requires it\' — exactly once, whatever happens. ' +
        'Then read one.txt, two.txt and three.txt in the working directory and reply with the single line that contains the answer token, and nothing else." ' +
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
    // Its narrowing is an opening fact of its own log, and its steps ran narrow.
    const narrowings = childEvents.filter((event) => event.type === 'agent/narrowing')
    expect(narrowings).toHaveLength(1)
    expect(narrowings[0]!.data).toMatchObject({ tools: [{ deny: DENIED }], sections: [{ name: 'persona' }] })
    narrowHeader(childEvents, 'the delegated child')
    // Its opening stamps say it was delegated, and nothing widened them.
    const stamps = childEvents.filter((event) => event.type === 'sandbox/mode').map((event) => event.data as { mode: string; reason: string })
    expect(stamps[0]).toMatchObject({ reason: 'delegation' })
    expect(effectiveSandboxMode(childEvents)).toBe(stamps[0]!.mode)
    expect(childEvents.filter((event) => event.type === 'approval/policy').map((event) => event.data)).toEqual([{ policy: 'never', reason: 'delegation' }])
    // The audit of the CHILD opens with the delegation, and of the PARENT names it.
    expect(auditLines(childEvents)[0]).toContain('(delegation')
    expect(auditLines(parentLog.events).some((line) => line.includes('delegated') && line.includes(childId))).toBe(true)
    // The escalation the task demanded reached the approval seam and was
    // refused by the pin, without a client ever being consulted: the pinned
    // `never` writes its ask and its refusal in one tick (core/approval), so
    // every decision is the POLICY's, none a person's, and this client — which
    // never answers in this arc — answered nothing. The count is required, not
    // printed: `every` over nothing used to pass on every host.
    const escalations = childEvents.filter(
      (event) => event.type === 'tool/call' && /sandbox_permissions/.test((event.data as { arguments: string }).arguments),
    )
    const decided = childEvents.filter((event) => event.type === 'approval/decided').map((event) => event.data as { outcome: string; decidedBy?: string })
    expect(
      decided.length,
      `the child made ${escalations.length} escalated shell call(s) and reached no approval: the model did not follow the task, so the refusal leg did not run`,
    ).toBeGreaterThan(0)
    expect(decided.map((decision) => decision.outcome)).toEqual(decided.map(() => 'rejected'))
    expect(decided.map((decision) => decision.decidedBy), 'a delegated child\'s approval was decided by someone other than its pin').toEqual(decided.map(() => 'policy'))
    console.log(`[delegation arc] the child escalated ${escalations.length} time(s); ${decided.length} decision(s), all refused by the pin`)

    // ---- a wire attempt to widen the child is refused ----------------------
    // The child is disposed with the call, so a resumed one is the only way to
    // reach it — and it is still fenced by what it opened under.
    await serve.request('session/prompt', { sessionId: childId, text: 'Say ok.' })
    const widened = await serve.request<{ sandbox: string }>('session/authority', { sessionId: childId, sandbox: 'danger-full-access' }).catch((error: Error) => error)
    expect(widened, 'widening a delegated child must be refused').toBeInstanceOf(Error)
    expect((widened as Error).message).toMatch(/ceiling|cannot be widened/i)
    const pinned = await serve.request<{ approval: string }>('session/authority', { sessionId: childId, approval: 'ask' }).catch((error: Error) => error)
    expect(pinned).toBeInstanceOf(Error)

    // Its ACCEPTANCE is a copy it cannot renegotiate either. A child that
    // could weaken it would be buying itself an unconfined shell its parent
    // never accepted — and being pinned `never`, it has nobody to ask.
    const accepting = await serve
      .request<{ accepts: string }>('session/authority', { sessionId: childId, accepts: 'none' })
      .catch((error: Error) => error)
    expect(accepting, 'a delegated child must not be able to change what it accepts').toBeInstanceOf(Error)
    // The parent never accepted anything, so the child opened at the strict
    // default and recorded no acceptance of its own: nothing to weaken.
    expect(childEvents.filter((event) => event.type === 'sandbox/acceptance')).toHaveLength(0)
    const childView = await serve.request<{ accepts: string }>('session/authority', { sessionId: childId })
    expect(childView.accepts).toBe('full')

    // ---- the resumed child is exactly as narrow (S21.1) --------------------
    // The resume composed the child from its log alone — no resumer knew it
    // was narrowed — and its 'Say ok.' turn ran a step. A narrowing lost here
    // would have written a request header carrying the job tools.
    await serve.waitForCompletedTurn(childId, 2)
    const resumedChild = storedEvents(home, childId)
    const resumedAt = resumedChild.filter((event) => event.type === 'session/lifecycle').at(-1)!.seq
    expect(resumedAt, 'the child was resumed into a second lifecycle').toBeGreaterThan(0)
    expect(resumedChild.some((event) => event.type === 'step/start' && event.seq > resumedAt), 'the resumed lifecycle ran no step').toBe(true)
    expect(resumedChild.filter((event) => event.type === 'agent/narrowing'), 'a continuation writes no narrowing of its own').toHaveLength(1)
    narrowHeader(resumedChild, 'the resumed child')

    // ---- the parent finishes the job ---------------------------------------
    await serve.request('session/prompt', { sessionId, text: 'Now write the token you reported into found.txt in the working directory, on one line.' })
    await serve.waitForCompletedTurn(sessionId, 2)
    const final = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    await serve.shutdown()

    // ---- the child's authority, read cold from its own log -----------------
    // A separate process, holding only the stored bytes, states the ceiling and
    // the pin the runtime enforced, and the join back to the delegating call.
    const childCold = coldRead(home, ['inspect', childId, '--json'])
    expect(childCold.code, `cold inspect of the child: ${childCold.out}${childCold.err}`).toBe(0)
    const child = childCold.json as {
      verdict: string
      header: { delegatedBy?: string; delegatedByCallId?: string }
      authority: { delegation?: { ceiling?: string; pin?: string } }
    }
    expect(child.verdict).toBe('ok')
    expect(child.authority.delegation).toMatchObject({ ceiling: stamps[0]!.mode, pin: 'never' })
    expect((childCold.json as { narrowing?: unknown }).narrowing, 'a cold reader states the narrowing').toMatchObject({ tools: [{ deny: DENIED }] })
    expect(child.header).toMatchObject({ delegatedBy: sessionId, delegatedByCallId: (start!.data as { callId: string }).callId })
    const parentCold = coldRead(home, ['inspect', sessionId, '--json']).json as { children: { childId: string; callId: string; ended?: string }[] }
    expect(parentCold.children).toEqual([{ childId, callId: (start!.data as { callId: string }).callId, seq: start!.seq, ended: 'completed' }])

    // The WORLD: the parent wrote the file, the decoy is untouched, and the
    // child — asked to read, and unable to ask anyone for anything — wrote nothing.
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
        // The route the recording ran on, never a literal (A8-11).
        ...recordedRoute(parentTurnOne),
        approve: true,
        sessionsRoot: tempDir('minidsh-e2e6d-replay-'),
        // What `serve` mounted: the recorded requests carry its skill list.
        skillRoots: skillRootsFor(home),
        browserProfileRoot: join(home, 'browser-replay'),
        logger: silent,
        // The recording's composition, the narrowed row included: the child's
        // replayed requests carry what that row narrowed.
        patches: [{ id: 'llm-deepseek', disabled: true }, NARROWED_ROW],
        prepare: (context) => {
          replayHandle = installLlmReplay(context, { events: parentTurnOne, children: [{ id: childId, events: childEvents }] })
        },
      },
      undefined,
    )
    // Both sessions replayed their own recording — the child's found through
    // the call that delegated it, never by when it first asked — and both
    // were drained.
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
  })
})
