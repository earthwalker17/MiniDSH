/**
 * The approval VOCABULARY: outcomes, policies, and the durable event kinds.
 * Split from the service so that modules below the service — the session's
 * crash repair, the authority invariant — can name an approval fact without
 * importing the seam that decides one (which would import the session back).
 */
import { eventKind, matches, type EventEnvelope } from '../session/types.ts'

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

export const APPROVAL_ASKED = eventKind<{ id: string; toolName: string; callId?: string; reason?: string }>('approval/asked')
export const APPROVAL_DECIDED = eventKind<{ id: string; outcome: ApprovalOutcome }>('approval/decided')
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

/** Approvals asked and not yet decided, in asking order — the open half of the audit pair. */
export function undecidedApprovals(events: readonly EventEnvelope[]): string[] {
  const open = new Map<string, true>()
  for (const event of events) {
    if (matches(event, APPROVAL_ASKED)) open.set(event.data.id, true)
    else if (matches(event, APPROVAL_DECIDED)) open.delete(event.data.id)
  }
  return [...open.keys()]
}
