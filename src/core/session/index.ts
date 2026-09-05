/** The session subsystem: the append-only log, its surface, and the store seam. */
export * from './types.ts'
export { Session, SessionForkError, sliceForkSeed, type SessionHost } from './session.ts'
export { deriveEventMessage, foldLastAssistantText, foldLastTurnEnd, foldRequestContext, foldRequestHeader, foldSurfaceSeqs, Surface } from './surface.ts'
export { repairInterruptedTail } from './repair.ts'
export {
  DEFAULT_PAGE_MESSAGES,
  MAX_PAGE_EVENTS,
  MAX_PAGE_MESSAGES,
  groupStart,
  pageEvents,
  type EventPage,
  type PageRequest,
} from './page.ts'
export {
  SESSIONS,
  SESSION_CREATED,
  SESSION_EVENT,
  SESSION_FLUSH,
  SESSION_DISPOSED,
  sessionPlugin,
  type Sessions,
  type CreateSessionOptions,
} from './store.ts'
export { sessionInvariantPlugin } from './invariant.ts'
