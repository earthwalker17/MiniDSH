/**
 * The approval seam. The model proposes an action; an answerer decides. The
 * default is fail-closed (`unavailable`), a grant is one-shot, and every
 * decision is an audit pair in the session log — never in the model transcript.
 *
 * The session also carries a durable `ApprovalPolicy`: `never` is the strict
 * unattended stance and is enforced INSIDE the service, before dispatch, so
 * that an answerer registered later (even with `prepend`) cannot reopen the
 * gate. Like the sandbox mode, a switch IS its event.
 */
import { z } from 'zod'
import { serviceKey, waterfallEvent, type Plugin } from '../../kernel/index.ts'
import { AGENT_CREATED } from '../agent/events.ts'
import type { Agent } from '../agent/types.ts'
import type { CallId } from '../ids.ts'
import type { Session } from '../session/index.ts'
import type { EventEnvelope } from '../session/types.ts'
import {
  APPROVAL_ASKED,
  APPROVAL_DECIDED,
  APPROVAL_POLICIES,
  APPROVAL_POLICY,
  delegationPin,
  effectiveApprovalPolicy,
  isApprovalOutcome,
  type ApprovalOutcome,
  type ApprovalPolicy,
} from './events.ts'

export * from './events.ts'

export type ApprovalErrorCode = 'APPROVAL_PINNED' | 'APPROVAL_ALREADY_OPEN'

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode
  constructor(code: ApprovalErrorCode, message: string) {
    super(message)
    this.name = 'ApprovalError'
    this.code = code
  }
}

export interface ApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: CallId
  readonly reason?: string
  readonly signal?: AbortSignal
}

/**
 * A `reason` is the requester's justification for an action, and the shell's
 * comes from the MODEL: unbounded free text that a terminal renders straight
 * into the `[y/N]` line a person is about to answer. A terminal executes what
 * it is written, so a `\r\x1b[2K` in it erases that line and repaints a
 * different, milder question above the same keystroke — the grant would be
 * real and its description a forgery. Neutralized and clamped HERE, before it
 * enters the log, because the log is what every surface renders and because
 * one place is the only way a future requester cannot reintroduce it. The
 * model's exact words stay durable in the `tool/call` arguments beside it.
 */
const REASON_MAX_CHARS = 300
function safeReason(text: string): string {
  let flat = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    flat += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch
  }
  const oneLine = flat.replace(/\s+/gu, ' ').trim()
  return oneLine.length > REASON_MAX_CHARS ? `${oneLine.slice(0, REASON_MAX_CHARS - 1)}…` : oneLine
}

/**
 * What answerers see: the request plus its durable id — the same id the
 * `approval/asked` audit event carries, so a surface can correlate a live
 * prompt with the log and echo the id back in its answer.
 */
export interface ApprovalPrompt extends ApprovalRequest {
  readonly id: string
}

export interface Approval {
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
  /** The durable switch. Appends `approval/policy` iff the policy actually changes; refused on a delegated session, whose policy is pinned. */
  setPolicy(session: Session, policy: ApprovalPolicy): ApprovalPolicy
  /**
   * Records the policy a session opens under, iff nothing is recorded yet — so
   * every decision is preceded by the policy that governed it, and the audit
   * reads what the session started under. Called at `agent/created`.
   *
   * With an `opening`, the explicit form a creator uses BEFORE publication
   * (in `setup`): a delegated child opens pinned, `reason: 'delegation'`.
   * Refused if the session has already recorded a policy.
   */
  open(session: Session, opening?: { readonly policy: ApprovalPolicy; readonly reason: 'delegation' }): void
  /** The policy governing a session: its last recorded one, else the deployment default. */
  policyFor(session: Session | undefined): ApprovalPolicy
  readonly defaultPolicy: ApprovalPolicy
}

export const APPROVAL = serviceKey<Approval>('approval')

/** Answerer chain; first non-delegating listener wins. Default thunk returns `unavailable`. */
export const APPROVAL_REQUEST = waterfallEvent<[prompt: ApprovalPrompt], Promise<ApprovalOutcome>>('approval/request')

class ApprovalService implements Approval {
  readonly defaultPolicy: ApprovalPolicy
  constructor(defaultPolicy: ApprovalPolicy) {
    this.defaultPolicy = defaultPolicy
  }

  policyFor(session: Session | undefined): ApprovalPolicy {
    return (session ? effectiveApprovalPolicy(session.facts) : undefined) ?? this.defaultPolicy
  }

  open(session: Session, opening?: { readonly policy: ApprovalPolicy; readonly reason: 'delegation' }): void {
    const recorded = effectiveApprovalPolicy(session.facts)
    if (opening === undefined) {
      if (recorded !== undefined) return
      session.append(APPROVAL_POLICY, { policy: this.defaultPolicy, reason: 'initial' })
      return
    }
    if (recorded !== undefined) throw new ApprovalError('APPROVAL_ALREADY_OPEN', `session ${session.id} has already recorded its opening approval policy`)
    session.append(APPROVAL_POLICY, { policy: opening.policy, reason: opening.reason })
  }

  setPolicy(session: Session, policy: ApprovalPolicy): ApprovalPolicy {
    const pin = delegationPin(session.facts)
    if (pin !== undefined && policy !== pin) {
      throw new ApprovalError('APPROVAL_PINNED', `session ${session.id} was delegated with approvals pinned to "${pin}" and cannot be switched to "${policy}"`)
    }
    // Record what the session started under BEFORE the change, exactly as the
    // sandbox does: the audit then reads "started X, then changed to Y".
    this.open(session)
    const previous = effectiveApprovalPolicy(session.facts)
    if (previous === policy) return policy
    session.append(APPROVAL_POLICY, { policy, reason: 'change' })
    return policy
  }

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = request.agent.session
    // A decision is preceded by the policy that governs it, always.
    this.open(session)
    // The id is the asked event's own seq: unique within the session for its whole
    // lifetime (across resume and fork), with no in-memory counter to reset.
    const id = `approval-${session.seq}`
    const reason = request.reason === undefined ? undefined : safeReason(request.reason)
    session.append(APPROVAL_ASKED, {
      id,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
    })
    // A request cancelled before it could be asked is decided without consulting
    // anyone: no answerer should ever see a prompt whose outcome is already fixed.
    if (request.signal?.aborted) {
      session.append(APPROVAL_DECIDED, { id, outcome: 'cancelled' })
      return 'cancelled'
    }
    // The strict unattended stance: refuse without consulting anyone. Enforced
    // here, before dispatch, so no answerer can be composed around it.
    if (this.policyFor(session) === 'never') {
      session.append(APPROVAL_DECIDED, { id, outcome: 'rejected' })
      return 'rejected'
    }
    // The prompt carries the SAME reason the log does: an answerer must never
    // be shown text a reader of the audit could not have seen.
    const prompt: ApprovalPrompt = { ...request, id, ...(reason === undefined ? {} : { reason }) }
    let outcome: ApprovalOutcome
    try {
      // Dispatched in the requesting agent's scope: an answerer registered through
      // one agent's context never answers for another agent. The seam, not the
      // answerer, owns cancellation: an aborted signal settles the request even
      // if an answerer (a disconnected client) never does.
      const answer = Promise.resolve(request.agent.ctx.waterfall(APPROVAL_REQUEST, prompt, async () => 'unavailable' as ApprovalOutcome))
      outcome = await settleOrCancel(answer, request.signal)
      if (!isApprovalOutcome(outcome)) outcome = 'unavailable'
    } catch {
      outcome = 'unavailable'
    }
    if (request.signal?.aborted) outcome = 'cancelled'
    session.append(APPROVAL_DECIDED, { id, outcome })
    return outcome
  }
}

function settleOrCancel(answer: Promise<ApprovalOutcome>, signal: AbortSignal | undefined): Promise<ApprovalOutcome> {
  if (!signal) return answer
  if (signal.aborted) {
    answer.catch(() => undefined)
    return Promise.resolve('cancelled')
  }
  return new Promise((resolve) => {
    const onAbort = (): void => resolve('cancelled')
    signal.addEventListener('abort', onAbort, { once: true })
    answer.then(resolve, () => resolve('unavailable')).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export interface ApprovalConfig {
  /** Deployment default for sessions with no recorded policy (default `ask`). */
  readonly policy?: ApprovalPolicy | undefined
}

const configSchema = z.strictObject({ policy: z.enum(APPROVAL_POLICIES).optional() }).optional()

/** Provides `ctx.approval`. */
export const approvalPlugin: Plugin<ApprovalConfig | undefined> = {
  name: 'core-approval',
  config: configSchema,
  apply(ctx, config) {
    const service = new ApprovalService(config?.policy ?? 'ask')
    ctx.provide(APPROVAL, service)
    // The opening record is the creator's act, written before publication.
    ctx.on(AGENT_CREATED, (agent) => service.open(agent.session))
  },
}

export type { EventEnvelope }
