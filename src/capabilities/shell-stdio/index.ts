/**
 * Persistent shell provider over piped stdio (no PTY). One shell child per
 * agent, created on first use and disposed with the agent's scope. Commands
 * are serialized and framed by a per-session marker.
 *
 * The confinement backend lives here as a spawn wrapper (`confine/`): the
 * child is spawned inside it, and both real mechanisms are inherited by every
 * descendant, so one wrap confines every command that shell will ever run.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { canonicalPath, type SandboxEnforcement, type SandboxMode } from '../../core/sandbox/index.ts'
import { SHELL, type Shell, type ShellSession } from '../../core/shell/index.ts'
import { CONFINEMENT_CHOICES, selectConfinement, type Confinement, type ConfinementChoice } from './confine/index.ts'
import { ShellProcess, type ShellDialect } from './process.ts'

export interface ShellStdioConfig {
  readonly dialect: ShellDialect
  readonly shellPath?: string | undefined
  /** In-memory capture bound per command. What the MODEL sees is the tool's business, not the executor's. */
  readonly maxCaptureChars?: number | undefined
  /**
   * Which OS confinement mechanism wraps the shell. `auto` (the default) picks
   * by platform and PROBES it, so a host that cannot enforce reports `none`
   * and refuses rather than running unconfined. `none` is not a weakening —
   * it is what every host without a backend already does, named explicitly so
   * a test about that host does not depend on the machine it runs on.
   */
  readonly confinement?: ConfinementChoice | undefined
}

const configSchema = z.strictObject({
  dialect: z.enum(['bash', 'pwsh']),
  shellPath: z.string().min(1).optional(),
  maxCaptureChars: z.number().int().positive().optional(),
  confinement: z.enum(CONFINEMENT_CHOICES).optional(),
})

class ShellStdioProvider implements Shell {
  readonly dialect: ShellDialect
  private readonly config: ShellStdioConfig
  private readonly confinement: Confinement
  private readonly sessions = new WeakMap<Agent, ShellSession>()
  constructor(config: ShellStdioConfig) {
    this.dialect = config.dialect
    this.config = config
    // Probed once, at mount, and then a synchronous fact: `enforcementFor` is
    // asked while a stamp is being recorded, inside event delivery.
    this.confinement = selectConfinement(config.confinement ?? 'auto')
  }

  get denialSignatures(): readonly string[] {
    return this.confinement.denialSignatures
  }

  /**
   * What the mounted mechanism actually delivers. `danger-full-access` is not
   * confined at all, so there is nothing to enforce and nothing to claim —
   * the same answer a host with no backend gives, for the opposite reason.
   */
  enforcementFor(mode: SandboxMode): SandboxEnforcement {
    if (mode === 'danger-full-access') return 'none'
    return this.confinement.enforcement
  }

  sessionFor(agent: Agent): ShellSession {
    const existing = this.sessions.get(agent)
    if (existing) return existing
    // The CANONICAL cwd, which is the identity `ctx.sandbox` resolves the
    // workspace root to. A backend binds and grants that path, so a shell
    // started at a symlinked spelling of it would be standing somewhere the
    // grant does not name — and under bwrap the spelling can be masked
    // outright when it lives under /tmp.
    const process = new ShellProcess(this.dialect, canonicalPath(agent.session.header.cwd), {
      confinement: this.confinement,
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
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(SHELL, new ShellStdioProvider(config))
  },
}

export { ShellProcess } from './process.ts'
export type { ShellDialect } from './process.ts'
export { selectConfinement, NO_CONFINEMENT } from './confine/index.ts'
export type { Confinement, ConfinementChoice, ConfinementId } from './confine/index.ts'
