/**
 * The authority plane: one stamp, derived roots, a durable mode that folds out
 * of the log, and the closed vocabulary the invariant defends.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { AGENTS } from '../agent/index.ts'
import { APPROVAL, APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_POLICY, APPROVAL_REQUEST, type ApprovalOutcome } from '../approval/index.ts'
import { matches, type EventEnvelope } from '../session/index.ts'
import {
  allowsWrite,
  effectiveSandboxMode,
  isInside,
  isWider,
  lastSandboxStamp,
  SANDBOX,
  SANDBOX_MODE,
  writableRoots,
  type SandboxExecutionPolicy,
  type SandboxMode,
} from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const policy = (mode: SandboxMode, root = ROOT): SandboxExecutionPolicy => ({ mode, workspaceRoot: root })

const stamps = (events: readonly EventEnvelope[]) =>
  events.filter((event) => matches(event, SANDBOX_MODE)).map((event) => event.data as { mode: string; enforcement: string; reason: string })

describe('sandbox policy: one stamp, derived roots', () => {
  it('derives the writable allow-list from the mode, so no two worlds can disagree', () => {
    expect(writableRoots(policy('workspace-write'))).toEqual([ROOT])
    expect(writableRoots(policy('read-only'))).toEqual([])
    // danger-full-access has no allow-list because it fences nothing.
    expect(writableRoots(policy('danger-full-access'))).toEqual([])
  })

  it('allows a write only inside the workspace, and only in a mode that permits writing', () => {
    const inside = join(ROOT, 'src', 'a.ts')
    const outside = join(ROOT, '..', 'elsewhere', 'a.ts')
    expect(allowsWrite(policy('workspace-write'), inside)).toBe(true)
    expect(allowsWrite(policy('workspace-write'), outside)).toBe(false)
    expect(allowsWrite(policy('read-only'), inside)).toBe(false)
    expect(allowsWrite(policy('danger-full-access'), outside)).toBe(true)
  })

  it('escalation must be strictly wider than the mode it escalates from', () => {
    expect(isWider('danger-full-access', 'workspace-write')).toBe(true)
    expect(isWider('workspace-write', 'read-only')).toBe(true)
    expect(isWider('workspace-write', 'workspace-write')).toBe(false)
    expect(isWider('read-only', 'workspace-write')).toBe(false)
  })

  it('containment treats the root itself as inside and rejects an escape', () => {
    expect(isInside(ROOT, ROOT)).toBe(true)
    expect(isInside(ROOT, join(ROOT, 'a', 'b'))).toBe(true)
    expect(isInside(ROOT, join(ROOT, '..', 'a'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('containment refuses a different drive instead of reading it as inside', () => {
    // path.relative between different roots returns the target verbatim.
    expect(isInside('C:\\ws', 'D:\\ws\\a.ts')).toBe(false)
    expect(isInside('C:\\ws', 'c:\\WS\\a.ts')).toBe(true)
  })
})

describe('sandbox mode: durable, folded, recorded when it changes', () => {
  it('records the effective mode the first time a call resolves, and not again', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const sandbox = harness.root.get(SANDBOX)
    expect(stamps(agent.session.events)).toHaveLength(0)

    const first = sandbox.resolve({ session: agent.session })
    expect(first.mode).toBe('workspace-write')
    expect(stamps(agent.session.events)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'initial' }])

    sandbox.resolve({ session: agent.session })
    sandbox.resolve({ session: agent.session })
    expect(stamps(agent.session.events)).toHaveLength(1)
  })

  it('an approved one-shot escalation is never recorded as a session switch', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const sandbox = harness.root.get(SANDBOX)
    sandbox.resolve({ session: agent.session })

    const escalated = sandbox.resolve({ session: agent.session, mode: 'danger-full-access' })
    expect(escalated.mode).toBe('danger-full-access')
    expect(stamps(agent.session.events)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'initial' }])
    expect(effectiveSandboxMode(agent.session.events)).toBe('workspace-write')
    // The next ordinary call is back under the session mode.
    expect(sandbox.resolve({ session: agent.session }).mode).toBe('workspace-write')
  })

  it('a switch is its event, and re-setting the same mode records nothing', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const sandbox = harness.root.get(SANDBOX)
    sandbox.resolve({ session: agent.session })

    sandbox.setMode(agent.session, 'read-only')
    sandbox.setMode(agent.session, 'read-only')
    expect(stamps(agent.session.events)).toEqual([
      { mode: 'workspace-write', enforcement: 'none', reason: 'initial' },
      { mode: 'read-only', enforcement: 'none', reason: 'change' },
    ])
    expect(sandbox.resolve({ session: agent.session }).mode).toBe('read-only')
  })

  it('tells the model about a switch through a durable injected message, never a rewritten prompt', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.get(SANDBOX).setMode(agent.session, 'read-only')
    const inbox = agent.session.events.filter((event) => event.type === 'inbox/spliced')
    const note = inbox.map((event) => JSON.stringify(event.data)).join(' ')
    expect(note).toContain('read-only')
    expect(note).toContain('core-sandbox')
  })

  it('a resumed session keeps its own recorded mode instead of falling back to the deployment default', async () => {
    const first = await coreHarness()
    const original = await first.create()
    first.root.get(SANDBOX).setMode(original.agent.session, 'read-only')
    const id = original.agent.id
    const seed = original.agent.session.forkSeed()
    await first.dispose()

    harness = await coreHarness()
    expect(harness.root.get(SANDBOX).defaultMode).toBe('workspace-write')
    const resumed = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      sessionId: id,
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      seed,
    })
    expect(harness.root.get(SANDBOX).resolve({ session: resumed.agent.session }).mode).toBe('read-only')
    // Nothing changed, so the pickup records nothing new (the two stamps are the
    // opening mode and the switch, both inherited from the seed).
    expect(stamps(resumed.agent.session.events)).toHaveLength(2)
    await resumed.dispose()
  })

  it('an agent-less call is fenced to the configured root and records nothing', async () => {
    harness = await coreHarness()
    const resolved = harness.root.get(SANDBOX).resolve({})
    expect(resolved.mode).toBe('workspace-write')
    expect(resolved.workspaceRoot.length).toBeGreaterThan(0)
    expect(allowsWrite(resolved, join(resolved.workspaceRoot, 'x.txt'))).toBe(true)
  })
})

describe('approval policy: the strict unattended stance', () => {
  it('refuses without consulting any answerer, and still logs the audit pair', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let consulted = false
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      consulted = true
      return 'allowed-once'
    })
    const approval = harness.root.get(APPROVAL)
    approval.setPolicy(agent.session, 'never')

    expect(await approval.request({ agent, toolName: 'bash' })).toBe('rejected')
    expect(consulted).toBe(false)
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    const decided = agent.session.events.find((event) => matches(event, APPROVAL_DECIDED))!
    expect((decided.data as { id: string; outcome: string })).toEqual({ id: (asked.data as { id: string }).id, outcome: 'rejected' })
  })

  it('folds the last policy event and records a switch only when it changes', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const approval = harness.root.get(APPROVAL)
    expect(approval.policyFor(agent.session)).toBe('ask')

    approval.setPolicy(agent.session, 'never')
    approval.setPolicy(agent.session, 'never')
    approval.setPolicy(agent.session, 'ask')
    const records = agent.session.events.filter((event) => matches(event, APPROVAL_POLICY)).map((event) => event.data)
    expect(records).toEqual([
      { policy: 'never', reason: 'initial' },
      { policy: 'ask', reason: 'change' },
    ])
    expect(approval.policyFor(agent.session)).toBe('ask')
  })
})

describe('the authority invariant', () => {
  it('refuses a forged mode before it can enter the log', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const before = agent.session.seq
    expect(() => agent.session.append(SANDBOX_MODE, { mode: 'unfenced' as SandboxMode, enforcement: 'full', reason: 'change' })).toThrowError(
      /unknown mode/,
    )
    expect(agent.session.seq).toBe(before)
  })

  it('refuses a second decision for one approval', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'rejected')
    await harness.root.get(APPROVAL).request({ agent, toolName: 'bash' })
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    expect(() => agent.session.append(APPROVAL_DECIDED, { id: (asked.data as { id: string }).id, outcome: 'allowed-once' })).toThrowError(
      /already decided/,
    )
  })

  it('refuses a decision with no matching request', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    expect(() => agent.session.append(APPROVAL_DECIDED, { id: 'approval-999', outcome: 'allowed-once' })).toThrowError(/no matching/)
  })
})

describe('the stamp is legible on its own', () => {
  it('reports the last recorded stamp including the enforcement the host could deliver', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.get(SANDBOX).resolve({ session: agent.session })
    // No execution world is mounted in the core harness, so nothing is enforced.
    expect(lastSandboxStamp(agent.session.events)).toEqual({ mode: 'workspace-write', enforcement: 'none', reason: 'initial' })
  })
})
