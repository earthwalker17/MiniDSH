import type { Context } from '../../kernel/index.ts'
import type { SessionId } from '../ids.ts'
import type { Message } from '../llm/types.ts'
import type { Session } from '../session/index.ts'

export type AgentStatus = 'idle' | 'running'
export type InboxTarget = 'next-turn' | 'next-step'

export type CancelCause = { readonly kind: 'user' } | { readonly kind: 'parent' } | { readonly kind: 'disposed' } | { readonly kind: 'hook'; readonly reason: string }

export interface CancelOptions {
  /**
   * Abort the running turn without touching the durable queue. A cancel from
   * one of several attached clients must not throw away work another client
   * queued; a graceful teardown keeps the queue for the same reason, and a
   * lone user's cancel still means "and forget what I asked for".
   */
  readonly keepInbox?: boolean
}

/** The model config an agent starts from, before per-request interception. */
export interface CallConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly temperature?: number
}

export interface AgentOptions extends CallConfig {
  readonly maxSteps?: number
}

/** Why an `agent/options` record was written: the opening base, a durable switch, or an override at resume. */
export type AgentOptionsReason = 'initial' | 'change' | 'resume'

/** The live agent handle. `id` equals the session id. */
export interface Agent {
  readonly id: SessionId
  readonly session: Session
  readonly status: AgentStatus
  /** The agent's scoped context: registrations here are visible to and live with this agent alone. */
  readonly ctx: Context
  /**
   * The BASE route and limits this agent runs from — the fold of `agent/options`.
   * A per-request rewrite on `agent/request` (a role) never changes it, which
   * is what lets a resume rebuild from the base rather than from the last
   * rewrite the log happened to record.
   */
  readonly options: AgentOptions
  /**
   * The durable switch: merges `options` over the base, appends
   * `agent/options{reason: 'change'}` iff something actually changed, and
   * takes effect at the next step. Undefined values never clobber; a route
   * change drops an effort the switch did not name (effort ids are adapter-owned).
   */
  configure(options: Partial<AgentOptions>): AgentOptions
  /**
   * The composer of this agent's world — the INHERITABLE half of what it was
   * created with, so a creator of a child can compose the SAME world into the
   * child's scope before adding what the child alone needs (DSH's
   * `composeFrom`). Deliberately not `setup`: a delegated child's `setup` is
   * the narrowing closure that stamped its authority, and a grandchild
   * composing THAT would re-open a ceiling that is already open.
   */
  readonly world: CreateAgentOptions['world']
  /** Low-level delivery; `followup`/`steer`/`inject` are the presets. */
  send(message: Message, target: InboxTarget, wakeup: boolean): void
  followup(message: Message): void
  steer(message: Message): void
  inject(message: Message): void
  cancel(cause: CancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
}

export interface AgentHandle {
  readonly agent: Agent
  dispose(): Promise<void>
}

export interface CreateAgentOptions {
  readonly cwd: string
  readonly sessionId?: SessionId
  readonly agentOptions: AgentOptions
  readonly seed?: readonly import('../session/index.ts').EventEnvelope[]
  /** Session provenance, forwarded verbatim to the session header / live origin. */
  readonly origin?: import('../session/index.ts').SessionOrigin
  readonly parentId?: SessionId
  readonly seedLength?: number
  /** Delegation lineage, recorded in the header (see `SessionHeader`). */
  readonly delegatedBy?: SessionId
  readonly delegationDepth?: number
  /** The preset name the world was composed from, recorded in the header. */
  readonly agentPreset?: string
  readonly createdAt?: number
  /**
   * A creation that is cancelled before it publishes rolls back unannounced:
   * a delegating tool call aborted mid-setup leaves no agent, no session file.
   */
  readonly signal?: AbortSignal
  /**
   * The INHERITABLE composer of this agent's world: the deployment's named
   * agent preset, the surface's per-agent rows — whatever a child of this
   * agent should also be composed from. Stored as `Agent.world` and run FIRST,
   * before `setup`.
   *
   * It is a separate slot from `setup` rather than a default for it, because
   * the difference is not stylistic: a delegated child is created with its
   * parent's `world` and its OWN narrowing `setup`, and a grandchild must
   * inherit the first and never the second. Collapsing them into one field —
   * or defaulting `world` to `setup` — is how a grandchild ends up re-running
   * its parent's authority stamps one generation late.
   */
  readonly world?: (agentCtx: Context, agent: Agent) => void | Promise<void>
  /**
   * Composes what THIS agent alone needs, before publication and after
   * `world`: registrations and plugins mounted through `agentCtx` are visible
   * to this agent alone and unwind with it. Never inherited by a child.
   * Creation fails (and rolls back) if it throws or a mounted plugin cannot
   * activate. Services are read by the plugins mounted here (which declare
   * `inject`) or via `tryGet`; `agentCtx.get` is limited to what the loop
   * itself injects.
   *
   * `agent` is the UNPUBLISHED agent (it is also `agentCtx.scope`): its
   * session is appendable here, which is how a creator seeds durable facts a
   * fresh session must open with — the slot a delegation seam stamps a child's
   * authority into before its first effect.
   */
  readonly setup?: (agentCtx: Context, agent: Agent) => void | Promise<void>
}

export interface AgentFactory {
  /** Creates and publishes an agent whose lifetime is bound to `owner`: disposing the owner disposes the agent. */
  create(owner: Context, options: CreateAgentOptions): Promise<AgentHandle>
}

/**
 * Options for continuing a stored session (`agents.resume` / `agents.fork`).
 * Model config precedence: explicit `agentOptions` overrides > the seed's own
 * folded `request/header` (the log is its own config authority) > `defaults`
 * (a surface's default model, used only when the log recorded no request).
 */
export interface ResumeAgentOptions {
  readonly agentOptions?: Partial<AgentOptions>
  readonly defaults?: AgentOptions
  /** The continued lifecycle's world — inheritable, exactly as at creation. */
  readonly world?: CreateAgentOptions['world']
}

export interface ForkAgentOptions extends ResumeAgentOptions {
  /** Explicit child session id; minted otherwise. */
  readonly sessionId?: SessionId
}

// ---- pre-step / request interception --------------------------------------

export interface PreStepContext {
  readonly agent: Agent
  readonly messages: readonly Message[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export type PreStepDecision = { readonly kind: 'reject' } | { readonly kind: 'enter'; readonly messages: readonly Message[] }

/**
 * The `agent/request` waterfall's subject: the base config a call starts from,
 * which a listener may rewrite. A loop step carries its position; a call that
 * is NOT a step (a compaction summary, a delegated child's route) carries a
 * `purpose` instead — the one discriminator a role routes on, and a field the
 * provider never sees.
 */
export interface RequestContext {
  readonly agent: Agent
  readonly turn?: number
  readonly step?: number
  readonly config: CallConfig
  readonly signal?: AbortSignal
  readonly purpose?: string
}

export interface RequestErrorContext {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: import('../llm/types.ts').LlmFailure
  readonly signal: AbortSignal
}

export type RequestErrorAction = { readonly kind: 'retry' } | undefined

export interface TurnStoppingContext {
  readonly agent: Agent
  readonly turn: number
  readonly signal: AbortSignal
}
