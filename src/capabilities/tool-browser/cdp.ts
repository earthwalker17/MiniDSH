/**
 * The Chrome DevTools Protocol over `--remote-debugging-pipe`: the whole client.
 *
 * Chrome reads commands from its fd 3 and writes answers and events to its fd
 * 4, each message one JSON text terminated by a NUL byte
 * (`content/browser/devtools/devtools_pipe_handler.cc`, the default "ASCIIZ"
 * mode). The pipe is the reason there is no port: only the holder of those two
 * file descriptors can drive the browser, so a confined shell sharing the
 * loopback interface cannot (a `--remote-debugging-port` answers anyone on the
 * host, unauthenticated). Sessions are FLAT: a command for a page carries the
 * `sessionId` `Target.attachToTarget({flatten: true})` returned, and so does
 * every event from that page.
 *
 * Three failure rules, each one a defect the plan critics named:
 *   - every pending request rejects when the pipe ends, errors or the browser
 *     exits, so no caller waits on a dead process;
 *   - a write to a pipe whose reader is gone raises `EPIPE` as an `'error'`
 *     event, and an unhandled one kills the host — so both streams carry a
 *     listener that routes it here, to `close`;
 *   - an answer past `maxMessageBytes` is discarded up to its NUL and fails
 *     only the request it answers; the connection lives on.
 */
import type { Readable, Writable } from 'node:stream'
import { BrowserError } from './errors.ts'

export interface CdpEvent {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly sessionId?: string
}

export interface SendOptions {
  readonly sessionId?: string | undefined
  /** Default 30 s. The browser answers most commands in milliseconds; a long one says so. */
  readonly timeoutMs?: number | undefined
  /** The caller's cancellation: rejects with its reason. A late answer is dropped. */
  readonly signal?: AbortSignal | undefined
}

interface Pending {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly cleanup: () => void
}

/** Generous: a full-page capture or a large page's accessibility tree is megabytes, and Chrome caps its own inbound at 100 MB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

export class CdpConnection {
  private readonly writable: Writable
  private readonly maxMessageBytes: number
  private chunks: Buffer[] = []
  private size = 0
  /** Inside an oversized message: its first bytes, kept to name the request it answers. */
  private discardHead: Buffer | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private closedReason: string | undefined

  constructor(writable: Writable, readable: Readable, options: { maxMessageBytes?: number } = {}) {
    this.writable = writable
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    readable.on('data', (chunk: Buffer) => this.onData(chunk))
    readable.on('end', () => this.close('the browser closed its end of the pipe'))
    readable.on('error', (error: Error) => this.close(`the pipe from the browser failed: ${error.message}`))
    writable.on('error', (error: Error) => this.close(`the pipe to the browser failed: ${error.message}`))
  }

  /** Why the connection closed, or `undefined` while it is open. */
  get closed(): string | undefined {
    return this.closedReason
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, options: SendOptions = {}): Promise<T> {
    if (this.closedReason !== undefined) return Promise.reject(new BrowserError('BROWSER_CLOSED', `the browser connection is closed (${this.closedReason}); ${method} was not sent`))
    if (options.signal?.aborted === true) return Promise.reject(options.signal.reason)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.settle(id)?.reject(new BrowserError('BROWSER_TIMEOUT', `the browser did not answer ${method} within ${timeoutMs} ms`))
      }, timeoutMs)
      const onAbort = (): void => {
        this.settle(id)?.reject(options.signal!.reason)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
        },
      })
      const message = JSON.stringify({ id, method, params, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) })
      try {
        this.writable.write(`${message}\0`)
      } catch (error) {
        this.close(`writing to the browser failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** Every event, in arrival order. Returns the unsubscribe. A throwing listener is contained. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called once, with the reason, when the connection closes; immediately if it already has. */
  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason !== undefined) {
      listener(this.closedReason)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** Idempotent. Rejects every pending request with `BROWSER_CLOSED` naming the reason. */
  close(reason: string): void {
    if (this.closedReason !== undefined) return
    this.closedReason = reason
    for (const id of Array.from(this.pending.keys())) this.settle(id)?.reject(new BrowserError('BROWSER_CLOSED', `the browser went away (${reason})`))
    for (const listener of Array.from(this.closeListeners)) {
      try {
        listener(reason)
      } catch {
        // A close listener's fault is its own.
      }
    }
    this.closeListeners.clear()
    this.listeners.clear()
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    entry.cleanup()
    return entry
  }

  private onData(chunk: Buffer): void {
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start)
      if (end < 0) {
        this.append(chunk.subarray(start))
        return
      }
      this.append(chunk.subarray(start, end))
      this.flush()
      start = end + 1
    }
  }

  private append(part: Buffer): void {
    if (part.length === 0) return
    if (this.discardHead !== undefined) return
    if (this.size + part.length > this.maxMessageBytes) {
      // Keep only enough to read the answer's id, and drop the rest as it arrives.
      this.discardHead = Buffer.concat([...this.chunks, part.subarray(0, 64)]).subarray(0, 64)
      this.chunks = []
      this.size = 0
      return
    }
    this.chunks.push(part)
    this.size += part.length
  }

  private flush(): void {
    if (this.discardHead !== undefined) {
      const head = this.discardHead.toString('utf8')
      this.discardHead = undefined
      const id = /^\{"id":(\d+)/.exec(head)?.[1]
      if (id !== undefined) {
        const entry = this.settle(Number(id))
        entry?.reject(new BrowserError('BROWSER_PROTOCOL', `the browser's answer to ${entry.method} was larger than ${this.maxMessageBytes} bytes and was dropped`))
      }
      return
    }
    const text = Buffer.concat(this.chunks, this.size).toString('utf8')
    this.chunks = []
    this.size = 0
    if (text.length === 0) return
    let message: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown; result?: unknown; error?: { message?: unknown } }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      this.close('the browser sent a message that is not JSON')
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.settle(message.id)
      if (!entry) return
      if (message.error !== undefined) entry.reject(new BrowserError('BROWSER_PROTOCOL', `${entry.method}: ${String(message.error.message ?? 'protocol error')}`))
      else entry.resolve(message.result ?? {})
      return
    }
    if (typeof message.method === 'string') {
      const event: CdpEvent = {
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
        ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
      }
      for (const listener of Array.from(this.listeners)) {
        try {
          listener(event)
        } catch {
          // A listener's fault is its own: one bad consumer must not starve the rest.
        }
      }
    }
  }
}
