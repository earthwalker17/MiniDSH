import type { Plugin } from '../../kernel/index.ts'
import { INVARIANTS, type InvariantFailure, type InvariantInstaller } from '../invariants/index.ts'
import type { Session } from './session.ts'
import { SESSION_EVENT } from './store.ts'
import {
  ASSISTANT_CHUNK,
  ASSISTANT_MESSAGE,
  matches,
  REQUEST_HEADER,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type EventEnvelope,
} from './types.ts'

interface Trace {
  lastSeq: number
  openTurn: number | undefined
  openStep: number | undefined
  nextTurn: number
  nextStep: number
  pending: Set<string>
}

function freshTrace(): Trace {
  return { lastSeq: -1, openTurn: undefined, openStep: undefined, nextTurn: 1, nextStep: 1, pending: new Set() }
}

const STEP_SCOPED = new Set([ASSISTANT_CHUNK.type, ASSISTANT_MESSAGE.type, TOOL_CALL.type, TOOL_RESULT.type, REQUEST_HEADER.type])

/** Validates one event against the running trace; throws via `fail` on violation. */
function validate(trace: Trace, event: EventEnvelope, fail: InvariantFailure): void {
  if (event.seq !== trace.lastSeq + 1) fail(`seq ${event.seq} is not contiguous (expected ${trace.lastSeq + 1})`)
  trace.lastSeq = event.seq

  if (matches(event, TURN_START)) {
    if (trace.openTurn !== undefined) fail(`turn/start ${event.data.turn} while turn ${trace.openTurn} is open`)
    if (event.data.turn !== trace.nextTurn) fail(`turn number ${event.data.turn} != expected ${trace.nextTurn}`)
    trace.openTurn = event.data.turn
    trace.nextTurn++
    trace.nextStep = 1
    return
  }
  if (matches(event, TURN_END)) {
    if (trace.openTurn !== event.data.turn) fail(`turn/end ${event.data.turn} does not match open turn ${String(trace.openTurn)}`)
    if (trace.openStep !== undefined) fail(`turn/end while step ${trace.openStep} is open`)
    trace.openTurn = undefined
    return
  }
  if (matches(event, STEP_START)) {
    if (trace.openTurn !== event.data.turn) fail(`step/start in turn ${event.data.turn} but open turn is ${String(trace.openTurn)}`)
    if (trace.openStep !== undefined) fail(`step/start while step ${trace.openStep} is open`)
    if (event.data.step !== trace.nextStep) fail(`step number ${event.data.step} != expected ${trace.nextStep}`)
    trace.openStep = event.data.step
    trace.nextStep++
    trace.pending.clear()
    return
  }
  if (matches(event, STEP_END)) {
    if (trace.openStep !== event.data.step) fail(`step/end ${event.data.step} does not match open step ${String(trace.openStep)}`)
    trace.openStep = undefined
    trace.pending.clear()
    return
  }
  if (matches(event, USER_MESSAGE)) {
    if (trace.openTurn === undefined) fail('user/message outside a turn')
    return
  }
  if (STEP_SCOPED.has(event.type)) {
    if (trace.openStep === undefined) fail(`step-scoped event "${event.type}" outside an open step`)
    if (matches(event, TOOL_CALL)) trace.pending.add(event.data.callId)
    if (matches(event, TOOL_RESULT)) {
      const synthetic = event.data.error?.code === 'TOOL_NOT_STARTED'
      if (!synthetic && !trace.pending.has(event.data.callId)) fail(`tool/result for "${event.data.callId}" has no pending tool/call`)
      trace.pending.delete(event.data.callId)
    }
  }
}

const NAME = 'core-session'

const installSessionInvariant: InvariantInstaller = (ctx, fail) => {
  const traces = new WeakMap<Session, Trace>()
  ctx.observe((info) => {
    if (info.name !== SESSION_EVENT.name) return
    const session = info.args[0] as Session
    const event = info.args[1] as EventEnvelope
    let trace = traces.get(session)
    if (!trace) {
      trace = freshTrace()
      // Fold any prior (seed) events so numbering and pairing account for them.
      for (const prior of session.events) {
        if (prior.seq >= event.seq) break
        validate(trace, prior, fail)
      }
      traces.set(session, trace)
    }
    validate(trace, event, fail)
  })
}

/** Registers the session relational-trace invariant. Mount only where invariants run. */
export const sessionInvariantPlugin: Plugin = {
  name: 'core-session-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, NAME, installSessionInvariant)
  },
}
