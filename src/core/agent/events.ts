/**
 * The agent VOCABULARY: the `agent/*` kernel events, the delegation records
 * and the base-route record with its fold. Split from the service (`index.ts`)
 * exactly as `approval/events.ts` and `sandbox/events.ts` are, so a module
 * below the registry — the sandbox and approval services opening their stamps
 * at `agent/created`, the invariant — can name an agent event without
 * importing the seam that owns the registry, which imports those services'
 * vocabularies back. `check-deps` pins the result: core is acyclic at file level.
 */
import { emitEvent, serialEvent, waterfallEvent } from '../../kernel/index.ts'
import type { Message, TokenUsage } from '../llm/types.ts'
import type { SandboxMode } from '../sandbox/events.ts'
import { eventKind, matches, type EventEnvelope, type TurnEndReason } from '../session/types.ts'
import type {
  Agent,
  AgentOptions,
  AgentOptionsReason,
  AgentStatus,
  InboxTarget,
  PreStepContext,
  PreStepDecision,
  RequestContext,
  RequestErrorAction,
  RequestErrorContext,
  TurnStoppingContext,
} from './types.ts'

// ---- kernel events ----------------------------------------------------------

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

// ---- delegation -------------------------------------------------------------

/**
 * The two log-only records a parent writes about a child it started, in the
 * PARENT's session; the child's own steps live in the child's own log, where
 * `sessions show <child>` reads them.
 *
 * They live here rather than in the tool that writes them because delegation is
 * a runtime concept the log records, not one tool's private bookkeeping: the
 * lineage half is already here (`SessionHeader.delegatedBy`/`delegationDepth`,
 * and `agents.fork` refusing a boundary below a child's opening stamps), and a
 * capability may not import another (`scripts/check-deps.ts`).
 */
export const SUBAGENT_START = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly depth: number
  readonly provider: string
  readonly model: string
  readonly sandbox: SandboxMode
  readonly approval: 'never'
}>('subagent/start')

/** How the child's turn ended, and what it cost. */
export const SUBAGENT_END = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly reason: TurnEndReason
  readonly usage?: TokenUsage
}>('subagent/end')

// ---- the base route ---------------------------------------------------------

/**
 * Log-only, folded by `findLast`: the BASE route and limits an agent runs
 * from. Written at creation (`initial`), by `Agent.configure` (`change`), and
 * by an override at resume (`resume`) — the same discipline as the authority
 * knobs. The effective per-request route lives in `request/header` and
 * `request/context`; this record is what a resume rebuilds from, so a role
 * that rewrote the last request can never become the base.
 */
export const AGENT_OPTIONS = eventKind<{ options: AgentOptions; reason: AgentOptionsReason }>('agent/options')

export function foldAgentOptions(events: readonly EventEnvelope[]): AgentOptions | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, AGENT_OPTIONS)) return event.data.options
  }
  return undefined
}
