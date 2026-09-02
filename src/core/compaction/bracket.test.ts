/**
 * The compaction bracket and the give-up fold.
 *
 * The fold is where the care is. A naive "count every decline since the last
 * applied" would invert a rule the runtime has always had — a summary lost to a
 * race neither counts nor clears — so two deferred `/compact`s would switch the
 * automatic triggers off with no summary having failed. And an unbounded fold
 * would turn a two-strike counter into a latch nothing automatic can clear,
 * inherited by every fork.
 */
import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../session/index.ts'
import { COMPACTION_END, COUNTING_DECLINE_REASONS, foldCompactionFailures, type CompactionDeclineReason, type CompactionEndOutcome } from './index.ts'

let seq = 0
function end(outcome: CompactionEndOutcome): EventEnvelope {
  return { type: COMPACTION_END.type, seq: seq++, time: 0, data: { startSeq: 0, outcome } }
}
function declined(reason: CompactionDeclineReason): EventEnvelope {
  return end({ kind: 'declined', reason })
}
function other(): EventEnvelope {
  return { type: 'turn/end', seq: seq++, time: 0, data: {} }
}

describe('foldCompactionFailures', () => {
  it('counts only what the summariser is responsible for', () => {
    seq = 0
    expect(foldCompactionFailures([declined('summary-failed'), declined('summary-empty'), declined('summary-not-smaller')])).toBe(3)
  })

  /**
   * The documented rule, now checkable: a lost race neither counts nor clears.
   * Without this split, two `/compact`s deferred by a starting turn would reach
   * the shipped `maxSummaryFailures: 2` and disable automatic compaction while
   * every summary call had succeeded.
   */
  it('skips every race and shutdown, neither counting nor clearing them', () => {
    seq = 0
    const races: CompactionDeclineReason[] = ['turn-started', 'plan-stale', 'agent-gone', 'cancelled']
    expect(foldCompactionFailures(races.map(declined))).toBe(0)
    for (const reason of races) expect(COUNTING_DECLINE_REASONS.has(reason)).toBe(false)

    seq = 0
    // A race in the middle is transparent: the two real failures still count.
    expect(foldCompactionFailures([declined('summary-failed'), declined('turn-started'), declined('summary-empty')])).toBe(2)
  })

  it('an applied compaction clears the count, and nothing before it is looked at', () => {
    seq = 0
    expect(foldCompactionFailures([declined('summary-failed'), declined('summary-failed'), end({ kind: 'applied' }), declined('summary-empty')])).toBe(1)
  })

  it('ignores everything that is not a bracket end', () => {
    seq = 0
    expect(foldCompactionFailures([other(), declined('summary-failed'), other()])).toBe(1)
  })

  /**
   * The bound that keeps a counter from becoming a latch. Only an applied
   * compaction clears the fold, and the automatic triggers that could produce
   * one are exactly what a give-up disabled — so without `liveStart` a session
   * that failed twice would never compact automatically again, in any resume,
   * and every fork of it would be born disabled.
   */
  it('counts only this lifecycle, so a resume gets a fresh two attempts', () => {
    seq = 0
    const inherited = [declined('summary-failed'), declined('summary-failed')]
    const live = [declined('summary-failed')]
    const log = [...inherited, ...live]
    expect(foldCompactionFailures(log)).toBe(3)
    // `liveStart` is the seq this lifecycle's own writes begin at.
    expect(foldCompactionFailures(log, live[0]!.seq)).toBe(1)
    expect(foldCompactionFailures(log, log.length)).toBe(0)
  })
})
