/**
 * The settings store, against a real file. The cases are the ones a
 * revision-guarded, multi-writer store gets wrong: a stale write, a write that
 * would not validate, a document another process changed underneath, and a
 * hand-edited file that no longer parses.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

async function store(logger: Logger = silent): Promise<{ settings: Settings; path: string; root: Context; changes: { ns: string; revision: number }[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'minidsh-settings-'))
  dirs.push(dir)
  const path = join(dir, 'settings.json')
  const root = createRoot({ logger })
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

    // The caller's error by its code: a bare throw let the wire answer a bad
    // value as a host failure (-32603), which a retry policy retries forever.
    expect(() => settings.write('agent', { model: '' }, { expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'SETTINGS_INVALID' }))
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

  // That the temporary is synced before it is renamed is `settings-faults.test.ts`'s
  // to show: only a wrapped `node:fs` can see the order of the two calls.
  it('writes privately, leaving nothing but the document behind', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    settings.write('agent', { maxSteps: 9 }, { expectedRevision: 0 })
    expect(read(path)).toEqual({ agent: { maxSteps: 9 }, revisions: { agent: 1 } })
    expect(readdirSync(dirname(path))).toEqual(['settings.json'])
    // Owner-only where the filesystem has modes; Windows keeps its folder's ACL.
    if (process.platform !== 'win32') expect((statSync(path).mode & 0o777).toString(8)).toBe('600')
  })

  it('reads a document that begins with a byte-order mark, as an editor on Windows saves it', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    writeFileSync(path, `﻿${JSON.stringify({ agent: { model: 'marked' }, revisions: { agent: 3 } })}`, 'utf8')
    expect(readFileSync(path).subarray(0, 3).toString('hex'), 'the mark is really on disk').toBe('efbbbf')
    expect(settings.read('agent')).toMatchObject({ value: { provider: 'deepseek', model: 'marked' }, revision: 3 })
    // …and a write over it goes through, on the revision the marked file held.
    settings.write('agent', { model: 'next' }, { expectedRevision: 3 })
    expect(read(path)).toEqual({ agent: { model: 'next' }, revisions: { agent: 4 } })
  })

  it('reads an empty or whitespace-only document as no settings, says so once, and replaces it at the next write', async () => {
    const warnings: string[] = []
    const { settings, path, root } = await store({ warn: (message) => void warnings.push(message), error: () => {} })
    const scope = settings.register(root, 'agent', schema, { base })
    for (const content of ['', ' \n\t\r\n', '﻿\n']) {
      writeFileSync(path, content, 'utf8')
      expect(scope.get(), JSON.stringify(content)).toEqual(base)
      expect(settings.read('agent'), JSON.stringify(content)).toMatchObject({ value: base, user: {}, revision: 0 })
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(path)
    expect(warnings[0]).toMatch(/is empty; it is read as no settings/)
    // A document that has bytes and is not JSON is still a hand-edit to report, not to guess at.
    writeFileSync(path, '{ "agent": ', 'utf8')
    expect(() => settings.read('agent')).toThrowError(expect.objectContaining({ code: 'SETTINGS_INVALID' }))

    writeFileSync(path, '', 'utf8')
    settings.write('agent', { model: 'saved' }, { expectedRevision: 0 })
    expect(read(path)).toEqual({ agent: { model: 'saved' }, revisions: { agent: 1 } })
  })
})

/**
 * The lock is what makes "re-read, check the revision, validate, persist" one
 * step across processes. A second process is modelled the only way it shows up
 * here: as the files it would leave beside the document.
 */
describe('the settings store: one writer at a time', () => {
  const STALE_MS = 5_000
  const backdate = (path: string, ms: number): void => {
    const when = (Date.now() - ms) / 1000
    utimesSync(path, when, when)
  }

  it('refuses a write while another writer holds the lock, and leaves the document as it was', async () => {
    const { settings, path, root, changes } = await store()
    settings.register(root, 'agent', schema, { base })
    settings.write('agent', { model: 'first' }, { expectedRevision: 0 })
    const before = readFileSync(path, 'utf8')
    writeFileSync(`${path}.lock`, '')

    expect(() => settings.write('agent', { model: 'second' }, { expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'SETTINGS_CONFLICT', message: expect.stringContaining('another writer holds') }))
    expect(readFileSync(path, 'utf8')).toBe(before)
    // Their lock is theirs: still there, and nothing was announced.
    expect(existsSync(`${path}.lock`)).toBe(true)
    expect(changes).toEqual([{ ns: 'agent', revision: 1 }])
    // Nearly stale is still held.
    backdate(`${path}.lock`, STALE_MS - 2_000)
    expect(() => settings.write('agent', { model: 'second' }, { expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'SETTINGS_CONFLICT' }))
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('takes over a lock a killed writer left, once it is older than any write could be', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    writeFileSync(`${path}.lock`, '')
    backdate(`${path}.lock`, STALE_MS + 60_000)

    settings.write('agent', { model: 'after the crash' }, { expectedRevision: 0 })
    expect(read(path)).toEqual({ agent: { model: 'after the crash' }, revisions: { agent: 1 } })
    expect(readdirSync(dirname(path))).toEqual(['settings.json'])
  })

  it('does not take over a stale lock while another reclaimer holds the steal mutex', async () => {
    const { settings, path, root } = await store()
    settings.register(root, 'agent', schema, { base })
    writeFileSync(`${path}.lock`, '')
    backdate(`${path}.lock`, STALE_MS + 60_000)
    writeFileSync(`${path}.lock.steal`, '')

    expect(() => settings.write('agent', { model: 'mine' }, { expectedRevision: 0 })).toThrowError(expect.objectContaining({ code: 'SETTINGS_CONFLICT', message: expect.stringContaining('another writer is reclaiming') }))
    // Nothing written, and neither of the other reclaimer's files touched.
    expect(readdirSync(dirname(path)).toSorted()).toEqual(['settings.json.lock', 'settings.json.lock.steal'])
  })
})
