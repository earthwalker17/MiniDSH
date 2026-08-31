/**
 * The settings seam: user-adjustable defaults, registered by whoever owns them
 * and readable, watchable and WRITABLE at runtime.
 *
 * It exists because a remote writer does. Until S7 settings resolved once at
 * process entry into plain values, which is all a CLI needs; a browser pane
 * that edits a default needs three things a value cannot give it — a
 * description of what may be written (`describe`), a way to write it
 * (`write`), and a way for a second client to learn that someone did
 * (`settings/changed`).
 *
 * What it is NOT is as load-bearing as what it is:
 *
 * - Authority is never settings. Sandbox and approval are durable session
 *   events; a settings write must not be able to widen what an agent may do.
 * - Composition is never settings. Which plugins mount, and their config, is
 *   `composition.json`, hashed into each session's `composition/applied` — so
 *   a session records the world it ran in. A settings write may not change it.
 * - Settings stay in the DEFAULTS tier. A resumed session rebuilds from its own
 *   log; an edit here can never rewrite what a session already recorded.
 *
 * Two layers, merged shallowly per namespace: the `base` its owner registered
 * (already the deployment's resolved default) and the one layer a user writes.
 * The store is the provider's; this file is the contract.
 */
import { emitEvent, serviceKey, type Context, type Disposer } from '../../kernel/index.ts'
import type { JsonValue } from '../json.ts'

/** Structural, like the kernel's plugin config contract — the core imports no schema library. */
export interface SettingsSchema<T> {
  parse(value: unknown): T
}

/** The owner's handle on one namespace. */
export interface SettingsScope<T> {
  /** The resolved value: the user layer merged over the registered base. */
  get(): T
  /** Called after any change to this namespace, including one another client made. */
  watch(listener: (next: T, previous: T) => void): Disposer
  /** Merge fields into the user layer. */
  update(patch: Partial<T>): T
  /** Replace the user layer outright. */
  replace(next: Partial<T>): T
}

export interface SettingsNamespaceInfo {
  readonly ns: string
  /** What this namespace resolves to now. */
  readonly value: JsonValue
  /** What it would resolve to with no user layer — so a UI can show what "unset" means. */
  readonly base: JsonValue
  /** Only the fields a user actually set. */
  readonly user: JsonValue
  /**
   * Monotonic per namespace, over the RAW user layer. A writer echoes the
   * revision it read; a stale one is refused, so two panes cannot silently
   * lose each other's edits.
   */
  readonly revision: number
  /** A JSON Schema for a UI to render, when the owner supplied one. */
  readonly schema?: JsonValue
}

export interface SettingsWriteResult {
  readonly revision: number
  readonly value: JsonValue
}

export interface Settings {
  /**
   * Claims a namespace. Registering twice is an error: two owners of one name
   * would each think their base was the deployment's.
   */
  register<T>(owner: Context, ns: string, schema: SettingsSchema<T>, options: { base: T; schema?: JsonValue }): SettingsScope<T>
  /** Every registered namespace, for a client that must render what it may write. */
  describe(): readonly SettingsNamespaceInfo[]
  read(ns: string): SettingsNamespaceInfo
  /**
   * Writes the user layer. `expectedRevision` is REQUIRED on this path — the
   * fence is what makes two writers safe, and a caller that read a revision has
   * one to give. `patch` merges; `replace: true` overwrites the layer.
   */
  write(ns: string, patch: JsonValue, options: { expectedRevision: number; replace?: boolean }): SettingsWriteResult
}

export const SETTINGS = serviceKey<Settings>('settings')

/** One namespace's resolved value changed. Carries the new revision so a mirror can dedupe. */
export const SETTINGS_CHANGED = emitEvent<[ns: string, revision: number]>('settings/changed')

export class SettingsError extends Error {
  readonly code: 'SETTINGS_UNKNOWN_NS' | 'SETTINGS_DUPLICATE_NS' | 'SETTINGS_CONFLICT' | 'SETTINGS_INVALID'
  constructor(code: SettingsError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SettingsError'
    this.code = code
  }
}

/**
 * The one resolution rule: the user layer's own fields over the base, one level
 * deep. Deep merging would make "unset this field" impossible to express, and a
 * settings namespace is a flat record of defaults by design.
 */
export function mergeLayers<T>(base: T, user: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return user === undefined ? base : user
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return base
  return { ...(base as object), ...(user as object) }
}
