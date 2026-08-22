/**
 * The shell seam (Definition only; a capability provides it).
 *
 * One persistent shell session per agent, calls serialized per owner. The
 * provider owns the process table and binds each session's disposal to the
 * owning agent's context.
 */
import { serviceKey } from '../../kernel/index.ts'
import type { Agent } from '../agent/types.ts'

export interface ShellExecRequest {
  readonly command: string
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
}

export interface ShellSession {
  exec(request: ShellExecRequest): Promise<ShellRunResult>
  restart(): Promise<void>
  dispose(): Promise<void>
}

export interface Shell {
  /** The persistent shell for an agent, created on first use and disposed with the agent. */
  sessionFor(agent: Agent): ShellSession
  /** The dialect this provider speaks (for the tool's description and name). */
  readonly dialect: 'bash' | 'pwsh'
}

export const SHELL = serviceKey<Shell>('shell')
