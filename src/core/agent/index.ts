/**
 * The agent seam: the `Agent` interface, the live registry (`ctx.agents`), the
 * inbox, and the whole `agent/*` event vocabulary. This package has NO
 * dependency on the loop, so the driver behind the factory is replaceable.
 */
import { serviceKey, type Context, type Disposer, type Plugin } from '../../kernel/index.ts'
import type { SessionId } from '../ids.ts'
import { restoreMessage } from '../llm/message.ts'
import type { Message } from '../llm/types.ts'
import { delegationPin } from '../approval/events.ts'
import { PERSISTENCE, type StoredSession } from '../persistence/index.ts'
import { delegationCeiling } from '../sandbox/events.ts'
import {
  eventKind,
  foldRequestHeader,
  matches,
  repairInterruptedTail,
  sliceForkSeed,
  type EventEnvelope,
  type Session,
  type SessionHeader,
} from '../session/index.ts'
import { AGENT_CREATED, AGENT_DISPOSED, AGENT_REQUEST, foldAgentOptions } from './events.ts'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  CallConfig,
  CancelCause,
  CreateAgentOptions,
  ForkAgentOptions,
  InboxTarget,
  RequestContext,
  ResumeAgentOptions,
} from './types.ts'

export * from './types.ts'
// The vocabulary lives below the service (`events.ts`), like the sandbox and
// approval vocabularies, so a core service can name an agent event without
// importing this registry; every caller keeps importing it from here.
export * from './events.ts'

/** Canonical form for equality and for the log: optional fields absent, never `undefined`. */
export function canonicalAgentOptions(options: AgentOptions): AgentOptions {
  return {
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  }
}

export function sameAgentOptions(a: AgentOptions, b: AgentOptions): boolean {
  return JSON.stringify(canonicalAgentOptions(a)) === JSON.stringify(canonicalAgentOptions(b))
}

/**
 * A switch merged over a base. An undefined value never clobbers; a route
 * change (provider or model) drops every SAMPLING knob the switch did not
 * name, because whether a model accepts one is adapter-owned knowledge and one
 * adapter's answer means nothing to another. Effort ids are the obvious case;
 * `temperature` is the sharper one — an adapter that refuses it (rather than
 * clamping, which this system never does) would refuse every step of a session
 * that switched into it, and no surface can send an undefined to clear it.
 * `maxSteps` is the loop's, not the route's, and survives.
 */
const ROUTE_SCOPED_OPTIONS = ['reasoningEffort', 'temperature', 'maxTokens'] as const

export function mergeAgentOptions(base: AgentOptions, partial: Partial<AgentOptions>): AgentOptions {
  const merged: Record<string, unknown> = { ...canonicalAgentOptions(base) }
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) merged[key] = value
  }
  const routeChanged = merged.provider !== base.provider || merged.model !== base.model
  if (routeChanged) {
    for (const key of ROUTE_SCOPED_OPTIONS) if (partial[key] === undefined) delete merged[key]
  }
  return canonicalAgentOptions(merged as unknown as AgentOptions)
}

/** The model-visible part of the base: what a call starts from before `agent/request`. */
export function baseCallConfig(options: AgentOptions): CallConfig {
  return {
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}

/**
 * THE route resolution for every model call made about an agent — a loop step
 * (with its position) or an out-of-loop call (with its `purpose`): the base
 * config, then the `agent/request` waterfall in the agent's scope. One path,
 * so a role listener is consulted for a compaction summary or a child's route
 * exactly as it is for a step.
 */
export async function resolveCallConfig(
  agent: Agent,
  call: { readonly purpose?: string; readonly turn?: number; readonly step?: number; readonly signal?: AbortSignal },
): Promise<CallConfig> {
  const config = baseCallConfig(agent.options)
  const context: RequestContext = {
    agent,
    config,
    ...(call.turn === undefined ? {} : { turn: call.turn }),
    ...(call.step === undefined ? {} : { step: call.step }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    ...(call.purpose === undefined ? {} : { purpose: call.purpose }),
  }
  return agent.ctx.waterfall(AGENT_REQUEST, context, async () => config)
}

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
      // Lineage is immutable: a resumed child is still a child, at its depth, of its world.
      ...(stored.header.delegatedBy === undefined ? {} : { delegatedBy: stored.header.delegatedBy }),
      ...(stored.header.delegationDepth === undefined ? {} : { delegationDepth: stored.header.delegationDepth }),
      ...(stored.header.agentPreset === undefined ? {} : { agentPreset: stored.header.agentPreset }),
      agentOptions: resolveSeedAgentOptions(seed, options, `session "${id}"`),
      ...(options.world === undefined ? {} : { world: options.world }),
    })
  }

  async fork(owner: Context, source: Session | SessionId, boundary?: number, options: ForkAgentOptions = {}): Promise<AgentHandle> {
    const src = this.forkSource(source)
    const seed = sliceForkSeed(src.events, boundary)
    // A fork of a delegated session must carry that session's fence with it.
    // A boundary below the opening stamps would produce a session the header
    // still calls a child while its authority re-opened at the deployment
    // default — possibly WIDER than the ceiling it was delegated under.
    if (src.header.delegatedBy !== undefined) {
      const ceiling = delegationCeiling(src.events)
      const pin = delegationPin(src.events)
      if ((ceiling !== undefined && delegationCeiling(seed) === undefined) || (pin !== undefined && delegationPin(seed) === undefined)) {
        throw new Error(`fork of "${src.parentId}": the boundary cuts below the delegation opening, which would drop the authority this session was delegated under`)
      }
    }
    return this.create(owner, {
      cwd: src.cwd,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      seed,
      parentId: src.parentId,
      seedLength: seed.length,
      // A fork of a delegated child is still delegated: the seed carries the
      // opening stamps that fence it, and the header carries its depth.
      ...(src.header.delegatedBy === undefined ? {} : { delegatedBy: src.header.delegatedBy }),
      ...(src.header.delegationDepth === undefined ? {} : { delegationDepth: src.header.delegationDepth }),
      ...(src.header.agentPreset === undefined ? {} : { agentPreset: src.header.agentPreset }),
      agentOptions: resolveSeedAgentOptions(seed, options, `fork of "${src.parentId}"`),
      ...(options.world === undefined ? {} : { world: options.world }),
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

  private forkSource(source: Session | SessionId): { events: readonly EventEnvelope[]; cwd: string; parentId: SessionId; header: SessionHeader } {
    if (typeof source !== 'string') {
      return { events: source.events, cwd: source.header.cwd, parentId: source.id, header: source.header }
    }
    const live = this.agents.get(source)
    if (live) return { events: live.session.events, cwd: live.session.header.cwd, parentId: live.session.id, header: live.session.header }
    const stored = this.loadStored(source)
    const closers = repairInterruptedTail(stored.events)
    return {
      events: closers.length === 0 ? stored.events : [...stored.events, ...closers],
      cwd: stored.header.cwd,
      parentId: stored.header.id,
      header: stored.header,
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
 * seed's folded BASE (`agent/options`) > the seed's folded `request/header`
 * (a log from before the base was recorded) > surface defaults. Undefined
 * override values never clobber a folded fact.
 */
function resolveSeedAgentOptions(seed: readonly EventEnvelope[], options: ResumeAgentOptions, what: string): AgentOptions {
  const merged: Record<string, unknown> = { ...options.defaults }
  const base = foldAgentOptions(seed)
  const header = base ? undefined : foldRequestHeader(seed)
  // A folded fact is the whole model-config authority: an optional it omits
  // was genuinely absent, so a default must not resurrect it. Only `maxSteps`
  // survives from defaults when the fact does not name one — it is
  // deliberately not model-visible.
  const recorded = base ?? header
  if (recorded) {
    merged.provider = recorded.provider
    merged.model = recorded.model
    for (const key of ['reasoningEffort', 'maxTokens', 'temperature'] as const) {
      if (recorded[key] !== undefined) merged[key] = recorded[key]
      else delete merged[key]
    }
    if (base?.maxSteps !== undefined) merged.maxSteps = base.maxSteps
  }
  const partial = options.agentOptions ?? {}
  if (typeof merged.provider !== 'string' || typeof merged.model !== 'string') {
    if (typeof partial.provider !== 'string' || typeof partial.model !== 'string') {
      throw new Error(`${what}: no stored agent/options or request/header to derive the model from; pass agentOptions`)
    }
    merged.provider = partial.provider
    merged.model = partial.model
  }
  // An override at resume is a switch over the recorded base: the same merge
  // rule as a live `configure`, so a route change drops an unnamed effort.
  return mergeAgentOptions(merged as unknown as AgentOptions, partial)
}

/** The agent registry plugin: provides `ctx.agents`. The loop registers the factory. */
export const agentPlugin: Plugin = {
  name: 'core-agent',
  apply(ctx) {
    ctx.provide(AGENTS, new AgentRegistry(ctx))
  },
}

export type { CancelCause }
