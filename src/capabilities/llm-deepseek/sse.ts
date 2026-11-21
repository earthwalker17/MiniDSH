import { LlmError } from '../../core/llm/index.ts'
import { parseSseEvents } from '../../core/llm/wire.ts'

/**
 * Parses a `text/event-stream` body into the `data:` payloads of each event,
 * yielding the literal `[DONE]` sentinel and then stopping. Throws
 * STREAM_CLOSED if the body ends without `[DONE]`, and equally if it ends in
 * the middle of an event. Framing (CRLF, lone CR, the per-event cap) is the
 * shared `core/llm/wire.ts`; what ends a stream is this provider's.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<string> {
  for await (const event of parseSseEvents(body, onActivity, { provider: 'DeepSeek' })) {
    // An event flushed at end of body without its blank line is either whole
    // or was cut while being written. A cut is the dropped connection the
    // throw below names, seen one event sooner, so it says the same retryable
    // thing: handed on, the half-written payload would fail to parse as
    // MALFORMED_RESPONSE, which nothing retries.
    if (event.tail === true && event.data !== '[DONE]' && !parses(event.data)) {
      throw new LlmError('STREAM_CLOSED', 'DeepSeek stream was cut in the middle of an event')
    }
    yield event.data
    if (event.data === '[DONE]') return
  }
  throw new LlmError('STREAM_CLOSED', 'DeepSeek stream ended without [DONE]')
}

function parses(data: string): boolean {
  try {
    JSON.parse(data)
    return true
  } catch {
    return false
  }
}
