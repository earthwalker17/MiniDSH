/**
 * The persistence Definition: the read seam over stored session logs, so the
 * core can seed resume/fork from a stored log without importing a capability.
 * The write path is deliberately NOT here — a provider subscribes to
 * `session/*` and owns its format, its attach-on-resume behavior, and its
 * failure discipline. Consumers get exactly what they need: load one stored
 * log, list what is stored — and the one thing about the write path a reader
 * must be told rather than assume: what the provider's own `session/flush`
 * listener guarantees (`durability`), which the creation transaction copies
 * into each lifecycle's record (§4).
 */
import { serviceKey } from '../../kernel/index.ts'
import type { EventEnvelope, SessionHeader } from '../session/types.ts'

export interface StoredSession {
  readonly header: SessionHeader
  /** The contiguous readable event prefix (a torn tail is truncated on read). */
  readonly events: EventEnvelope[]
  /**
   * Set when the store holds bytes beyond `events` that are more than a torn
   * final line (a mid-file parse error, a seq gap, a line that is not an event
   * envelope). Such a session is still readable but must not be resumed:
   * attaching would silently disown data. A fork may salvage its prefix.
   */
  readonly damaged?: true
  /** How the store read the file, for a reader that must say what it could not read. Absent from a store that cannot tell. */
  readonly integrity?: StoredIntegrity
}

export interface StoredIntegrity {
  /** The file's size, and the bytes of its accepted prefix (header included). */
  readonly bytes: number
  readonly readableBytes: number
  /** What lies past the prefix: nothing, an unterminated final line (a crash artifact), or damage. */
  readonly tail: 'none' | 'torn' | 'damaged'
  /** Where reading stopped, for `damaged`: the 1-based line, its byte offset, and why. */
  readonly stop?: { readonly line: number; readonly byte: number; readonly reason: string }
}

/** What a listing knows about a stored session without reading it: its header, and what to call it. */
export interface StoredSessionSummary {
  readonly header: SessionHeader
  /**
   * The session's name — the recorded `session/title`, else what its first
   * prompt says. DERIVED, never stored on the header, and absent when the
   * store's bounded prefix read did not reach far enough to find either.
   */
  readonly title?: string
}

export interface Persistence {
  /** The stored session, or undefined if the store has no such id. Throws `SessionFormatError` for a log of a format this reader cannot read. */
  load(id: string): StoredSession | undefined
  /** Stored session summaries, newest first. */
  list(): StoredSessionSummary[]
  /**
   * `synced`: a resolved `session/flush` has put every event appended before
   * it on stable storage, so it survives a power cut. Absent: no such claim
   * (the modelled failure is then a process crash). Declared, never inferred —
   * crash repair leans on it (§4).
   */
  readonly durability?: 'synced'
}

export const PERSISTENCE = serviceKey<Persistence>('persistence')
