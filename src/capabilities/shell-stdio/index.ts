/**
 * Persistent shell provider over piped stdio (no PTY). One shell child per
 * agent, created on first use and disposed with the agent's scope. Commands
 * are serialized and framed by a per-session marker.
 */
import type { Plugin } from '../../kernel/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { SHELL, type Shell, type ShellSession } from '../../core/shell/index.ts'
import { ShellProcess, type ShellDialect } from './process.ts'

export interface ShellStdioConfig {
  readonly dialect: ShellDialect
  readonly shellPath?: string
  readonly maxOutputChars?: number
}

class ShellStdioProvider implements Shell {
  readonly dialect: ShellDialect
  private readonly config: ShellStdioConfig
  private readonly sessions = new WeakMap<Agent, ShellSession>()
  constructor(config: ShellStdioConfig) {
    this.dialect = config.dialect
    this.config = config
  }

  sessionFor(agent: Agent): ShellSession {
    const existing = this.sessions.get(agent)
    if (existing) return existing
    const process = new ShellProcess(this.dialect, agent.session.header.cwd, {
      ...(this.config.shellPath === undefined ? {} : { shellPath: this.config.shellPath }),
      ...(this.config.maxOutputChars === undefined ? {} : { maxOutputChars: this.config.maxOutputChars }),
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
