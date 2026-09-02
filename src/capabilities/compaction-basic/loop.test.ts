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
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { AGENTS, agentPlugin, type Agent, type AgentHandle } from '../../core/agent/index.ts'
import { agentInvariantPlugin } from '../../core/agent/invariant.ts'
import { approvalPlugin } from '../../core/approval/index.ts'
import { COMPACTION, foldCompactionFailures, COMPACTION_APPLIED } from '../../core/compaction/index.ts'
import { invariantsPlugin } from '../../core/invariants/index.ts'
import { LLM, llmPlugin, LLM_AUX_CALL, type AuxCallRecord } from '../../core/llm/index.ts'
import { createUserMessage, messageText } from '../../core/llm/message.ts'
import { loopInvariantPlugin, loopPlugin } from '../../core/loop/index.ts'
import { PROMPT, promptPlugin } from '../../core/prompt/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../../core/sandbox/invariant.ts'
import { sessionInvariantPlugin, sessionPlugin } from '../../core/session/index.ts'
import { toolsPlugin } from '../../core/tools/index.ts'
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

async function harness(config: CompactionBasicConfig, withAdapter = true): Promise<Harness> {
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
  root.plugin(loopPlugin)
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

function responder(options: { overflowOnCall?: number; failSummary?: boolean; bloatedSummary?: boolean } = {}): ScriptedResponse {
  let steps = 0
  let calls = 0
  return (request) => {
    if (request.purpose === 'compaction') {
      if (options.failSummary) return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'nope', code: 'SERVER' } } }]
      // A summariser that answers a short span at length: the call succeeds,
      // and the "compaction" it offers would leave the surface bigger.
      if (options.bloatedSummary) return assistantText(`## Primary Request\n- keep going ${'z'.repeat(20_000)}`)
      return assistantText('## Primary Request\n- keep going\n## Next Step\n- finish the job')
    }
    calls += 1
    if (options.overflowOnCall === calls) {
      return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'context size has been exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' } } }]
    }
    steps += 1
    return assistantText(`reply ${steps} ${'y'.repeat(320)}`, { inputTokens: steps * 130, outputTokens: 6 })
  }
}

/** Enough scripted answers that no test runs out of script mid-turn. */
function arm(test: Harness, options: { overflowOnCall?: number; failSummary?: boolean; bloatedSummary?: boolean } = {}): void {
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
    arm(test, { failSummary: true })
    await grow(agent, 6)

    const controller = new AbortController()
    controller.abort()
    const outcome = await test.root.get(COMPACTION).compactNow(agent, controller.signal)
    expect(outcome).toMatchObject({ kind: 'nothing-to-do', reason: 'cancelled' })
    const end = agent.session.events.filter((event) => event.type === 'compaction/end').at(-1)!
    expect(end.data).toMatchObject({ outcome: { kind: 'declined', reason: 'cancelled' } })
    expect(foldCompactionFailures(agent.session.facts, agent.session.liveStart)).toBe(0)
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
    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends).toHaveLength(8)
    expect(ends.every((event) => (event.data as { reason: { kind: string } }).reason.kind === 'completed')).toBe(true)
    // The steps after it carried the summary, not the shadowed history.
    expect(messageText(test.adapter.calls.at(-1)!.messages[0]!)).toContain('<system-reminder>')
    // It landed inside a turn but before the step it protected.
    const stepStarts = agent.session.events.filter((event) => event.type === 'step/start').map((event) => event.seq)
    expect(stepStarts.some((seq) => seq > applied[0]!.seq)).toBe(true)
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
    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends.every((event) => (event.data as { reason: { kind: string } }).reason.kind === 'completed')).toBe(true)
    // Two attempts of one step, and the retried one was smaller than the one
    // the provider refused.
    const attempts = agent.session.events.filter((event) => event.type === 'assistant/chunk').map((event) => (event.data as { attempt: number }).attempt)
    expect(attempts).toContain(2)
    const loopCalls = test.adapter.calls.filter((call) => call.purpose === undefined)
    expect(loopCalls[4]!.messages.length).toBeLessThan(loopCalls[3]!.messages.length)
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
    expect(attempts).toHaveLength(2)
    expect(attempts.every((event) => (event.data as AuxCallRecord).outcome.kind === 'error')).toBe(true)
    // Every turn still completed: a failing summariser must never fail the work.
    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends.every((event) => (event.data as { reason: { kind: string } }).reason.kind === 'completed')).toBe(true)
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
    expect(attempts).toHaveLength(2)
    expect(attempts.every((event) => (event.data as AuxCallRecord).outcome.kind === 'text')).toBe(true)

    // And the work itself never suffered for it.
    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends.every((event) => (event.data as { reason: { kind: string } }).reason.kind === 'completed')).toBe(true)
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
