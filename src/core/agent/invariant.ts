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
 * only the creator does (`core/loop/factory.ts`). The rule itself is
 * `narrowingStep` (`./events.ts`), which `foldNarrowing` applies too: a seed
 * that breaks it refuses its continuation at the factory, so this observer
 * holds only the LIVE appends.
 */
import type { Plugin } from '../../kernel/index.ts'
import { firstViolation, INVARIANTS, type InvariantFailure, type InvariantInstaller, type LogViolation } from '../invariants/index.ts'
import { matches, SESSION_EVENT, type EventEnvelope, type Session } from '../session/index.ts'
import { AGENT_NARROWING, AGENT_STATUS, narrowingStep, type NarrowingOpening } from './events.ts'
import type { Agent, AgentStatus } from './types.ts'

function validate(opening: NarrowingOpening, event: EventEnvelope, fail: InvariantFailure): void {
  const violation = narrowingStep(opening, event)
  if (violation !== undefined) fail(violation)
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
    const opening: NarrowingOpening = {}
    for (const prior of session.facts) {
      if (prior.seq >= event.seq) break
      validate(opening, prior, fail)
    }
    validate(opening, event, fail)
  })
}

/** The narrowing rule over a whole stored log, cold. The first violation, or none. */
export function checkNarrowingLog(events: readonly EventEnvelope[]): LogViolation | undefined {
  const opening: NarrowingOpening = {}
  return firstViolation(events, (index, fail) => validate(opening, events[index]!, fail))
}

export const agentInvariantPlugin: Plugin = {
  name: 'core-agent-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, 'core-agent', install)
  },
}
