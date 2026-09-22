/**
 * The approval VOCABULARY: outcomes, policies, and the durable event kinds.
 * Split from the service so that modules below the service — the session's
 * crash repair, the authority invariant — can name an approval fact without
 * importing the seam that decides one (which would import the session back).
 */
import { intentKey, type EffectIntent } from '../effects/events.ts'
import { eventKind, matches, TOOL_CALL, type EventEnvelope } from '../session/types.ts'
import { printableText } from '../text.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
const VALID_OUTCOMES: ReadonlySet<string> = new Set<ApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/** The closed outcome vocabulary, declared once — the seam and its invariant share it. */
export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && VALID_OUTCOMES.has(value)
}

/** `ask` consults the answerer chain; `never` refuses every request without asking anyone. */
export type ApprovalPolicy = 'ask' | 'never'
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never']

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === 'ask' || value === 'never'
}

/**
 * `reason` is the requester's PROSE, which for the shell comes from the model.
 * `subject` is what the RUNTIME says the call will do, derived by trusted code
 * from validated arguments (`core/effects`) — the half a person should be
 * consenting to, and the only half a grant may be keyed on.
 */
export const APPROVAL_ASKED = eventKind<{ id: string; toolName: string; callId?: string; reason?: string; subject?: EffectIntent }>('approval/asked')
/**
 * WHO decided, when the runtime knows — omitted when nobody was consulted,
 * because the outcome already says `cancelled` or `unavailable` and an absent
 * field is honest about a decision nobody made.
 *
 * `policy` is the durable `never`, decided before dispatch. `user` is a client
 * that could see this session answering over the wire; `auto` is any other
 * answerer, including one that declined to say — an answerer that does not
 * claim a human did not have one, which is the fail-closed direction for an
 * audit. It is not an identity: MiniDSH has one principal and no accounts
 * (ARCHITECTURE §13), so this distinguishes a person's click from a rule, and
 * nothing finer.
 */
export type ApprovalDecider = 'policy' | 'grant' | 'user' | 'auto'
const VALID_DECIDERS: ReadonlySet<string> = new Set<ApprovalDecider>(['policy', 'grant', 'user', 'auto'])

export function isApprovalDecider(value: unknown): value is ApprovalDecider {
  return typeof value === 'string' && VALID_DECIDERS.has(value)
}

export const APPROVAL_DECIDED = eventKind<{ id: string; outcome: ApprovalOutcome; decidedBy?: ApprovalDecider; grantId?: string }>('approval/decided')
/** `delegation`: the opening stamp of a child, pinned by its parent — and the pin every later stamp is held to. */
export type ApprovalPolicyReason = 'initial' | 'change' | 'delegation'
/** Log-only, like `sandbox/mode`: the LAST such event is the session policy. */
export const APPROVAL_POLICY = eventKind<{ policy: ApprovalPolicy; reason: ApprovalPolicyReason }>('approval/policy')

// ---- grants -----------------------------------------------------------------

/**
 * A standing consent, op-shaped like `inbox/spliced` rather than positional.
 *
 * Its identity is the tool plus the EXACT recorded subject (`intentKey`), which
 * is the one point in the space upstream enumerated and declined to choose
 * from — "exact call, path, command prefix, session, or time window". No
 * prefixes and no patterns: those need a per-dialect parser that can refuse a
 * compound form, and nothing here has one.
 *
 * Exact matching is fragile — quoting, a working directory, an environment
 * prefix, a pipeline retried as its failing stage — and that is the safety
 * argument rather than an objection to it. Upstream rejected exact matching
 * for hard-matching a RETRY to a prior denial, where fragility means a
 * legitimate retry is refused; here it means a near-miss ASKS AGAIN. So the
 * claim is bounded and stated: a grant covers a repeated identical action, the
 * test command re-run across a turn loop, and nothing else. It is not a policy
 * language.
 */
export type ApprovalGrantOp =
  | {
      readonly op: 'grant'
      readonly id: string
      readonly toolName: string
      readonly subject: EffectIntent
      /** The `approval/asked` this consent came from — a grant is a fact about a consent that provably happened. */
      readonly fromApproval: string
    }
  | { readonly op: 'revoke'; readonly id: string }

export const APPROVAL_GRANT = eventKind<ApprovalGrantOp>('approval/grant')

/** A live standing consent, as a surface lists one. */
export interface ApprovalGrant {
  readonly id: string
  readonly toolName: string
  readonly subject: EffectIntent
}

/**
 * The authority facts that END every standing consent in a session.
 *
 * **Consent is to the world as it stood.** A grant minted under an escalation
 * to `danger-full-access` would otherwise still match after a person typed
 * `/sandbox read-only` — `resolvePolicy` checks only that the target is wider,
 * and `sandbox.resolve` checks only the DELEGATION ceiling — so the narrowing
 * would change nothing for exactly the command somebody worried about. One
 * comparison in a walk that already happens, and it covers the cases a
 * subject-only guard misses: a resume onto a differently-enforcing host writes
 * `sandbox/mode{resume}`, and a preset writes through both setters.
 */
const AUTHORITY_KINDS: ReadonlySet<string> = new Set([APPROVAL_POLICY.type, 'sandbox/mode', 'sandbox/acceptance', 'authority/preset'])

/**
 * Every live grant, keyed by `intentKey`. A grant is live only if it was not
 * revoked and NO authority event follows it.
 */
export function liveGrants(events: readonly EventEnvelope[]): Map<string, ApprovalGrant> {
  const live = new Map<string, ApprovalGrant>()
  // A grant is written BEFORE the decision it came from (so the decision can
  // name it), and the log is not fsynced, so a crash can keep the grant and
  // lose the decision. Repair then closes that ask `cancelled` — nobody
  // consented — while the grant would go on answering for the rest of the
  // session. A consent is only live once its own ask is recorded as allowed,
  // which is the same rule the pre-commit invariant states from the other side.
  const born = new Map<string, { key: string; grant: ApprovalGrant }>()
  for (const event of events) {
    if (AUTHORITY_KINDS.has(event.type)) {
      live.clear()
      born.clear()
      continue
    }
    if (matches(event, APPROVAL_DECIDED)) {
      const pending = born.get(event.data.id)
      if (pending === undefined) continue
      born.delete(event.data.id)
      if (event.data.outcome === 'allowed-once') live.set(pending.key, pending.grant)
      continue
    }
    if (!matches(event, APPROVAL_GRANT)) continue
    if (event.data.op === 'revoke') {
      const id = event.data.id
      for (const [key, grant] of live) if (grant.id === id) live.delete(key)
      for (const [askId, pending] of born) if (pending.grant.id === id) born.delete(askId)
      continue
    }
    const key = intentKey(event.data.toolName, event.data.subject)
    if (key !== undefined) born.set(event.data.fromApproval, { key, grant: { id: event.data.id, toolName: event.data.toolName, subject: event.data.subject } })
  }
  return live
}

/** The live grant covering this exact action, if one stands. */
export function grantFor(events: readonly EventEnvelope[], toolName: string, subject: EffectIntent): ApprovalGrant | undefined {
  const key = intentKey(toolName, subject)
  return key === undefined ? undefined : liveGrants(events).get(key)
}

/**
 * What a HOST may offer beside a one-shot yes. A closed id, not a label: the
 * words belong to each surface, and no surface may invent a scope.
 */
export type ApprovalOfferId = 'grant-session'

/**
 * The delegation pin: the policy a delegated child opened under, when its
 * FIRST stamp says so. It never changes for the life of the session — the
 * pin is what makes a child's authority a ceiling and not a suggestion.
 */
export function delegationPin(events: readonly EventEnvelope[]): ApprovalPolicy | undefined {
  for (const event of events) {
    if (!matches(event, APPROVAL_POLICY)) continue
    return event.data.reason === 'delegation' ? event.data.policy : undefined
  }
  return undefined
}

export function effectiveApprovalPolicy(events: readonly EventEnvelope[]): ApprovalPolicy | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, APPROVAL_POLICY)) return event.data.policy
  }
  return undefined
}

/** The policy THIS lifecycle opened under — same rule as `openingSandboxStamp`, and for the same consumer. */
export function openingApprovalPolicy(events: readonly EventEnvelope[], liveStart = 0): ApprovalPolicy | undefined {
  let seeded: ApprovalPolicy | undefined
  for (const event of events) {
    if (!matches(event, APPROVAL_POLICY)) continue
    if (event.seq >= liveStart) {
      if (event.data.reason !== 'change') return event.data.policy
      break
    }
    seeded = event.data.policy
  }
  return seeded
}

/**
 * The call an approval covers, joined out of the log by `callId`.
 *
 * The arguments are the model's, so they are control-stripped here: this value
 * exists to be rendered into a line somebody answers, and a `\r\x1b[2K` in it
 * would repaint that line exactly as one in a `reason` would. The durable
 * `tool/call` keeps the raw bytes; this is the projection.
 */
export interface ApprovedCall {
  readonly name: string
  readonly arguments: string
  /** How many characters the bound left out. Absent when nothing was left out. */
  readonly omittedChars?: number
}

/** An approval asked and not yet decided — everything an answerer needs to render the question. */
export interface OpenApproval {
  readonly id: string
  readonly toolName: string
  readonly reason?: string
  /** What the runtime says the call will do, when its requester said. */
  readonly subject?: EffectIntent
  /** The `tool/call` this covers, when the requester named one. */
  readonly callId?: string
  /** That call as the log recorded it — the literal record, beside the runtime's account of it. */
  readonly call?: ApprovedCall
  /**
   * What a surface may offer beside a one-shot yes, computed HERE from the log
   * — never invented by the surface, and re-checked by the seam before any
   * durable consequence. Empty is the common case.
   */
  readonly offers?: readonly ApprovalOfferId[]
}

/**
 * How much of a call's arguments crosses to an answerer.
 *
 * A bound, not a preview: hiding a command's tail asks a person to consent to
 * text they cannot read, so what is left out is COUNTED and said, and a
 * surface that hits it points at the whole record rather than pretending. It
 * exists because this value rides `SessionView`, which the host republishes,
 * and one 100 KB heredoc should not cross the wire repeatedly.
 */
const MAX_CALL_CHARS = 16_384

function boundedCall(name: string, args: string): ApprovedCall {
  const safe = printableText(args)
  if (safe.length <= MAX_CALL_CHARS) return { name, arguments: safe }
  return { name, arguments: safe.slice(0, MAX_CALL_CHARS), omittedChars: safe.length - MAX_CALL_CHARS }
}

/**
 * Approvals asked and not yet decided, in asking order — the open half of the
 * audit pair. A client that holds only a PAGE of the log cannot compute this
 * (an `asked` whose `decided` fell outside the page is a phantom prompt; an
 * outstanding `asked` below the page strands a real one), so the host folds it
 * and sends the answer.
 */
export function openApprovals(events: readonly EventEnvelope[]): OpenApproval[] {
  const open = new Map<string, OpenApproval>()
  for (const event of events) {
    if (matches(event, APPROVAL_ASKED)) {
      const { id, toolName, reason, subject, callId } = event.data
      open.set(id, {
        id,
        toolName,
        ...(reason === undefined ? {} : { reason }),
        ...(subject === undefined ? {} : { subject }),
        ...(callId === undefined ? {} : { callId }),
      })
    } else if (matches(event, APPROVAL_DECIDED)) open.delete(event.data.id)
  }
  return withOffers(joinCalls([...open.values()], events), events)
}

/**
 * What each open approval may durably buy, as a fold over the log.
 *
 * In the fold and not in the host, so every surface and the audit agree, and so
 * the seam can re-run the same function before writing anything — which is the
 * operative meaning of "no surface invents a scope". Offerable needs a subject
 * that can be keyed (so never a truncated one), a session that is not delegated
 * (a child's authority is not its to extend), a policy that actually asks, and
 * no live grant already covering it.
 */
function withOffers(open: OpenApproval[], events: readonly EventEnvelope[]): OpenApproval[] {
  if (open.length === 0) return open
  if (delegationPin(events) !== undefined) return open
  if (effectiveApprovalPolicy(events) !== 'ask') return open
  const live = liveGrants(events)
  return open.map((entry) => {
    if (entry.subject === undefined) return entry
    const key = intentKey(entry.toolName, entry.subject)
    if (key === undefined || live.has(key)) return entry
    return { ...entry, offers: ['grant-session'] as const }
  })
}

/**
 * Attach each open approval's `tool/call`, so an answerer sees what was
 * actually asked for rather than a description of it.
 *
 * A second pass rather than a map built during the first: a long session holds
 * thousands of calls and almost never an open approval, so remembering every
 * call on the way past would cost the common case (every view publication) to
 * serve the rare one. When nothing is open this returns immediately.
 *
 * The host folds this because a client holding a PAGE cannot: the `tool/call`
 * an ask covers can sit outside the page, or below it.
 */
function joinCalls(open: OpenApproval[], events: readonly EventEnvelope[]): OpenApproval[] {
  const wanted = new Set(open.map((entry) => entry.callId).filter((id): id is string => id !== undefined))
  if (wanted.size === 0) return open
  const calls = new Map<string, ApprovedCall>()
  for (const event of events) {
    if (!matches(event, TOOL_CALL) || !wanted.has(event.data.callId)) continue
    calls.set(event.data.callId, boundedCall(event.data.name, event.data.arguments))
  }
  return open.map((entry) => {
    const call = entry.callId === undefined ? undefined : calls.get(entry.callId)
    return call === undefined ? entry : { ...entry, call }
  })
}

/** The open ids alone — the same fold, for callers that only close the pair. */
export function undecidedApprovals(events: readonly EventEnvelope[]): string[] {
  return openApprovals(events).map((approval) => approval.id)
}
