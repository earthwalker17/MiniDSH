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
import { SANDBOX, SANDBOX_MODE } from '../../core/sandbox/index.ts'
import { matches } from '../../core/session/index.ts'
import { TOOLS, toolCall } from '../../core/tools/index.ts'
import { shellStdioPlugin, type ShellDialect } from '../shell-stdio/index.ts'
import { toolShellPlugin } from './index.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const toolName = dialect === 'pwsh' ? 'pwsh' : 'bash'
const binary = dialect === 'pwsh' ? 'pwsh' : 'bash'
const shellAvailable = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
const echoCmd = dialect === 'pwsh' ? "Write-Output 'ran'" : "echo 'ran'"

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
  harness.root.plugin(shellStdioPlugin, { dialect })
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
  })
})
