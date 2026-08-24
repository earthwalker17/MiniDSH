/**
 * Declarative composition: layers with provenance, duplicate refusal, the
 * plugin reference resolver (catalog + module import), the stable descriptor
 * hash, the recorder's changed-only discipline, and the exit-criterion
 * regression — recorded authority beats a widened composition default.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serviceKey, type Context, type Logger } from '../kernel/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { LLM } from '../core/llm/index.ts'
import { SANDBOX } from '../core/sandbox/index.ts'
import type { CompositionApplied } from '../capabilities/composition-record/index.ts'
import { assistantText, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { defineRow, type Row } from './compose.ts'
import { applyLayers, describeComposition, loadCompositionFile, resolvePluginRef, toPatches } from './config.ts'
import { bootComposition, resumeTask, runTask } from './headless.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function scripted(adapter: ScriptedAdapter): { patches: [{ id: string; disabled: true }]; prepare: (root: Context) => void; provider: string } {
  return {
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root) => void root.get(LLM).registerAdapter(root, adapter),
    provider: 'scripted',
  }
}

const noopPlugin = (name: string): Row['plugin'] => ({ name, apply: () => {} })

describe('applyLayers', () => {
  it('applies layers in order, records provenance, and prefixes warnings with the layer', () => {
    const base = [defineRow('a', noopPlugin('plugin-a'), { v: 1 }), defineRow('b', noopPlugin('plugin-b'))]
    const warnings: string[] = []
    const effective = applyLayers(
      base,
      [
        { name: 'home', patches: [{ id: 'a', config: { v: 2 } }, { id: 'ghost', disabled: true }] },
        { name: 'patch:x', patches: [{ id: 'a', config: { v: 3 } }, { insert: [defineRow('c', noopPlugin('plugin-c'))] }] },
      ],
      (message) => warnings.push(message),
    )
    expect(effective.rows.find((row) => row.id === 'a')?.config).toEqual({ v: 3 })
    expect(effective.provenance.get('a')).toBe('patch:x')
    expect(effective.provenance.get('b')).toBe('built-in')
    expect(effective.provenance.get('c')).toBe('patch:x')
    expect(warnings).toEqual(['home: patch targets unknown row id "ghost"'])
    expect(effective.descriptor.layers).toEqual(['built-in', 'home', 'patch:x'])
  })

  it('refuses duplicate row ids — a duplicate is only half-patchable', () => {
    const base = [defineRow('a', noopPlugin('plugin-a'))]
    expect(() => applyLayers(base, [{ name: 'home', patches: [{ insert: [defineRow('a', noopPlugin('plugin-a2'))] }] }], () => {})).toThrow(
      /duplicate row id "a"/,
    )
  })
})

describe('the composition descriptor', () => {
  it('hashes configs canonically and treats unserializable configs by presence, not identity', () => {
    const rows = [defineRow('x', noopPlugin('plugin-x'), { b: 2, a: 1 })]
    const reordered = [defineRow('x', noopPlugin('plugin-x'), { a: 1, b: 2 })]
    expect(describeComposition(rows, ['built-in']).hash).toBe(describeComposition(reordered, ['built-in']).hash)
    expect(describeComposition([defineRow('x', noopPlugin('plugin-x'), { a: 9 })], ['built-in']).hash).not.toBe(
      describeComposition(rows, ['built-in']).hash,
    )
    // Per-boot closures (the protocol row's onClose) must not churn the hash.
    const withFn = (): Row[] => [defineRow('p', noopPlugin('plugin-p'), { onClose: () => {} })]
    expect(describeComposition(withFn(), ['built-in']).hash).toBe(describeComposition(withFn(), ['built-in']).hash)
    // Configs never appear in the descriptor rows.
    expect(describeComposition(rows, ['built-in']).rows).toEqual([{ id: 'x', plugin: 'plugin-x' }])
  })
})

describe('the disk vocabulary', () => {
  it('loads and validates composition.json, surfacing broken files by path', async () => {
    const dir = tempDir('minidsh-config-')
    const path = join(dir, 'composition.json')
    expect(loadCompositionFile(path)).toBeUndefined()
    writeFileSync(path, 'nope')
    expect(() => loadCompositionFile(path)).toThrow(/not valid JSON/)
    writeFileSync(path, JSON.stringify({ patches: [{ id: 'x', bogus: true }] }))
    expect(() => loadCompositionFile(path)).toThrow(/invalid/)
    writeFileSync(path, JSON.stringify({ patches: [{ id: 'llm-retry', disabled: true }, { insert: [{ id: 'extra', plugin: 'llm-retry' }] }] }))
    const file = loadCompositionFile(path)!
    const patches = await toPatches(file, dir)
    expect(patches).toHaveLength(2)
  })

  it('resolves builtin names from the catalog and refuses unknown bare specifiers loudly', async () => {
    const dir = tempDir('minidsh-config-')
    const builtin = await resolvePluginRef('llm-retry', dir)
    expect(builtin.name).toBe('llm-retry')
    await expect(resolvePluginRef('definitely-not-a-plugin', dir)).rejects.toThrow(/not a builtin and could not be imported/)
  })

  it('loads a plugin module from disk and mounts it into a real composition', async () => {
    const home = tempDir('minidsh-home-')
    writeFileSync(
      join(home, 'marker-plugin.ts'),
      `export default {
  name: 'from-disk-marker',
  apply(ctx) {
    ctx.provide({ kind: 'service', name: 'from-disk' }, 42)
  },
}
`,
    )
    const file = { patches: [{ insert: [{ id: 'from-disk', plugin: './marker-plugin.ts' }] }] }
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-sessions-'),
      logger: silent,
      configLayers: [{ name: 'home', patches: await toPatches(file, home) }],
    })
    try {
      // Realms are keyed by service NAME, so the disk module needs no shared token.
      expect(root.tryGet(serviceKey<number>('from-disk'))).toBe(42)
    } finally {
      await root.dispose()
    }
  })
})

describe('the composition record', () => {
  const readEvents = (sessionsRoot: string, id: string): { type: string; data: CompositionApplied }[] =>
    readFileSync(join(sessionsRoot, `${encodeURIComponent(id)}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line) as { type: string; data: CompositionApplied })
      .filter((event) => event.type === 'composition/applied')

  it('stamps once, stays silent on an unchanged resume, and re-stamps a changed composition', async () => {
    const sessionsRoot = tempDir('minidsh-sessions-')
    const cwd = tempDir('minidsh-cwd-')
    const first = await runTask(
      { task: 'one', cwd, model: 'scripted-model', sessionsRoot, logger: silent, ...scripted(new ScriptedAdapter().script(assistantText('a'))) },
      undefined,
    )
    const afterRun = readEvents(sessionsRoot, first.sessionId)
    expect(afterRun).toHaveLength(1)
    expect(afterRun[0]!.data.layers).toEqual(['built-in', 'app'])
    expect(afterRun[0]!.data.rows.find((row) => row.id === 'llm-deepseek')).toMatchObject({ disabled: true })

    await resumeTask(
      { id: first.sessionId, task: 'two', sessionsRoot, logger: silent, ...scripted(new ScriptedAdapter().script(assistantText('b'))) },
      undefined,
    )
    expect(readEvents(sessionsRoot, first.sessionId)).toHaveLength(1) // unchanged composition: no second stamp

    await resumeTask(
      {
        id: first.sessionId,
        task: 'three',
        sessionsRoot,
        logger: silent,
        configLayers: [{ name: 'home', patches: [{ id: 'llm-retry', disabled: true }] }],
        ...scripted(new ScriptedAdapter().script(assistantText('c'))),
      },
      undefined,
    )
    const afterChange = readEvents(sessionsRoot, first.sessionId)
    expect(afterChange).toHaveLength(2)
    expect(afterChange[1]!.data.hash).not.toBe(afterChange[0]!.data.hash)
    expect(afterChange[1]!.data.layers).toEqual(['built-in', 'app', 'home'])
    expect(afterChange[1]!.data.rows.find((row) => row.id === 'llm-retry')).toMatchObject({ disabled: true })
  })
})

describe('configuration cannot widen recorded authority', () => {
  it('a composition default widened on disk never overrides what a session recorded', async () => {
    const sessionsRoot = tempDir('minidsh-sessions-')
    const cwd = tempDir('minidsh-cwd-')
    // The session records read-only as a durable switch.
    const first = await runTask(
      {
        task: 'one',
        cwd,
        model: 'scripted-model',
        sessionsRoot,
        logger: silent,
        sandbox: 'read-only',
        ...scripted(new ScriptedAdapter().script(assistantText('a'))),
      },
      undefined,
    )
    // A second boot whose composition default is the widest mode.
    const adapter = new ScriptedAdapter().script(assistantText('b'))
    const root = await bootComposition({
      sessionsRoot,
      logger: silent,
      patches: [
        { id: 'llm-deepseek', disabled: true },
        { id: 'sandbox', config: { mode: 'danger-full-access' } },
      ],
      prepare: (ctx) => void ctx.get(LLM).registerAdapter(ctx, adapter),
    })
    try {
      const handle = await root.get(AGENTS).resume(root, first.sessionId, { defaults: { provider: 'scripted', model: 'scripted-model' } })
      try {
        // The fold beats the composition default: the stamp every effect uses stays read-only.
        expect(root.get(SANDBOX).resolve({ session: handle.agent.session }).mode).toBe('read-only')
      } finally {
        await handle.dispose()
      }
    } finally {
      await root.dispose()
    }
  })
})
