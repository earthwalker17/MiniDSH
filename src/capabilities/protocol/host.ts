/**
 * The protocol host: JSON-RPC method handlers, the live control plane a wire
 * needs beyond durable events — the status and session projections, approval
 * prompts as answerable frames keyed by the durable `approval/asked` id (a
 * host-side pending table, first answer wins across clients), cancel/steer —
 * and the ownership of agents created over the wire. Approval frames have no
 * notification of their own: the durable `approval/asked`/`approval/decided`
 * events streaming over `session.event` ARE the frames.
 *
 * The host is per-DEPLOYMENT, not per-client. Everything durable or shared
 * lives here and outlives any connection; a `ClientConnection` owns only its
 * frame sink and its watch set. That split is what makes a disconnect mean
 * "this client is gone" rather than "dispose the work it started".
 */
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '../../kernel/index.ts'
import { AGENTS, AGENT_OPTIONS, foldAgentOptions, mergeAgentOptions, type Agent, type AgentHandle, type AgentOptions } from '../../core/agent/index.ts'
import {
  APPROVAL,
  APPROVAL_ASKED,
  APPROVAL_DECIDED,
  APPROVAL_POLICIES,
  APPROVAL_POLICY,
  effectiveApprovalPolicy,
  isApprovalPolicy,
  openApprovals,
  type ApprovalOutcome,
  type ApprovalPrompt,
} from '../../core/approval/index.ts'
import { COMPACTION } from '../../core/compaction/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { LLM } from '../../core/llm/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { meterSession } from '../../core/metering/index.ts'
import { PERSISTENCE } from '../../core/persistence/index.ts'
import { AUTHORITY_PRESET, PRESETS } from '../../core/presets/index.ts'
import { canonicalPath, effectiveSandboxMode, isInside, isSandboxMode, SANDBOX, SANDBOX_MODE, SANDBOX_MODES } from '../../core/sandbox/index.ts'
import {
  ASSISTANT_MESSAGE,
  REQUEST_CONTEXT,
  SESSIONS,
  TRACE_TYPES,
  foldRequestContext,
  matches,
  pageEvents,
  type EventEnvelope,
  type Session,
  type SessionHeader,
} from '../../core/session/index.ts'
import { ClientConnection } from './connection.ts'
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  RpcFailure,
  type ApprovalAnswerResult,
  type AttachResult,
  type AuthorityView,
  type CompactResult,
  type EventsResult,
  type InitializeResult,
  type PageResult,
  type PromptResult,
  type RpcNotification,
  type SessionSummary,
  type SessionView,
  type SessionsListResult,
  type WorkspaceInfo,
} from './frames.ts'

/**
 * Stored sessions kept parsed for a reader paging backwards. A cold read is a
 * whole-file parse; backward paging asks for the same session repeatedly, and a
 * session that goes live is served from the live log instead.
 */
const COLD_SOURCE_CACHE = 3

/**
 * The durable kinds that move a `SessionView`. Named from the kind tokens, so a
 * renamed event is a compile error rather than a view that quietly stops
 * updating. A surface `replace` is handled separately — it is an op, not a kind.
 */
const VIEW_CHANGING: ReadonlySet<string> = new Set([
  ASSISTANT_MESSAGE.type,
  APPROVAL_ASKED.type,
  APPROVAL_DECIDED.type,
  APPROVAL_POLICY.type,
  SANDBOX_MODE.type,
  AUTHORITY_PRESET.type,
  AGENT_OPTIONS.type,
  REQUEST_CONTEXT.type,
])

/** One session as a reader sees it — live or stored, addressed the same way. */
interface SessionSource {
  readonly header: SessionHeader
  /** Every tier, dense and zero-based, so a seq is an index. */
  readonly events: readonly EventEnvelope[]
  /** The log without its trace tier, seqs preserved: what a page is cut from. */
  readonly facts: readonly EventEnvelope[]
  /** The seq of the last event, or -1 for an empty log. */
  readonly cursor: number
  readonly agent?: Agent | undefined
  readonly damaged?: true
}

export interface ProtocolServerConfig {
  readonly cwd: string
  /** Canonical directories a client-chosen `cwd` must lie under. */
  readonly workspaceRoots: readonly string[]
  /** Named places to work, canonical roots, ids already resolved. */
  readonly workspaces: readonly WorkspaceInfo[]
  readonly defaultAgentOptions: AgentOptions
  readonly serverVersion: string
  /** Applied to every agent this surface creates or resumes. */
  readonly setup?: (agentCtx: Context) => void | Promise<void>
  /** The name of the preset `setup` composes, recorded in each session's header. */
  readonly agentPreset?: string
  /** Called once, when the protocol is done (shutdown answered, or the input ended). */
  readonly onClose?: () => void
  /**
   * End the host when its last client disconnects. True for a carrier whose
   * client IS the process's reason to run (stdio, the loopback pair); false for
   * a socket, where the host outlives every tab that opens it.
   */
  readonly closeWithLastClient?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(params: Record<string, unknown>, key: string, method: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) throw new RpcFailure(INVALID_PARAMS, `${method}: "${key}" must be a non-empty string`)
  return value
}

/** An optional non-negative integer, refused rather than coerced. */
function optionalCount(params: Record<string, unknown>, key: string, method: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RpcFailure(INVALID_PARAMS, `${method}: "${key}" must be a non-negative integer`)
  }
  return value
}

/**
 * Overrides merged over defaults. Every value is validated here rather than at
 * the first paid step, because the merge's result becomes the session's
 * durable base route — a `maxSteps` of `"lots"` would silently remove the step
 * ceiling, and a route to nowhere would be recorded before it failed. The
 * merge itself is `core/agent`'s, so a route change drops an adapter-owned
 * effort the caller did not restate, exactly as a live switch does.
 */
function readAgentOptions(defaults: AgentOptions, overrides: unknown, method: string): { full: AgentOptions; partial: Partial<AgentOptions> } {
  if (overrides !== undefined && !isRecord(overrides)) throw new RpcFailure(INVALID_PARAMS, `${method}: "agentOptions" must be an object`)
  const partial: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue
    if (key === 'maxSteps' || key === 'maxTokens') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new RpcFailure(INVALID_PARAMS, `${method}: "${key}" must be a positive integer`)
    } else if (key === 'temperature') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new RpcFailure(INVALID_PARAMS, `${method}: "temperature" must be a number`)
    } else if (key === 'provider' || key === 'model' || key === 'reasoningEffort') {
      if (typeof value !== 'string' || value.length === 0) throw new RpcFailure(INVALID_PARAMS, `${method}: "${key}" must be a non-empty string`)
    } else {
      throw new RpcFailure(INVALID_PARAMS, `${method}: "agentOptions" has no field "${key}"`)
    }
    partial[key] = value
  }
  const typed = partial as Partial<AgentOptions>
  return { full: mergeAgentOptions(defaults, typed), partial: typed }
}

/** A parked approval, and the connections that could still answer it. */
interface PendingApproval {
  readonly sessionId: string
  readonly settle: (outcome: ApprovalOutcome) => void
  readonly watchers: Set<ClientConnection>
}

export class ProtocolHost {
  private readonly ctx: Context
  private readonly config: ProtocolServerConfig
  /** Every connected client. Agents outlive all of them. */
  private readonly connections = new Set<ClientConnection>()
  /** Answerable approval frames, keyed by `sessionId:durableId`. First answer wins, across clients. */
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  /** Agents this protocol created (and therefore owns), by session id. */
  private readonly owned = new Map<string, AgentHandle>()
  /** In-flight resumes, so concurrent prompts for one stored id share a transaction. */
  private readonly resuming = new Map<string, Promise<Agent>>()
  /** Every in-flight acquire, so shutdown can drain creations racing it. */
  private readonly inflight = new Set<Promise<Agent>>()
  /** Parsed stored sessions, most recently used last (insertion order IS the LRU). */
  private readonly cold = new Map<string, SessionSource>()
  private closed = false
  private shuttingDown = false

  constructor(ctx: Context, config: ProtocolServerConfig) {
    this.ctx = ctx
    this.config = config
  }

  // ---- connections --------------------------------------------------------

  connect(connection: ClientConnection): void {
    if (this.closed) {
      connection.close()
      return
    }
    this.connections.add(connection)
  }

  /**
   * One client is gone. Its agents are NOT: a disconnect is not a shutdown, so
   * a browser refresh reattaches to work still running. What does end is any
   * approval only this client could have answered — leaving it parked would
   * block the agent on a question nobody can see.
   */
  disconnect(connection: ClientConnection): void {
    connection.close()
    this.connections.delete(connection)
    this.withdrawFromApprovals(connection)
    if (this.connections.size === 0 && this.config.closeWithLastClient) this.close()
  }

  /**
   * This client can no longer answer — it left, or it stopped watching. An
   * approval whose last possible answerer is gone is closed rather than left
   * parked, because a parked question no one can see stops the agent forever.
   */
  private withdrawFromApprovals(connection: ClientConnection, sessionId?: string): void {
    for (const [key, pending] of this.pendingApprovals) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue
      if (!pending.watchers.delete(connection) || pending.watchers.size > 0) continue
      this.pendingApprovals.delete(key)
      pending.settle('unavailable')
    }
  }

  // ---- outbound: the notifications ----------------------------------------

  private broadcast(sessionId: string, frame: RpcNotification, droppable = false): void {
    for (const connection of this.connections) if (connection.watches(sessionId)) connection.send(frame, droppable)
  }

  onSessionEvent(session: Session, event: EventEnvelope): void {
    // A live event means any stored copy of this session is behind; the live
    // log is the source from here on. Done even while closed, so a reattaching
    // reader never sees a stale parse.
    if (this.cold.size > 0) this.cold.delete(session.id)
    if (this.closed) return
    // The trace tier is what a carrier under pressure is allowed to drop: it is
    // recorded for streaming fidelity, no fold reads it, and `assistant/message`
    // carries the same text durably a moment later.
    this.broadcast(session.id, { jsonrpc: '2.0', method: 'session.event', params: { sessionId: session.id, event } }, TRACE_TYPES.has(event.type))
    // The durable decision settles the answerable frame, whoever decided it.
    if (matches(event, APPROVAL_DECIDED)) this.pendingApprovals.delete(`${session.id}:${event.data.id}`)
    // A page-holding client cannot recompute these folds, so the host re-sends
    // them whenever a durable fact moved one. A replace is included because it
    // makes the meter re-estimate the whole surface.
    if (VIEW_CHANGING.has(event.type) || event.surfaceOp?.op === 'replace') this.publishView(session)
  }

  /** The view as it now stands, for every reader of this session. */
  private publishView(session: Session): void {
    const view = this.viewOf({
      header: session.header,
      events: session.events,
      facts: session.facts,
      cursor: session.seq - 1,
      agent: this.ctx.get(AGENTS).get(session.id),
    })
    this.broadcast(session.id, { jsonrpc: '2.0', method: 'session.view', params: { sessionId: session.id, view } })
  }

  onAgentStatus(agent: Agent, status: 'idle' | 'running'): void {
    if (this.closed) return
    this.broadcast(agent.id, { jsonrpc: '2.0', method: 'session.status', params: { sessionId: agent.id, status } })
  }

  /**
   * The `approval/request` answerer. The durable `approval/asked` event already
   * reached every watching client as a frame, so parking the promise is all
   * this does — and it parks only if someone is actually watching that session.
   * With nobody to ask, it delegates down the waterfall rather than hanging the
   * agent on a question no one will ever see.
   */
  answerApproval(prompt: ApprovalPrompt, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (this.closed) return next()
    const watchers = new Set([...this.connections].filter((connection) => connection.watches(prompt.agent.id)))
    if (watchers.size === 0) return next()
    return new Promise<ApprovalOutcome>((resolve) => {
      this.pendingApprovals.set(`${prompt.agent.id}:${prompt.id}`, { sessionId: prompt.agent.id, settle: resolve, watchers })
    })
  }

  // ---- inbound ------------------------------------------------------------

  async onFrame(connection: ClientConnection, frame: unknown): Promise<void> {
    if (!isRecord(frame) || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') return
    const id = frame.id
    if (typeof id !== 'number' && typeof id !== 'string') return // a client notification; none are defined
    try {
      const result = await this.dispatch(connection, frame.method, frame.params)
      connection.send({ jsonrpc: '2.0', id, result })
      if (frame.method === 'shutdown') this.close()
    } catch (error) {
      const failure =
        error instanceof RpcFailure
          ? { code: error.code, message: error.message }
          : { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) }
      connection.send({ jsonrpc: '2.0', id, error: failure })
    }
  }

  private dispatch(connection: ClientConnection, method: string, params: unknown): Promise<unknown> | unknown {
    const record = isRecord(params) ? params : {}
    switch (method) {
      case 'initialize':
        return this.initialize()
      case 'session/prompt':
        return this.prompt(record)
      case 'sessions/list':
        return this.sessionsList(record)
      case 'session/events':
        return this.events(record)
      case 'session/attach':
        return this.attach(connection, record)
      case 'session/detach':
        return this.detach(connection, record)
      case 'session/page':
        return this.page(record)
      case 'session/cancel':
        return this.cancel(record)
      case 'session/compact':
        return this.compact(record)
      case 'approval/answer':
        return this.approvalAnswer(record)
      case 'session/authority':
        return this.authority(record)
      case 'session/model':
        return this.model(record)
      case 'shutdown':
        // Host-wide, and therefore not every carrier's to call: a browser tab
        // closing must not end a daemon other clients are attached to.
        if (!connection.allowShutdown) throw new RpcFailure(INVALID_PARAMS, 'shutdown: this carrier may not shut the host down; close the connection instead')
        return this.shutdown()
      default:
        throw new RpcFailure(METHOD_NOT_FOUND, `unknown method "${method}"`)
    }
  }

  private initialize(): InitializeResult {
    return {
      serverInfo: { name: 'minidsh', version: this.config.serverVersion },
      providers: this.ctx.get(LLM).providers(),
      defaultAgentOptions: this.config.defaultAgentOptions,
      defaultAuthority: this.defaultAuthority(),
      workspaceRoots: this.config.workspaceRoots,
      workspaces: this.config.workspaces,
    }
  }

  /**
   * Every session a client could open, live or stored, newest first. A browser
   * has no other way to find one; `persistence.list` reads a bounded header
   * prefix per file, so this needs no projection to stay cheap.
   */
  private sessionsList(params: Record<string, unknown>): SessionsListResult {
    const workspaceId = params.workspaceId
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      throw new RpcFailure(INVALID_PARAMS, 'sessions/list: "workspaceId" must be a string')
    }
    const live = new Map(this.ctx.get(SESSIONS).list().map((session) => [String(session.id), session.header]))
    const stored = this.ctx.tryGet(PERSISTENCE)?.list() ?? []
    const headers = new Map(stored.map((header) => [String(header.id), header]))
    // A live session that has not recorded a conversation fact yet has no file,
    // so the union is what "every session" means.
    for (const [id, header] of live) headers.set(id, header)
    const sessions: SessionSummary[] = []
    for (const header of headers.values()) {
      const workspace = this.workspaceOf(header.cwd)
      if (workspaceId !== undefined && workspace?.id !== workspaceId) continue
      sessions.push({
        id: String(header.id),
        createdAt: header.createdAt,
        cwd: header.cwd,
        live: live.has(String(header.id)),
        ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
        ...(header.parentId === undefined ? {} : { parentId: String(header.parentId) }),
        ...(header.delegatedBy === undefined ? {} : { delegatedBy: String(header.delegatedBy) }),
        ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
      })
    }
    sessions.sort((left, right) => right.createdAt - left.createdAt)
    return { sessions }
  }

  /** The workspace a path belongs to, derived — no session stores a workspace id. */
  private workspaceOf(cwd: string): WorkspaceInfo | undefined {
    return this.config.workspaces.find((workspace) => isInside(workspace.root, cwd))
  }

  /**
   * A client may choose WHERE a session works, inside the host's policy — never
   * the policy. The cwd becomes the immutable workspace root every fence
   * derives from, so it must exist and lie under one of the host's roots; the
   * canonical path (links followed) is what is checked and what is recorded.
   */
  /**
   * Where a new session works: a workspace id, or a path, or the host's own
   * default. Never both — given both, the host refuses rather than guessing
   * which one the client meant.
   */
  private resolveCwd(params: Record<string, unknown>): string {
    const { cwd, workspaceId, path } = params
    if (cwd !== undefined && typeof cwd !== 'string') throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "cwd" must be a string')
    if (workspaceId !== undefined && typeof workspaceId !== 'string') throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "workspaceId" must be a string')
    if (path !== undefined && typeof path !== 'string') throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "path" must be a string')
    if (cwd !== undefined && workspaceId !== undefined) {
      throw new RpcFailure(INVALID_PARAMS, 'session/prompt: give "workspaceId" or "cwd", not both')
    }
    if (workspaceId === undefined) {
      if (path !== undefined) throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "path" is relative to a "workspaceId"')
      return cwd === undefined ? this.config.cwd : this.workspaceFor(cwd)
    }
    const workspace = this.config.workspaces.find((one) => one.id === workspaceId)
    if (!workspace) throw new RpcFailure(INVALID_PARAMS, `session/prompt: no workspace "${workspaceId}"`)
    // Resolved and then held to exactly the same four checks a raw path is:
    // naming a workspace is a convenience, not a wider permission.
    return this.workspaceFor(path === undefined ? workspace.root : join(workspace.root, path))
  }

  private workspaceFor(raw: string): string {
    if (!isAbsolute(raw)) throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "cwd" must be an absolute path')
    let canonical: string
    try {
      canonical = canonicalPath(raw)
    } catch (error) {
      throw new RpcFailure(INVALID_PARAMS, `session/prompt: "cwd" cannot be resolved: ${error instanceof Error ? error.message : String(error)}`)
    }
    let directory = false
    try {
      directory = statSync(canonical).isDirectory()
    } catch {
      directory = false
    }
    if (!directory) throw new RpcFailure(INVALID_PARAMS, `session/prompt: "cwd" is not an existing directory: ${raw}`)
    if (!this.config.workspaceRoots.some((root) => isInside(root, canonical))) {
      throw new RpcFailure(INVALID_PARAMS, `session/prompt: "cwd" must lie inside one of this host's workspace roots (${this.config.workspaceRoots.join(', ')})`)
    }
    return canonical
  }

  private defaultAuthority(): AuthorityView {
    const sandbox = this.ctx.get(SANDBOX)
    return this.withPreset({
      sandbox: sandbox.defaultMode,
      approval: this.ctx.get(APPROVAL).defaultPolicy,
      enforcement: sandbox.enforcementFor(sandbox.defaultMode),
    })
  }

  /** Derived, per request, via tryGet — a composition without presets simply omits the field. */
  private withPreset(view: AuthorityView): AuthorityView {
    const presets = this.ctx.tryGet(PRESETS)
    if (!presets) return view
    return { ...view, preset: presets.selectFor({ sandbox: view.sandbox, approval: view.approval }) }
  }

  /**
   * Read or switch a live session authority. Each switch IS its durable event,
   * so a client never holds authority state of its own — it reads the log like
   * every other surface.
   */
  private authority(params: Record<string, unknown>): AuthorityView {
    const sessionId = requireString(params, 'sessionId', 'session/authority')
    const agent = this.ctx.get(AGENTS).get(asSessionId(sessionId))
    if (!agent) throw new RpcFailure(INTERNAL_ERROR, `no live session "${sessionId}"`)
    if (params.sandbox !== undefined && !isSandboxMode(params.sandbox)) {
      throw new RpcFailure(INVALID_PARAMS, `session/authority: "sandbox" must be one of ${SANDBOX_MODES.join(' | ')}`)
    }
    if (params.approval !== undefined && !isApprovalPolicy(params.approval)) {
      throw new RpcFailure(INVALID_PARAMS, `session/authority: "approval" must be one of ${APPROVAL_POLICIES.join(' | ')}`)
    }
    if (params.preset !== undefined) {
      if (typeof params.preset !== 'string' || params.preset.length === 0) {
        throw new RpcFailure(INVALID_PARAMS, 'session/authority: "preset" must be a preset name')
      }
      if (params.sandbox !== undefined || params.approval !== undefined) {
        throw new RpcFailure(INVALID_PARAMS, 'session/authority: "preset" replaces "sandbox"/"approval"; give one or the other')
      }
      const presets = this.ctx.tryGet(PRESETS)
      if (!presets) throw new RpcFailure(INVALID_PARAMS, 'this composition has no authority-presets capability')
      try {
        presets.apply(agent.session, params.preset)
      } catch (error) {
        throw new RpcFailure(INVALID_PARAMS, error instanceof Error ? error.message : String(error))
      }
    }
    const sandbox = this.ctx.get(SANDBOX)
    const approval = this.ctx.get(APPROVAL)
    if (params.sandbox !== undefined) sandbox.setMode(agent.session, params.sandbox)
    if (params.approval !== undefined) approval.setPolicy(agent.session, params.approval)
    // Read through the pure fold, never through `resolve` — resolving is the
    // audit act of an effect boundary, and looking is not an effect.
    const mode = effectiveSandboxMode(agent.session.facts) ?? sandbox.defaultMode
    return this.withPreset({ sandbox: mode, approval: approval.policyFor(agent.session), enforcement: sandbox.enforcementFor(mode) })
  }

  /**
   * Read or switch a live session's BASE route. A switch IS its durable event
   * (`agent/options{change}`), so a client never holds route state of its own
   * — it reads the log like every other surface. The provider must be one
   * this host has an adapter for: a route to nowhere is refused here, not at
   * the next paid step.
   */
  private model(params: Record<string, unknown>): AgentOptions {
    const sessionId = requireString(params, 'sessionId', 'session/model')
    const agent = this.ctx.get(AGENTS).get(asSessionId(sessionId))
    if (!agent) throw new RpcFailure(INTERNAL_ERROR, `no live session "${sessionId}"`)
    const partial: { provider?: string; model?: string; reasoningEffort?: string } = {}
    for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
      const value = params[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.length === 0) throw new RpcFailure(INVALID_PARAMS, `session/model: "${key}" must be a non-empty string`)
      partial[key] = value
    }
    this.assertRoutable(partial, 'session/model')
    if (Object.keys(partial).length > 0) agent.configure(partial)
    return agent.options
  }

  /** A route names a provider this host serves, or it is refused before it can become a durable fact. */
  private assertRoutable(partial: Partial<AgentOptions>, method: string): void {
    if (partial.provider !== undefined && !this.ctx.get(LLM).hasProvider(partial.provider)) {
      throw new RpcFailure(INVALID_PARAMS, `${method}: no adapter for provider "${partial.provider}"`)
    }
  }

  private async prompt(params: Record<string, unknown>): Promise<PromptResult> {
    if (this.shuttingDown) throw new RpcFailure(INTERNAL_ERROR, 'the host is shutting down')
    const text = requireString(params, 'text', 'session/prompt')
    const mode = params.mode ?? 'followup'
    if (mode !== 'followup' && mode !== 'steer' && mode !== 'auto') {
      throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "mode" must be "followup", "steer" or "auto"')
    }
    const acquiring = this.acquire(params)
    this.inflight.add(acquiring)
    let agent: Agent
    try {
      agent = await acquiring
    } finally {
      this.inflight.delete(acquiring)
    }
    // A shutdown that raced this acquire has already swept `owned`: dispose the
    // straggler instead of starting a turn after shutdown was answered.
    if (this.shuttingDown) {
      const handle = this.owned.get(agent.id)
      if (handle) {
        this.owned.delete(agent.id)
        await handle.dispose()
      }
      throw new RpcFailure(INTERNAL_ERROR, 'the host is shutting down')
    }
    const message = createUserMessage(text)
    // `auto` is resolved HERE, against the live agent, in the same tick it is
    // delivered. A client choosing from an observed `session.status` is racing
    // turn-end with one client and cannot win with two.
    const target = mode === 'auto' ? (agent.status === 'running' ? 'steer' : 'followup') : mode
    if (target === 'steer') agent.steer(message)
    else agent.followup(message)
    return { sessionId: agent.id, messageId: message.id }
  }

  /** No id: create. Live id: deliver. Stored id: resume (concurrent prompts share the resume). */
  private async acquire(params: Record<string, unknown>): Promise<Agent> {
    const requested = params.sessionId
    if (requested !== undefined && typeof requested !== 'string') {
      throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "sessionId" must be a string')
    }
    const agents = this.ctx.get(AGENTS)
    const options = readAgentOptions(this.config.defaultAgentOptions, params.agentOptions, 'session/prompt')
    // A route to nowhere is refused here, on every path, rather than becoming
    // this session's recorded base and failing at its first paid step.
    this.assertRoutable(options.partial, 'session/prompt')
    const preset = this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset }
    const setup = this.config.setup === undefined ? {} : { setup: this.config.setup }
    if (requested === undefined) {
      const cwd = this.resolveCwd(params)
      const handle = await agents.create(this.ctx, { cwd, agentOptions: options.full, ...preset, ...setup })
      this.owned.set(handle.agent.id, handle)
      return handle.agent
    }
    const live = agents.get(asSessionId(requested))
    if (live) {
      // Options on a prompt to a LIVE session are the same durable switch
      // `session/model` makes: merged over the base, logged iff they differ.
      if (Object.keys(options.partial).length > 0) live.configure(options.partial)
      return live
    }
    let inflight = this.resuming.get(requested)
    if (!inflight) {
      inflight = agents
        .resume(this.ctx, asSessionId(requested), { agentOptions: options.partial, defaults: this.config.defaultAgentOptions, ...setup })
        .then((handle) => {
          this.owned.set(handle.agent.id, handle)
          return handle.agent
        })
        .finally(() => this.resuming.delete(requested))
      this.resuming.set(requested, inflight)
    }
    return inflight
  }

  private events(params: Record<string, unknown>): EventsResult {
    const sessionId = requireString(params, 'sessionId', 'session/events')
    const fromSeq = optionalCount(params, 'fromSeq', 'session/events') ?? 0
    const toSeq = optionalCount(params, 'toSeq', 'session/events')
    const limit = optionalCount(params, 'limit', 'session/events')
    if (params.omitTrace !== undefined && typeof params.omitTrace !== 'boolean') {
      throw new RpcFailure(INVALID_PARAMS, 'session/events: "omitTrace" must be a boolean')
    }
    const source = this.sourceFor(sessionId)
    // `slice(fromSeq)` is a seq-indexed slice: the log is a dense zero-based
    // prefix (§4), live and stored alike, and the session invariant refuses a
    // discontinuity before it enters the log.
    let events = source.events.slice(fromSeq, toSeq === undefined ? undefined : toSeq + 1)
    if (params.omitTrace === true) events = events.filter((event) => !TRACE_TYPES.has(event.type))
    if (limit !== undefined) events = events.slice(0, limit)
    return { header: source.header, events, ...(source.damaged ? { damaged: true as const } : {}) }
  }

  /**
   * Attach: the header, the folds a paged client cannot compute, a
   * message-aligned tail page, and the cursor it was cut against.
   *
   * There is no lower-bound cursor by design — a reconnecting client
   * re-attaches and replaces its window. The whole frame is built in ONE
   * synchronous window: `Session.events`/`facts` are the live arrays, and a
   * page taken on one side of an await with a cursor read on the other would
   * open a gap no dedup could see.
   */
  private attach(connection: ClientConnection, params: Record<string, unknown>): AttachResult {
    const sessionId = requireString(params, 'sessionId', 'session/attach')
    const limit = optionalCount(params, 'limit', 'session/attach')
    const source = this.sourceFor(sessionId)
    // Subscribe BEFORE the page is cut. A connection that started watching
    // afterwards would silently miss whatever landed in between; the client
    // drops anything at or below the cursor, so an overlap is free and a gap
    // is not.
    connection.attach(sessionId)
    const page = pageEvents(source.facts, { throughSeq: source.cursor, ...(limit === undefined ? {} : { maxMessages: limit }) })
    return {
      header: source.header,
      view: this.viewOf(source),
      page,
      cursor: source.cursor,
      ...(source.damaged ? { damaged: true as const } : {}),
    }
  }

  /**
   * Stop delivering one session's events to this client. The session is
   * untouched — but a client that stopped watching can no longer answer that
   * session's questions, so it leaves their answerer sets too.
   */
  private detach(connection: ClientConnection, params: Record<string, unknown>): Record<string, never> {
    const sessionId = requireString(params, 'sessionId', 'session/detach')
    connection.detach(sessionId)
    this.withdrawFromApprovals(connection, sessionId)
    return {}
  }

  /** An older page beneath a cut the client already holds. Identity and view come from the attach frame alone. */
  private page(params: Record<string, unknown>): PageResult {
    const sessionId = requireString(params, 'sessionId', 'session/page')
    const throughSeq = params.throughSeq
    if (typeof throughSeq !== 'number' || !Number.isInteger(throughSeq) || throughSeq < -1) {
      throw new RpcFailure(INVALID_PARAMS, 'session/page: "throughSeq" must be an integer >= -1')
    }
    const beforeSeq = optionalCount(params, 'beforeSeq', 'session/page')
    const limit = optionalCount(params, 'limit', 'session/page')
    const source = this.sourceFor(sessionId)
    // The anchor is a postcondition, not a hint: a page past the cut the client
    // synchronized on would silently interleave with its live tail.
    if (throughSeq > source.cursor) {
      throw new RpcFailure(INVALID_PARAMS, `session/page: "throughSeq" ${throughSeq} is past this session's cursor ${source.cursor}`)
    }
    return {
      page: pageEvents(source.facts, {
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(limit === undefined ? {} : { maxMessages: limit }),
      }),
    }
  }

  /**
   * The live session, or the stored one — and reading a stored one NEVER
   * resumes it. Observing a transcript must not start an agent: a reader who
   * opened a session to look at it would otherwise pay for a model, take its
   * write lease, and change what it was looking at.
   */
  private sourceFor(sessionId: string): SessionSource {
    const live = this.ctx.get(SESSIONS).get(asSessionId(sessionId))
    if (live) {
      return { header: live.header, events: live.events, facts: live.facts, cursor: live.seq - 1, agent: this.ctx.get(AGENTS).get(asSessionId(sessionId)) }
    }
    const cached = this.cold.get(sessionId)
    if (cached) {
      // Refresh recency: a reader paging backwards touches one session repeatedly.
      this.cold.delete(sessionId)
      this.cold.set(sessionId, cached)
      return cached
    }
    const stored = this.ctx.tryGet(PERSISTENCE)?.load(sessionId)
    if (!stored) throw new RpcFailure(INTERNAL_ERROR, `no session "${sessionId}"`)
    const source: SessionSource = {
      header: stored.header,
      events: stored.events,
      facts: stored.events.filter((event) => !TRACE_TYPES.has(event.type)),
      cursor: stored.events.length - 1,
      ...(stored.damaged ? { damaged: true as const } : {}),
    }
    // A cold read costs a whole-file parse (~167 ms and ~28 MB on a 400-turn
    // session), and backward paging asks for the same session again and again.
    this.cold.set(sessionId, source)
    while (this.cold.size > COLD_SOURCE_CACHE) this.cold.delete(this.cold.keys().next().value!)
    return source
  }

  /**
   * The folds a client holding only a page cannot do for itself, each computed
   * by whoever already owns it. Nothing here is new truth: every field is a
   * projection of durable facts.
   */
  private viewOf(source: SessionSource): SessionView {
    const facts = source.facts
    const sandbox = this.ctx.get(SANDBOX)
    const mode = effectiveSandboxMode(facts) ?? sandbox.defaultMode
    const authority = this.withPreset({
      sandbox: mode,
      approval: effectiveApprovalPolicy(facts) ?? this.ctx.get(APPROVAL).defaultPolicy,
      enforcement: sandbox.enforcementFor(mode),
    })
    const route = foldRequestContext(facts)
    const options = source.agent?.options ?? foldAgentOptions(facts)
    const window = route?.contextWindow ?? this.catalogWindow(options)
    return {
      status: source.agent?.status ?? 'idle',
      pendingApprovals: openApprovals(facts),
      authority,
      ...(options === undefined ? {} : { options }),
      ...(route === undefined ? {} : { route }),
      ...(window === undefined || window <= 0 ? {} : { context: meterSession(facts, window) }),
    }
  }

  /**
   * The window a route's adapter advertises, for a session that has not yet
   * written a `request/context`. The log's own record wins the moment there is
   * one — this only answers "before the first request".
   */
  private catalogWindow(options: AgentOptions | undefined): number | undefined {
    if (!options) return undefined
    const provider = this.ctx.get(LLM).providers().find((entry) => entry.id === options.provider)
    return provider?.models.find((model) => model.id === options.model)?.contextWindow
  }

  /**
   * Stop the running turn. `keepQueued` decides what happens to the durable
   * inbox, and the default is the single-client meaning MiniDSH has always had:
   * a person cancelling means "and forget what I asked for". A client that
   * knows it shares the session says `keepQueued: true`, because throwing away
   * another client's queued prompts is not its call to make.
   */
  private cancel(params: Record<string, unknown>): Record<string, never> {
    const sessionId = requireString(params, 'sessionId', 'session/cancel')
    if (params.keepQueued !== undefined && typeof params.keepQueued !== 'boolean') {
      throw new RpcFailure(INVALID_PARAMS, 'session/cancel: "keepQueued" must be a boolean')
    }
    const agent = this.ctx.get(AGENTS).get(asSessionId(sessionId))
    if (!agent) throw new RpcFailure(INTERNAL_ERROR, `no live session "${sessionId}"`)
    agent.cancel({ kind: 'user' }, { keepInbox: params.keepQueued === true })
    return {}
  }

  /**
   * Compaction is a HUMAN command, never a model-facing tool — the model does
   * not get to decide what it forgets. Read through `tryGet` so a composition
   * without the row answers honestly instead of failing the method.
   */
  private async compact(params: Record<string, unknown>): Promise<CompactResult> {
    const sessionId = requireString(params, 'sessionId', 'session/compact')
    const agent = this.ctx.get(AGENTS).get(asSessionId(sessionId))
    if (!agent) throw new RpcFailure(INTERNAL_ERROR, `no live session "${sessionId}"`)
    const compaction = this.ctx.tryGet(COMPACTION)
    if (!compaction) throw new RpcFailure(INTERNAL_ERROR, 'this host has no compaction capability mounted')
    return compaction.compactNow(agent)
  }

  private approvalAnswer(params: Record<string, unknown>): ApprovalAnswerResult {
    const sessionId = requireString(params, 'sessionId', 'approval/answer')
    const id = requireString(params, 'id', 'approval/answer')
    const outcome = params.outcome
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new RpcFailure(INVALID_PARAMS, 'approval/answer: "outcome" must be "allowed-once" or "rejected"')
    }
    const key = `${sessionId}:${id}`
    const pending = this.pendingApprovals.get(key)
    // First answer wins, whichever client sent it; every other client learns
    // the outcome from the durable `approval/decided` event, not from here.
    if (!pending) return { outcome: 'not-pending' }
    this.pendingApprovals.delete(key)
    pending.settle(outcome)
    return { outcome: 'accepted' }
  }

  /** Dispose-to-idle: owned turns close as `cancelled` and flush; durable queues survive for the next resume. */
  private async shutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    // Drain acquires racing the shutdown before sweeping, and sweep again for
    // whatever they registered; `shuttingDown` stops new acquires at the door.
    while (this.inflight.size > 0 || this.owned.size > 0) {
      if (this.inflight.size > 0) await Promise.allSettled(this.inflight)
      const handles = [...this.owned.values()]
      this.owned.clear()
      for (const handle of handles) await handle.dispose()
    }
    return {}
  }

  /** Idempotent: fail pending approvals closed, drop every connection, then tell the app the surface is done. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pendingApprovals.values()) pending.settle('unavailable')
    this.pendingApprovals.clear()
    for (const connection of this.connections) connection.close()
    this.connections.clear()
    this.config.onClose?.()
  }
}
