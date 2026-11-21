/**
 * Compaction driven by the real loop, through a real composition with the
 * invariants on.
 *
 * History is built by driving REAL turns through the scripted adapter:
 * appending hand-written turns to a live session desynchronises the driver's
 * turn numbering, and a compaction that only ever ran over fabricated history
 * would prove nothing about the loop. One responder answers every call — a
 * summarisation request (identified by `purpose`) gets a summary, a loop step
 * gets a bulky reply whose reported prompt grows the way a real one does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { AGENTS, agentPlugin, type Agent, type AgentHandle } from '../../core/agent/index.ts'
import { agentInvariantPlugin } from '../../core/agent/invariant.ts'
import { approvalPlugin } from '../../core/approval/index.ts'
import { COMPACTION, foldCompactionFailures, COMPACTION_APPLIED } from '../../core/compaction/index.ts'
import { invariantsPlugin } from '../../core/invariants/index.ts'
import { LLM, llmPlugin, LLM_AUX_CALL, type AuxCallRecord } from '../../core/llm/index.ts'
import { createUserMessage, messageText } from '../../core/llm/message.ts'
import { loopInvariantPlugin, loopPlugin, type LoopConfig } from '../../core/loop/index.ts'
import { PROMPT, promptPlugin } from '../../core/prompt/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../../core/sandbox/invariant.ts'
import { sessionInvariantPlugin, sessionPlugin, USER_MESSAGE } from '../../core/session/index.ts'
import { defineTool, TOOLS, toolsPlugin } from '../../core/tools/index.ts'
import { installLlmReplay } from '../../test-support/llm-replay.ts'
import { ScriptedAdapter, assistantText, type ScriptedResponse } from '../../test-support/scripted-adapter.ts'
import { compactionBasicPlugin, type CompactionBasicConfig } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

interface Harness {
  root: Context
  adapter: ScriptedAdapter
  create(provider?: string): Promise<AgentHandle>
  dispose(): Promise<void>
}

const open: Harness[] = []
afterEach(async () => {
  for (const mounted of open.splice(0)) await mounted.dispose()
})

async function harness(config: CompactionBasicConfig, withAdapter = true, loop?: LoopConfig): Promise<Harness> {
  const root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin, {})
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(sandboxPlugin, {})
  root.plugin(authorityInvariantPlugin)
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(loopPlugin, loop)
  root.plugin(loopInvariantPlugin)
  root.plugin(compactionBasicPlugin, config)
  await root.settle()
  const adapter = new ScriptedAdapter()
  // A replay harness registers the log-derived adapter instead: one provider
  // name, one adapter.
  if (withAdapter) root.get(LLM).registerAdapter(root, adapter)
  root.get(PROMPT).section(root, { name: 'persona', order: 0, text: 'You are a test agent.' })
  const handles: AgentHandle[] = []
  const created: Harness = {
    root,
    adapter,
    async create(provider = 'scripted') {
      const handle = await root.get(AGENTS).create(root, { cwd: process.cwd(), agentOptions: { provider, model: 'scripted-model' } })
      handles.push(handle)
      return handle
    },
    async dispose() {
      for (const handle of handles.toReversed()) await handle.dispose()
      await root.dispose()
    },
  }
  open.push(created)
  return created
}

interface ResponderOptions {
  /** The one loop call (counted from 1) the provider refuses as an overflow. */
  overflowOnCall?: number
  /** Every loop call from this one on is refused as an overflow: a provider no compaction satisfies. */
  overflowFromCall?: number
  failSummary?: boolean
  bloatedSummary?: boolean
  truncatedSummary?: boolean
}

function responder(options: ResponderOptions = {}): ScriptedResponse {
  let steps = 0
  let calls = 0
  return (request) => {
    if (request.purpose === 'compaction') {
      if (options.failSummary) return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'nope', code: 'SERVER' } } }]
      // A summariser that answers a short span at length: the call succeeds,
      // and the "compaction" it offers would leave the surface bigger.
      // A summary the output cap cut off mid-sentence.
      if (options.truncatedSummary) return [...assistantText('## Primary Request\n- the user asked to refactor the par').slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } }]
      if (options.bloatedSummary) return assistantText(`## Primary Request\n- keep going ${'z'.repeat(20_000)}`)
      return assistantText('## Primary Request\n- keep going\n## Next Step\n- finish the job')
    }
    calls += 1
    if (options.overflowOnCall === calls || (options.overflowFromCall !== undefined && calls >= options.overflowFromCall)) {
      return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'context size has been exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' } } }]
    }
    steps += 1
    return assistantText(`reply ${steps} ${'y'.repeat(320)}`, { inputTokens: steps * 130, outputTokens: 6 })
  }
}

/** Enough scripted answers that no test runs out of script mid-turn. */
function arm(test: Harness, options: ResponderOptions = {}): void {
  const shared = responder(options)
  test.adapter.script(...Array.from({ length: 40 }, () => shared))
}

async function grow(agent: Agent, turns: number): Promise<void> {
  for (let turn = 1; turn <= turns; turn++) {
    agent.followup(createUserMessage(`prompt ${turn} ${'x'.repeat(320)}`))
    await agent.whenIdle()
  }
}

function surfaceTexts(agent: Agent): string[] {
  return agent.session.deriveMessages().map((message) => messageText(message))
}

function appliedRecords(agent: Agent) {
  return agent.session.events.filter((event) => event.type === COMPACTION_APPLIED.type)
}

/** How each turn of the session ended, in order: its reason, and the failure's code when it failed. */
function turnEnds(agent: Agent): string[] {
  return agent.session.events
    .filter((event) => event.type === 'turn/end')
    .map((event) => (event.data as { reason: { kind: string; code?: string } }).reason)
    .map((reason) => (reason.code === undefined ? reason.kind : `${reason.kind} ${reason.code}`))
}

/**
 * Where a seq sits among the loop's own brackets: whether the nearest turn or
 * step bracket before it left a step open, and the first bracket after it.
 */
function boundaryAround(agent: Agent, seq: number): string {
  const loop = agent.session.events.filter((event) => ['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type))
  const before = loop.findLast((event) => event.seq < seq)?.type
  const after = loop.find((event) => event.seq > seq)?.type
  const state = before === 'turn/start' || before === 'step/end' ? 'no step open' : `after ${String(before)}`
  return `${state}, then ${String(after)}`
}

/** The compaction brackets of a log, in order: S for a start, E and why for an end. */
function brackets(agent: Agent): string[] {
  return agent.session.events.flatMap((event) => {
    if (event.type === 'compaction/start') return ['S']
    if (event.type !== 'compaction/end') return []
    const outcome = (event.data as { outcome: { kind: string; reason?: string } }).outcome
    return [`E ${outcome.reason ?? outcome.kind}`]
  })
}

/** A promise and the function that settles it, for a test to hold a scripted answer until it says. */
function latch(): { readonly reached: Promise<void>; readonly open: () => void } {
  let settle!: () => void
  const reached = new Promise<void>((resolve) => (settle = resolve))
  return { reached, open: settle }
}

describe('compaction through the real loop', () => {
  it('replaces the oldest history with a summary, keeping every shadowed event in the log', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 6)

    const before = agent.session.events.length
    const nodesBefore = agent.session.surfaceSeqs().length
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')

    // The log grew; nothing was removed, renumbered, or rewritten.
    expect(agent.session.events.length).toBeGreaterThan(before)
    for (let seq = 0; seq < before; seq++) expect(agent.session.events[seq]!.seq).toBe(seq)
    expect(agent.session.surfaceSeqs().length).toBeLessThan(nodesBefore)

    // The bracket closes AFTER the mutation, so the replace is no longer the
    // last event; it is the last SURFACE one.
    const tail = agent.session.events.slice(-2)
    const replace = tail[0]!
    expect(replace.type).toBe('user/message')
    expect(replace.surfaceOp).toMatchObject({ op: 'replace' })
    expect(tail[1]!.type).toBe('compaction/end')
    expect(tail[1]!.data).toMatchObject({ outcome: { kind: 'applied' } })

    const data = appliedRecords(agent).at(-1)!.data as { shadowedSeqs: number[]; trigger: string; auxCallSeq: number }
    expect(data.trigger).toBe('explicit')
    // Every shadowed node is cited by the replace itself, not merely recorded beside it.
    expect([...(replace.sourceEventSeqs ?? [])].toSorted((a, b) => a - b)).toEqual([...data.shadowedSeqs].toSorted((a, b) => a - b))
    for (const seq of data.shadowedSeqs) {
      expect(agent.session.events[seq]).toBeDefined()
      expect(agent.session.surfaceSeqs()).not.toContain(seq)
    }

    // The summary call is durable, and joined to the record by seq.
    const auxCall = agent.session.events[data.auxCallSeq]!
    expect(auxCall.type).toBe(LLM_AUX_CALL.type)
    expect((auxCall.data as AuxCallRecord).purpose).toBe('compaction')
    expect((auxCall.data as AuxCallRecord).inputSeqs).toEqual(data.shadowedSeqs)

    expect(surfaceTexts(agent)[0]).toContain('<system-reminder>')
  })

  // S20.5, live: a summarizer that spent its answer on tool calls wrote no
  // summary, twice, and compaction declined both. The tools stay in the
  // request (the loop's prefix) but none may be called.
  it('asks for its summary with the tools shown and none callable', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 6)
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')
    const summary = test.adapter.calls.find((call) => call.purpose === 'compaction')!
    expect(summary.toolChoice).toBe('none')
    // Loop steps leave the choice to the model: six of them, one per turn.
    expect(test.adapter.calls.filter((call) => call.purpose === undefined).map((call) => call.toolChoice)).toEqual(Array.from({ length: 6 }, () => undefined))
  })

  it('leaves history alone when the summary call fails, and still records the attempt', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test, { failSummary: true })
    await grow(agent, 6)
    const nodesBefore = [...agent.session.surfaceSeqs()]

    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('nothing-to-do')
    expect(agent.session.surfaceSeqs()).toEqual(nodesBefore)
    expect(appliedRecords(agent)).toHaveLength(0)
    // A compaction that could not summarise must drop nothing — but it still
    // has to explain itself.
    const aux = agent.session.events.filter((event) => event.type === LLM_AUX_CALL.type).at(-1)!
    expect((aux.data as AuxCallRecord).outcome.kind).toBe('error')
  })

  // The S20.5 audit's reproduction: a summary cut off at the output cap was
  // applied as if whole, replacing history with text that stops mid-sentence.
  it('refuses a summary the output cap cut off, and counts it as a failure', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test, { truncatedSummary: true })
    await grow(agent, 6)
    const nodesBefore = [...agent.session.surfaceSeqs()]
    expect(await test.root.get(COMPACTION).compactNow(agent)).toMatchObject({ kind: 'nothing-to-do', reason: 'summary-failed' })
    expect(agent.session.surfaceSeqs()).toEqual(nodesBefore)
    expect(appliedRecords(agent)).toHaveLength(0)
    const aux = agent.session.events.filter((event) => event.type === LLM_AUX_CALL.type).at(-1)!
    expect((aux.data as AuxCallRecord).outcome).toMatchObject({ kind: 'text', truncated: true })
    expect(foldCompactionFailures(agent.session.facts)).toBe(1)
  })

  it('brackets every attempt, and names why one produced nothing', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test, { failSummary: true })
    await grow(agent, 6)

    const outcome = await test.root.get(COMPACTION).compactNow(agent)
    // The reason reaches the caller on the idle path — which is what finally
    // lets `/compact` say WHICH of the three things happened.
    expect(outcome).toMatchObject({ kind: 'nothing-to-do', reason: 'summary-failed' })

    const starts = agent.session.events.filter((event) => event.type === 'compaction/start')
    const ends = agent.session.events.filter((event) => event.type === 'compaction/end')
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    // The start records what was attempted, before anything was bought.
    expect(starts[0]!.data).toMatchObject({ trigger: 'explicit', budgetTokens: 4000 })
    expect((starts[0]!.data as { plannedNodes: number }).plannedNodes).toBeGreaterThan(0)
    // The end names the start it closes, so a reader can pair them.
    expect(ends[0]!.data).toMatchObject({ startSeq: starts[0]!.seq, outcome: { kind: 'declined', reason: 'summary-failed' } })
  })

  it('opens no bracket when there is nothing to attempt, so a session under pressure does not flood its log', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test)
    // Two nodes is below the planner's minimum, so there is no plan and no attempt.
    await grow(agent, 1)
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('nothing-to-do')
    expect(agent.session.events.filter((event) => event.type === 'compaction/start')).toHaveLength(0)
  })

  /**
   * The distinction the outcome union depends on, and it is not decorative: a
   * cancellation and a summariser failure are counted differently, and until
   * `summarise` returned a reason both arrived as the same `undefined`. Two
   * interrupted compactions would have disabled the automatic triggers with
   * every summary call having succeeded.
   */
  it('records a cancelled summary as cancelled, and the fold does not count it', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false, maxSummaryFailures: 2 })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 6)

    // Cancelled before the attempt even began: no bracket to open and close.
    const early = new AbortController()
    early.abort()
    expect(await test.root.get(COMPACTION).compactNow(agent, early.signal)).toMatchObject({ kind: 'nothing-to-do', reason: 'cancelled' })
    expect(agent.session.events.filter((event) => event.type === 'compaction/start')).toHaveLength(0)

    // Cancelled DURING the summary: the bracket closes `cancelled`, uncounted.
    const controller = new AbortController()
    test.adapter.scriptWhen(
      (request) => request.purpose === 'compaction',
      () => {
        controller.abort()
        return assistantText('## Primary Request\n- never delivered')
      },
    )
    const outcome = await test.root.get(COMPACTION).compactNow(agent, controller.signal)
    expect(outcome).toMatchObject({ kind: 'nothing-to-do', reason: 'cancelled' })
    const end = agent.session.events.filter((event) => event.type === 'compaction/end').at(-1)!
    expect(end.data).toMatchObject({ outcome: { kind: 'declined', reason: 'cancelled' } })
    expect(foldCompactionFailures(agent.session.facts, agent.session.liveStart)).toBe(0)
  })

  /**
   * S21.1: an idle `/compact` is work the agent OWNS (`Agent.own`). Before, a
   * disposal neither aborted nor awaited its summary: the call went on being
   * paid for, its record met a detached session, and `compaction/start` stayed
   * unpaired until some later resume closed it `unclosed`.
   */
  it('binds an idle /compact to its agent: a disposal aborts the summary and records the end before the log closes', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const handle = await test.create()
    const { agent } = handle
    arm(test)
    await grow(agent, 6)
    let summaryAsked!: () => void
    const asked = new Promise<void>((resolve) => (summaryAsked = resolve))
    let sawAbort = false
    test.adapter.scriptWhen(
      (request) => request.purpose === 'compaction',
      async (request) => {
        summaryAsked()
        // A provider that answers only once it is told to stop.
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
        sawAbort = request.signal?.aborted === true
        return assistantText('## Primary Request\n- too late')
      },
    )
    const outcome = test.root.get(COMPACTION).compactNow(agent)
    await asked
    const started = Date.now()
    await handle.dispose()
    expect(Date.now() - started, 'the disposal waited out a bound instead of aborting the call').toBeLessThan(3_000)
    expect(sawAbort, 'the disposal never aborted the summary call').toBe(true)
    expect(await outcome).toMatchObject({ kind: 'nothing-to-do', reason: 'cancelled' })
    const start = agent.session.events.filter((event) => event.type === 'compaction/start').at(-1)
    expect(start, 'no attempt was made').toBeDefined()
    const aux = agent.session.events.filter((event) => matchesAux(event)).at(-1)
    expect(aux?.data).toMatchObject({ purpose: 'compaction', outcome: { kind: 'error' } })
    const end = agent.session.events.filter((event) => event.type === 'compaction/end').at(-1)
    expect(end?.data, 'the bracket closed before the log did').toMatchObject({ startSeq: start!.seq, outcome: { kind: 'declined', reason: 'cancelled' } })
    // And a /compact that arrives once the disposal has begun starts nothing.
    expect(await test.root.get(COMPACTION).compactNow(agent)).toMatchObject({ kind: 'nothing-to-do' })
  })

  it('answers a /compact on an agent already being disposed as agent-gone, and opens no bracket', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 6)
    agent.cancel({ kind: 'disposed' })
    expect(await test.root.get(COMPACTION).compactNow(agent)).toEqual({ kind: 'nothing-to-do', reason: 'agent-gone' })
    expect(agent.session.events.filter((event) => event.type === 'compaction/start')).toHaveLength(0)
  })

  it('compacts under pressure before the step, and every request still equals the log', async () => {
    const test = await harness({ budgetTokens: 1200, retainRatio: 0.2, thresholdRatio: 0.5 })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 8)

    const applied = appliedRecords(agent)
    expect(applied.length).toBeGreaterThanOrEqual(1)
    expect((applied[0]!.data as { trigger: string }).trigger).toBe('pressure')
    // The loop invariant is mounted, so every completed turn is proof that the
    // request equalled `deriveMessages()` at `llm/stream`.
    expect(turnEnds(agent)).toEqual(Array.from({ length: 8 }, () => 'completed'))
    // The steps after it carried the summary, not the shadowed history.
    expect(messageText(test.adapter.calls.at(-1)!.messages[0]!)).toContain('<system-reminder>')
    // It landed inside a turn, at a step boundary: after the turn opened (or
    // the previous step closed) with no step open, and before the step it
    // protected opened. Never between a step's start and its end.
    expect(applied.map((event) => boundaryAround(agent, event.seq))).toEqual(applied.map(() => 'no step open, then step/start'))
  })

  it('answers a provider overflow by compacting and retrying the same step', async () => {
    // A budget nothing would trip on its own: only the provider's own refusal
    // can start this, which is the point.
    const test = await harness({ budgetTokens: 1_000_000, retainRatio: 0.2, thresholdRatio: 0.99 })
    const { agent } = await test.create()
    arm(test, { overflowOnCall: 4 })
    await grow(agent, 5)

    const applied = appliedRecords(agent)
    expect(applied).toHaveLength(1)
    expect((applied[0]!.data as { trigger: string }).trigger).toBe('context-overflow')
    expect(turnEnds(agent)).toEqual(Array.from({ length: 5 }, () => 'completed'))
    // Two attempts of one step, and the retried one was smaller than the one
    // the provider refused.
    const attempts = agent.session.events.filter((event) => event.type === 'assistant/chunk').map((event) => (event.data as { attempt: number }).attempt)
    expect(attempts).toContain(2)
    const loopCalls = test.adapter.calls.filter((call) => call.purpose === undefined)
    expect(loopCalls[4]!.messages.length).toBeLessThan(loopCalls[3]!.messages.length)
  })

  // The bound on that recovery: a provider that refuses the retried request
  // too gets no second compaction for the step. Without it each refusal bought
  // another summary for as long as the surface still had something to shadow.
  it('compacts once for an overflow and lets a second one on the same step end the turn', async () => {
    // A long tail kept, so a second compaction would have had a plan to run.
    const test = await harness({ budgetTokens: 1_000_000, retainRatio: 0.6, thresholdRatio: 0.99 })
    const { agent } = await test.create()
    arm(test, { overflowFromCall: 6 })
    await grow(agent, 6)

    expect(turnEnds(agent)).toEqual([...Array.from({ length: 5 }, () => 'completed'), 'error CONTEXT_WINDOW_EXCEEDED'])
    expect(appliedRecords(agent).map((event) => (event.data as { trigger: string }).trigger)).toEqual(['context-overflow'])
    expect(brackets(agent)).toEqual(['S', 'E applied'])
    // The refused step was tried twice: as asked, and once more after the compaction.
    const lastStep = agent.session.events.findLast((event) => event.type === 'step/start')!.seq
    const attempts = agent.session.events.filter((event) => event.seq > lastStep && event.type === 'assistant/chunk').map((event) => (event.data as { attempt: number }).attempt)
    expect([...new Set(attempts)]).toEqual([1, 2])
    // And a later compaction was still possible: the bound, not an empty plan, is what stopped it.
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')
  })

  // "One compaction per agent at a time": an idle /compact is waiting on its
  // summary when a turn starts and a second request reaches that turn's first
  // step boundary. Nothing else keeps the second from opening its own bracket
  // inside the first and rewriting the surface the first one planned over.
  it('starts no second compaction while one is waiting for its summary', async () => {
    const test = await harness({ budgetTokens: 1_000_000, retainRatio: 0.2, thresholdRatio: 0.99 })
    const { agent } = await test.create()
    const compaction = test.root.get(COMPACTION)
    const held = latch()
    const release = latch()
    const shared = responder() as Exclude<ScriptedResponse, unknown[]>
    // The first attempt, once it exists; whether its summary is being held; and
    // the compaction brackets the log held when the new turn's step asked the model.
    const flight: { first?: Promise<unknown>; holding: boolean; bracketsWhenTheStepAsked?: string[] } = { holding: false }
    test.adapter.script(
      ...Array.from({ length: 40 }, () => async (request: Parameters<typeof shared>[0]) => {
        if (request.purpose === 'compaction' && flight.first !== undefined && !flight.holding) {
          flight.holding = true
          held.open()
          await release.reached
        } else if (request.purpose === undefined && flight.holding && flight.bracketsWhenTheStepAsked === undefined) {
          // The new turn's pre-step has run: its step is asking the model. What
          // the log holds now is what that boundary did. Then the first summary
          // is let go, and this step waits for the first attempt to end.
          flight.bracketsWhenTheStepAsked = brackets(agent)
          release.open()
          await flight.first
        }
        return shared(request)
      }),
    )
    await grow(agent, 6)
    flight.first = compaction.compactNow(agent)
    await held.reached
    agent.followup(createUserMessage('a turn that starts during the summary'))
    // A second request, on a running agent: deferred to the next step boundary.
    expect((await compaction.compactNow(agent)).kind).toBe('scheduled')
    expect(await flight.first).toMatchObject({ kind: 'nothing-to-do', reason: 'turn-started' })
    await agent.whenIdle()

    // At that boundary the first attempt was still the only one, and still open.
    expect(flight.bracketsWhenTheStepAsked, 'the step boundary opened a bracket of its own inside the one in flight').toEqual(['S'])
    // One at a time, start to end: the first declined for the turn that began,
    // the deferred one honoured at that turn's end.
    expect(brackets(agent)).toEqual(['S', 'E turn-started', 'S', 'E applied'])
    expect(appliedRecords(agent).map((event) => (event.data as { trigger: string }).trigger)).toEqual(['explicit'])
  })

  // The plan is checked against the LIVE surface after the summary returns,
  // with no await before the append. Without the check a plan whose head was
  // rewritten meanwhile wrote `compaction/applied` and then threw from the
  // replace the surface refused: an applied record with nothing applied.
  it('declines a plan the surface moved under during the summary, and applies nothing', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    const held = latch()
    const release = latch()
    const shared = responder() as Exclude<ScriptedResponse, unknown[]>
    test.adapter.script(
      ...Array.from({ length: 40 }, () => async (request: Parameters<typeof shared>[0]) => {
        if (request.purpose === 'compaction') {
          held.open()
          await release.reached
        }
        return shared(request)
      }),
    )
    await grow(agent, 6)
    const outcome = test.root.get(COMPACTION).compactNow(agent)
    await held.reached
    // Something else replaces the first two nodes of the planned head.
    const head = agent.session.surfaceSeqs().slice(0, 2)
    agent.session.append(USER_MESSAGE, { message: createUserMessage('an earlier summary, written meanwhile') }, { surfaceOp: { op: 'replace', start: head[0]!, end: head[1]! }, sourceEventSeqs: head })
    const surface = [...agent.session.surfaceSeqs()]
    release.open()

    expect(await outcome).toEqual({ kind: 'nothing-to-do', reason: 'plan-stale' })
    expect(brackets(agent)).toEqual(['S', 'E plan-stale'])
    expect(appliedRecords(agent)).toEqual([])
    expect(agent.session.surfaceSeqs()).toEqual(surface)
    // Not a summariser failure: the call worked, and the next attempt plans over what is there now.
    expect(foldCompactionFailures(agent.session.facts, agent.session.liveStart)).toBe(0)
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')
  })

  // A disposal waits for a compaction the agent owns, but only up to a bound;
  // past it the session is detached with the summary still out. When that
  // summary returns there is no log left to write to, and the registry is the
  // one thing that says so before any append is tried.
  it('writes nothing into a session that was detached while its summary was out', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false }, true, { ownedWorkBoundMs: 50 })
    const handle = await test.create()
    const { agent } = handle
    const held = latch()
    const release = latch()
    const shared = responder() as Exclude<ScriptedResponse, unknown[]>
    test.adapter.script(
      ...Array.from({ length: 40 }, () => async (request: Parameters<typeof shared>[0]) => {
        if (request.purpose === 'compaction') {
          held.open()
          // A provider that does not stop when told to: only the test lets it answer.
          await release.reached
        }
        return shared(request)
      }),
    )
    await grow(agent, 6)
    const outcome = test.root.get(COMPACTION).compactNow(agent)
    await held.reached
    await handle.dispose()
    expect(test.root.get(AGENTS).get(agent.id)).toBeUndefined()
    const logged = agent.session.events.length
    release.open()
    expect(await outcome).toEqual({ kind: 'nothing-to-do', reason: 'agent-gone' })
    expect(agent.session.events).toHaveLength(logged)
  })

  /**
   * Each summary attempt replays a whole shadowed span — roughly a full-budget
   * request. A summariser that keeps failing would buy one at EVERY step
   * boundary, forever, with no backoff and no user-facing signal.
   */
  it('gives up on the automatic triggers after repeated summary failures', async () => {
    const test = await harness({ budgetTokens: 1200, retainRatio: 0.2, thresholdRatio: 0.5, maxSummaryFailures: 2 })
    const { agent } = await test.create()
    arm(test, { failSummary: true })
    await grow(agent, 8)

    expect(appliedRecords(agent)).toHaveLength(0)
    const attempts = agent.session.events.filter((event) => event.type === LLM_AUX_CALL.type)
    expect(attempts.map((event) => (event.data as AuxCallRecord).outcome.kind)).toEqual(['error', 'error'])
    // Every turn still completed: a failing summariser must never fail the work.
    expect(turnEnds(agent)).toEqual(Array.from({ length: 8 }, () => 'completed'))
  })

  /**
   * The one outcome a compaction must never have: a surface bigger than it
   * found. It is reachable whenever the plan's head is small and the model
   * answers it at length — a live S5 arc measured 4,545 against 4,314 — and by
   * then the call is already paid for, so the only question left is whether to
   * hide real history behind a summary that saves nothing.
   */
  it('refuses a summary at least as large as the span it would replace, and gives up after enough of them', async () => {
    const test = await harness({ budgetTokens: 1200, retainRatio: 0.2, thresholdRatio: 0.5, maxSummaryFailures: 2 })
    const { agent } = await test.create()
    arm(test, { bloatedSummary: true })
    const surfaceBefore = agent.session.surfaceSeqs().length
    await grow(agent, 8)

    // Nothing was applied, and the surface still holds every turn's own nodes.
    expect(appliedRecords(agent)).toHaveLength(0)
    expect(agent.session.surfaceSeqs().length).toBeGreaterThan(surfaceBefore)
    expect(agent.session.events.some((event) => event.surfaceOp?.op === 'replace')).toBe(false)

    // The summary CALLS succeeded — this is not the failing-summariser path —
    // and the give-up counter still bounded them at `maxSummaryFailures`.
    const attempts = agent.session.events.filter((event) => event.type === LLM_AUX_CALL.type)
    expect(attempts.map((event) => (event.data as AuxCallRecord).outcome.kind)).toEqual(['text', 'text'])

    // And the work itself never suffered for it.
    expect(turnEnds(agent)).toEqual(Array.from({ length: 8 }, () => 'completed'))
  })

  /**
   * `/compact` during the LAST step of a turn has no later step boundary to run
   * at, and the terminal has already promised the user it would run.
   */
  it('honours a deferred compaction at the end of the turn it was asked during', async () => {
    const test = await harness({ budgetTokens: 1_000_000, retainRatio: 0.2, thresholdRatio: 0.99 })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 6)

    agent.followup(createUserMessage('one last thing'))
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('scheduled')
    await agent.whenIdle()

    expect(appliedRecords(agent)).toHaveLength(1)
    expect(agent.status).toBe('idle')
  })

  // §6 names THE hazard: the summary is an await, and a turn may start during
  // it. The guard (status captured before any await, compared with none after)
  // had no behavioural test, so moving it past an await would have passed
  // every test while a replace landed between a step's request and its answer.
  it('declines a summary a turn started during, and asks again at that turn\'s next boundary', async () => {
    const test = await harness({ budgetTokens: 1_000_000, retainRatio: 0.2, thresholdRatio: 0.99 })
    const { agent } = await test.create()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const state = { held: false }
    const shared = responder()
    test.adapter.script(
      ...Array.from({ length: 40 }, () => async (request: Parameters<Exclude<ScriptedResponse, unknown[]>>[0]) => {
        if (request.purpose === 'compaction' && !state.held) {
          state.held = true
          await gate
        }
        return (shared as Exclude<ScriptedResponse, unknown[]>)(request)
      }),
    )
    await grow(agent, 6)
    const outcome = test.root.get(COMPACTION).compactNow(agent)
    while (!state.held) await new Promise((resolve) => setTimeout(resolve, 5))
    agent.followup(createUserMessage('a turn that starts during the summary'))
    release()
    expect(await outcome).toMatchObject({ kind: 'nothing-to-do', reason: 'turn-started' })
    await agent.whenIdle()
    // Re-armed, and honoured where a replace is legal: a step boundary of that turn.
    const applied = appliedRecords(agent)
    expect(applied).toHaveLength(1)
    expect((applied[0]!.data as { trigger: string }).trigger).toBe('explicit')
  })

  // The S20.5 audit: the planner shadows history, never the prefix (system
  // prompt + tool schemas), so a prefix at or past the threshold is pressure
  // no compaction can relieve — and each boundary bought another summary,
  // every applied one resetting the give-up count.
  it('buys no summary for pressure the fixed prefix alone creates', async () => {
    const test = await harness({ budgetTokens: 400, retainRatio: 0.2, thresholdRatio: 0.5 })
    // A schema heavier than the threshold on its own (~250 estimator tokens against 200).
    test.root.get(TOOLS).register(test.root, defineTool({ name: 'heavy', description: 'x'.repeat(1_000), input: z.object({}), output: z.object({}), execute: () => ({}), render: () => [] }))
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 3)
    expect(agent.session.events.filter((event) => event.type === 'compaction/start')).toHaveLength(0)
    expect(agent.session.events.filter((event) => event.type === LLM_AUX_CALL.type)).toHaveLength(0)
  })

  it('defers an explicit compaction on a running agent to its next step boundary', async () => {
    const test = await harness({ budgetTokens: 1_000_000, retainRatio: 0.2, thresholdRatio: 0.99 })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 6)

    // `send` flips the status synchronously, so this observes a running agent —
    // one that may already have a request in flight, which no re-check after
    // the summary await could make safe.
    agent.followup(createUserMessage('carry on'))
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('scheduled')
    await agent.whenIdle()

    const applied = appliedRecords(agent)
    expect(applied).toHaveLength(1)
    expect((applied[0]!.data as { trigger: string }).trigger).toBe('explicit')
  })

  /**
   * The S5 exit criterion, and the sharpest one: a compacted log is still its
   * own oracle. The replay serves loop steps from `assistant/chunk` and the
   * summary from its `llm/aux-call` record, and BOTH cursors must be drained —
   * so the replayed session compacted at the same point, with the same summary.
   */
  it('replays a compacted log keylessly, consuming the recorded summary call too', async () => {
    const recorder = await harness({ budgetTokens: 1200, retainRatio: 0.2, thresholdRatio: 0.5 })
    const { agent } = await recorder.create()
    arm(recorder)
    await grow(agent, 8)
    expect(appliedRecords(agent).length).toBeGreaterThanOrEqual(1)
    const recorded = agent.session.events.map((event) => ({ ...event }))
    const recordedText = messageText(agent.session.deriveMessages().at(-1)!)

    // A fresh runtime, the same composition, and NO adapter but the log itself.
    const replayed = await harness({ budgetTokens: 1200, retainRatio: 0.2, thresholdRatio: 0.5 }, false)
    const replay = installLlmReplay(replayed.root, { events: recorded, provider: 'scripted' })
    expect(replay.auxCalls).toBeGreaterThanOrEqual(1)
    const second = await replayed.create()
    await grow(second.agent, 8)

    replay.assertConsumed()
    expect(messageText(second.agent.session.deriveMessages().at(-1)!)).toBe(recordedText)
    // And it compacted the same number of times, from the same facts.
    expect(appliedRecords(second.agent)).toHaveLength(appliedRecords(agent).length)
    replay.dispose()
  })

  it('compacts a second time over a range that starts at the previous summary', async () => {
    const test = await harness({ budgetTokens: 4000, retainRatio: 0.2, auto: false })
    const { agent } = await test.create()
    arm(test)
    await grow(agent, 6)
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')
    const firstSummarySeq = agent.session.surfaceSeqs()[0]!

    await grow(agent, 6)
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')

    const applied = appliedRecords(agent)
    expect(applied).toHaveLength(2)
    // The second run shadowed the first summary node — legal only because it
    // was still a LIVE surface node, which is what `Surface.validate` enforces.
    expect((applied[1]!.data as { shadowedSeqs: number[] }).shadowedSeqs).toContain(firstSummarySeq)
    expect(agent.session.surfaceSeqs()).not.toContain(firstSummarySeq)
    expect(surfaceTexts(agent)[0]).toContain('<system-reminder>')
  })
})

describe('the summary takes the route the log names', () => {
  it('measures against the window the log records and summarises down the route a listener chose', async () => {
    const test = await harness({ retainRatio: 0.25, maxTokens: 512 })
    arm(test)
    const { AGENT_REQUEST } = await import('../../core/agent/index.ts')
    test.root.on(
      AGENT_REQUEST,
      async (context, next) => {
        const config = await next()
        return context.purpose === 'compaction' ? { ...config, model: 'cheap-model' } : config
      },
      { global: true },
    )
    const { agent } = await test.create()
    await grow(agent, 4)
    const outcome = await test.root.get(COMPACTION).compactNow(agent)
    expect(outcome.kind).toBe('compacted')
    const record = appliedRecords(agent).at(-1)!.data as { budgetTokens: number; auxCallSeq: number }
    // No budgetTokens configured: the budget is the window the log recorded for the loop's route.
    expect(record.budgetTokens).toBe(100_000)
    const aux = agent.session.events[record.auxCallSeq]!.data as AuxCallRecord
    expect([aux.provider, aux.model]).toEqual(['scripted', 'cheap-model'])
    // The loop's own route never moved: the summary's route is the aux record's, not the header's.
    expect(agent.session.foldRequestHeader()!.model).toBe('scripted-model')
  })
})

function matchesAux(event: { readonly type: string }): boolean {
  return event.type === LLM_AUX_CALL.type
}
