import type { Context } from '../../kernel/index.ts'
import type { SessionId } from '../ids.ts'
import type { Message } from '../llm/types.ts'
import type { Session } from '../session/index.ts'

export type AgentStatus = 'idle' | 'running'
export type InboxTarget = 'next-turn' | 'next-step'

export type CancelCause = { readonly kind: 'user' } | { readonly kind: 'parent' } | { readonly kind: 'disposed' } | { readonly kind: 'hook'; readonly reason: string }

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

/** The live agent handle. `id` equals the session id. */
export interface Agent {
  readonly id: SessionId
  readonly session: Session
  readonly status: AgentStatus
  /** The agent's scoped context: registrations here are visible to and live with this agent alone. */
  readonly ctx: Context
  readonly options: AgentOptions
  /** Low-level delivery; `followup`/`steer`/`inject` are the presets. */
  send(message: Message, target: InboxTarget, wakeup: boolean): void
  followup(message: Message): void
  steer(message: Message): void
  inject(message: Message): void
  cancel(cause: CancelCause): void
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
  /**
   * Composes the agent's local world before publication: registrations and
   * plugins mounted through `agentCtx` are visible to this agent alone and
   * unwind with it. Creation fails (and rolls back) if setup throws or a
   * mounted plugin cannot activate.
   */
  readonly setup?: (agentCtx: Context) => void | Promise<void>
}

export interface AgentFactory {
  /** Creates and publishes an agent whose lifetime is bound to `owner`: disposing the owner disposes the agent. */
  create(owner: Context, options: CreateAgentOptions): Promise<AgentHandle>
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

export interface RequestContext {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly config: CallConfig
  readonly signal: AbortSignal
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
