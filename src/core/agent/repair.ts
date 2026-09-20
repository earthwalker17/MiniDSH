/**
 * The whole crash repair, composed.
 *
 * `core/session` closes the session's own structure — the approval pairs, the
 * unanswered calls of the open step, the step and the turn. It knows nothing
 * about delegation or compaction, and should not: a bracket's vocabulary
 * belongs to the package that opens it. DSH refuses to close plugin brackets
 * for exactly that reason, and answers the question with a lifetime marker
 * instead: an opener before the last `session/end-seed` belongs to an ended
 * lifecycle, and its OWNER may judge it dead.
 *
 * MiniDSH answers it differently, and this file is the whole of the
 * difference. Both brackets it closes are CORE vocabularies already
 * (`agent/events.ts`, `compaction/events.ts`), so nothing here teaches core
 * about a plugin; and one deterministic answer that a cold read and a durable
 * repair both produce is worth more here than a marker a reader must know how
 * to interpret. The composition lives in `core/agent` because that is repair's
 * only caller — `resume`, and a `fork` of a cold source.
 *
 * **A STATIC list.** Three closers, readable off this file without running
 * anything. A registry would be the shape to reach for at a third user, and
 * there is no third user.
 *
 * **Order.** Innermost first: a delegation ends inside the tool call that
 * started it, a compaction bracket ends where the attempt did, and the turn —
 * the outermost bracket — closes last. The two bracket closers run whether or
 * not a turn is open, which is what finally reaches a `/compact` bracket
 * opened on an idle agent; the session's own closers still stop at the open
 * turn, because a call with no turn around it is not a shape this log has.
 *
 * **Purity.** Every closer takes the ORIGINAL events, the seq its records
 * start at and the one timestamp they all share (the last real event's), so
 * the same log always yields the same bytes — which is what lets persistence
 * attach by comparing the tail, and what makes a second crash before these
 * reach disk harmless: the next resume recomputes them exactly.
 */
import { repairInterruptedTail, type EventEnvelope, type TailCloser } from '../session/index.ts'
import { closeUnpairedCompactions } from '../compaction/events.ts'
import { closeUnpairedSubagents } from './events.ts'

const TAIL_CLOSERS: readonly TailCloser[] = [closeUnpairedSubagents, closeUnpairedCompactions, repairInterruptedTail]

/** Every closer a stored log owes, in order, seqs continuing from its length. A balanced log yields `[]`. */
export function repairTail(events: readonly EventEnvelope[]): EventEnvelope[] {
  const time = events.at(-1)?.time ?? Date.now()
  const closers: EventEnvelope[] = []
  let seq = events.length
  for (const close of TAIL_CLOSERS) {
    const made = close(events, seq, time)
    closers.push(...made)
    seq += made.length
  }
  return closers
}
