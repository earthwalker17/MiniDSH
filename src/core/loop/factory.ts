import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENTS, type AgentFactory, type AgentHandle, type CreateAgentOptions } from '../agent/index.ts'
import { LLM } from '../llm/index.ts'
import { PROMPT } from '../prompt/index.ts'
import { SESSIONS } from '../session/index.ts'
import { TOOLS } from '../tools/index.ts'
import { ReactLoopAgent } from './driver.ts'

class LoopFactory implements AgentFactory {
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async create(_owner: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const sessions = this.ctx.get(SESSIONS)
    const agents = this.ctx.get(AGENTS)
    const session = sessions.create({
      cwd: options.cwd,
      ...(options.sessionId === undefined ? {} : { id: options.sessionId }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    })
    const agent = new ReactLoopAgent(session, options.agentOptions)
    // The scope resolves services through the loop context and is keyed by the agent itself.
    const scope = this.ctx.child({ scope: agent, label: `agent:${session.id}` })
    agent.attach(scope)
    if (options.setup) await options.setup(scope)
    const detach = agents.register(agent)

    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      agent.cancel({ kind: 'disposed' })
      await agent.whenIdle()
      await detach()
      await scope.dispose()
      await sessions.detach(session)
    }
    return { agent, dispose }
  }
}

/** The one concrete loop plugin. Extension code depends on `dsh-agent` events, never on this. */
export const loopPlugin: Plugin = {
  name: 'core-agent-loop',
  inject: [AGENTS, SESSIONS, LLM, TOOLS, PROMPT],
  apply(ctx) {
    ctx.get(AGENTS).setFactory(ctx, new LoopFactory(ctx))
  },
}
