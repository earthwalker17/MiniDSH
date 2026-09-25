import { APPROVAL_DECIDED, undecidedApprovals } from '../approval/events.ts'
import { describeEffects, EFFECT_RECORDED, type EffectRecorded } from '../effects/events.ts'
import { asCallId, asMessageId } from '../ids.ts'
import { createToolResultMessage, restoreMessage } from '../llm/message.ts'
import { deepFreeze, snapshotJson } from '../json.ts'
import {
  ASSISTANT_MESSAGE,
  END_SEED,
  matches,
  SESSION_LIFECYCLE,
  STEP_START,
  STEP_END,
  TOOL_CALL,
  TOOL_DISPATCH,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  type EventEnvelope,
  type LifecycleRecord,
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
export type TailCloser = (events: readonly EventEnvelope[], nextSeq: number, time: number, context?: RepairContext) => EventEnvelope[]

/**
 * What the events are. `salvage`: a DAMAGED log's readable prefix, cut at the
 * first bad line wherever it fell — not a crash suffix, so nothing about what
 * is missing past it can be inferred, and every closer is a conservative
 * placeholder rather than a fact.
 */
export interface RepairContext {
  readonly salvage?: boolean
}

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
 *   | evidence for the block                            | code                   |
 *   | no `tool/call`                                    | `TOOL_NOT_STARTED`     |
 *   | a `tool/dispatch`, or a recorded effect           | `TOOL_OUTCOME_UNKNOWN` |
 *   | neither, in a lifecycle whose `session/lifecycle` | `TOOL_NOT_STARTED`     |
 *   |   claims `dispatch` AND `durability: 'synced'`    |                        |
 *   | anything else                                     | `TOOL_OUTCOME_UNKNOWN` |
 *
 * and under `salvage` every block is `TOOL_OUTCOME_UNKNOWN` (`classify`).
 *
 * The third row is what `tool/dispatch` and a synced checkpoint buy together:
 * the driver makes the dispatch durable before any body, so after a crash OR a
 * power cut a missing one means the gate never passed — a call that died at
 * its policy gate or waiting on a person's consent. Both claims are read from
 * the record of the open turn's lifecycle, never inferred: a lifecycle written
 * before S16 (1.0.0, or an unsynced store) gets the last row.
 *
 * The last row is a default, and claiming "did not run" about a body that ran
 * is the one error this contract exists to prevent.
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
  context: RepairContext = {},
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
  /**
   * The record of the CURRENT lifecycle segment, reset at every
   * `session/end-seed`. The open turn always lies in the last segment — each
   * resume closes the tail before its own end-seed, and a fork refuses an
   * open turn — so at the end of the pass this is the open turn's writer.
   */
  let lifecycle: LifecycleRecord | undefined
  const clearStep = (): void => {
    blocks = []
    calls.clear()
    dispatched.clear()
    effects.clear()
    answered.clear()
  }
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (matches(event, END_SEED)) lifecycle = undefined
    else if (matches(event, SESSION_LIFECYCLE)) lifecycle ??= event.data
    else if (matches(event, TURN_START)) {
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
    else if (matches(event, TOOL_DISPATCH)) dispatched.add(event.data.callId)
    else if (matches(event, EFFECT_RECORDED)) {
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
  const salvage = context.salvage === true
  for (const entry of owed) {
    const recorded = effects.get(entry.callId) ?? []
    const code = classify({
      logged: entry.started,
      reachedBody: dispatched.has(entry.callId) || recorded.length > 0,
      claimsDispatch: lifecycle?.dispatch === true,
      synced: lifecycle?.durability === 'synced',
      salvage,
    })
    const text = salvage ? salvageText(recorded) : code === 'TOOL_OUTCOME_UNKNOWN' ? unknownText(recorded) : notStartedText(entry.started)
    /**
     * A DERIVED message id, not a minted one. Everything else a closer emits
     * is a pure function of the log, and `createToolResultMessage` would put a
     * fresh UUID in the middle of it — so two readers of one stored log
     * produced different bytes, and the claim persistence leans on when it
     * compares a resumed tail ("another process writes the same closers")
     * would have been false the moment that check grew past type and time.
     * Unique within a session: one synthetic result per call, per open step.
     */
    const message = restoreMessage({
      ...createToolResultMessage(asCallId(entry.callId), [{ type: 'text', text }], true),
      id: asMessageId(`msg-repair-${turn}-${step}-${entry.callId}`),
    })
    closers.push(
      deepFreeze({
        type: TOOL_RESULT.type,
        seq: seq++,
        time,
        data: snapshotJson({ turn, step, callId: entry.callId, message, error: { name: salvage ? 'SalvagedError' : 'InterruptedError', code } }),
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
 * The recovery table, as four rows — and one override.
 *
 * The third row is the one that is easy to get wrong. A missing
 * `tool/dispatch` means "the gate never passed" only if the log could not have
 * LOST it, and that is a property of the WRITER, which its lifecycle record
 * states: `dispatch` (this driver writes one before every body) and
 * `durability: 'synced'` (every checkpoint it passed was on stable storage, so
 * the dispatch was on disk before any body ran). Absent either claim — a 1.0.0
 * log, an unsynced store — a power cut could have taken the dispatch line and
 * left the call, and the answer is unknown.
 *
 * S14 answered that with "the log kept an event written after the call"; the
 * S16 design critique showed it unsound under power loss, because the gate
 * itself writes `approval/*` BETWEEN the call and the dispatch, so a surviving
 * later event does not prove the dispatch could not have been lost.
 *
 * The first row keeps process-crash semantics for an unsynced writer (the
 * driver logs `tool/call` before any gate or body, and a crash loses nothing
 * that was written); a synced writer made the call durable before its gate.
 *
 * `salvage` overrides all of it: a damaged prefix stops at the first bad line
 * wherever it fell, which may be the very `tool/call` of a block whose body
 * ran and whose later lines are unreadable — so no absence proves anything.
 */
function classify(evidence: {
  /** A `tool/call` was logged for this block. */
  readonly logged: boolean
  /** A `tool/dispatch` was logged for it, or an effect was recorded against it. */
  readonly reachedBody: boolean
  /** The open turn's lifecycle record says its driver writes `tool/dispatch` before every body. */
  readonly claimsDispatch: boolean
  /** ... and that its checkpoints were on stable storage. */
  readonly synced: boolean
  readonly salvage: boolean
}): 'TOOL_NOT_STARTED' | 'TOOL_OUTCOME_UNKNOWN' {
  if (evidence.salvage) return 'TOOL_OUTCOME_UNKNOWN'
  if (!evidence.logged) return 'TOOL_NOT_STARTED'
  if (evidence.reachedBody) return 'TOOL_OUTCOME_UNKNOWN'
  if (evidence.claimsDispatch && evidence.synced) return 'TOOL_NOT_STARTED'
  return 'TOOL_OUTCOME_UNKNOWN'
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

/** What the model is told about a call in a salvaged fork: the record stopped here, and the world may not have. */
function salvageText(recorded: readonly EffectRecorded[]): string {
  const evidence = describeEffects(recorded)
  return (
    'Tool result unknown: this session was forked from a DAMAGED log whose record is unreadable after this point, so this call — and any later work that is not in this history — may have taken effect. ' +
    (evidence === undefined ? '' : `${evidence} `) +
    'Check the current state before acting on anything, and repeat a call only if it is read-only or idempotent — never blindly.'
  )
}

function notStartedText(logged: boolean): string {
  return logged
    ? 'Tool not started: the session was interrupted while this call was still at the policy and approval gate, so its body never ran. It is safe to make the call again.'
    : 'Tool not started: the session was interrupted before this call was dispatched. It is safe to make the call again.'
}
