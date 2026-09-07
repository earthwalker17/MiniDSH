/**
 * The shell boundary and the one negotiation over it.
 *
 * The executor never negotiates: under a mode it cannot enforce, the command
 * is refused and the model is told what it may ask for. The ask is the model's
 * own move, the approval seam is the consent step, and a grant covers exactly
 * one call — it is never a session switch.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import type { Agent } from '../../core/agent/types.ts'
import { APPROVAL, APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_REQUEST, type ApprovalOutcome } from '../../core/approval/index.ts'
import { SANDBOX, SANDBOX_MODE, type SandboxEnforcement, type SandboxMode } from '../../core/sandbox/index.ts'
import { matches } from '../../core/session/index.ts'
import { TOOLS, toolCall } from '../../core/tools/index.ts'
import { SHELL, type Shell, type ShellExecRequest, type ShellSession } from '../../core/shell/index.ts'
import { shellStdioPlugin, type ShellDialect } from '../shell-stdio/index.ts'
import { toolShellPlugin } from './index.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const toolName = dialect === 'pwsh' ? 'pwsh' : 'bash'
const binary = dialect === 'pwsh' ? 'pwsh' : 'bash'
const shellAvailable = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
const echoCmd = dialect === 'pwsh' ? "Write-Output 'ran'" : "echo 'ran'"

/**
 * Every test here is about a host with NO confinement backend: the refusal,
 * the escalation it offers, and the grant that covers one call. Pinned, so a
 * machine with bwrap or sandbox-exec does not quietly turn them into tests of
 * something else — `../shell-stdio/confine.test.ts` covers that host.
 */
const UNCONFINED = { confinement: 'none' } as const

/**
 * The four cases below reach a REAL shell, and a `pwsh` start alone costs
 * 1.2-2 s on an idle Windows machine — close enough to the 30 s default that a
 * loaded runner fails them as timeouts rather than as defects. Same budget and
 * same reasoning as `spill-local/spill.test.ts` and `shell-stdio/shell.test.ts`.
 */
const SHELL_TEST_TIMEOUT_MS = 120_000


let harness: CoreHarness | undefined
let workdir: string | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  workdir = undefined
})

interface Fixture {
  agent: Agent
  run(args: object): Promise<{ isError: boolean; code: string | undefined; text: string }>
}

async function setup(): Promise<Fixture> {
  workdir = mkdtempSync(join(tmpdir(), 'minidsh-shelltool-'))
  harness = await coreHarness()
  harness.root.plugin(shellStdioPlugin, { dialect, ...UNCONFINED })
  harness.root.plugin(toolShellPlugin, {})
  await harness.root.settle()
  const { agent } = await harness.create({ cwd: workdir })
  const tools = harness.root.get(TOOLS)
  return {
    agent,
    run: async (args: object) => {
      const result = await tools.execute(toolCall(`call-${Math.random()}`, toolName, JSON.stringify(args), agent, new AbortController().signal))
      const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      return { isError: result.isError, code: result.error?.info?.code, text }
    },
  }
}

const approvals = (agent: Agent): { type: string; [key: string]: unknown }[] =>
  agent.session.events
    .filter((event) => matches(event, APPROVAL_ASKED) || matches(event, APPROVAL_DECIDED))
    .map((event) => ({ ...(event.data as Record<string, unknown>), type: event.type }))

const modeStamps = (agent: Agent) => agent.session.events.filter((event) => matches(event, SANDBOX_MODE))

describe('the shell under a mode this host cannot enforce', () => {
  it('refuses the command and reports the escalation the model may ask for', async () => {
    const { agent, run } = await setup()
    const result = await run({ command: echoCmd })
    // A reported fact, not a tool failure: nothing ran.
    expect(result.isError).toBe(false)
    expect(result.text).toContain('[sandbox:')
    expect(result.text).toContain('no confinement backend')
    expect(result.text).toContain('sandbox_permissions')
    expect(approvals(agent)).toHaveLength(0)
  })

  it('runs without any approval once the session mode needs no confinement', async () => {
    const { agent, run } = await setup()
    harness!.root.get(SANDBOX).setMode(agent.session, 'danger-full-access')
    const result = await run({ command: echoCmd })
    expect(result.text).not.toContain('[sandbox:')
    expect(approvals(agent)).toHaveLength(0)
  }, SHELL_TEST_TIMEOUT_MS)
})

/**
 * A world that confines, driven from the test rather than from the machine.
 *
 * On a host with a backend the tool's guidance and its refusal move: the
 * command RUNS and the kernel refuses the write, so nothing arrives as
 * `SANDBOX_UNAVAILABLE` and the escalation would be invisible unless the
 * denial itself carries it. That is what these pin, on every platform,
 * including the one that ships no backend at all.
 */
class StubShell implements Shell {
  readonly dialect: ShellDialect = dialect
  readonly denialSignatures = ['read-only file system']
  readonly seen: ShellExecRequest[] = []
  private readonly answer: { output: string; exitCode: number }
  constructor(answer: { output: string; exitCode: number }) {
    this.answer = answer
  }
  enforcementFor(mode: SandboxMode): SandboxEnforcement {
    return mode === 'danger-full-access' ? 'none' : 'full'
  }
  sessionFor(): ShellSession {
    return {
      exec: (request: ShellExecRequest) => {
        this.seen.push(request)
        return Promise.resolve({
          output: this.answer.output,
          exitCode: this.answer.exitCode,
          timedOut: false,
          truncated: false,
          reset: false,
          sandbox: { mode: request.policy.mode, enforcement: this.enforcementFor(request.policy.mode) },
        })
      },
      restart: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    }
  }
}

async function confinedSetup(answer: { output: string; exitCode: number }): Promise<Fixture & { shell: StubShell }> {
  workdir = mkdtempSync(join(tmpdir(), 'minidsh-shelltool-'))
  harness = await coreHarness()
  const shell = new StubShell(answer)
  harness.root.plugin({ name: 'shell-stub', apply: (ctx) => void ctx.provide(SHELL, shell) })
  harness.root.plugin(toolShellPlugin, {})
  await harness.root.settle()
  const { agent } = await harness.create({ cwd: workdir })
  const tools = harness.root.get(TOOLS)
  return {
    agent,
    shell,
    run: async (args: object) => {
      const result = await tools.execute(toolCall(`call-${Math.random()}`, toolName, JSON.stringify(args), agent, new AbortController().signal))
      const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      return { isError: result.isError, code: result.error?.info?.code, text }
    },
  }
}

describe('the shell on a host that DOES confine', () => {
  it('runs an ordinary command with no refusal and no approval at all', async () => {
    const { agent, run } = await confinedSetup({ output: 'ran', exitCode: 0 })
    const result = await run({ command: echoCmd })
    expect(result.text).toContain('ran')
    expect(result.text).not.toContain('[sandbox:')
    expect(approvals(agent)).toHaveLength(0)
  })

  it('offers the same escalation for a KERNEL denial that a refusal offers, since nothing else would', async () => {
    const { run } = await confinedSetup({ output: "sh: 1: cannot create /etc/x: Read-only file system", exitCode: 2 })
    const result = await run({ command: echoCmd })
    expect(result.text).toContain('the sandbox refused a file effect')
    expect(result.text).toContain('sandbox_permissions')
    expect(result.text).toContain('"danger-full-access"')
  })

  it('says nothing about escalation for an ordinary failure that merely exits non-zero', async () => {
    const { run } = await confinedSetup({ output: 'grep: no matches', exitCode: 1 })
    const result = await run({ command: echoCmd })
    expect(result.text).not.toContain('[sandbox:')
  })

  it('marks an approved escalation one-shot, and tells the model its state did not persist', async () => {
    const { agent, run, shell } = await confinedSetup({ output: 'ran', exitCode: 0 })
    harness!.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'allowed-once')
    const result = await run({ command: echoCmd, sandbox_permissions: 'danger-full-access', justification: 'write outside' })
    expect(result.isError).toBe(false)
    expect(shell.seen.at(-1)!.oneShot).toBe(true)
    expect(shell.seen.at(-1)!.policy.mode).toBe('danger-full-access')
    expect(result.text).toContain('ran in a separate shell')
    // One ask per escalation: a command that already spent consent is finished.
    expect(approvals(agent).filter((entry) => entry.type === 'approval/asked')).toHaveLength(1)
  })

  it('never asks twice: a denial on an already-escalated command carries no fresh hint', async () => {
    const { run } = await confinedSetup({ output: 'cannot create /etc/x: Read-only file system', exitCode: 2 })
    harness!.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'allowed-once')
    const result = await run({ command: echoCmd, sandbox_permissions: 'danger-full-access', justification: 'write outside' })
    expect(result.text).not.toContain('the sandbox refused a file effect')
  })

  it('describes the boundary the way THIS host actually enforces it', async () => {
    await confinedSetup({ output: 'ran', exitCode: 0 })
    const schemas = harness!.root.get(TOOLS).schemas()
    const description = schemas.find((schema) => schema.name === toolName)!.description
    expect(description).toContain('inside an OS sandbox')
    expect(description).not.toContain('cannot be confined on this host is REFUSED')
  })
})

describe('escalation', () => {
  it('requires a justification alongside the requested mode, and says so as an argument error', async () => {
    const { run } = await setup()
    const result = await run({ command: echoCmd, sandbox_permissions: 'danger-full-access' })
    expect(result.isError).toBe(true)
    // Not TOOL_FAILED: a bad argument reads like every other bad argument.
    expect(result.code).toBe('INVALID_ARGS')
    expect(result.text).toContain('must be given together')
  })

  it('never spends consent on a wider mode this host still could not confine', async () => {
    const { agent, run } = await setup()
    let asked = 0
    harness!.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      asked++
      return 'allowed-once'
    })
    harness!.root.get(SANDBOX).setMode(agent.session, 'read-only')
    // workspace-write IS strictly wider than read-only, but nothing here can
    // enforce it either, so a grant would have bought a second refusal.
    const result = await run({ command: echoCmd, sandbox_permissions: 'workspace-write', justification: 'need to write' })
    expect(asked).toBe(0)
    expect(approvals(agent)).toHaveLength(0)
    expect(result.text).toContain('would not let the command run')
  })

  it('names only the modes an escalation could actually succeed under', async () => {
    const { agent, run } = await setup()
    harness!.root.get(SANDBOX).setMode(agent.session, 'read-only')
    const result = await run({ command: echoCmd })
    expect(result.text).toContain('"danger-full-access"')
    expect(result.text).not.toContain('"workspace-write"')
  })

  it('refuses a request that is not strictly wider than the current mode', async () => {
    const { run } = await setup()
    const result = await run({ command: echoCmd, sandbox_permissions: 'workspace-write', justification: 'please' })
    expect(result.code).toBe('SANDBOX_NOT_WIDER')
  })

  it('ends the command when the user rejects, and does not ask again', async () => {
    const { agent, run } = await setup()
    let asked = 0
    harness!.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      asked++
      return 'rejected'
    })
    const result = await run({ command: echoCmd, sandbox_permissions: 'danger-full-access', justification: 'run the suite' })
    expect(result.code).toBe('SANDBOX_ESCALATION_DENIED')
    expect(asked).toBe(1)
    expect(approvals(agent).map((entry) => entry.type)).toEqual(['approval/asked', 'approval/decided'])
  })

  it('is refused outright when the session policy is never, without consulting an answerer', async () => {
    const { agent, run } = await setup()
    let consulted = false
    harness!.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      consulted = true
      return 'allowed-once'
    })
    harness!.root.get(APPROVAL).setPolicy(agent.session, 'never')
    const result = await run({ command: echoCmd, sandbox_permissions: 'danger-full-access', justification: 'run the suite' })
    expect(result.code).toBe('SANDBOX_ESCALATION_DENIED')
    expect(consulted).toBe(false)
  })

  /**
   * The registry deadline used to keep ticking while a person deliberated over
   * this body's escalation consent; with the default 120 s executor budget a
   * 135 s deliberation ended as TOOL_TIMEOUT, and the grant then landed on a
   * call the model had already been told was over. The executor owns the whole
   * deadline now, so consent takes as long as consent takes.
   */
  it.skipIf(!shellAvailable)('lets consent outlast the registry default budget: the shell tool owns its own deadline', async () => {
    workdir = mkdtempSync(join(tmpdir(), 'minidsh-shelltool-'))
    harness = await coreHarness({ tools: { defaultTimeoutMs: 30 } })
    harness.root.plugin(shellStdioPlugin, { dialect, ...UNCONFINED })
    harness.root.plugin(toolShellPlugin, {})
    await harness.root.settle()
    const { agent } = await harness.create({ cwd: workdir })
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return 'allowed-once'
    })
    const result = await harness.root
      .get(TOOLS)
      .execute(toolCall('call-slow', toolName, JSON.stringify({ command: echoCmd, sandbox_permissions: 'danger-full-access', justification: 'run it' }), agent, new AbortController().signal))
    expect(result.error?.info?.code).toBeUndefined()
    expect(result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).toContain('ran')
  }, SHELL_TEST_TIMEOUT_MS)

  it.skipIf(!shellAvailable)('an already-cancelled call dispatches nothing to the persistent shell', async () => {
    workdir = mkdtempSync(join(tmpdir(), 'minidsh-shelltool-'))
    const { ShellProcess } = await import('../shell-stdio/process.ts')
    const shell = new ShellProcess(dialect, workdir)
    try {
      const controller = new AbortController()
      controller.abort()
      const started = Date.now()
      const result = await shell.exec({ command: echoCmd, policy: { mode: 'danger-full-access', workspaceRoot: workdir }, signal: controller.signal })
      expect(result.output).toBe('')
      expect(result.reset).toBe(false)
      expect(result.aborted).toBe(true) // "nothing ran", distinguishable from "ran and printed nothing"
      // Nothing was spawned, so nothing had to be killed: this returns at once.
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      await shell.dispose()
    }
  }, SHELL_TEST_TIMEOUT_MS)

  it.skipIf(!shellAvailable)('runs the command once when granted, and never records it as a session switch', async () => {
    const { agent, run } = await setup()
    harness!.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'allowed-once')
    const result = await run({ command: echoCmd, sandbox_permissions: 'danger-full-access', justification: 'run the suite' })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('ran')

    const asked = approvals(agent).find((entry) => entry.type === 'approval/asked')
    expect(String(asked?.reason)).toContain('run the suite')
    expect(asked?.callId).toBeTruthy()
    // The grant covered that one call: the only stamp is the session own mode.
    expect(modeStamps(agent).map((event) => event.data)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'initial' }])
    expect(harness!.root.get(SANDBOX).resolve({ session: agent.session }).mode).toBe('workspace-write')
  }, SHELL_TEST_TIMEOUT_MS)
})
