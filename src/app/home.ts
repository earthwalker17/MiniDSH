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
