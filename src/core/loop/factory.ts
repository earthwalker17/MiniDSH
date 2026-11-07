import { z } from 'zod'
import type { Context, Disposer, Plugin } from '../../kernel/index.ts'
import {
  AGENT_NARROWING,
  AGENT_OPTIONS,
  AGENTS,
  foldAgentOptions,
  foldNarrowing,
  sameAgentOptions,
  type AgentFactory,
  type AgentHandle,
  type AgentNarrowing,
  type CreateAgentOptions,
} from '../agent/index.ts'
import { LLM } from '../llm/index.ts'
import { PERSISTENCE } from '../persistence/index.ts'
import { PROMPT } from '../prompt/index.ts'
import { SESSION_LIFECYCLE, SESSIONS } from '../session/index.ts'
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
  private readonly ownedWorkBoundMs: number
  constructor(ctx: Context, config: LoopConfig) {
    this.ctx = ctx
    this.ownedWorkBoundMs = config.ownedWorkBoundMs ?? DEFAULT_OWNED_WORK_BOUND_MS
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
      ...(options.delegatedByCallId === undefined ? {} : { delegatedByCallId: options.delegatedByCallId }),
      ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    // The lifecycle's first fact, before anything it governs: what THIS driver
    // and the mounted store guarantee about what follows, so a reader that is
    // not this process can tell what an absent fact proves (§4). `dispatch`
    // is this driver's own claim (`executeTools` writes `tool/dispatch`
    // through `onDispatch`, durable before every body); `durability` is only
    // ever what the provider DECLARED.
    const durability = this.ctx.tryGet(PERSISTENCE)?.durability
    // The transaction starts at the session, not at the `try` below: the first
    // live append is where every invariant folds the seed, and a refusal there
    // (or a malformed stored inbox at `attach`) left the unpublished session
    // registered, so the same host's retry said "already exists" instead of
    // the real reason (S20.5 review).
    let agent: ReactLoopAgent | undefined
    let scope: Context | undefined
    let narrowing: AgentNarrowing | undefined
    try {
      session.append(SESSION_LIFECYCLE, {
        origin: session.origin,
        dispatch: true,
        ...(durability === undefined ? {} : { durability }),
        ...(options.salvage === undefined ? {} : { salvage: options.salvage }),
      })
      agent = new ReactLoopAgent(session, options.agentOptions, options.world)
      // The scope resolves services through the loop context and is keyed by the agent itself.
      scope = this.ctx.child({ scope: agent, label: `agent:${session.id}` })
      agent.attach(scope)
      // The base route is an opening fact, like the authority knobs: written
      // before publication iff the seed does not already say it. A log from
      // before the record existed gets one at pickup (`initial`); an override at
      // resume is a `resume`; a fork born with overrides changed at its birth.
      const folded = foldAgentOptions(session.facts)
      if (!folded || !sameAgentOptions(folded, agent.options)) {
        session.append(AGENT_OPTIONS, { options: agent.options, reason: !folded ? 'initial' : session.origin === 'resumed' ? 'resume' : 'change' })
      }
      // The narrowing is an opening fact of the agent, like its base, but it
      // is only ever WRITTEN for a fresh agent: a continuation's record is
      // its narrowing (§4). Folded before anything composes, so a record this
      // reader cannot believe refuses the continuation here (`foldNarrowing`)
      // instead of letting it compose wider than the log says.
      const recorded = foldNarrowing(session.facts)
      if (options.narrowing !== undefined) {
        if (recorded !== undefined) throw new Error(`agent ${session.id}: its log already records a narrowing, which a continuation re-applies; it takes no new one`)
        session.append(AGENT_NARROWING, canonicalNarrowing(options.narrowing))
      }
      narrowing = recorded ?? foldNarrowing(session.facts)
    } catch (error) {
      await scope?.dispose()
      await sessions.detach(session)
      throw error
    }

    // One disposal, run at most once, shared by every path that can end the agent:
    // an explicit handle.dispose(), the creator's unwind, the loop plugin's unwind
    // (which owns the scope), and creation rollback.
    const lifetime: { detach?: Disposer; releases: Disposer[]; task?: Promise<void> } = { releases: [] }
    const run = async (): Promise<void> => {
      agent.cancel({ kind: 'disposed' })
      await agent.whenIdle()
      // Work the agent owns outside a turn (`Agent.own`): the cancel above
      // aborted its signal, and it gets to record how it ended while the scope
      // is whole and the session still takes appends — the end recorded
      // before the detach. Bounded: the cancel is cooperative.
      if (!(await agent.settleOwned(this.ownedWorkBoundMs))) {
        this.ctx.logger.warn(`agent ${session.id}: work it owned outside a turn did not stop within ${this.ownedWorkBoundMs} ms of its disposal; disposing anyway`)
      }
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
      // The inheritable world first, then the recorded narrowing, then what a
      // fresh agent alone needs (`setup`: a child's authority stamps), each a
      // rollback point of its own; a continuer's own switches come only after
      // publication (`opening`, below).
      if (options.world) await options.world(scope, agent)
      // The recorded narrowing, on EVERY lifecycle — the one place a create, a
      // resume and a fork all pass through, so no resumer has to know a child
      // was narrowed, let alone reconstruct how (BLUEPRINT §1 refused a
      // resume-time `setup` for exactly that). After the world, because it
      // narrows the world; after the world has SETTLED, because a preset
      // world mounts plugins that activate asynchronously, and what they
      // claimed decides how a section composes. Before `setup`, which a fresh
      // child still uses for its authority stamps.
      if (narrowing !== undefined) {
        await scope.settle((plugin) => plugin.scope === agent)
        this.applyNarrowing(scope, narrowing)
      }
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
      // inside the transaction, where it rolls the creation back. Not
      // unannounced: the lease is taken AT publication, so by now
      // `agent/created` and `session/created` were heard, and the rollback's
      // disposals withdraw them (S20.5 review).
      if (session.origin === 'resumed') {
        try {
          await sessions.flush(session)
        } catch (error) {
          throw error instanceof AggregateError && error.errors.length === 1 ? error.errors[0] : error
        }
      }
      // The continuer's own durable switches (`ResumeAgentOptions.opening`):
      // AFTER publication, so the services' own opening stamps for this
      // lifecycle land first and a switch note finds its agent registered —
      // before publication a resume's `--sandbox` reached the log but not the
      // model (S21.1 review) — and BEFORE any restored prompt may wake, so no
      // turn starts ahead of them. A refusal is the rollback below: nothing
      // woke, so nothing was claimed, and the disposal's non-durable clear
      // leaves the restored prompt owed.
      if (options.opening) await options.opening(agent)
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

  /**
   * Installs a narrowing in the agent's scope. Its restrictions reach the
   * scope's OWN registrations (`includeOwn`): a preset world composes its rows
   * into this very scope, and a narrowing that exempted them would hide a
   * global network tool while leaving the preset's own in view.
   *
   * A section shadows the world's same-named GLOBAL (how a child's persona
   * replaces the deployment's). Where the world claimed that name in this
   * scope itself — a preset with a persona of its own — shadowing is not
   * expressible, so the section composes just AHEAD of the claimed one under
   * its own key, and the agent reads both, the narrowing first.
   */
  private applyNarrowing(scope: Context, narrowing: AgentNarrowing): void {
    const tools = this.ctx.get(TOOLS)
    const prompt = this.ctx.get(PROMPT)
    for (const restriction of narrowing.tools ?? []) tools.restrict(scope, restriction, { includeOwn: true })
    for (const section of narrowing.sections ?? []) {
      const claimed = prompt.sectionIn(scope, section.name)
      prompt.section(scope, claimed === undefined ? section : { name: `narrowing:${section.name}`, order: claimed.order - 0.5, text: section.text })
    }
  }
}

/** Canonical form for the log: absent rather than empty, every list copied, nothing a caller can mutate later. */
function canonicalNarrowing(narrowing: AgentNarrowing): AgentNarrowing {
  const terms = ['allow', 'deny', 'allowTags', 'denyTags'] as const
  const tools = (narrowing.tools ?? []).map((restriction) => {
    const out: Record<string, readonly string[]> = {}
    for (const term of terms) if (restriction[term] !== undefined) out[term] = [...restriction[term]]
    return out
  })
  const sections = (narrowing.sections ?? []).map((section) => ({ name: section.name, order: section.order, text: section.text }))
  return { ...(tools.length === 0 ? {} : { tools }), ...(sections.length === 0 ? {} : { sections }) }
}

export interface LoopConfig {
  /**
   * How long an agent's disposal waits for the work it owns outside a turn
   * (`Agent.own`) once that work's signal has aborted (default 10 s). A
   * bound, not a budget: cooperative work ends in milliseconds, and a host
   * shutting down disposes its agents one by one.
   */
  readonly ownedWorkBoundMs?: number | undefined
}

const DEFAULT_OWNED_WORK_BOUND_MS = 10_000

const configSchema = z.strictObject({ ownedWorkBoundMs: z.number().int().positive().optional() }).optional()

/** The one concrete loop plugin. Extension code depends on `dsh-agent` events, never on this. */
export const loopPlugin: Plugin<LoopConfig | undefined> = {
  name: 'core-agent-loop',
  inject: [AGENTS, SESSIONS, LLM, TOOLS, PROMPT],
  config: configSchema,
  apply(ctx, config) {
    ctx.get(AGENTS).setFactory(ctx, new LoopFactory(ctx, config ?? {}))
  },
}
