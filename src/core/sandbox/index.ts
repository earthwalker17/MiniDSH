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
  delegationCeiling,
  effectiveSandboxMode,
  isWider,
  lastSandboxStamp,
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
   * Refused if the session has already recorded a stamp.
   */
  open(session: Session, opening?: { readonly mode: SandboxMode; readonly reason: 'delegation' }): void
  /** The durable switch. Appends `sandbox/mode` iff the recorded stamp changes; refused past a delegation ceiling. */
  setMode(session: Session, mode: SandboxMode): SandboxMode
  /** What the mounted execution world can enforce for a mode on this host. */
  enforcementFor(mode: SandboxMode): SandboxEnforcement
  /** The deployment default, used by a session that has recorded nothing. */
  readonly defaultMode: SandboxMode
}

export const SANDBOX = serviceKey<Sandbox>('sandbox')

export interface SandboxConfig {
  /** Deployment default for sessions with no recorded mode (default `workspace-write`). */
  readonly mode?: SandboxMode | undefined
  /** Root for agent-less calls, which have no session cwd (default `process.cwd()`). */
  readonly workspaceRoot?: string | undefined
}

const configSchema = z.strictObject({ mode: z.enum(SANDBOX_MODES).optional(), workspaceRoot: z.string().min(1).optional() }).optional()

class SandboxService implements Sandbox {
  readonly defaultMode: SandboxMode
  private readonly ctx: Context
  private readonly fallbackRoot: string
  private readonly roots = new WeakMap<Session, string>()

  constructor(ctx: Context, config: SandboxConfig) {
    this.ctx = ctx
    this.defaultMode = config.mode ?? 'workspace-write'
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

  open(session: Session, opening?: { readonly mode: SandboxMode; readonly reason: 'delegation' }): void {
    if (opening === undefined) {
      this.record(session, effectiveSandboxMode(session.facts) ?? this.defaultMode)
      return
    }
    if (lastSandboxStamp(session.facts) !== undefined) {
      throw new SandboxError('SANDBOX_ALREADY_OPEN', `session ${session.id} has already recorded its opening sandbox mode`)
    }
    session.append(SANDBOX_MODE, { mode: opening.mode, enforcement: this.enforcementFor(opening.mode), reason: opening.reason })
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
    if (last && last.mode === mode && last.enforcement === enforcement) return
    // Same mode, different enforcement: the session was picked up on another host.
    const reason: SandboxReason = !last ? 'initial' : last.mode === mode ? 'resume' : 'change'
    session.append(SANDBOX_MODE, { mode, enforcement, reason })
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
