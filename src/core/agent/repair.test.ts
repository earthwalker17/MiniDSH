import { describe, expect, it } from 'vitest'
import { COMPACTION_END, COMPACTION_START, foldCompactionFailures } from '../compaction/index.ts'
import { STEP_START, TOOL_CALL, TURN_START, type EventEnvelope } from '../session/index.ts'
import { SUBAGENT_END, SUBAGENT_START } from './events.ts'
import { repairTail } from './repair.ts'

let seq = 0
function log(...entries: { type: string; data: unknown }[]): EventEnvelope[] {
  seq = 0
  return entries.map((entry) => ({ type: entry.type, seq: seq++, time: 1_700_000_000_000, data: entry.data }))
}
const ev = <D>(kind: { type: string }, data: D): { type: string; data: unknown } => ({ type: kind.type, data })

const START = {
  callId: 'c1',
  childId: 'child-1',
  depth: 1,
  provider: 'p',
  model: 'm',
  sandbox: 'read-only' as const,
  approval: 'never' as const,
}
const PLAN = { trigger: 'explicit' as const, budgetTokens: 1000, projectedTokens: 900, plannedStart: 2, plannedEnd: 9, plannedNodes: 6 }

describe('repairTail: the composed crash repair', () => {
  it('closes an unpaired delegation as interrupted, and pairs nothing that already paired', () => {
    const events = log(
      ev(TURN_START, { turn: 1 }),
      ev(STEP_START, { turn: 1, step: 1 }),
      ev(SUBAGENT_START, { ...START, childId: 'done', callId: 'c0' }),
      ev(SUBAGENT_END, { callId: 'c0', childId: 'done', reason: { kind: 'completed' } }),
      ev(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'subagent', arguments: '{}' }),
      ev(SUBAGENT_START, START),
    )
    const closers = repairTail(events)
    const ends = closers.filter((event) => event.type === SUBAGENT_END.type)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).toEqual({ callId: 'c1', childId: 'child-1', reason: { kind: 'interrupted' } })
    // The delegation closes BEFORE the tool result that answers its call, as it
    // would have live, and the turn — the outermost bracket — closes last.
    expect(closers.map((event) => event.type)).toEqual(['subagent/end', 'tool/result', 'step/end', 'turn/end'])
  })

  it('closes a compaction bracket opened with no turn open, which nothing could reach before', () => {
    // `/compact` on an idle agent: no turn, so the session's own closers have
    // nothing to say, and the bracket used to stay open forever.
    const events = log(ev(COMPACTION_START, PLAN))
    const closers = repairTail(events)
    expect(closers.map((event) => event.type)).toEqual(['compaction/end'])
    expect(closers[0]!.data).toEqual({ startSeq: 0, outcome: { kind: 'declined', reason: 'unclosed' } })
  })

  it('says only what it knows: `unclosed`, not `interrupted`', () => {
    // An ordinary disposal mid-summary reaches `agent-gone` with the session
    // already detached and no append left legal, so an unpaired compaction
    // start is NOT evidence of a crash. The delegation bracket is, because the
    // tool owes its end on every exit path it has.
    const closers = repairTail(log(ev(COMPACTION_START, PLAN), ev(SUBAGENT_START, START)))
    const reasons = closers.map((event) => JSON.stringify(event.data))
    expect(reasons.some((data) => data.includes('"unclosed"'))).toBe(true)
    expect(reasons.some((data) => data.includes('"interrupted"'))).toBe(true)
  })

  it('leaves a balanced log alone and threads seqs and one timestamp through every closer', () => {
    expect(repairTail(log(ev(COMPACTION_START, PLAN), ev(COMPACTION_END, { startSeq: 0, outcome: { kind: 'applied' } })))).toEqual([])

    const events = log(ev(TURN_START, { turn: 1 }), ev(SUBAGENT_START, START), ev(COMPACTION_START, PLAN))
    const closers = repairTail(events)
    expect(closers.map((event) => event.seq)).toEqual([3, 4, 5])
    expect(new Set(closers.map((event) => event.time))).toEqual(new Set([1_700_000_000_000]))
  })

  it('cannot move the give-up count, whichever way it is folded', () => {
    const events = log(ev(COMPACTION_START, PLAN))
    const repaired = [...events, ...repairTail(events)]
    // Not a counting reason, and not `applied`, so it neither adds a failure
    // nor shields an older one. On a resumed session it also sits below
    // `liveStart` and the fold stops before reaching it at all.
    expect(foldCompactionFailures(repaired)).toBe(0)
    expect(foldCompactionFailures(repaired, repaired.length)).toBe(0)
  })
})
