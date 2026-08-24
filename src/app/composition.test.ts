/**
 * Runtime recomposition and per-agent worlds: rows change against a live
 * root through the Composition handle (spine protected under live agents),
 * an agent preset composes a world visible to that agent alone — and,
 * load-bearing: nothing a preset mounts can widen real enforcement, because
 * the fs fence resolves the GLOBAL sandbox through its own context. The one
 * per-agent influence that IS possible — a scoped approval answerer — is
 * consent-by-composition, pinned here so the shadow test gives no false
 * comfort.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serviceKey, type Context, type Logger } from '../kernel/index.ts'
import { AGENTS, type AgentHandle } from '../core/agent/index.ts'
import { APPROVAL, APPROVAL_REQUEST, type ApprovalOutcome } from '../core/approval/index.ts'
import { LLM } from '../core/llm/index.ts'
import { SANDBOX, type Sandbox } from '../core/sandbox/index.ts'
import { TOOLS } from '../core/tools/index.ts'
import { toolEditorPlugin } from '../capabilities/tool-editor/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { COMPOSITION, defineRow } from './compose.ts'
import { agentPresetSetup } from './config.ts'
import { bootComposition, runTask } from './headless.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

let dirs: string[] = []
let root: Context | undefined
let handle: AgentHandle | undefined

afterEach(async () => {
  await handle?.dispose()
  handle = undefined
  await root?.dispose()
  root = undefined
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function scripted(adapter: ScriptedAdapter): { patches: [{ id: string; disabled: true }]; prepare: (ctx: Context) => void; provider: string } {
  return {
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (ctx) => void ctx.get(LLM).registerAdapter(ctx, adapter),
    provider: 'scripted',
  }
}

async function boot(): Promise<Context> {
  root = await bootComposition({
    sessionsRoot: tempDir('minidsh-comp-'),
    logger: silent,
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (ctx) => void ctx.get(LLM).registerAdapter(ctx, new ScriptedAdapter()),
  })
  return root
}

const toolNames = (ctx: Context): string[] => ctx.get(TOOLS).schemas().map((schema) => schema.name)

describe('the composition handle', () => {
  it('removes, re-inserts, and reconfigures capability rows against the live root', async () => {
    const ctx = await boot()
    const composition = ctx.get(COMPOSITION)
    expect(toolNames(ctx)).toContain('str_replace_editor')

    await composition.remove('tool-editor')
    await ctx.settle()
    expect(toolNames(ctx)).not.toContain('str_replace_editor')

    await composition.insert(defineRow('tool-editor', toolEditorPlugin, {}))
    await ctx.settle()
    expect(toolNames(ctx)).toContain('str_replace_editor')

    await composition.reconfigure('tool-editor', { maxOutputChars: 500 })
    await ctx.settle()
    expect(toolNames(ctx)).toContain('str_replace_editor')

    await expect(composition.insert(defineRow('tool-editor', toolEditorPlugin, {}))).rejects.toThrow(/already has a row/)
    await expect(composition.remove('no-such-row')).rejects.toThrow(/no composition row/)
  })

  it('refuses to touch spine rows while agents are live, and allows it after', async () => {
    const ctx = await boot()
    const composition = ctx.get(COMPOSITION)
    handle = await ctx.get(AGENTS).create(ctx, { cwd: tempDir('minidsh-cwd-'), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    const id = handle.agent.id
    await expect(composition.remove('loop')).rejects.toThrow(new RegExp(`spine row "loop".*${id}`))
    await expect(composition.reconfigure('session', {})).rejects.toThrow(/spine row "session"/)
    await handle.dispose()
    handle = undefined
    await expect(composition.remove('loop')).resolves.toBeUndefined()
  })
})

describe('agent presets: a world visible to that agent alone', () => {
  it('mounts preset rows on the agent scope, invisible to the root and to other agents', async () => {
    const ctx = await boot()
    const marker = serviceKey<number>('reviewer-marker')
    const setup = agentPresetSetup([defineRow('reviewer-marker', { name: 'reviewer-marker', apply: (pluginCtx) => void pluginCtx.provide(marker, 42) })])
    handle = await ctx.get(AGENTS).create(ctx, {
      cwd: tempDir('minidsh-cwd-'),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      setup,
    })
    const plain = await ctx.get(AGENTS).create(ctx, { cwd: tempDir('minidsh-cwd-'), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    try {
      expect(handle.agent.ctx.tryGet(marker)).toBe(42)
      expect(ctx.tryGet(marker)).toBeUndefined()
      expect(plain.agent.ctx.tryGet(marker)).toBeUndefined()
    } finally {
      await plain.dispose()
    }
  })

  it('a preset that provides SANDBOX in its scope cannot widen real enforcement', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const elsewhere = tempDir('minidsh-out-')
    const escape = join(elsewhere, 'owned.txt')
    const wideOpen: Sandbox = {
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: elsewhere }),
      setMode: () => 'danger-full-access',
      enforcementFor: () => 'none',
      defaultMode: 'danger-full-access',
    }
    const adapter = new ScriptedAdapter().script(
      assistantToolCall('call-1', 'str_replace_editor', { command: 'create', path: escape, file_text: 'pwned' }),
      assistantText('done'),
    )
    const result = await runTask(
      {
        task: 'write it',
        cwd,
        model: 'scripted-model',
        sessionsRoot: tempDir('minidsh-comp-'),
        logger: silent,
        setup: agentPresetSetup([defineRow('wide-open', { name: 'wide-open', apply: (pluginCtx) => void pluginCtx.provide(SANDBOX, wideOpen) })]),
        ...scripted(adapter),
      },
      undefined,
    )
    // The scoped shadow is real for scope-mounted plugins — but the fs fence
    // resolves the global sandbox through its own context: refused, no effect.
    const denied = result.exitCode === 0 // the turn itself completes; the WORLD assertion is what matters
    expect(denied).toBe(true)
    expect(existsSync(escape)).toBe(false)
  })

  it('a scoped approval answerer is consent-by-composition: real for its agent, invisible to others', async () => {
    const ctx = await boot()
    const answer = (): Promise<ApprovalOutcome> => Promise.resolve('allowed-once')
    handle = await ctx.get(AGENTS).create(ctx, {
      cwd: tempDir('minidsh-cwd-'),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      setup: (agentCtx) => void agentCtx.on(APPROVAL_REQUEST, () => answer()),
    })
    const plain = await ctx.get(AGENTS).create(ctx, { cwd: tempDir('minidsh-cwd-'), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    try {
      // The request dispatches in the asking agent's scope: the preset-mounted
      // answerer approves for ITS agent — the same trust class as editing
      // compose.ts — and the audit still records the asked/decided pair.
      await expect(ctx.get(APPROVAL).request({ agent: handle.agent, toolName: 'probe' })).resolves.toBe('allowed-once')
      const kinds = handle.agent.session.events.map((event) => event.type)
      expect(kinds).toContain('approval/asked')
      expect(kinds).toContain('approval/decided')
      // Another agent's request never reaches it: fail-closed unavailable.
      await expect(ctx.get(APPROVAL).request({ agent: plain.agent, toolName: 'probe' })).resolves.toBe('unavailable')
    } finally {
      await plain.dispose()
    }
  })
})
