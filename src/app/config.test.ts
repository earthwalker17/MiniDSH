/**
 * Declarative composition: layers with provenance, duplicate refusal, the
 * plugin reference resolver (catalog + module import), the stable descriptor
 * hash, the recorder's changed-only discipline, and the exit-criterion
 * regression — recorded authority beats a widened composition default.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serviceKey, type Context, type Logger } from '../kernel/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { APPROVAL } from '../core/approval/index.ts'
import { LLM } from '../core/llm/index.ts'
import { SANDBOX } from '../core/sandbox/index.ts'
import type { CompositionApplied } from '../capabilities/composition-record/index.ts'
import { assistantText, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { COMPOSITION, defaultDialect, defineRow, type Row } from './compose.ts'
import { applyLayers, describeComposition, loadCompositionFile, resolvePluginRef, toPatches, type NamedLayer } from './config.ts'
import { bootComposition, resumeTask, runTask, type BootOptions } from './headless.ts'

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

  it('names the build that composed it, so a stored log can say which MiniDSH wrote each segment', async () => {
    const { VERSION } = await import('./version.ts')
    expect(describeComposition([], ['built-in']).writer).toBe(`minidsh ${VERSION}`)
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

  // A home layer can narrow authority (a read-only default, a disabled shell):
  // one that is THERE and cannot be opened must stop the boot, not vanish.
  it('treats only a missing file as absent: one that exists and cannot be read throws, naming the path', () => {
    const dir = tempDir('minidsh-config-')
    // A directory at the path: it exists, and no read of it succeeds, on any host.
    const occupied = join(dir, 'composition.json')
    mkdirSync(occupied)
    expect(() => loadCompositionFile(occupied)).toThrow(`composition file ${occupied} is unreadable: `)
    // Nothing can be at a path beneath a regular file: that is absence.
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    expect(loadCompositionFile(join(file, 'composition.json'))).toBeUndefined()
  })

  it('reads past one leading byte-order mark, which Notepad and Windows PowerShell write', () => {
    const path = join(tempDir('minidsh-config-'), 'composition.json')
    const BOM = String.fromCharCode(0xfeff)
    writeFileSync(path, `${BOM}${JSON.stringify({ patches: [{ id: 'llm-retry', disabled: true }] })}`)
    expect(loadCompositionFile(path)).toEqual({ patches: [{ id: 'llm-retry', disabled: true }] })
    // One mark is an editor's habit; a second is content, and not JSON.
    writeFileSync(path, `${BOM}${BOM}{}`)
    expect(() => loadCompositionFile(path)).toThrow(/not valid JSON/)
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

/**
 * A patch replaces a row's WHOLE config, and three things the app says about a
 * row used to travel in the base row's config, where a layer that touched the
 * row for another key erased them without a word: an explicit authority flag,
 * the user's global AGENTS.md, and the runtime's own install directories.
 */
describe('what the command line and the deployment say survives a layer on the same row', () => {
  const home = (patches: readonly { id: string; config: unknown }[]): NamedLayer[] => [{ name: 'home', patches }]

  /** A boot under `options`, with what it warned, read through `read` and disposed. */
  async function booted<T>(options: Partial<BootOptions>, read: (root: Context) => T | Promise<T>): Promise<{ value: T; warnings: string[] }> {
    const warnings: string[] = []
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-sessions-'),
      logger: { warn: (message) => void warnings.push(message), error: () => {} },
      ...scripted(new ScriptedAdapter()),
      ...options,
    })
    try {
      return { value: await read(root), warnings }
    } finally {
      await root.dispose()
    }
  }

  it('keeps --sandbox and --ask on rows a home layer patched for another key, and opens a session under them', async () => {
    // The sessions `web`, `serve` and `chat` create get no durable switch: the
    // row's default is all of the flag they ever see.
    const { value, warnings } = await booted(
      { sandbox: 'read-only', approvalPolicy: 'never', configLayers: home([{ id: 'sandbox', config: { accepts: 'none' } }, { id: 'approval', config: {} }]) },
      async (root) => {
        const handle = await root.get(AGENTS).create(root, { cwd: tempDir('minidsh-cwd-'), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
        try {
          const opened = (type: string): unknown => handle.agent.session.events.find((event) => event.type === type)?.data
          return {
            mode: root.get(SANDBOX).defaultMode,
            accepts: root.get(SANDBOX).acceptsFor(undefined, 'read-only'),
            policy: root.get(APPROVAL).defaultPolicy,
            openedMode: opened('sandbox/mode'),
            openedPolicy: opened('approval/policy'),
          }
        } finally {
          await handle.dispose()
        }
      },
    )
    expect(value.mode).toBe('read-only')
    expect(value.policy).toBe('never')
    // The layer's own key on that row stands beside the flag's.
    expect(value.accepts).toBe('none')
    expect(value.openedMode).toMatchObject({ mode: 'read-only', reason: 'initial' })
    expect(value.openedPolicy).toMatchObject({ policy: 'never', reason: 'initial' })
    // Nothing was taken from the layer: it named other keys.
    expect(warnings.filter((message) => message.includes('wins over'))).toEqual([])
  })

  it('lets a flag win over a layer that set the same key, and says which layer and which value it overrode', async () => {
    const layers = home([{ id: 'sandbox', config: { mode: 'danger-full-access', accepts: 'none' } }, { id: 'approval', config: { policy: 'ask' } }])
    const read = (root: Context) => ({ mode: root.get(SANDBOX).defaultMode, accepts: root.get(SANDBOX).acceptsFor(undefined, 'workspace-write'), policy: root.get(APPROVAL).defaultPolicy })
    const flagged = await booted({ sandbox: 'workspace-write', accepts: 'full', approvalPolicy: 'never', configLayers: layers }, read)
    expect(flagged.value).toEqual({ mode: 'workspace-write', accepts: 'full', policy: 'never' })
    expect(flagged.warnings.filter((message) => message.includes('wins over'))).toEqual([
      '--ask never wins over layer "home", which sets policy: "ask" on row "approval"',
      '--sandbox workspace-write wins over layer "home", which sets mode: "danger-full-access" on row "sandbox"',
      '--accept full wins over layer "home", which sets accepts: "none" on row "sandbox"',
    ])
    // With no flag the layer is the deployment's word, and nothing is said.
    const unflagged = await booted({ configLayers: layers }, read)
    expect(unflagged.value).toEqual({ mode: 'danger-full-access', accepts: 'none', policy: 'ask' })
    expect(unflagged.warnings).toEqual([])
  })

  it('keeps --approve answering when a layer gives approval-headless an allow list, and leaves the row to the layers without it', async () => {
    const ask = async (root: Context): Promise<string> => {
      const handle = await root.get(AGENTS).create(root, { cwd: tempDir('minidsh-cwd-'), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      try {
        return await root.get(APPROVAL).request({ agent: handle.agent, toolName: 'probe' })
      } finally {
        await handle.dispose()
      }
    }
    const allow = home([{ id: 'approval-headless', config: { allow: [] } }])
    expect((await booted({ approve: true, configLayers: allow }, ask)).value).toBe('allowed-once')
    // No flag (the CLI passes `false` for its absence): the layer's config is whole.
    expect((await booted({ approve: false, configLayers: allow }, ask)).value).toBe('unavailable')
    const layerApproves = home([{ id: 'approval-headless', config: { approve: true } }])
    expect((await booted({ approve: false, configLayers: layerApproves }, ask)).value).toBe('allowed-once')
    // And the flag over a layer that said no is said.
    const overridden = await booted({ approve: true, configLayers: home([{ id: 'approval-headless', config: { approve: false } }]) }, ask)
    expect(overridden.value).toBe('allowed-once')
    expect(overridden.warnings).toEqual(['--approve wins over layer "home", which sets approve: false on row "approval-headless"'])
  })

  it('still reads the global AGENTS.md of the user when a layer patches workspace-instructions for its budget', async () => {
    const userHome = tempDir('minidsh-home-')
    const global = join(userHome, 'AGENTS.md')
    writeFileSync(global, 'GLOBAL-RULE-7f3a: always say please')
    const firstRequest = async (patch: unknown): Promise<string> => {
      const adapter = new ScriptedAdapter().script(assistantText('ok'))
      const result = await runTask({
        task: 'go',
        cwd: tempDir('minidsh-cwd-'),
        model: 'scripted-model',
        sessionsRoot: tempDir('minidsh-sessions-'),
        logger: silent,
        globalInstructionsPath: global,
        ...(patch === undefined ? {} : { configLayers: home([{ id: 'workspace-instructions', config: patch }]) }),
        ...scripted(adapter),
      })
      expect(result.exitCode).toBe(0)
      return JSON.stringify(adapter.calls[0]!.messages)
    }
    // The control: with no layer it is read, so its absence below would mean something.
    expect(await firstRequest(undefined)).toContain('GLOBAL-RULE-7f3a')
    expect(await firstRequest({ maxBytes: 64_000 })).toContain('GLOBAL-RULE-7f3a')
    // A path the layer names is the layer's choice, and is the one read.
    const other = join(tempDir('minidsh-home-'), 'AGENTS.md')
    writeFileSync(other, 'OTHER-RULE-22c1: never say please')
    const chosen = await firstRequest({ maxBytes: 64_000, globalPath: other })
    expect(chosen).toContain('OTHER-RULE-22c1')
    expect(chosen).not.toContain('GLOBAL-RULE-7f3a')
  })

  it('hands the shell row the install directories of the runtime as `expose`, under a layer on that row too, and keeps a list the layer gives', async () => {
    const install = [tempDir('minidsh-install-'), tempDir('minidsh-node-')]
    const dialect = defaultDialect()
    const shellConfig = async (options: Partial<BootOptions>): Promise<unknown> => (await booted(options, (root) => root.get(COMPOSITION).rows().find((row) => row.id === 'shell')?.config)).value
    expect(await shellConfig({ installRoots: install })).toEqual({ dialect, expose: install })
    // The patch a host with no backend writes: it used to drop every key the app had set.
    expect(await shellConfig({ installRoots: install, configLayers: home([{ id: 'shell', config: { dialect, confinement: 'none' } }]) })).toEqual({ dialect, confinement: 'none', expose: install })
    expect(await shellConfig({ installRoots: install, configLayers: home([{ id: 'shell', config: { dialect, expose: [] } }]) })).toEqual({ dialect, expose: [] })
    // A hermetic boot names none, and the row is as `compose` wrote it.
    expect(await shellConfig({})).toEqual({ dialect })
  })
})
