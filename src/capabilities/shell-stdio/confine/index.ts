/**
 * Confinement selection: one strategy, chosen per host, behind the `shell`
 * seam. Nothing above this provider learns what a bwrap is.
 *
 * The whole mechanism is `argv → argv` plus one honest answer about what the
 * host delivers. Both real backends apply only at SPAWN and are inherited by
 * every descendant, so wrapping a persistent shell confines every command it
 * will ever run — which is why this is a strategy inside the provider and not
 * a second seam with a lifecycle of its own.
 *
 * **Policy, report, enforcement.** A mode is policy. `enforcement` is a report
 * about a host. Only the kernel refusing a write is enforcement. This module
 * is allowed to answer the middle one only because it PROBES the third.
 */
import { spawnSync } from 'node:child_process'
import type { SandboxEnforcement, SandboxExecutionPolicy } from '../../../core/sandbox/index.ts'
import { BWRAP_BIN, BWRAP_DENIALS, BWRAP_RUNNER_FAILURES, bwrapArgs } from './bwrap.ts'
import { SEATBELT_BIN, SEATBELT_DENIALS, SEATBELT_RUNNER_FAILURES, seatbeltArgs } from './seatbelt.ts'

export type ConfinementId = 'none' | 'bwrap' | 'seatbelt'
/** `auto` picks by platform; naming one asks for it anywhere and still probes it. */
export type ConfinementChoice = 'auto' | ConfinementId

export const CONFINEMENT_CHOICES = ['auto', 'none', 'bwrap', 'seatbelt'] as const

export interface Confinement {
  readonly id: ConfinementId
  /**
   * What this mechanism delivers for a CONFINED mode on this host. `full` is
   * a claim about the profile's completeness — every file effect the mode
   * promises is governed — asserted from how the profile is built and proven
   * by a functional probe, not measured per call. `none` means it cannot
   * confine, and the provider must then refuse rather than run unconfined.
   */
  readonly enforcement: SandboxEnforcement
  /** This backend's own words for a refused write; empty when nothing confines. */
  readonly denialSignatures: readonly string[]
  /** This backend's own words for "the wrapper could not start"; the command never ran. */
  readonly runnerFailureSignatures: readonly string[]
  /** The confined argv, or the argv unchanged when this mode needs no confinement. */
  wrap(cmd: string, args: readonly string[], policy: SandboxExecutionPolicy): { cmd: string; args: string[] }
}

/** The honest answer on a host with no backend: enforce nothing, and say so. */
export const NO_CONFINEMENT: Confinement = {
  id: 'none',
  enforcement: 'none',
  denialSignatures: [],
  runnerFailureSignatures: [],
  wrap: (cmd, args) => ({ cmd, args: [...args] }),
}

interface Dialect {
  readonly id: Exclude<ConfinementId, 'none'>
  readonly bin: string
  readonly profile: (policy: SandboxExecutionPolicy) => string[]
  readonly denials: readonly string[]
  readonly runnerFailures: readonly string[]
}

const DIALECTS: Readonly<Record<Exclude<ConfinementId, 'none'>, Dialect>> = {
  bwrap: { id: 'bwrap', bin: BWRAP_BIN, profile: bwrapArgs, denials: BWRAP_DENIALS, runnerFailures: BWRAP_RUNNER_FAILURES },
  seatbelt: { id: 'seatbelt', bin: SEATBELT_BIN, profile: seatbeltArgs, denials: SEATBELT_DENIALS, runnerFailures: SEATBELT_RUNNER_FAILURES },
}

/** One candidate per platform. Windows has none, and §13 says why. */
const PLATFORM_CANDIDATE: Readonly<Record<string, Exclude<ConfinementId, 'none'> | undefined>> = {
  linux: 'bwrap',
  darwin: 'seatbelt',
}

const PROBE_TIMEOUT_MS = 5_000

/**
 * The functional probe: run the REAL read-only profile around `true` and take
 * exit 0 as proof.
 *
 * Never a `which` and never a version check. A binary that is installed and
 * cannot enforce is the case that matters — a container that forbids user
 * namespaces, a kernel with the syscalls and no enforcement — and only running
 * the profile catches it. The same builder the real wrap uses, or the probe
 * validates something weaker than what ships.
 *
 * MiniDSH probes even a sole candidate, where DSH skips that: DSH fails closed
 * at execution, while MiniDSH RECORDS `enforcement` in the log at agent
 * creation, before any command exists to fail. A stamp that says `full`
 * because a binary was named would be exactly the claim this session exists to
 * refuse.
 */
function probe(dialect: Dialect): boolean {
  try {
    const args = [...dialect.profile({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true']
    return spawnSync(dialect.bin, args, { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' }).status === 0
  } catch {
    // A missing binary and an unenforcing kernel are deliberately the same
    // answer: one degradation path, and the refusal names the remedy.
    return false
  }
}

function build(dialect: Dialect): Confinement {
  return {
    id: dialect.id,
    enforcement: 'full',
    denialSignatures: dialect.denials,
    runnerFailureSignatures: dialect.runnerFailures,
    wrap(cmd, args, policy) {
      // `danger-full-access` is not confined at all, so there is nothing to
      // wrap; the mode itself is the statement, and wrapping it with an empty
      // allow-list would confine it to nothing.
      if (policy.mode === 'danger-full-access') return { cmd, args: [...args] }
      return { cmd: dialect.bin, args: [...dialect.profile(policy), '--', cmd, ...args] }
    },
  }
}

/**
 * A host fact, so it cannot change inside a process: memoized per choice.
 * Every mount of the shell row in one process asks the same question and gets
 * the same answer without paying for the probe again.
 */
const selected = new Map<ConfinementChoice, Confinement>()

export function selectConfinement(choice: ConfinementChoice = 'auto'): Confinement {
  const cached = selected.get(choice)
  if (cached) return cached
  const result = resolve(choice)
  selected.set(choice, result)
  return result
}

function resolve(choice: ConfinementChoice): Confinement {
  if (choice === 'none') return NO_CONFINEMENT
  const id = choice === 'auto' ? PLATFORM_CANDIDATE[process.platform] : choice
  if (id === undefined) return NO_CONFINEMENT
  const dialect = DIALECTS[id]
  return probe(dialect) ? build(dialect) : NO_CONFINEMENT
}

/** What a host with no backend should be told to install, named per platform. */
export function confinementRemedy(): string {
  if (process.platform === 'linux') return 'install bubblewrap (apt install bubblewrap) or run the session under "danger-full-access"'
  if (process.platform === 'darwin') return 'ensure sandbox-exec is usable, or run the session under "danger-full-access"'
  return 'no confinement backend exists for this platform; approve the command, or run the session under "danger-full-access"'
}
