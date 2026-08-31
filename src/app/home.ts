import { homedir } from 'node:os'
import { join } from 'node:path'

/** MiniDSH home: `$MINIDSH_HOME` or `~/.minidsh`. Holds all durable user data. */
export function resolveHome(): string {
  const configured = process.env.MINIDSH_HOME
  return configured && configured.length > 0 ? configured : join(homedir(), '.minidsh')
}

export function sessionsDir(): string {
  return join(resolveHome(), 'sessions')
}

/**
 * Oversized tool output, saved per session. Beside the logs rather than in the
 * OS temp directory: a durable `tool/result` naming a path is a lie once a
 * reboot deletes it.
 */
export function spillDir(): string {
  return join(resolveHome(), 'spill')
}

/** Declarative composition layer: patch rows + named agent presets. */
export function compositionPath(): string {
  return join(resolveHome(), 'composition.json')
}

/**
 * The user's global instruction file. Model-facing CONTEXT only — it can no
 * more change this harness's authority than a repository's AGENTS.md can.
 */
export function globalInstructionsPath(): string {
  return join(resolveHome(), 'AGENTS.md')
}

/** User settings layer (agent defaults). Never authority, never composition. */
export function settingsPath(): string {
  return join(resolveHome(), 'settings.json')
}

/** Named secrets store: `{ "NAME": "value" }`. Only the names ever leave this file. */
export function credentialsPath(): string {
  return join(resolveHome(), 'credentials.json')
}

/** The whole layout as the boot options that carry it — one value, resolved once per command. */
export interface HomeLayout {
  readonly sessionsRoot: string
  readonly spillRoot: string
  readonly globalInstructionsPath: string
  readonly credentialsPath: string
  /**
   * The same file `settingsPath()` names, carried down as plugin config because
   * the settings store now WRITES it at runtime. The boot-time read stays in
   * the app; nothing below `app` may resolve the home for itself.
   */
  readonly settingsStorePath: string
}

export function homeLayout(): HomeLayout {
  return {
    sessionsRoot: sessionsDir(),
    spillRoot: spillDir(),
    globalInstructionsPath: globalInstructionsPath(),
    credentialsPath: credentialsPath(),
    settingsStorePath: settingsPath(),
  }
}
