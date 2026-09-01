/**
 * Message-aligned backward pagination over a session log.
 *
 * A long session is two orders of magnitude too large to hand a client in one
 * frame (a 400-turn session is ~103k events and ~17 MB of JSON), so an
 * attaching client gets a bounded tail page and walks backwards. The cut is
 * chosen so a page is never a misleading fragment:
 *
 * - Only the two MESSAGE kinds consume the budget, and only when they ARRIVED
 *   (`surfaceOp: 'append'`). A `tool/result` is a surface event but not a
 *   message: budgeting it would let one tool-heavy turn fill a page with
 *   results and no conversation. A replacement (`surfaceOp: 'replace'` — a
 *   compaction summary) is not an arrival either, so a compaction cannot make
 *   pages shrink as it shadows history.
 * - The cut is pulled back to the budget-spending message's own
 *   `min(seq, ...sourceEventSeqs)`, so a message is never split from the events
 *   that PRODUCED it — a repaired `tool/result` and the assistant block it
 *   answers stay together.
 *
 * The pullback is deliberately NOT applied to a replacement's citations. A
 * compaction summary cites every node it shadowed, so honouring those would
 * drag the whole shadowed history onto one page — defeating paging exactly on
 * the long sessions that need it. Those citations are references to history,
 * not parts of the record: no client folds the surface (the host sends the
 * folds a partial reader cannot do), so a summary whose shadowed originals lie
 * below the page renders correctly, and they arrive when the reader pages back.
 *
 * The fold is pure and takes any array sorted ascending by `seq` — a live
 * session's `facts`, or a stored log with its trace filtered out — and works in
 * SEQ space, never array-index space, because `facts` preserves seqs but not
 * indices.
 */
import { ASSISTANT_MESSAGE, USER_MESSAGE, type EventEnvelope } from './types.ts'

/**
 * The kinds that consume a page's budget. Deliberately NOT `SURFACE_TYPES`:
 * `tool/result` is a surface event and not a message (see the module note).
 */
const MESSAGE_TYPES: ReadonlySet<string> = new Set([USER_MESSAGE.type, ASSISTANT_MESSAGE.type])

/** Default budget, in arrived messages. */
export const DEFAULT_PAGE_MESSAGES = 50
/** Ceiling on the budget a client may ask for — a client may not ask for the whole log. */
export const MAX_PAGE_MESSAGES = 500
/**
 * Ceiling on the events one page may carry, enforced at message-group
 * boundaries. A single group larger than this is still served whole: a page
 * that split a group would cite events it did not carry.
 */
export const MAX_PAGE_EVENTS = 2_000

export interface EventPage {
  readonly events: readonly EventEnvelope[]
  /** Inclusive lower seq bound: the group start the cut landed on (0 for a page that reaches the head). */
  readonly from: number
  /** Inclusive upper seq bound, or -1 for an empty page. */
  readonly to: number
  /** Events exist below `from`. */
  readonly hasMore: boolean
}

export interface PageRequest {
  /** Inclusive upper bound — the consistent cut the page is anchored to. */
  readonly throughSeq: number
  /** Exclusive upper bound for an older page; must not exceed `throughSeq + 1`. */
  readonly beforeSeq?: number
  readonly maxMessages?: number
  readonly maxEvents?: number
}

/** The lowest seq a record refers to: its own, or the earliest event it cites. */
export function groupStart(event: EventEnvelope): number {
  let start = event.seq
  for (const source of event.sourceEventSeqs ?? []) if (source < start) start = source
  return start
}

/** First index whose seq is >= `seq`, in an array sorted ascending by seq. */
function lowerBound(events: readonly EventEnvelope[], seq: number): number {
  let low = 0
  let high = events.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (events[mid]!.seq < seq) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * The page ending at `throughSeq` (or just below `beforeSeq`), walking back
 * until the message budget or the event ceiling is spent.
 */
export function pageEvents(events: readonly EventEnvelope[], request: PageRequest): EventPage {
  const maxMessages = Math.max(1, Math.min(request.maxMessages ?? DEFAULT_PAGE_MESSAGES, MAX_PAGE_MESSAGES))
  const maxEvents = Math.max(1, request.maxEvents ?? MAX_PAGE_EVENTS)
  // Exclusive upper bound in seq space, then in index space.
  const upperSeq = Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1)
  const end = lowerBound(events, upperSeq)
  if (end === 0) return { events: [], from: 0, to: -1, hasMore: false }

  let messages = 0
  let cut = 0
  /** The start of the oldest message group fully walked — the only legal ceiling cut. */
  let lastGroupStart: number | undefined
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index]!
    if (MESSAGE_TYPES.has(event.type) && event.surfaceOp?.op === 'append') {
      messages++
      lastGroupStart = groupStart(event)
      if (messages >= maxMessages) {
        cut = lastGroupStart
        break
      }
    }
    // The ceiling cuts where a group ended, so a page never carries half of
    // one; a group bigger than the ceiling is served whole. With no group
    // walked at all the ceiling still binds, at this event's own group start —
    // otherwise a run with no ARRIVED message in it (a stretch of log-only
    // facts, a tail of nothing but tool results) had no legal cut anywhere and
    // the whole log came back, ceiling or not.
    if (end - index >= maxEvents) {
      cut = lastGroupStart ?? groupStart(event)
      break
    }
  }

  const start = lowerBound(events, cut)
  const slice = events.slice(start, end)
  return {
    events: slice,
    from: cut,
    to: slice.length === 0 ? -1 : slice[slice.length - 1]!.seq,
    hasMore: cut > 0,
  }
}
