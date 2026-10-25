/**
 * The SSE framing every adapter shares (`wire.ts`), read in the pieces a
 * network hands it.
 */
import { describe, expect, it } from 'vitest'
import { parseSseEvents, type SseEvent } from './wire.ts'

function streamOf(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let next = 0
  return new ReadableStream({
    pull(controller) {
      if (next < parts.length) controller.enqueue(encoder.encode(parts[next++]!))
      else controller.close()
    },
  })
}

async function eventsOf(parts: readonly string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of parseSseEvents(streamOf(parts), () => {}, { provider: 'test' })) events.push(event)
  return events
}

describe('parseSseEvents', () => {
  it('finds a boundary split across two reads, and one inside a read', async () => {
    expect(await eventsOf(['data: a\n', '\ndata: b\n\ndata: c', '\n\n'])).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
      { event: 'message', data: 'c' },
    ])
    // CRLF line ends split anywhere, the event name kept.
    expect(await eventsOf(['event: x\r', '\ndata: 1\r\n\r', '\n'])).toEqual([{ event: 'x', data: '1' }])
    // What the body ends inside is flagged a tail, for the caller to judge.
    expect(await eventsOf(['data: a\n\ndata: b'])).toEqual([{ event: 'message', data: 'a' }, { event: 'message', data: 'b', tail: true }])
  })

  // The S20.5 review: each read rescanned (and re-flattened) the whole
  // unfinished event, so reaching the 8 MiB cap in 256-byte reads took 47 s.
  // Judged by a RATIO, n against 4n: linear work grows 4x, the old shape 16x.
  it('reaches its cap in time linear in what arrived', async () => {
    const timeToCap = async (reads: number): Promise<number> => {
      const parts = ['data: ', ...Array.from({ length: reads }, () => 'x'.repeat(256))]
      const started = performance.now()
      const failure = await (async () => {
        for await (const _ of parseSseEvents(streamOf(parts), () => {}, { provider: 'test', maxEventChars: reads * 256 - 1024 })) {
          // No event ever ends.
        }
      })().catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'MALFORMED_RESPONSE' })
      return performance.now() - started
    }
    await timeToCap(500)
    const one = await timeToCap(2_000)
    const four = await timeToCap(8_000)
    expect(four, `${one.toFixed(0)} ms at n, ${four.toFixed(0)} ms at 4n`).toBeLessThan(Math.max(250, 8 * one))
  })
})
