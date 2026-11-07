/**
 * The agent vocabulary's rules, live and cold.
 *
 * `agent/status` never repeats a value — a no-op transition signals a driver
 * bug. `agent/narrowing` is an OPENING fact: well-formed, at most one per log,
 * and only in its first lifecycle, before any turn and any authority stamp.
 * Those three places are what make the narrowing a property of the agent
 * rather than of one moment of it — a record written after a turn would
 * describe a world the agent had already acted in wider, and one written by a
 * later lifecycle would be a continuation choosing its own narrowing, which
 * only the creator does (`core/loop/factory.ts`). The fold refuses what it
 * cannot believe on its own (`foldNarrowing`), so this is the second fence,
 * not the only one.
 */
import type { Plugin } from '../../kernel/index.ts'
import { firstViolation, INVARIANTS, type InvariantFailure, type InvariantInstaller, type LogViolation } from '../invariants/index.ts'
import { SANDBOX_MODE } from '../sandbox/events.ts'
import { END_SEED, matches, SESSION_EVENT, TURN_START, type EventEnvelope, type Session } from '../session/index.ts'
import { AGENT_NARROWING, AGENT_STATUS, narrowingFault } from './events.ts'
import type { Agent, AgentStatus } from './types.ts'

/** What a log has seen so far that decides whether a narrowing may still be written. */
interface Opening {
  narrowed: boolean
  /** A turn, an authority stamp or a lifecycle boundary has passed: the opening is over. */
  closedBy: string | undefined
}

function validate(opening: Opening, event: EventEnvelope, fail: InvariantFailure): void {
  if (matches(event, AGENT_NARROWING)) {
    const fault = narrowingFault(event.data)
    if (fault !== undefined) fail(fault)
    if (opening.narrowed) fail('agent/narrowing: a log records at most one narrowing')
    if (opening.closedBy !== undefined) fail(`agent/narrowing after ${opening.closedBy}: a narrowing is an opening fact of the first lifecycle`)
    opening.narrowed = true
    return
  }
  if (opening.closedBy !== undefined) return
  if (matches(event, TURN_START)) opening.closedBy = 'a turn/start'
  else if (matches(event, SANDBOX_MODE)) opening.closedBy = 'a sandbox/mode stamp'
  else if (matches(event, END_SEED)) opening.closedBy = 'a session/end-seed'
}

const install: InvariantInstaller = (ctx, fail) => {
  const last = new WeakMap<Agent, AgentStatus>()
  ctx.observe((info) => {
    if (info.name === AGENT_STATUS.name) {
      const agent = info.args[0] as Agent
      const status = info.args[1] as AgentStatus
      if (last.get(agent) === status) fail(`agent/status repeated "${status}" (no-op transition)`)
      last.set(agent, status)
      return
    }
    if (info.name !== SESSION_EVENT.name) return
    const event = info.args[1] as EventEnvelope
    // Only a narrowing needs the log behind it, and one is written once per
    // child: folding the prior facts at that append is cheaper than a trace
    // carried on every event of every session.
    if (!matches(event, AGENT_NARROWING)) return
    const session = info.args[0] as Session
    const opening: Opening = { narrowed: false, closedBy: undefined }
    for (const prior of session.facts) {
      if (prior.seq >= event.seq) break
      validate(opening, prior, fail)
    }
    validate(opening, event, fail)
  })
}

/** The narrowing rule over a whole stored log, cold. The first violation, or none. */
export function checkNarrowingLog(events: readonly EventEnvelope[]): LogViolation | undefined {
  const opening: Opening = { narrowed: false, closedBy: undefined }
  return firstViolation(events, (index, fail) => validate(opening, events[index]!, fail))
}

export const agentInvariantPlugin: Plugin = {
  name: 'core-agent-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, 'core-agent', install)
  },
}
