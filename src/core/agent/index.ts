/**
 * The agent seam: the `Agent` interface, the live registry (`ctx.agents`), the
 * inbox, and the whole `agent/*` event vocabulary. This package has NO
 * dependency on the loop, so the driver behind the factory is replaceable.
 */
import { emitEvent, serialEvent, serviceKey, waterfallEvent, type Context, type Disposer, type Plugin } from '../../kernel/index.ts'
import type { SessionId } from '../ids.ts'
import type { Message } from '../llm/types.ts'
import { PERSISTENCE, type StoredSession } from '../persistence/index.ts'
import { foldRequestHeader, repairInterruptedTail, sliceForkSeed, type EventEnvelope, type Session } from '../session/index.ts'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentStatus,
  CancelCause,
  CreateAgentOptions,
  ForkAgentOptions,
  InboxTarget,
  PreStepContext,
  PreStepDecision,
  RequestContext,
  RequestErrorAction,
  RequestErrorContext,
  ResumeAgentOptions,
  TurnStoppingContext,
} from './types.ts'

export * from './types.ts'

// ---- events ---------------------------------------------------------------

export const AGENT_CREATED = emitEvent<[agent: Agent]>('agent/created')
export const AGENT_DISPOSED = emitEvent<[agent: Agent]>('agent/disposed')
export const AGENT_STATUS = emitEvent<[agent: Agent, status: AgentStatus]>('agent/status')
export const AGENT_ERROR = emitEvent<[agent: Agent, error: unknown]>('agent/error')
export const AGENT_INBOX_INSERTED = emitEvent<[agent: Agent, message: Message, target: InboxTarget]>('agent/inbox/inserted')
export const AGENT_INBOX_CLAIMED = emitEvent<[agent: Agent, message: Message]>('agent/inbox/claimed')
export const AGENT_INBOX_DISCARDED = emitEvent<[agent: Agent, message: Message]>('agent/inbox/discarded')

export const AGENT_PRE_STEP = waterfallEvent<[context: PreStepContext], Promise<PreStepDecision>>('agent/pre-step')
export const AGENT_REQUEST = waterfallEvent<[context: RequestContext], Promise<RequestContext['config']>>('agent/request')
export const AGENT_REQUEST_ERROR = waterfallEvent<[context: RequestErrorContext], Promise<RequestErrorAction>>('agent/request-error')
export const AGENT_TURN_STOPPING = serialEvent<[context: TurnStoppingContext]>('agent/turn-stopping')

// ---- inbox ----------------------------------------------------------------

type InboxDispatch = (event: 'inserted' | 'discarded' | 'claimed', message: Message, target?: InboxTarget) => void

/**
 * Two-list message queue. `next-turn` holds prompts (one claimed per turn);
 * `next-step` holds steering (waking) and injected context (quiet), drained
 * wholesale at each step boundary. Live only in S1 (a durable projection
 * arrives with resume in S2).
 */
export class Inbox {
  private readonly turnQueue: Message[] = []
  private readonly stepQueue: { message: Message; waking: boolean }[] = []
  private readonly dispatch: InboxDispatch

  constructor(dispatch: InboxDispatch) {
    this.dispatch = dispatch
  }

  /** There is unconsumed waking work (a queued prompt or a steering message). */
  get hasWakingPending(): boolean {
    return this.turnQueue.length > 0 || this.stepQueue.some((entry) => entry.waking)
  }

  /** There is any next-step input (waking or quiet) to feed a following step. */
  get hasStepPending(): boolean {
    return this.stepQueue.length > 0
  }

  append(message: Message, target: InboxTarget, waking: boolean): void {
    if (target === 'next-turn') this.turnQueue.push(message)
    else this.stepQueue.push({ message, waking })
    this.dispatch('inserted', message, target)
  }

  /** Removes all next-step messages plus, on the first step, one next-turn message. */
  claim(firstStep: boolean): Message[] {
    const claimed = this.stepQueue.splice(0, this.stepQueue.length).map((entry) => entry.message)
    if (firstStep && this.turnQueue.length > 0) claimed.unshift(this.turnQueue.shift()!)
    for (const message of claimed) this.dispatch('claimed', message)
    return claimed
  }

  clear(): void {
    const discarded = [...this.stepQueue.map((entry) => entry.message), ...this.turnQueue]
    this.stepQueue.length = 0
    this.turnQueue.length = 0
    for (const message of discarded) this.dispatch('discarded', message)
  }
}

// ---- registry -------------------------------------------------------------

export interface Agents {
  setFactory(owner: Context, factory: AgentFactory): Disposer
  create(owner: Context, options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Continues a stored session under its own id: load → repair the interrupted
   * tail → seed → the ordinary creation transaction with `origin: 'resumed'`
   * (so persistence attaches append-only). Model config comes from the stored
   * log's folded request/header unless overridden (see `ResumeAgentOptions`).
   * The store's duplicate-id throw is the liveness guard.
   */
  resume(owner: Context, id: SessionId, options?: ResumeAgentOptions): Promise<AgentHandle>
  /**
   * Branches a live `Session` (or a live/stored id) at `boundary` (inclusive)
   * into a new agent whose session header carries `parentId`/`seedLength`.
   * A cold source is crash-repaired before slicing; a live one is taken as-is.
   */
  fork(owner: Context, source: Session | SessionId, boundary?: number, options?: ForkAgentOptions): Promise<AgentHandle>
  register(agent: Agent): Disposer
  get(id: SessionId): Agent | undefined
  list(): Agent[]
}

export const AGENTS = serviceKey<Agents>('agents')

class AgentRegistry implements Agents {
  private readonly agents = new Map<string, Agent>()
  private factory: AgentFactory | undefined
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  setFactory(owner: Context, factory: AgentFactory): Disposer {
    if (this.factory) throw new Error('an agent factory is already registered')
    this.factory = factory
    return owner.effect(() => () => {
      if (this.factory === factory) this.factory = undefined
    }, 'agents.factory')
  }

  create(owner: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    if (!this.factory) throw new Error('no agent factory is registered')
    return this.factory.create(owner, options)
  }

  async resume(owner: Context, id: SessionId, options: ResumeAgentOptions = {}): Promise<AgentHandle> {
    const stored = this.loadStored(id)
    const closers = repairInterruptedTail(stored.events)
    const seed = closers.length === 0 ? stored.events : [...stored.events, ...closers]
    return this.create(owner, {
      cwd: stored.header.cwd,
      sessionId: stored.header.id,
      seed,
      origin: 'resumed',
      createdAt: stored.header.createdAt,
      ...(stored.header.parentId === undefined ? {} : { parentId: stored.header.parentId }),
      ...(stored.header.seedLength === undefined ? {} : { seedLength: stored.header.seedLength }),
      agentOptions: resolveSeedAgentOptions(seed, options, `session "${id}"`),
      ...(options.setup === undefined ? {} : { setup: options.setup }),
    })
  }

  async fork(owner: Context, source: Session | SessionId, boundary?: number, options: ForkAgentOptions = {}): Promise<AgentHandle> {
    const src = this.forkSource(source)
    const seed = sliceForkSeed(src.events, boundary)
    return this.create(owner, {
      cwd: src.cwd,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      seed,
      parentId: src.parentId,
      seedLength: seed.length,
      agentOptions: resolveSeedAgentOptions(seed, options, `fork of "${src.parentId}"`),
      ...(options.setup === undefined ? {} : { setup: options.setup }),
    })
  }

  private loadStored(id: SessionId): StoredSession {
    // A call-time optional read: persistence is a capability, not a lifecycle
    // dependency of the registry; without a provider these entry points fail
    // clean while everything else keeps working.
    const persistence = this.ctx.tryGet(PERSISTENCE)
    if (!persistence) throw new Error('continuing a stored session requires a persistence provider')
    const stored = persistence.load(id)
    if (!stored) throw new Error(`no stored session "${id}"`)
    if (stored.damaged) throw new Error(`session "${id}": the stored log is damaged; refusing to continue it`)
    return stored
  }

  private forkSource(source: Session | SessionId): { events: readonly EventEnvelope[]; cwd: string; parentId: SessionId } {
    if (typeof source !== 'string') {
      return { events: source.events, cwd: source.header.cwd, parentId: source.id }
    }
    const live = this.agents.get(source)
    if (live) return { events: live.session.events, cwd: live.session.header.cwd, parentId: live.session.id }
    const stored = this.loadStored(source)
    const closers = repairInterruptedTail(stored.events)
    return {
      events: closers.length === 0 ? stored.events : [...stored.events, ...closers],
      cwd: stored.header.cwd,
      parentId: stored.header.id,
    }
  }

  /** Publishes an agent (emits agent/created). The disposer detaches and emits agent/disposed. */
  register(agent: Agent): Disposer {
    if (this.agents.has(agent.id)) throw new Error(`agent "${agent.id}" is already registered`)
    this.agents.set(agent.id, agent)
    this.ctx.emit(AGENT_CREATED, agent)
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      if (this.agents.get(agent.id) === agent) this.agents.delete(agent.id)
      this.ctx.emit(AGENT_DISPOSED, agent)
    }
  }

  get(id: SessionId): Agent | undefined {
    return this.agents.get(id)
  }

  list(): Agent[] {
    return [...this.agents.values()]
  }
}

/**
 * Model config for an agent continuing over a seed: explicit overrides > the
 * seed's folded `request/header` > surface defaults. Undefined override values
 * never clobber a folded fact.
 */
function resolveSeedAgentOptions(seed: readonly EventEnvelope[], options: ResumeAgentOptions, what: string): AgentOptions {
  const header = foldRequestHeader(seed)
  const merged: Record<string, unknown> = { ...options.defaults }
  if (header) {
    merged.provider = header.provider
    merged.model = header.model
    if (header.reasoningEffort !== undefined) merged.reasoningEffort = header.reasoningEffort
    if (header.maxTokens !== undefined) merged.maxTokens = header.maxTokens
    if (header.temperature !== undefined) merged.temperature = header.temperature
  }
  for (const [key, value] of Object.entries(options.agentOptions ?? {})) {
    if (value !== undefined) merged[key] = value
  }
  if (typeof merged.provider !== 'string' || typeof merged.model !== 'string') {
    throw new Error(`${what}: no stored request/header to derive the model from; pass agentOptions`)
  }
  return merged as unknown as AgentOptions
}

/** The agent registry plugin: provides `ctx.agents`. The loop registers the factory. */
export const agentPlugin: Plugin = {
  name: 'core-agent',
  apply(ctx) {
    ctx.provide(AGENTS, new AgentRegistry(ctx))
  },
}

export type { CancelCause }
