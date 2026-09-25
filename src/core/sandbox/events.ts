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
 * The stamp THIS lifecycle opened under: the OPENING one it wrote itself, and
 * otherwise the last one its seed recorded.
 *
 * The distinction matters for anything that must be stable for a lifecycle and
 * still true — the prompt's runtime-context block is the one consumer. The
 * log's FIRST stamp is what the session it was resumed from started with, so
 * reading that told a session resumed after a switch to `read-only` that it was
 * `workspace-write`.
 *
 * `reason !== 'change'` is what makes it an OPENING rather than just the first
 * one this lifecycle happened to write. A fresh session writes `initial` at
 * creation and a child writes `delegation`, so for them the first stamp at or
 * after `liveStart` is already the opening — but a resumed or forked session
 * whose host enforces identically writes NOTHING at pickup, and there the first
 * stamp at or after `liveStart` is the next `setMode`. Taking that one moved
 * the section mid-lifecycle, which is the one thing it may not do: the cached
 * prompt prefix is keyed on it, and a probe caught the forked case rendering
 * `workspace-write` before a switch and `read-only` after.
 */
export function openingSandboxStamp(events: readonly EventEnvelope[], liveStart = 0): SandboxStamp | undefined {
  let seeded: SandboxStamp | undefined
  for (const event of events) {
    if (!matches(event, SANDBOX_MODE)) continue
    if (event.seq >= liveStart) {
      if (event.data.reason !== 'change') return event.data
      break
    }
    seeded = event.data
  }
  return seeded
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

// ---- what enforcement a session accepts ------------------------------------

/**
 * The weakest enforcement this session accepts for a confined shell command,
 * and the MODE it accepted it for.
 *
 * A host with no confinement backend refuses every confined command rather
 * than running it unconfined, which is the right default and is what Windows
 * costs today: two model steps, a human prompt and a throwaway child for every
 * command. This is how a person says "I know this host cannot sandbox the
 * shell; run the command anyway" — durably, per session, and on the record,
 * rather than by dropping the whole session to `danger-full-access` and losing
 * the in-process file fence with it.
 *
 * **`forMode` is not decoration.** The shell's refusal is mode-blind, so an
 * acceptance without one would relax `read-only` exactly as it relaxes
 * `workspace-write` — a session recorded `read-only` would run an unwrapped
 * shell with full host write power, and a `read-only` delegated child, pinned
 * `never` and unable to ask anyone anything, would inherit that from a parent
 * that only ever accepted it for a wider mode. Recording the mode the
 * acceptance was GIVEN FOR, and honouring it only for that mode, closes both
 * with one mechanism: `/sandbox read-only` re-refuses, and a narrowed child's
 * mode no longer matches its parent's.
 *
 * Deliberately NOT a field on `sandbox/mode`: that record's `enforcement` is a
 * REPORTED host fact, this is a DECISION about the shell world, and a field on
 * a written-only-when-changed record reads as absent for the life of any
 * session that never rewrote it (§4).
 */
export const SANDBOX_ACCEPTANCE = eventKind<{ accepts: SandboxEnforcement; forMode: SandboxMode; reason: SandboxReason }>('sandbox/acceptance')

/**
 * The enforcement lattice, which runs the OTHER WAY from `RANK` above.
 *
 * `RANK` orders modes by permissiveness ascending (`read-only` is 0). Here the
 * permissive end is `none`, so an implementer reaching for `narrowest` would
 * invert the ceiling and let a delegation row configured `accepts: 'none'`
 * read as a narrowing of a parent at `full`. Hence a separate rank and a
 * separate verb.
 */
const ACCEPT_RANK: Readonly<Record<SandboxEnforcement, number>> = { full: 0, partial: 1, none: 2 }

/** The stricter of two acceptances — what a delegation row may do to a parent's, and only that. */
export function strictest(one: SandboxEnforcement, other: SandboxEnforcement): SandboxEnforcement {
  return ACCEPT_RANK[one] <= ACCEPT_RANK[other] ? one : other
}

/** Whether what a world can deliver satisfies what a session accepts. */
export function meetsAcceptance(delivered: SandboxEnforcement, accepted: SandboxEnforcement): boolean {
  return ACCEPT_RANK[delivered] <= ACCEPT_RANK[accepted]
}

/** Nothing accepted is `full`: refuse what cannot be enforced, which is what every host did before this knob. */
export const DEFAULT_ACCEPTANCE: SandboxEnforcement = 'full'

/**
 * What this session accepts for `mode` — the last acceptance recorded FOR THAT
 * MODE, else the strict default. An acceptance for another mode is not an
 * acceptance for this one.
 */
export function acceptanceFor(events: readonly EventEnvelope[], mode: SandboxMode, fallback: SandboxEnforcement = DEFAULT_ACCEPTANCE): SandboxEnforcement {
  return recordedAcceptance(events, mode) ?? fallback
}

/** The last acceptance the log RECORDED for `mode`, or `undefined` when it records none — what a cold reader can state without a deployment to fall back on. */
export function recordedAcceptance(events: readonly EventEnvelope[], mode: SandboxMode): SandboxEnforcement | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, SANDBOX_ACCEPTANCE) && event.data.forMode === mode) return event.data.accepts
  }
  return undefined
}

/**
 * The acceptance THIS lifecycle opened under, for `mode` — the same rule
 * `openingSandboxStamp` uses, and for the same consumer: the prompt's
 * runtime-context block must be byte-stable for a lifecycle, so a mid-session
 * `change` may not move it. A switch reaches the model as a message instead.
 */
export function openingAcceptance(
  events: readonly EventEnvelope[],
  liveStart: number,
  mode: SandboxMode,
  fallback: SandboxEnforcement = DEFAULT_ACCEPTANCE,
): SandboxEnforcement {
  let seeded = fallback
  for (const event of events) {
    if (!matches(event, SANDBOX_ACCEPTANCE) || event.data.forMode !== mode) continue
    if (event.seq >= liveStart) {
      if (event.data.reason !== 'change') return event.data.accepts
      break
    }
    seeded = event.data.accepts
  }
  return seeded
}

/**
 * The delegation PIN: what a child was started accepting, when its FIRST
 * acceptance says so. Unlike the mode, which is a ceiling a child may narrow,
 * this cannot be changed at all — a child that cannot ask anyone anything has
 * no legitimate in-session actor to renegotiate it, and narrowing is what the
 * delegation row is for.
 */
export function delegationAcceptance(events: readonly EventEnvelope[]): { accepts: SandboxEnforcement; forMode: SandboxMode } | undefined {
  for (const event of events) {
    if (!matches(event, SANDBOX_ACCEPTANCE)) continue
    return event.data.reason === 'delegation' ? { accepts: event.data.accepts, forMode: event.data.forMode } : undefined
  }
  return undefined
}
