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
 * translator's call, because only it knows what a complete message is.
 * Framing (CRLF, lone CR, the per-event cap) is the shared `core/llm/wire.ts`.
 */
export async function* parseNamedSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<SseEvent> {
  for await (const { event, data } of parseSseEvents(body, onActivity, { provider: 'Anthropic' })) yield { event, data }
}

/** Parses one event's data as a wire object. */
export function parseWireEvent(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    throw new LlmError('MALFORMED_RESPONSE', 'Anthropic returned a non-JSON stream event')
  }
}
