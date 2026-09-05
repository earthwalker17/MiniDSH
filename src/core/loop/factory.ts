import type { Context, Disposer, Plugin } from '../../kernel/index.ts'
import { AGENT_OPTIONS, AGENTS, foldAgentOptions, sameAgentOptions, type AgentFactory, type AgentHandle, type CreateAgentOptions } from '../agent/index.ts'
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
    if (options.signal?.aborted) throw new Error('agent creation aborted before it began')
    const sessions = this.ctx.get(SESSIONS)
    const agents = this.ctx.get(AGENTS)
    // Unpublished: session publication follows agent publication, so a rolled-
    // back creation is never announced and persistence never hears of it.
    const session = sessions.create({
      cwd: options.cwd,
      publish: false,
      ...(options.sessionId === undefined ? {} : { id: options.sessionId }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      ...(options.seedLength === undefined ? {} : { seedLength: options.seedLength }),
      ...(options.delegatedBy === undefined ? {} : { delegatedBy: options.delegatedBy }),
      ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    const agent = new ReactLoopAgent(session, options.agentOptions, options.world)
    // The scope resolves services through the loop context and is keyed by the agent itself.
    const scope = this.ctx.child({ scope: agent, label: `agent:${session.id}` })
    agent.attach(scope)
    // The base route is an opening fact, like the authority knobs: written
    // before publication iff the seed does not already say it. A log from
    // before the record existed gets one at pickup (`initial`); an override at
    // resume is a `resume`; a fork born with overrides changed at its birth.
    const folded = foldAgentOptions(session.facts)
    if (!folded || !sameAgentOptions(folded, agent.options)) {
      session.append(AGENT_OPTIONS, { options: agent.options, reason: !folded ? 'initial' : session.origin === 'resumed' ? 'resume' : 'change' })
    }

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
      // The inheritable world first, then what this agent alone needs: a
      // delegated child composes its parent's world and only then narrows it,
      // and a stamp written by the narrowing must land after whatever the world
      // put in the scope. Each is a rollback point of its own.
      if (options.world) await options.world(scope, agent)
      if (options.signal?.aborted) throw new Error(`agent ${session.id}: creation aborted during setup`)
      if (options.setup) await options.setup(scope, agent)
      // Publication is atomic: what setup mounted is active (or creation fails) before the agent is visible.
      const report = await scope.settle((plugin) => plugin.scope === agent)
      // A creator that gave up during setup gets a rollback, not a published agent it no longer wants.
      if (options.signal?.aborted) throw new Error(`agent ${session.id}: creation aborted during setup`)
      if (report.pending.length > 0 || report.failed.length > 0) {
        const pending = report.pending.map((entry) => `${entry.name} (needs ${entry.missing.join(', ') || 'nothing'})`).join('; ')
        const failed = report.failed.map((entry) => `${entry.name}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`).join('; ')
        throw new Error(`agent ${session.id}: setup did not settle — pending: [${pending}] failed: [${failed}]`, { cause: report.failed[0]?.error })
      }
      lifetime.detach = agents.register(agent)
      // Session publication follows agent publication: a session/created listener
      // can already resolve the owning agent by id.
      sessions.publish(session)
      // Publication effects run in a contained emit, so a persistence provider's
      // refusal (a held write lease, a damaged or mismatched stored log) cannot
      // throw through it. For a RESUME that refusal must reach the caller BEFORE
      // any paid work, not at the first turn-end flush — so surface it here,
      // inside the transaction, where it rolls the creation back unannounced.
      if (session.origin === 'resumed') {
        try {
          await sessions.flush(session)
        } catch (error) {
          throw error instanceof AggregateError && error.errors.length === 1 ? error.errors[0] : error
        }
      }
      // Whichever dies first — the loop plugin that owns the scope, or the creator — disposes the whole agent.
      lifetime.releases.push(this.ctx.effect(() => () => dispose(), `agent-lifetime(${session.id})`))
      lifetime.releases.push(owner.effect(() => () => dispose(), `agent(${session.id})`))
    } catch (error) {
      await dispose()
      throw error
    }
    // A restored inbox may already owe work (a followup queued before a crash);
    // only after publication may the first turn begin — and only for a RESUMED
    // session: a fork is a passive branch, and creating it must not start a
    // paid turn (the restored queue still enters that fork's next real turn).
    if (session.origin === 'resumed') agent.wakeIfPending()
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
