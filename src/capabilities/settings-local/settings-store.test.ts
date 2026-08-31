/**
 * The settings store, against a real file. The cases are the ones a
 * revision-guarded, multi-writer store gets wrong: a stale write, a write that
 * would not validate, a document another process changed underneath, and a
 * hand-edited file that no longer parses.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { SETTINGS, SETTINGS_CHANGED, type Settings } from '../../core/settings/index.ts'
import { settingsLocalPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const schema = z.strictObject({ provider: z.string().min(1), model: z.string().min(1), maxSteps: z.number().int().positive().optional() })
const base = { provider: 'deepseek', model: 'the-default' }

let dirs: string[] = []
let roots: Context[] = []

afterEach(async () => {
  for (const root of roots) await root.dispose()
  roots = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

async function store(): Promise<{ settings: Settings; path: string; root: Context; changes: { ns: string; revision: number }[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'minidsh-settings-'))
  dirs.push(dir)
  const path = join(dir, 'settings.json')
  const root = createRoot({ logger: silent })
  roots.push(root)
  root.plugin(settingsLocalPlugin, { path })
  await root.settle()
  const changes: { ns: string; revision: number }[] = []
  root.on(SETTINGS_CHANGED, (ns, revision) => void changes.push({ ns, revision }))
  return { settings: root.get(SETTINGS), path, root, changes }
}

const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

describe('the settings store', () => {
  it('resolves the registered base until a user layer says otherwise', async () => {
    const { settings, root } = await store()
    const scope = settings.register(root, 'agent', schema, { base })
    expect(scope.get()).toEqual(base)

    scope.update({ model: 'chosen' })
    expect(scope.get()).toEqual({ provider: 'deepseek', model: 'chosen' })
    // Only the override is stored: the base is the deployment's to change later.
    expect(settings.read('agent').user).toEqual({ model: 'chosen' })
  })

  it('refuses a write whose revision is stale, so two panes cannot lose each other work', async () => {
    const { settings, root } = await store()
    settings.register(root, 'agent', schema, { base })
    const first = settings.read('agent').revision

    settings.write('agent', { model: 'one' }, { expectedRevision: first })
    expect(() => settings.write('agent', { model: 'two' }, { expectedRevision: first })).toThrow(/changed since revision/)
    expect(settings.read('agent').value).toEqual({ provider: 'deepseek', model: 'one' })
  })

  it('validates the MERGED value before persisting, so a rejected edit changes nothing', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    settings.write('agent', { model: 'good' }, { expectedRevision: 0 })
    const before = readFileSync(path, 'utf8')

    expect(() => settings.write('agent', { model: '' }, { expectedRevision: 1 })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(settings.read('agent').value).toEqual({ provider: 'deepseek', model: 'good' })
  })

  it('notices a document another process changed, because it re-reads inside the lock', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    // Somebody else wrote, and bumped the revision.
    writeFileSync(path, JSON.stringify({ agent: { model: 'theirs' }, revisions: { agent: 7 } }), 'utf8')

    expect(settings.read('agent').value).toEqual({ provider: 'deepseek', model: 'theirs' })
    expect(settings.read('agent').revision).toBe(7)
    expect(() => settings.write('agent', { model: 'mine' }, { expectedRevision: 0 })).toThrow(/now 7/)
    settings.write('agent', { model: 'mine' }, { expectedRevision: 7 })
    expect(read(path).revisions).toEqual({ agent: 8 })
  })

  it('tells every watcher and the bus, so a second client is never left showing a stale value', async () => {
    const { settings, root, changes } = await store()
    const scope = settings.register(root, 'agent', schema, { base })
    const seen: { next: unknown; previous: unknown }[] = []
    scope.watch((next, previous) => void seen.push({ next, previous }))

    settings.write('agent', { model: 'announced' }, { expectedRevision: 0 })
    expect(seen).toEqual([{ next: { provider: 'deepseek', model: 'announced' }, previous: base }])
    expect(changes).toEqual([{ ns: 'agent', revision: 1 }])
  })

  it('falls back to the base when a hand-edited file no longer validates, instead of failing every read', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    writeFileSync(path, JSON.stringify({ agent: { model: 42 } }), 'utf8')
    expect(settings.read('agent').value).toEqual(base)
  })

  it('refuses an unknown namespace and a second owner of a claimed one', async () => {
    const { settings, root } = await store()
    settings.register(root, 'agent', schema, { base })
    expect(() => settings.register(root, 'agent', schema, { base })).toThrow(/already registered/)
    expect(() => settings.read('nope')).toThrow(/no settings namespace/)
  })

  it('describes what a client may write, schema included', async () => {
    const { settings, root } = await store()
    settings.register(root, 'agent', schema, { base, schema: { type: 'object' } })
    const described = settings.describe()
    expect(described).toHaveLength(1)
    expect(described[0]!.ns).toBe('agent')
    expect(described[0]!.base).toEqual(base)
    expect(described[0]!.schema).toEqual({ type: 'object' })
  })

  it('writes atomically and privately, leaving no half-written document behind', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    settings.write('agent', { maxSteps: 9 }, { expectedRevision: 0 })
    expect(read(path)).toEqual({ agent: { maxSteps: 9 }, revisions: { agent: 1 } })
    expect(() => readFileSync(`${path}.writing`, 'utf8')).toThrow()
    expect(() => readFileSync(`${path}.lock`, 'utf8')).toThrow()
  })
})
