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

/** User settings layer (agent defaults). Never authority, never composition. */
export function settingsPath(): string {
  return join(resolveHome(), 'settings.json')
}

/** Named secrets store: `{ "NAME": "value" }`. Only the names ever leave this file. */
export function credentialsPath(): string {
  return join(resolveHome(), 'credentials.json')
}
