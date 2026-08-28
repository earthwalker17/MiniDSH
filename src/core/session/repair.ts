import { APPROVAL_DECIDED, undecidedApprovals } from '../approval/events.ts'
import { asCallId } from '../ids.ts'
import { createToolResultMessage } from '../llm/message.ts'
import { deepFreeze, snapshotJson } from '../json.ts'
import { ASSISTANT_MESSAGE, matches, STEP_START, STEP_END, TOOL_CALL, TOOL_RESULT, TURN_END, TURN_START, type EventEnvelope } from './types.ts'

/**
 * Closing events for an interrupted tail, so a resumed session opens balanced:
 *
 *   1. `approval/decided{cancelled}` for every approval asked in the open turn
 *      and never decided — the audit pair must close exactly once, and a person
 *      who was still deliberating when the process died decided nothing.
 *   2. A synthetic `tool/result` for every tool-call BLOCK of the open step's
 *      assistant message that has no live result, in block order. The driver
 *      logs `tool/call` only when a call's turn comes, so a crash during call i
 *      of n leaves calls i+1..n with no call event at all; closing only the
 *      logged calls would resume a history in which an assistant message
 *      carries n tool calls and fewer results — a shape every OpenAI-compatible
 *      wire refuses on every later request. A logged call closes as
 *      `TOOL_OUTCOME_UNKNOWN`; a block that never reached dispatch closes as
 *      `TOOL_NOT_STARTED`, which the session invariant admits without a
 *      pending call.
 *   3. `step/end` if a step is open, then `turn/end{interrupted}`.
 *
 * Time reuses the last real event's time so repair is deterministic. A
 * balanced log yields `[]`.
 */
export function repairInterruptedTail(events: readonly EventEnvelope[]): EventEnvelope[] {
  let openTurn: number | undefined
  let openStep: { turn: number; step: number } | undefined
  let turnStartIndex = 0
  /** The open step's assistant tool-call blocks, in order, and where the message sits. */
  let blocks: { id: string; messageSeq: number }[] = []
  const calls = new Map<string, number>()
  const answered = new Set<string>()
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (matches(event, TURN_START)) {
      openTurn = event.data.turn
      turnStartIndex = i
    } else if (matches(event, TURN_END)) {
      openTurn = undefined
      openStep = undefined
      blocks = []
      calls.clear()
      answered.clear()
    } else if (matches(event, STEP_START)) {
      openStep = { turn: event.data.turn, step: event.data.step }
      blocks = []
      calls.clear()
      answered.clear()
    } else if (matches(event, STEP_END)) {
      openStep = undefined
      blocks = []
      calls.clear()
      answered.clear()
    } else if (matches(event, ASSISTANT_MESSAGE)) {
      blocks = event.data.message.content
        .filter((block): block is Extract<typeof block, { type: 'tool-call' }> => block.type === 'tool-call')
        .map((block) => ({ id: block.id, messageSeq: event.seq }))
    } else if (matches(event, TOOL_CALL)) calls.set(event.data.callId, event.seq)
    else if (matches(event, TOOL_RESULT)) answered.add(event.data.callId)
  }
  if (openTurn === undefined) return []

  const closers: EventEnvelope[] = []
  const time = events.at(-1)?.time ?? Date.now()
  let seq = events.length
  const turn = openTurn
  const step = openStep?.step ?? 0

  for (const id of undecidedApprovals(events.slice(turnStartIndex))) {
    closers.push(deepFreeze({ type: APPROVAL_DECIDED.type, seq: seq++, time, data: { id, outcome: 'cancelled' } }) as EventEnvelope)
  }

  // Every block the committed assistant message made, plus any logged call the
  // message somehow did not carry (defensive; the driver never produces one).
  const owed: { callId: string; source: number; started: boolean }[] = blocks
    .filter((block) => !answered.has(block.id))
    .map((block) => ({ callId: block.id, source: calls.get(block.id) ?? block.messageSeq, started: calls.has(block.id) }))
  for (const [callId, callSeq] of calls) {
    if (!answered.has(callId) && !owed.some((entry) => entry.callId === callId)) owed.push({ callId, source: callSeq, started: true })
  }
  for (const entry of owed) {
    const code = entry.started ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED'
    const text = entry.started
      ? 'Tool result unknown: the session was interrupted before completion.'
      : 'Tool not started: the session was interrupted before this call was dispatched.'
    const message = createToolResultMessage(asCallId(entry.callId), [{ type: 'text', text }], true)
    closers.push(
      deepFreeze({
        type: TOOL_RESULT.type,
        seq: seq++,
        time,
        data: snapshotJson({ turn, step, callId: entry.callId, message, error: { name: 'InterruptedError', code } }),
        surfaceOp: { op: 'append' },
        sourceEventSeqs: [entry.source],
      }) as EventEnvelope,
    )
  }
  if (openStep) {
    closers.push(deepFreeze({ type: STEP_END.type, seq: seq++, time, data: { turn, step } }) as EventEnvelope)
  }
  closers.push(deepFreeze({ type: TURN_END.type, seq: seq++, time, data: { turn, reason: { kind: 'interrupted' } } }) as EventEnvelope)
  return closers
}
