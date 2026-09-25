/**
 * The sandbox seam: one authority stamp, carried per call, shared by every
 * execution world.
 *
 * `SandboxMode` governs FILE EFFECTS only — network and process visibility are
 * outside this vocabulary, so the modes are not a general-purpose security
 * boundary. The stamp is resolved per call rather than fixed on a provider, so
 * two consumers may act under different boundaries at the same instant and an
 * approved one-shot escalation is simply a new call with a wider policy.
 *
 * The workspace boundary needs no event of its own: the immutable
 * `SessionHeader.cwd` recorded at creation IS the root for every call in that
 * session. Only the mode is switchable, and a switch IS its durable event —
 * nothing mutates the mode out of band.
 */
import { z } from 'zod'
import { serviceKey, type Context, type Plugin } from '../../kernel/index.ts'
import { AGENT_CREATED } from '../agent/events.ts'
import type { Session } from '../session/index.ts'
import { SHELL } from '../shell/index.ts'
import {
  acceptanceFor,
  DEFAULT_ACCEPTANCE,
  delegationAcceptance,
  delegationCeiling,
  effectiveSandboxMode,
  isWider,
  lastSandboxStamp,
  recordedAcceptance,
  SANDBOX_ACCEPTANCE,
  SANDBOX_MODE,
  SANDBOX_MODES,
  type SandboxEnforcement,
  type SandboxMode,
  type SandboxReason,
} from './events.ts'
import { canonicalPath, isInside } from './paths.ts'

export * from './events.ts'

/** The per-call stamp. */
export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode
  /** Absolute, canonical; the root `workspace-write` may write under. */
  readonly workspaceRoot: string
}

export interface SandboxPolicyRequest {
  /** The acting session; its immutable cwd becomes the workspace boundary. */
  readonly session?: Session
  /** An APPROVED one-shot escalation. Outranks the session mode and is never recorded as a switch. */
  readonly mode?: SandboxMode
}

export type SandboxErrorCode = 'SANDBOX_UNAVAILABLE' | 'SANDBOX_NOT_WIDER' | 'SANDBOX_ESCALATION_DENIED' | 'SANDBOX_CEILING' | 'SANDBOX_ALREADY_OPEN'

export class SandboxError extends Error {
  readonly code: SandboxErrorCode
  constructor(code: SandboxErrorCode, message: string) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
  }
}

/**
 * The one allow-list, and a CEILING rather than an equality: every family
 * derives its roots here, and a family may grant LESS than this, never more.
 * So the invariant both of them keep is "no host file outside these roots is
 * modified", not "these roots are writable everywhere".
 *
 * The distinction is what lets a confinement backend be stricter than the
 * declared set without lying about the mode. `shell-stdio`'s bwrap profile
 * mounts an ephemeral tmpfs over `/tmp` and `/dev`: a command may write there
 * and nothing it writes reaches the host or the editor, so the ceiling still
 * describes every host file that can change. DSH pins the same rule with the
 * same mechanism.
 *
 * A deliberate divergence from DSH: DSH's shared list also grants `/tmp` and
 * `os.tmpdir()` (its Seatbelt profile and its in-process fence honour that;
 * its own bwrap backend does not). MiniDSH grants neither, because the temp
 * root is where MiniDSH puts every workspace it tests with — granting it
 * would make the containment check vacuous for a session whose cwd is under
 * it, which is every live arc and any real `minidsh chat --cwd /tmp/scratch`.
 * The cost is recorded in ARCHITECTURE §13: a tool that needs a writable
 * `$TMPDIR` gets the tmpfs on Linux and an escalation on macOS.
 */
export function writableRoots(policy: SandboxExecutionPolicy): readonly string[] {
  if (policy.mode !== 'workspace-write') return []
  return [policy.workspaceRoot]
}

/** The containment decision for one absolute path. Reads are never fenced. */
export function allowsWrite(policy: SandboxExecutionPolicy, absolutePath: string): boolean {
  if (policy.mode === 'danger-full-access') return true
  return writableRoots(policy).some((root) => isInside(root, absolutePath))
}

// ---- the service ----------------------------------------------------------

export interface Sandbox {
  /**
   * Resolves the policy for one call AND records it when it differs from the
   * last recorded stamp (a session picked up on a host that enforces
   * differently logs `resume`). The OPENING stamp is written at agent creation
   * (`open`), so the audit reads what a session started under before its
   * first effect; this is the safety net for a session created outside the
   * registry. An escalation (`request.mode`) is never recorded.
   */
  resolve(request: SandboxPolicyRequest): SandboxExecutionPolicy
  /**
   * Records the mode a session opens under, iff nothing is recorded yet —
   * the deployment default for a fresh session, nothing new for a resumed one
   * whose log already says. Called at `agent/created`, before publication.
   *
   * With an `opening`, the explicit form a creator uses BEFORE publication
   * (in `setup`): the child opens under the mode its parent had at
   * delegation, stamped `reason: 'delegation'` — which is also its ceiling.
   * Its `accepts` is recorded beside it as a PIN unless everything is strict.
   * Refused if the session has already recorded a stamp.
   */
  open(session: Session, opening?: { readonly mode: SandboxMode; readonly reason: 'delegation'; readonly accepts?: SandboxEnforcement }): void
  /** The durable switch. Appends `sandbox/mode` iff the recorded stamp changes; refused past a delegation ceiling. */
  setMode(session: Session, mode: SandboxMode): SandboxMode
  /** What the mounted execution world can enforce for a mode on this host. */
  enforcementFor(mode: SandboxMode): SandboxEnforcement
  /**
   * The weakest enforcement this session accepts for a confined shell command
   * under `mode` — `full` unless somebody said otherwise, which is every host
   * that refuses what it cannot confine.
   *
   * Read per call by the caller that reaches the shell, and passed on the
   * request rather than on the stamp: `SandboxExecutionPolicy` is the value
   * `writableRoots`, `allowsWrite` and both confinement profiles are pure
   * functions of, and a decision about the shell world does not belong in the
   * ceiling both file families derive from.
   */
  acceptsFor(session: Session | undefined, mode: SandboxMode): SandboxEnforcement
  /**
   * The durable switch. Appends `sandbox/acceptance` iff it changes what
   * `mode` accepts; refused on a delegated session, whose acceptance is pinned.
   */
  setAcceptance(session: Session, accepts: SandboxEnforcement, forMode: SandboxMode): void
  /** The deployment default, used by a session that has recorded nothing. */
  readonly defaultMode: SandboxMode
}

export const SANDBOX = serviceKey<Sandbox>('sandbox')

export interface SandboxConfig {
  /** Deployment default for sessions with no recorded mode (default `workspace-write`). */
  readonly mode?: SandboxMode | undefined
  /**
   * Deployment default for what a session accepts from its execution world
   * (default `full`: refuse a confined command this host cannot confine).
   * A weakened default is stamped into each top-level session beside its mode
   * (`stampAcceptance`), so the log names it and a resume keeps it, as it
   * keeps the mode; the row is authority-sensitive.
   */
  readonly accepts?: SandboxEnforcement | undefined
  /** Root for agent-less calls, which have no session cwd (default `process.cwd()`). */
  readonly workspaceRoot?: string | undefined
}

const configSchema = z
  .strictObject({
    mode: z.enum(SANDBOX_MODES).optional(),
    accepts: z.enum(['full', 'partial', 'none']).optional(),
    workspaceRoot: z.string().min(1).optional(),
  })
  .optional()

class SandboxService implements Sandbox {
  readonly defaultMode: SandboxMode
  /** What a session with nothing recorded accepts. A deployment may weaken it; `minidsh config` flags the row that did. */
  private readonly defaultAcceptance: SandboxEnforcement
  private readonly ctx: Context
  private readonly fallbackRoot: string
  private readonly roots = new WeakMap<Session, string>()

  constructor(ctx: Context, config: SandboxConfig) {
    this.ctx = ctx
    this.defaultMode = config.mode ?? 'workspace-write'
    this.defaultAcceptance = config.accepts ?? DEFAULT_ACCEPTANCE
    this.fallbackRoot = canonicalPath(config.workspaceRoot ?? process.cwd())
  }

  /**
   * Execution confinement is reported by the mounted execution world. A
   * `danger-full-access` call is not confined at all, so there is nothing to
   * enforce; the mode itself says so.
   */
  enforcementFor(mode: SandboxMode): SandboxEnforcement {
    if (mode === 'danger-full-access') return 'none'
    return this.ctx.tryGet(SHELL)?.enforcementFor(mode) ?? 'none'
  }

  private rootFor(session: Session | undefined): string {
    if (!session) return this.fallbackRoot
    let root = this.roots.get(session)
    if (root === undefined) {
      root = canonicalPath(session.header.cwd)
      this.roots.set(session, root)
    }
    return root
  }

  resolve(request: SandboxPolicyRequest): SandboxExecutionPolicy {
    const session = request.session
    const workspaceRoot = this.rootFor(session)
    if (request.mode !== undefined) {
      // An approved escalation is a wider call, and a delegated child's calls
      // are never wider than its ceiling — the approval pin already refuses
      // the ask, and this refuses the grant should any answerer ever say yes.
      if (session) this.assertUnderCeiling(session, request.mode)
      return { mode: request.mode, workspaceRoot }
    }
    const mode = (session ? effectiveSandboxMode(session.facts) : undefined) ?? this.defaultMode
    if (session) this.record(session, mode)
    return { mode, workspaceRoot }
  }

  open(session: Session, opening?: { readonly mode: SandboxMode; readonly reason: 'delegation'; readonly accepts?: SandboxEnforcement }): void {
    if (opening === undefined) {
      this.record(session, effectiveSandboxMode(session.facts) ?? this.defaultMode)
      return
    }
    if (lastSandboxStamp(session.facts) !== undefined) {
      throw new SandboxError('SANDBOX_ALREADY_OPEN', `session ${session.id} has already recorded its opening sandbox mode`)
    }
    session.append(SANDBOX_MODE, { mode: opening.mode, enforcement: this.enforcementFor(opening.mode), reason: opening.reason })
    // A child's acceptance is a PIN — first, and unchangeable for its life —
    // and it is recorded unless both it and this deployment are the strict
    // default, so the child's log alone says what it accepted. Comparing
    // against the deployment alone (S15) left a child pinned `none` under a
    // `none` deployment with no line, which a cold reader folds as `full`; and
    // `acceptsFor` below never falls back to the deployment for a child, so a
    // child pinned `full` under a `none` deployment needs its line too.
    if (opening.accepts !== undefined && !(opening.accepts === DEFAULT_ACCEPTANCE && this.defaultAcceptance === DEFAULT_ACCEPTANCE)) {
      session.append(SANDBOX_ACCEPTANCE, { accepts: opening.accepts, forMode: opening.mode, reason: opening.reason })
    }
  }

  /**
   * A delegated child falls back to the STRICT default, never to the
   * deployment and never to its pin: its pin is recorded for the mode it was
   * given for (`open`), and a mode it narrows into (a resumed child may) was
   * accepted by nobody. The deployment fallback let a child pinned `full`,
   * resumed under a `none` deployment, accept an unconfined `read-only` shell;
   * the pin fallback (S16's first fix) let a child pinned `none` for
   * `workspace-write` carry it into `read-only` — the widening `forMode`
   * exists to prevent. With this, a child's answer is exactly the fold of its
   * own log, which is what every cold reader computes.
   */
  acceptsFor(session: Session | undefined, mode: SandboxMode): SandboxEnforcement {
    if (!session) return this.defaultAcceptance
    return acceptanceFor(session.facts, mode, session.header.delegatedBy !== undefined ? DEFAULT_ACCEPTANCE : this.defaultAcceptance)
  }

  setAcceptance(session: Session, accepts: SandboxEnforcement, forMode: SandboxMode): void {
    // The HEADER, not the recorded acceptance. A child whose parent accepted
    // nothing records no acceptance of its own — the strict default needs no
    // line — so keying the refusal on that stamp left exactly those children
    // free to accept an unconfined shell their parent never had. The live
    // delegation arc found it on its first run.
    //
    // A delegated session may not renegotiate this at all: it cannot ask
    // anyone anything, so there is no actor in it with standing to, and
    // narrowing is the delegation row's to express.
    if (session.header.delegatedBy !== undefined) {
      const pin = delegationAcceptance(session.facts)
      throw new SandboxError(
        'SANDBOX_CEILING',
        `session ${session.id} was delegated accepting "${pin?.accepts ?? DEFAULT_ACCEPTANCE}" enforcement and cannot change it`,
      )
    }
    if (this.acceptsFor(session, forMode) === accepts) return
    session.append(SANDBOX_ACCEPTANCE, { accepts, forMode, reason: 'change' })
  }

  private assertUnderCeiling(session: Session, mode: SandboxMode): void {
    const ceiling = delegationCeiling(session.facts)
    if (ceiling !== undefined && isWider(mode, ceiling)) {
      throw new SandboxError('SANDBOX_CEILING', `session ${session.id} was delegated under "${ceiling}" and cannot be widened to "${mode}"`)
    }
  }

  setMode(session: Session, mode: SandboxMode): SandboxMode {
    this.assertUnderCeiling(session, mode)
    const recorded = lastSandboxStamp(session.facts)
    // Compare against what actually governed the session, not only against what
    // was recorded: a session that has not acted yet is under the default, and
    // "switching" to it is not a switch.
    const previous = recorded?.mode ?? this.defaultMode
    // Record what the session started under BEFORE recording the change, so this
    // lifecycle's opening stamp is immutably the opening authority. Anything
    // that renders it (the prompt's runtime-context block) then stays
    // byte-identical for the lifecycle, and the audit reads "started X, then
    // changed to Y".
    if (!recorded) this.record(session, previous)
    this.record(session, mode)
    // A switch IS its event, and that is all this seam owes. What the MODEL is
    // told about one is prose about context, not a property of the authority
    // plane: `context-runtime` writes it, off the `sandbox/mode{change}` this
    // just recorded. Composing that sentence here meant a core seam holding
    // English and reaching for `ctx.agents` to deliver it.
    return mode
  }

  /** Log-only-when-changed, exactly like `request/header`. */
  private record(session: Session, mode: SandboxMode): void {
    const enforcement = this.enforcementFor(mode)
    const last = lastSandboxStamp(session.facts)
    if (last && last.mode === mode && last.enforcement === enforcement) {
      this.stampAcceptance(session, mode, 'resume')
      return
    }
    // Same mode, different enforcement: the session was picked up on another host.
    const reason: SandboxReason = !last ? 'initial' : last.mode === mode ? 'resume' : 'change'
    session.append(SANDBOX_MODE, { mode, enforcement, reason })
    this.stampAcceptance(session, mode, reason)
  }

  /**
   * The acceptance in force, written down when a DEPLOYMENT weakened it — the
   * same discipline as the mode's own opening stamp and the approval
   * policy's, so a stored log says what its session accepted without the host
   * that ran it.
   *
   * For EVERY mode a command can be confined under, not only the session's
   * own: an approved escalation runs one command under a wider mode the
   * session never switched into (`resolve` with a mode records nothing), and
   * stamping it there would end every standing grant (`sandbox/acceptance`
   * is an authority event), so it is written at the opening, before any grant
   * can exist. Nothing is written under the strict default (a line saying
   * `full` would say what the fold already answers), nothing for a mode the
   * log already records (a resume keeps what was recorded), and nothing in a
   * delegated child, whose pin is recorded by `open` and whose every other
   * mode is strict. `reason` is the mode stamp's, or `resume` when this
   * lifecycle picked up a session whose stamp still stands.
   */
  private stampAcceptance(session: Session, mode: SandboxMode, reason: SandboxReason): void {
    if (this.defaultAcceptance === DEFAULT_ACCEPTANCE || session.header.delegatedBy !== undefined) return
    for (const confinable of [mode, ...SANDBOX_MODES.filter((other) => other !== mode)]) {
      // Never confined, so nothing about it is accepted.
      if (confinable === 'danger-full-access') continue
      if (recordedAcceptance(session.facts, confinable) !== undefined) continue
      session.append(SANDBOX_ACCEPTANCE, { accepts: this.defaultAcceptance, forMode: confinable, reason })
    }
  }
}

/** Provides `ctx.sandbox`. Like `core/approval`, the Definition ships its own driver. */
export const sandboxPlugin: Plugin<SandboxConfig | undefined> = {
  name: 'core-sandbox',
  config: configSchema,
  apply(ctx, config) {
    const service = new SandboxService(ctx, config ?? {})
    ctx.provide(SANDBOX, service)
    // The opening stamp is the creator's act, written before publication: the
    // same discipline as the approval policy and the composition record.
    ctx.on(AGENT_CREATED, (agent) => service.open(agent.session))
  },
}

export { canonicalPath, isInside } from './paths.ts'
