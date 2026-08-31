/**
 * The protocol client, over a WebSocket. Plain ES modules: MiniDSH has no build
 * step, so there is no TypeScript and no bundler in the browser.
 *
 * It owns three things the host cannot do for it — reconnecting, correlating
 * replies, and keeping one session's event stream gap-free:
 *
 * - Reconnect REPLACES the window. There is no lower-bound cursor in the
 *   protocol on purpose, so a reconnecting client re-attaches, gets a fresh
 *   page and a fresh cursor, and throws away what it held. The only guard is
 *   that the new cursor may not be behind what was already applied.
 * - A duplicate is dropped, a HOLE is repaired. An event at or below the cursor
 *   is already rendered; one past `cursor + 1` means a frame was dropped (a
 *   carrier under pressure drops the trace tier), so the missing range is
 *   fetched bounded at BOTH ends and applied before the event that revealed it.
 */

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000

export class Wire {
  constructor(url, handlers) {
    this.url = url
    this.handlers = handlers
    this.socket = undefined
    this.nextId = 1
    this.pending = new Map()
    this.attempt = 0
    this.closedByUs = false
    this.connect()
  }

  connect() {
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('open', () => {
      this.attempt = 0
      this.handlers.onOpen?.()
    })
    this.socket.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (typeof frame.method === 'string') {
        this.handlers.onNotification?.(frame.method, frame.params)
        return
      }
      const settle = this.pending.get(frame.id)
      if (!settle) return
      this.pending.delete(frame.id)
      settle(frame)
    })
    this.socket.addEventListener('close', (event) => {
      for (const settle of this.pending.values()) settle({ error: { message: 'the connection closed' } })
      this.pending.clear()
      this.handlers.onClose?.(event)
      if (this.closedByUs) return
      // Jittered exponential backoff, capped: a host that is restarting should
      // not be hammered, and a tab left open overnight should still recover.
      const cap = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt++, BACKOFF_MAX_MS)
      setTimeout(() => this.connect(), cap / 2 + Math.random() * (cap / 2))
    })
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, (frame) => (frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result)))
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    })
  }

  close() {
    this.closedByUs = true
    this.socket?.close()
  }
}

/**
 * One session's window: a page of history, a cursor, and the live tail applied
 * on top of it. Everything about ordering and gaps lives here so the view can
 * be a pure function of `events`.
 */
export class SessionWindow {
  constructor(wire, sessionId, onChange) {
    this.wire = wire
    this.sessionId = sessionId
    this.onChange = onChange
    this.events = []
    this.cursor = -1
    this.oldest = 0
    this.hasMore = false
    this.header = undefined
    this.view = undefined
    // Live events are applied one at a time. `apply` awaits a repair, and two
    // events arriving around that await would otherwise interleave: the second
    // would see the pre-repair cursor, push itself past the hole, and the
    // repaired range would then be dropped as already-seen.
    this.queue = Promise.resolve()
  }

  /** Attach (or re-attach): a fresh page and a fresh cursor replace whatever was held. */
  async attach() {
    const attached = await this.wire.request('session/attach', { sessionId: this.sessionId })
    if (attached.cursor < this.cursor) throw new Error('the host answered with a cursor behind what was already applied')
    this.header = attached.header
    this.view = attached.view
    this.events = attached.page.events.slice()
    this.cursor = attached.cursor
    this.oldest = attached.page.from
    this.hasMore = attached.page.hasMore
    this.onChange()
    return attached
  }

  /** One page further back, anchored to the cut this window attached on. */
  async older() {
    if (!this.hasMore) return
    const { page } = await this.wire.request('session/page', { sessionId: this.sessionId, throughSeq: this.cursor, beforeSeq: this.oldest })
    this.events = [...page.events, ...this.events]
    this.oldest = page.from
    this.hasMore = page.hasMore
    this.onChange()
  }

  setView(view) {
    this.view = view
    this.onChange()
  }

  /** A live event, applied in arrival order. Already-seen is dropped; a hole is repaired first. */
  apply(event) {
    // Serialized, and a failure never blocks the next event.
    this.queue = this.queue.then(
      () => this.applyOne(event),
      () => this.applyOne(event),
    )
    return this.queue
  }

  async applyOne(event) {
    if (event.seq <= this.cursor) return
    if (event.seq > this.cursor + 1) await this.repair(event.seq - 1)
    if (event.seq <= this.cursor) return
    this.events.push(event)
    this.cursor = event.seq
    this.onChange()
  }

  async repair(throughSeq) {
    const { events } = await this.wire.request('session/events', {
      sessionId: this.sessionId,
      fromSeq: this.cursor + 1,
      toSeq: throughSeq,
      omitTrace: true,
    })
    for (const event of events) {
      if (event.seq <= this.cursor) continue
      this.events.push(event)
      this.cursor = event.seq
    }
    this.onChange()
  }
}
