/**
 * The persistence Definition: the read seam over stored session logs, so the
 * core can seed resume/fork from a stored log without importing a capability.
 * The write path is deliberately NOT here — a provider subscribes to
 * `session/*` and owns its format, its attach-on-resume behavior, and its
 * failure discipline. Consumers get exactly what they need: load one stored
 * log, list what is stored.
 */
import { serviceKey } from '../../kernel/index.ts'
import type { EventEnvelope, SessionHeader } from '../session/types.ts'

export interface StoredSession {
  readonly header: SessionHeader
  /** The contiguous readable event prefix (a torn tail is truncated on read). */
  readonly events: EventEnvelope[]
  /**
   * Set when the store holds bytes beyond `events` that are more than a torn
   * final line (a mid-file parse error or seq gap). Such a session is still
   * readable but must not be resumed: attaching would silently disown data.
   */
  readonly damaged?: true
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
  /** The stored session, or undefined if the store has no such id. */
  load(id: string): StoredSession | undefined
  /** Stored session summaries, newest first. */
  list(): StoredSessionSummary[]
}

export const PERSISTENCE = serviceKey<Persistence>('persistence')
