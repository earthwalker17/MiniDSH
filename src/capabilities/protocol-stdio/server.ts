/**
 * The protocol host: JSON-RPC method handlers, the live control plane a wire
 * needs beyond durable events — the status projection, approval prompts as
 * answerable frames keyed by the durable `approval/asked` id (a host-side
 * pending table, first answer wins), cancel/steer — and the ownership of
 * agents created over the wire. Approval frames have no notification of their
 * own: the durable `approval/asked`/`approval/decided` events streaming over
 * `session.event` ARE the frames.
 */
import type { Context } from '../../kernel/index.ts'
import { AGENTS, type Agent, type AgentHandle, type AgentOptions } from '../../core/agent/index.ts'
import { APPROVAL, APPROVAL_DECIDED, APPROVAL_POLICIES, isApprovalPolicy, type ApprovalOutcome, type ApprovalPrompt } from '../../core/approval/index.ts'
import { COMPACTION } from '../../core/compaction/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { LLM } from '../../core/llm/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { PERSISTENCE } from '../../core/persistence/index.ts'
import { PRESETS } from '../../core/presets/index.ts'
import { effectiveSandboxMode, isSandboxMode, SANDBOX, SANDBOX_MODES } from '../../core/sandbox/index.ts'
import { SESSIONS, matches, type EventEnvelope, type Session } from '../../core/session/index.ts'
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  RpcFailure,
  type ApprovalAnswerResult,
  type AuthorityView,
  type CompactResult,
  type EventsResult,
  type InitializeResult,
  type PromptResult,
  type RpcNotification,
  type RpcResponse,
} from './frames.ts'

export interface ProtocolServerConfig {
  readonly cwd: string
  readonly defaultAgentOptions: AgentOptions
  readonly serverVersion: string
  /** Applied to every agent this surface creates or resumes. */
  readonly setup?: (agentCtx: Context) => void | Promise<void>
  /** Called once, when the protocol is done (shutdown answered, or the input ended). */
  readonly onClose?: () => void
}

type Emit = (frame: RpcResponse | RpcNotification) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(params: Record<string, unknown>, key: string, method: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) throw new RpcFailure(INVALID_PARAMS, `${method}: "${key}" must be a non-empty string`)
  return value
}

/** Overrides merged over defaults, undefined values never clobbering. */
function mergeAgentOptions(defaults: AgentOptions, overrides: unknown, method: string): { full: AgentOptions; partial: Partial<AgentOptions> } {
  if (overrides !== undefined && !isRecord(overrides)) throw new RpcFailure(INVALID_PARAMS, `${method}: "agentOptions" must be an object`)
  const partial: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) partial[key] = value
  }
  return { full: { ...defaults, ...partial } as AgentOptions, partial: partial as Partial<AgentOptions> }
}

export class ProtocolServer {
  private readonly ctx: Context
  private readonly config: ProtocolServerConfig
  private readonly emit: Emit
  /** Answerable approval frames, keyed by `sessionId:durableId`. First answer wins. */
  private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>()
  /** Agents this protocol created (and therefore owns), by session id. */
  private readonly owned = new Map<string, AgentHandle>()
  /** In-flight resumes, so concurrent prompts for one stored id share a transaction. */
  private readonly resuming = new Map<string, Promise<Agent>>()
  /** Every in-flight acquire, so shutdown can drain creations racing it. */
  private readonly inflight = new Set<Promise<Agent>>()
  private closed = false
  private shuttingDown = false

  constructor(ctx: Context, config: ProtocolServerConfig, emit: Emit) {
    this.ctx = ctx
    this.config = config
    this.emit = emit
  }

  // ---- outbound: the two notifications ------------------------------------

  onSessionEvent(session: Session, event: EventEnvelope): void {
    if (this.closed) return
    this.emit({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: session.id, event } })
    // The durable decision settles the answerable frame, whoever decided it.
    if (matches(event, APPROVAL_DECIDED)) this.pendingApprovals.delete(`${session.id}:${event.data.id}`)
  }

  onAgentStatus(agent: Agent, status: 'idle' | 'running'): void {
    if (this.closed) return
    this.emit({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: agent.id, status } })
  }

  /** The `approval/request` answerer: park the prompt for the client; delegate when no client can answer. */
  answerApproval(prompt: ApprovalPrompt, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (this.closed) return next()
    return new Promise<ApprovalOutcome>((resolve) => {
      this.pendingApprovals.set(`${prompt.agent.id}:${prompt.id}`, resolve)
    })
  }

  // ---- inbound ------------------------------------------------------------

  async onFrame(frame: unknown): Promise<void> {
    if (!isRecord(frame) || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') return
    const id = frame.id
    if (typeof id !== 'number' && typeof id !== 'string') return // a client notification; none are defined
    try {
      const result = await this.dispatch(frame.method, frame.params)
      this.emit({ jsonrpc: '2.0', id, result })
      if (frame.method === 'shutdown') this.close()
    } catch (error) {
      const failure =
        error instanceof RpcFailure
          ? { code: error.code, message: error.message }
          : { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) }
      this.emit({ jsonrpc: '2.0', id, error: failure })
    }
  }

  private dispatch(method: string, params: unknown): Promise<unknown> | unknown {
    const record = isRecord(params) ? params : {}
    switch (method) {
      case 'initialize':
        return this.initialize()
      case 'session/prompt':
        return this.prompt(record)
      case 'session/events':
        return this.events(record)
      case 'session/cancel':
        return this.cancel(record)
      case 'session/compact':
        return this.compact(record)
      case 'approval/answer':
        return this.approvalAnswer(record)
      case 'session/authority':
        return this.authority(record)
      case 'shutdown':
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
    }
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

  private async prompt(params: Record<string, unknown>): Promise<PromptResult> {
    if (this.shuttingDown) throw new RpcFailure(INTERNAL_ERROR, 'the host is shutting down')
    const text = requireString(params, 'text', 'session/prompt')
    const mode = params.mode ?? 'followup'
    if (mode !== 'followup' && mode !== 'steer') throw new RpcFailure(INVALID_PARAMS, 'session/prompt: "mode" must be "followup" or "steer"')
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
    if (mode === 'steer') agent.steer(message)
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
    const options = mergeAgentOptions(this.config.defaultAgentOptions, params.agentOptions, 'session/prompt')
    const setup = this.config.setup === undefined ? {} : { setup: this.config.setup }
    if (requested === undefined) {
      const cwd = typeof params.cwd === 'string' ? params.cwd : this.config.cwd
      const handle = await agents.create(this.ctx, { cwd, agentOptions: options.full, ...setup })
      this.owned.set(handle.agent.id, handle)
      return handle.agent
    }
    const live = agents.get(asSessionId(requested))
    if (live) return live
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
    const fromSeq = params.fromSeq ?? 0
    if (typeof fromSeq !== 'number' || !Number.isInteger(fromSeq) || fromSeq < 0) {
      throw new RpcFailure(INVALID_PARAMS, 'session/events: "fromSeq" must be a non-negative integer')
    }
    const live = this.ctx.get(SESSIONS).get(asSessionId(sessionId))
    if (live) return { header: live.header, events: live.events.slice(fromSeq) }
    const stored = this.ctx.tryGet(PERSISTENCE)?.load(sessionId)
    if (!stored) throw new RpcFailure(INTERNAL_ERROR, `no session "${sessionId}"`)
    return { header: stored.header, events: stored.events.slice(fromSeq), ...(stored.damaged ? { damaged: true as const } : {}) }
  }

  private cancel(params: Record<string, unknown>): Record<string, never> {
    const sessionId = requireString(params, 'sessionId', 'session/cancel')
    const agent = this.ctx.get(AGENTS).get(asSessionId(sessionId))
    if (!agent) throw new RpcFailure(INTERNAL_ERROR, `no live session "${sessionId}"`)
    agent.cancel({ kind: 'user' })
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
    const resolve = this.pendingApprovals.get(key)
    if (!resolve) return { outcome: 'not-pending' }
    this.pendingApprovals.delete(key)
    resolve(outcome)
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

  /** Idempotent: fail pending approvals closed, then tell the app the surface is done. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const resolve of this.pendingApprovals.values()) resolve('unavailable')
    this.pendingApprovals.clear()
    this.config.onClose?.()
  }
}
