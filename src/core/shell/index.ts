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
 * never negotiates; escalation is the tool and approval seam job. A confining
 * provider must also bind its persistent child to the policy it was spawned
 * under, restarting it when the effective policy changes.
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
}

export interface ShellRunResult {
  readonly output: string
  readonly exitCode?: number
  readonly timedOut: boolean
  readonly truncated: boolean
  /** True when the shell was reset (after a timeout); the next call starts fresh. */
  readonly reset: boolean
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
  /** What this execution world can enforce for a confined mode on this host. */
  enforcementFor(mode: SandboxMode): SandboxEnforcement
}

export const SHELL = serviceKey<Shell>('shell')
