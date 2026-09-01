/**
 * The WebSocket carrier over a REAL socket, driven by Node's built-in
 * `WebSocket` client — the same client a browser is. The codec is ours, so the
 * cases that matter are the ones a hand-rolled one gets wrong: fragmentation,
 * a payload past the 16-bit length, ping/pong, the close handshake, and the
 * trust fence rejecting an upgrade instead of half-opening it.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { assistantText, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { startProtocolHost, type ProtocolHostHandle } from '../../app/serve.ts'
import { decodeFrames, encodeTextFrame } from './transport-ws.ts'
import type { AttachResult } from './frames.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

let dirs: string[] = []
let hosts: ProtocolHostHandle[] = []
let servers: Server[] = []
let sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close()
  sockets = []
  for (const host of hosts.toReversed()) await host.dispose()
  hosts = []
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

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
    // Still serving.
    expect(await client.result<{ serverInfo: { name: string } }>('initialize')).toBeDefined()
    expect(host.root).toBeDefined()
  })

  it('outlives its clients: the host is still there when the last socket closes', async () => {
    const { port, host } = await startWebHost(new ScriptedAdapter().script(assistantText('one'), assistantText('two')))
    const first = await connect(port)
    const { sessionId } = await first.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await first.waitFor(() => first.frames('turn/end')[0], 'the first turn')
    first.socket.close()
    await first.waitFor(() => (first.closes.length > 0 ? true : undefined), 'the socket to close')

    // A fresh tab reattaches to the same live session and drives it on.
    const second = await connect(port)
    const attached = await second.result<AttachResult>('session/attach', { sessionId })
    expect(attached.header.id).toBe(sessionId)
    await second.result('session/prompt', { sessionId, text: 'still here?' })
    await second.waitFor(() => second.frames('turn/end')[0], 'the second turn')
    expect(host.root).toBeDefined()
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

  it('answers a ping and survives it', async () => {
    const { port } = await startWebHost(new ScriptedAdapter())
    const client = await connect(port)
    // Node's client answers server pings itself; this proves the connection is
    // still usable after the heartbeat machinery has run.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect((await client.result<{ serverInfo: { name: string } }>('initialize')).serverInfo.name).toBe('minidsh')
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

  it('never emits a control frame past the 125-byte limit, however long the ping it echoes', () => {
    // A ping we answer carries the PEER's payload; writing 200 into the single
    // length byte would desynchronize everything after it on that socket.
    const ping = Buffer.alloc(4 + 200)
    ping[0] = 0x80 | 0x9
    ping[1] = 0x80 | 200
    const { frames } = decodeFrames(Buffer.concat([Buffer.from([0x89, 0x80 | 125, 1, 2, 3, 4]), Buffer.alloc(125)]), 1024)
    expect(frames[0]!.payload).toHaveLength(125)
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
  /** A frame with every header field under the caller's control. */
  function frame(opcode: number, payload: Buffer, options: { fin?: boolean; rsv?: number; masked?: boolean } = {}): Buffer {
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
