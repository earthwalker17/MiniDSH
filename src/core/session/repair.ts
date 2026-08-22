import { asCallId } from '../ids.ts'
import { createToolResultMessage } from '../llm/message.ts'
import { deepFreeze, snapshotJson } from '../json.ts'
import { matches, STEP_START, STEP_END, TOOL_CALL, TOOL_RESULT, TURN_END, TURN_START, type EventEnvelope } from './types.ts'

/**
 * Closing events for an interrupted tail: a synthetic tool result for every
 * unmatched call, then a step end if a step is open, then an interrupted turn
 * end. Time reuses the last real event's time so repair is deterministic. A
 * balanced log yields `[]`.
 */
export function repairInterruptedTail(events: readonly EventEnvelope[]): EventEnvelope[] {
  let openTurn: number | undefined
  let openStep: { turn: number; step: number } | undefined
  const pending = new Map<string, number>()
  for (const event of events) {
    if (matches(event, TURN_START)) openTurn = event.data.turn
    else if (matches(event, TURN_END)) {
      openTurn = undefined
      openStep = undefined
      pending.clear()
    } else if (matches(event, STEP_START)) openStep = { turn: event.data.turn, step: event.data.step }
    else if (matches(event, STEP_END)) {
      openStep = undefined
      pending.clear()
    } else if (matches(event, TOOL_CALL)) pending.set(event.data.callId, event.seq)
    else if (matches(event, TOOL_RESULT)) pending.delete(event.data.callId)
  }
  if (openTurn === undefined) return []

  const closers: EventEnvelope[] = []
  const time = events.at(-1)?.time ?? Date.now()
  let seq = events.length
  const turn = openTurn
  const step = openStep?.step ?? 0

  for (const [callId, callSeq] of pending) {
    const message = createToolResultMessage(
      asCallId(callId),
      [{ type: 'text', text: 'Tool result unknown: the session was interrupted before completion.' }],
      true,
    )
    closers.push(
      deepFreeze({
        type: TOOL_RESULT.type,
        seq: seq++,
        time,
        data: snapshotJson({ turn, step, callId, message, error: { name: 'InterruptedError', code: 'TOOL_OUTCOME_UNKNOWN' } }),
        surfaceOp: { op: 'append' },
        sourceEventSeqs: [callSeq],
      }) as EventEnvelope,
    )
  }
  if (openStep) {
    closers.push(deepFreeze({ type: STEP_END.type, seq: seq++, time, data: { turn, step } }) as EventEnvelope)
  }
  closers.push(deepFreeze({ type: TURN_END.type, seq: seq++, time, data: { turn, reason: { kind: 'interrupted' } } }) as EventEnvelope)
  return closers
}
