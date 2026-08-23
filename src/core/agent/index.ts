/**
 * The agent seam: the `Agent` interface, the live registry (`ctx.agents`), the
 * inbox, and the whole `agent/*` event vocabulary. This package has NO
 * dependency on the loop, so the driver behind the factory is replaceable.
 */
import { emitEvent, serialEvent, serviceKey, waterfallEvent, type Context, type Disposer, type Plugin } from '../../kernel/index.ts'
import type { SessionId } from '../ids.ts'
import { restoreMessage } from '../llm/message.ts'
import type { Message } from '../llm/types.ts'
import { PERSISTENCE, type StoredSession } from '../persistence/index.ts'
import {
  eventKind,
  foldRequestHeader,
  matches,
  repairInterruptedTail,
  sliceForkSeed,
  type EventEnvelope,
  type Session,
} from '../session/index.ts'
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
 * The durable inbox record: op-shaped mutations, not positional splices —
 * `claim` drains counts from the FRONT, which keeps the fold correct even for
 * the one real reorder (an insert landing during the pre-step await is logged
 * before the deferred claim record but appends to the back either way).
 */
export type InboxSplice =
  | { readonly op: 'insert'; readonly queue: InboxTarget; readonly message: Message; readonly waking?: boolean }
  | { readonly op: 'claim'; readonly steps: number; readonly turns: number }
  | { readonly op: 'clear' }

/** Log-only; a resumed session folds these to reconstruct its pending input. */
export const INBOX_SPLICED = eventKind<InboxSplice>('inbox/spliced')

type InboxRecord = (splice: InboxSplice) => void

export interface InboxState {
  readonly turnQueue: Message[]
  readonly stepQueue: { message: Message; waking: boolean }[]
}

/** Reconstructs the pending inbox from a session log's `inbox/spliced` records. */
export function foldInbox(events: readonly EventEnvelope[]): InboxState {
  const turnQueue: Message[] = []
  const stepQueue: { message: Message; waking: boolean }[] = []
  for (const event of events) {
    if (!matches(event, INBOX_SPLICED)) continue
    const splice = event.data
    if (splice.op === 'insert') {
      const message = restoreMessage(splice.message as Parameters<typeof restoreMessage>[0])
      if (splice.queue === 'next-turn') turnQueue.push(message)
      else stepQueue.push({ message, waking: splice.waking === true })
    } else if (splice.op === 'claim') {
      stepQueue.splice(0, splice.steps)
      turnQueue.splice(0, splice.turns)
    } else {
      turnQueue.length = 0
      stepQueue.length = 0
    }
  }
  return { turnQueue, stepQueue }
}

/**
 * Two-list message queue. `next-turn` holds prompts (one claimed per turn);
 * `next-step` holds steering (waking) and injected context (quiet), drained
 * wholesale at each step boundary. Mutations are durable via `record`: inserts
 * and clears at mutation time; a claim's record is RETURNED for the driver to
 * log after the entered `user/message`s (so a crash in the pre-step await
 * re-delivers a prompt rather than losing it).
 */
export class Inbox {
  private readonly turnQueue: Message[] = []
  private readonly stepQueue: { message: Message; waking: boolean }[] = []
  private readonly dispatch: InboxDispatch
  private readonly record: InboxRecord

  constructor(dispatch: InboxDispatch, record: InboxRecord = () => {}) {
    this.dispatch = dispatch
    this.record = record
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
    this.record({ op: 'insert', queue: target, message, ...(target === 'next-step' ? { waking } : {}) })
    this.dispatch('inserted', message, target)
  }

  /** Removes all next-step messages plus, on the first step, one next-turn message. */
  claim(firstStep: boolean): { messages: Message[]; splice?: InboxSplice } {
    const steps = this.stepQueue.length
    const claimed = this.stepQueue.splice(0, steps).map((entry) => entry.message)
    let turns = 0
    if (firstStep && this.turnQueue.length > 0) {
      claimed.unshift(this.turnQueue.shift()!)
      turns = 1
    }
    for (const message of claimed) this.dispatch('claimed', message)
    return { messages: claimed, ...(steps + turns > 0 ? { splice: { op: 'claim', steps, turns } as const } : {}) }
  }

  /**
   * Drops everything. `durable: false` (graceful teardown) keeps the log's
   * queue intact so the next resume still sees it; an empty clear records
   * nothing either way.
   */
  clear(durable: boolean): void {
    const discarded = [...this.stepQueue.map((entry) => entry.message), ...this.turnQueue]
    this.stepQueue.length = 0
    this.turnQueue.length = 0
    if (durable && discarded.length > 0) this.record({ op: 'clear' })
    for (const message of discarded) this.dispatch('discarded', message)
  }

  /** Restores a folded durable state (resume): no dispatch, no re-record. */
  restore(state: InboxState): void {
    this.turnQueue.push(...state.turnQueue)
    this.stepQueue.push(...state.stepQueue)
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
    // The header is the whole model-config authority: an optional it omits was
    // genuinely absent, so a default must not resurrect it. Only `maxSteps`
    // survives from defaults — it is deliberately not model-visible.
    merged.provider = header.provider
    merged.model = header.model
    for (const key of ['reasoningEffort', 'maxTokens', 'temperature'] as const) {
      if (header[key] !== undefined) merged[key] = header[key]
      else delete merged[key]
    }
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
