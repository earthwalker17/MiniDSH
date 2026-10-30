/**
 * The S21 parallel-delegation live end-to-end: several children doing real
 * work at once, joined at the parent's step (ARCHITECTURE §6).
 *
 * One arc, over real stdio JSON-RPC to `minidsh serve` against the real
 * DeepSeek API.
 *
 *   the batch    the parent puts its delegations in ONE assistant message —
 *                an assumption about the model (S21's Phase 0 measured 25 of
 *                25), asserted so its decay is named, not discovered
 *   overlap      the children's turns overlap in time, read from their own
 *                logs: the separating assertion, about the runtime, not the
 *                model — a serial executor cannot produce it whatever the
 *                model says
 *   order        the parent's results commit in model order, each citing its call
 *                (the separating test for order is the unit suite's; this run
 *                reports whether its children finished out of model order)
 *   the world    each child wrote its own directory's file, and only that
 *   replay       the parent and every child replay, bound by delegation: the
 *                children are handed over in REVERSED order, and each replayed
 *                call's result must be the one its own child gave — the world
 *                alone cannot tell, since a log replays the same file whoever
 *                runs it (S21 review)
 *   measured     the delegating step's wall clock against the children's sum
 *                (S21 Phase 0, serial: 24.9 s and 28.9 s, each the sum)
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay, recordedRoute } from '../test-support/llm-replay.ts'
import { coldRead, killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { runTask } from './headless.ts'
import { skillRootsFor } from './home.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }

const TEAMS = { alpha: 'AMBER-FALCON', beta: 'COBALT-HERON', gamma: 'OPAL-LYNX' } as const

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

/** The numbers behind the assertions, where a passing run can be read (vitest hides a green test's output when piped). */
function probe(lines: readonly string[]): void {
  const target = process.env.MINIDSH_E2E_PROBE
  if (target) appendFileSync(target, `${lines.join('\n')}\n`, 'utf8')
}

function seedWorkspace(dir: string): void {
  for (const [team, codename] of Object.entries(TEAMS)) {
    mkdirSync(join(dir, team), { recursive: true })
    writeFileSync(join(dir, team, 'notes.md'), `Team ${team} notes.\nRelease codename: ${codename}\n`, 'utf8')
    writeFileSync(join(dir, team, 'plan.txt'), 'step one\nstep two\n', 'utf8')
  }
}

function storedEvents(home: string, id: string): EventEnvelope[] {
  return readFileSync(join(home, 'sessions', `${encodeURIComponent(id)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

/** A child's working span: its first turn's start to its last turn's end. */
function span(events: readonly EventEnvelope[]): { start: number; end: number } {
  const starts = events.filter((event) => event.type === 'turn/start').map((event) => event.time)
  const ends = events.filter((event) => event.type === 'turn/end').map((event) => event.time)
  return { start: Math.min(...starts), end: Math.max(...ends) }
}

/** The text a tool result carries, inside its `tool-result` block. */
function resultText(event: EventEnvelope): string {
  type Block = { type: string; text?: string; content?: Block[] }
  const flatten = (blocks: readonly Block[]): string => blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : flatten(block.content ?? []))).join('')
  return flatten((event.data as { message: { content: Block[] } }).message.content)
}

const PROMPT =
  'Do not read any file yourself. In ONE message, start three subagents at once: one finds the release codename in alpha/, one in beta/, ' +
  'one in gamma/, and each writes that codename alone into CODENAME.txt in its own directory. Name every file by its relative path ' +
  '(alpha/notes.md, alpha/CODENAME.txt), never an absolute one, in the prompt of each subagent too. Then tell me the three codenames.'

describe.skipIf(!KEY)('S21 live E2E: delegations in one message run at once, joined at the parent\'s step', () => {
  it('overlaps the children, commits their answers in model order, and replays them bound by delegation', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-e2e21-ws-')
    const home = tempDir('minidsh-e2e21-home-')
    seedWorkspace(workspace)

    const serve = new ServeProcess(workspace, home, {})
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: PROMPT })
    await serve.waitForCompletedTurn(sessionId, 1)
    const parentLog = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    await serve.shutdown()
    const events = parentLog.events

    // ---- the batch: the premise, measured ------------------------------------
    const batch = events.find(
      (event) => event.type === 'assistant/message' && (event.data as { message: { content: { type: string; name?: string }[] } }).message.content.some((block) => block.type === 'tool-call' && block.name === 'subagent'),
    )
    expect(batch, 'the model never delegated').toBeDefined()
    const { turn, step, message } = batch!.data as { turn: number; step: number; message: { content: { type: string; name?: string; id?: string }[] } }
    const delegated = message.content.filter((block) => block.type === 'tool-call' && block.name === 'subagent').map((block) => block.id!)
    expect(delegated.length, 'the model delegated one task at a time: the premise S21 Phase 0 measured has decayed').toBeGreaterThanOrEqual(2)

    // ---- the children, one session each, all completed -----------------------
    const starts = events.filter((event) => event.type === 'subagent/start').map((event) => event.data as { callId: string; childId: string })
    const ends = events.filter((event) => event.type === 'subagent/end').map((event) => event.data as { callId: string; reason: { kind: string } })
    expect(
      starts.map((start) => start.callId).toSorted(),
      'the children started are not exactly the batch: the model delegated outside its one message, or a batched call never reached its body',
    ).toEqual([...delegated].toSorted())
    expect(ends.map((end) => end.reason.kind)).toEqual(ends.map(() => 'completed'))
    const children = starts.map((start) => ({ ...start, events: storedEvents(home, start.childId) }))

    // ---- overlap: the runtime ran them at once -------------------------------
    const spans = children.map((child) => span(child.events))
    const latestStart = Math.max(...spans.map((s) => s.start))
    const earliestEnd = Math.min(...spans.map((s) => s.end))
    expect(latestStart, 'the children ran one after another: every child must start before any child ends').toBeLessThan(earliestEnd)

    // ---- order: results in model order, each citing its own call --------------
    const stepCalls = events.filter((event) => event.type === 'tool/call' && (event.data as { turn: number; step: number }).turn === turn && (event.data as { step: number }).step === step)
    const stepResults = events.filter((event) => event.type === 'tool/result' && (event.data as { turn: number; step: number }).turn === turn && (event.data as { step: number }).step === step)
    const modelOrder = message.content.filter((block) => block.type === 'tool-call').map((block) => block.id!)
    expect(stepResults.map((event) => (event.data as { callId: string }).callId)).toEqual(modelOrder)
    const callSeq = new Map(stepCalls.map((event) => [(event.data as { callId: string }).callId, event.seq]))
    for (const result of stepResults) expect(result.sourceEventSeqs).toEqual([callSeq.get((result.data as { callId: string }).callId)])

    // ---- the world: each child wrote its own directory's file ------------------
    for (const [team, codename] of Object.entries(TEAMS)) {
      const file = join(workspace, team, 'CODENAME.txt')
      expect(existsSync(file), `${team}/CODENAME.txt was never written`).toBe(true)
      expect(readFileSync(file, 'utf8').trim()).toBe(codename)
    }
    // ... and only that: the replay below removes exactly these files, so a
    // child that wrote anything else would make the replay start from another world.
    const seeded = Object.keys(TEAMS).flatMap((team) => [`${team}/notes.md`, `${team}/plan.txt`, `${team}/CODENAME.txt`])
    const present = (readdirSync(workspace, { recursive: true }) as string[])
      .filter((entry) => statSync(join(workspace, entry)).isFile())
      .map((entry) => entry.split(sep).join('/'))
    expect(present.toSorted(), 'a child wrote outside its own CODENAME.txt').toEqual(seeded.toSorted())

    // ---- measured: the step against what a serial executor would have cost ----
    const stepEnd = events.find((event) => event.type === 'step/end' && (event.data as { turn: number; step: number }).turn === turn && (event.data as { step: number }).step === step)!
    const joinedMs = stepEnd.time - batch!.time
    const childMs = spans.map((s) => s.end - s.start)
    const serialMs = childMs.reduce((sum, ms) => sum + ms, 0)
    expect(joinedMs, 'the step took as long as its children run one by one').toBeLessThan(serialMs)
    const finished = events.filter((event) => event.type === 'subagent/end').map((event) => (event.data as { callId: string }).callId)
    // The prompt pins relative paths and a child may ignore it (one WSL run in three did, S21): counted. The replay runs
    // in this workspace, so such a path replays where it was recorded. Arguments are JSON text, so the workspace
    // appears there in its JSON-escaped spelling.
    const escapedRoot = JSON.stringify(workspace).slice(1, -1)
    const absolute = children.flatMap((child) => child.events.filter((event) => event.type === 'tool/call' && (event.data as { arguments: string }).arguments.includes(escapedRoot))).length
    const line = `[parallel arc] ${delegated.length} children in one message; the delegating step took ${joinedMs} ms against ${serialMs} ms serial (children ${childMs.join(', ')} ms); finished ${finished.join(' ')} for model order ${modelOrder.join(' ')}; ${absolute} child call(s) named an absolute path`
    console.log(line)
    probe([line])

    // ---- the parent's cold record joins each child to its call ------------------
    const parentCold = coldRead(home, ['inspect', sessionId, '--json']).json as { children: { childId: string; callId: string; ended?: string }[] }
    expect(parentCold.children.map((child) => `${child.callId}:${child.ended}`).toSorted()).toEqual(starts.map((start) => `${start.callId}:completed`).toSorted())

    // ---- replay, bound by delegation, children handed over in reverse -----------
    const parentTurnOne = events.slice(0, events.findIndex((event) => event.type === 'turn/end') + 1)
    // The replay runs in the SAME workspace, the children's files removed: a
    // child that named a path absolutely (the prompt asks it not to; one WSL
    // run in three did anyway, S21) replays inside the fence of the root its
    // recording named, so the world check tests the runtime, not the model's
    // path style. A fresh root would refuse every such write.
    const replayWorkspace = workspace
    for (const team of Object.keys(TEAMS)) rmSync(join(replayWorkspace, team, 'CODENAME.txt'), { force: true })
    for (const team of Object.keys(TEAMS)) expect(existsSync(join(replayWorkspace, team, 'CODENAME.txt'))).toBe(false)
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayFrames: { sessionId: string; event: EventEnvelope }[] = []
    const replayed = await runTask(
      {
        task: PROMPT,
        cwd: replayWorkspace,
        ...recordedRoute(parentTurnOne),
        approve: true,
        sessionsRoot: tempDir('minidsh-e2e21-replay-'),
        skillRoots: skillRootsFor(home),
        browserProfileRoot: join(home, 'browser-replay'),
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (context) => {
          replayHandle = installLlmReplay(context, { events: parentTurnOne, children: children.map((child) => ({ id: child.childId, events: child.events })).toReversed() })
        },
      },
      (frame) => void replayFrames.push(frame),
    )
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
    // Each replayed call was served by its OWN child's recording. A mis-bound child replays a sibling's log, writes the
    // same files and drains every cursor, so the world cannot tell; the answer text can only when siblings answered
    // differently. The children's own tool calls can: each child names its own directory, so a mis-bound child's
    // calls are its sibling's (S21 final review).
    const replayedResults = new Map(
      replayFrames.filter((frame) => frame.sessionId === replayed.sessionId && frame.event.type === 'tool/result').map((frame) => [(frame.event.data as { callId: string }).callId, resultText(frame.event)]),
    )
    for (const recorded of stepResults) {
      const callId = (recorded.data as { callId: string }).callId
      expect(replayedResults.get(callId), `call ${callId} replayed another child's answer`).toBe(resultText(recorded))
    }
    const replayedChild = new Map(
      replayFrames
        .filter((frame) => frame.sessionId === replayed.sessionId && frame.event.type === 'subagent/start')
        .map((frame) => [(frame.event.data as { callId: string }).callId, (frame.event.data as { childId: string }).childId]),
    )
    const callsOf = (list: readonly EventEnvelope[]): string[] => list.filter((event) => event.type === 'tool/call').map((event) => (event.data as { arguments: string }).arguments)
    for (const child of children) {
      const replayedId = replayedChild.get(child.callId)
      expect(replayedId, `call ${child.callId} started no child in the replay`).toBeDefined()
      const replayedCalls = callsOf(replayFrames.filter((frame) => frame.sessionId === replayedId).map((frame) => frame.event))
      expect(replayedCalls.length, `call ${child.callId}'s child made no tool call, so its binding is unproved`).toBeGreaterThan(0)
      expect(replayedCalls, `call ${child.callId}'s child replayed a sibling's recording`).toEqual(callsOf(child.events))
    }
    // The replay reproduced the world: each child wrote its own file again.
    for (const [team, codename] of Object.entries(TEAMS)) expect(readFileSync(join(replayWorkspace, team, 'CODENAME.txt'), 'utf8').trim()).toBe(codename)
  })
})
