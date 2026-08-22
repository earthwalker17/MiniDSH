import { LlmError } from '../../core/llm/index.ts'

/**
 * Parses a `text/event-stream` body into the `data:` payloads of each event,
 * yielding the literal `[DONE]` sentinel and then stopping. Throws
 * STREAM_CLOSED if the body ends without `[DONE]`.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      onActivity()
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = dataOf(rawEvent)
        if (data !== undefined) {
          if (data === '[DONE]') {
            done = true
            yield '[DONE]'
            return
          }
          yield data
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    const tail = dataOf(buffer)
    if (tail === '[DONE]') {
      done = true
      yield '[DONE]'
      return
    }
    if (tail !== undefined) yield tail
  } finally {
    reader.cancel().catch(() => {})
  }
  if (!done) throw new LlmError('STREAM_CLOSED', 'DeepSeek stream ended without [DONE]')
}

function dataOf(rawEvent: string): string | undefined {
  const parts: string[] = []
  for (const line of rawEvent.split('\n')) {
    const trimmed = line.startsWith('data:') ? line.slice(5).replace(/^ /, '') : undefined
    if (trimmed !== undefined) parts.push(trimmed)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}
