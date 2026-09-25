import type { Plugin } from '../../kernel/index.ts'
import { firstViolation, INVARIANTS, type InvariantFailure, type InvariantInstaller, type LogViolation } from '../invariants/index.ts'
import type { Session } from './session.ts'
import { SESSION_EVENT } from './store.ts'
import { Surface } from './surface.ts'
import {
  ASSISTANT_CHUNK,
  ASSISTANT_MESSAGE,
  END_SEED,
  matches,
  REQUEST_HEADER,
  SESSION_LIFECYCLE,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_DISPATCH,
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
  /** Where the current lifecycle segment began: 0, or just after a `session/end-seed`. */
  segmentStart: number
}

function freshTrace(): Trace {
  return { lastSeq: -1, openTurn: undefined, openStep: undefined, nextTurn: 1, nextStep: 1, pending: new Set(), segmentStart: 0 }
}

const ORIGINS: ReadonlySet<string> = new Set(['new', 'seeded', 'resumed'])

const STEP_SCOPED = new Set([ASSISTANT_CHUNK.type, ASSISTANT_MESSAGE.type, TOOL_CALL.type, TOOL_DISPATCH.type, TOOL_RESULT.type, REQUEST_HEADER.type])

/** Validates one event against the running trace; throws via `fail` on violation. */
function validate(trace: Trace, event: EventEnvelope, fail: InvariantFailure): void {
  if (event.seq !== trace.lastSeq + 1) fail(`seq ${event.seq} is not contiguous (expected ${trace.lastSeq + 1})`)
  trace.lastSeq = event.seq

  if (matches(event, END_SEED)) {
    trace.segmentStart = event.seq + 1
    return
  }
  if (matches(event, SESSION_LIFECYCLE)) {
    // Crash repair trusts this record's claims about everything after it in
    // its segment, so it may only OPEN a segment — which also makes it once
    // per segment: a record appended mid-lifecycle would vouch for events its
    // writer never wrote.
    if (event.seq !== trace.segmentStart) fail(`session/lifecycle at seq ${event.seq} is not the first fact of its lifecycle (seq ${trace.segmentStart})`)
    const data: unknown = event.data
    const { origin, dispatch, durability } = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
    if (typeof origin !== 'string' || !ORIGINS.has(origin)) fail(`session/lifecycle carries an unknown origin ${JSON.stringify(origin)}`)
    if (dispatch !== undefined && dispatch !== true) fail('session/lifecycle dispatch is neither absent nor true')
    if (durability !== undefined && durability !== 'synced') fail(`session/lifecycle carries an unknown durability ${JSON.stringify(durability)}`)
    return
  }

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
    // An ARRIVING message belongs to a turn: it is input, and input is what a
    // turn is made of. A message that REPLACES a range is not input at all —
    // it is a rewrite of the model-visible surface (a compaction checkpoint),
    // and rewriting between turns is exactly when a human asks for it.
    if (trace.openTurn === undefined && event.surfaceOp?.op !== 'replace') fail('user/message outside a turn')
    return
  }
  if (STEP_SCOPED.has(event.type)) {
    if (trace.openStep === undefined) fail(`step-scoped event "${event.type}" outside an open step`)
    if (matches(event, TOOL_CALL)) trace.pending.add(event.data.callId)
    // The gate-passed fact is only meaningful about a call this step logged:
    // one without a pending call would make the recovery rule read a dispatch
    // for something that was never dispatched.
    if (matches(event, TOOL_DISPATCH) && !trace.pending.has(event.data.callId)) {
      fail(`tool/dispatch for "${event.data.callId}" has no pending tool/call`)
    }
    if (matches(event, TOOL_RESULT)) {
      // Repair answers blocks that never logged a call: as not started, or —
      // salvaging a damaged prefix, which may have lost the call line itself —
      // as unknown under its own name.
      const synthetic = event.data.error?.code === 'TOOL_NOT_STARTED' || event.data.error?.name === 'SalvagedError'
      if (!synthetic && !trace.pending.has(event.data.callId)) fail(`tool/result for "${event.data.callId}" has no pending tool/call`)
      trace.pending.delete(event.data.callId)
    }
  }
}

const NAME = 'core-session'

const installSessionInvariant: InvariantInstaller = (ctx, fail) => {
  const traces = new WeakMap<Session, Trace>()
  const staged = new WeakMap<Session, Trace>()
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
    // Observation is pre-commit and any observer may still reject this event, so
    // the advanced trace is only staged here and committed once the event lands.
    const next: Trace = { ...trace, pending: new Set(trace.pending) }
    validate(next, event, fail)
    staged.set(session, next)
  })
  ctx.on(SESSION_EVENT, (session, event) => {
    const next = staged.get(session)
    staged.delete(session)
    if (next && next.lastSeq === event.seq) traces.set(session, next)
  })
}

/**
 * The session's structure over a whole stored log, cold (§4): what seeding it
 * would check (`Surface` placement, replace ranges and citations) and what the
 * live invariant holds every append to (seqs, turn and step nesting, call
 * pairing, the lifecycle record's position). The first violation, or none.
 */
export function checkSessionLog(events: readonly EventEnvelope[]): LogViolation | undefined {
  const trace = freshTrace()
  const surface = new Surface()
  return firstViolation(events, (index, fail) => {
    const event = events[index]!
    try {
      surface.validate(event)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    validate(trace, event, fail)
    surface.apply(event)
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
