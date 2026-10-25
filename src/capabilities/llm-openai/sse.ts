import { LlmError } from '../../core/llm/index.ts'
import { parseSseEvents, type SseEvent } from '../../core/llm/wire.ts'

/**
 * One named server-sent event. The Responses API names every event and ends
 * the stream with a terminal lifecycle event (`response.completed`,
 * `.incomplete`, `.failed`): measured 2026-10-16, there is no `[DONE]`. An
 * event flushed at end of body without its blank line carries `tail`.
 */
export type { SseEvent }

/**
 * Parses a `text/event-stream` body into named events. Framing (CRLF and
 * lone-CR line ends, the per-event cap) is the shared `core/llm/wire.ts`, which
 * began as this parser. The stream is over when the body ends; whether it
 * ended PROPERLY is the translator's call, because only it knows what a
 * terminal event is. A `data: [DONE]` sentinel, should one ever arrive, is
 * skipped rather than handed on as JSON that is not.
 */
export async function* parseNamedSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<SseEvent> {
  for await (const event of parseSseEvents(body, onActivity, { provider: 'OpenAI' })) {
    if (event.data !== '[DONE]') yield event
  }
}

/** Parses one event's data as a wire object. */
export function parseWireEvent(data: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new LlmError('MALFORMED_RESPONSE', 'OpenAI returned a non-JSON stream event')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LlmError('MALFORMED_RESPONSE', 'OpenAI returned a stream event that is not an object')
  return parsed as Record<string, unknown>
}
