/**
 * Context compaction: the seam that makes model history smaller without making
 * the log less truthful.
 *
 * The whole mechanism is one `surfaceOp: replace` — a summary node takes the
 * place of a contiguous run of surface nodes. Nothing is rewritten and nothing
 * is deleted: the shadowed events stay in the log, the replace event names
 * every one of them in `sourceEventSeqs`, and a reader can still reconstruct
 * exactly what the model saw before and after.
 *
 * This module is the Definition and the PURE planner. It ships no policy and
 * no model call — a provider (`capabilities/compaction-basic`) owns the
 * threshold, the summary, and the trigger. The service key exists because the
 * protocol capability must reach compaction and a capability may not import
 * another capability; the pressure path needs no key, because its only caller
 * is the provider's own listener.
 */
import { serviceKey } from '../../kernel/index.ts'
import type { Agent } from '../agent/types.ts'
import { estimateMessage } from '../metering/index.ts'
import { deriveEventMessage } from '../session/surface.ts'
import { matches, TOOL_RESULT, type EventEnvelope } from '../session/types.ts'
import type { CompactionDeclineReason } from './events.ts'

// The vocabulary sits below this service (`events.ts`), so crash repair can
// close an unpaired bracket without importing the seam that opens one.
export * from './events.ts'

export type CompactionOutcome =
  | { readonly kind: 'compacted'; readonly shadowedNodes: number; readonly surfaceTokensBefore: number; readonly surfaceTokensAfter: number }
  /** The agent is mid-turn: compaction will run at its next step boundary. */
  | { readonly kind: 'scheduled' }
  /**
   * Nothing worth summarising, or the attempt produced nothing usable. `reason`
   * is present whenever an attempt was actually made, which is what finally lets
   * `/compact` say WHICH of "declined as too large", "lost its race" and "plan
   * no longer live" happened — on the idle path, where the caller is still
   * holding the result. On the deferred path the reason is durable in
   * `compaction/end` and a client learns it by watching the log.
   */
  | { readonly kind: 'nothing-to-do'; readonly reason?: CompactionDeclineReason }

export interface Compaction {
  /**
   * Compacts one useful span now, ignoring the automatic threshold. This is
   * the human command — compaction is deliberately not a model-facing tool.
   */
  compactNow(agent: Agent, signal?: AbortSignal): Promise<CompactionOutcome>
}

export const COMPACTION = serviceKey<Compaction>('compaction')

export interface CompactionPlan {
  /** Seq of the first shadowed surface node. */
  readonly start: number
  /** Seq of the last shadowed surface node. */
  readonly end: number
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokens: number
  /** Estimated size of the whole live surface, in the meter's units. */
  readonly surfaceTokens: number
  readonly retainedNodes: number
}

export interface PlanOptions {
  readonly budgetTokens: number
  /** Fraction to keep as recent history. */
  readonly retainRatio: number
  /** Never plan a compaction that would shadow fewer than this many nodes. */
  readonly minShadowedNodes?: number
}

/**
 * Chooses the run of surface nodes to summarise: the oldest history, keeping a
 * recent tail, and never separating an assistant's tool calls from their
 * results.
 *
 * Pure, and measured in the estimator's units rather than the provider's, so
 * the same log always yields the same plan — which is what lets a recorded
 * compaction reproduce under keyless replay.
 */
export function planCompaction(events: readonly EventEnvelope[], surfaceSeqs: readonly number[], options: PlanOptions): CompactionPlan | undefined {
  const minShadowed = options.minShadowedNodes ?? 2
  if (surfaceSeqs.length <= minShadowed) return undefined

  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const costs = surfaceSeqs.map((seq) => {
    const node = bySeq.get(seq)
    const message = node ? deriveEventMessage(node) : null
    return message ? estimateMessage(message) : 0
  })

  /**
   * The retained tail is a fraction of what is ACTUALLY there, capped by a
   * fraction of the budget — not of the budget alone. A budget far above the
   * live surface (a large window, or an overflow the provider reported before
   * the meter saw it coming) would otherwise make the tail bigger than the
   * whole conversation, and compaction would decline exactly when it was
   * asked to make progress.
   */
  const total = costs.reduce((sum, cost) => sum + cost, 0)
  const retainBudget = Math.max(0, Math.min(options.budgetTokens, total) * options.retainRatio)
  let cut = surfaceSeqs.length
  let retained = 0
  while (cut > 0) {
    const next = retained + costs[cut - 1]!
    if (next > retainBudget && cut < surfaceSeqs.length) break
    retained = next
    cut -= 1
  }

  /**
   * The pairing rule: the retained tail must never BEGIN with a `tool/result`,
   * whose `tool/call` would then sit in an assistant message about to be
   * shadowed. Once the head is not a tool result, every result belonging to the
   * last shadowed assistant message is already inside the shadowed run, because
   * results always follow their call.
   *
   * Two directions, and both are needed. Moving the cut FORWARD shadows the
   * offending results and frees more, so it is tried first — but a turn made of
   * tool steps ends `…assistant(tool-calls), tool/result`, and walking forward
   * from inside that run reaches the end of the surface, which used to decline
   * the compaction outright. That is the shape `agent/pre-step` sees at every
   * step boundary of a tool-heavy turn, so declining there meant automatic
   * compaction silently doing nothing exactly when it was most needed. When
   * forward runs out, move BACKWARD instead: the tail then starts at the
   * assistant message that owns those results, and both are retained.
   */
  let forward = cut
  while (forward < surfaceSeqs.length && isToolResult(bySeq.get(surfaceSeqs[forward]!))) forward += 1
  if (forward < surfaceSeqs.length) cut = forward
  else while (cut > 0 && isToolResult(bySeq.get(surfaceSeqs[cut]!))) cut -= 1

  if (cut < minShadowed) return undefined
  // Always leave the model something after the summary.
  if (cut >= surfaceSeqs.length) return undefined

  const shadowedSeqs = surfaceSeqs.slice(0, cut)
  return {
    start: shadowedSeqs[0]!,
    end: shadowedSeqs[shadowedSeqs.length - 1]!,
    shadowedSeqs,
    shadowedTokens: costs.slice(0, cut).reduce((sum, cost) => sum + cost, 0),
    surfaceTokens: total,
    retainedNodes: surfaceSeqs.length - cut,
  }
}

function isToolResult(event: EventEnvelope | undefined): boolean {
  return event !== undefined && matches(event, TOOL_RESULT)
}

/** True while every planned node is still a live surface node, in the same contiguous order. */
export function planIsLive(plan: CompactionPlan, surfaceSeqs: readonly number[]): boolean {
  const start = surfaceSeqs.indexOf(plan.start)
  if (start < 0) return false
  if (start + plan.shadowedSeqs.length > surfaceSeqs.length) return false
  return plan.shadowedSeqs.every((seq, index) => surfaceSeqs[start + index] === seq)
}
