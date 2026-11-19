import { describe, expect, it } from 'vitest'
import { activityOf, inspectRuntime, type InspectSocket } from './inspect.ts'

type Listener = (event: { readonly data?: unknown }) => void

/**
 * A scripted socket: `behave` runs once construction returns, with the socket
 * to drive. It records what was sent and whether it was closed.
 */
function fakeSockets(behave: (socket: FakeSocket) => void): { ctor: new (url: string, init: { headers: Record<string, string> }) => InspectSocket; made: FakeSocket[] } {
  const made: FakeSocket[] = []
  class Ctor extends FakeSocket {
    constructor(url: string, init: { headers: Record<string, string> }) {
      super(url, init)
      made.push(this)
      queueMicrotask(() => behave(this))
    }
  }
  return { ctor: Ctor, made }
}

class FakeSocket implements InspectSocket {
  readonly url: string
  readonly headers: Record<string, string>
  readonly sent: unknown[] = []
  closed = 0
  private readonly listeners = new Map<string, Listener[]>()
  constructor(url: string, init: { headers: Record<string, string> }) {
    this.url = url
    this.headers = init.headers
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed += 1
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(data === undefined ? {} : { data })
  }
  answer(frame: unknown): void {
    this.emit('message', JSON.stringify(frame))
  }
}

const summary = (status: string, runningJobs = 0, pendingApprovals = 0, heldNotices = 0): Record<string, unknown> => ({ sessionId: `s-${status}`, status, runningJobs, heldNotices, pendingApprovals })
const COOKIE = 'minidsh_session=abc.def'

describe('runtime inspection over the wire', () => {
  it('sends one control/subscribe with the cookie, reads the baseline, and closes', async () => {
    const { ctor, made } = fakeSockets((socket) => {
      socket.emit('open')
      // A notification first: only the answer to OUR id settles.
      socket.answer({ jsonrpc: '2.0', method: 'control.summary', params: summary('running') })
      socket.answer({ jsonrpc: '2.0', id: 1, result: { sessions: [summary('idle', 0, 0, 3), summary('closed')] } })
    })
    expect(await inspectRuntime({ port: 31_000, cookie: COOKIE, WebSocketImpl: ctor })).toEqual({ busy: false, unknown: false, running: 0, jobs: 0, approvals: 0 })
    const [socket] = made
    expect(socket!.url).toBe('ws://127.0.0.1:31000/ws')
    expect(socket!.headers).toEqual({ cookie: COOKIE })
    expect(socket!.sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'control/subscribe', params: {} }])
    expect(socket!.closed).toBe(1)
  })

  it('is busy for a running turn, a running job or a waiting question, and counts each', async () => {
    const result = { sessions: [summary('running'), summary('idle', 2, 0), summary('idle', 0, 1), summary('running', 1, 1)] }
    const { ctor } = fakeSockets((socket) => {
      socket.emit('open')
      socket.answer({ jsonrpc: '2.0', id: 1, result })
    })
    expect(await inspectRuntime({ port: 1, cookie: COOKIE, WebSocketImpl: ctor })).toEqual({ busy: true, unknown: false, running: 2, jobs: 3, approvals: 2 })
    expect(activityOf({ sessions: [summary('idle', 0, 1)] })?.busy).toBe(true)
    expect(activityOf({ sessions: [summary('idle', 1, 0)] })?.busy).toBe(true)
    expect(activityOf({ sessions: [] })).toEqual({ busy: false, unknown: false, running: 0, jobs: 0, approvals: 0 })
  })

  it('reads every failure as unknown, and unknown as busy, always closing the socket', async () => {
    const UNKNOWN = { busy: true, unknown: true, running: 0, jobs: 0, approvals: 0 }
    const scripts: ((socket: FakeSocket) => void)[] = [
      (socket) => socket.emit('error'),
      (socket) => socket.emit('close'),
      (socket) => {
        socket.emit('open')
        socket.emit('close')
      },
      (socket) => {
        socket.emit('open')
        socket.answer({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown method' } })
      },
      (socket) => {
        socket.emit('open')
        socket.answer({ jsonrpc: '2.0', id: 1, result: { sessions: [{ status: 'running' }] } })
      },
      (socket) => {
        socket.emit('open')
        socket.answer({ jsonrpc: '2.0', id: 1, result: { sessions: [summary('weird')] } })
      },
      (socket) => {
        socket.emit('open')
        socket.answer({ jsonrpc: '2.0', id: 1 })
      },
    ]
    for (const script of scripts) {
      const { ctor, made } = fakeSockets(script)
      expect(await inspectRuntime({ port: 1, cookie: COOKIE, WebSocketImpl: ctor })).toEqual(UNKNOWN)
      expect(made[0]!.closed).toBeGreaterThanOrEqual(1)
    }
  })

  it('gives up at the deadline, closing the socket rather than holding a control subscription', async () => {
    const { ctor, made } = fakeSockets((socket) => socket.emit('open'))
    const started = Date.now()
    expect(await inspectRuntime({ port: 1, cookie: COOKIE, timeoutMs: 100, WebSocketImpl: ctor })).toMatchObject({ busy: true, unknown: true })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(made[0]!.closed).toBe(1)
    // A late answer changes nothing and reopens nothing.
    made[0]!.answer({ jsonrpc: '2.0', id: 1, result: { sessions: [] } })
    expect(made).toHaveLength(1)
  })

  it('is unknown when the socket cannot even be constructed', async () => {
    const throws = function (): never {
      throw new SyntaxError('bad url')
    }
    expect(await inspectRuntime({ port: 1, cookie: COOKIE, WebSocketImpl: throws as never })).toMatchObject({ busy: true, unknown: true })
  })

  it('is unknown against a port nobody listens on, with the real WebSocket', async () => {
    expect(await inspectRuntime({ port: 1, cookie: COOKIE, timeoutMs: 5_000 })).toMatchObject({ busy: true, unknown: true })
  })
})
