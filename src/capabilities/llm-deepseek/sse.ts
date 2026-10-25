import { LlmError } from '../../core/llm/index.ts'
import { parseSseEvents } from '../../core/llm/wire.ts'

/**
 * Parses a `text/event-stream` body into the `data:` payloads of each event,
 * yielding the literal `[DONE]` sentinel and then stopping. Throws
 * STREAM_CLOSED if the body ends without `[DONE]`. Framing (CRLF, lone CR, the
 * per-event cap) is the shared `core/llm/wire.ts`; what ends a stream is this
 * provider's.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<string> {
  for await (const event of parseSseEvents(body, onActivity, { provider: 'DeepSeek' })) {
    yield event.data
    if (event.data === '[DONE]') return
  }
  throw new LlmError('STREAM_CLOSED', 'DeepSeek stream ended without [DONE]')
}
