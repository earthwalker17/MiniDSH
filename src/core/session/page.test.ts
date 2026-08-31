/**
 * The paging fold: what a client is allowed to be handed. Every case here is a
 * way a page could be a plausible lie — a split message group, a summary
 * citing events it did not carry, a budget a tool-heavy turn could exhaust —
 * or a way it could be unbounded.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PAGE_MESSAGES, MAX_PAGE_MESSAGES, groupStart, pageEvents } from './page.ts'
import { TRACE_TYPES, type EventEnvelope } from './types.ts'

let nextSeq = 0
function event(type: string, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return { type, seq: nextSeq++, time: 1_000 + nextSeq, data: {}, ...extra }
}
const append = { surfaceOp: { op: 'append' } as const }

/** `turns` turns of `steps` steps each, every step a user message, a chunk, an assistant message and a tool result. */
function log(turns: number, steps = 1): EventEnvelope[] {
  nextSeq = 0
  const events: EventEnvelope[] = []
  for (let turn = 1; turn <= turns; turn++) {
    events.push(event('turn/start'))
    for (let step = 1; step <= steps; step++) {
      events.push(event('step/start'))
      events.push(event('user/message', append))
      events.push(event('assistant/chunk'))
      events.push(event('assistant/message', append))
      events.push(event('tool/call'))
      events.push(event('tool/result', append))
      events.push(event('step/end'))
    }
    events.push(event('turn/end'))
  }
  return events
}

const facts = (events: readonly EventEnvelope[]): EventEnvelope[] => events.filter((one) => !TRACE_TYPES.has(one.type))
const head = (events: readonly EventEnvelope[]): number => events[events.length - 1]!.seq
const messagesIn = (events: readonly EventEnvelope[]): number =>
  events.filter((one) => (one.type === 'user/message' || one.type === 'assistant/message') && one.surfaceOp?.op === 'append').length

describe('the page fold', () => {
  it('serves the tail within its message budget and says older events remain', () => {
    const all = facts(log(40))
    const page = pageEvents(all, { throughSeq: head(all), maxMessages: 10 })

    expect(messagesIn(page.events)).toBe(10)
    expect(page.hasMore).toBe(true)
    expect(page.to).toBe(head(all))
    expect(page.events[0]!.seq).toBe(page.from)
  })

  it('counts only arrived messages, so a tool-heavy turn cannot spend the budget on results', () => {
    // Ten steps per turn: 20 messages and 10 tool results inside one turn.
    const all = facts(log(4, 10))
    const page = pageEvents(all, { throughSeq: head(all), maxMessages: 20 })

    expect(messagesIn(page.events)).toBe(20)
    // The whole last turn is 20 messages, so the page holds its 10 results too.
    expect(page.events.filter((one) => one.type === 'tool/result')).toHaveLength(10)
  })

  it('never splits a message from the events that produced it', () => {
    const all = facts(log(20))
    // A repaired tool result cites the assistant block it answers; an assistant
    // message reconstructed from many sources cites all of them.
    const sources = all.slice(-9, -1).map((one) => one.seq)
    const produced = event('assistant/message', { seq: head(all) + 1, ...append, sourceEventSeqs: sources })
    const page = pageEvents([...all, produced], { throughSeq: produced.seq, maxMessages: 1 })

    expect(page.events).toContain(produced)
    for (const seq of sources) expect(page.events.some((one) => one.seq === seq)).toBe(true)
    expect(page.from).toBe(sources[0])
  })

  it('does not drag a compaction summary shadowed history onto the page, and does not spend budget on it', () => {
    const all = facts(log(20))
    const shadowed = all.filter((one) => one.surfaceOp?.op === 'append').slice(0, 12).map((one) => one.seq)
    const replace = event('user/message', {
      seq: head(all) + 1,
      surfaceOp: { op: 'replace', start: shadowed[0]!, end: shadowed.at(-1)! },
      sourceEventSeqs: shadowed,
    })
    const page = pageEvents([...all, replace], { throughSeq: replace.seq, maxMessages: 4 })

    // The summary rides on the page as a record, and cost nothing to carry:
    // four arrivals still fit beside it.
    expect(page.events).toContain(replace)
    expect(messagesIn(page.events)).toBe(4)
    // Its citations reach far below the cut, and are NOT pulled in — that is
    // what keeps a page bounded on exactly the sessions that need paging.
    expect(page.from).toBeGreaterThan(shadowed.at(-1)!)
  })

  it('walks backwards to seq 0 and stops claiming more exactly at the head', () => {
    const all = facts(log(12))
    const through = head(all)
    const seen: EventEnvelope[] = []
    let before: number | undefined
    let pages = 0
    for (;;) {
      const page = pageEvents(all, { throughSeq: through, ...(before === undefined ? {} : { beforeSeq: before }), maxMessages: 5 })
      seen.unshift(...page.events)
      pages++
      if (!page.hasMore) break
      before = page.from
      expect(pages).toBeLessThan(50)
    }

    expect(pages).toBeGreaterThan(1)
    expect(seen.map((one) => one.seq)).toEqual(all.map((one) => one.seq))
  })

  it('is anchored: nothing above throughSeq can appear, however much the log has grown', () => {
    const all = facts(log(20))
    const anchor = all[Math.floor(all.length / 2)]!.seq
    const page = pageEvents(all, { throughSeq: anchor, maxMessages: 5 })

    expect(page.to).toBeLessThanOrEqual(anchor)
    expect(page.events.every((one) => one.seq <= anchor)).toBe(true)
  })

  it('clamps a budget a client asked for, so no client can pull the whole log in one frame', () => {
    const all = facts(log(400))
    const page = pageEvents(all, { throughSeq: head(all), maxMessages: Number.MAX_SAFE_INTEGER })

    expect(messagesIn(page.events)).toBe(MAX_PAGE_MESSAGES)
    expect(page.hasMore).toBe(true)
  })

  it('honours an event ceiling, and cuts only where a message group ended', () => {
    const all = facts(log(40))
    const page = pageEvents(all, { throughSeq: head(all), maxMessages: DEFAULT_PAGE_MESSAGES, maxEvents: 20 })

    expect(page.events.length).toBeLessThanOrEqual(40)
    expect(page.events.length).toBeGreaterThan(0)
    // The cut is a group start, so the first event of the page is that group's own event.
    expect(groupStart(page.events[0]!)).toBe(page.from)
  })

  it('serves one oversized group whole rather than half of it', () => {
    const all = facts(log(20))
    const sources = all.map((one) => one.seq)
    const produced = event('assistant/message', { seq: head(all) + 1, ...append, sourceEventSeqs: sources })
    const page = pageEvents([...all, produced], { throughSeq: produced.seq, maxMessages: 1, maxEvents: 5 })

    expect(page.from).toBe(sources[0])
    expect(page.events.length).toBeGreaterThan(5)
  })

  it('reads an array whose indices are not its seqs — the facts view every live fold walks', () => {
    const all = log(10)
    const withoutTrace = facts(all)
    expect(withoutTrace[5]!.seq).not.toBe(5) // the trace tier left holes in the index space

    const page = pageEvents(withoutTrace, { throughSeq: head(all), maxMessages: 4 })
    expect(page.events.every((one) => !TRACE_TYPES.has(one.type))).toBe(true)
    expect(messagesIn(page.events)).toBe(4)
  })

  it('answers an empty log with an empty page that claims nothing', () => {
    expect(pageEvents([], { throughSeq: -1 })).toEqual({ events: [], from: 0, to: -1, hasMore: false })
  })
})
