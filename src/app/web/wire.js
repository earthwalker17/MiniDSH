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
/** Events per repair round trip; a hole is fetched in pages like everything else. */
const REPAIR_LIMIT = 500

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
 *
 * It reports WHAT changed, not merely that something did. The transcript is the
 * seq-ordered log, and an append-only log admits exactly four shapes: a fresh
 * page replaces the window, a live event or a repaired range extends it at the
 * tail, a backward page extends it at the head, and a view push touches no row
 * at all. A renderer told which of those happened can keep the DOM it already
 * built; one told only "something changed" has to rebuild to be correct.
 *
 * `onChange` receives `{kind: 'reset'}` | `{kind: 'append', events}` |
 * `{kind: 'prepend', events}` | `{kind: 'view'}`.
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
    /** The stored log is a readable prefix, not the whole session. */
    this.damaged = false
    /** No page yet: an event applied before one would repair from seq 0. */
    this.attached = false
    // Live events are applied one at a time. `apply` awaits a repair, and two
    // events arriving around that await would otherwise interleave: the second
    // would see the pre-repair cursor, push itself past the hole, and the
    // repaired range would then be dropped as already-seen.
    this.queue = Promise.resolve()
  }

  /**
   * Attach (or re-attach): a fresh page and a fresh cursor replace whatever was
   * held. Queued behind `apply`, and applying the result of the attach queued
   * behind it too — an event that arrives while the attach RPC is in flight
   * would otherwise be applied against the PRE-attach cursor, and its repair
   * would land after the page that already contained it.
   */
  attach() {
    const attached = this.queue.then(
      () => this.attachOnce(),
      () => this.attachOnce(),
    )
    this.queue = attached.then(
      () => undefined,
      () => undefined,
    )
    return attached
  }

  async attachOnce() {
    const attached = await this.wire.request('session/attach', { sessionId: this.sessionId })
    if (attached.cursor < this.cursor) throw new Error('the host answered with a cursor behind what was already applied')
    this.header = attached.header
    this.view = attached.view
    this.events = attached.page.events.slice()
    this.cursor = attached.cursor
    this.oldest = attached.page.from
    this.hasMore = attached.page.hasMore
    // The store holds bytes past what it could read: this transcript is a
    // readable prefix, not the session. Saying nothing renders a truncated log
    // as if it were whole.
    this.damaged = attached.damaged === true
    this.attached = true
    this.onChange({ kind: 'reset' })
    return attached
  }

  /** One page further back, anchored to the cut this window attached on. */
  async older() {
    if (!this.hasMore) return
    const { page } = await this.wire.request('session/page', { sessionId: this.sessionId, throughSeq: this.cursor, beforeSeq: this.oldest })
    this.events = [...page.events, ...this.events]
    this.oldest = page.from
    this.hasMore = page.hasMore
    this.onChange({ kind: 'prepend', events: page.events })
  }

  setView(view) {
    this.view = view
    this.onChange({ kind: 'view' })
  }

  /**
   * A live event this window does NOT store but has seen — the trace tier,
   * which is streamed straight into the transcript and never kept.
   *
   * The cursor must still advance across it. Without this, every run of chunks
   * read as a hole: each assistant message arrived at `cursor + 41` and spent a
   * `session/events` round trip discovering that the range between held nothing
   * a page carries. The repair machinery ran constantly, so a REAL drop — which
   * is what a carrier under pressure does to exactly this tier — was
   * indistinguishable from an ordinary turn.
   */
  noted(event) {
    // On the SAME queue as `apply`, because it moves the same cursor. Advancing
    // it synchronously raced a repair that was already parked on an await: a
    // chunk arriving during the round trip pushed the cursor past the very
    // surface event that had revealed the hole, and `applyOne` then dropped it
    // as already-seen. A surface event the carrier is forbidden to drop, lost
    // by the client instead — on exactly the path this method exists for.
    const advance = () => {
      if (this.attached && event.seq > this.cursor) this.cursor = event.seq
    }
    this.queue = this.queue.then(advance, advance)
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
    // Before the first page there is nothing to apply INTO, and a repair from
    // cursor -1 would ask for the whole log — the one thing paging exists to
    // avoid. The attach that follows carries this event anyway.
    if (!this.attached) return
    if (event.seq <= this.cursor) return
    if (event.seq > this.cursor + 1) await this.repair(event.seq - 1)
    if (event.seq <= this.cursor) return
    this.events.push(event)
    this.cursor = event.seq
    this.onChange({ kind: 'append', events: [event] })
  }

  /**
   * Fetch a hole, bounded at BOTH ends and in pages. A repair is a range read,
   * not a whole-log read: asking for everything from the cursor would undo the
   * paging the rest of this client is built on.
   */
  async repair(throughSeq) {
    while (this.cursor < throughSeq) {
      const { events } = await this.wire.request('session/events', {
        sessionId: this.sessionId,
        fromSeq: this.cursor + 1,
        toSeq: throughSeq,
        limit: REPAIR_LIMIT,
        omitTrace: true,
      })
      if (events.length === 0) break
      const applied = []
      for (const event of events) {
        if (event.seq <= this.cursor) continue
        this.events.push(event)
        this.cursor = event.seq
        applied.push(event)
      }
      // A repaired range is an APPEND like any other: it lands above everything
      // already rendered, in seq order, beneath the cursor that revealed it.
      this.onChange({ kind: 'append', events: applied })
    }
  }
}
