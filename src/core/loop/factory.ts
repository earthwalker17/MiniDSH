import type { Context, Disposer, Plugin } from '../../kernel/index.ts'
import { AGENTS, type AgentFactory, type AgentHandle, type CreateAgentOptions } from '../agent/index.ts'
import { LLM } from '../llm/index.ts'
import { PROMPT } from '../prompt/index.ts'
import { SESSIONS } from '../session/index.ts'
import { TOOLS } from '../tools/index.ts'
import { ReactLoopAgent } from './driver.ts'

/**
 * Agent creation is a transaction: session, scope, agent and setup are built
 * unpublished; everything mounted during setup must be active before the
 * agent is registered, and any failure rolls the partial world back. The
 * agent's lifetime is bound to the creating `owner` context.
 */
class LoopFactory implements AgentFactory {
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async create(owner: Context, options: CreateAgentOptions): Promise<AgentHandle> {
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

    // One disposal, run at most once, shared by every path that can end the agent:
    // an explicit handle.dispose(), the creator's unwind, the loop plugin's unwind
    // (which owns the scope), and creation rollback.
    const lifetime: { detach?: Disposer; releases: Disposer[]; task?: Promise<void> } = { releases: [] }
    const run = async (): Promise<void> => {
      agent.cancel({ kind: 'disposed' })
      await agent.whenIdle()
      await scope.dispose()
      await lifetime.detach?.()
      await sessions.detach(session)
      // Drop the lifetime records on the loop and the owner. Each re-enters dispose(),
      // which returns this very task, so they are released without being awaited.
      const releases = lifetime.releases
      lifetime.releases = []
      for (const release of releases) void release().catch(() => undefined)
    }
    const dispose = (): Promise<void> => (lifetime.task ??= run())

    try {
      if (options.setup) await options.setup(scope)
      // Publication is atomic: what setup mounted is active (or creation fails) before the agent is visible.
      const report = await scope.settle((plugin) => plugin.scope === agent)
      if (report.pending.length > 0 || report.failed.length > 0) {
        const pending = report.pending.map((entry) => `${entry.name} (needs ${entry.missing.join(', ') || 'nothing'})`).join('; ')
        const failed = report.failed.map((entry) => entry.name).join('; ')
        throw new Error(`agent ${session.id}: setup did not settle — pending: [${pending}] failed: [${failed}]`, { cause: report.failed[0]?.error })
      }
      lifetime.detach = agents.register(agent)
      // Whichever dies first — the loop plugin that owns the scope, or the creator — disposes the whole agent.
      lifetime.releases.push(this.ctx.effect(() => () => dispose(), `agent-lifetime(${session.id})`))
      lifetime.releases.push(owner.effect(() => () => dispose(), `agent(${session.id})`))
    } catch (error) {
      await dispose()
      throw error
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
