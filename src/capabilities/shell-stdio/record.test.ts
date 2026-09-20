/**
 * The shell's effect record, through the real provider and a real child.
 *
 * `ShellProcess` holds a cwd string and a confinement and deliberately no
 * session, so the record is the PROVIDER's: a thin decorator around the
 * process, which is what `sessionFor` memoizes. What is pinned here is when it
 * writes and when it must not — a command that never ran leaves no record, and
 * a record without a call to hang it on is not written at all.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import type { Agent } from '../../core/agent/types.ts'
import { asCallId } from '../../core/ids.ts'
import { canonicalPath, type SandboxExecutionPolicy } from '../../core/sandbox/index.ts'
import { SHELL, type ShellSession } from '../../core/shell/index.ts'
import { shellStdioPlugin, type ShellDialect } from './index.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const binary = dialect === 'pwsh' ? 'pwsh' : 'bash'
const available = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
/** A real `pwsh` start costs 1.2-2 s on an idle Windows machine; same budget as the neighbouring shell suites. */
const SHELL_TEST_TIMEOUT_MS = 120_000

let harness: CoreHarness | undefined
let workdir: string | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  workdir = undefined
})

interface Effect {
  callId: string
  effect: string
  exitCode?: number
  durationMs: number
  mode: string
  enforcement: string
  timedOut?: true
}

const effects = (agent: Agent): Effect[] =>
  agent.session.facts.filter((event) => event.type === 'effect/recorded').map((event) => event.data as Effect)

async function setup(): Promise<{ agent: Agent; shell: ShellSession; policy: SandboxExecutionPolicy }> {
  workdir = mkdtempSync(join(tmpdir(), 'minidsh-shellrec-'))
  harness = await coreHarness()
  // Nothing confines, so the run must be one this host will not refuse.
  harness.root.plugin(shellStdioPlugin, { dialect, confinement: 'none' })
  await harness.root.settle()
  const { agent } = await harness.create({ cwd: workdir })
  return {
    agent,
    shell: harness.root.get(SHELL).sessionFor(agent),
    policy: { mode: 'danger-full-access', workspaceRoot: canonicalPath(workdir) },
  }
}

describe.runIf(available)('the shell effect record', () => {
  it(
    'records a command that ran: its exit code, its duration, and the authority it actually got',
    { timeout: SHELL_TEST_TIMEOUT_MS },
    async () => {
      const { agent, shell, policy } = await setup()
      const result = await shell.exec({ command: 'echo recorded', policy, callId: asCallId('c1') })
      expect(result.output).toContain('recorded')

      const [record, ...rest] = effects(agent)
      expect(rest).toHaveLength(0)
      expect(record).toMatchObject({ callId: 'c1', effect: 'shell-command', exitCode: 0, mode: 'danger-full-access', enforcement: 'none' })
      expect(record!.timedOut).toBeUndefined()
    },
  )

  /**
   * The duration is the RUN's, not the caller's. Two commands are issued
   * without awaiting the first, so the second sits in the per-owner queue
   * behind a slow one: if `startedAt` were stamped at `exec()` rather than
   * where the command reaches the child, the second record would carry the
   * whole wait. Comparing the record to the result it came from proves
   * nothing — they are the same number.
   */
  it('measures the run, not the wait behind another command', { timeout: SHELL_TEST_TIMEOUT_MS }, async () => {
    const { agent, shell, policy } = await setup()
    const slow = dialect === 'pwsh' ? 'Start-Sleep -Milliseconds 700' : 'sleep 0.7'
    const first = shell.exec({ command: slow, policy, callId: asCallId('slow') })
    const second = shell.exec({ command: 'echo second', policy, callId: asCallId('fast') })
    await Promise.all([first, second])

    const fast = effects(agent).find((record) => record.callId === 'fast')!
    const queued = effects(agent).find((record) => record.callId === 'slow')!
    expect(queued.durationMs).toBeGreaterThan(500)
    expect(fast.durationMs, 'the queue wait behind the slow command is not this command s duration').toBeLessThan(500)
  })

  it('records a killed command as timed out, with no exit code to report', { timeout: SHELL_TEST_TIMEOUT_MS }, async () => {
    const { agent, shell, policy } = await setup()
    const forever = dialect === 'pwsh' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
    const result = await shell.exec({ command: forever, policy, callId: asCallId('c1'), timeoutMs: 300 })
    expect(result.timedOut).toBe(true)

    const [record] = effects(agent)
    expect(record).toMatchObject({ callId: 'c1', effect: 'shell-command', timedOut: true })
    // A killed command has no exit code, and the record must not invent one.
    expect(record!.exitCode).toBeUndefined()
    // Stamped where the result was decided, so the kill and the reap that
    // follow it are not charged to the command's own deadline.
    expect(record!.durationMs, 'the shell teardown after the deadline is not part of the run').toBeLessThan(2_000)
  })

  it('records nothing without a call to key it to', { timeout: SHELL_TEST_TIMEOUT_MS }, async () => {
    const { agent, shell, policy } = await setup()
    await shell.exec({ command: 'echo anonymous', policy })
    expect(effects(agent)).toHaveLength(0)
  })

  it('records nothing for a command that never ran', { timeout: SHELL_TEST_TIMEOUT_MS }, async () => {
    const { agent, shell, policy } = await setup()
    // A disposed shell used to answer like a command that ran and printed
    // nothing. It says `aborted` now, which is also what stops this.
    await shell.dispose()
    const result = await shell.exec({ command: 'echo never', policy, callId: asCallId('c1') })
    expect(result.aborted).toBe(true)
    expect(effects(agent)).toHaveLength(0)
  })

  it('records nothing for a call cancelled before dispatch', { timeout: SHELL_TEST_TIMEOUT_MS }, async () => {
    const { agent, shell, policy } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await shell.exec({ command: 'echo never', policy, callId: asCallId('c1'), signal: controller.signal })
    expect(result.aborted).toBe(true)
    expect(effects(agent)).toHaveLength(0)
  })
})
