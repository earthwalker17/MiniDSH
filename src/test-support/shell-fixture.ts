/**
 * What a test that spawns a REAL shell asks first: does this host have its
 * dialect's binary (`pwsh` on Windows, `bash` elsewhere)?
 *
 * A suite that needs one self-skips without it, so a host that has none
 * reports it green having run nothing — and on Windows a missing `pwsh` is not
 * a skipped feature, it is `SHELL_UNAVAILABLE` on every command the model
 * runs. `MINIDSH_EXPECT_SHELL=1` (every CI leg, and a local run that is meant
 * to count) turns that skip into a failure, but only in a file that says so:
 * `shell.test.ts` held the rule for itself, and each other file that probes
 * the shell with its own copy of this line skipped in silence. A file that
 * skips on the shell calls `expectShellSuite` and is held to the flag too.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/** The shell dialect this platform's sessions run. */
export const shellDialect: 'pwsh' | 'bash' = process.platform === 'win32' ? 'pwsh' : 'bash'

/** Whether that dialect's binary runs here. Bounded: a probe that hangs is a host without a usable shell. */
export const shellAvailable: boolean = spawnSync(shellDialect, ['--version'], { stdio: 'ignore', timeout: 60_000 }).status === 0

/** Fails the run when a shell is required and absent; call once per test file that skips on `shellAvailable`. */
export function expectShellSuite(name: string): void {
  // Registered only when there is something to refuse, so a summary gains no skipped test from it.
  if (process.env.MINIDSH_EXPECT_SHELL !== '1' || shellAvailable) return
  describe(`${name}: a host that is REQUIRED to have a shell`, () => {
    it('has its dialect installed', () => {
      expect.fail(`MINIDSH_EXPECT_SHELL=1 but \`${shellDialect} --version\` does not run on ${process.platform}: every shell test in this file would self-skip`)
    })
  })
}
