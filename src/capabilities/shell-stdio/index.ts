/**
 * Persistent shell provider over piped stdio (no PTY). One shell child per
 * agent, created on first use and disposed with the agent's scope. Commands
 * are serialized and framed by a per-session marker.
 */
import type { Plugin } from '../../kernel/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import type { SandboxEnforcement, SandboxMode } from '../../core/sandbox/index.ts'
import { SHELL, type Shell, type ShellSession } from '../../core/shell/index.ts'
import { ShellProcess, type ShellDialect } from './process.ts'

export interface ShellStdioConfig {
  readonly dialect: ShellDialect
  readonly shellPath?: string
  /** In-memory capture bound per command. What the MODEL sees is the tool's business, not the executor's. */
  readonly maxCaptureChars?: number
}

class ShellStdioProvider implements Shell {
  readonly dialect: ShellDialect
  private readonly config: ShellStdioConfig
  private readonly sessions = new WeakMap<Agent, ShellSession>()
  constructor(config: ShellStdioConfig) {
    this.dialect = config.dialect
    this.config = config
  }

  /**
   * A piped child shell is not confined: this provider enforces nothing, so a
   * confined command refuses rather than running unconfined. Real enforcement
   * arrives as a provider that wraps the spawn in an OS sandbox (bwrap,
   * Landlock, Seatbelt, a Windows restricted token) and reports it here.
   */
  enforcementFor(_mode: SandboxMode): SandboxEnforcement {
    return 'none'
  }

  sessionFor(agent: Agent): ShellSession {
    const existing = this.sessions.get(agent)
    if (existing) return existing
    const process = new ShellProcess(this.dialect, agent.session.header.cwd, {
      enforcementFor: (mode) => this.enforcementFor(mode),
      ...(this.config.shellPath === undefined ? {} : { shellPath: this.config.shellPath }),
      ...(this.config.maxCaptureChars === undefined ? {} : { maxCaptureChars: this.config.maxCaptureChars }),
    })
    this.sessions.set(agent, process)
    // The shell dies with the agent's scope.
    agent.ctx.effect(() => () => process.dispose(), 'shell.session')
    return process
  }
}

/** Provides `ctx.shell`. Pick the dialect at composition time (pwsh on win32, bash elsewhere). */
export const shellStdioPlugin: Plugin<ShellStdioConfig> = {
  name: 'shell-stdio',
  apply(ctx, config) {
    ctx.provide(SHELL, new ShellStdioProvider(config))
  },
}

export { ShellProcess } from './process.ts'
export type { ShellDialect } from './process.ts'
