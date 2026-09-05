import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxExecutionPolicy } from '../../core/sandbox/index.ts'
import { ShellProcess, type ShellDialect } from './process.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const binary = dialect === 'pwsh' ? 'pwsh' : 'bash'
const available = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
// The stdin redirect is a bash-dialect fix, so it is tested wherever bash exists
// — not only where bash is the platform default.
const bashAvailable = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0

let proc: ShellProcess | undefined
let dir: string | undefined
afterEach(async () => {
  await proc?.dispose()
  proc = undefined
  if (dir) await removeWithRetry(dir)
  dir = undefined
})

/**
 * MSYS bash releases its cwd handle ~100ms AFTER its kill has been reaped, and
 * `rmSync`'s own `maxRetries` retries without ever sleeping (measured: it
 * exhausts 10x50ms inside ~10ms) — so the teardown needs a retry loop with
 * real awaits between attempts.
 */
async function removeWithRetry(target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 40) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/** This provider confines nothing, so the tests run under the one unconfined mode. */
const unconfined = (root: string): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: root })

const echoCmd = (text: string): string => (dialect === 'pwsh' ? `Write-Output '${text}'` : `echo '${text}'`)
const pwdCmd = (): string => (dialect === 'pwsh' ? '(Get-Location).Path' : 'pwd')
// A native non-zero exit (as `node --test` produces) propagates reliably via $LASTEXITCODE / $?.
const failCmd = (): string => 'node -e "process.exit(3)"'

describe.skipIf(!available)(`persistent ${dialect} shell`, () => {
  it('runs a command and captures its output and exit code', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    const result = await proc.exec({ command: echoCmd('hello world'), policy: unconfined(dir), timeoutMs: 30_000 })
    expect(result.output).toContain('hello world')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it('persists working directory across calls', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    mkdirSync(join(dir, 'sub'))
    proc = new ShellProcess(dialect, dir)
    await proc.exec({ command: dialect === 'pwsh' ? 'Set-Location sub' : 'cd sub', policy: unconfined(dir), timeoutMs: 30_000 })
    const result = await proc.exec({ command: pwdCmd(), policy: unconfined(dir), timeoutMs: 30_000 })
    expect(result.output.toLowerCase()).toContain('sub')
  })

  it.skipIf(!bashAvailable)('a command that reads stdin gets EOF instead of the next command', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess('bash', dir)
    // Without the redirect this `cat` would block until the deadline AND eat the
    // next command out of the shared pipe, so the second call would never match.
    const reader = await proc.exec({ command: 'cat', policy: unconfined(dir), timeoutMs: 30_000 })
    expect(reader.timedOut).toBe(false)
    const after = await proc.exec({ command: "echo 'still here'", policy: unconfined(dir), timeoutMs: 30_000 })
    expect(after.output).toContain('still here')
    expect(after.exitCode).toBe(0)
  })

  it('reports a non-zero exit code for a failing command', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    const result = await proc.exec({ command: failCmd(), policy: unconfined(dir), timeoutMs: 30_000 })
    expect(result.exitCode).not.toBe(0)
  })
})

describe('a shell binary that is not there', () => {
  it('refuses with SHELL_UNAVAILABLE naming the binary and the remedy, never a command that printed nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir, { shellPath: 'minidsh-no-such-shell-binary' })
    // A stock Windows has powershell.exe 5.1 and no pwsh: the spawn fails one
    // tick after it returns, and this used to be read as an exited child whose
    // output was empty.
    await expect(proc.exec({ command: echoCmd('hello'), policy: unconfined(dir), timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'SHELL_UNAVAILABLE',
      message: expect.stringContaining('minidsh-no-such-shell-binary'),
    })
  })
})
