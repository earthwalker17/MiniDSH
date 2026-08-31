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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

class LocalSettings implements Settings {
  private readonly ctx: Context
  private readonly path: string
  private readonly staleLockMs: number
  private readonly namespaces = new Map<string, Namespace>()

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
      // document exactly as it was.
      value = entry.schema.parse(mergeLayers(entry.base, layer))
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
      return documentSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))) as Record<string, unknown>
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
    // Written whole, then renamed: a crash leaves the old document, never half
    // of a new one.
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
  }

  private lock(): () => void {
    const lock = `${this.path}.lock`
    mkdirSync(dirname(this.path), { recursive: true })
    try {
      closeSync(openSync(lock, 'wx'))
    } catch {
      // A holder that never released (a killed process) must not block writes
      // forever; anything younger than the stale window is a real writer.
      const age = existsSync(lock) ? Date.now() - statSync(lock).mtimeMs : Number.POSITIVE_INFINITY
      if (age < this.staleLockMs) throw new SettingsError('SETTINGS_CONFLICT', `another writer holds ${lock}`)
      // Reclaiming is the protocol's one TWO-step (remove, then create), so it
      // runs under its own exclusive-create mutex — the same discipline the
      // session lease uses. Without it two reclaimers of one dead holder could
      // both remove and both create, and the second remove would delete the
      // first's fresh lock: two writers, both believing they hold it.
      const steal = `${lock}.steal`
      try {
        closeSync(openSync(steal, 'wx'))
      } catch {
        throw new SettingsError('SETTINGS_CONFLICT', `another writer is reclaiming ${lock}`)
      }
      try {
        rmSync(lock, { force: true })
        closeSync(openSync(lock, 'wx'))
      } catch {
        throw new SettingsError('SETTINGS_CONFLICT', `another writer reclaimed ${lock} first`)
      } finally {
        rmSync(steal, { force: true })
      }
    }
    return () => rmSync(lock, { force: true })
  }
}

export const settingsLocalPlugin: Plugin<SettingsLocalConfig> = {
  name: 'settings-local',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(SETTINGS, new LocalSettings(ctx, config))
  },
}
