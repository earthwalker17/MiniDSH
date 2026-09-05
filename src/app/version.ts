/**
 * What version of MiniDSH this is — read once, from the one place that already
 * knows.
 *
 * `--version`, the `initialize` handshake and the terminal's banner all said a
 * version, and the last two said a string hard-coded in the protocol plugin
 * that nothing kept level with `package.json`. Same rule as the CLI's flag
 * table: one table, never two strings.
 *
 * Resolved against `import.meta.url` rather than the working directory, so it
 * answers the same from anywhere the binary is run, and a store it cannot read
 * degrades to a stated `unknown` rather than throwing — a version string is not
 * worth failing a boot over.
 */
import { readFileSync } from 'node:fs'

function readVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const VERSION = readVersion()
