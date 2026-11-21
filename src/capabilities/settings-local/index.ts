/**
 * The settings provider: one user document under the home, one layer over each
 * namespace's registered base.
 *
 * The write path is where the care is. Every write RE-READS the document first,
 * under a lock file, so a second process editing the same file is noticed
 * rather than clobbered; the revision the caller echoed is checked at that
 * point, not when it was handed out; the merged value is validated against the
 * owner's schema BEFORE anything is persisted; and the file is replaced
 * atomically, so a crash mid-write leaves the old document rather than half of
 * a new one.
 *
 * Secrets deliberately do not live here. They are `CredentialRef`s — env-var
 * names resolved per operation through `ctx.credentials` — so this store never
 * holds a value that would have to be redacted before it crossed a wire, and
 * needs no redacting read or field-level write verb to make that safe.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { type Context, type Disposer, type Plugin } from '../../kernel/index.ts'
import { snapshotJson, type JsonValue } from '../../core/json.ts'
import {
  SETTINGS,
  SETTINGS_CHANGED,
  SettingsError,
  mergeLayers,
  type Settings,
  type SettingsNamespaceInfo,
  type SettingsSchema,
  type SettingsScope,
  type SettingsWriteResult,
} from '../../core/settings/index.ts'

const configSchema = z.strictObject({
  /** The user document. Its sections are namespaces; a missing file is an empty one. */
  path: z.string().min(1),
  /** A lock older than this is assumed abandoned (default 5s). */
  staleLockMs: z.number().int().positive().optional(),
})

export type SettingsLocalConfig = z.infer<typeof configSchema>

/** Namespace sections plus the per-namespace revisions, which are the file's own bookkeeping. */
const documentSchema = z.looseObject({ revisions: z.record(z.string(), z.number().int().nonnegative()).optional() })

interface Namespace {
  readonly schema: SettingsSchema<unknown>
  readonly base: unknown
  readonly describe?: JsonValue
  readonly watchers: Set<(next: unknown, previous: unknown) => void>
}

/**
 * The Windows rules of a lock file and of a rename over a file somebody may
 * have open. They are `credentials-local`'s, mirrored here because capabilities
 * do not import each other; the measurement behind them lives there (6 of 100
 * writers died of the first in a four-process race).
 *
 * A name its holder just removed stays DELETE-PENDING while any process still
 * has a handle on it (another writer's stat, an antivirus scan), and creating
 * it again answers EPERM, EACCES or EBUSY rather than EEXIST. A rename over a
 * file a reader has open for a moment answers the same three. Both are busy,
 * not broken, so both are asked again for a short bound, and at its end the
 * real error is thrown.
 */
const PENDING_WAIT_MS = 1_000
const PENDING_RETRY_MS = 25
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 50

function busyOnWindows(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Exclusive create of an empty lock file: `false` when the name is taken.
 * Anything else the filesystem says (a read-only directory, a full disk) is
 * thrown in its own words: it is not another writer, and must not be reported
 * as one.
 */
function createExclusive(path: string): boolean {
  const deadline = Date.now() + PENDING_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      if (!busyOnWindows(error) || Date.now() > deadline) throw error
      pause(PENDING_RETRY_MS)
    }
  }
}

function renameOver(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !busyOnWindows(error)) throw error
      pause(RENAME_RETRY_MS)
    }
  }
}

class LocalSettings implements Settings {
  private readonly ctx: Context
  private readonly path: string
  private readonly staleLockMs: number
  private readonly namespaces = new Map<string, Namespace>()
  /** An empty document is reported once, not on every read of it. */
  private warnedEmpty = false

  constructor(ctx: Context, config: SettingsLocalConfig) {
    this.ctx = ctx
    this.path = config.path
    this.staleLockMs = config.staleLockMs ?? 5_000
  }

  register<T>(owner: Context, ns: string, schema: SettingsSchema<T>, options: { base: T; schema?: JsonValue }): SettingsScope<T> {
    if (this.namespaces.has(ns)) throw new SettingsError('SETTINGS_DUPLICATE_NS', `settings namespace "${ns}" is already registered`)
    const entry: Namespace = {
      schema: schema as SettingsSchema<unknown>,
      base: options.base,
      ...(options.schema === undefined ? {} : { describe: options.schema }),
      watchers: new Set(),
    }
    this.namespaces.set(ns, entry)
    owner.effect(() => () => {
      this.namespaces.delete(ns)
    }, `settings:${ns}`)
    return {
      get: () => this.resolve(ns, entry) as T,
      watch: (listener) => {
        const typed = listener as (next: unknown, previous: unknown) => void
        entry.watchers.add(typed)
        return (() => {
          entry.watchers.delete(typed)
        }) as Disposer
      },
      update: (patch) => this.writeFor(ns, snapshotJson(patch) as JsonValue, false) as T,
      replace: (next) => this.writeFor(ns, snapshotJson(next) as JsonValue, true) as T,
    }
  }

  describe(): readonly SettingsNamespaceInfo[] {
    return [...this.namespaces.keys()].map((ns) => this.read(ns))
  }

  read(ns: string): SettingsNamespaceInfo {
    const entry = this.require(ns)
    const document = this.document()
    return {
      ns,
      value: snapshotJson(this.resolve(ns, entry, document)) as JsonValue,
      base: snapshotJson(entry.base) as JsonValue,
      user: (document[ns] ?? {}) as JsonValue,
      revision: this.revisionOf(document, ns),
      ...(entry.describe === undefined ? {} : { schema: entry.describe }),
    }
  }

  write(ns: string, patch: JsonValue, options: { expectedRevision: number; replace?: boolean }): SettingsWriteResult {
    const entry = this.require(ns)
    const previous = this.resolve(ns, entry)
    const release = this.lock()
    let revision: number
    let value: unknown
    try {
      // Re-read INSIDE the lock: the revision the caller echoed is checked
      // against what is on disk now, not against what it read a moment ago.
      const document = this.document()
      const current = this.revisionOf(document, ns)
      if (current !== options.expectedRevision) {
        throw new SettingsError('SETTINGS_CONFLICT', `settings "${ns}" changed since revision ${options.expectedRevision} (now ${current})`)
      }
      const layer = options.replace === true ? patch : (mergeLayers(document[ns] ?? {}, patch) as JsonValue)
      // Validated before anything is persisted: a rejected edit leaves the
      // document exactly as it was. Thrown as the CALLER's error: the owner's
      // schema throws its own kind, which the wire answered as a host failure
      // a retry policy would retry forever (S20.5 review).
      try {
        value = entry.schema.parse(mergeLayers(entry.base, layer))
      } catch (error) {
        throw new SettingsError('SETTINGS_INVALID', `settings "${ns}" refuses that value: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      revision = current + 1
      const revisions = { ...((document.revisions ?? {}) as Record<string, number>), [ns]: revision }
      this.persist({ ...document, [ns]: layer, revisions })
    } finally {
      release()
    }
    for (const watcher of entry.watchers) watcher(value, previous)
    this.ctx.emit(SETTINGS_CHANGED, ns, revision)
    return { revision, value: snapshotJson(value) as JsonValue }
  }

  private writeFor(ns: string, patch: JsonValue, replace: boolean): unknown {
    const revision = this.read(ns).revision
    return this.write(ns, patch, { expectedRevision: revision, replace }).value
  }

  private require(ns: string): Namespace {
    const entry = this.namespaces.get(ns)
    if (!entry) throw new SettingsError('SETTINGS_UNKNOWN_NS', `no settings namespace "${ns}"`)
    return entry
  }

  private resolve(ns: string, entry: Namespace, document = this.document()): unknown {
    const merged = mergeLayers(entry.base, document[ns])
    try {
      return entry.schema.parse(merged)
    } catch {
      // A hand-edited file that no longer validates must not take the process
      // down at read time; the base is what the deployment meant.
      return entry.base
    }
  }

  private document(): Record<string, unknown> {
    if (!existsSync(this.path)) return {}
    try {
      let text = readFileSync(this.path, 'utf8')
      // One leading byte-order mark is an editor's habit (Notepad, Windows
      // PowerShell's `Set-Content -Encoding UTF8`), not a syntax error.
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      // An EMPTY document says nothing, which is what no document says. It is
      // what a power cut can leave of a file replaced without a sync (every
      // version before 2.0 wrote it that way), and refusing it would stop every
      // read and write until a person found the file and deleted it by hand.
      // The next write replaces it with a whole one.
      if (text.trim().length === 0) {
        if (!this.warnedEmpty) {
          this.warnedEmpty = true
          this.ctx.logger.warn(`settings file ${this.path} is empty; it is read as no settings, and the next change saved replaces it`)
        }
        return {}
      }
      return documentSchema.parse(JSON.parse(text)) as Record<string, unknown>
    } catch (error) {
      throw new SettingsError('SETTINGS_INVALID', `settings file ${this.path} is not readable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  private revisionOf(document: Record<string, unknown>, ns: string): number {
    const revisions = (document.revisions ?? {}) as Record<string, number>
    return revisions[ns] ?? 0
  }

  private persist(document: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.writing`
    try {
      // Written whole and SYNCED, then renamed: a crash leaves the old
      // document, never half of a new one. The sync is what makes that true
      // across a power cut, where a filesystem may keep the rename (journaled
      // metadata) and lose the bytes it named: an empty settings.json.
      const fd = openSync(temporary, 'w', 0o600)
      try {
        writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameOver(temporary, this.path)
    } catch (error) {
      // A write that did not land leaves no half-made file beside the document.
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The failure to report is the write's, not the cleanup's.
      }
      throw error
    }
  }

  private lock(): () => void {
    const lock = `${this.path}.lock`
    mkdirSync(dirname(this.path), { recursive: true })
    const release = (): void => rmSync(lock, { force: true })
    if (createExclusive(lock)) return release
    // A holder that never released (a killed process) must not block writes
    // forever; anything younger than the stale window is a real writer. A lock
    // that is gone by now was released between the two calls, and is taken
    // through the reclaim below like any other that nobody holds.
    let age = Number.POSITIVE_INFINITY
    try {
      age = Date.now() - statSync(lock).mtimeMs
    } catch {
      // Released since the create was refused.
    }
    if (age < this.staleLockMs) throw new SettingsError('SETTINGS_CONFLICT', `another writer holds ${lock}`)
    // Reclaiming is the protocol's one TWO-step (remove, then create), so it
    // runs under its own exclusive-create mutex — the same discipline the
    // session lease uses. Without it two reclaimers of one dead holder could
    // both remove and both create, and the second remove would delete the
    // first's fresh lock: two writers, both believing they hold it.
    const steal = `${lock}.steal`
    if (!createExclusive(steal)) throw new SettingsError('SETTINGS_CONFLICT', `another writer is reclaiming ${lock}`)
    try {
      // Looked at AGAIN, now under the mutex, as the session lease re-probes
      // under its own: the age above was read before this reclaimer held it,
      // and another one may have finished in between. Its lock is fresh, and
      // removing it here would leave two writers each believing they hold it.
      let fresh = false
      try {
        fresh = Date.now() - statSync(lock).mtimeMs < this.staleLockMs
      } catch {
        // Gone: nobody holds it.
      }
      if (fresh) throw new SettingsError('SETTINGS_CONFLICT', `another writer reclaimed ${lock} first`)
      rmSync(lock, { force: true })
      if (!createExclusive(lock)) throw new SettingsError('SETTINGS_CONFLICT', `another writer reclaimed ${lock} first`)
    } finally {
      rmSync(steal, { force: true })
    }
    return release
  }
}

export const settingsLocalPlugin: Plugin<SettingsLocalConfig> = {
  name: 'settings-local',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(SETTINGS, new LocalSettings(ctx, config))
  },
}
