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
import { serviceKey, type Context, type Plugin } from '../../kernel/index.ts'
import { AGENTS } from '../agent/index.ts'
import { createPluginMessage } from '../llm/message.ts'
import { eventKind, matches, type EventEnvelope, type Session } from '../session/index.ts'
import { SHELL } from '../shell/index.ts'
import { canonicalPath, isInside } from './paths.ts'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * What an execution world actually delivers for a confined mode on this host.
 * `full` governs every file effect the mode promises; `partial` governs only a
 * subset (an older kernel ABI, a backend with known gaps); `none` means the
 * world cannot confine at all and must refuse rather than run unconfined.
 */
export type SandboxEnforcement = 'full' | 'partial' | 'none'

export type SandboxReason = 'initial' | 'change' | 'resume'

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

export type SandboxErrorCode = 'SANDBOX_UNAVAILABLE' | 'SANDBOX_NOT_WIDER' | 'SANDBOX_ESCALATION_DENIED'

export class SandboxError extends Error {
  readonly code: SandboxErrorCode
  constructor(code: SandboxErrorCode, message: string) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
  }
}

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
 * The one allow-list. Every fence derives its roots here so two execution
 * worlds can never disagree about what `workspace-write` means.
 *
 * A deliberate divergence from DSH: DSH also grants `/tmp` and `os.tmpdir()`
 * so its CONFINED shell keeps working with redirects into temp. MiniDSH ships
 * no confined shell, so no such asymmetry can arise — and granting the
 * platform temp root would hand the editor write authority it has no use for.
 * A backend that needs temp writability adds it here, once, for both families.
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

// ---- the durable record ---------------------------------------------------

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

// ---- the service ----------------------------------------------------------

export interface Sandbox {
  /**
   * Resolves the policy for one call AND records it when it differs from the
   * last recorded stamp — resolving is the audit act, so every effect is
   * preceded by a recorded stamp without eagerly stamping a session that never
   * acts. An escalation (`request.mode`) is never recorded.
   */
  resolve(request: SandboxPolicyRequest): SandboxExecutionPolicy
  /** The durable switch. Appends `sandbox/mode` iff the recorded stamp changes. */
  setMode(session: Session, mode: SandboxMode): SandboxMode
  /** What the mounted execution world can enforce for a mode on this host. */
  enforcementFor(mode: SandboxMode): SandboxEnforcement
  /** The deployment default, used by a session that has recorded nothing. */
  readonly defaultMode: SandboxMode
}

export const SANDBOX = serviceKey<Sandbox>('sandbox')

export interface SandboxConfig {
  /** Deployment default for sessions with no recorded mode (default `workspace-write`). */
  readonly mode?: SandboxMode
  /** Root for agent-less calls, which have no session cwd (default `process.cwd()`). */
  readonly workspaceRoot?: string
}

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
    if (request.mode !== undefined) return { mode: request.mode, workspaceRoot }
    const mode = (session ? effectiveSandboxMode(session.events) : undefined) ?? this.defaultMode
    if (session) this.record(session, mode)
    return { mode, workspaceRoot }
  }

  setMode(session: Session, mode: SandboxMode): SandboxMode {
    const previous = lastSandboxStamp(session.events)
    this.record(session, mode)
    if (previous && previous.mode === mode) return mode
    const note =
      `Sandbox mode is now "${mode}". ` +
      (mode === 'read-only'
        ? 'File modifications are refused by policy in this session.'
        : mode === 'danger-full-access'
          ? 'Writes are no longer confined to the workspace.'
          : `Writes are confined to ${this.rootFor(session)}.`)
    this.ctx.tryGet(AGENTS)?.get(session.id)?.inject(createPluginMessage('core-sandbox', note))
    return mode
  }

  /** Log-only-when-changed, exactly like `request/header`. */
  private record(session: Session, mode: SandboxMode): void {
    const enforcement = this.enforcementFor(mode)
    const last = lastSandboxStamp(session.events)
    if (last && last.mode === mode && last.enforcement === enforcement) return
    // Same mode, different enforcement: the session was picked up on another host.
    const reason: SandboxReason = !last ? 'initial' : last.mode === mode ? 'resume' : 'change'
    session.append(SANDBOX_MODE, { mode, enforcement, reason })
  }
}

/** Provides `ctx.sandbox`. Like `core/approval`, the Definition ships its own driver. */
export const sandboxPlugin: Plugin<SandboxConfig | undefined> = {
  name: 'core-sandbox',
  apply(ctx, config) {
    ctx.provide(SANDBOX, new SandboxService(ctx, config ?? {}))
  },
}

export { canonicalPath, isInside } from './paths.ts'
