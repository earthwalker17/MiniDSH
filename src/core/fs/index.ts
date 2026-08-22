/**
 * The filesystem seam (Definition only; a capability provides it).
 *
 * `writeText`/edit go through the `fs/write-intent` and `fs/edit-intent`
 * single-slot waterfalls so a read-before-edit policy can gate them, and every
 * mutation emits the live `fs/observed` notification (not a session event).
 */
import { emitEvent, serviceKey, waterfallEvent } from '../../kernel/index.ts'
import type { Session } from '../session/index.ts'

export type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_OBSERVED'
  | 'FS_STALE_VERSION'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_OUTSIDE_WORKSPACE'
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

/** An opaque actor passed to policy listeners; carries the acting agent when known. */
export interface FsActor {
  readonly agent?: { readonly session: Session }
}

export interface Fs {
  resolve(path: string, cwd: string): FsTarget
  stat(target: FsTarget): Promise<FsInfo | undefined>
  readText(target: FsTarget): Promise<{ text: string; version: string }>
  writeText(target: FsTarget, text: string, intent: FsWriteIntent, actor: FsActor): Promise<{ version: string }>
  listDir(target: FsTarget): Promise<DirEntry[]>
  /** The canonical writable root for a session (its cwd). S3 generalizes this into policy. */
  workspaceRoot(session: Session): string
}

export const FS = serviceKey<Fs>('fs')

/** Refine a write's conditionality (default provider uses `unconditional`). */
export const FS_WRITE_INTENT = waterfallEvent<[target: FsTarget, actor: FsActor], FsWriteIntent>('fs/write-intent')
/** Assert an edit is allowed and return the expected version, or throw FS_NOT_OBSERVED. */
export const FS_EDIT_INTENT = waterfallEvent<[target: FsTarget, actor: FsActor], FsObservation>('fs/edit-intent')
/** Live notification that a target's state was observed (read or written). Sync, non-throwing. */
export const FS_OBSERVED = emitEvent<[target: FsTarget, observation: FsObservation, actor: FsActor]>('fs/observed')
