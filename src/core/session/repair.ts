import { APPROVAL_DECIDED, undecidedApprovals } from '../approval/events.ts'
import { describeEffects, EFFECT_RECORDED, type EffectRecorded } from '../effects/events.ts'
import { asCallId } from '../ids.ts'
import { createToolResultMessage } from '../llm/message.ts'
import { deepFreeze, snapshotJson } from '../json.ts'
import {
  ASSISTANT_MESSAGE,
  matches,
  STEP_START,
  STEP_END,
  TOOL_CALL,
  TOOL_DISPATCH,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  type EventEnvelope,
} from './types.ts'

/**
 * One closer in the composed repair: pure, given the whole log plus the seq
 * its own records start at and the one timestamp every closer shares.
 *
 * The composition is `core/agent/repair.ts`, not here, because a bracket's
 * vocabulary belongs to the package that opens it and the session has no
 * business knowing about delegation or compaction. This module owns exactly
 * the session's own structure: turns, steps, calls, and the approval pairs a
 * call leaves open.
 */
export type TailCloser = (events: readonly EventEnvelope[], nextSeq: number, time: number) => EventEnvelope[]

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
 *      wire refuses on every later request.
 *   3. `step/end` if a step is open, then `turn/end{interrupted}`.
 *
 * **What the result SAYS is the recovery contract.** Four cases, in order:
 *
 *   | evidence for the block                     | code                   |
 *   | no `tool/call`                             | `TOOL_NOT_STARTED`     |
 *   | a `tool/dispatch`                          | `TOOL_OUTCOME_UNKNOWN` |
 *   | no dispatch, in a log that records them    | `TOOL_NOT_STARTED`     |
 *   | no dispatch, in a log that records none    | `TOOL_OUTCOME_UNKNOWN` |
 *
 * The third row is what `tool/dispatch` bought: a call that died at its policy
 * gate or waiting on a person's consent provably never reached a body, and
 * before S14 every logged call had to be read as "may have run".
 *
 * The fourth is the price of an additive format. A log written by an earlier
 * version records no dispatches at all, so absence there is not evidence, and
 * claiming "did not run" about a body that ran is the one error this contract
 * exists to prevent. The probe is therefore the whole log: if it has ever
 * recorded a dispatch, its writer records them. One hole remains and is
 * stated rather than papered over — a call killed inside its gate BEFORE a
 * log's first dispatch reads as outcome-unknown, the safe direction.
 *
 * An outcome-unknown result also carries what the log can prove about how far
 * the call got: the effects recorded for it in this step (§4). Presence is
 * proof, absence proves nothing, and the sentence says so, because a model
 * reading a list reads an inventory unless told otherwise.
 *
 * Time reuses the last real event's time so repair is deterministic. A
 * balanced log yields `[]`.
 */
export function repairInterruptedTail(
  events: readonly EventEnvelope[],
  nextSeq: number = events.length,
  time: number = events.at(-1)?.time ?? Date.now(),
): EventEnvelope[] {
  let openTurn: number | undefined
  let openStep: { turn: number; step: number } | undefined
  let turnStartIndex = 0
  /** The open step's assistant tool-call blocks, in order, and where the message sits. */
  let blocks: { id: string; messageSeq: number }[] = []
  const calls = new Map<string, number>()
  const dispatched = new Set<string>()
  const effects = new Map<string, EffectRecorded[]>()
  const answered = new Set<string>()
  /** Does this log's WRITER record dispatches at all? Whole-log, never reset. */
  let recordsDispatch = false
  const clearStep = (): void => {
    blocks = []
    calls.clear()
    dispatched.clear()
    effects.clear()
    answered.clear()
  }
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (matches(event, TURN_START)) {
      openTurn = event.data.turn
      turnStartIndex = i
    } else if (matches(event, TURN_END)) {
      openTurn = undefined
      openStep = undefined
      clearStep()
    } else if (matches(event, STEP_START)) {
      openStep = { turn: event.data.turn, step: event.data.step }
      clearStep()
    } else if (matches(event, STEP_END)) {
      openStep = undefined
      clearStep()
    } else if (matches(event, ASSISTANT_MESSAGE)) {
      blocks = event.data.message.content
        .filter((block): block is Extract<typeof block, { type: 'tool-call' }> => block.type === 'tool-call')
        .map((block) => ({ id: block.id, messageSeq: event.seq }))
    } else if (matches(event, TOOL_CALL)) calls.set(event.data.callId, event.seq)
    else if (matches(event, TOOL_DISPATCH)) {
      recordsDispatch = true
      dispatched.add(event.data.callId)
    } else if (matches(event, EFFECT_RECORDED)) {
      // Collected in the SAME pass and bounded by the step, which is also what
      // keeps a repeated call id honest: nothing makes one unique across
      // steps, and a whole-log fold would render an earlier turn's writes as
      // the effects of this unanswered call.
      const forCall = effects.get(event.data.callId)
      if (forCall) forCall.push(event.data)
      else effects.set(event.data.callId, [event.data])
    } else if (matches(event, TOOL_RESULT)) answered.add(event.data.callId)
  }
  if (openTurn === undefined) return []

  const closers: EventEnvelope[] = []
  let seq = nextSeq
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
    const ran = entry.started && (dispatched.has(entry.callId) || !recordsDispatch)
    const text = ran ? unknownText(effects.get(entry.callId) ?? []) : notStartedText(entry.started)
    const code = ran ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED'
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

/**
 * What the model is told when the body may have run.
 *
 * It never invites a retry and it never forbids one either: the safe move
 * depends on what the action was, and the model is the only reader that knows.
 * So it says what is known, then names the one condition under which repeating
 * is safe. DSH's equivalent sentence takes the same shape.
 */
function unknownText(recorded: readonly EffectRecorded[]): string {
  const evidence = describeEffects(recorded)
  return (
    'Tool result unknown: the session was interrupted while this call was running, so it may or may not have taken effect. ' +
    (evidence === undefined ? 'No effect was recorded for it, which is not proof that none happened. ' : `${evidence} `) +
    'Check the current state before acting on this, and repeat the call only if it is read-only or idempotent — never blindly.'
  )
}

function notStartedText(logged: boolean): string {
  return logged
    ? 'Tool not started: the session was interrupted while this call was still at the policy and approval gate, so its body never ran. It is safe to make the call again.'
    : 'Tool not started: the session was interrupted before this call was dispatched. It is safe to make the call again.'
}
