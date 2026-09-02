/**
 * The sandbox VOCABULARY: the mode, its ordering, the durable stamp, and the
 * folds over it. Split from the service exactly as `approval/events.ts` is,
 * so a module BELOW the service — the agent registry deciding whether a fork
 * would drop a child's ceiling, an invariant — can name a sandbox fact
 * without importing the seam that resolves one (which imports the agent
 * registry back).
 */
import { eventKind, matches, type EventEnvelope } from '../session/types.ts'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * What an execution world actually delivers for a confined mode on this host.
 * `full` governs every file effect the mode promises; `partial` governs only a
 * subset (an older kernel ABI, a backend with known gaps); `none` means the
 * world cannot confine at all and must refuse rather than run unconfined.
 */
export type SandboxEnforcement = 'full' | 'partial' | 'none'

/** `delegation`: the opening stamp of a child, copied from its parent — and the ceiling every later stamp is held under. */
export type SandboxReason = 'initial' | 'change' | 'resume' | 'delegation'

export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const RANK: Readonly<Record<SandboxMode, number>> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

/** Strictly wider: an escalation must buy authority the call did not already have. */
export function isWider(candidate: SandboxMode, current: SandboxMode): boolean {
  return RANK[candidate] > RANK[current]
}

/**
 * The narrower of two modes.
 *
 * A composition may fence a delegated child further than its parent (a
 * verifier that must not write), and this is how: never a widening, so a row
 * config can only ever subtract authority.
 */
export function narrowest(one: SandboxMode, other: SandboxMode): SandboxMode {
  return RANK[one] <= RANK[other] ? one : other
}

export interface SandboxStamp {
  readonly mode: SandboxMode
  readonly enforcement: SandboxEnforcement
  readonly reason: SandboxReason
}

/**
 * Log-only (like `approval/*`): durable and replayable, never in the model
 * transcript. The LAST such event is the session mode.
 */
export const SANDBOX_MODE = eventKind<SandboxStamp>('sandbox/mode')

/** The last recorded stamp, or undefined for a session that never acted. */
export function lastSandboxStamp(events: readonly EventEnvelope[]): SandboxStamp | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, SANDBOX_MODE)) return event.data
  }
  return undefined
}

export function effectiveSandboxMode(events: readonly EventEnvelope[]): SandboxMode | undefined {
  return lastSandboxStamp(events)?.mode
}

/**
 * The delegation ceiling: the mode a delegated child opened under, when its
 * FIRST stamp says so. Nothing in that session — a switch, an escalation, a
 * forged stamp — may ever be wider. Absent for a session that is not a child.
 */
export function delegationCeiling(events: readonly EventEnvelope[]): SandboxMode | undefined {
  for (const event of events) {
    if (!matches(event, SANDBOX_MODE)) continue
    return event.data.reason === 'delegation' ? event.data.mode : undefined
  }
  return undefined
}
