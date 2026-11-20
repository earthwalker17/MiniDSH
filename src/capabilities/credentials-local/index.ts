/**
 * Local credential provider: the process environment first, then a JSON store
 * (`<home>/credentials.json`, shaped `{ "NAME": "value" }`). The store is
 * re-read on every resolution — that per-operation read IS the hot-rotation
 * mechanism. A MISSING store is absent; a store that exists but cannot be
 * read or parsed also resolves as absent (the consumer owns its own
 * missing-credential error) but is reported once, because "key not set" is a
 * misleading answer to "your credentials file has a trailing comma". An empty
 * layer value falls through to the next layer.
 *
 * This module is the store's owner, so its one writer lives here too
 * (`updateCredentialStore`, for `minidsh credentials set|unset`), beside the
 * reader whose rules it must not contradict.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { Logger, Plugin } from '../../kernel/index.ts'
import { CREDENTIALS, type CredentialRef, type Credentials } from '../../core/credentials/index.ts'

export interface CredentialsLocalConfig {
  /** JSON store path; omitted = environment-only resolution (hermetic tests). */
  readonly path?: string | undefined
}

const configSchema = z.strictObject({ path: z.string().min(1).optional() }).optional()

/** Blank is absent: a value that is empty after trimming never resolves. */
function present(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : undefined
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/** One read of the store: absent, an object, or why it cannot be used — in words that never quote its bytes. */
type StoreRead = { readonly state: 'missing' } | { readonly state: 'read'; readonly store: Record<string, unknown> } | { readonly state: 'unusable'; readonly why: string }

function readStore(path: string): StoreRead {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'unusable', why: `is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  let store: unknown
  try {
    store = JSON.parse(raw)
  } catch (error) {
    // WHERE, never what: V8's message quotes about ten characters around the
    // fault, and in a store of secrets those are the head of a value (a
    // single-quoted one printed `'sk-live-S` to the host's stderr).
    return { state: 'unusable', why: `is not valid JSON${faultPosition(raw, error)}` }
  }
  if (store === null || typeof store !== 'object' || Array.isArray(store)) return { state: 'unusable', why: 'is not a JSON object' }
  return { state: 'read', store: store as Record<string, unknown> }
}

/** Where `resolve` would find `ref` — the one lookup order, so a report of it cannot drift from what resolves. */
function lookup(path: string | undefined, ref: CredentialRef, read: () => StoreRead): { source: CredentialSource; value?: string } {
  const fromEnv = present(process.env[ref])
  if (fromEnv !== undefined) return { source: 'env', value: fromEnv }
  if (path === undefined) return { source: 'absent' }
  const store = read()
  if (store.state !== 'read') return { source: 'absent' }
  const value = store.store[ref]
  const fromStore = typeof value === 'string' ? present(value) : undefined
  return fromStore === undefined ? { source: 'absent' } : { source: 'store', value: fromStore }
}

class LocalCredentials implements Credentials {
  private readonly path: string | undefined
  private readonly logger: Logger
  private warned = false
  /** What this deployment calls a secret, declared by the rows that mint them. */
  private readonly declared = new Set<CredentialRef>()
  constructor(path: string | undefined, logger: Logger) {
    this.path = path
    this.logger = logger
  }

  declare(ref: CredentialRef): void {
    this.declared.add(ref)
  }

  declaredRefs(): readonly CredentialRef[] {
    return [...this.declared]
  }

  resolve(ref: CredentialRef): string | undefined {
    const path = this.path
    return lookup(path, ref, () => {
      const store = readStore(path!)
      if (store.state === 'unusable') this.report(store.why)
      return store
    }).value
  }

  describe(ref: CredentialRef): string {
    const env = `the ${ref} environment variable`
    return this.path === undefined ? env : `${env}, or "${ref}" in ${this.path}`
  }

  private report(what: string): void {
    if (this.warned) return
    this.warned = true
    this.logger.warn(`credentials store ${this.path} ${what}; credentials resolve from the environment only until it is fixed`)
  }
}

/** Which layer a reference resolves from, never what it resolves to. */
export type CredentialSource = 'env' | 'store' | 'absent'

/**
 * Where each reference would resolve from RIGHT NOW, by the provider's own
 * lookup — for a person's report (`minidsh credentials list`), so it carries
 * no value, not even a prefix. `problem` is why the store, if it exists,
 * cannot be read: every one of its references then reports `absent`, exactly
 * as `resolve` would treat it.
 */
export function credentialSources(path: string | undefined, refs: readonly CredentialRef[]): { readonly sources: readonly { readonly name: CredentialRef; readonly source: CredentialSource }[]; readonly problem?: string } {
  let read: StoreRead | undefined
  const once = (): StoreRead => (read ??= readStore(path!))
  const sources = refs.map((name) => ({ name, source: lookup(path, name, once).source }))
  // Read even when every reference came from the environment: a broken store
  // is worth saying whichever layer happens to answer today.
  if (path !== undefined) once()
  return { sources, ...(read?.state === 'unusable' ? { problem: `credentials store ${path} ${read.why}` } : {}) }
}

/** Windows refuses a rename over a file another process has open for a moment; a reader's open is brief. */
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 50

/**
 * Sets `name` to `value` in the store at `path`, or removes it (`value`
 * undefined; an absent key is not an error, and writes nothing). Returns
 * whether the store was written. Throws, naming the path, rather
 * than write over a store it cannot read back exactly: a file that exists but
 * is unreadable, not JSON, or not an object of string values is a file a
 * person edited by hand, and a rewrite would silently drop what it holds.
 *
 * Atomic: a temporary beside the store, created exclusively with mode 0600
 * (POSIX; Windows has no mode bits to give it) and synced, then renamed over
 * the store — so a reader sees the old file or the new one, never half of
 * one. The home directory is created when absent. The value is never part of
 * an error.
 */
export function updateCredentialStore(path: string, name: CredentialRef, value: string | undefined): boolean {
  // A store that is a link (a dotfiles checkout) is written where it points:
  // renaming over the link would silently detach it.
  const target = storeTarget(path)
  // Removing from a store that does not exist writes nothing: not even the
  // directory the lock would need.
  if (value === undefined && !existsSync(target)) return false
  return underStoreLock(target, () => writeStore(target, name, value))
}

/**
 * The file a link at `path` names, followed link by link; `path` itself when
 * it is no link or does not exist yet. A DANGLING link (its target not created
 * yet, in a dotfiles checkout say) is followed too: the store is written where
 * the link points, so a rename never replaces the person's link with a file.
 */
function storeTarget(path: string): string {
  let at = path
  for (let hop = 0; hop < 32; hop++) {
    try {
      if (!lstatSync(at).isSymbolicLink()) return at
    } catch {
      return at
    }
    try {
      // A chain that ends at a file: exactly where the OS lands.
      return realpathSync(at)
    } catch {
      // Dangling: one hop, relative to the link's REAL folder (a `..` in the
      // target means what the OS means by it, never a lexical step).
      at = resolve(realpathSync(dirname(at)), readlinkSync(at))
    }
  }
  throw new Error(`${path} is a chain of more than 32 links`)
}

/** How long a writer waits for another, and when a lock is too old to belong to a live one. */
const LOCK_WAIT_MS = 5_000
const LOCK_STALE_MS = 30_000

/**
 * One read-modify-write at a time over the store, across processes: two saves
 * in flight (the desktop's key form and a terminal's `credentials set`) would
 * otherwise both read the old store and the second rename would drop the
 * first key. An exclusive `<store>.lock`, waited for briefly; one older than
 * any write could take is a crashed writer's and is removed.
 */
function underStoreLock<T>(path: string, body: () => T): T {
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // On Windows a lock its holder just removed stays DELETE-PENDING while
      // any process still has a handle on it (a waiter's stat, an antivirus
      // scan), and creating it again answers EPERM, not EEXIST. Measured: 6 of
      // 100 writers died of it in a four-process race (CI found it first).
      // Busy, not broken, until the deadline, which then reports the real error.
      const pending = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
      if (code !== 'EEXIST' && !pending) throw error
      if (code === 'EEXIST') {
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock)
        } catch {
          // Released between the two calls.
        }
      }
      if (Date.now() > deadline) {
        if (pending) throw error
        throw new Error(`credentials store ${path} is being written by another process (${lock}); try again`, { cause: error })
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try {
    return body()
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      // Removed as stale by a waiter that gave up on us: nothing to release.
    }
  }
}

function writeStore(path: string, name: CredentialRef, value: string | undefined): boolean {
  const current = readStore(path)
  if (current.state === 'unusable') throw new Error(`credentials store ${path} ${current.why}; fix or remove it by hand — it is not rewritten`)
  // No prototype: `__proto__` is a valid reference name, and on an ordinary
  // object assigning it sets nothing, so a hand-written key of that name would
  // vanish from the rewrite.
  const store: Record<string, string> = Object.create(null) as Record<string, string>
  if (current.state === 'read') {
    for (const [key, held] of Object.entries(current.store)) {
      if (typeof held !== 'string') throw new Error(`credentials store ${path} holds a value for "${key}" that is not a string; fix it by hand — it is not rewritten`)
      store[key] = held
    }
  }
  if (value === undefined) {
    if (!(name in store)) return false
    delete store[name]
  } else {
    store[name] = value
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  try {
    unlinkSync(temporary)
  } catch {
    // None left by an earlier run with this pid: the usual case.
  }
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(store, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameOver(temporary, path)
    return true
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Already renamed, or never created.
    }
    throw error
  }
}

function renameOver(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || attempt >= RENAME_ATTEMPTS || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS)
    }
  }
}

/** ` at line L, column C` when the parser named a character offset, else nothing: only the digits of its message are read. */
function faultPosition(raw: string, error: unknown): string {
  const offset = error instanceof Error ? /at position (\d+)/u.exec(error.message)?.[1] : undefined
  if (offset === undefined) return ''
  const before = raw.slice(0, Number(offset))
  const line = before.split('\n').length
  const column = before.length - before.lastIndexOf('\n')
  return ` at line ${line}, column ${column}`
}

export const credentialsLocalPlugin: Plugin<CredentialsLocalConfig | undefined> = {
  name: 'credentials-local',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(CREDENTIALS, new LocalCredentials(config?.path, ctx.logger))
  },
}
