/**
 * The filesystem seam (Definition only; a capability provides it).
 *
 * Writes carry an explicit `FsWriteIntent` chosen by the caller; an edit first
 * asks the `fs/edit-intent` single-slot waterfall so a read-before-edit policy
 * can supply the expected version (or refuse). Every read and mutation emits
 * the live `fs/observed` notification (not a session event).
 *
 * **Authority contract.** A provider MUST fence every mutation with the acting
 * session sandbox policy resolved from `ctx.sandbox` — refusing with
 * `FS_SANDBOX_DENIED` before any effect, including creating parent
 * directories. Reads always pass: the mode vocabulary governs file EFFECTS.
 * The fence lives here, below every consumer, so no tool can be the boundary.
 */
import { emitEvent, serviceKey, waterfallEvent } from '../../kernel/index.ts'
import type { Agent } from '../agent/types.ts'

export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_OBSERVED'
  | 'FS_STALE_VERSION'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_SANDBOX_DENIED'
  | 'FS_EXISTS'
  | 'FS_IO'

export class FsError extends Error {
  readonly code: FsErrorCode
  constructor(code: FsErrorCode, message: string) {
    super(message)
    this.name = 'FsError'
    this.code = code
  }
}

/** An opaque, canonical file target resolved against a cwd. */
export interface FsTarget {
  /** Absolute canonical path used for identity and workspace containment. */
  readonly path: string
  /** Path as the model referred to it (for messages). */
  readonly displayPath: string
}

export interface FsInfo {
  readonly type: 'file' | 'directory' | 'other'
  readonly version: string
  readonly size: number
}

export interface DirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
}

/** Conditional write semantics; the observation policy fills these in. */
export type FsWriteIntent =
  | { readonly kind: 'unconditional' }
  | { readonly kind: 'createIfAbsent' }
  | { readonly kind: 'replaceIfVersion'; readonly version: string }

export type FsObservation = { readonly kind: 'present'; readonly version: string } | { readonly kind: 'absent' }

/**
 * The actor of an fs operation; carries the acting agent when known. The
 * `fs/*` events are dispatched in the actor's agent scope (`agent.ctx`), so a
 * policy registered through one agent's context observes that agent alone.
 */
export interface FsActor {
  readonly agent?: Agent
}

export interface Fs {
  resolve(path: string, cwd: string): FsTarget
  stat(target: FsTarget): Promise<FsInfo | undefined>
  /** Reads a file and emits `fs/observed` so the read-before-edit policy can record it. */
  readText(target: FsTarget, actor: FsActor): Promise<{ text: string; version: string }>
  writeText(target: FsTarget, text: string, intent: FsWriteIntent, actor: FsActor): Promise<{ version: string }>
  listDir(target: FsTarget): Promise<DirEntry[]>
}

export const FS = serviceKey<Fs>('fs')

/** Assert an edit is allowed and return the expected version, or throw FS_NOT_OBSERVED. */
export const FS_EDIT_INTENT = waterfallEvent<[target: FsTarget, actor: FsActor], FsObservation>('fs/edit-intent')
/** Live notification that a target's state was observed (read or written). Sync, non-throwing. */
export const FS_OBSERVED = emitEvent<[target: FsTarget, observation: FsObservation, actor: FsActor]>('fs/observed')
