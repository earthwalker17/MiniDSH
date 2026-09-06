/**
 * Who tells the model about this session's authority, and from what.
 *
 * Two claims: the runtime-context section is a fold of the LOG — of the stamp
 * this lifecycle opened under, both halves of it — so nothing outside the log
 * can rewrite the prefix the prompt cache is keyed on; and a switch reaches the
 * model as a durable injected message written here rather than by the service
 * that owns the knob.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger, type Plugin } from '../../kernel/index.ts'
import { AGENTS, agentPlugin, type Agent, type AgentHandle } from '../../core/agent/index.ts'
import { agentInvariantPlugin } from '../../core/agent/invariant.ts'
import { APPROVAL, approvalPlugin } from '../../core/approval/index.ts'
import { invariantsPlugin } from '../../core/invariants/index.ts'
import { llmPlugin } from '../../core/llm/index.ts'
import { loopInvariantPlugin, loopPlugin } from '../../core/loop/index.ts'
import { PROMPT, promptPlugin } from '../../core/prompt/index.ts'
import { SANDBOX, sandboxPlugin, type SandboxEnforcement, type SandboxMode } from '../../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../../core/sandbox/invariant.ts'
import { sessionInvariantPlugin, sessionPlugin } from '../../core/session/index.ts'
import { SHELL, type Shell, type ShellSession } from '../../core/shell/index.ts'
import { toolsPlugin } from '../../core/tools/index.ts'
import { contextRuntimePlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

/** A shell world whose confinement answer can change under a live agent. */
class SwitchableShell implements Shell {
  readonly dialect = 'bash' as const
  readonly denialSignatures: readonly string[] = []
  enforcement: SandboxEnforcement
  constructor(enforcement: SandboxEnforcement) {
    this.enforcement = enforcement
  }
  sessionFor(): ShellSession {
    throw new Error('not used')
  }
  enforcementFor(_mode: SandboxMode): SandboxEnforcement {
    return this.enforcement
  }
}

interface Harness {
  root: Context
  shell: SwitchableShell
  create(mode?: SandboxMode): Promise<AgentHandle>
  fork(source: Agent): Promise<AgentHandle>
  dispose(): Promise<void>
}

const open: Harness[] = []
afterEach(async () => {
  for (const mounted of open.splice(0)) await mounted.dispose()
})

async function harness(enforcement: SandboxEnforcement = 'none', defaultMode: SandboxMode = 'workspace-write'): Promise<Harness> {
  const root = createRoot({ logger: silent })
  const shell = new SwitchableShell(enforcement)
  const shellRow: Plugin = {
    name: 'test-shell',
    apply(ctx) {
      ctx.provide(SHELL, shell)
    },
  }
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin, {})
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(sandboxPlugin, { mode: defaultMode })
  root.plugin(authorityInvariantPlugin)
  root.plugin(shellRow)
  root.plugin(contextRuntimePlugin, {})
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(loopPlugin)
  root.plugin(loopInvariantPlugin)
  await root.settle()
  const handles: AgentHandle[] = []
  const created: Harness = {
    root,
    shell,
    async create() {
      const handle = await root.get(AGENTS).create(root, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      handles.push(handle)
      return handle
    },
    async fork(source) {
      const handle = await root.get(AGENTS).fork(root, source.session)
      handles.push(handle)
      return handle
    },
    async dispose() {
      for (const handle of handles.toReversed()) await handle.dispose()
      await root.dispose()
    },
  }
  open.push(created)
  return created
}

/** The switch note is drained on a microtask, so it has landed by the next tick. */
async function settleNotes(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function notes(agent: Agent): string {
  return JSON.stringify(agent.session.events.filter((event) => event.type === 'inbox/spliced').map((event) => event.data))
}

describe('the runtime-context section', () => {
  it('reads confinement off the recorded stamp, so a world that changes under a live agent cannot rewrite the prompt', async () => {
    const test = await harness('full')
    const { agent } = await test.create()
    const before = await test.root.get(PROMPT).assemble(agent)
    // This host confines, and the stamp says so.
    expect(before.system).not.toContain('cannot confine shell commands')

    // A shell row swapped under a live agent. The section is a fold of the log,
    // so the prefix the provider's cache is keyed on does not move.
    test.shell.enforcement = 'none'
    const after = await test.root.get(PROMPT).assemble(agent)
    expect(after.system).toBe(before.system)
  })

  it('tells a model that cannot confine what a refusal means', async () => {
    const test = await harness('none')
    const { agent } = await test.create()
    const assembled = await test.root.get(PROMPT).assemble(agent)
    expect(assembled.system).toContain('cannot confine shell commands')
    expect(assembled.system).toContain('A denial is policy, not a bug')
  })

  it('states the authority THIS lifecycle opened under, not the one its log opens with', async () => {
    const test = await harness('none')
    const { agent } = await test.create()
    test.root.get(SANDBOX).setMode(agent.session, 'read-only')
    test.root.get(APPROVAL).setPolicy(agent.session, 'never')
    // The switched session keeps stating what it opened under: the section is
    // byte-stable for a lifecycle, and the switch is a message instead.
    expect((await test.root.get(PROMPT).assemble(agent)).system).toContain('Sandbox: workspace-write')

    // A new lifecycle over the same history opens under what the log says NOW.
    const forked = await test.fork(agent)
    const system = (await test.root.get(PROMPT).assemble(forked.agent)).system
    expect(system).toContain('Sandbox: read-only')
    expect(system).toContain('Approvals: never')
  })

  it('stays byte-identical across a switch on a FORKED session, which wrote no opening stamp of its own', async () => {
    // A fresh session writes `initial` at creation, so its opening is the first
    // stamp of its own lifecycle. A fork whose host enforces identically writes
    // NOTHING at pickup — so the first stamp at or after `liveStart` is the next
    // `setMode`, and taking that one moved the section mid-lifecycle. The
    // stability test that existed only covered a fresh agent and passed anyway.
    const test = await harness('none')
    const { agent } = await test.create()
    const forked = await test.fork(agent)
    expect(forked.agent.session.facts.filter((event) => event.type === 'sandbox/mode' && event.seq >= forked.agent.session.liveStart)).toHaveLength(0)

    const before = (await test.root.get(PROMPT).assemble(forked.agent)).system
    test.root.get(SANDBOX).setMode(forked.agent.session, 'read-only')
    test.root.get(APPROVAL).setPolicy(forked.agent.session, 'never')
    const after = (await test.root.get(PROMPT).assemble(forked.agent)).system
    expect(after).toBe(before)
    expect(after).toContain('Sandbox: workspace-write')
  })

  it('a RESUMED lifecycle states the mode it is under, where reading the log’s first stamp told it the opposite', async () => {
    // The defect this closes, exactly: a session switched to `read-only` and
    // then picked up again writes NO new stamp (nothing changed), so the log's
    // first stamp is still the `initial` of the session it was resumed from.
    // `authorityLines` read that one, and told a read-only lifecycle it was
    // workspace-write — the widest of the two, and the wrong direction to be
    // wrong in for a sentence the model plans against.
    const first = await harness('none')
    const original = await first.create()
    first.root.get(SANDBOX).setMode(original.agent.session, 'read-only')
    first.root.get(APPROVAL).setPolicy(original.agent.session, 'never')
    const seed = original.agent.session.forkSeed()
    const id = original.agent.id

    const test = await harness('none')
    const resumed = await test.root.get(AGENTS).create(test.root, {
      cwd: process.cwd(),
      sessionId: id,
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      seed,
      origin: 'resumed',
    })
    // The premise, pinned: the log's FIRST stamp says workspace-write, which is
    // what the old `facts.find(...)` returned and what the model was told.
    const stamps = resumed.agent.session.events.filter((event) => event.type === 'sandbox/mode')
    expect((stamps[0]!.data as { mode: string }).mode).toBe('workspace-write')
    // Nothing changed on pickup, so no stamp of this lifecycle's own exists…
    expect(stamps.filter((event) => event.seq >= resumed.agent.session.liveStart)).toHaveLength(0)
    // …and the section still has to say what this lifecycle is actually under.
    const system = (await test.root.get(PROMPT).assemble(resumed.agent)).system
    expect(system).toContain('Sandbox: read-only')
    expect(system).toContain('Approvals: never')
    expect(system).not.toContain('Sandbox: workspace-write')
    await resumed.dispose()
  })
})

describe('a switch reaches the model as a message', () => {
  it('announces a sandbox switch, from here rather than from the service that recorded it', async () => {
    const test = await harness('none')
    const { agent } = await test.create()
    test.root.get(SANDBOX).setMode(agent.session, 'read-only')
    await settleNotes()
    const note = notes(agent)
    expect(note).toContain('read-only')
    expect(note).toContain('context-runtime')
    // The service that owns the knob writes no prose.
    expect(note).not.toContain('core-sandbox')
  })

  it('announces an approval switch, which nothing used to tell the model about at all', async () => {
    const test = await harness('none')
    const { agent } = await test.create()
    test.root.get(APPROVAL).setPolicy(agent.session, 'never')
    await settleNotes()
    expect(notes(agent)).toContain('Approvals are now')
  })

  it('sends ONE message for a switch that moves both knobs', async () => {
    const test = await harness('none')
    const { agent } = await test.create()
    test.root.get(SANDBOX).setMode(agent.session, 'danger-full-access')
    test.root.get(APPROVAL).setPolicy(agent.session, 'never')
    await settleNotes()
    const spliced = agent.session.events.filter((event) => event.type === 'inbox/spliced')
    expect(spliced).toHaveLength(1)
    const text = JSON.stringify(spliced[0]!.data)
    expect(text).toContain('danger-full-access')
    expect(text).toContain('Approvals are now')
  })

  it('says nothing when a switch changes nothing', async () => {
    const test = await harness('none')
    const { agent } = await test.create()
    test.root.get(SANDBOX).setMode(agent.session, 'workspace-write')
    await settleNotes()
    expect(agent.session.events.filter((event) => event.type === 'inbox/spliced')).toHaveLength(0)
  })
})
