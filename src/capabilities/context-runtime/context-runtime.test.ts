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
