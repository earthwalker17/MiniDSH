/**
 * The shipped compaction provider: threshold, summary, and the three triggers.
 *
 * DSH's `compaction-basic` is the reference — a ratio of the context window, a
 * retained tail, and a summarisation request that replays the shadowed
 * conversation VERBATIM under the same system prompt and tool schemas, so the
 * provider's warm prefix cache pays for most of it.
 *
 * Three ways in, one implementation:
 *   pressure         `agent/pre-step`, before the step's request is built
 *   context-overflow `agent/request-error`, then retry the attempt
 *   explicit         `COMPACTION.compactNow`, from `/compact` over the protocol
 *
 * The dangerous part is not the mutation, it is the AWAIT before it. The
 * summary call takes seconds, and a session can start a turn in that window; a
 * replace landing mid-step would leave the log claiming the model answered a
 * history it never saw. So the plan is re-validated against the live surface
 * and the agent's status in a window with no `await` in it — nothing else can
 * run between the check and the append.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import {
  AGENT_PRE_STEP,
  AGENT_REQUEST_ERROR,
  AGENT_TURN_STOPPING,
  AGENTS,
  resolveCallConfig,
  type Agent,
  type CallConfig,
  type RequestErrorAction,
} from '../../core/agent/index.ts'
import {
  COMPACTION,
  COMPACTION_APPLIED,
  COMPACTION_END,
  COMPACTION_START,
  foldCompactionFailures,
  planCompaction,
  planIsLive,
  type Compaction,
  type CompactionDeclineReason,
  type CompactionOutcome,
  type CompactionPlan,
  type CompactionTrigger,
} from '../../core/compaction/index.ts'
import { AuxCallError, LLM, runAuxCall, type Llm } from '../../core/llm/index.ts'
import { createPluginMessage } from '../../core/llm/message.ts'
import type { LlmRequest, Message } from '../../core/llm/types.ts'
import { estimateMessage, meterSession } from '../../core/metering/index.ts'
import { PROMPT, type AssembledPrompt } from '../../core/prompt/index.ts'
import { deriveEventMessage, foldRequestContext, USER_MESSAGE } from '../../core/session/index.ts'

export interface CompactionBasicConfig {
  /** Compact when the projected request reaches this fraction of the budget. */
  readonly thresholdRatio?: number | undefined
  /** Fraction of the budget kept as recent history. */
  readonly retainRatio?: number | undefined
  /**
   * An absolute context budget, overriding the window the log names for the
   * route (`request/context`). A deployment knob: spend, latency, or a model
   * whose advertised window is far larger than the history it is worth
   * carrying.
   */
  readonly budgetTokens?: number | undefined
  /** Generation cap for the summary itself. */
  readonly maxTokens?: number | undefined
  /** Automatic pressure and overflow triggers; `/compact` works either way. */
  readonly auto?: boolean | undefined
  /** How many times one step may answer a provider overflow by compacting. */
  readonly maxOverflowRetries?: number | undefined
  /**
   * Consecutive summaries that produced no compaction before the AUTOMATIC
   * triggers give up on a session — a call that failed, and equally one whose
   * summary came back at least as large as the span it would have replaced.
   * Each attempt replays a whole shadowed span, so a summariser that keeps
   * producing nothing usable is an expensive request at every step boundary,
   * forever. A summary lost to a race (a turn started, the agent went away)
   * neither counts nor clears: the call worked, and nothing was learned about
   * the summariser.
   * `/compact` is a human asking again and is never disabled.
   */
  readonly maxSummaryFailures?: number | undefined
}

const configSchema = z
  .strictObject({
    thresholdRatio: z.number().positive().max(1).optional(),
    retainRatio: z.number().nonnegative().max(1).optional(),
    budgetTokens: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    auto: z.boolean().optional(),
    maxOverflowRetries: z.number().int().nonnegative().optional(),
    maxSummaryFailures: z.number().int().nonnegative().optional(),
  })
  .optional()

const PLUGIN = 'compaction-basic'
const PURPOSE = 'compaction'

/** What one summary attempt produced. Every arm maps to exactly one decline reason. */
type SummaryResult = { kind: 'text'; text: string; seq: number } | { kind: 'empty' } | { kind: 'failed' } | { kind: 'cancelled' } | { kind: 'no-messages' }

/**
 * DSH's brief, which is well-shaped for resuming work: what was asked, what
 * matters, what changed, what broke, what is left.
 */
const INSTRUCTION = `The conversation above is being summarised so that work can continue within the context window.

Write a summary in Markdown with exactly these sections, using terse bullets. Include specific file paths, identifiers, commands, and error text — a reader will have ONLY this summary and the most recent messages.

## Primary Request
## Key Concepts
## Files and Code
## Errors and Fixes
## Pending Work
## Current Work
## Next Step
## Critical Context

If an earlier summary appears above, merge its content rather than copying it verbatim. Reply with the summary only.`

function frame(summary: string): string {
  return `<system-reminder>
The earlier part of this conversation was replaced by the summary below to stay within the context window. The full history remains in the session log; only what you can see has changed. Continue the work from here.
</system-reminder>

${summary}`
}

class BasicCompaction implements Compaction {
  private readonly ctx: Context
  private readonly config: {
    readonly thresholdRatio: number
    readonly retainRatio: number
    readonly maxTokens: number
    readonly auto: boolean
    readonly maxOverflowRetries: number
    readonly maxSummaryFailures: number
    readonly budgetTokens?: number
  }
  /** One compaction per agent at a time: pressure and `/compact` must not interleave. */
  private readonly running = new WeakSet<Agent>()
  /** Set by `/compact` on a busy agent; consumed by the next pre-step. */
  private readonly requested = new WeakSet<Agent>()
  private readonly overflows = new WeakMap<Agent, { key: string; count: number }>()

  constructor(ctx: Context, config: CompactionBasicConfig | undefined) {
    this.ctx = ctx
    this.config = {
      thresholdRatio: config?.thresholdRatio ?? 0.8,
      retainRatio: config?.retainRatio ?? 0.16,
      maxTokens: config?.maxTokens ?? 8192,
      auto: config?.auto ?? true,
      maxOverflowRetries: config?.maxOverflowRetries ?? 1,
      maxSummaryFailures: config?.maxSummaryFailures ?? 2,
      ...(config?.budgetTokens === undefined ? {} : { budgetTokens: config.budgetTokens }),
    }
  }

  async compactNow(agent: Agent, signal?: AbortSignal): Promise<CompactionOutcome> {
    // A running agent may already have a request in flight, and no re-check
    // after the summary await could make that safe. Defer to the next step
    // boundary, where the driver is holding still by construction.
    if (agent.status !== 'idle') {
      this.requested.add(agent)
      return { kind: 'scheduled' }
    }
    return this.run(agent, 'explicit', signal)
  }

  /** The budget every path measures against. */
  budgetFor(agent: Agent): number {
    if (this.config.budgetTokens !== undefined) return this.config.budgetTokens
    // The window the log names for the route the next step will use — a
    // durable fact every reader shares, written before this listener runs. A
    // log from before the record existed falls back to the live adapter.
    const logged = foldRequestContext(agent.session.facts)?.contextWindow
    if (logged !== undefined) return logged
    return this.windowOf(agent.options.provider, agent.options.model)
  }

  private windowOf(provider: string, model: string): number {
    const llm = this.ctx.tryGet(LLM)
    if (!llm) return 0
    try {
      return llm.resolveModel(provider, model).contextWindow
    } catch {
      return 0
    }
  }

  /**
   * The budget a PLAN must fit: the smaller of what the conversation is
   * measured against and what the summariser can actually read. A role may
   * point `compaction` at a cheaper model with a much smaller window, and a
   * span planned against the loop's window would overflow that model on every
   * attempt — buying nothing and eventually disabling the automatic triggers.
   */
  private planBudget(route: { provider: string; model: string }, budget: number): number {
    const summariser = this.windowOf(route.provider, route.model)
    return summariser > 0 ? Math.min(budget, summariser) : budget
  }

  underPressure(agent: Agent): boolean {
    const budget = this.budgetFor(agent)
    if (budget <= 0) return false
    return meterSession(agent.session.facts, budget).ratio >= this.config.thresholdRatio
  }

  wasRequested(agent: Agent): boolean {
    return this.requested.has(agent)
  }

  /**
   * Automatic triggers run only while this session's summariser is still
   * working. The count is a FOLD over the log rather than a counter in memory,
   * so it is explainable after the fact — and bounded to this lifecycle, so a
   * resume gets a fresh two attempts instead of inheriting a latch only an
   * applied compaction could clear.
   */
  autoUsable(agent: Agent): boolean {
    return this.config.auto && foldCompactionFailures(agent.session.facts, agent.session.liveStart) < this.config.maxSummaryFailures
  }

  /** Bookkeeping so one step cannot answer overflow with compaction forever. */
  overflowAllowed(agent: Agent, turn: number, step: number): boolean {
    const key = `${turn}:${step}`
    const state = this.overflows.get(agent)
    return (state && state.key === key ? state.count : 0) < this.config.maxOverflowRetries
  }

  /**
   * Spent on the RECOVERY, not the attempt. A summary call that itself failed
   * bought nothing, and burning the one allowed retry for it would leave the
   * step to die on the overflow it could have recovered from.
   */
  overflowSpent(agent: Agent, turn: number, step: number): void {
    const key = `${turn}:${step}`
    const state = this.overflows.get(agent)
    this.overflows.set(agent, { key, count: (state && state.key === key ? state.count : 0) + 1 })
  }

  async run(agent: Agent, trigger: CompactionTrigger, signal?: AbortSignal): Promise<CompactionOutcome> {
    if (this.running.has(agent)) return { kind: 'nothing-to-do' }
    this.running.add(agent)
    // Cleared BEFORE the attempt, so `compact` can re-arm it when the exit race
    // discards an otherwise-good compaction.
    this.requested.delete(agent)
    try {
      return await this.compact(agent, trigger, signal)
    } finally {
      this.running.delete(agent)
    }
  }

  private async compact(agent: Agent, trigger: CompactionTrigger, signal?: AbortSignal): Promise<CompactionOutcome> {
    const llm = this.ctx.tryGet(LLM)
    const prompt = this.ctx.tryGet(PROMPT)
    if (!llm || !prompt) return { kind: 'nothing-to-do' }

    const session = agent.session
    const budget = this.budgetFor(agent)
    if (budget <= 0) return { kind: 'nothing-to-do' }
    const projected = meterSession(session.facts, budget).projectedTokens
    // The summary's route decides what the plan may hold, so it is resolved
    // BEFORE the plan and passed to the call that uses it.
    const route = await resolveCallConfig(agent, { purpose: PURPOSE, ...(signal ? { signal } : {}) })
    // Assembled before the bracket opens, because it can throw — an unknown
    // prompt variable, two `complete` sections, a throwing `system-prompt/assemble`
    // listener — and a throw past `compaction/start` would escape `compact()`
    // with no end appended, leaving an orphan that the log's own vocabulary
    // defines as a crash, a disposal or a fork boundary on a session that is
    // healthy and live. It depends on neither the plan nor the route.
    const assembled = await prompt.assemble(agent)
    const plan = planCompaction(session.facts, session.surfaceSeqs(), {
      budgetTokens: this.planBudget(route, budget),
      retainRatio: this.config.retainRatio,
    })
    if (!plan) return { kind: 'nothing-to-do' }

    // The bracket opens once there IS an attempt: after the plan, before the
    // paid call. Opening it earlier would append a record at every step boundary
    // of a session under pressure with nothing worth compacting, and "no plan"
    // is not an attempt.
    const startSeq = session.append(COMPACTION_START, {
      trigger,
      budgetTokens: budget,
      projectedTokens: projected,
      plannedStart: plan.start,
      plannedEnd: plan.end,
      plannedNodes: plan.shadowedSeqs.length,
    }).seq
    const decline = (reason: CompactionDeclineReason): CompactionOutcome => {
      session.append(COMPACTION_END, { startSeq, outcome: { kind: 'declined', reason } })
      return { kind: 'nothing-to-do', reason }
    }

    const statusBefore = agent.status
    const summary = await this.summarise(llm, assembled, agent, plan, route, signal)

    // ---- no `await` past this line, or the checks mean nothing -------------
    // The registry check comes FIRST — before even the summary’s own outcome —
    // because it is the only one that says whether an append is LEGAL at all;
    // every other branch here merely chooses which decline reason to record. An
    // agent disposed during the summary is normally disposed by being cancelled,
    // which aborts the aux call and returns `cancelled`, so ordering this behind
    // the summary check would append into a session whose descriptor is already
    // closed on exactly the commonest path.
    if (this.ctx.tryGet(AGENTS)?.get(agent.id) !== agent) return { kind: 'nothing-to-do', reason: 'agent-gone' }
    if (summary.kind !== 'text') return decline(summary.kind === 'no-messages' ? 'plan-stale' : summary.kind === 'empty' ? 'summary-empty' : summary.kind === 'cancelled' ? 'cancelled' : 'summary-failed')
    if (agent.status !== statusBefore) {
      // The EXIT race: a turn started during the summary, so this replace can no
      // longer land safely. The work is paid for either way — remember the
      // request so the next step boundary honours it instead of dropping it.
      this.requested.add(agent)
      return decline('turn-started')
    }
    if (signal?.aborted) return decline('cancelled')
    const live = session.surfaceSeqs()
    if (!planIsLive(plan, live)) return decline('plan-stale')

    const message = createPluginMessage(PLUGIN, frame(summary.text), 'summary')
    // Both surface numbers are ESTIMATOR units and include the summary node the
    // replace is about to insert. They are measured from the LIVE surface here,
    // not from the plan: on the explicit path an idle agent may have completed a
    // whole turn during the summary await, and the plan still being live only
    // says its shadowed head is intact, not that the tail did not grow. The
    // projection stays separate: it is what the threshold compared, it is
    // usually provider-priced, and subtracting an estimate from it would not be
    // a quantity — nor would it be a saving, since the summary itself is not free.
    const cost = (seq: number): number => {
      const node = session.events[seq]
      const derived = node ? deriveEventMessage(node) : null
      return derived ? estimateMessage(derived) : 0
    }
    const surfaceTokensBefore = live.reduce((sum, seq) => sum + cost(seq), 0)
    const shadowedTokens = plan.shadowedSeqs.reduce((sum, seq) => sum + cost(seq), 0)
    const surfaceTokensAfter = surfaceTokensBefore - shadowedTokens + estimateMessage(message)
    // A summary at least as large as everything it replaces is not a compaction.
    // Applying it would pay for a call, hide real history behind a replace, and
    // leave the surface BIGGER than it found it — there is no reading under
    // which that helps, and the two numbers that say so are already in hand
    // here. It happens when the plan's head is small (a surface only just over
    // budget) and the model answers a short span at length; a live run measured
    // 4,545 against 4,314. Counted with the summary failures because it is one:
    // the call succeeded and produced nothing usable, and without the count an
    // automatic trigger would buy the same useless summary at every step
    // boundary for the rest of the session.
    if (surfaceTokensAfter >= surfaceTokensBefore) return decline('summary-not-smaller')
    session.append(COMPACTION_APPLIED, {
      trigger,
      budgetTokens: budget,
      projectedTokens: projected,
      surfaceTokensBefore,
      surfaceTokensAfter,
      shadowedSeqs: [...plan.shadowedSeqs],
      retainedNodes: live.length - plan.shadowedSeqs.length,
      auxCallSeq: summary.seq,
      startSeq,
    })
    session.append(USER_MESSAGE, { message }, { surfaceOp: { op: 'replace', start: plan.start, end: plan.end }, sourceEventSeqs: [...plan.shadowedSeqs] })
    session.append(COMPACTION_END, { startSeq, outcome: { kind: 'applied' } })
    return { kind: 'compacted', shadowedNodes: plan.shadowedSeqs.length, surfaceTokensBefore, surfaceTokensAfter }
  }

  /**
   * The shadowed conversation replayed verbatim under the CURRENT system
   * prompt and tool schemas, then the instruction. That prefix is byte-identical
   * to the prefix of the requests the loop has been sending, so the provider
   * serves most of it from cache.
   */
  private async summarise(
    llm: Llm,
    assembled: AssembledPrompt,
    agent: Agent,
    plan: CompactionPlan,
    route: CallConfig,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const session = agent.session
    const messages: Message[] = []
    for (const seq of plan.shadowedSeqs) {
      // Indexed, never scanned: a seq in hand is an O(1) read of the log.
      const node = session.events[seq]
      const message = node ? deriveEventMessage(node) : null
      if (message) messages.push(message)
    }
    if (messages.length === 0) return { kind: 'no-messages' }
    messages.push(createPluginMessage(PLUGIN, INSTRUCTION, 'compaction-instruction'))

    // The route was resolved by the caller — the same resolution a loop step
    // takes, with a purpose instead of a position — because the plan had to
    // fit the model that would read it. The record `runAuxCall` writes names
    // whatever route was used.
    const request: LlmRequest & { purpose: string } = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      system: assembled.system,
      messages,
      tools: assembled.tools,
      maxTokens: this.config.maxTokens,
      purpose: PURPOSE,
      ...(signal ? { signal } : {}),
      sessionId: session.id,
    }
    try {
      const result = await runAuxCall(llm, session, request, plan.shadowedSeqs)
      // An empty answer (the model called a tool instead of writing prose)
      // is not a summary. The failed call stays in the log; the surface does not move.
      return result.text.trim().length === 0 ? { kind: 'empty' } : { kind: 'text', text: result.text, seq: result.seq }
    } catch (error) {
      // `runAuxCall` already recorded why. A compaction that cannot summarise
      // must leave history alone rather than drop it — but it must say WHICH
      // thing happened, because the give-up counter treats a summariser failure
      // and a cancellation completely differently. Collapsing them (as returning
      // `undefined` for both did) would let two interrupted compactions disable
      // the automatic triggers with no summary having failed at all.
      const cancelled = signal?.aborted === true || (error instanceof AuxCallError && error.failure.code === 'ABORTED')
      return { kind: cancelled ? 'cancelled' : 'failed' }
    }
  }
}

/** Provides `ctx.compaction` and mounts the automatic triggers. */
export const compactionBasicPlugin: Plugin<CompactionBasicConfig | undefined> = {
  name: 'compaction-basic',
  inject: [LLM, PROMPT],
  config: configSchema,
  apply(ctx, config) {
    const engine = new BasicCompaction(ctx, config)
    ctx.provide(COMPACTION, engine)

    /**
     * Pressure. `agent/pre-step` is a decision waterfall, and this listener
     * makes no decision — it passes the batch through untouched and mutates
     * the surface as a side effect. That is deliberate: it is the only hook
     * that runs inside an open turn with no step open and no request built,
     * which is exactly the window a surface rewrite needs.
     */
    ctx.on(
      AGENT_PRE_STEP,
      async (context, next) => {
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        const explicit = engine.wasRequested(context.agent)
        const wanted = explicit || (engine.autoUsable(context.agent) && engine.underPressure(context.agent))
        if (wanted) await engine.run(context.agent, explicit ? 'explicit' : 'pressure', context.signal)
        return decision
      },
      { global: true },
    )

    /**
     * A `/compact` that arrived during the LAST step of a turn has no later
     * step boundary to run at, and the terminal has already told the user it
     * would. Honour it here, while the turn is still open.
     */
    ctx.on(
      AGENT_TURN_STOPPING,
      async (context) => {
        if (engine.wasRequested(context.agent)) await engine.run(context.agent, 'explicit', context.signal)
      },
      { global: true },
    )

    /** Overflow: the provider says the request was too big, so make it smaller and try again. */
    ctx.on(
      AGENT_REQUEST_ERROR,
      async (context, next): Promise<RequestErrorAction> => {
        const prior = await next()
        if (prior || !engine.autoUsable(context.agent)) return prior
        if (context.failure.code !== 'CONTEXT_WINDOW_EXCEEDED') return prior
        if (!engine.overflowAllowed(context.agent, context.turn, context.step)) return prior
        const outcome = await engine.run(context.agent, 'context-overflow', context.signal)
        if (outcome.kind !== 'compacted') return prior
        engine.overflowSpent(context.agent, context.turn, context.step)
        return { kind: 'retry' }
      },
      { global: true },
    )
  },
}
