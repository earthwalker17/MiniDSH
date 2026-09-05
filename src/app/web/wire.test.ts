/**
 * The browser client's window rules, which are the only place in the system
 * where dedup, hole repair and re-attach are decided — and which had no test
 * until S7.5, because `wire.js` is plain JS with no build step. `allowJs` in
 * `tsconfig.json` is what lets a test import it; nothing else needs it.
 *
 * `SessionWindow` takes its wire by injection, so this exercises the real
 * module against a scripted host, not a re-implementation of it.
 */
import { describe, expect, it } from 'vitest'
import { SessionWindow } from './wire.js'

interface Frame {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: { op: 'append' }
  sourceEventSeqs?: number[]
}

/** A host whose log is fixed, answering the two reads a window makes. */
function scriptedWire(log: Frame[], cursor = log.length - 1) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  return {
    calls,
    request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      if (method === 'session/attach') {
        return Promise.resolve({
          header: { id: 's' },
          view: { status: 'idle', pendingApprovals: [], authority: {} },
          page: { events: [], from: 0, to: -1, hasMore: false },
          cursor,
        })
      }
      if (method === 'session/events') {
        const { fromSeq, toSeq, limit, omitTrace } = params as { fromSeq: number; toSeq: number; limit: number; omitTrace: boolean }
        let out = log.filter((one) => one.seq >= fromSeq && one.seq <= toSeq)
        if (omitTrace) out = out.filter((one) => one.type !== 'assistant/chunk')
        return Promise.resolve({ header: {}, events: out.slice(0, limit) })
      }
      throw new Error(`unexpected ${method}`)
    },
  }
}

/** One step: a prompt, a header, a run of chunks, the message, a call and its result. */
function step(from: number, chunks: number): Frame[] {
  let seq = from
  const at = (type: string, extra: Partial<Frame> = {}): Frame => ({ type, seq: seq++, time: 0, data: {}, ...extra })
  const events = [at('step/start'), at('user/message', { surfaceOp: { op: 'append' } }), at('request/header')]
  for (let i = 0; i < chunks; i++) events.push(at('assistant/chunk'))
  events.push(at('assistant/message', { surfaceOp: { op: 'append' } }))
  const call = at('tool/call')
  events.push(call, at('tool/result', { surfaceOp: { op: 'append' }, sourceEventSeqs: [call.seq] }), at('step/end'))
  return events
}

describe('the browser session window', () => {
  it('counts the trace tier it does not store, so an ordinary turn is not a hole', async () => {
    const log = step(0, 40)
    const wire = scriptedWire(log, -1)
    const window_ = new SessionWindow(wire, 's', () => {})
    await window_.attach()

    for (const event of log) {
      if (event.type === 'assistant/chunk') window_.noted(event)
      else await window_.apply(event)
    }

    // The chunks were seen and dropped; everything else is held, in order.
    expect(wire.calls.filter((one) => one.method === 'session/events')).toHaveLength(0)
    expect(window_.cursor).toBe(log.at(-1)!.seq)
    expect(window_.events.map((one: Frame) => one.type)).toEqual(log.filter((one) => one.type !== 'assistant/chunk').map((one) => one.type))
  })

  it('counts a trace event that arrives DURING a repair without losing what revealed the hole', async () => {
    // `noted` moves the same cursor `apply` does, so it has to take the same
    // queue. Advancing it synchronously raced a repair already parked on an
    // await: a chunk arriving mid-round-trip pushed the cursor past the very
    // surface event that had revealed the hole, and it was then dropped as
    // already-seen — a surface event lost by the client, on exactly the path
    // this method exists for.
    const log: Frame[] = [
      { type: 'user/message', seq: 0, time: 0, data: {}, surfaceOp: { op: 'append' } },
      { type: 'assistant/chunk', seq: 1, time: 0, data: {} },
      { type: 'assistant/message', seq: 2, time: 0, data: {}, surfaceOp: { op: 'append' } },
      { type: 'assistant/chunk', seq: 3, time: 0, data: {} },
    ]
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const wire = {
      async request(method: string) {
        if (method === 'session/attach') {
          return { header: {}, view: {}, page: { events: [log[0]!], from: 0, to: 0, hasMore: false }, cursor: 0 }
        }
        await held // the hole was trace-only; finding that out costs a round trip
        return { header: {}, events: [] }
      },
    }
    const window_ = new SessionWindow(wire, 's', () => {})
    await window_.attach()

    const applying = window_.apply(log[2]!) // chunk@1 was dropped by the carrier
    await new Promise((resolve) => setTimeout(resolve, 10))
    window_.noted(log[3]!) // arrives while the repair is in flight
    release()
    await applying

    expect(window_.events.map((one: Frame) => one.seq)).toEqual([0, 2])
    expect(window_.cursor).toBe(3)
  })

  it('repairs a real hole, bounded at both ends and without the trace tier', async () => {
    const first = step(0, 3)
    const log = [...first, ...step(first.at(-1)!.seq + 1, 3)]
    const wire = scriptedWire(log, -1)
    const window_ = new SessionWindow(wire, 's', () => {})
    await window_.attach()

    await window_.apply(log[0]!)
    // Everything between is dropped by the carrier; the next event reveals it.
    const last = log.at(-1)!
    await window_.apply(last)

    const repairs = wire.calls.filter((one) => one.method === 'session/events')
    expect(repairs).toHaveLength(1)
    expect(repairs[0]!.params).toMatchObject({ fromSeq: 1, toSeq: last.seq - 1, omitTrace: true })
    expect(window_.cursor).toBe(last.seq)
    // The repair carried the facts and none of the trace tier.
    expect(window_.events.some((one: Frame) => one.type === 'assistant/chunk')).toBe(false)
    expect(window_.events.map((one: Frame) => one.seq)).toEqual(log.filter((one) => one.type !== 'assistant/chunk').map((one) => one.seq))
  })

  it('drops what it already holds, however it arrives', async () => {
    const log = step(0, 2)
    const window_ = new SessionWindow(scriptedWire(log, -1), 's', () => {})
    await window_.attach()
    await window_.apply(log[0]!)
    await window_.apply(log[0]!)
    await window_.apply(log[0]!)
    expect(window_.events).toHaveLength(1)
  })

  it('applies nothing before its first page, because the page carries it', async () => {
    const log = step(0, 2)
    const wire = scriptedWire(log, -1)
    const window_ = new SessionWindow(wire, 's', () => {})
    // No attach yet: a repair from cursor -1 would ask for the whole log, which
    // is the one thing paging exists to avoid.
    await window_.apply(log.at(-1)!)
    expect(wire.calls).toHaveLength(0)
    expect(window_.events).toHaveLength(0)
  })

  it('refuses a re-attach that would move the cursor backwards', async () => {
    const log = step(0, 2)
    const window_ = new SessionWindow(scriptedWire(log, 5), 's', () => {})
    await window_.attach()
    expect(window_.cursor).toBe(5)
    // A host answering with a cursor behind what was already applied would make
    // the window re-render events it had passed.
    const behind = new SessionWindow(scriptedWire(log, 1), 's', () => {})
    behind.cursor = 4
    await expect(behind.attach()).rejects.toThrow(/cursor behind/)
  })

  it('carries the damaged flag, so a readable prefix is not shown as a whole session', async () => {
    const wire = {
      request: () =>
        Promise.resolve({
          header: { id: 's' },
          view: { status: 'idle', pendingApprovals: [], authority: {} },
          page: { events: [], from: 0, to: -1, hasMore: false },
          cursor: -1,
          damaged: true,
        }),
    }
    const window_ = new SessionWindow(wire, 's', () => {})
    await window_.attach()
    expect(window_.damaged).toBe(true)
  })
})

/**
 * WHICH change each mutation reports. The renderer keeps its DOM on the
 * strength of these labels, so a mutation that reported the wrong one — or
 * reported `reset` for everything, as this class used to — would put the
 * transcript back to rebuilding without any test noticing.
 */
describe('what the window says it did', () => {
  function recording(log: Frame[], cursor?: number) {
    const changes: { kind: string; seqs?: number[] }[] = []
    const wire = scriptedWire(log, cursor)
    const window_ = new SessionWindow(wire as never, 's', (change: { kind: string; events?: Frame[] }) =>
      changes.push({ kind: change.kind, ...(change.events === undefined ? {} : { seqs: change.events.map((one) => one.seq) }) }),
    )
    return { changes, window: window_, wire }
  }

  it('calls an attach a reset, a live event an append, and a view push neither', async () => {
    const { changes, window: window_ } = recording([], -1)
    await window_.attach()
    expect(changes).toEqual([{ kind: 'reset' }])

    changes.length = 0
    await window_.apply({ type: 'user/message', seq: 0, time: 0, data: {}, surfaceOp: { op: 'append' } })
    expect(changes).toEqual([{ kind: 'append', seqs: [0] }])

    changes.length = 0
    window_.setView({ status: 'running' })
    // A status push moves the pills. It used to rebuild the whole transcript,
    // which is how a mid-turn update could delete a half-streamed answer.
    expect(changes).toEqual([{ kind: 'view' }])
  })

  it('calls a repaired range one append, and a backward page a prepend', async () => {
    const log = step(0, 3)
    const { changes, window: window_, wire } = recording(log, -1)
    await window_.attach()
    changes.length = 0

    // A hole: the last event of the step arrives while nothing between it and
    // the cursor was ever delivered.
    const last = log.at(-1)!
    await window_.apply(last)
    // One append for the repaired range, then one for the event that revealed
    // it — never a reset, which would have thrown away everything above.
    expect(changes.map((one) => one.kind)).toEqual(['append', 'append'])
    expect(changes.at(-1)!.seqs).toEqual([last.seq])
    // The repair is trace-free, so the run of chunks is not in what it reports.
    expect(changes[0]!.seqs).not.toContain(3)

    changes.length = 0
    window_.hasMore = true
    window_.oldest = 5
    wire.request = ((method: string) => {
      if (method !== 'session/page') throw new Error(`unexpected ${method}`)
      return Promise.resolve({ page: { events: [{ type: 'user/message', seq: 4, time: 0, data: {} }], from: 4, to: 4, hasMore: false } })
    }) as never
    await window_.older()
    expect(changes).toEqual([{ kind: 'prepend', seqs: [4] }])
  })
})

describe('paging backwards, twice', () => {
  it('fetches one page per click, however many clicks land inside one round trip', async () => {
    let inFlight = 0
    let requests = 0
    const changes: string[] = []
    const wire = {
      request: (method: string) => {
        if (method !== 'session/page') throw new Error(`unexpected ${method}`)
        requests++
        inFlight++
        // A cold session's page is a whole-file parse on the host; two clicks
        // fit inside one comfortably.
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--
            resolve({ page: { events: [{ type: 'user/message', seq: 4, time: 0, data: {} }], from: 4, to: 4, hasMore: true } })
          }, 20),
        )
      },
    }
    const window_ = new SessionWindow(wire as never, 's', (change: { kind: string }) => changes.push(change.kind))
    window_.attached = true
    window_.hasMore = true
    window_.oldest = 5
    window_.cursor = 9

    await Promise.all([window_.older(), window_.older(), window_.older()])

    expect(requests).toBe(1)
    expect(inFlight).toBe(0)
    expect(changes).toEqual(['prepend'])
    // The page's seqs appear once, so `events` is still in seq order.
    expect(window_.events.map((one) => one.seq)).toEqual([4])
  })
})
