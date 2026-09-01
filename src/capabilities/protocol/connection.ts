/**
 * One connected client. Everything that is per-socket lives here — the frame
 * sink, which sessions this client receives events for, and whether its carrier
 * lets it shut the host down. Everything else (agents, the resume table, the
 * pending approvals, the cold-read cache) belongs to the host and outlives any
 * connection: a browser refreshing its tab must not dispose a running agent.
 */
import type { RpcNotification, RpcResponse } from './frames.ts'

export interface ConnectionOptions {
  /**
   * Where frames go. A carrier owns framing and flow control; this is the sink.
   * `droppable` marks a frame the client can lose without losing meaning — the
   * trace tier, which is streaming fidelity and nothing a fold reads. A carrier
   * under pressure may skip those; it may never skip a fact or a surface event.
   */
  readonly send: (frame: RpcResponse | RpcNotification, droppable: boolean) => void
  /**
   * Whether a client on this carrier may end the whole host. True for stdio and
   * the loopback pair, where the client IS the process's reason to run; false
   * for a socket, where one browser tab must not be able to kill a daemon
   * other clients are using.
   */
  readonly allowShutdown: boolean
}

export class ClientConnection {
  private readonly options: ConnectionOptions
  /**
   * `undefined` means every session, which is what a client that has not
   * attached gets — the behaviour every existing client was written against.
   * The first `session/attach` narrows to a set, because a client that names a
   * session is telling you which one it wants.
   */
  private watching: Set<string> | undefined
  private closed = false

  constructor(options: ConnectionOptions) {
    this.options = options
  }

  get allowShutdown(): boolean {
    return this.options.allowShutdown
  }

  get isClosed(): boolean {
    return this.closed
  }

  watches(sessionId: string): boolean {
    return this.watching === undefined || this.watching.has(sessionId)
  }

  /**
   * ASKED for this session by name, rather than merely not having narrowed
   * away from it. The distinction is what a delegated child turns on: a client
   * that watches everything has not asked to follow someone else's subagent.
   */
  attached(sessionId: string): boolean {
    return this.watching?.has(sessionId) === true
  }

  /** Narrows to this session (and any attached before it). */
  attach(sessionId: string): void {
    this.watching ??= new Set()
    this.watching.add(sessionId)
  }

  /** Stops delivery for one session. A connection that detaches its last one receives nothing. */
  detach(sessionId: string): void {
    this.watching ??= new Set()
    this.watching.delete(sessionId)
  }

  /**
   * Watch nothing at all. A client that has not attached yet watches
   * EVERYTHING, which also makes it a candidate answerer for every approval —
   * so a surface that shows only the session it has open says so explicitly
   * rather than parking questions it will never display.
   */
  detachAll(): void {
    this.watching = new Set()
  }

  send(frame: RpcResponse | RpcNotification, droppable = false): void {
    if (this.closed) return
    this.options.send(frame, droppable)
  }

  close(): void {
    this.closed = true
  }
}
