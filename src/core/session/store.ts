import { emitEvent, parallelEvent, serviceKey, type Context, type Plugin } from '../../kernel/index.ts'
import { newSessionId, type SessionId } from '../ids.ts'
import { Session, type SessionForkError, type SessionHost } from './session.ts'
import { SESSION_FORMAT_VERSION, type EventEnvelope, type SessionHeader, type SessionOrigin } from './types.ts'

export interface CreateSessionOptions {
  readonly cwd: string
  readonly id?: SessionId
  readonly parentId?: SessionId
  readonly seed?: readonly EventEnvelope[]
  readonly seedLength?: number
  readonly createdAt?: number
  readonly origin?: SessionOrigin
  /**
   * `false` defers the `session/created` announcement: the session exists (its
   * id is claimed, events may be appended) but is invisible to `get`/`list`
   * until the creator calls `publish`. The agent factory uses this so session
   * publication follows agent publication, and a rolled-back creation was
   * never announced at all. Defaults to `true`.
   */
  readonly publish?: boolean
}

export interface Sessions {
  create(options: CreateSessionOptions): Session
  /** Announces a deferred-publication session (`session/created`). Once, and only for a session this store holds. */
  publish(session: Session): void
  get(id: SessionId): Session | undefined
  list(): Session[]
  flush(session: Session): Promise<void>
  detach(session: Session): Promise<void>
}

export const SESSIONS = serviceKey<Sessions>('sessions')

/** A new live session was published. Listeners may snapshot its header. */
export const SESSION_CREATED = emitEvent<[session: Session]>('session/created')
/**
 * One durable event was appended (fire-and-forget, contained). Observers run
 * before the commit and may reject it; listeners run after.
 */
export const SESSION_EVENT = emitEvent<[session: Session, event: EventEnvelope]>('session/event')
/** Awaited durability checkpoint. */
export const SESSION_FLUSH = parallelEvent<[session: Session]>('session/flush')
export const SESSION_DISPOSED = emitEvent<[session: Session]>('session/disposed')

class SessionStore implements Sessions, SessionHost {
  private readonly sessions = new Map<string, Session>()
  private readonly published = new WeakSet<Session>()
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  prepare(session: Session, event: EventEnvelope): () => void {
    return this.ctx.prepareEmit(SESSION_EVENT, session, event)
  }

  async flush(session: Session): Promise<void> {
    await this.ctx.parallel(SESSION_FLUSH, session)
  }

  create(options: CreateSessionOptions): Session {
    const id = options.id ?? newSessionId()
    if (this.sessions.has(id)) throw new Error(`session "${id}" already exists`)
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: options.createdAt ?? Date.now(),
      cwd: options.cwd,
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      ...(options.seedLength === undefined ? {} : { seedLength: options.seedLength }),
    }
    const session = new Session(header, this, options.seed, options.origin)
    this.sessions.set(id, session)
    if (options.publish !== false) this.publish(session)
    return session
  }

  publish(session: Session): void {
    if (this.sessions.get(session.id) !== session) throw new Error(`session "${session.id}" is not held by this store`)
    if (this.published.has(session)) throw new Error(`session "${session.id}" is already published`)
    this.published.add(session)
    this.ctx.emit(SESSION_CREATED, session)
  }

  get(id: SessionId): Session | undefined {
    const session = this.sessions.get(id)
    return session && this.published.has(session) ? session : undefined
  }

  list(): Session[] {
    return [...this.sessions.values()].filter((session) => this.published.has(session))
  }

  /** An unpublished session detaches silently: nothing was ever announced. */
  async detach(session: Session): Promise<void> {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    if (this.published.has(session)) this.ctx.emit(SESSION_DISPOSED, session)
  }
}

export type { SessionForkError }

/** The session seam plugin: provides `ctx.sessions`. */
export const sessionPlugin: Plugin = {
  name: 'core-session',
  apply(ctx) {
    ctx.provide(SESSIONS, new SessionStore(ctx))
  },
}
