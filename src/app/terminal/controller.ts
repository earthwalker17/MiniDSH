/**
 * The protocol side of the terminal, shared by its two views (the line view
 * for pipes and `--plain`, the full-screen view for a terminal): everything
 * the terminal SAYS to the host and everything it must remember to say it
 * correctly. It hands its views data — events, views, questions, results —
 * and never formats a line; how those look is each view's.
 *
 * The rules it keeps (ARCHITECTURE §8, each with a test):
 * - **A protocol client.** It reaches a session only over the wire: a resume
 *   or a fork is `session/resume` or `session/fork`, never the host's registry.
 * - **Watching.** It attaches its OWN session as soon as it knows the id —
 *   after the first prompt creates one, or a continuation — before any child,
 *   because a connection's first attach narrows it to what it attached. And it
 *   subscribes to the control plane, so an ask raised before that attach (a
 *   resumed session waking on its restored inbox) parks for this client
 *   instead of settling `unavailable` (`couldAnswer`).
 * - **Ordering.** Live rendering starts at the attach cut plus one; frames that
 *   arrive while an attach is in flight wait and replay after it, so nothing is
 *   shown twice or skipped. Older pages come through `session/page` against
 *   the same cut.
 * - **Consent.** A question is asked on its durable frame, a microtask later,
 *   and only if nothing decided it in the same tick (the durable `never` and a
 *   matching grant append both at once); an offer is shown only where the
 *   host's fold made it.
 * - **Children are read-only.** A child is attached to WATCH it; no driving
 *   method is ever sent for one.
 * - **Switching.** `/new`, `/resume` and `/fork` replace the session this
 *   terminal shows only when nothing would be stranded: not while it runs,
 *   asks, or has a job running. The session left behind stays live and idle
 *   until the terminal exits (ARCHITECTURE §13).
 */
import type { AgentOptions } from '../../core/agent/index.ts'
import type { ApprovalOfferId, ApprovedCall } from '../../core/approval/index.ts'
import type { EffectIntent } from '../../core/effects/index.ts'
import { matches, type EventEnvelope, type SessionEventFrame } from '../../core/session/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED } from '../../core/approval/index.ts'
import type {
  ApprovalAnswerResult,
  AttachResult,
  AuthorityView,
  CompactResult,
  ContinueResult,
  InitializeResult,
  JobCancelResult,
  JobSummary,
  ModelResult,
  PageResult,
  PromptResult,
  SessionView,
  SessionSummary,
  SessionsListResult,
} from '../../capabilities/protocol/index.ts'
import type { ProtocolClient } from './client.ts'

export type Status = 'idle' | 'running'

/** A question the person must answer, as the views draw it. */
export interface Ask {
  readonly id: string
  readonly toolName: string
  readonly reason?: string
  readonly subject?: EffectIntent
  readonly call?: ApprovedCall
  /** The host's fold offered `grant-session` on this ask. */
  readonly offered: boolean
}

/** Why the views are being handed a page: a continuation shows it; the first prompt's own attach does not. */
export type AttachReason = 'resumed' | 'forked' | 'created' | 'switched'

export interface Attached {
  readonly reason: AttachReason
  readonly result: AttachResult
  /** For a fork: the session it was branched from. */
  readonly from?: string
}

export interface ControllerHooks {
  /** A live frame: the attached session's at or past the cut, or an attached child's. */
  readonly onEvent: (sessionId: string, event: EventEnvelope) => void
  readonly onStatus: (status: Status) => void
  readonly onView: (view: SessionView) => void
  readonly onAttached: (attached: Attached) => void
  readonly onAsk: (ask: Ask) => void
  readonly onDecided: (id: string) => void
  /** Notices an IDLE session holds that no one has been told about yet. */
  readonly onHeld: (jobs: readonly JobSummary[]) => void
  /** The host went away. */
  readonly onClosed: () => void
}

export interface ContinueRequest {
  readonly kind: 'resume' | 'fork'
  readonly sessionId: string
  readonly atSeq?: number
  readonly salvage?: boolean
  /** The launch's explicit model flags: sent with a CLI continuation, never with an in-place one. */
  readonly agentOptions?: Partial<AgentOptions>
}

/** A refusal the controller decides before sending anything. */
export class NotNow extends Error {}

export class SessionController {
  readonly client: ProtocolClient
  private readonly hooks: ControllerHooks
  private readonly overrides: Partial<AgentOptions>
  init: InitializeResult | undefined
  sessionId: string | undefined
  status: Status = 'idle'
  view: SessionView | undefined
  /** Where `older()` reads from: the cut this client attached on, and the oldest event it holds. */
  history: { cursor: number; oldest: number; hasMore: boolean } | undefined
  private liveFrom = 0
  /** The newest seq delivered for the current session: every frame reaches a view once. */
  private lastSeq = -1
  /** While the first prompt creates the session, every frame waits: its id is not known yet. */
  private creating: SessionEventFrame[] | undefined
  /** Frames for the session being attached, held until its cut is known. */
  private attaching: { sessionId: string; held: SessionEventFrame[] } | undefined
  private readonly children = new Set<string>()
  private readonly answered = new Set<string>()
  /**
   * The questions this session has open, oldest first: the view shows the
   * head. Two calls can ask at once (a body that asks while a sibling's
   * does), and answering one must bring the next back, not lose it.
   */
  private readonly queue: Ask[] = []
  /** Ids queued or waiting for their microtask, so a re-delivery or an attach never asks twice. */
  private readonly queued = new Set<string>()
  private readonly hinted = new Set<string>()

  constructor(client: ProtocolClient, hooks: ControllerHooks, overrides: Partial<AgentOptions> = {}) {
    this.client = client
    this.hooks = hooks
    this.overrides = overrides
  }

  /** The one entry for every notification the client receives. */
  onNotification(method: string, params: unknown): void {
    if (method === 'session.event') {
      const frame = params as SessionEventFrame
      if (this.creating !== undefined) {
        this.creating.push(frame)
        return
      }
      if (this.attaching?.sessionId === frame.sessionId) {
        this.attaching.held.push(frame)
        return
      }
      if (this.children.has(frame.sessionId)) {
        this.hooks.onEvent(frame.sessionId, frame.event)
        return
      }
      // Before this terminal has a session, a fresh chat watches everything;
      // it shows only frames that turn out to be its own.
      if (this.sessionId !== undefined && frame.sessionId !== this.sessionId) return
      if (this.sessionId === undefined) return
      this.deliver(frame)
    } else if (method === 'session.status') {
      const projected = params as { sessionId: string; status: Status }
      if (projected.sessionId !== this.sessionId) return
      this.status = projected.status
      // The held notice first, so a view can say it above the prompt that follows.
      if (this.status === 'idle') this.hintHeld()
      this.hooks.onStatus(this.status)
    } else if (method === 'session.view') {
      const projected = params as { sessionId: string; view: SessionView }
      if (projected.sessionId !== this.sessionId) return
      this.view = projected.view
      this.hooks.onView(projected.view)
      this.hintHeld()
    }
  }

  private deliver(frame: SessionEventFrame): void {
    if (frame.event.seq < this.liveFrom || frame.event.seq <= this.lastSeq) return
    this.lastSeq = frame.event.seq
    this.hooks.onEvent(frame.sessionId, frame.event)
    if (matches(frame.event, APPROVAL_ASKED)) this.ask(frame.event.data)
    else if (matches(frame.event, APPROVAL_DECIDED)) this.settle(frame.event.data.id)
  }

  /** A question decided (here, elsewhere, or by nobody): off the queue, and the next one up. */
  private settle(id: string): void {
    this.answered.add(id)
    this.queued.delete(id)
    const at = this.queue.findIndex((ask) => ask.id === id)
    if (at !== -1) this.queue.splice(at, 1)
    this.hooks.onDecided(id)
    if (at === 0 && this.queue.length > 0) this.hooks.onAsk(this.queue[0]!)
  }

  /**
   * Asked a microtask later, and skipped if a decision has already landed:
   * a decision nobody had to make arrives in the same tick as its question.
   */
  private ask(data: { id: string; toolName: string; reason?: string; subject?: EffectIntent; call?: ApprovedCall; offers?: readonly ApprovalOfferId[] }): void {
    if (this.answered.has(data.id) || this.queued.has(data.id)) return
    this.queued.add(data.id)
    queueMicrotask(() => {
      if (this.answered.has(data.id)) {
        this.queued.delete(data.id)
        return
      }
      // Offers come from the fold, never from here: the view names only what
      // the runtime says is available. The attach path carries them; live, the
      // view published in the same tick does.
      const open = this.view?.pendingApprovals.find((entry) => entry.id === data.id)
      const offered = data.offers?.includes('grant-session') === true || open?.offers?.includes('grant-session') === true
      const call = data.call ?? open?.call
      this.queue.push({
        id: data.id,
        toolName: data.toolName,
        ...(data.reason === undefined ? {} : { reason: data.reason }),
        ...(data.subject === undefined ? {} : { subject: data.subject }),
        ...(call === undefined ? {} : { call }),
        offered,
      })
      if (this.queue.length === 1) this.hooks.onAsk(this.queue[0]!)
    })
  }

  /** The question this client shows now, if any. */
  get asked(): string | undefined {
    return this.queue[0]?.id
  }

  /** How many questions are open here, the one shown included. */
  get askCount(): number {
    return this.queue.length
  }

  /**
   * Held job notices the person has not been told about: a stop a person or
   * the runtime caused never wakes the agent, so without a word the end would
   * sit unread until the next prompt.
   */
  private hintHeld(): void {
    if (this.status !== 'idle' || this.attaching !== undefined || this.queue.length > 0 || this.sessionId === undefined) return
    const fresh = (this.view?.jobs ?? []).filter((job) => job.held === true && !this.hinted.has(job.jobId))
    if (fresh.length === 0) return
    for (const job of fresh) this.hinted.add(job.jobId)
    this.hooks.onHeld(fresh)
  }

  async start(): Promise<InitializeResult> {
    this.init = await this.client.request<InitializeResult>('initialize')
    // Counted as a possible answerer for every session's questions, so one
    // raised before this client's attach parks rather than failing.
    await this.client.request('control/subscribe', {})
    return this.init
  }

  /** Attach a session and make it this terminal's: page, cut, view, then the frames held meanwhile. */
  private async attach(sessionId: string, reason: AttachReason, from?: string): Promise<AttachResult> {
    this.attaching = { sessionId, held: [] }
    let result: AttachResult
    try {
      result = await this.client.request<AttachResult>('session/attach', { sessionId })
    } catch (error) {
      this.attaching = undefined
      throw error
    }
    const held = this.attaching.held
    this.attaching = undefined
    this.sessionId = sessionId
    this.history = { cursor: result.cursor, oldest: result.page.from, hasMore: result.page.hasMore }
    this.view = result.view
    this.status = result.view.status
    // A continuation's views draw its page, so live frames start past the cut.
    // The first prompt's session streamed from its first frame, so nothing is
    // cut: the held frames replay past what was already delivered.
    if (reason !== 'created') {
      this.liveFrom = result.cursor + 1
      this.lastSeq = result.cursor
      this.answered.clear()
      this.queued.clear()
      this.queue.length = 0
    }
    this.hooks.onAttached({ reason, result, ...(from === undefined ? {} : { from }) })
    // The status the attach reports, as if it had arrived: a fresh session's
    // first `running` came before its id was known, and was not this client's yet.
    this.hooks.onStatus(this.status)
    // A prompt asked and never decided still needs an answer; the host folds
    // that pair, because half of it can fall outside a page.
    for (const pending of result.view.pendingApprovals) this.ask(pending)
    for (const frame of held) this.deliver(frame)
    this.hintHeld()
    return result
  }

  /** `minidsh resume|fork`: the session this terminal opens with. */
  async continueSession(request: ContinueRequest): Promise<AttachResult> {
    const continued = await this.client.request<ContinueResult>(request.kind === 'resume' ? 'session/resume' : 'session/fork', {
      sessionId: request.sessionId,
      ...(request.agentOptions === undefined || Object.keys(request.agentOptions).length === 0 ? {} : { agentOptions: request.agentOptions }),
      ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }),
      ...(request.salvage === true ? { salvage: true } : {}),
    })
    return this.attach(continued.sessionId, request.kind === 'resume' ? 'resumed' : 'forked', request.kind === 'fork' ? request.sessionId : undefined)
  }

  /**
   * A line the person sent. `auto`: the HOST decides steer or followup in the
   * tick it delivers — choosing here from an observed status races turn-end.
   * The first one creates the session, which this terminal then attaches.
   */
  async submit(text: string): Promise<PromptResult> {
    if (this.sessionId !== undefined) return this.client.request<PromptResult>('session/prompt', { text, sessionId: this.sessionId, mode: 'auto' })
    this.creating = []
    let result: PromptResult
    try {
      result = await this.client.request<PromptResult>('session/prompt', { text, agentOptions: this.overrides })
    } catch (error) {
      this.creating = undefined
      throw error
    }
    // The frames that streamed to this still un-narrowed client while the
    // session was being made are its own: delivered now, from its first, and
    // the attach then narrows the watch to it.
    const early = this.creating
    this.creating = undefined
    this.sessionId = result.sessionId
    this.liveFrom = 0
    this.lastSeq = -1
    for (const frame of early) if (frame.sessionId === result.sessionId) this.deliver(frame)
    await this.attach(result.sessionId, 'created')
    return result
  }

  /** The decided frame takes the question off the queue; one already decided elsewhere comes off now. */
  async answer(id: string, outcome: 'allowed-once' | 'rejected', offer?: 'grant-session'): Promise<ApprovalAnswerResult> {
    const result = await this.client.request<ApprovalAnswerResult>('approval/answer', { sessionId: this.sessionId, id, outcome, ...(offer === undefined ? {} : { offer }) })
    if (result.outcome === 'not-pending' && !this.answered.has(id)) this.settle(id)
    return result
  }

  /** Stops the running turn. `keepQueued`: what the person queued meanwhile survives (the browser's choice). */
  async cancel(keepQueued: boolean): Promise<boolean> {
    if (this.sessionId === undefined || this.status !== 'running') return false
    await this.client.request('session/cancel', { sessionId: this.sessionId, ...(keepQueued ? { keepQueued: true } : {}) })
    return true
  }

  private requireSession(): string {
    if (this.sessionId === undefined) throw new NotNow('no session yet - send a prompt first')
    return this.sessionId
  }

  compact(): Promise<CompactResult> {
    return this.client.request<CompactResult>('session/compact', { sessionId: this.requireSession() })
  }

  /** `/model [provider/]model [effort]`; nothing named reads the route. */
  model(target: string | undefined, effort: string | undefined): Promise<ModelResult> {
    const params: Record<string, string> = { sessionId: this.requireSession() }
    if (target) {
      const slash = target.indexOf('/')
      if (slash > 0) {
        params.provider = target.slice(0, slash)
        params.model = target.slice(slash + 1)
      } else params.model = target
    }
    if (effort) params.reasoningEffort = effort
    return this.client.request<ModelResult>('session/model', params)
  }

  /** One authority switch, as its durable event: `{sandbox|approval|accepts|preset: value}`. */
  authority(switches: Record<string, string>): Promise<AuthorityView> {
    return this.client.request<AuthorityView>('session/authority', { sessionId: this.requireSession(), ...switches })
  }

  grants(): Promise<AuthorityView> {
    return this.client.request<AuthorityView>('session/authority', { sessionId: this.requireSession() })
  }

  revoke(grantId: string): Promise<{ revoked: boolean }> {
    return this.client.request<{ revoked: boolean }>('approval/revoke', { sessionId: this.requireSession(), grantId })
  }

  cancelJob(jobId: string): Promise<JobCancelResult> {
    return this.client.request<JobCancelResult>('job/cancel', { sessionId: this.requireSession(), jobId })
  }

  async sessions(): Promise<readonly SessionSummary[]> {
    return (await this.client.request<SessionsListResult>('sessions/list')).sessions
  }

  /** One page further back, against the cut this client attached on. Undefined when there is nothing older. */
  async older(): Promise<PageResult['page'] | undefined> {
    if (this.sessionId === undefined || this.history === undefined || !this.history.hasMore) return undefined
    const { page } = await this.client.request<PageResult>('session/page', { sessionId: this.sessionId, throughSeq: this.history.cursor, beforeSeq: this.history.oldest })
    this.history = { cursor: this.history.cursor, oldest: page.from, hasMore: page.hasMore }
    return page
  }

  /** Why this terminal cannot leave the session it shows right now, or undefined. */
  switchRefusal(): string | undefined {
    if (this.status === 'running') return 'the turn is still running: cancel it first (Esc)'
    if (this.queue.length > 0 || (this.view?.pendingApprovals.length ?? 0) > 0) return 'a question is waiting for an answer'
    if ((this.view?.jobs ?? []).some((job) => job.state === 'running')) return 'a background job is running: stop it first (/jobs)'
    return undefined
  }

  /**
   * Replace the session this terminal shows: a stored or listed one resumed,
   * the current one forked at its head, or none (the next prompt creates one).
   * The new session is attached before the old one is detached, so the
   * connection never watches nothing.
   */
  async switchTo(target: { kind: 'resume'; sessionId: string } | { kind: 'fork' } | { kind: 'new' }): Promise<AttachResult | undefined> {
    const refusal = this.switchRefusal()
    if (refusal !== undefined) throw new NotNow(refusal)
    const old = this.sessionId
    for (const child of Array.from(this.children)) await this.unwatchChild(child)
    if (target.kind === 'new') {
      if (old !== undefined) await this.client.request('session/detach', { sessionId: old })
      this.sessionId = undefined
      this.view = undefined
      this.history = undefined
      this.status = 'idle'
      this.liveFrom = 0
      this.lastSeq = -1
      this.answered.clear()
      this.queued.clear()
      this.queue.length = 0
      return undefined
    }
    let id: string
    if (target.kind === 'fork') {
      const source = this.requireSession()
      id = (await this.client.request<ContinueResult>('session/fork', { sessionId: source })).sessionId
    } else {
      if (target.sessionId === old) throw new NotNow('that is the session already open')
      id = (await this.client.request<ContinueResult>('session/resume', { sessionId: target.sessionId })).sessionId
    }
    const result = await this.attach(id, target.kind === 'fork' ? 'forked' : 'switched', target.kind === 'fork' ? old : undefined)
    if (old !== undefined && old !== id) await this.client.request('session/detach', { sessionId: old })
    return result
  }

  /** Watch a running child read-only: its page, then its live frames through `onEvent`. */
  async watchChild(childId: string, limit = 40): Promise<AttachResult | undefined> {
    if (this.children.has(childId) || this.sessionId === undefined) return undefined
    this.children.add(childId)
    try {
      return await this.client.request<AttachResult>('session/attach', { sessionId: childId, limit })
    } catch {
      this.children.delete(childId)
      return undefined
    }
  }

  async unwatchChild(childId: string): Promise<void> {
    if (!this.children.delete(childId)) return
    await this.client.request('session/detach', { sessionId: childId }).catch(() => {})
  }

  get watching(): readonly string[] {
    return [...this.children]
  }

  closed(): void {
    this.hooks.onClosed()
  }
}
