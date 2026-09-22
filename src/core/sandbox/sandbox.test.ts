/**
 * The authority plane: one stamp, derived roots, a durable mode that folds out
 * of the log, and the closed vocabulary the invariant defends.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { AGENTS } from '../agent/index.ts'
import { asSessionId } from '../ids.ts'
import { APPROVAL, APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_POLICY, APPROVAL_REQUEST, type ApprovalOutcome } from '../approval/index.ts'
import { matches, type EventEnvelope } from '../session/index.ts'
import {
  allowsWrite,
  effectiveSandboxMode,
  isInside,
  isWider,
  lastSandboxStamp,
  meetsAcceptance,
  SANDBOX,
  SANDBOX_ACCEPTANCE,
  SANDBOX_MODE,
  strictest,
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
  it('records the opening mode at agent creation, and a resolve records nothing new', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const sandbox = harness.root.get(SANDBOX)
    // Before any effect: the audit already says what the session started under.
    expect(stamps(agent.session.events)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'initial' }])

    const first = sandbox.resolve({ session: agent.session })
    expect(first.mode).toBe('workspace-write')
    sandbox.resolve({ session: agent.session })
    sandbox.resolve({ session: agent.session })
    expect(stamps(agent.session.events)).toHaveLength(1)
  })

  it('a session created outside the registry is still stamped by its first resolve', async () => {
    harness = await coreHarness()
    const { SESSIONS } = await import('../session/index.ts')
    const session = harness.root.get(SESSIONS).create({ cwd: process.cwd() })
    expect(stamps(session.events)).toHaveLength(0)
    harness.root.get(SANDBOX).resolve({ session })
    expect(stamps(session.events)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'initial' }])
    await harness.root.get(SESSIONS).detach(session)
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

  it('records a switch and writes no prose about it: what the model is told is a capability’s business', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.get(SANDBOX).setMode(agent.session, 'read-only')
    await Promise.resolve()
    // The switch IS its event. `context-runtime` turns that event into a
    // message (see its own test); a core-only composition composes no English
    // and reaches for no agent registry to deliver it.
    expect(agent.session.events.filter((event) => event.type === 'inbox/spliced')).toHaveLength(0)
    expect(agent.session.events.filter((event) => event.type === 'sandbox/mode')).toHaveLength(2)
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
    // `policy`, not a decider: the audit distinguishes the durable `never` from
    // a person or a rule saying no, because only one of those can be argued with.
    expect(decided.data).toEqual({ id: (asked.data as { id: string }).id, outcome: 'rejected', decidedBy: 'policy' })
  })

  it('opens with the deployment policy at creation, folds the last policy event, and records a switch only when it changes', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const approval = harness.root.get(APPROVAL)
    expect(approval.policyFor(agent.session)).toBe('ask')

    approval.setPolicy(agent.session, 'never')
    approval.setPolicy(agent.session, 'never')
    approval.setPolicy(agent.session, 'ask')
    const records = agent.session.events.filter((event) => matches(event, APPROVAL_POLICY)).map((event) => event.data)
    expect(records).toEqual([
      { policy: 'ask', reason: 'initial' },
      { policy: 'never', reason: 'change' },
      { policy: 'ask', reason: 'change' },
    ])
    expect(approval.policyFor(agent.session)).toBe('ask')
  })

  it('every decision is preceded by the policy that governed it, even for a session created outside the registry', async () => {
    harness = await coreHarness()
    const { SESSIONS } = await import('../session/index.ts')
    const { agent } = await harness.create()
    // A bare session carries no opening record until the seam acts on it.
    const bare = harness.root.get(SESSIONS).create({ cwd: process.cwd() })
    expect(bare.events.some((event) => matches(event, APPROVAL_POLICY))).toBe(false)
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'rejected')
    await harness.root.get(APPROVAL).request({ agent: { ...agent, session: bare } as typeof agent, toolName: 'x' })
    const kinds = bare.events.map((event) => event.type)
    expect(kinds.indexOf('approval/policy')).toBeLessThan(kinds.indexOf('approval/asked'))
    await harness.root.get(SESSIONS).detach(bare)
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

  it('refuses a forged SUBJECT, which would render as authority the runtime never resolved', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const before = agent.session.seq
    // A subject is what a person consents to and what a grant is keyed on, so
    // the closed family and the two closed authority vocabularies are held
    // here for the same reason the mode vocabulary is.
    const forge = (subject: unknown): void =>
      void agent.session.append(APPROVAL_ASKED, { id: `approval-${agent.session.seq}`, toolName: 'bash', subject } as never)
    expect(() => forge({ effect: 'network-request', url: 'https://x' })).toThrowError(/unknown effect/)
    expect(() => forge({ effect: 'shell-command', command: 'ls', mode: 'unfenced', enforcement: 'none' })).toThrowError(/unknown mode/)
    expect(() => forge({ effect: 'shell-command', command: 'ls', mode: 'workspace-write', enforcement: 'best-effort' })).toThrowError(
      /unknown enforcement/,
    )
    expect(() => forge({ effect: 'shell-command', command: 42, mode: 'workspace-write', enforcement: 'none' })).toThrowError(
      /command is not a string/,
    )
    expect(() => forge('ls -la')).toThrowError(/not an object/)
    expect(agent.session.seq).toBe(before)
  })

  it('refuses a decision with no matching request', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    expect(() => agent.session.append(APPROVAL_DECIDED, { id: 'approval-999', outcome: 'allowed-once' })).toThrowError(/no matching/)
  })
})

describe('what enforcement a session accepts', () => {
  it('orders the enforcement lattice the OTHER way from the mode lattice', () => {
    // `narrowest` ranks modes by permissiveness ascending, so reaching for it
    // here inverts the ceiling: a delegation row set to `none` would read as a
    // narrowing of a parent at `full`, and the child would get the unconfined
    // shell the parent refused. These assertions fail on that inversion.
    expect(strictest('full', 'none')).toBe('full')
    expect(strictest('none', 'full')).toBe('full')
    expect(strictest('partial', 'none')).toBe('partial')
    expect(strictest('full', 'partial')).toBe('full')
    // And what a world delivers satisfies what a session accepts only when it
    // is at least as strict.
    expect(meetsAcceptance('full', 'none')).toBe(true)
    expect(meetsAcceptance('none', 'full')).toBe(false)
    expect(meetsAcceptance('none', 'none')).toBe(true)
    expect(meetsAcceptance('partial', 'full')).toBe(false)
  })

  it('defaults to refusing what this host cannot confine', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    expect(harness.root.get(SANDBOX).acceptsFor(agent.session, 'workspace-write')).toBe('full')
    // And records nothing: a line saying "full" would say what the default
    // already says, on every session ever created.
    expect(agent.session.events.filter((event) => matches(event, SANDBOX_ACCEPTANCE))).toHaveLength(0)
  })

  /**
   * The deployment default is what `serve`, `web` and `chat` reach through:
   * they do not create the session themselves, so `--accept` can only arrive
   * as a row default. It was read into the service and consulted for nobody —
   * `initialize` advertised it while every session refused — so the flag was
   * silently a no-op on exactly the host that needs it.
   */
  it('lets a deployment weaken the default, and pins a child against it', async () => {
    harness = await coreHarness({ sandbox: { accepts: 'none' } })
    const { agent } = await harness.create()
    const sandbox = harness.root.get(SANDBOX)
    expect(sandbox.acceptsFor(agent.session, 'workspace-write')).toBe('none')
    // Still a DEFAULT, not a stamp: nothing is recorded until somebody decides.
    expect(agent.session.events.filter((event) => matches(event, SANDBOX_ACCEPTANCE))).toHaveLength(0)

    // And the hazard the fallback creates, closed: a child whose row pins it to
    // `full` records that `full`, because otherwise the fold would fall through
    // to the deployment's `none` and the delegation would WIDEN the child.
    const child = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      delegatedBy: agent.session.id,
      setup: (_childCtx, delegated) => {
        sandbox.open(delegated.session, { mode: 'read-only', reason: 'delegation', accepts: 'full' })
        harness!.root.get(APPROVAL).open(delegated.session, { policy: 'never', reason: 'delegation' })
      },
    })
    expect(sandbox.acceptsFor(child.agent.session, 'read-only')).toBe('full')
    await child.dispose()
  })

  it('applies an acceptance ONLY to the mode it was accepted for', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const sandbox = harness.root.get(SANDBOX)
    sandbox.setAcceptance(agent.session, 'none', 'workspace-write')
    expect(sandbox.acceptsFor(agent.session, 'workspace-write')).toBe('none')
    // The whole point: the shell's refusal is mode-blind, so an acceptance
    // without a mode would unfence `read-only` too.
    expect(sandbox.acceptsFor(agent.session, 'read-only')).toBe('full')
    expect(sandbox.acceptsFor(agent.session, 'danger-full-access')).toBe('full')
  })

  it('is a durable last-wins fold per mode, and records nothing when nothing changes', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const sandbox = harness.root.get(SANDBOX)
    sandbox.setAcceptance(agent.session, 'none', 'workspace-write')
    sandbox.setAcceptance(agent.session, 'none', 'workspace-write')
    expect(agent.session.events.filter((event) => matches(event, SANDBOX_ACCEPTANCE))).toHaveLength(1)
    sandbox.setAcceptance(agent.session, 'full', 'workspace-write')
    expect(sandbox.acceptsFor(agent.session, 'workspace-write')).toBe('full')
    expect(agent.session.events.filter((event) => matches(event, SANDBOX_ACCEPTANCE))).toHaveLength(2)
  })

  it('refuses a child that RECORDED no acceptance just as firmly as one that did', async () => {
    // The hole the live delegation arc found on its first run: a child whose
    // parent accepted nothing records no acceptance of its own — the strict
    // default needs no line — so keying the refusal on that stamp left exactly
    // those children free to accept an unconfined shell their parent never had.
    harness = await coreHarness()
    const sandbox = harness.root.get(SANDBOX)
    const child = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      delegatedBy: asSessionId('parent-session'),
      setup: (_childCtx, agent) => {
        sandbox.open(agent.session, { mode: 'workspace-write', reason: 'delegation' })
        harness!.root.get(APPROVAL).open(agent.session, { policy: 'never', reason: 'delegation' })
      },
    })
    try {
      const session = child.agent.session
      expect(session.events.filter((event) => matches(event, SANDBOX_ACCEPTANCE))).toHaveLength(0)
      expect(() => sandbox.setAcceptance(session, 'none', 'workspace-write')).toThrowError(/cannot change it/)
      // And pre-commit, off the approval pin every delegated session carries.
      expect(() => session.append(SANDBOX_ACCEPTANCE, { accepts: 'none', forMode: 'workspace-write', reason: 'change' })).toThrowError(
        /delegated session was started accepting/,
      )
      expect(sandbox.acceptsFor(session, 'workspace-write')).toBe('full')
    } finally {
      await child.dispose()
    }
  })

  it('refuses to be renegotiated inside a delegated session, and refuses a forged one pre-commit', async () => {
    harness = await coreHarness()
    const sandbox = harness.root.get(SANDBOX)
    const child = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      delegatedBy: asSessionId('parent-session'),
      setup: (_childCtx, agent) => {
        sandbox.open(agent.session, { mode: 'workspace-write', reason: 'delegation', accepts: 'none' })
      },
    })
    try {
      const session = child.agent.session
      expect(sandbox.acceptsFor(session, 'workspace-write')).toBe('none')
      // A pin, not a ceiling: a child that cannot ask anyone anything has no
      // actor with standing to renegotiate what it was started accepting.
      expect(() => sandbox.setAcceptance(session, 'full', 'workspace-write')).toThrowError(/cannot change it/)
      // And whatever gets past the setter is refused before it enters the log.
      expect(() => session.append(SANDBOX_ACCEPTANCE, { accepts: 'none', forMode: 'read-only', reason: 'change' })).toThrowError(
        /delegated session was started accepting/,
      )
      expect(() => session.append(SANDBOX_ACCEPTANCE, { accepts: 'best-effort' as never, forMode: 'read-only', reason: 'change' })).toThrowError(
        /unknown enforcement/,
      )
    } finally {
      await child.dispose()
    }
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

describe('a delegated session: the opening is the ceiling', () => {
  it('opens under a delegation stamp before publication, and every widening is refused before it can enter the log', async () => {
    harness = await coreHarness()
    const { delegationCeiling } = await import('./index.ts')
    const sandbox = harness.root.get(SANDBOX)
    const approval = harness.root.get(APPROVAL)
    const agents = harness.root.get(AGENTS)
    const handle = await agents.create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      // What a delegating tool does in the child's setup: open both knobs under the parent's authority, explicitly.
      setup: (_agentCtx, agent) => {
        sandbox.open(agent.session, { mode: 'workspace-write', reason: 'delegation' })
        approval.open(agent.session, { policy: 'never', reason: 'delegation' })
      },
    })
    const session = handle.agent.session
    // The seed wins: the `agent/created` opening wrote nothing on top of it.
    expect(stamps(session.events)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'delegation' }])
    expect(session.events.filter((event) => matches(event, APPROVAL_POLICY)).map((event) => event.data)).toEqual([{ policy: 'never', reason: 'delegation' }])
    expect(delegationCeiling(session.facts)).toBe('workspace-write')

    // The setters refuse a widening, an escalation grant included.
    expect(() => sandbox.setMode(session, 'danger-full-access')).toThrowError(expect.objectContaining({ code: 'SANDBOX_CEILING' }))
    expect(() => sandbox.resolve({ session, mode: 'danger-full-access' })).toThrowError(expect.objectContaining({ code: 'SANDBOX_CEILING' }))
    expect(() => approval.setPolicy(session, 'ask')).toThrowError(expect.objectContaining({ code: 'APPROVAL_PINNED' }))
    expect(() => sandbox.open(session, { mode: 'danger-full-access', reason: 'delegation' })).toThrowError(expect.objectContaining({ code: 'SANDBOX_ALREADY_OPEN' }))
    expect(() => approval.open(session, { policy: 'ask', reason: 'delegation' })).toThrowError(expect.objectContaining({ code: 'APPROVAL_ALREADY_OPEN' }))
    // And the invariant refuses a forged widening pre-commit, so nothing that got past a setter could land either.
    expect(() => session.append(SANDBOX_MODE, { mode: 'danger-full-access', enforcement: 'none', reason: 'change' })).toThrowError(/widens past the delegation ceiling/)
    expect(() => session.append(APPROVAL_POLICY, { policy: 'ask', reason: 'change' })).toThrowError(/leaves the delegation pin/)

    // Narrowing stays legal, returning to the ceiling is legal, restating the pin is not a switch.
    expect(sandbox.setMode(session, 'read-only')).toBe('read-only')
    expect(sandbox.setMode(session, 'workspace-write')).toBe('workspace-write')
    expect(approval.setPolicy(session, 'never')).toBe('never')
    expect(stamps(session.events).map((stamp) => stamp.mode)).toEqual(['workspace-write', 'read-only', 'workspace-write'])

    // A delegation stamp that is not the first of its knob is refused for any session.
    const { agent: top } = await harness.create()
    expect(() => top.session.append(SANDBOX_MODE, { mode: 'read-only', enforcement: 'none', reason: 'delegation' })).toThrowError(/must be the first/)
    expect(() => top.session.append(APPROVAL_POLICY, { policy: 'never', reason: 'delegation' })).toThrowError(/must be the first/)
    // A top-level session has no ceiling: widening is its own business.
    expect(sandbox.setMode(top.session, 'danger-full-access')).toBe('danger-full-access')
    await handle.dispose()
  })
})
