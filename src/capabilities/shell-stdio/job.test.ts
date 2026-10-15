/**
 * A job's process, for real: `ShellProcess.start` spawns a shell, streams its
 * output, settles once, and kills what it started. The assertions are about
 * the WORLD — which processes are still alive, what reached the caller — never
 * about what the handle says of itself.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxExecutionPolicy } from '../../core/sandbox/index.ts'
import type { ShellJobExit } from '../../core/shell/index.ts'
import { ShellProcess, type ShellDialect } from './process.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const binary = dialect === 'pwsh' ? 'pwsh' : 'bash'
const available = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
const TIMEOUT_MS = 120_000

let proc: ShellProcess | undefined
let dir: string | undefined
afterEach(async () => {
  await proc?.dispose()
  proc = undefined
  if (dir) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 40) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
  dir = undefined
})

function setup(options: { shellPath?: string; withheld?: readonly string[] } = {}): { shell: ShellProcess; policy: SandboxExecutionPolicy; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'minidsh-job-'))
  dir = root
  proc = new ShellProcess(dialect, root, {
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    ...(options.withheld === undefined ? {} : { withheld: () => options.withheld! }),
  })
  return { shell: proc, policy: { mode: 'danger-full-access', workspaceRoot: root }, root }
}

/** A grandchild that records its pid and lives until killed: what a dev server's `node` is under `npm run dev`. */
function grandchild(root: string): string {
  writeFileSync(join(root, 'gc.cjs'), "require('fs').writeFileSync('gc.pid', String(process.pid)); setInterval(() => {}, 1000)\n")
  // A second statement keeps the shell as the parent, so the tree is real.
  return dialect === 'pwsh' ? 'node gc.cjs; Write-Output after' : 'node gc.cjs; echo after'
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the world to change')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.runIf(available)('a job process', () => {
  it('streams its output as it arrives and settles once with its exit code', { timeout: TIMEOUT_MS }, async () => {
    const { shell, policy } = setup()
    const chunks: string[] = []
    const command = dialect === 'pwsh' ? 'Write-Output first; Start-Sleep -Milliseconds 400; Write-Output second; exit 3' : 'echo first; sleep 0.4; echo second; exit 3'
    const job = await shell.start({ command, policy, output: (chunk) => chunks.push(chunk) })
    expect(job.pid).toBeGreaterThan(0)
    expect(job.sandbox).toEqual({ mode: 'danger-full-access', enforcement: 'none' })
    await until(() => chunks.join('').includes('first'))
    expect(chunks.join(''), 'the first line arrives before the job ends').not.toContain('second')
    const exit: ShellJobExit = await job.exited
    expect(exit.exitCode).toBe(3)
    expect(chunks.join('')).toContain('second')
  })

  it('kills its whole tree when asked, and the descendant is gone', { timeout: TIMEOUT_MS }, async () => {
    const { shell, policy, root } = setup()
    const job = await shell.start({ command: grandchild(root), policy, output: () => {} })
    await until(() => existsSync(join(root, 'gc.pid')))
    const pid = Number(readFileSync(join(root, 'gc.pid'), 'utf8'))
    expect(alive(pid)).toBe(true)
    job.kill()
    const exit = await job.exited
    expect(exit.exitCode === undefined || exit.exitCode !== 0).toBe(true)
    await until(() => !alive(pid))
  })

  it.runIf(process.platform !== 'win32')('ends with what it wrote when a backgrounded descendant holds the pipe, and reaps that descendant', { timeout: TIMEOUT_MS }, async () => {
    const { shell, policy, root } = setup()
    writeFileSync(join(root, 'bg.cjs'), "require('fs').writeFileSync('bg.pid', String(process.pid)); setInterval(() => {}, 1000)\n")
    const chunks: string[] = []
    const started = Date.now()
    const job = await shell.start({ command: 'node bg.cjs & sleep 0.3; echo marker', policy, output: (chunk) => chunks.push(chunk) })
    const exit = await job.exited
    expect(exit.exitCode).toBe(0)
    expect(chunks.join('')).toContain('marker')
    expect(Date.now() - started, "the pipe's grace, not the descendant's life").toBeLessThan(10_000)
    const pid = Number(readFileSync(join(root, 'bg.pid'), 'utf8'))
    await until(() => !alive(pid))
  })

  it('is reaped by the shell\'s disposal, and says so in its exit', { timeout: TIMEOUT_MS }, async () => {
    const { shell, policy, root } = setup()
    const job = await shell.start({ command: grandchild(root), policy, output: () => {} })
    await until(() => existsSync(join(root, 'gc.pid')))
    const pid = Number(readFileSync(join(root, 'gc.pid'), 'utf8'))
    await shell.dispose()
    expect((await job.exited).disposed).toBe(true)
    await until(() => !alive(pid))
    await expect(shell.start({ command: 'echo late', policy, output: () => {} })).rejects.toMatchObject({ code: 'ABORTED_BEFORE_DISPATCH' })
  })

  it('refuses at start exactly as exec does: an unenforceable policy, a missing binary', { timeout: TIMEOUT_MS }, async () => {
    const { shell, root } = setup()
    const confined: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: root }
    await expect(shell.start({ command: 'echo no', policy: confined, output: () => {} })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    const missing = setup({ shellPath: join(root, 'no-such-shell') })
    await expect(missing.shell.start({ command: 'echo no', policy: missing.policy, output: () => {} })).rejects.toMatchObject({ code: 'SHELL_UNAVAILABLE' })
  })

  it('gets the same scrubbed environment as every other child', { timeout: TIMEOUT_MS }, async () => {
    process.env.S17_DECLARED_SECRET = 'should-not-pass'
    try {
      const { shell, policy } = setup({ withheld: ['S17_DECLARED_SECRET'] })
      const chunks: string[] = []
      const command = dialect === 'pwsh' ? 'Write-Output "[$env:S17_DECLARED_SECRET]"' : 'echo "[$S17_DECLARED_SECRET]"'
      await (await shell.start({ command, policy, output: (chunk) => chunks.push(chunk) })).exited
      expect(chunks.join('').trim()).toBe('[]')
    } finally {
      delete process.env.S17_DECLARED_SECRET
    }
  })

  it('a cancelled one-shot escalation now reaps its tree on every platform', { timeout: TIMEOUT_MS }, async () => {
    const { shell, policy, root } = setup()
    // Cancelled once the grandchild is up, not on a deadline: a loaded host
    // can spend a short deadline starting pwsh, before there is a tree at all.
    const cancel = new AbortController()
    const run = shell.exec({ command: grandchild(root), policy, oneShot: true, timeoutMs: TIMEOUT_MS, signal: cancel.signal })
    await until(() => existsSync(join(root, 'gc.pid')))
    const pid = Number(readFileSync(join(root, 'gc.pid'), 'utf8'))
    expect(alive(pid)).toBe(true)
    cancel.abort()
    await run
    await until(() => !alive(pid))
  })
})
