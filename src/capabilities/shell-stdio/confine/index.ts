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
import { spawnRefusal } from '../../../core/process.ts'
import type { SandboxEnforcement, SandboxExecutionPolicy } from '../../../core/sandbox/index.ts'
import { BWRAP_BIN, BWRAP_DENIALS, BWRAP_RUNNER_FAILURES, bwrapArgs, bwrapTempDir } from './bwrap.ts'
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
   * No backend reports `partial` today: `build` claims `full` from the profile
   * alone. `partial` exists as a value a ROW may accept (`sandbox/acceptance`)
   * and as DSH's Windows verdict, never as a measurement made here.
   */
  readonly enforcement: SandboxEnforcement
  /** This backend's own words for a refused write; empty when nothing confines. */
  readonly denialSignatures: readonly string[]
  /** This backend's own words for "the wrapper could not start"; the command never ran. */
  readonly runnerFailureSignatures: readonly string[]
  /** The confined argv, or the argv unchanged when this mode needs no confinement. */
  wrap(cmd: string, args: readonly string[], policy: SandboxExecutionPolicy): { cmd: string; args: string[] }
  /**
   * Environment the confined child needs in order to USE what the profile
   * granted it, or `undefined` to inherit unchanged.
   *
   * The one entry so far is `TMPDIR`, and it is not a convenience: a shell
   * inherits whatever temp directory the harness was started with, and under a
   * profile that grants only the workspace, that path is outside the ceiling.
   * bwrap gives the sandbox a private writable `/tmp` — but a host with
   * `TMPDIR=$HOME/tmp` (pam_tmpdir, or a macOS session, where launchd always
   * sets one) sends every `mktemp`, every compiler intermediate and every
   * spooled here-document at a path the sandbox correctly refuses. Pointing
   * TMPDIR at what the profile already granted widens nothing.
   */
  envFor(policy: SandboxExecutionPolicy): Readonly<Record<string, string>> | undefined
}

/** The honest answer on a host with no backend: enforce nothing, and say so. */
export const NO_CONFINEMENT: Confinement = {
  id: 'none',
  enforcement: 'none',
  denialSignatures: [],
  runnerFailureSignatures: [],
  wrap: (cmd, args) => ({ cmd, args: [...args] }),
  envFor: () => undefined,
}

interface Dialect {
  readonly id: Exclude<ConfinementId, 'none'>
  readonly bin: string
  readonly profile: (policy: SandboxExecutionPolicy) => string[]
  readonly denials: readonly string[]
  readonly runnerFailures: readonly string[]
  /** A writable temp directory this dialect's profile provides, if it provides one. */
  readonly tempDir: (policy: SandboxExecutionPolicy) => string | undefined
}

const DIALECTS: Readonly<Record<Exclude<ConfinementId, 'none'>, Dialect>> = {
  bwrap: { id: 'bwrap', bin: BWRAP_BIN, profile: bwrapArgs, denials: BWRAP_DENIALS, runnerFailures: BWRAP_RUNNER_FAILURES, tempDir: bwrapTempDir },
  // Seatbelt provides none: it does not change the filesystem VIEW, so there is
  // nowhere private to point at and granting the host's real temp area would
  // widen the ceiling. Recorded as a limitation rather than papered over.
  seatbelt: { id: 'seatbelt', bin: SEATBELT_BIN, profile: seatbeltArgs, denials: SEATBELT_DENIALS, runnerFailures: SEATBELT_RUNNER_FAILURES, tempDir: () => undefined },
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
 *
 * Three answers, not two, because only two of them are about the HOST:
 *   - `enforces` — the profile ran and exited 0;
 *   - `cannot` — the backend ran and refused (a nonzero status, no spawn error,
 *     no signal), or its binary is not there or not runnable (ENOENT, EACCES).
 *     A missing binary and an unenforcing kernel are deliberately the same
 *     answer: one degradation path, and the refusal names the remedy;
 *   - `unproved` — the probe could not run at all: out of descriptors or
 *     processes (EMFILE, ENFILE, EAGAIN, ENOMEM), its 5 s bound (ETIMEDOUT, or
 *     any signal), or anything else. That is a fact about a MOMENT. It still
 *     answers `none` — nothing proved the backend works — but it is never
 *     remembered (`selectConfinement`). Before S20.5 it was, so one busy
 *     moment at mount made a bwrap host refuse every command with "install
 *     bubblewrap", and let a session accepting `none` run unconfined where a
 *     backend existed (reproduced under WSL by exhausting descriptors at mount).
 */
type Verdict = 'enforces' | 'cannot' | 'unproved'

/** `spawnSync`'s one use here, injectable so a test can stage what a busy host returns. */
export type ProbeRun = (command: string, args: readonly string[], options: { timeout: number; stdio: 'ignore' }) => {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error | undefined
}

function probe(dialect: Dialect, run: ProbeRun): Verdict {
  let result: ReturnType<ProbeRun>
  try {
    const args = [...dialect.profile({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true']
    result = run(dialect.bin, args, { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' })
  } catch {
    return 'unproved'
  }
  if (result.error !== undefined) return spawnRefusal(result.error) === 'missing' ? 'cannot' : 'unproved'
  if (result.signal !== null) return 'unproved'
  return result.status === 0 ? 'enforces' : 'cannot'
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
    envFor(policy) {
      if (policy.mode === 'danger-full-access') return undefined
      const temp = dialect.tempDir(policy)
      return temp === undefined ? undefined : { TMPDIR: temp }
    },
  }
}

/**
 * Only a HOST fact is memoized, per choice: a backend that enforces, one that
 * cannot, a platform with none. Those cannot change inside a process, so every
 * later mount of the shell row gets the same answer without paying for the
 * probe again. A probe that proved nothing (`unproved`) answers `none` to the
 * mount that asked and is forgotten, so a later mount probes again — the
 * browser's rule (`tool-browser`): only a host fault is remembered.
 *
 * A mount is once per PROCESS, though: the row's answer stands for every
 * session that process serves, because a session's stamp and its shell must
 * describe one world, and a re-probe landing between them would part them.
 * So an unproved answer is `fact: false`, and the provider warns the
 * operator that this process runs as a host without a backend until it
 * restarts (S20.5 review: the comment had promised a re-probe).
 */
const selected = new Map<ConfinementChoice, Confinement>()

export function selectConfinementVerdict(choice: ConfinementChoice = 'auto', run: ProbeRun = spawnSync): { readonly confinement: Confinement; readonly fact: boolean } {
  const cached = selected.get(choice)
  if (cached) return { confinement: cached, fact: true }
  const result = resolve(choice, run)
  if (result.fact) selected.set(choice, result.confinement)
  return result
}

export function selectConfinement(choice: ConfinementChoice = 'auto', run: ProbeRun = spawnSync): Confinement {
  return selectConfinementVerdict(choice, run).confinement
}

function resolve(choice: ConfinementChoice, run: ProbeRun): { readonly confinement: Confinement; readonly fact: boolean } {
  if (choice === 'none') return { confinement: NO_CONFINEMENT, fact: true }
  const id = choice === 'auto' ? PLATFORM_CANDIDATE[process.platform] : choice
  if (id === undefined) return { confinement: NO_CONFINEMENT, fact: true }
  const dialect = DIALECTS[id]
  const verdict = probe(dialect, run)
  return { confinement: verdict === 'enforces' ? build(dialect) : NO_CONFINEMENT, fact: verdict !== 'unproved' }
}

/** What a host with no backend should be told to install, named per platform. */
export function confinementRemedy(): string {
  if (process.platform === 'linux') return 'install bubblewrap (apt install bubblewrap) or run the session under "danger-full-access"'
  if (process.platform === 'darwin') return 'ensure sandbox-exec is usable, or run the session under "danger-full-access"'
  return 'no confinement backend exists for this platform; approve the command, or run the session under "danger-full-access"'
}
