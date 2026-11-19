/**
 * The client protocol vocabulary: newline-delimited JSON-RPC 2.0. The wire
 * carries durable session events verbatim as `{sessionId, event}` — core types
 * reach a client type-only, there is no DTO layer, and no protocol version
 * until a client ships independently of the host (clients ignore unknown
 * event and notification types).
 *
 * The wire shape follows DeepSeek Harness's SDK — newline-delimited JSON-RPC
 * over stdio (https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md);
 * the method table, the paged attach and the authority methods are MiniDSH's.
 */
import type { AgentOptions } from '../../core/agent/index.ts'
import type { ApprovalGrant, ApprovalOfferId, ApprovalPolicy, OpenApproval } from '../../core/approval/index.ts'
import type { CompactionDeclineReason } from '../../core/compaction/index.ts'
import type { JobEnd } from '../../core/jobs/index.ts'
import type { ProviderInfo } from '../../core/llm/index.ts'
import type { ContextMetrics } from '../../core/metering/index.ts'
import type { SandboxEnforcement, SandboxMode } from '../../core/sandbox/index.ts'
import type { EventEnvelope, RequestContextRecord, SessionEventFrame, SessionHeader } from '../../core/session/index.ts'
import type { ToolDisplay } from '../../core/tools/index.ts'

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

/**
 * How a surface should draw calls of one tool: its name and the display the
 * tool itself declared (`ToolDefinition.display`). Presentation only — the
 * host copies it out and nothing on either side of the wire may decide what a
 * call DOES from it. Never the description or the schema: those are
 * model-facing, and a surface has no use for them.
 */
export interface ToolPresentation {
  readonly name: string
  readonly display?: ToolDisplay
}

/** One authority preset as a picker offers it: the pair it selects, and what it says about itself. */
export interface PresetInfo {
  readonly name: string
  readonly sandbox: SandboxMode
  readonly approval: ApprovalPolicy
  readonly description?: string
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
  /**
   * The DEPLOYMENT's tools — the global registry, before any agent's
   * narrowing or a preset's own rows. A live session's own list, preset
   * tools included, comes with its attach (`AttachResult.tools`). `[]` where
   * no tool registry is mounted.
   */
  readonly tools: readonly ToolPresentation[]
  /** The authority presets a session may be switched to, in table order; `[]` where no presets capability is mounted. */
  readonly presets: readonly PresetInfo[]
}

/** One session a client may open, live or stored. */
export interface SessionSummary {
  readonly id: string
  readonly createdAt: number
  readonly cwd: string
  /**
   * What to call it: the session's recorded `session/title`, else what its
   * first prompt says. Derived, never on the header — and absent for a session
   * nobody has prompted yet, or one whose first prompt is bigger than the
   * bounded prefix a stored listing reads.
   */
  readonly title?: string
  /** The workspace whose root contains `cwd`, when one does. Derived, never stored. */
  readonly workspaceId?: string
  /** An agent is running this session right now. */
  readonly live: boolean
  readonly parentId?: string
  readonly delegatedBy?: string
  /** Which parent tool call created this child, when the header records one. */
  readonly delegatedByCallId?: string
  readonly agentPreset?: string
  /**
   * When this session last changed, ms since the epoch: a LIVE session's last
   * appended event's `time`, a stored one's store write time
   * (`StoredSessionSummary.updatedAt`). A label for "recent", never an order
   * the list promises — `sessions/list` stays newest-CREATED first. Absent
   * where neither is known (a live session with no event yet, a store that
   * cannot tell).
   */
  readonly updatedAt?: number
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
  /**
   * The weakest enforcement this session ACCEPTS for a shell command under
   * `sandbox` — a decision, where `enforcement` beside it is a host fact.
   * `full` unless somebody said otherwise; weaker means a command this host
   * cannot confine runs anyway, with only the in-process file fence left.
   */
  readonly accepts: SandboxEnforcement
  /** Standing consents this session still holds — a person may see and take back what they gave. */
  readonly grants: readonly ApprovalGrant[]
  /** Derived from the pair against the preset table (`custom` = no match); absent when no presets capability is mounted. */
  readonly preset?: string
}

export interface AuthorityParams {
  readonly sessionId: string
  /** Either may be omitted; omitting all three reads the current authority without changing it. */
  readonly sandbox?: SandboxMode
  readonly approval?: ApprovalPolicy
  /** What this session accepts from its execution world, for whatever mode it ends this call under. */
  readonly accepts?: SandboxEnforcement
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
  /**
   * The authority a NEW session opens under, applied before its first turn
   * can start: the same switch set `session/authority` makes — each switch its
   * durable event, held to the same rules — run inside the creation
   * transaction (`CreateAgentOptions.opening`), so a refusal rolls the
   * creation back with no session left and the prompt never delivered. Only
   * on a prompt that CREATES a session: given with a `sessionId` it is
   * INVALID_PARAMS, because a live or stored session's authority is switched
   * by `session/authority`, as a decision of its own. `preset` is exclusive
   * with `sandbox`/`approval`, exactly as there.
   */
  readonly authority?: PromptAuthority
}

/** The knobs of `session/authority`, without the session: what a new session should open under. */
export interface PromptAuthority {
  readonly sandbox?: SandboxMode
  readonly approval?: ApprovalPolicy
  readonly accepts?: SandboxEnforcement
  readonly preset?: string
}

export interface PromptResult {
  readonly sessionId: string
  readonly messageId: string
}

/**
 * Continue a session WITHOUT a prompt: a stored one is resumed (its restored
 * inbox may wake it), a live one is returned as it is — upstream's SDK
 * refuses an occupied session instead; here a live session is already this
 * host's to drive or refused as a running child. Either way the caller then
 * attaches to watch it. `agentOptions` are the same durable route switch a
 * prompt's are; a surface reopening a session it only listed sends none.
 */
export interface ResumeParams {
  readonly sessionId: string
  readonly agentOptions?: Partial<AgentOptions>
}

/**
 * Branch a live or stored session into a NEW one and leave it idle (a fork
 * never wakes). `atSeq` is the inclusive boundary (`agents.fork`); absent,
 * the source's whole log, which must not end inside an open turn. `salvage`
 * forks a damaged STORED log's readable prefix and is refused for a live one.
 */
export interface ForkParams {
  readonly sessionId: string
  readonly atSeq?: number
  readonly salvage?: boolean
  readonly agentOptions?: Partial<AgentOptions>
}

/** The session `session/resume` continued, or the one `session/fork` made. */
export interface ContinueResult {
  readonly sessionId: string
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
  /** The BASE route (`agent/options`): the live agent's, else the stored log's fold. Absent only where neither names one. */
  readonly options?: AgentOptions
  /** The EFFECTIVE route of the last request, and the window its adapter advertises. */
  readonly route?: RequestContextRecord
  /** Every background job the log names, in start order; `[]` when none. A page cannot pair a start with an end it does not hold. */
  readonly jobs: readonly JobSummary[]
  /**
   * Present, `false`, exactly when the host would refuse a DRIVING method on
   * this session right now (prompt, cancel, compact, a switch of route or
   * authority, a revoke, a job stop): it is a delegated child its live parent
   * is running, and only that tool call may drive it. Reads stay open. Absent
   * means drivable. A surface disables its controls from this rather than
   * learning the rule by being refused.
   */
  readonly drivable?: false
  /** The session driving this one, beside `drivable: false`: the delegating parent's id. */
  readonly drivenBy?: string
}

/** One background job as a reader is shown it: a projection of its bracket and its notice, never registry state. */
export interface JobSummary {
  readonly jobId: string
  readonly label: string
  /**
   * `running`: a live registry supervises it now. `ended`: its end is
   * recorded. `unclosed`: no end is recorded and nothing here supervises it —
   * a cold read of a log whose writer is gone, which the next resume closes
   * `lost`. A cold read never says `running`.
   */
  readonly state: 'running' | 'ended' | 'unclosed'
  readonly pid?: number
  /** The recorded end, verbatim. */
  readonly end?: JobEnd
  /** Its notice is queued and will not wake the agent: the next message delivers it. */
  readonly held?: true
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
  /**
   * The tools THIS session's agent sees, display included — the deployment's,
   * narrowed by the agent's restrictions and widened by what its preset world
   * mounted (`initialize`'s list cannot know those). Present only for a LIVE
   * session: a cold read has no agent, so a surface falls back to
   * `initialize`'s deployment list.
   */
  readonly tools?: readonly ToolPresentation[]
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


export interface ApprovalRevokeParams {
  readonly sessionId: string
  readonly grantId: string
}

export interface ApprovalRevokeResult {
  /** False when this session holds no such live grant — already revoked, or ended by an authority change. */
  readonly revoked: boolean
}

export interface ApprovalAnswerParams {
  readonly sessionId: string
  /** The durable id from the `approval/asked` event streaming over `session.event`. */
  readonly id: string
  readonly outcome: 'allowed-once' | 'rejected'
  /**
   * A scope the HOST offered on this approval (`view.pendingApprovals[].offers`),
   * taken beside the one-shot yes. A surface may not invent one: an id the fold
   * did not offer is refused here, and the seam re-checks before writing.
   */
  readonly offer?: ApprovalOfferId
}

export interface ApprovalAnswerResult {
  /** First answer wins; a settled, unknown, or already-answered prompt is `not-pending`. */
  readonly outcome: 'accepted' | 'not-pending'
}

/** A PERSON's stop of one background job of a live session. */
export interface JobCancelParams {
  readonly sessionId: string
  readonly jobId: string
}

/**
 * The job after the stop, waited on (bounded): `running` means its process
 * had not ended when the wait gave up, and its end will still be recorded
 * when it does. Either way the agent is not woken — a stop a person asked for
 * is delivered quiet.
 */
export interface JobCancelResult {
  readonly jobId: string
  readonly state: 'running' | 'ended'
  readonly end?: JobEnd
}

/**
 * Become a control subscriber: this connection receives `control.summary` for
 * every live session, whatever its watch set — and, being shown each one's
 * `pendingApprovals`, it counts as a client that could still come to answer
 * a parked question.
 */
export type ControlSubscribeParams = Record<string, never>

/** The baseline: one summary per live session the host would show (a child mid-delegation is its parent's). */
export interface ControlSubscribeResult {
  readonly sessions: readonly ControlSummary[]
}

/**
 * Read the bytes of one image a session's log shows, so a surface can draw
 * what the model saw. The log carries only an `AttachmentRef` (§5's binary
 * plane: no base64 in a fact), and a browser has no path to the store.
 *
 * There is one principal behind every connection (§13), so this is no
 * privilege boundary between users — but an attachment id is a CONTENT
 * address (`sha256:…`), and without the session check this method would be an
 * oracle over the whole store: "does this host hold an image with this hash",
 * answered for any hash, from any session. So only an id that appears in an
 * `image` block of THIS session's facts (a user message, or a tool result at
 * any depth) is read, through the log's OWN reference — never one the client
 * supplies — and the store re-verifies the bytes against it. A read, not a
 * drive: a child mid-delegation and a stored session answer it, from any
 * connection that could attach to the session.
 */
export interface AttachmentReadParams {
  readonly sessionId: string
  readonly attachmentId: string
}

export interface AttachmentReadResult {
  /** The media type the store verified from the bytes when they were saved. */
  readonly mediaType: string
  /** The decoded length. */
  readonly bytes: number
  /** Base64, standard alphabet. */
  readonly data: string
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

/**
 * `control.summary` params: what a control plane needs to know a session wants
 * a person, without watching its events. Whole-state and superseding — the
 * latest one for a session is all there is to know — and coalesced per
 * session per tick. `closed` is sent once, when the session's agent is
 * disposed; its counts are zero by design (nothing runs or waits in a session
 * no agent holds), and a reader wanting the log's own debts attaches cold.
 */
export interface ControlSummary {
  readonly sessionId: string
  readonly status: 'idle' | 'running' | 'closed'
  readonly runningJobs: number
  /** Notices queued that will not wake the agent: the next message delivers them. */
  readonly heldNotices: number
  readonly pendingApprovals: number
}

export type ControlSummaryParams = ControlSummary
