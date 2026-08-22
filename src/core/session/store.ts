import { emitEvent, parallelEvent, serviceKey, type Context, type Disposer, type Plugin } from '../../kernel/index.ts'
import { asSessionId, newSessionId, type SessionId } from '../ids.ts'
import { Session, type SessionForkError, type SessionHost } from './session.ts'
import { SESSION_FORMAT_VERSION, type EventEnvelope, type SessionHeader } from './types.ts'

export interface CreateSessionOptions {
  readonly cwd: string
  readonly id?: SessionId
  readonly parentId?: SessionId
  readonly seed?: readonly EventEnvelope[]
  readonly seedLength?: number
  readonly createdAt?: number
}

export interface Sessions {
  create(options: CreateSessionOptions): Session
  get(id: SessionId): Session | undefined
  list(): Session[]
  fork(source: Session | SessionId, boundary?: number, childId?: SessionId): Session
  flush(session: Session): Promise<void>
  detach(session: Session): Promise<void>
}

export const SESSIONS = serviceKey<Sessions>('sessions')

/** A new live session was published. Listeners may snapshot its header. */
export const SESSION_CREATED = emitEvent<[session: Session]>('session/created')
/** One durable event was appended (post-commit, fire-and-forget, contained). */
export const SESSION_EVENT = emitEvent<[session: Session, event: EventEnvelope]>('session/event')
/** Awaited durability checkpoint. */
export const SESSION_FLUSH = parallelEvent<[session: Session]>('session/flush')
export const SESSION_DISPOSED = emitEvent<[session: Session]>('session/disposed')

class SessionStore implements Sessions, SessionHost {
  private readonly sessions = new Map<string, Session>()
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  onCommit(session: Session, event: EventEnvelope): void {
    this.ctx.emit(SESSION_EVENT, session, event)
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
    const session = new Session(header, this, options.seed)
    this.sessions.set(id, session)
    this.ctx.emit(SESSION_CREATED, session)
    return session
  }

  get(id: SessionId): Session | undefined {
    return this.sessions.get(id)
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  fork(source: Session | SessionId, boundary?: number, childId?: SessionId): Session {
    const src = typeof source === 'string' ? this.sessions.get(asSessionId(source)) : source
    if (!src) throw new Error(`fork source "${String(source)}" not found`)
    const seed = src.forkSeed(boundary)
    return this.create({
      cwd: src.header.cwd,
      parentId: src.id,
      seed,
      seedLength: seed.length,
      ...(childId === undefined ? {} : { id: childId }),
    })
  }

  async detach(session: Session): Promise<void> {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    this.ctx.emit(SESSION_DISPOSED, session)
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

/** Convenience for capabilities that own a disposer around a created session. */
export function createOwnedSession(ctx: Context, options: CreateSessionOptions): { session: Session; dispose: Disposer } {
  const sessions = ctx.get(SESSIONS)
  const session = sessions.create(options)
  return { session, dispose: () => sessions.detach(session) }
}
