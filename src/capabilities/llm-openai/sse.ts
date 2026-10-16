import { LlmError } from '../../core/llm/index.ts'

/**
 * One named server-sent event. The Responses API names every event and ends
 * the stream with a terminal lifecycle event (`response.completed`,
 * `.incomplete`, `.failed`): measured 2026-10-16, there is no `[DONE]`.
 */
export interface SseEvent {
  readonly event: string
  readonly data: string
  /** Flushed at end of body without its blank line: complete, or a cut. The reader decides which. */
  readonly tail?: true
}

/**
 * Parses a `text/event-stream` body into named events, tolerating CRLF and
 * lone-CR line ends as the SSE grammar allows. The stream is over when the
 * body ends; whether it ended PROPERLY is the translator's call, because only
 * it knows what a terminal event is. A `data: [DONE]` sentinel, should one
 * ever arrive, is skipped rather than handed on as JSON that is not.
 */
export async function* parseNamedSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // A CR that ends one read may be the first half of a CRLF split across two:
  // normalizing it alone would turn one line end into two, and two line ends
  // are an event boundary.
  let carry = ''
  const append = (text: string): void => {
    let next = carry + text
    carry = ''
    if (next.endsWith('\r')) {
      carry = '\r'
      next = next.slice(0, -1)
    }
    buffer += next.replace(/\r\n?/g, '\n')
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onActivity()
      append(decoder.decode(value, { stream: true }))
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const parsed = eventOf(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (parsed) yield parsed
        boundary = buffer.indexOf('\n\n')
      }
    }
    append(decoder.decode())
    buffer += carry.replace(/\r/g, '\n')
    for (const raw of buffer.split('\n\n')) {
      const parsed = eventOf(raw)
      if (parsed) yield { ...parsed, tail: true }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function eventOf(raw: string): SseEvent | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0) return undefined
  const joined = data.join('\n')
  return joined === '[DONE]' ? undefined : { event, data: joined }
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
