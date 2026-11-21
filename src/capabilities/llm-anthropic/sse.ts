import { LlmError } from '../../core/llm/index.ts'
import { parseSseEvents } from '../../core/llm/wire.ts'

/** One named server-sent event: the Messages API names every event and ends the stream with `message_stop`, never a `[DONE]` sentinel. */
export interface SseEvent {
  readonly event: string
  readonly data: string
}

/**
 * Parses a `text/event-stream` body into named events. The stream is over
 * when the body ends; whether it ended PROPERLY (with `message_stop`) is the
 * translator's call, because only it knows what a complete message is. A body
 * that ends in the middle of an event is this parser's to name, and fails
 * STREAM_CLOSED. Framing (CRLF, lone CR, the per-event cap) is the shared
 * `core/llm/wire.ts`.
 */
export async function* parseNamedSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<SseEvent> {
  for await (const { event, data, tail } of parseSseEvents(body, onActivity, { provider: 'Anthropic' })) {
    // An event flushed at end of body without its blank line is either whole
    // or was cut while being written. A cut is the dropped connection the
    // adapter names when `message_stop` never came, seen one event sooner, so
    // it says the same retryable thing: handed on, the half-written payload
    // would fail to parse as MALFORMED_RESPONSE, which nothing retries.
    if (tail === true && !parses(data)) throw new LlmError('STREAM_CLOSED', 'Anthropic stream was cut in the middle of an event')
    yield { event, data }
  }
}

function parses(data: string): boolean {
  try {
    JSON.parse(data)
    return true
  } catch {
    return false
  }
}

/** Parses one event's data as a wire object. */
export function parseWireEvent(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    throw new LlmError('MALFORMED_RESPONSE', 'Anthropic returned a non-JSON stream event')
  }
}
