/**
 * Authority presets over a real composition: one selector writing through the
 * two canonical setters, a derived-only `custom`, and a capability-owned
 * invariant rejecting forged intent events pre-commit.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { AGENTS, type AgentHandle } from '../../core/agent/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { AUTHORITY_PRESET, CUSTOM_PRESET, presetFor, presetTable, PRESETS } from '../../core/presets/index.ts'
import { SANDBOX } from '../../core/sandbox/index.ts'
import { ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { bootComposition } from '../../app/headless.ts'

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

async function bootWithAgent(): Promise<void> {
  root = await bootComposition({
    sessionsRoot: tempDir('minidsh-presets-'),
    logger: silent,
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (ctx) => void ctx.get(LLM).registerAdapter(ctx, new ScriptedAdapter()),
  })
  handle = await root.get(AGENTS).create(root, { cwd: tempDir('minidsh-cwd-'), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
}

describe('the preset table and derivation', () => {
  it('ships DSH’s two presets, validates configured tables, and reserves custom', () => {
    const table = presetTable()
    expect([...table.keys()]).toEqual(['workspace-write', 'danger-full-access'])
    expect(presetFor(table, { sandbox: 'workspace-write', approval: 'ask' })).toBe('workspace-write')
    expect(presetFor(table, { sandbox: 'danger-full-access', approval: 'never' })).toBe('danger-full-access')
    // read-only is a legal mode no preset selects: derived-only custom.
    expect(presetFor(table, { sandbox: 'read-only', approval: 'ask' })).toBe(CUSTOM_PRESET)
    expect(() => presetTable({ custom: { sandbox: 'read-only', approval: 'ask' } })).toThrow(/reserved/)
    expect(() => presetTable({ x: { sandbox: 'everything' as never, approval: 'ask' } })).toThrow(/unknown sandbox mode/)
  })
})

describe('applying a preset in a real composition', () => {
  it('writes the intent event then both knobs, in order, through the canonical setters', async () => {
    await bootWithAgent()
    const session = handle!.agent.session
    const presets = root!.get(PRESETS)
    expect(presets.selectForSession(session)).toBe('workspace-write') // deployment default pair

    presets.apply(session, 'danger-full-access')
    const kinds = session.events.map((event) => event.type)
    const intentAt = kinds.indexOf('authority/preset')
    expect(intentAt).toBeGreaterThanOrEqual(0)
    // The knob events follow the intent; their content is the setters' truth.
    // (The opening stamps were written at creation, so each knob logs one change.)
    expect(kinds.slice(intentAt)).toEqual(['authority/preset', 'sandbox/mode', 'inbox/spliced', 'approval/policy'])
    expect(presets.selectForSession(session)).toBe('danger-full-access')
    expect(root!.get(SANDBOX).resolve({ session }).mode).toBe('danger-full-access')

    expect(() => presets.apply(session, 'nope')).toThrow(/unknown authority preset "nope" \(known: workspace-write, danger-full-access\)/)
    expect(() => presets.apply(session, CUSTOM_PRESET)).toThrow(/unknown authority preset/)
  })

  it('rejects a forged intent event pre-commit through the capability-owned invariant', async () => {
    await bootWithAgent()
    const session = handle!.agent.session
    const before = session.events.length
    expect(() => session.append(AUTHORITY_PRESET, { name: 'not-a-preset' })).toThrow(/unknown preset/)
    expect(session.events).toHaveLength(before) // nothing entered the log
  })
})
