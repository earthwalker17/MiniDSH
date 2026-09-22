/**
 * The approval VOCABULARY: outcomes, policies, and the durable event kinds.
 * Split from the service so that modules below the service — the session's
 * crash repair, the authority invariant — can name an approval fact without
 * importing the seam that decides one (which would import the session back).
 */
import type { EffectIntent } from '../effects/events.ts'
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

export const APPROVAL_DECIDED = eventKind<{ id: string; outcome: ApprovalOutcome; decidedBy?: ApprovalDecider }>('approval/decided')
/** `delegation`: the opening stamp of a child, pinned by its parent — and the pin every later stamp is held to. */
export type ApprovalPolicyReason = 'initial' | 'change' | 'delegation'
/** Log-only, like `sandbox/mode`: the LAST such event is the session policy. */
export const APPROVAL_POLICY = eventKind<{ policy: ApprovalPolicy; reason: ApprovalPolicyReason }>('approval/policy')

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
  return joinCalls([...open.values()], events)
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
