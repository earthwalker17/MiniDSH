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
  type Agent,
  type RequestErrorAction,
} from '../../core/agent/index.ts'
import {
  COMPACTION,
  COMPACTION_APPLIED,
  planCompaction,
  planIsLive,
  type Compaction,
  type CompactionOutcome,
  type CompactionPlan,
  type CompactionTrigger,
} from '../../core/compaction/index.ts'
import { LLM, runAuxCall, type Llm } from '../../core/llm/index.ts'
import { createPluginMessage } from '../../core/llm/message.ts'
import type { LlmRequest, Message } from '../../core/llm/types.ts'
import { estimateMessage, meterSession } from '../../core/metering/index.ts'
import { PROMPT, type Prompt } from '../../core/prompt/index.ts'
import { deriveEventMessage, USER_MESSAGE } from '../../core/session/index.ts'

export interface CompactionBasicConfig {
  /** Compact when the projected request reaches this fraction of the budget. */
  readonly thresholdRatio?: number | undefined
  /** Fraction of the budget kept as recent history. */
  readonly retainRatio?: number | undefined
  /**
   * An absolute context budget, overriding the model's advertised window.
   * A deployment knob (spend, latency) AND the only way to exercise
   * compaction deterministically: an adapter's window is a live fact the log
   * does not carry, so a replay cannot depend on two adapters agreeing.
   */
  readonly budgetTokens?: number | undefined
  /** Generation cap for the summary itself. */
  readonly maxTokens?: number | undefined
  /** Automatic pressure and overflow triggers; `/compact` works either way. */
  readonly auto?: boolean | undefined
  /** How many times one step may answer a provider overflow by compacting. */
  readonly maxOverflowRetries?: number | undefined
  /**
   * Consecutive failed summary calls before the AUTOMATIC triggers give up on a
   * session. Each attempt replays a whole shadowed span, so a persistently
   * failing summariser is an expensive request at every step boundary, forever.
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
  /** Consecutive summary failures per agent; reset by any success. */
  private readonly failures = new WeakMap<Agent, number>()

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
    const llm = this.ctx.tryGet(LLM)
    if (!llm) return 0
    try {
      return llm.resolveModel(agent.options.provider, agent.options.model).contextWindow
    } catch {
      return 0
    }
  }

  underPressure(agent: Agent): boolean {
    const budget = this.budgetFor(agent)
    if (budget <= 0) return false
    return meterSession(agent.session.facts, budget).ratio >= this.config.thresholdRatio
  }

  wasRequested(agent: Agent): boolean {
    return this.requested.has(agent)
  }

  /** Automatic triggers run only while this session's summariser is still working. */
  autoUsable(agent: Agent): boolean {
    return this.config.auto && (this.failures.get(agent) ?? 0) < this.config.maxSummaryFailures
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
    const plan = planCompaction(session.facts, session.surfaceSeqs(), { budgetTokens: budget, retainRatio: this.config.retainRatio })
    if (!plan) return { kind: 'nothing-to-do' }

    const statusBefore = agent.status
    const summary = await this.summarise(llm, prompt, agent, plan, signal)
    if (summary === undefined) {
      this.failures.set(agent, (this.failures.get(agent) ?? 0) + 1)
      return { kind: 'nothing-to-do' }
    }
    this.failures.delete(agent)

    // ---- no `await` past this line, or the checks mean nothing -------------
    if (agent.status !== statusBefore) {
      // The EXIT race: a turn started during the summary, so this replace can no
      // longer land safely. The work is paid for either way — remember the
      // request so the next step boundary honours it instead of dropping it.
      this.requested.add(agent)
      return { kind: 'nothing-to-do' }
    }
    if (signal?.aborted) return { kind: 'nothing-to-do' }
    // An agent disposed during the summary has already detached its session:
    // appending here would write three records — including the paid aux call —
    // into a log nothing is listening to any more.
    if (this.ctx.tryGet(AGENTS)?.get(agent.id) !== agent) return { kind: 'nothing-to-do' }
    const live = session.surfaceSeqs()
    if (!planIsLive(plan, live)) return { kind: 'nothing-to-do' }

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
    session.append(COMPACTION_APPLIED, {
      trigger,
      budgetTokens: budget,
      projectedTokens: projected,
      surfaceTokensBefore,
      surfaceTokensAfter,
      shadowedSeqs: [...plan.shadowedSeqs],
      retainedNodes: live.length - plan.shadowedSeqs.length,
      auxCallSeq: summary.seq,
    })
    session.append(USER_MESSAGE, { message }, { surfaceOp: { op: 'replace', start: plan.start, end: plan.end }, sourceEventSeqs: [...plan.shadowedSeqs] })
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
    prompt: Prompt,
    agent: Agent,
    plan: CompactionPlan,
    signal?: AbortSignal,
  ): Promise<{ text: string; seq: number } | undefined> {
    const session = agent.session
    const messages: Message[] = []
    for (const seq of plan.shadowedSeqs) {
      // Indexed, never scanned: a seq in hand is an O(1) read of the log.
      const node = session.events[seq]
      const message = node ? deriveEventMessage(node) : null
      if (message) messages.push(message)
    }
    if (messages.length === 0) return undefined
    messages.push(createPluginMessage(PLUGIN, INSTRUCTION, 'compaction-instruction'))

    const assembled = await prompt.assemble(agent)
    const request: LlmRequest & { purpose: string } = {
      provider: agent.options.provider,
      model: agent.options.model,
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
      return result.text.trim().length === 0 ? undefined : { text: result.text, seq: result.seq }
    } catch {
      // `runAuxCall` already recorded why. A compaction that cannot summarise
      // must leave history alone rather than drop it.
      return undefined
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
