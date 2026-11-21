/**
 * The settings store's write path where the filesystem misbehaves, and the one
 * ordering a real file cannot show: that the temporary is synced BEFORE it is
 * renamed over the document. `node:fs` is wrapped so each fault happens exactly
 * when the test says; everything else is the real disk.
 */
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type * as Fs from 'node:fs'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({
  /** `fsync <name>` and `rename <from> -> <to>`, in the order they were asked for. */
  log: [] as string[],
  /** Path of every open descriptor, so a sync can be named by its file. */
  open: new Map<number, string>(),
  /** What the next exclusive creates of the document's lock answer, first to last; then the real filesystem answers. */
  lockCreateErrors: [] as string[],
  /** One entry per exclusive create of the lock: the code it answered, or `created`. */
  lockCreates: [] as string[],
  /** What the next renames answer, first to last; then the real filesystem answers. */
  renameErrors: [] as string[],
  /** How many times the document's lock has been looked at (`statSync`). */
  lockStats: 0,
  /** Called before each look at the lock, with its count: a test changes the disk between two looks. */
  beforeLockStat: undefined as ((count: number) => void) | undefined,
}))

const real = await vi.importActual<typeof Fs>('node:fs')

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  const fault = (code: string, call: string, path: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated, ${call} '${path}'`), { code })
  return {
    ...actual,
    openSync: (path: Fs.PathLike, flags?: Fs.OpenMode, mode?: Fs.Mode) => {
      const name = String(path)
      const isLock = name.endsWith('settings.json.lock') && flags === 'wx'
      if (isLock) {
        const code = control.lockCreateErrors.shift()
        if (code !== undefined) {
          control.lockCreates.push(code)
          throw fault(code, 'open', name)
        }
      }
      try {
        const fd = actual.openSync(path, flags ?? 'r', mode)
        control.open.set(fd, name)
        if (isLock) control.lockCreates.push('created')
        return fd
      } catch (error) {
        if (isLock) control.lockCreates.push((error as NodeJS.ErrnoException).code ?? 'unknown')
        throw error
      }
    },
    fsyncSync: (fd: number) => {
      control.log.push(`fsync ${basename(control.open.get(fd) ?? `fd ${fd}`)}`)
      actual.fsyncSync(fd)
    },
    statSync: ((path: Fs.PathLike, options?: Fs.StatSyncOptions) => {
      if (String(path).endsWith('settings.json.lock')) control.beforeLockStat?.(++control.lockStats)
      return actual.statSync(path, options)
    }) as typeof actual.statSync,
    renameSync: (from: Fs.PathLike, to: Fs.PathLike) => {
      const code = control.renameErrors.shift()
      control.log.push(`rename ${basename(String(from))} -> ${basename(String(to))}${code === undefined ? '' : ` (${code})`}`)
      if (code !== undefined) throw fault(code, 'rename', String(from))
      actual.renameSync(from, to)
    },
  }
})

const { createRoot } = await import('../../kernel/index.ts')
const { SETTINGS, SettingsError } = await import('../../core/settings/index.ts')
const { settingsLocalPlugin } = await import('./index.ts')

type Root = Awaited<ReturnType<typeof createRoot>>
const schema = z.strictObject({ provider: z.string().min(1), model: z.string().min(1) })
const base = { provider: 'deepseek', model: 'the-default' }
let dir: string | undefined
let root: Root | undefined

beforeEach(() => {
  control.log = []
  control.open = new Map()
  control.lockCreateErrors = []
  control.lockCreates = []
  control.renameErrors = []
  control.lockStats = 0
  control.beforeLockStat = undefined
})

afterEach(async () => {
  control.lockCreateErrors = []
  control.renameErrors = []
  control.beforeLockStat = undefined
  await root?.dispose()
  root = undefined
  if (dir) real.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

async function store() {
  dir = real.mkdtempSync(join(tmpdir(), 'minidsh-settings-faults-'))
  const path = join(dir, 'settings.json')
  root = createRoot({ logger: { warn: () => {}, error: () => {} } })
  root.plugin(settingsLocalPlugin, { path })
  await root.settle()
  const settings = root.get(SETTINGS)
  settings.register(root, 'agent', schema, { base })
  return { settings, path }
}

const saved = (path: string): unknown => JSON.parse(real.readFileSync(path, 'utf8'))
const thrownBy = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('the settings store: a write that survives a power cut', () => {
  /**
   * A rename is metadata, and a journaling filesystem may keep it across a
   * power cut while losing the bytes it named. Unsynced, that leaves an EMPTY
   * settings.json under the right name, and every command then stops at boot.
   */
  it('syncs the temporary before it renames it over the document', async () => {
    const { settings, path } = await store()
    settings.write('agent', { model: 'durable' }, { expectedRevision: 0 })
    expect(control.log).toEqual(['fsync settings.json.writing', 'rename settings.json.writing -> settings.json'])
    expect(saved(path)).toEqual({ agent: { model: 'durable' }, revisions: { agent: 1 } })
  })
})

describe('the settings store: a filesystem that answers late or says no', () => {
  /**
   * Windows keeps a removed name DELETE-PENDING while any handle is open on it
   * (another writer's stat, an antivirus scan), and creating it again answers
   * EPERM, EACCES or EBUSY rather than EEXIST. Nobody holds such a lock.
   * Everywhere else those codes mean what they say.
   */
  it('waits out a lock name Windows has not let go of yet, and nowhere else', async () => {
    const { settings, path } = await store()
    control.lockCreateErrors = ['EPERM', 'EACCES', 'EBUSY']
    const error = thrownBy(() => settings.write('agent', { model: 'waited' }, { expectedRevision: 0 }))
    if (process.platform === 'win32') {
      expect({ error, creates: control.lockCreates }).toEqual({ error: undefined, creates: ['EPERM', 'EACCES', 'EBUSY', 'created'] })
      expect(saved(path)).toEqual({ agent: { model: 'waited' }, revisions: { agent: 1 } })
    } else {
      expect(control.lockCreates).toEqual(['EPERM'])
      expect(error).toMatchObject({ code: 'EPERM' })
      expect(real.existsSync(path)).toBe(false)
    }
    expect(real.readdirSync(dirname(path)).filter((name) => name !== 'settings.json'), 'nothing left beside the document').toEqual([])
  })

  /**
   * Two reclaimers of one dead holder. Each reads the lock's age BEFORE it
   * holds the reclaim mutex, so the second to get the mutex used to remove
   * whatever was there: by then the first one's fresh lock. Two writers, both
   * believing they held it. The disk is changed between this writer's two
   * looks, which is exactly what the other reclaimer does.
   */
  it('looks at a stale lock again once it holds the reclaim mutex, and leaves a fresh one another reclaimer made', async () => {
    const { settings, path } = await store()
    const lock = `${path}.lock`
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    real.writeFileSync(lock, '')
    real.utimesSync(lock, longAgo, longAgo)
    control.beforeLockStat = (count) => {
      if (count !== 2) return
      const now = new Date()
      real.utimesSync(lock, now, now)
    }
    const error = thrownBy(() => settings.write('agent', { model: 'second' }, { expectedRevision: 0 }))
    expect(error).toMatchObject({ code: 'SETTINGS_CONFLICT' })
    expect({ looks: control.lockStats, lock: real.existsSync(lock), mutex: real.existsSync(`${lock}.steal`), document: real.existsSync(path) }).toEqual({ looks: 2, lock: true, mutex: false, document: false })
    // The control: with nobody in between, the same dead holder's lock is reclaimed and the write lands.
    control.beforeLockStat = undefined
    real.utimesSync(lock, longAgo, longAgo)
    settings.write('agent', { model: 'reclaimed' }, { expectedRevision: 0 })
    expect(saved(path)).toEqual({ agent: { model: 'reclaimed' }, revisions: { agent: 1 } })
    expect(real.existsSync(lock)).toBe(false)
  })

  it('reports a lock it cannot create in the filesystem\'s own words, never as another writer', async () => {
    const { settings, path } = await store()
    // A full disk: not EEXIST, and not one of the codes Windows uses for "busy".
    control.lockCreateErrors = ['ENOSPC', 'ENOSPC', 'ENOSPC']
    const error = thrownBy(() => settings.write('agent', { model: 'refused' }, { expectedRevision: 0 }))
    expect(error).toMatchObject({ code: 'ENOSPC' })
    expect(error).not.toBeInstanceOf(SettingsError)
    // Asked once: a full disk is not waited on, and no reclaim was attempted over it.
    expect(control.lockCreates).toEqual(['ENOSPC'])
    expect(real.readdirSync(dirname(path))).toEqual([])
  })

  it('asks again when Windows refuses the rename for a moment, and nowhere else', async () => {
    const { settings, path } = await store()
    control.renameErrors = ['EPERM', 'EBUSY']
    const error = thrownBy(() => settings.write('agent', { model: 'renamed' }, { expectedRevision: 0 }))
    const renames = control.log.filter((entry) => entry.startsWith('rename '))
    if (process.platform === 'win32') {
      expect({ error, renames }).toEqual({
        error: undefined,
        renames: ['rename settings.json.writing -> settings.json (EPERM)', 'rename settings.json.writing -> settings.json (EBUSY)', 'rename settings.json.writing -> settings.json'],
      })
      expect(saved(path)).toEqual({ agent: { model: 'renamed' }, revisions: { agent: 1 } })
    } else {
      expect(renames).toEqual(['rename settings.json.writing -> settings.json (EPERM)'])
      expect(error).toMatchObject({ code: 'EPERM' })
    }
    expect(real.readdirSync(dirname(path)).filter((name) => name !== 'settings.json'), 'nothing left beside the document').toEqual([])
  })

  it('leaves the old document, no temporary and no lock when the rename fails for good', async () => {
    const { settings, path } = await store()
    settings.write('agent', { model: 'kept' }, { expectedRevision: 0 })
    const before = real.readFileSync(path, 'utf8')
    control.log = []
    control.renameErrors = ['EIO']
    const error = thrownBy(() => settings.write('agent', { model: 'lost' }, { expectedRevision: 1 }))
    expect(error).toMatchObject({ code: 'EIO' })
    expect(control.log).toEqual(['fsync settings.json.writing', 'rename settings.json.writing -> settings.json (EIO)'])
    expect(real.readFileSync(path, 'utf8')).toBe(before)
    expect(real.readdirSync(dirname(path))).toEqual(['settings.json'])
    // The failed write took nothing with it: the revision is the one on disk, and the next write goes through.
    settings.write('agent', { model: 'next' }, { expectedRevision: 1 })
    expect(saved(path)).toEqual({ agent: { model: 'next' }, revisions: { agent: 2 } })
  })
})
