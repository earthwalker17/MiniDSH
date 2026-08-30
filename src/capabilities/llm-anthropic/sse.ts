import { LlmError } from '../../core/llm/index.ts'

/** One named server-sent event: the Messages API names every event and ends the stream with `message_stop`, never a `[DONE]` sentinel. */
export interface SseEvent {
  readonly event: string
  readonly data: string
}

/**
 * Parses a `text/event-stream` body into named events. The stream is over
 * when the body ends; whether it ended PROPERLY (with `message_stop`) is the
 * translator's call, because only it knows what a complete message is.
 */
export async function* parseNamedSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onActivity()
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = eventOf(raw)
        if (parsed) yield parsed
        boundary = buffer.indexOf('\n\n')
      }
    }
    const tail = eventOf(buffer)
    if (tail) yield tail
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
  return data.length > 0 ? { event, data: data.join('\n') } : undefined
}

/** Parses one event's data as a wire object. */
export function parseWireEvent(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    throw new LlmError('MALFORMED_RESPONSE', 'Anthropic returned a non-JSON stream event')
  }
}
