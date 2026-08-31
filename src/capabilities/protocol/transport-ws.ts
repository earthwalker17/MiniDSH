/**
 * A WebSocket carrier for the same JSON-RPC frames the stream carrier speaks.
 * One text message per frame — no newline framing, because the protocol does
 * it — and one connection per socket.
 *
 * The codec is written here rather than taken as a dependency: Node ships a
 * WebSocket CLIENT but no server, and the server half a JSON-RPC wire needs is
 * a handshake plus a frame codec. That also means the tests drive a real socket
 * with Node's own client, and a browser is the same client.
 *
 * BACKPRESSURE IS TIER-AWARE, and that is the one place this carrier is not a
 * neutral pipe. `session/event` is a synchronous, contained emit, so a listener
 * cannot suspend the loop the way a pull-based pump could: the only choices are
 * an unbounded buffer or a drop policy. So the trace tier — recorded for
 * streaming fidelity, never folded by anything — is dropped when a peer falls
 * behind, and the client reconstructs the same text from `assistant/message`.
 * Facts and surface events are never dropped: past a hard ceiling the socket is
 * closed instead, and the client reattaches and gets a fresh page.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { ClientConnection } from './connection.ts'
import type { RpcNotification, RpcResponse } from './frames.ts'

/** RFC 6455's fixed handshake GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Close codes this carrier sends. 1009 and 1003 are RFC; 1013 is "try again later". */
const CLOSE_UNSUPPORTED_DATA = 1003
const CLOSE_TOO_LARGE = 1009
const CLOSE_SLOW_CLIENT = 1013

export interface WebSocketCarrierOptions {
  /** The HTTP server whose upgrades this carrier answers. The app owns the server and its routes. */
  readonly server: Server
  /** Path to accept upgrades on (default `/ws`). Anything else is left to other listeners. */
  readonly path?: string
  /**
   * The trust fence, supplied by the app: origin, host, and whatever
   * credential it minted. Returning a number rejects the upgrade with that
   * status. Mechanism lives here; policy does not.
   */
  readonly authorize?: (request: IncomingMessage) => true | number
  /** Whether a client here may end the whole host (default false: a tab is not a process). */
  readonly allowShutdown?: boolean
  /** Bytes queued on the socket past which the trace tier is dropped (default 1 MiB). */
  readonly softLimitBytes?: number
  /** Bytes queued past which the connection is closed as too slow (default 8 MiB). */
  readonly hardLimitBytes?: number
  /** Largest inbound message accepted (default 8 MiB). */
  readonly maxMessageBytes?: number
  /** Heartbeat period; a peer that misses two is gone (default 30s). */
  readonly heartbeatMs?: number
  readonly onConnection: (connection: ClientConnection, socket: WebSocketPeer) => void
  readonly onClose: (connection: ClientConnection) => void
  readonly onMessage: (connection: ClientConnection, frame: unknown) => void
  readonly onMalformed?: (detail: string) => void
}

/** What the carrier hands back per socket, so a caller can close one deliberately. */
export interface WebSocketPeer {
  close(code?: number, reason?: string): void
}

export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
}

/** One text frame, unfragmented (a server never needs to fragment a JSON document). */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let head: Buffer
  if (length < 126) {
    head = Buffer.alloc(2)
    head[1] = length
  } else if (length < 65_536) {
    head = Buffer.alloc(4)
    head[1] = 126
    head.writeUInt16BE(length, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  head[0] = 0x80 | OP_TEXT // FIN + text
  return Buffer.concat([head, payload])
}

function encodeControlFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(2)
  head[0] = 0x80 | opcode
  head[1] = payload.length
  return Buffer.concat([head, payload])
}

interface DecodedFrame {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Buffer
}

/** Decodes whole frames from a buffer, returning the undecoded remainder. */
export function decodeFrames(buffer: Buffer, maxPayload: number): { frames: DecodedFrame[]; rest: Buffer; error?: number } {
  const frames: DecodedFrame[] = []
  let at = 0
  while (at + 2 <= buffer.length) {
    const first = buffer[at]!
    const second = buffer[at + 1]!
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = at + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      const big = buffer.readBigUInt64BE(cursor)
      if (big > BigInt(maxPayload)) return { frames, rest: buffer.subarray(at), error: CLOSE_TOO_LARGE }
      length = Number(big)
      cursor += 8
    }
    if (length > maxPayload) return { frames, rest: buffer.subarray(at), error: CLOSE_TOO_LARGE }
    let mask: Buffer | undefined
    if (masked) {
      if (cursor + 4 > buffer.length) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!
    frames.push({ fin, opcode, payload })
    at = cursor + length
  }
  return { frames, rest: buffer.subarray(at) }
}

/**
 * Answers upgrades on `path` and turns each socket into a `ClientConnection`.
 * Returns a disposer that closes every peer and stops listening.
 */
export function serveWebSocket(options: WebSocketCarrierOptions): () => void {
  const path = options.path ?? '/ws'
  const softLimit = options.softLimitBytes ?? 1024 * 1024
  const hardLimit = options.hardLimitBytes ?? 8 * 1024 * 1024
  const maxMessage = options.maxMessageBytes ?? 8 * 1024 * 1024
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const peers = new Set<{ close: (code?: number, reason?: string) => void; beat: () => void }>()

  const onUpgrade = (request: IncomingMessage, socket: Duplex): void => {
    const requestPath = (request.url ?? '/').split('?', 1)[0]
    if (requestPath !== path) return
    const key = request.headers['sec-websocket-key']
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const verdict = options.authorize?.(request) ?? true
    if (verdict !== true) {
      // Answered by hand rather than handed to the socket layer: a rejected
      // upgrade must never become a half-open WebSocket.
      socket.end(`HTTP/1.1 ${verdict} ${verdict === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`)
      return
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`)

    let buffered: Buffer = Buffer.alloc(0)
    let fragments: Buffer[] = []
    let fragmentOpcode = OP_CONTINUATION
    let awaitingPong = false
    let closed = false

    const close = (code = 1000, reason = ''): void => {
      if (closed) return
      closed = true
      try {
        socket.write(encodeControlFrame(OP_CLOSE, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, 'utf8')])))
      } catch {
        // The peer is already gone; the end below is what matters.
      }
      socket.end()
      peers.delete(peer)
      options.onClose(connection)
    }

    const send = (frame: RpcResponse | RpcNotification, droppable: boolean): void => {
      if (closed) return
      const queued = socket.writableLength
      // Over the soft limit the trace tier is the give: it is streaming
      // fidelity, and `assistant/message` carries the same text durably.
      if (droppable && queued > softLimit) return
      if (queued > hardLimit) {
        close(CLOSE_SLOW_CLIENT, 'slow-client')
        return
      }
      socket.write(encodeTextFrame(JSON.stringify(frame)))
    }

    const peer = { close, beat: () => undefined as void }
    const connection = new ClientConnection({ send, allowShutdown: options.allowShutdown ?? false })

    peer.beat = (): void => {
      if (closed) return
      if (awaitingPong) {
        close(CLOSE_SLOW_CLIENT, 'no pong')
        return
      }
      awaitingPong = true
      socket.write(encodeControlFrame(OP_PING))
    }
    peers.add(peer)
    options.onConnection(connection, peer)

    socket.on('data', (chunk: Buffer) => {
      if (closed) return
      buffered = Buffer.concat([buffered, chunk])
      const { frames, rest, error } = decodeFrames(buffered, maxMessage)
      buffered = rest
      if (error !== undefined) {
        close(error, 'frame too large')
        return
      }
      for (const frame of frames) {
        if (frame.opcode === OP_CLOSE) {
          close(1000, '')
          return
        }
        if (frame.opcode === OP_PING) {
          socket.write(encodeControlFrame(OP_PONG, frame.payload))
          continue
        }
        if (frame.opcode === OP_PONG) {
          awaitingPong = false
          continue
        }
        if (frame.opcode === OP_BINARY) {
          close(CLOSE_UNSUPPORTED_DATA, 'text frames only')
          return
        }
        if (frame.opcode === OP_TEXT || frame.opcode === OP_CONTINUATION) {
          if (frame.opcode === OP_TEXT) {
            fragments = [frame.payload]
            fragmentOpcode = OP_TEXT
          } else {
            fragments.push(frame.payload)
          }
          if (!frame.fin) continue
          const text = Buffer.concat(fragments).toString('utf8')
          fragments = []
          if (fragmentOpcode !== OP_TEXT) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            options.onMalformed?.(text.slice(0, 120))
            continue
          }
          options.onMessage(connection, parsed)
        }
      }
    })
    socket.on('close', () => {
      if (closed) return
      closed = true
      peers.delete(peer)
      options.onClose(connection)
    })
    socket.on('error', () => close(1011, 'socket error'))
  }

  options.server.on('upgrade', onUpgrade)
  const heartbeat = setInterval(() => {
    for (const one of peers) one.beat()
  }, heartbeatMs)
  heartbeat.unref()

  return () => {
    options.server.off('upgrade', onUpgrade)
    clearInterval(heartbeat)
    // A copy on purpose: closing removes the peer from the set being walked.
    for (const one of Array.from(peers)) one.close(1001, 'going away')
  }
}
