/**
 * The shell seam (Definition only; a capability provides it).
 *
 * One persistent shell session per agent, calls serialized per owner. The
 * provider owns the process table and binds each shell disposal to the owning
 * agent context.
 *
 * **Authority contract.** Every command carries the caller resolved
 * `SandboxExecutionPolicy` (from `ctx.sandbox`, never assembled by hand). A
 * provider must enforce what it claims in `enforcementFor` and must REFUSE —
 * `SandboxError('SANDBOX_UNAVAILABLE')` — a confined policy it cannot enforce:
 * silent unconfined passthrough is never legal. The provider is deny-only and
 * never negotiates; escalation is the tool and approval seam job.
 *
 * **Binding the persistent child.** Both real backends (bwrap, Seatbelt) can
 * only be applied at spawn and are inherited by every descendant, so a
 * confining provider binds its persistent child to the policy it was spawned
 * under. Two ways the effective policy can differ from that one, and they get
 * different answers:
 *
 *   - a DURABLE switch (`sandbox.setMode`) changes what this session is, so
 *     the persistent child is replaced and the result says `restarted` —
 *     never `reset`, which already tells the model its own command killed the
 *     shell;
 *   - an approved ONE-SHOT escalation is not a session fact at all, so it runs
 *     in a throwaway child (`oneShot`) and leaves the persistent one alone.
 *     A grant that covers one call must not leave shell state behind either,
 *     and the ordinary path keeps the "state persists across calls" promise
 *     the tool description makes.
 *
 * DSH reaches the same binding and answers the first case by REFUSING the
 * switch while a shell is open; it never meets the second, because its
 * persistent shell has no escalation at all.
 */
import { serviceKey } from '../../kernel/index.ts'
import type { Agent } from '../agent/types.ts'
import type { SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '../sandbox/index.ts'

export type ShellErrorCode = 'SHELL_UNAVAILABLE'

/**
 * The shell world could not do what was asked of it at all — its binary is
 * not on this host. Coded like `SandboxError`, so a tool result names the
 * fact and the remedy instead of reading as a command that printed nothing.
 */
export class ShellError extends Error {
  readonly code: ShellErrorCode
  constructor(code: ShellErrorCode, message: string) {
    super(message)
    this.name = 'ShellError'
    this.code = code
  }
}

export interface ShellExecRequest {
  readonly command: string
  /** The per-call authority stamp; resolved by the caller from `ctx.sandbox`. */
  readonly policy: SandboxExecutionPolicy
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /**
   * This policy covers THIS CALL only — an approved escalation, never a
   * session fact. A confining provider runs it in a throwaway child so the
   * persistent shell keeps its own policy and its own state; a provider that
   * confines nothing may ignore it. Set by the caller that took the consent.
   */
  readonly oneShot?: boolean
}

export interface ShellRunResult {
  readonly output: string
  readonly exitCode?: number
  readonly timedOut: boolean
  readonly truncated: boolean
  /** True when the shell was reset (after a timeout); the next call starts fresh. */
  readonly reset: boolean
  /**
   * True when the persistent shell was replaced BEFORE this command ran,
   * because the session's policy no longer matched the child's. Distinct from
   * `reset`: nothing went wrong and the command did run — but the shell state
   * a previous call left behind is gone, and only a caller told so can say so.
   */
  readonly restarted?: true
  /** True when the command was never dispatched because the call was already cancelled: nothing ran. */
  readonly aborted?: true
  /** What actually governed this run — a reported fact, not a promise. */
  readonly sandbox: { readonly mode: SandboxMode; readonly enforcement: SandboxEnforcement }
}

export interface ShellSession {
  exec(request: ShellExecRequest): Promise<ShellRunResult>
  restart(): Promise<void>
  dispose(): Promise<void>
}

export interface Shell {
  /** The persistent shell for an agent, created on first use and disposed with the agent. */
  sessionFor(agent: Agent): ShellSession
  /** The dialect this provider speaks (for the tool description and name). */
  readonly dialect: 'bash' | 'pwsh'
  /**
   * What this execution world can enforce for a confined mode on this host —
   * answered from a FUNCTIONAL probe of the mechanism, never from a binary's
   * presence or a version string, because a backend that is installed and
   * cannot enforce is the case that matters. Synchronous: the sandbox seam
   * asks this while recording a stamp, inside event delivery.
   */
  enforcementFor(mode: SandboxMode): SandboxEnforcement
  /**
   * Lower-cased substrings that mean "the confinement mechanism refused this
   * write" in the mounted backend's own words, for a consumer that wants to
   * offer the escalation a refusal offers. Empty where nothing confines.
   *
   * Each backend advertises only its OWN dialect: a cross-backend union would
   * claim denials a given backend never produces. It is a HINT and never a
   * classification — the worst a false positive costs is one extra line of
   * guidance, which is the whole reason this may be matched out of output at
   * all. It is also incomplete by construction: under bwrap a path beneath
   * the ephemeral tmpfs is INVISIBLE rather than read-only, so its denial
   * reads as an ordinary missing directory and is deliberately not matched.
   */
  readonly denialSignatures: readonly string[]
}

export const SHELL = serviceKey<Shell>('shell')
