/**
 * Workspace instructions. The claims worth pinning: they reach the model as
 * DURABLE context (so a resume does not lose them and does not double them),
 * the nearest file wins when the budget is tight, and a repository can tell the
 * model how it likes its code without telling the harness what it may do.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { AGENTS, agentPlugin, type Agent } from '../../core/agent/index.ts'
import { agentInvariantPlugin } from '../../core/agent/invariant.ts'
import { approvalPlugin } from '../../core/approval/index.ts'
import { FS } from '../../core/fs/index.ts'
import { invariantsPlugin } from '../../core/invariants/index.ts'
import { LLM, llmPlugin } from '../../core/llm/index.ts'
import { createUserMessage, messageText, restoreMessage } from '../../core/llm/message.ts'
import { loopInvariantPlugin, loopPlugin } from '../../core/loop/index.ts'
import { PROMPT, promptPlugin } from '../../core/prompt/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../../core/sandbox/invariant.ts'
import { matches, sessionInvariantPlugin, sessionPlugin, USER_MESSAGE } from '../../core/session/index.ts'
import { toolsPlugin } from '../../core/tools/index.ts'
import { assistantText, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { fsLocalPlugin } from '../fs-local/index.ts'
import { collectInstructions, renderInstructions, workspaceInstructionsPlugin, type WorkspaceInstructionsConfig } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

const dirs: string[] = []
let root: Context | undefined
afterEach(async () => {
  await root?.dispose()
  root = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix = 'minidsh-instr-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function mount(config: WorkspaceInstructionsConfig): Promise<{ adapter: ScriptedAdapter; create(cwd: string): Promise<Agent> }> {
  root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin, {})
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(sandboxPlugin, {})
  root.plugin(authorityInvariantPlugin)
  root.plugin(fsLocalPlugin)
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(loopPlugin)
  root.plugin(loopInvariantPlugin)
  root.plugin(workspaceInstructionsPlugin, config)
  await root.settle()
  const adapter = new ScriptedAdapter()
  root.get(LLM).registerAdapter(root, adapter)
  root.get(PROMPT).section(root, { name: 'persona', order: 0, text: 'You are a test agent.' })
  const owner = root
  return {
    adapter,
    async create(cwd: string) {
      const handle = await owner.get(AGENTS).create(owner, { cwd, agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      return handle.agent
    },
  }
}

function entered(agent: Agent): string[] {
  return agent.session.events
    .filter((event) => matches(event, USER_MESSAGE))
    .map((event) => restoreMessage(event.data.message))
    .filter((message) => message.source.kind === 'plugin' && message.source.form === 'workspace-instructions')
    .map((message) => messageText(message))
}

/** A workspace with a git marker, so the root walk stops where a project would. */
function workspaceWithRoot(): string {
  const dir = tempDir()
  mkdirSync(join(dir, '.git'))
  return dir
}

describe('discovery', () => {
  it('reads the global file, then each directory from the project root down to the cwd', async () => {
    const workspace = workspaceWithRoot()
    const home = tempDir('minidsh-home-')
    const nested = join(workspace, 'packages', 'api')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(home, 'AGENTS.md'), 'global rule', 'utf8')
    writeFileSync(join(workspace, 'AGENTS.md'), 'project rule', 'utf8')
    writeFileSync(join(nested, 'AGENTS.md'), 'api rule', 'utf8')

    const mounted = await mount({ maxBytes: 32_000, globalPath: join(home, 'AGENTS.md') })
    const fs = root!.get(FS)
    const sources = await collectInstructions(fs, nested, { maxBytes: 32_000, globalPath: join(home, 'AGENTS.md') })
    expect(sources.map((source) => source.text)).toEqual(['global rule', 'project rule', 'api rule'])
    void mounted
  })

  it('renders a duplicate sibling once', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'the same words', 'utf8')
    writeFileSync(join(workspace, 'CLAUDE.md'), '  the same words  ', 'utf8')
    await mount({ maxBytes: 32_000 })
    const sources = await collectInstructions(root!.get(FS), workspace, { maxBytes: 32_000 })
    expect(sources).toHaveLength(1)
    expect(sources[0]!.path).toContain('AGENTS.md')
  })

  it('stops at the cwd when no project root marker is found', async () => {
    const parent = tempDir()
    const child = join(parent, 'child')
    mkdirSync(child)
    writeFileSync(join(parent, 'AGENTS.md'), 'parent rule', 'utf8')
    writeFileSync(join(child, 'AGENTS.md'), 'child rule', 'utf8')
    await mount({ maxBytes: 32_000 })
    const sources = await collectInstructions(root!.get(FS), child, { maxBytes: 32_000 })
    expect(sources.map((source) => source.text)).toEqual(['child rule'])
  })
})

describe('the budget', () => {
  it('drops broad files whole before truncating the nearest one', () => {
    const broad = { path: '/w/AGENTS.md', text: 'B'.repeat(500) }
    const near = { path: '/w/pkg/AGENTS.md', text: 'N'.repeat(500) }
    const rendered = renderInstructions([broad, near], 900)!
    expect(rendered).toContain('N'.repeat(400))
    expect(rendered).not.toContain('B'.repeat(400))
  })

  it('truncates the nearest file rather than dropping it, and says so', () => {
    const near = { path: '/w/pkg/AGENTS.md', text: 'N'.repeat(5000) }
    const rendered = renderInstructions([near], 800)!
    expect(rendered).toContain('truncated to fit')
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(800)
  })

  it('renders nothing at all rather than a header with no content', () => {
    expect(renderInstructions([{ path: '/w/AGENTS.md', text: 'x' }], 10)).toBeUndefined()
    expect(renderInstructions([], 32_000)).toBeUndefined()
  })
})

describe('entering the conversation', () => {
  it('enters once, as a durable message, alongside the first real prompt', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'always end with DONE', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    mounted.adapter.script(assistantText('first'), assistantText('second'))

    agent.followup(createUserMessage('do the thing'))
    await agent.whenIdle()
    agent.followup(createUserMessage('and again'))
    await agent.whenIdle()

    const found = entered(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('always end with DONE')
    expect(found[0]).toContain('<system-reminder>')
    // It reached the model in the same request as the prompt it joined.
    const first = mounted.adapter.calls[0]!
    expect(first.messages).toHaveLength(2)
    expect(messageText(first.messages[0]!)).toBe('do the thing')
    expect(messageText(first.messages[1]!)).toContain('always end with DONE')
  })

  it('does not enter again on a resumed session, because the log already has it', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'house style', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    mounted.adapter.script(assistantText('one'))
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    const seed = agent.session.events.map((event) => ({ ...event }))

    // A second lifecycle over the same log: the instructions are already in it.
    const resumed = await root!.get(AGENTS).create(root!, {
      cwd: workspace,
      seed,
      origin: 'resumed',
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
    })
    mounted.adapter.script(assistantText('two'))
    resumed.agent.followup(createUserMessage('carry on'))
    await resumed.agent.whenIdle()
    expect(entered(resumed.agent)).toHaveLength(1)
    await resumed.dispose()
  })

  it('never revives a turn that had nothing to say', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'house style', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    // No prompt, so no batch: the driver must still close the turn as a natural
    // stop rather than being handed a message it did not ask for.
    agent.send(createUserMessage('quiet'), 'next-step', false)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
  })

  it('is a no-op with no filesystem provider, instead of failing the turn', async () => {
    root = createRoot({ logger: silent })
    root.plugin(invariantsPlugin, {})
    root.plugin(sessionPlugin)
    root.plugin(llmPlugin)
    root.plugin(toolsPlugin, {})
    root.plugin(promptPlugin)
    root.plugin(approvalPlugin)
    root.plugin(sandboxPlugin, {})
    root.plugin(agentPlugin)
    root.plugin(loopPlugin)
    root.plugin(workspaceInstructionsPlugin, { maxBytes: 32_000 })
    await root.settle()
    const adapter = new ScriptedAdapter().script(assistantText('fine'))
    root.get(LLM).registerAdapter(root, adapter)
    root.get(PROMPT).section(root, { name: 'persona', order: 0, text: 'persona' })
    const handle = await root.get(AGENTS).create(root, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()
    expect(messageText(handle.agent.session.deriveMessages().at(-1)!)).toBe('fine')
    expect(entered(handle.agent)).toHaveLength(0)
    await handle.dispose()
  })
})
