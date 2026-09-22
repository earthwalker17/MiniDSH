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
import { clampIntent, type EffectIntent } from '../effects/events.ts'
import type { CallId } from '../ids.ts'
import type { Session } from '../session/index.ts'
import type { EventEnvelope } from '../session/types.ts'
import { printableText } from '../text.ts'
import {
  APPROVAL_ASKED,
  APPROVAL_DECIDED,
  APPROVAL_POLICIES,
  APPROVAL_POLICY,
  delegationPin,
  effectiveApprovalPolicy,
  APPROVAL_GRANT,
  grantFor,
  isApprovalOutcome,
  liveGrants,
  openApprovals,
  type ApprovalDecider,
  type ApprovalGrant,
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
  /**
   * What the RUNTIME says this call will do, derived by trusted code from the
   * call's VALIDATED arguments — never from model prose, which belongs in
   * `reason` beside it. Clamped by the seam, like `reason`.
   *
   * It is a projection of the arguments the body will execute, not a second
   * source of truth: the pipeline validates before the gate (`core/tools`), so
   * a requester builds this from the same frozen value the body receives, and
   * nothing in MiniDSH rewrites a call's arguments between the two.
   *
   * Absent where a requester has nothing trustworthy to say — and an ask with
   * no subject can never be granted, which is the fail-closed direction.
   */
  readonly subject?: EffectIntent
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
  const oneLine = printableText(text).replace(/\s+/gu, ' ').trim()
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

/**
 * What an answerer may return: the outcome, or the outcome plus a claim about
 * WHO it came from.
 *
 * `by` is a claim, not a proof — it is code-equivalent trust, exactly as a
 * preset-mounted answerer already is (§7). The protocol host says `user` only
 * for an answer from a connection that may see the session; everything else is
 * `auto`, including an answerer that says nothing, because one that does not
 * claim a human did not have one.
 */
export type ApprovalAnswer =
  | ApprovalOutcome
  | {
      readonly outcome: ApprovalOutcome
      readonly by?: 'user' | 'auto'
      /**
       * The answerer reports that the person took the `grant-session` offer.
       * A REPORT, not an instruction: the seam re-runs the same fold that
       * produced the offer and writes nothing if it no longer stands, so an
       * answerer cannot mint a consent nobody was offered.
       */
      readonly grant?: true
    }

/**
 * One place where a raw answerer value becomes the durable decision.
 *
 * It DROPS `by` whenever it rewrites the outcome, so an audit can never read
 * `{outcome: 'cancelled', decidedBy: 'user'}` — a person recorded as having
 * cancelled a request the abort signal killed. And `cancelled`/`unavailable`
 * carry no decider at all: nobody made that decision, and the outcome says so.
 */
function decide(answer: unknown, aborted: boolean): { outcome: ApprovalOutcome; by?: ApprovalDecider; grant?: true } {
  if (aborted) return { outcome: 'cancelled' }
  const shaped = typeof answer === 'object' && answer !== null ? (answer as { outcome?: unknown; by?: unknown; grant?: unknown }) : { outcome: answer }
  const outcome = isApprovalOutcome(shaped.outcome) ? shaped.outcome : 'unavailable'
  if (outcome !== 'allowed-once' && outcome !== 'rejected') return { outcome }
  return {
    outcome,
    by: shaped.by === 'user' ? 'user' : 'auto',
    // Only a yes can buy a standing consent, and only where one was offered.
    ...(outcome === 'allowed-once' && shaped.grant === true ? { grant: true as const } : {}),
  }
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
  /**
   * The standing consents this session still holds, newest last.
   *
   * There is deliberately no public `grant`. A consent is minted only inside
   * `request`, from an answer to an offer this seam itself computed, so a
   * mounted row cannot write one for a subject nobody was ever asked about —
   * and the invariant refuses one that names no open matching ask.
   */
  grants(session: Session): ApprovalGrant[]
  /** Ends one standing consent. A person may take back what they gave. */
  revoke(session: Session, grantId: string): boolean
  readonly defaultPolicy: ApprovalPolicy
}

export const APPROVAL = serviceKey<Approval>('approval')

/** Answerer chain; first non-delegating listener wins. Default thunk returns `unavailable`. */
export const APPROVAL_REQUEST = waterfallEvent<[prompt: ApprovalPrompt], Promise<ApprovalAnswer>>('approval/request')

class ApprovalService implements Approval {
  readonly defaultPolicy: ApprovalPolicy
  constructor(defaultPolicy: ApprovalPolicy) {
    this.defaultPolicy = defaultPolicy
  }

  policyFor(session: Session | undefined): ApprovalPolicy {
    return (session ? effectiveApprovalPolicy(session.facts) : undefined) ?? this.defaultPolicy
  }

  grants(session: Session): ApprovalGrant[] {
    return [...liveGrants(session.facts).values()]
  }

  revoke(session: Session, grantId: string): boolean {
    if (!this.grants(session).some((grant) => grant.id === grantId)) return false
    session.append(APPROVAL_GRANT, { op: 'revoke', id: grantId })
    return true
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
    // Clamped HERE for the reason `reason` is: one place, before the log, so no
    // future requester can reintroduce a control character into the line a
    // person answers — and so the answerer and the audit see the same bytes.
    const subject = request.subject === undefined ? undefined : clampIntent(request.subject)
    const ask = (): void => {
      session.append(APPROVAL_ASKED, {
        id,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(reason === undefined || reason.length === 0 ? {} : { reason }),
        ...(subject === undefined ? {} : { subject }),
      })
    }

    // Everything decided WITHOUT consulting anyone is decided before the ask is
    // appended, so the pair lands in one tick and no surface ever publishes a
    // view in which the question is open. A prompt printed for an already
    // settled question stands over nothing and swallows the next line typed.
    if (request.signal?.aborted) {
      ask()
      session.append(APPROVAL_DECIDED, { id, outcome: 'cancelled' })
      return 'cancelled'
    }
    // The strict unattended stance: refuse without consulting anyone. Enforced
    // here, before dispatch, so no answerer can be composed around it — and
    // BEFORE any standing consent is consulted, so a delegated child's pin
    // still wins absolutely.
    if (this.policyFor(session) === 'never') {
      ask()
      session.append(APPROVAL_DECIDED, { id, outcome: 'rejected', decidedBy: 'policy' })
      return 'rejected'
    }
    const standing = subject === undefined ? undefined : grantFor(session.facts, request.toolName, subject)
    if (standing !== undefined) {
      // The full audit pair even though nobody was asked: a granted call must
      // not be thinner on the record than an asked one, and `grantId` says
      // which consent answered it.
      ask()
      session.append(APPROVAL_DECIDED, { id, outcome: 'allowed-once', decidedBy: 'grant', grantId: standing.id })
      return 'allowed-once'
    }

    ask()
    // The prompt carries the SAME reason and subject the log does: an answerer
    // must never be shown text a reader of the audit could not have seen.
    const prompt: ApprovalPrompt = { ...request, id, ...(reason === undefined ? {} : { reason }), ...(subject === undefined ? {} : { subject }) }
    let answered: unknown
    try {
      // Dispatched in the requesting agent's scope: an answerer registered through
      // one agent's context never answers for another agent. The seam, not the
      // answerer, owns cancellation: an aborted signal settles the request even
      // if an answerer (a disconnected client) never does.
      const answer = Promise.resolve(request.agent.ctx.waterfall(APPROVAL_REQUEST, prompt, async () => 'unavailable' as ApprovalAnswer))
      answered = await settleOrCancel(answer, request.signal)
    } catch {
      answered = 'unavailable'
    }
    const { outcome, by, grant } = decide(answered, request.signal?.aborted === true)
    // The grant BEFORE the decision it came from, so the log reads in the order
    // the consent was given — and only if the offer this seam computed still
    // stands, re-checked here rather than taken on the answerer's word.
    const grantId = grant === true ? this.mint(session, id, request.toolName, subject) : undefined
    session.append(APPROVAL_DECIDED, {
      id,
      outcome,
      ...(by === undefined ? {} : { decidedBy: by }),
      ...(grantId === undefined ? {} : { grantId }),
    })
    return outcome
  }

  /**
   * Writes the standing consent an answer reported, or nothing.
   *
   * The offer is recomputed from the log rather than trusted: `openApprovals`
   * is the one function that decides what an ask may durably buy, and running
   * it here is what stops a composed answerer minting a consent for a subject
   * nobody was offered one for.
   */
  private mint(session: Session, askedId: string, toolName: string, subject: EffectIntent | undefined): string | undefined {
    if (subject === undefined) return undefined
    const offered = openApprovals(session.facts).find((entry) => entry.id === askedId)
    if (offered?.offers?.includes('grant-session') !== true) return undefined
    const id = `grant-${session.seq}`
    session.append(APPROVAL_GRANT, { op: 'grant', id, toolName, subject, fromApproval: askedId })
    return id
  }
}

function settleOrCancel(answer: Promise<ApprovalAnswer>, signal: AbortSignal | undefined): Promise<ApprovalAnswer> {
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
