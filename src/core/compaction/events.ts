/**
 * The compaction VOCABULARY: the bracket, the checkpoint record, the decline
 * reasons, and the two folds over them.
 *
 * Split from the service exactly as `approval/events.ts` and
 * `agent/events.ts` are, and for the same reason: crash repair must be able
 * to close an unpaired bracket without importing the seam that opens one —
 * which would import the session, the meter and the surface back.
 */
import { eventKind, matches, type EventEnvelope } from '../session/types.ts'

export type CompactionTrigger = 'pressure' | 'context-overflow' | 'explicit'

/**
 * Why an attempt produced no compaction. A closed union, because the point of
 * recording it is that a reader can tell the cases apart — and because most
 * of them must never be counted against the summariser.
 *
 * The first three are the summariser's own fault and are what the give-up
 * counter counts. The next four are races and shutdowns: the call worked, or
 * never happened, and nothing was learned about whether this session can be
 * summarised, so they neither count nor clear. `unclosed` is the last, and
 * the only one no live path can write.
 */
export type CompactionDeclineReason =
  | 'summary-failed'
  | 'summary-empty'
  | 'summary-not-smaller'
  | 'turn-started'
  | 'plan-stale'
  | 'agent-gone'
  | 'cancelled'
  /**
   * Written by crash repair, never by an attempt: the bracket recorded no
   * end, and the writer that opened it is gone. It states what the log knows
   * and no more. It is deliberately NOT called "interrupted": the commonest
   * way to reach it is not a crash at all but an ordinary disposal, where
   * `compaction-basic` reaches its `agent-gone` exit with the session already
   * detached and no append left legal.
   */
  | 'unclosed'

/** The decline reasons that say something about the SUMMARISER, and therefore count. */
export const COUNTING_DECLINE_REASONS: ReadonlySet<CompactionDeclineReason> = new Set<CompactionDeclineReason>([
  'summary-failed',
  'summary-empty',
  'summary-not-smaller',
])

export type CompactionEndOutcome = { readonly kind: 'applied' } | { readonly kind: 'declined'; readonly reason: CompactionDeclineReason }

/**
 * Opened once the plan exists and BEFORE the summary call, so an attempt that
 * was paid for is durable even when it produced nothing.
 *
 * It deliberately does not open earlier. A session under pressure with nothing
 * worth compacting would otherwise append a record at every step boundary
 * forever, and "no plan" is not an attempt.
 */
export const COMPACTION_START = eventKind<{
  readonly trigger: CompactionTrigger
  readonly budgetTokens: number
  /** What the meter projected, and therefore what the threshold compared against. */
  readonly projectedTokens: number
  /** The span the plan proposed to shadow, before anything was bought. */
  readonly plannedStart: number
  readonly plannedEnd: number
  readonly plannedNodes: number
}>('compaction/start')

/**
 * Closes the bracket. `startSeq` is the correlation key: seqs are already
 * unique and monotonic here, so there is nothing to mint, and it is what makes
 * "this checkpoint came from that attempt" checkable from the log alone.
 *
 * An unpaired start means the attempt did not close, and since S14 that is a
 * state only a LIVE log can be in: crash repair closes it `unclosed` at the
 * next resume or cold fork (`core/agent/repair.ts`). The pairing rule still
 * reads one way only — an end requires a start, never the reverse.
 */
export const COMPACTION_END = eventKind<{ readonly startSeq: number; readonly outcome: CompactionEndOutcome }>('compaction/end')

/**
 * Log-only, like the authority events: durable and replayable, never part of
 * the model transcript. The surface `user/message` that follows is the actual
 * mutation; this record says WHY it happened and what it cost.
 *
 * `shadowedSeqs` is an ordinary data field, not the envelope's
 * `sourceEventSeqs` — that one is reserved for surface events and is rejected
 * on a log-only record.
 */
export const COMPACTION_APPLIED = eventKind<{
  readonly trigger: CompactionTrigger
  readonly budgetTokens: number
  /**
   * What the meter projected for the next request, and therefore what the
   * threshold compared against. Provider-priced when the meter had usage to
   * price it with — so it is NOT comparable with the two surface numbers below,
   * which are estimator units. Three fields rather than a before/after pair
   * because a subtraction across those two units is not a quantity.
   */
  readonly projectedTokens: number
  /** Estimated size of the whole surface before the replace. */
  readonly surfaceTokensBefore: number
  /** Estimated size of the surface after it: what was retained, plus the summary. */
  readonly surfaceTokensAfter: number
  readonly shadowedSeqs: readonly number[]
  readonly retainedNodes: number
  /** The `llm/aux-call` record that produced the summary. */
  readonly auxCallSeq: number
  /** The `compaction/start` this checkpoint belongs to. */
  readonly startSeq: number
}>('compaction/applied')

/**
 * Consecutive summariser failures in THIS lifecycle: a fold, not a counter.
 *
 * It walks back to the first applied compaction, or to `liveStart`, whichever
 * is later. Both bounds are load-bearing. Stopping at `applied` is what makes a
 * success clear the count. Stopping at `liveStart` is what keeps a two-strike
 * counter from becoming an unrecoverable latch: only an applied compaction
 * clears it, and the automatic triggers that could produce one are exactly what
 * a give-up disabled — so a whole-log fold would disable automatic compaction
 * for the rest of a session's life and every fork of it would be born disabled.
 * A resume is a deliberate act and gets a fresh two attempts, exactly as the
 * in-memory counter it replaces always gave it.
 *
 * What IS new is that the attempts are durable: which trigger fired, against
 * what budget, and why each produced nothing.
 *
 * A synthetic `unclosed` end cannot move this in either direction: it is not a
 * counting reason, it is not `applied`, and repair seeds it BELOW `liveStart`,
 * so a resumed session's fold stops before ever reaching it.
 */
export function foldCompactionFailures(events: readonly EventEnvelope[], liveStart = 0): number {
  let failures = 0
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.seq < liveStart) break
    if (!matches(event, COMPACTION_END)) continue
    if (event.data.outcome.kind === 'applied') break
    if (COUNTING_DECLINE_REASONS.has(event.data.outcome.reason)) failures++
  }
  return failures
}

/**
 * One `compaction/end{unclosed}` per `compaction/start` the log never paired.
 *
 * NOT scoped to the tail turn, unlike the surface closers it runs beside: an
 * explicit `/compact` opens its bracket with the agent idle and no turn open
 * at all, which is why an orphan there used to be unreachable. A bracket may
 * also legitimately outlive the turn it opened in.
 *
 * Pure: the caller supplies the next seq and the one timestamp every closer
 * shares, so a cold read and a durable repair produce identical bytes.
 */
export function closeUnpairedCompactions(events: readonly EventEnvelope[], nextSeq: number, time: number): EventEnvelope[] {
  const open = new Set<number>()
  for (const event of events) {
    if (matches(event, COMPACTION_START)) open.add(event.seq)
    else if (matches(event, COMPACTION_END)) open.delete(event.data.startSeq)
  }
  let seq = nextSeq
  return [...open].map((startSeq) => ({
    type: COMPACTION_END.type,
    seq: seq++,
    time,
    data: { startSeq, outcome: { kind: 'declined' as const, reason: 'unclosed' as const } },
  }))
}
