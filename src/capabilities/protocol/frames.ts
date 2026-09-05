/**
 * The client protocol vocabulary: newline-delimited JSON-RPC 2.0. The wire
 * carries durable session events verbatim as `{sessionId, event}` — core types
 * reach a client type-only, there is no DTO layer, and no protocol version
 * until a client ships independently of the host (clients ignore unknown
 * event and notification types).
 */
import type { AgentOptions } from '../../core/agent/index.ts'
import type { ApprovalPolicy, OpenApproval } from '../../core/approval/index.ts'
import type { CompactionDeclineReason } from '../../core/compaction/index.ts'
import type { ProviderInfo } from '../../core/llm/index.ts'
import type { ContextMetrics } from '../../core/metering/index.ts'
import type { SandboxEnforcement, SandboxMode } from '../../core/sandbox/index.ts'
import type { EventEnvelope, RequestContextRecord, SessionEventFrame, SessionHeader } from '../../core/session/index.ts'

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

/**
 * A named place a session can work, so a client need not know or invent host
 * paths. A workspace is ADDRESSING and never authority: naming one grants
 * nothing that `workspaceRoots` does not already allow, and the fence a session
 * runs under still comes from its own immutable header `cwd`.
 */
export interface WorkspaceInfo {
  readonly id: string
  readonly name: string
  readonly root: string
}

export interface InitializeResult {
  readonly serverInfo: { readonly name: string; readonly version: string }
  readonly providers: readonly ProviderInfo[]
  readonly defaultAgentOptions: AgentOptions
  /** What a session created now would start under, and what this host can enforce. */
  readonly defaultAuthority: AuthorityView
  /** The directories a session's `cwd` — its sandbox workspace root — may lie under. Host policy, never the client's. */
  readonly workspaceRoots: readonly string[]
  /** The named workspaces this host serves. Derived from `workspaceRoots` when the deployment names none. */
  readonly workspaces: readonly WorkspaceInfo[]
}

/** One session a client may open, live or stored. */
export interface SessionSummary {
  readonly id: string
  readonly createdAt: number
  readonly cwd: string
  /** The workspace whose root contains `cwd`, when one does. Derived, never stored. */
  readonly workspaceId?: string
  /** An agent is running this session right now. */
  readonly live: boolean
  readonly parentId?: string
  readonly delegatedBy?: string
  readonly agentPreset?: string
}

export interface SessionsListParams {
  /** Only sessions whose cwd lies in this workspace. */
  readonly workspaceId?: string
}

export interface SessionsListResult {
  readonly sessions: readonly SessionSummary[]
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

export type PromptMode = 'followup' | 'steer' | 'auto'

export interface PromptParams {
  /** Absent: create a fresh session. Live: deliver to it. Stored: resume it first. */
  readonly sessionId?: string
  readonly text: string
  /**
   * `followup` (default) queues a next-turn prompt; `steer` lands at the next
   * step boundary; `auto` lets the HOST choose against the live agent in the
   * tick it delivers, which is the only way to choose correctly when a client
   * cannot know whether the turn it observed is still running.
   */
  readonly mode?: PromptMode
  readonly agentOptions?: Partial<AgentOptions>
  /**
   * The new session's working directory — and therefore its sandbox workspace
   * root. It must be an existing directory inside one of the host's
   * `workspaceRoots` (see `initialize`); anything else is INVALID_PARAMS, because
   * the wire may choose WHERE inside the host's policy, never the policy.
   */
  readonly cwd?: string
  /**
   * Name the working directory by workspace instead of by path — what a client
   * that should not have to know host paths uses. Exclusive with `cwd`: given
   * both, the host refuses rather than guessing which one was meant.
   */
  readonly workspaceId?: string
  /** A path relative to that workspace's root. Absent means the root itself. */
  readonly path?: string
}

export interface PromptResult {
  readonly sessionId: string
  readonly messageId: string
}

export interface EventsParams {
  readonly sessionId: string
  readonly fromSeq?: number
  /** Inclusive upper bound. With `fromSeq` this is a gap repair: a range bounded at both ends. */
  readonly toSeq?: number
  /** Ceiling on events returned, from `fromSeq` forward. */
  readonly limit?: number
  /** Drop the trace tier (`assistant/chunk`). A repair wants the facts, not the streaming fidelity. */
  readonly omitTrace?: boolean
}

export interface EventsResult {
  readonly header: SessionHeader
  readonly events: readonly EventEnvelope[]
  /** The store holds bytes beyond `events` (corruption past a torn tail): the stream is a readable prefix, not the whole session. */
  readonly damaged?: true
}

// ---- the paged attach ------------------------------------------------------

/**
 * The folds a client holding only a PAGE cannot compute for itself, done by
 * whoever already owns each one. This is the live control plane the protocol
 * owns (§8), widened from the bare status projection to exactly what a partial
 * reader is missing — never a re-shaping of events, which cross the wire
 * verbatim.
 */
export interface SessionView {
  readonly status: 'idle' | 'running'
  /** Context pressure, metered against the window the log names for the route in use. Absent for a session with no priced request. */
  readonly context?: ContextMetrics
  /** Asked and not yet decided. A page cannot fold this: half a pair is a phantom prompt or a stranded one. */
  readonly pendingApprovals: readonly OpenApproval[]
  readonly authority: AuthorityView
  /** The BASE route (`agent/options`). Absent for a session that is not live. */
  readonly options?: AgentOptions
  /** The EFFECTIVE route of the last request, and the window its adapter advertises. */
  readonly route?: RequestContextRecord
}

/** A message-aligned slice of the log. `from`/`to` are inclusive seq bounds; `to` is -1 for an empty page. */
export interface EventPageFrame {
  readonly events: readonly EventEnvelope[]
  readonly from: number
  readonly to: number
  /** Events exist below `from`. */
  readonly hasMore: boolean
}

export interface AttachParams {
  readonly sessionId: string
  /** Messages the tail page may carry; clamped by the host. */
  readonly limit?: number
}

/** Stop receiving one session's events — or, with no id, every session's. */
export interface DetachParams {
  readonly sessionId?: string
}

/**
 * There is deliberately NO lower-bound cursor here. A reconnecting client
 * re-attaches and REPLACES its window from a fresh page; a gap inside one
 * connection is repaired with `session/events` bounded at both ends. A
 * resume-from-seq attach would have to promise retention the host does not owe.
 */
export interface AttachResult {
  readonly header: SessionHeader
  readonly view: SessionView
  readonly page: EventPageFrame
  /**
   * The seq of the last event the page was cut against (-1 for an empty log):
   * the dedup watermark, and the anchor every later `session/page` must pin to.
   * A live frame at or below it is a duplicate.
   */
  readonly cursor: number
  readonly damaged?: true
}

export interface PageParams {
  readonly sessionId: string
  /** The consistent cut, from the attach frame's `cursor`. Past the live cursor is INVALID_PARAMS. */
  readonly throughSeq: number
  /** Exclusive upper bound for an older page: the `from` of the page already held. */
  readonly beforeSeq?: number
  readonly limit?: number
}

/** Identity and derived state come from the attach frame alone; a page is only a slice. */
export interface PageResult {
  readonly page: EventPageFrame
}

export interface CancelParams {
  readonly sessionId: string
  /**
   * Leave the durable queue alone (default false — a lone client's cancel
   * means "and forget what I asked for"). A client that shares the session
   * with others sets it, because another client's queued prompts are not
   * its to discard.
   */
  readonly keepQueued?: boolean
}

/**
 * Read or switch a live session's BASE route. Omitting every field reads;
 * each given field is merged over the base as one durable switch
 * (`agent/options{change}`), effective at the next step. A provider must be
 * one this host has an adapter for.
 */
export interface ModelParams {
  readonly sessionId: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** The base route after the call — unchanged when nothing was given or nothing differed. */
export type ModelResult = AgentOptions

export interface CompactParams {
  readonly sessionId: string
}

/**
 * `scheduled`: the agent was mid-turn, so compaction runs at its next step
 * boundary. `nothing-to-do` carries the decline reason whenever an attempt was
 * actually made (the same closed union `compaction/end` records), so the client
 * that asked learns why on the idle path without watching the log.
 */
export type CompactResult =
  | { readonly kind: 'compacted'; readonly shadowedNodes: number; readonly surfaceTokensBefore: number; readonly surfaceTokensAfter: number }
  | { readonly kind: 'scheduled' }
  | { readonly kind: 'nothing-to-do'; readonly reason?: CompactionDeclineReason }


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

/**
 * `session.view` params: the host-computed folds, re-sent whenever one of them
 * changes. `session.status` stays beside it rather than folding into it —
 * status is the cheapest and most frequent signal, and clients already read it.
 */
export interface SessionViewParams {
  readonly sessionId: string
  readonly view: SessionView
}
