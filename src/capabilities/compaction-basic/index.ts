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
import type { Context, Plugin } from '../../kernel/index.ts'
import {
  AGENT_PRE_STEP,
  AGENT_REQUEST_ERROR,
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
import { meterSession } from '../../core/metering/index.ts'
import { PROMPT, type Prompt } from '../../core/prompt/index.ts'
import { deriveEventMessage, USER_MESSAGE } from '../../core/session/index.ts'

export interface CompactionBasicConfig {
  /** Compact when the projected request reaches this fraction of the budget. */
  readonly thresholdRatio?: number
  /** Fraction of the budget kept as recent history. */
  readonly retainRatio?: number
  /**
   * An absolute context budget, overriding the model's advertised window.
   * A deployment knob (spend, latency) AND the only way to exercise
   * compaction deterministically: an adapter's window is a live fact the log
   * does not carry, so a replay cannot depend on two adapters agreeing.
   */
  readonly budgetTokens?: number
  /** Generation cap for the summary itself. */
  readonly maxTokens?: number
  /** Automatic pressure and overflow triggers; `/compact` works either way. */
  readonly auto?: boolean
  /** How many times one step may answer a provider overflow by compacting. */
  readonly maxOverflowRetries?: number
}

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
  private readonly config: Required<Pick<CompactionBasicConfig, 'thresholdRatio' | 'retainRatio' | 'maxTokens' | 'auto' | 'maxOverflowRetries'>> & {
    budgetTokens?: number
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
    return meterSession(agent.session.events, budget).ratio >= this.config.thresholdRatio
  }

  wasRequested(agent: Agent): boolean {
    return this.requested.has(agent)
  }

  auto(): boolean {
    return this.config.auto
  }

  /** Bookkeeping so one step cannot answer overflow with compaction forever. */
  overflowAllowed(agent: Agent, turn: number, step: number): boolean {
    const key = `${turn}:${step}`
    const state = this.overflows.get(agent)
    const count = state && state.key === key ? state.count : 0
    if (count >= this.config.maxOverflowRetries) return false
    this.overflows.set(agent, { key, count: count + 1 })
    return true
  }

  async run(agent: Agent, trigger: CompactionTrigger, signal?: AbortSignal): Promise<CompactionOutcome> {
    if (this.running.has(agent)) return { kind: 'nothing-to-do' }
    this.running.add(agent)
    try {
      return await this.compact(agent, trigger, signal)
    } finally {
      this.running.delete(agent)
      this.requested.delete(agent)
    }
  }

  private async compact(agent: Agent, trigger: CompactionTrigger, signal?: AbortSignal): Promise<CompactionOutcome> {
    const llm = this.ctx.tryGet(LLM)
    const prompt = this.ctx.tryGet(PROMPT)
    if (!llm || !prompt) return { kind: 'nothing-to-do' }

    const session = agent.session
    const budget = this.budgetFor(agent)
    if (budget <= 0) return { kind: 'nothing-to-do' }
    const before = meterSession(session.events, budget).projectedTokens
    const plan = planCompaction(session.events, session.surfaceSeqs(), { budgetTokens: budget, retainRatio: this.config.retainRatio })
    if (!plan) return { kind: 'nothing-to-do' }

    const statusBefore = agent.status
    const summary = await this.summarise(llm, prompt, agent, plan, signal)
    if (summary === undefined) return { kind: 'nothing-to-do' }

    // ---- no `await` past this line, or the checks mean nothing -------------
    if (agent.status !== statusBefore) return { kind: 'nothing-to-do' }
    if (signal?.aborted) return { kind: 'nothing-to-do' }
    const live = session.surfaceSeqs()
    if (!planIsLive(plan, live)) return { kind: 'nothing-to-do' }

    const message = createPluginMessage(PLUGIN, frame(summary.text), 'summary')
    session.append(COMPACTION_APPLIED, {
      trigger,
      budgetTokens: budget,
      beforeTokens: before,
      afterTokens: Math.max(0, before - plan.shadowedTokens),
      shadowedSeqs: [...plan.shadowedSeqs],
      retainedNodes: plan.retainedNodes,
      auxCallSeq: summary.seq,
    })
    session.append(USER_MESSAGE, { message }, { surfaceOp: { op: 'replace', start: plan.start, end: plan.end }, sourceEventSeqs: [...plan.shadowedSeqs] })
    return {
      kind: 'compacted',
      shadowedNodes: plan.shadowedSeqs.length,
      beforeTokens: before,
      afterTokens: Math.max(0, before - plan.shadowedTokens),
    }
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
    const bySeq = new Map(session.events.map((event) => [event.seq, event]))
    const messages: Message[] = []
    for (const seq of plan.shadowedSeqs) {
      const node = bySeq.get(seq)
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
        const wanted = engine.wasRequested(context.agent) || (engine.auto() && engine.underPressure(context.agent))
        if (wanted) await engine.run(context.agent, engine.wasRequested(context.agent) ? 'explicit' : 'pressure', context.signal)
        return decision
      },
      { global: true },
    )

    /** Overflow: the provider says the request was too big, so make it smaller and try again. */
    ctx.on(
      AGENT_REQUEST_ERROR,
      async (context, next): Promise<RequestErrorAction> => {
        const prior = await next()
        if (prior || !engine.auto()) return prior
        if (context.failure.code !== 'CONTEXT_WINDOW_EXCEEDED') return prior
        if (!engine.overflowAllowed(context.agent, context.turn, context.step)) return prior
        const outcome = await engine.run(context.agent, 'context-overflow', context.signal)
        return outcome.kind === 'compacted' ? { kind: 'retry' } : prior
      },
      { global: true },
    )
  },
}
