/**
 * The WebSocket carrier over a REAL socket, driven by Node's built-in
 * `WebSocket` client — the same client a browser is. The codec is ours, so the
 * cases that matter are the ones a hand-rolled one gets wrong: fragmentation,
 * a payload past the 16-bit length, ping/pong, the close handshake, and the
 * trust fence rejecting an upgrade instead of half-opening it.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { connect as tcpConnect, type AddressInfo, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { AGENTS } from '../../core/agent/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { LLM } from '../../core/llm/index.ts'
import { assistantText, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { startProtocolHost, type ProtocolHostHandle } from '../../app/serve.ts'
import type { ClientConnection } from './connection.ts'
import { acceptKey, decodeFrames, encodeTextFrame, serveWebSocket, type WebSocketCarrierOptions } from './transport-ws.ts'
import type { AttachResult } from './frames.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

let dirs: string[] = []
let hosts: ProtocolHostHandle[] = []
let servers: Server[] = []
let sockets: WebSocket[] = []
let rawSockets: Socket[] = []
let carrierStops: (() => void)[] = []

afterEach(async () => {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close()
  sockets = []
  for (const socket of rawSockets) socket.destroy()
  rawSockets = []
  for (const stop of carrierStops) stop()
  carrierStops = []
  for (const host of hosts.toReversed()) await host.dispose()
  hosts = []
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
  // Last: a heartbeat made on the stepped clock is cleared on it.
  vi.useRealTimers()
})

/** Polls `pick` until it answers; the failure names what never came. */
async function eventually<T>(pick: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = pick()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Runs `body` with this process's uncaught exceptions collected instead of
 * handed to the test runner, so "nothing was thrown at the process" fails as
 * an assertion that prints what was thrown.
 */
async function collectingUncaught(body: () => Promise<void>): Promise<string[]> {
  const uncaught: string[] = []
  const collect = (error: unknown): void => void uncaught.push(String(error))
  const others = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  process.on('uncaughtException', collect)
  try {
    await body()
  } finally {
    process.off('uncaughtException', collect)
    for (const listener of others) process.on('uncaughtException', listener)
  }
  return uncaught
}

/**
 * The heartbeat on a clock the test steps, so "by the next beat" is a step and
 * not a race against a loaded host: with real 25 ms beats, a pong that took
 * longer than one beat to cross a starved event loop closed a healthy socket.
 * Only the interval is stepped; every other timer stays real. Call it BEFORE
 * the carrier starts, and beat with `vi.advanceTimersByTime(BEAT_MS)`.
 */
const BEAT_MS = 25
function steppedHeartbeat(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
}

/** One client frame with every header field under the caller's control. */
function clientFrame(opcode: number, payload: Buffer, options: { fin?: boolean; rsv?: number; masked?: boolean } = {}): Buffer {
  const { fin = true, rsv = 0, masked = true } = options
  const key = Buffer.from([0x01, 0x02, 0x03, 0x04])
  const body = Buffer.from(payload)
  if (masked) for (let index = 0; index < body.length; index++) body[index] = body[index]! ^ key[index % 4]!
  const parts: Buffer[] = [Buffer.from([(fin ? 0x80 : 0) | (rsv << 4) | opcode])]
  if (body.length < 126) parts.push(Buffer.from([(masked ? 0x80 : 0) | body.length]))
  else {
    const long = Buffer.alloc(3)
    long[0] = (masked ? 0x80 : 0) | 126
    long.writeUInt16BE(body.length, 1)
    parts.push(long)
  }
  if (masked) parts.push(key)
  parts.push(body)
  return Buffer.concat(parts)
}

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

const upgradeRequest = (port: number, path: string, key: string | undefined): string =>
  [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', ...(key === undefined ? [] : [`Sec-WebSocket-Key: ${key}`]), 'Sec-WebSocket-Version: 13', '', ''].join('\r\n')

function rawSocket(port: number, options: { allowHalfOpen?: boolean } = {}): Socket {
  const socket = tcpConnect({ port, host: '127.0.0.1', ...options })
  rawSockets.push(socket)
  // This end's errors are the test's own doing (it resets); the host's end is what is under test.
  socket.on('error', () => {})
  return socket
}

/**
 * A WebSocket peer written by hand on a raw TCP socket, for everything Node's
 * own client never does: fragment a message, send a frame unmasked or binary,
 * leave a ping unanswered. It answers nothing by itself.
 */
class RawPeer {
  /** Every frame the host sent, in order (a server never masks). */
  readonly frames: { opcode: number; payload: Buffer }[] = []
  private readonly socket: Socket
  private rest: Buffer = Buffer.alloc(0)

  private constructor(socket: Socket) {
    this.socket = socket
  }

  static async open(port: number, path = '/ws'): Promise<RawPeer> {
    const socket = rawSocket(port)
    const peer = new RawPeer(socket)
    const key = randomBytes(16).toString('base64')
    await new Promise<void>((resolve, reject) => {
      let head: Buffer = Buffer.alloc(0)
      const onData = (chunk: Buffer): void => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.off('data', onData)
        const answer = head.subarray(0, end).toString('latin1')
        if (!answer.startsWith('HTTP/1.1 101') || !answer.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`)) {
          reject(new Error(`the handshake was not accepted: ${answer}`))
          return
        }
        socket.on('data', (more: Buffer) => peer.take(more))
        peer.take(head.subarray(end + 4))
        resolve()
      }
      socket.on('data', onData)
      socket.once('close', () => reject(new Error('the socket closed during the handshake')))
      socket.once('connect', () => socket.write(upgradeRequest(port, path, key)))
    })
    return peer
  }

  private take(chunk: Buffer): void {
    this.rest = Buffer.concat([this.rest, chunk])
    const { frames, rest } = decodeFrames(this.rest, 64 * 1024 * 1024)
    this.rest = rest
    for (const frame of frames) this.frames.push({ opcode: frame.opcode, payload: frame.payload })
  }

  send(...frames: Buffer[]): void {
    this.socket.write(Buffer.concat(frames))
  }

  sendJson(value: unknown): void {
    this.send(clientFrame(OP.text, Buffer.from(JSON.stringify(value), 'utf8')))
  }

  count(opcode: number): number {
    return this.frames.filter((frame) => frame.opcode === opcode).length
  }

  messages(): Record<string, unknown>[] {
    return this.frames.filter((frame) => frame.opcode === OP.text).map((frame) => JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>)
  }

  /** The close frame the host sent, if it has. */
  closed(): { code: number; reason: string } | undefined {
    const frame = this.frames.find((one) => one.opcode === OP.close)
    return frame === undefined ? undefined : { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString('utf8') }
  }
}

interface BareCarrier {
  readonly port: number
  readonly server: Server
  /** The host's end of every TCP connection, in the order they were accepted. */
  readonly accepted: Socket[]
  readonly connections: ClientConnection[]
  readonly messages: unknown[]
  readonly malformed: string[]
  closes: number
}

/** The carrier alone on a bare HTTP server: no protocol host behind it, so what it hands over is read directly. */
async function bareCarrier(options: Partial<WebSocketCarrierOptions> = {}): Promise<BareCarrier> {
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  servers.push(server)
  const accepted: Socket[] = []
  server.on('connection', (socket) => accepted.push(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const carrier: BareCarrier = { port: (server.address() as AddressInfo).port, server, accepted, connections: [], messages: [], malformed: [], closes: 0 }
  carrierStops.push(
    serveWebSocket({
      server,
      onConnection: (connection) => void carrier.connections.push(connection),
      onClose: () => void carrier.closes++,
      onMessage: (_connection, frame) => void carrier.messages.push(frame),
      onMalformed: (detail) => void carrier.malformed.push(detail),
      ...options,
    }),
  )
  return carrier
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A JSON-RPC client over a real WebSocket, the shape the browser client uses. */
class SocketClient {
  readonly notifications: { method: string; params: Record<string, unknown> }[] = []
  readonly closes: { code: number; reason: string }[] = []
  private nextId = 1
  private readonly pending = new Map<number, (reply: { result?: unknown; error?: { code: number; message: string } }) => void>()

  readonly socket: WebSocket

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      if (typeof frame.method === 'string') this.notifications.push(frame as { method: string; params: Record<string, unknown> })
      else {
        this.pending.get(frame.id as number)?.(frame)
        this.pending.delete(frame.id as number)
      }
    })
    socket.addEventListener('close', (event) => void this.closes.push({ code: event.code, reason: event.reason }))
  }

  call(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = this.nextId++
    const reply = new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => this.pending.set(id, resolve))
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    return reply
  }

  async result<T>(method: string, params?: unknown): Promise<T> {
    const reply = await this.call(method, params)
    if (reply.error) throw new Error(`${method} failed: ${reply.error.message}`)
    return reply.result as T
  }

  frames(type?: string): { sessionId: string; event: { type: string; data: Record<string, unknown> } }[] {
    return this.notifications
      .filter((entry) => entry.method === 'session.event')
      .map((entry) => entry.params as unknown as { sessionId: string; event: { type: string; data: Record<string, unknown> } })
      .filter((frame) => type === undefined || frame.event.type === type)
  }

  async waitFor<T>(pick: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const value = pick()
      if (value !== undefined) return value
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

async function startWebHost(
  adapter: ScriptedAdapter,
  extra?: {
    authorize?: (request: { headers: Record<string, unknown> }) => true | number
    prepare?: (root: Context) => void
    softLimitBytes?: number
    hardLimitBytes?: number
    heartbeatMs?: number
  },
): Promise<{ host: ProtocolHostHandle; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const host = await startProtocolHost({
    cwd: tempDir('minidsh-ws-cwd-'),
    sessionsRoot: tempDir('minidsh-ws-sessions-'),
    logger: silent,
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root) => {
      root.get(LLM).registerAdapter(root, adapter)
      extra?.prepare?.(root)
    },
    carriers: [
      {
        kind: 'websocket',
        server,
        ...(extra?.authorize === undefined ? {} : { authorize: extra.authorize as never }),
        ...(extra?.softLimitBytes === undefined ? {} : { softLimitBytes: extra.softLimitBytes }),
        ...(extra?.heartbeatMs === undefined ? {} : { heartbeatMs: extra.heartbeatMs }),
      },
      // A second carrier on the same server, for a client whose limits differ.
      ...(extra?.hardLimitBytes === undefined ? [] : [{ kind: 'websocket' as const, server, path: '/slow', hardLimitBytes: extra.hardLimitBytes }]),
    ],
  })
  hosts.push(host)
  return { host, port: (server.address() as AddressInfo).port }
}

async function connect(port: number, path = '/ws'): Promise<SocketClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('the socket refused to open')), { once: true })
  })
  return new SocketClient(socket)
}

describe('the websocket carrier', () => {
  it('serves the same protocol over a real socket, with no dependency on either side', async () => {
    const { port } = await startWebHost(new ScriptedAdapter().script(assistantText('hello over the socket')))
    const client = await connect(port)

    const init = await client.result<{ serverInfo: { name: string } }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')

    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await client.waitFor(() => client.frames('turn/end')[0], 'the turn to end')
    const attached = await client.result<AttachResult>('session/attach', { sessionId })
    expect(attached.header.id).toBe(sessionId)
    expect(attached.page.events.some((event) => event.type === 'assistant/message')).toBe(true)
  })

  it('refuses shutdown, because a tab is not a process', async () => {
    const { port, host } = await startWebHost(new ScriptedAdapter())
    const client = await connect(port)
    const reply = await client.call('shutdown')
    expect(reply.error?.message).toContain('may not shut the host down')
    // Still serving: the same socket is answered, and the surface has not been declared done.
    expect((await client.result<{ serverInfo: { name: string } }>('initialize')).serverInfo.name).toBe('minidsh')
    expect(await Promise.race([host.closed.then(() => 'closed'), new Promise((resolve) => setImmediate(() => resolve('serving')))])).toBe('serving')
  })

  it('outlives its clients: the host is still there when the last socket closes', async () => {
    const { port, host } = await startWebHost(new ScriptedAdapter().script(assistantText('one'), assistantText('two')))
    const first = await connect(port)
    const { sessionId } = await first.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await first.waitFor(() => first.frames('turn/end')[0], 'the first turn')
    first.socket.close()
    await first.waitFor(() => (first.closes.length > 0 ? true : undefined), 'the socket to close')

    // A fresh tab reattaches to the same live session and drives it on. LIVE is
    // the claim: the agent the first tab made was not disposed with its socket
    // (a stored session would be resumed by the prompt below, and pass too).
    const second = await connect(port)
    const attached = await second.result<AttachResult>('session/attach', { sessionId })
    expect(attached.header.id).toBe(sessionId)
    expect(host.root.get(AGENTS).get(asSessionId(sessionId)), 'the agent the closed socket had made').toBeDefined()
    await second.result('session/prompt', { sessionId, text: 'still here?' })
    await second.waitFor(() => second.frames('turn/end')[0], 'the second turn')
  })

  it('rejects an upgrade the trust fence turns down, rather than half-opening it', async () => {
    const { port } = await startWebHost(new ScriptedAdapter(), { authorize: () => 403 })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(socket)
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => resolve('opened'), { once: true })
      socket.addEventListener('error', () => resolve('refused'), { once: true })
      socket.addEventListener('close', () => resolve('closed'), { once: true })
    })
    expect(outcome).not.toBe('opened')
  })

  it('carries a message far past the 16-bit length, in both directions', async () => {
    const { port } = await startWebHost(new ScriptedAdapter().script(assistantText('x'.repeat(200_000))))
    const client = await connect(port)
    await client.result<{ sessionId: string }>('session/prompt', { text: 'y'.repeat(150_000), agentOptions: SCRIPTED })
    const message = await client.waitFor(() => client.frames('assistant/message')[0], 'the large assistant message')
    const text = ((message.event.data.message as { content: { text?: string }[] }).content[0] as { text: string }).text
    expect(text).toHaveLength(200_000)
    const entered = client.frames('user/message')[0]!
    expect(((entered.event.data.message as { content: { text?: string }[] }).content[0] as { text: string }).text).toHaveLength(150_000)
  })

  /**
   * The limits are forced negative so every send is "over" them. Stalling a
   * real socket takes hundreds of kilobytes of kernel buffer and is timing
   * dependent; what matters here is the branch, and the branch is exact.
   */
  it('drops the trace tier under pressure and never a fact or a surface event', async () => {
    const { port } = await startWebHost(new ScriptedAdapter().script(assistantText('the durable answer')), { softLimitBytes: -1 })
    const client = await connect(port)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await client.waitFor(() => client.frames('turn/end')[0], 'the turn to end')

    // Streaming fidelity is the give…
    expect(client.frames('assistant/chunk')).toHaveLength(0)
    // …and the conversation is not: the same text arrives durably.
    const message = client.frames('assistant/message')[0]!
    expect(((message.event.data.message as { content: { text?: string }[] }).content[0] as { text: string }).text).toBe('the durable answer')
    for (const required of ['turn/start', 'user/message', 'turn/end']) {
      expect(client.frames(required).length).toBeGreaterThan(0)
    }
    // And the client can still read the whole session back.
    const attached = await client.result<AttachResult>('session/attach', { sessionId })
    expect(attached.page.events.some((event) => event.type === 'assistant/message')).toBe(true)
  })

  it('closes a client too far behind to be served, rather than buffering for it forever', async () => {
    const { port } = await startWebHost(new ScriptedAdapter().script(assistantText('delivered to the healthy client')), { hardLimitBytes: -1 })
    const healthy = await connect(port)
    // A watcher on a carrier whose ceiling it is already past. It asks nothing,
    // so the first notification is what finds it.
    const behind = await connect(port, '/slow')

    const { sessionId } = await healthy.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    const closed = await behind.waitFor(() => behind.closes[0], 'the slow socket to be closed')
    expect(closed.code).toBe(1013)
    expect(closed.reason).toBe('slow-client')

    // Dropping one client is not dropping the session: the healthy one finishes.
    await healthy.waitFor(() => healthy.frames('turn/end')[0], 'the turn to end')
    const attached = await healthy.result<AttachResult>('session/attach', { sessionId })
    expect(attached.page.events.some((event) => event.type === 'assistant/message')).toBe(true)
  })

  it('pings every beat, and a peer that answers is never closed for it', async () => {
    // A peer that has not answered one ping by the next beat is closed 1013,
    // so surviving SEVERAL beats is the assertion — on a clock the test steps
    // (`steppedHeartbeat`). A raw peer counts the pings, so this cannot pass
    // on a host that never sends one (the default beat is 30 s); Node's own
    // client stands beside it because it answers pings by itself, as a
    // browser does.
    steppedHeartbeat()
    const { port } = await startWebHost(new ScriptedAdapter(), { heartbeatMs: BEAT_MS })
    const client = await connect(port)
    const peer = await RawPeer.open(port)
    const beats = 4
    for (let beat = 1; beat <= beats; beat++) {
      vi.advanceTimersByTime(BEAT_MS)
      await eventually(() => (peer.count(OP.ping) === beat ? true : undefined), `ping ${beat} of ${beats} (the host has sent ${peer.count(OP.ping)})`)
      // The raw peer answers by hand and then asks something: frames are
      // handled in order, so the reply proves its pong was read first.
      peer.send(clientFrame(OP.pong, Buffer.alloc(0)))
      peer.sendJson({ jsonrpc: '2.0', id: beat, method: 'initialize' })
      await eventually(() => peer.messages().find((message) => message.id === beat), `the raw peer's reply after pong ${beat}`)
      // Node's client read the ping ahead of the first reply, and wrote its
      // pong before this test could send the second request: the second reply
      // proves that pong was read as well.
      await client.result('initialize')
      await client.result('initialize')
    }
    expect(peer.count(OP.ping), 'pings the host sent').toBe(beats)
    expect(peer.closed(), 'the heartbeat closed a raw peer that answered every ping').toBeUndefined()
    expect(client.closes, 'the heartbeat closed a socket that was answering its pings').toEqual([])
    expect((await client.result<{ serverInfo: { name: string } }>('initialize')).serverInfo.name).toBe('minidsh')
  })
})

/**
 * The socket-level paths Node's own client never takes: it does not fragment,
 * always masks, sends text, and answers every ping. A browser may fragment a
 * large prompt, and anything at all may open a socket.
 */
describe('the websocket carrier: frames only a hand-written peer sends', () => {
  it('reassembles a message sent in fragments, answering a ping that arrives between them', async () => {
    const carrier = await bareCarrier()
    const peer = await RawPeer.open(carrier.port)
    const request = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { text: 'three fragments make one message' } }
    const bytes = Buffer.from(JSON.stringify(request), 'utf8')
    const first = Math.floor(bytes.length / 3)
    const second = Math.floor((2 * bytes.length) / 3)
    peer.send(
      clientFrame(OP.text, bytes.subarray(0, first), { fin: false }),
      clientFrame(OP.ping, Buffer.from('between')),
      clientFrame(OP.continuation, bytes.subarray(first, second), { fin: false }),
      clientFrame(OP.continuation, bytes.subarray(second)),
    )
    // A whole message behind it: frames are handled in order, so once this one
    // is in, the fragmented one has been handed over or reported.
    const after = { jsonrpc: '2.0', id: 2, method: 'initialize' }
    peer.sendJson(after)
    await eventually(
      () => (carrier.messages.length + carrier.malformed.length >= 2 ? true : undefined),
      `both messages (handed over: ${JSON.stringify(carrier.messages)}; malformed: ${JSON.stringify(carrier.malformed)})`,
    )
    expect(carrier.malformed, 'a fragmented message arrived as something that is not JSON').toEqual([])
    expect(carrier.messages).toEqual([request, after])
    await eventually(() => (peer.count(OP.pong) > 0 ? true : undefined), 'the pong for the ping between fragments')
    expect(peer.frames.filter((frame) => frame.opcode === OP.pong).map((frame) => frame.payload.toString('utf8'))).toEqual(['between'])
    expect(peer.closed()).toBeUndefined()
  })

  it.each([
    ['an unmasked client frame', (): Buffer => clientFrame(OP.text, Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}'), { masked: false }), { code: 1002, reason: 'client frames must be masked' }],
    ['a binary frame', (): Buffer => clientFrame(OP.binary, Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}')), { code: 1003, reason: 'text frames only' }],
  ])('closes on %s and hands nothing over', async (_what, bytes, expected) => {
    const carrier = await bareCarrier()
    const peer = await RawPeer.open(carrier.port)
    peer.send(bytes())
    expect(await eventually(() => peer.closed(), `the close frame (handed over instead: ${JSON.stringify(carrier.messages)})`)).toEqual(expected)
    expect(carrier.messages).toEqual([])
    expect(carrier.closes).toBe(1)
  })

  it('bounds a MESSAGE, not a frame: fragments that add up past the ceiling close 1009', async () => {
    const carrier = await bareCarrier({ maxMessageBytes: 64 })
    const peer = await RawPeer.open(carrier.port)
    // Each frame is under the ceiling; the message they are building is not.
    const part = Buffer.alloc(40, 0x61)
    peer.send(clientFrame(OP.text, part, { fin: false }), clientFrame(OP.continuation, part, { fin: false }))
    expect(await eventually(() => peer.closed(), 'the close for a message past the ceiling')).toEqual({ code: 1009, reason: 'message too large' })
    expect(carrier.messages).toEqual([])
  })

  it('closes a peer 1013 when a ping is still unanswered at the next beat', async () => {
    steppedHeartbeat()
    const carrier = await bareCarrier({ heartbeatMs: BEAT_MS })
    const peer = await RawPeer.open(carrier.port)
    vi.advanceTimersByTime(BEAT_MS)
    await eventually(() => (peer.count(OP.ping) === 1 ? true : undefined), 'the first ping')
    expect(peer.closed(), 'closed before the peer had a beat to answer in').toBeUndefined()
    // This peer answers nothing. One more beat is the whole allowance.
    vi.advanceTimersByTime(BEAT_MS)
    expect(await eventually(() => peer.closed(), 'the close for a ping nobody answered')).toEqual({ code: 1013, reason: 'no pong' })
    expect(peer.count(OP.ping), 'pings sent before the host gave up').toBe(1)
    expect(carrier.closes).toBe(1)
  })
})

/**
 * A refused upgrade is the one answer ANYONE can get out of this carrier, with
 * no credential at all, so it must cost the host nothing: not the process (an
 * `error` with no listener is an uncaught exception) and not a socket.
 */
describe('the websocket carrier: an upgrade it will not take', () => {
  const KEY = randomBytes(16).toString('base64')

  it.each([
    ['a handshake with no key', {}, (port: number): string => upgradeRequest(port, '/ws', undefined), 400],
    ['an upgrade the trust fence turns down', { authorize: (): number => 403 }, (port: number): string => upgradeRequest(port, '/ws', KEY), 403],
    ['an upgrade the trust fence does not know', { authorize: (): number => 401 }, (port: number): string => upgradeRequest(port, '/ws', KEY), 401],
  ])('survives its peer resetting the connection after %s', async (_what, options, request, status) => {
    const carrier = await bareCarrier(options)
    const uncaught = await collectingUncaught(async () => {
      const socket = rawSocket(carrier.port)
      const answer = new Promise<string>((resolve) =>
        socket.once('data', (chunk: Buffer) => {
          // Reset, not closed: the host's end then fails instead of ending.
          socket.resetAndDestroy()
          resolve(chunk.toString('latin1'))
        }),
      )
      socket.write(request(carrier.port))
      expect(await answer).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `))
      // The reset reaches the host as an error on ITS end; once that end is
      // destroyed, whatever it was going to throw at the process is thrown.
      await eventually(() => (carrier.accepted[0]?.destroyed === true ? true : undefined), "the host's end of the refused socket to be gone")
    })
    expect(uncaught, 'errors nobody was listening for').toEqual([])
    expect(carrier.connections, 'a refused upgrade became a connection').toHaveLength(0)
  })

  it('lets go of a socket it refused even when the peer keeps its own half open', async () => {
    const carrier = await bareCarrier({ authorize: () => 401 })
    // A peer that never closes: `end()` alone would leave the host's end open
    // for as long as this one cared to hold it, and the server's close() with it.
    const socket = rawSocket(carrier.port, { allowHalfOpen: true })
    const answer = new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1'))))
    socket.write(upgradeRequest(carrier.port, '/ws', KEY))
    expect(await answer).toMatch(/^HTTP\/1\.1 401 /)
    await eventually(() => (carrier.accepted[0]?.destroyed === true ? true : undefined), "the host's end of the refused socket to be destroyed")
    expect(socket.destroyed, 'this peer must still be holding its half for the test to mean anything').toBe(false)
  })

  it('cannot be ended by a socket it merely left for another carrier', async () => {
    const carrier = await bareCarrier()
    let seen!: () => void
    const upgraded = new Promise<void>((resolve) => (seen = resolve))
    // Nobody claims this path, and this server has no app to answer what
    // nobody claimed: the socket just sits there, which is when a reset used
    // to find it with no listener.
    carrier.server.on('upgrade', () => seen())
    const uncaught = await collectingUncaught(async () => {
      const socket = rawSocket(carrier.port)
      socket.write(upgradeRequest(carrier.port, '/elsewhere', KEY))
      await upgraded
      socket.resetAndDestroy()
      await eventually(() => (carrier.accepted[0]?.destroyed === true ? true : undefined), "the host's end of the reset socket to be gone")
    })
    expect(uncaught, 'errors nobody was listening for').toEqual([])
  })
})

describe('the websocket frame codec', () => {
  const mask = (payload: Buffer): Buffer => {
    const key = Buffer.from([0x01, 0x02, 0x03, 0x04])
    const masked = Buffer.from(payload)
    for (let index = 0; index < masked.length; index++) masked[index] = masked[index]! ^ key[index % 4]!
    let head: Buffer
    if (masked.length < 126) {
      head = Buffer.alloc(2)
      head[1] = 0x80 | masked.length
    } else {
      head = Buffer.alloc(4)
      head[1] = 0x80 | 126
      head.writeUInt16BE(masked.length, 2)
    }
    head[0] = 0x80 | 0x1
    return Buffer.concat([head, key, masked])
  }

  it('decodes a masked client frame, which every browser sends', () => {
    const { frames, rest } = decodeFrames(mask(Buffer.from('{"jsonrpc":"2.0"}', 'utf8')), 1024)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.payload.toString('utf8')).toBe('{"jsonrpc":"2.0"}')
    expect(rest).toHaveLength(0)
  })

  it('keeps a partial frame for the next chunk instead of guessing at it', () => {
    const whole = mask(Buffer.from('a'.repeat(300), 'utf8'))
    const { frames, rest } = decodeFrames(whole.subarray(0, 40), 1024)
    expect(frames).toHaveLength(0)
    expect(rest).toHaveLength(40)
    const { frames: complete } = decodeFrames(whole, 1024)
    expect(complete[0]!.payload.toString('utf8')).toHaveLength(300)
  })

  it('refuses a frame larger than the ceiling instead of allocating it', () => {
    const head = Buffer.alloc(10)
    head[0] = 0x81
    head[1] = 127
    head.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2)
    const { error } = decodeFrames(head, 1024)
    expect(error).toBe(1009)
  })

  it('reports whether a client frame was masked, because a server must refuse one that is not', () => {
    const unmasked = encodeTextFrame('pretending to be a server')
    const { frames } = decodeFrames(unmasked, 1024)
    expect(frames[0]!.masked).toBe(false)
    const { frames: proper } = decodeFrames(mask(Buffer.from('a real client', 'utf8')), 1024)
    expect(proper[0]!.masked).toBe(true)
  })

  it('encodes each length form the way the wire expects', () => {
    expect(encodeTextFrame('hi')[1]).toBe(2)
    expect(encodeTextFrame('x'.repeat(200))[1]).toBe(126)
    expect(encodeTextFrame('x'.repeat(70_000))[1]).toBe(127)
    // Round-trips through the decoder, mask-free as a server frame is.
    const { frames } = decodeFrames(encodeTextFrame('round trip'), 1024)
    expect(frames[0]!.payload.toString('utf8')).toBe('round trip')
  })
})

describe('the websocket frame codec: what RFC 6455 says a server must refuse', () => {
  const frame = clientFrame

  it('fails the connection on a reserved bit, rather than guessing what the peer meant', () => {
    // No extension is ever negotiated here, so RSV1..3 must be zero (§5.2).
    const { frames, error } = decodeFrames(frame(0x1, Buffer.from('{}'), { rsv: 4 }), 1024)
    expect(error).toBe(1002)
    expect(frames).toHaveLength(0)
  })

  it('refuses a fragmented control frame, which §5.5 forbids outright', () => {
    const { error } = decodeFrames(frame(0x9, Buffer.from('x'), { fin: false }), 1024)
    expect(error).toBe(1002)
  })

  it('refuses a control frame past 125 bytes, which cannot be framed on the way back', () => {
    // The echo path clips its pong, but accepting the frame at all left the
    // decoder reading a stream it and the peer no longer agreed about.
    const { error } = decodeFrames(frame(0x9, Buffer.alloc(200, 0x70)), 4096)
    expect(error).toBe(1002)
  })

  it('still decodes the shapes a browser actually sends', () => {
    const whole = Buffer.concat([frame(0x1, Buffer.from('{"a":1'), { fin: false }), frame(0x9, Buffer.from('p')), frame(0x0, Buffer.from('}'))])
    const { frames, error } = decodeFrames(whole, 4096)
    expect(error).toBeUndefined()
    expect(frames.map((one) => one.opcode)).toEqual([0x1, 0x9, 0x0])
    expect(frames[0]!.fin).toBe(false)
  })
})
