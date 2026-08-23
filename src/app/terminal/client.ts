/**
 * The protocol client half of the terminal surface: JSON-RPC requests with
 * response correlation, notifications handed to the controller. It speaks the
 * same newline-delimited framing as any external client — the loopback pair it
 * usually rides on is a carrier detail.
 */
import { NdjsonTransport } from '../../capabilities/protocol-stdio/index.ts'

export interface ClientHandlers {
  readonly onNotification: (method: string, params: unknown) => void
  readonly onEnd?: () => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class ProtocolClient {
  private readonly transport: NdjsonTransport
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  constructor(fromHost: NodeJS.ReadableStream, toHost: NodeJS.WritableStream, handlers: ClientHandlers) {
    this.transport = new NdjsonTransport(fromHost, toHost)
    this.transport.start({
      onFrame: (frame) => this.onFrame(frame, handlers),
      onEnd: () => {
        this.failAll(new Error('the host closed the connection'))
        handlers.onEnd?.()
      },
    })
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('client closed'))
    const id = this.nextId++
    const reply = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    return reply as Promise<T>
  }

  private onFrame(frame: unknown, handlers: ClientHandlers): void {
    if (typeof frame !== 'object' || frame === null) return
    const record = frame as Record<string, unknown>
    if (typeof record.method === 'string') {
      handlers.onNotification(record.method, record.params)
      return
    }
    const id = record.id
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    const error = record.error as { code: number; message: string } | undefined
    if (error) entry.reject(new Error(error.message))
    else entry.resolve(record.result)
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('client closed'))
    this.transport.stop()
  }
}
