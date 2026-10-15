/**
 * The jobs bracket's rules, live and cold.
 *
 * Ids are unique in a log, an end needs an open start, and a job ends once.
 * One rule is POSITIONAL: `lost` is crash repair's word, written into a
 * resumed or forked session's SEED by `closeUnpairedJobs`, and never by a live
 * writer — a registry that called its own job lost would be stating that its
 * record ended while it was still writing it. The live observer therefore
 * refuses `lost` only at or after the lifecycle's `liveStart`; seeded closers
 * fold like any other fact. A cold reader cannot tell a seeded closer from a
 * live append, so `checkJobsLog` does not apply that rule at all.
 */
import type { Plugin } from '../../kernel/index.ts'
import { firstViolation, INVARIANTS, type InvariantFailure, type InvariantInstaller, type LogViolation } from '../invariants/index.ts'
import { matches, SESSION_EVENT, type EventEnvelope, type Session } from '../session/index.ts'
import { JOB_END, JOB_START } from './events.ts'

interface Trace {
  lastSeq: number
  started: Set<string>
  ended: Set<string>
}

function freshTrace(): Trace {
  return { lastSeq: -1, started: new Set(), ended: new Set() }
}

function validate(trace: Trace, event: EventEnvelope, fail: InvariantFailure, live: boolean): void {
  trace.lastSeq = event.seq
  if (matches(event, JOB_START)) {
    const jobId: unknown = event.data?.jobId
    if (typeof jobId !== 'string' || jobId.length === 0) fail('job/start carries no job id')
    if (trace.started.has(jobId)) fail(`job/start "${jobId}" reuses a job id this log already started`)
    trace.started.add(jobId)
    return
  }
  if (matches(event, JOB_END)) {
    // Untrusted shape: a stored payload is read as unknown before it is believed.
    const jobId: unknown = event.data?.jobId
    const cause: unknown = event.data?.cause
    if (typeof jobId !== 'string' || jobId.length === 0) fail('job/end carries no job id')
    if (typeof cause !== 'string') fail(`job/end "${jobId}" carries no cause`)
    if (!trace.started.has(jobId)) fail(`job/end "${jobId}" has no job/start`)
    if (trace.ended.has(jobId)) fail(`job/end "${jobId}" is a second end for one job`)
    if (live && cause === 'lost') fail(`job/end "${jobId}" says lost: only crash repair and a fork write that, into a seed`)
    trace.ended.add(jobId)
  }
}

const NAME = 'core-jobs'

const installJobsInvariant: InvariantInstaller = (ctx, fail) => {
  const traces = new WeakMap<Session, Trace>()
  const staged = new WeakMap<Session, Trace>()
  ctx.observe((info) => {
    if (info.name !== SESSION_EVENT.name) return
    const session = info.args[0] as Session
    const event = info.args[1] as EventEnvelope
    let trace = traces.get(session)
    if (!trace) {
      trace = freshTrace()
      for (const prior of session.facts) {
        if (prior.seq >= event.seq) break
        validate(trace, prior, fail, prior.seq >= session.liveStart)
      }
      traces.set(session, trace)
    }
    const next: Trace = { ...trace, started: new Set(trace.started), ended: new Set(trace.ended) }
    validate(next, event, fail, event.seq >= session.liveStart)
    staged.set(session, next)
  })
  ctx.on(SESSION_EVENT, (session, event) => {
    const next = staged.get(session)
    staged.delete(session)
    if (next && next.lastSeq === event.seq) traces.set(session, next)
  })
}

/** The bracket over a whole stored log, cold: unique ids, one end per start. The first violation, or none. */
export function checkJobsLog(events: readonly EventEnvelope[]): LogViolation | undefined {
  const trace = freshTrace()
  return firstViolation(events, (index, fail) => validate(trace, events[index]!, fail, false))
}

/** Registers the jobs invariant. Mount only where invariants run. */
export const jobsInvariantPlugin: Plugin = {
  name: 'core-jobs-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, NAME, installJobsInvariant)
  },
}
