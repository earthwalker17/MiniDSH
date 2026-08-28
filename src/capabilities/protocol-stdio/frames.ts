/**
 * The client protocol vocabulary: newline-delimited JSON-RPC 2.0. The wire
 * carries durable session events verbatim as `{sessionId, event}` — core types
 * reach a client type-only, there is no DTO layer, and no protocol version
 * until a client ships independently of the host (clients ignore unknown
 * event and notification types).
 */
import type { AgentOptions } from '../../core/agent/index.ts'
import type { ApprovalPolicy } from '../../core/approval/index.ts'
import type { ProviderInfo } from '../../core/llm/index.ts'
import type { SandboxEnforcement, SandboxMode } from '../../core/sandbox/index.ts'
import type { EventEnvelope, SessionEventFrame, SessionHeader } from '../../core/session/index.ts'

// ---- JSON-RPC 2.0 envelope ------------------------------------------------

export interface RpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly method: string
  readonly params?: unknown
}

export interface RpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export interface RpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface RpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly result?: unknown
  readonly error?: RpcErrorObject
}

export const INVALID_PARAMS = -32602
export const METHOD_NOT_FOUND = -32601
export const INTERNAL_ERROR = -32603

/** A handler failure that already knows its JSON-RPC error code. */
export class RpcFailure extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'RpcFailure'
    this.code = code
  }
}

// ---- requests (client → host) ---------------------------------------------

export interface InitializeResult {
  readonly serverInfo: { readonly name: string; readonly version: string }
  readonly providers: readonly ProviderInfo[]
  readonly defaultAgentOptions: AgentOptions
  /** What a session created now would start under, and what this host can enforce. */
  readonly defaultAuthority: AuthorityView
  /** The directories a session's `cwd` — its sandbox workspace root — may lie under. Host policy, never the client's. */
  readonly workspaceRoots: readonly string[]
}

/** The authority a session is under. `enforcement` is a reported fact about THIS host. */
export interface AuthorityView {
  readonly sandbox: SandboxMode
  readonly approval: ApprovalPolicy
  readonly enforcement: SandboxEnforcement
  /** Derived from the pair against the preset table (`custom` = no match); absent when no presets capability is mounted. */
  readonly preset?: string
}

export interface AuthorityParams {
  readonly sessionId: string
  /** Either may be omitted; omitting all three reads the current authority without changing it. */
  readonly sandbox?: SandboxMode
  readonly approval?: ApprovalPolicy
  /** A named preset over the pair; exclusive with `sandbox`/`approval`. */
  readonly preset?: string
}

export type PromptMode = 'followup' | 'steer'

export interface PromptParams {
  /** Absent: create a fresh session. Live: deliver to it. Stored: resume it first. */
  readonly sessionId?: string
  readonly text: string
  /** `followup` (default) queues a next-turn prompt; `steer` lands at the next step boundary. */
  readonly mode?: PromptMode
  readonly agentOptions?: Partial<AgentOptions>
  /**
   * The new session's working directory — and therefore its sandbox workspace
   * root. It must be an existing directory inside one of the host's
   * `workspaceRoots` (see `initialize`); anything else is INVALID_PARAMS, because
   * the wire may choose WHERE inside the host's policy, never the policy.
   */
  readonly cwd?: string
}

export interface PromptResult {
  readonly sessionId: string
  readonly messageId: string
}

export interface EventsParams {
  readonly sessionId: string
  readonly fromSeq?: number
}

export interface EventsResult {
  readonly header: SessionHeader
  readonly events: readonly EventEnvelope[]
  /** The store holds bytes beyond `events` (corruption past a torn tail): the stream is a readable prefix, not the whole session. */
  readonly damaged?: true
}

export interface CancelParams {
  readonly sessionId: string
}

export interface CompactParams {
  readonly sessionId: string
}

/** `scheduled`: the agent was mid-turn, so compaction runs at its next step boundary. */
export type CompactResult =
  | { readonly kind: 'compacted'; readonly shadowedNodes: number; readonly surfaceTokensBefore: number; readonly surfaceTokensAfter: number }
  | { readonly kind: 'scheduled' }
  | { readonly kind: 'nothing-to-do' }


export interface ApprovalAnswerParams {
  readonly sessionId: string
  /** The durable id from the `approval/asked` event streaming over `session.event`. */
  readonly id: string
  readonly outcome: 'allowed-once' | 'rejected'
}

export interface ApprovalAnswerResult {
  /** First answer wins; a settled, unknown, or already-answered prompt is `not-pending`. */
  readonly outcome: 'accepted' | 'not-pending'
}

// ---- notifications (host → client) ----------------------------------------

/** `session.event` params: the durable event, verbatim. */
export type SessionEventParams = SessionEventFrame

/** `session.status` params: the whole-agent lifecycle projection. */
export interface SessionStatusParams {
  readonly sessionId: string
  readonly status: 'idle' | 'running'
}
