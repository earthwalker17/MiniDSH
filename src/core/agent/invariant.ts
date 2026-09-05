import type { Plugin } from '../../kernel/index.ts'
import { INVARIANTS, type InvariantInstaller } from '../invariants/index.ts'
import { AGENT_STATUS } from './events.ts'
import type { Agent, AgentStatus } from './types.ts'

/** `agent/status` never repeats a value — a no-op transition signals a driver bug. */
const install: InvariantInstaller = (ctx, fail) => {
  const last = new WeakMap<Agent, AgentStatus>()
  ctx.observe((info) => {
    if (info.name !== AGENT_STATUS.name) return
    const agent = info.args[0] as Agent
    const status = info.args[1] as AgentStatus
    if (last.get(agent) === status) fail(`agent/status repeated "${status}" (no-op transition)`)
    last.set(agent, status)
  })
}

export const agentInvariantPlugin: Plugin = {
  name: 'core-agent-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, 'core-agent', install)
  },
}
