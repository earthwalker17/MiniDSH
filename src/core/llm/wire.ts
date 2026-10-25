/**
 * The HTTP wire the provider adapters share: SSE framing, a bounded read of an
 * error body, the base-URL rule and key redaction. Pure helpers, no state;
 * each adapter keeps its own reading of what an event MEANS (DeepSeek's
 * `[DONE]`, Anthropic's `message_stop`, OpenAI's terminal lifecycle events).
 *
 * One copy because three drifted: the S20.5 review found the DeepSeek and
 * Anthropic parsers splitting only on LF LF, so an endpoint (a proxy behind
 * `*_BASE_URL`) that ends lines with CRLF was buffered whole and failed
 * MALFORMED_RESPONSE, while OpenAI's parser had long handled it.
 */
import { LlmError, type StreamChunk } from './types.ts'

/** One server-sent event. `event` defaults to `message`, as the grammar says. */
export interface SseEvent {
  readonly event: string
  readonly data: string
  /** Flushed at end of body without its blank line: complete, or a cut. The reader decides which. */
  readonly tail?: true
}

/**
 * How much text one event may hold before it ends. A real event is a delta or,
 * at most, OpenAI's terminal `response.completed` carrying the whole answer —
 * a 128K-token answer is well under one MiB. Past this the endpoint is not
 * streaming events at all, and an unbounded buffer would grow host memory for
 * as long as it drips bytes (each read re-arms the idle watchdog).
 */
export const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024

/** An error body is read only for its message; the status already classified it. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024

/**
 * Parses a `text/event-stream` body into events, tolerating CRLF and lone-CR
 * line ends as the SSE grammar allows. An event with no `data:` line is
 * skipped. The stream is over when the body ends; whether it ended PROPERLY is
 * the caller's call. Past `maxEventChars` of one unfinished event it fails
 * MALFORMED_RESPONSE, naming `provider` — not retryable, because a provider
 * that does this once will do it again.
 */
export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
  options: { readonly provider: string; readonly maxEventChars?: number },
): AsyncIterable<SseEvent> {
  const max = options.maxEventChars ?? MAX_SSE_EVENT_CHARS
  const reader = body.getReader()
  const decoder = new TextDecoder()
  // A CR that ends one read may be the first half of a CRLF split across two:
  // normalizing it alone would turn one line end into two, and two line ends
  // are an event boundary.
  let carry = ''
  const normalize = (text: string): string => {
    let next = carry + text
    carry = ''
    if (next.endsWith('\r')) {
      carry = '\r'
      next = next.slice(0, -1)
    }
    return next.replace(/\r\n?/g, '\n')
  }
  // The unfinished event, as the pieces it arrived in. Each read is searched
  // alone, plus the one character before it where a boundary can straddle, and
  // the pieces join only when a boundary closes the event: rescanning one
  // growing string re-flattened all of it at every read, quadratic inside the
  // cap (S20.5 review: 47 s to reach 8 MiB in 256-byte reads).
  let pieces: string[] = []
  let pendingChars = 0
  let lastChar = ''
  const take = (raw: string): SseEvent | undefined => {
    pieces = []
    pendingChars = 0
    lastChar = ''
    return eventOf(raw)
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onActivity()
      let rest = normalize(decoder.decode(value, { stream: true }))
      while (rest.length > 0) {
        if (lastChar === '\n' && rest.startsWith('\n')) {
          const parsed = take(pieces.join('').slice(0, -1))
          rest = rest.slice(1)
          if (parsed) yield parsed
          continue
        }
        const boundary = rest.indexOf('\n\n')
        if (boundary < 0) {
          pieces.push(rest)
          pendingChars += rest.length
          lastChar = rest.at(-1)!
          break
        }
        const parsed = take(pieces.join('') + rest.slice(0, boundary))
        rest = rest.slice(boundary + 2)
        if (parsed) yield parsed
      }
      if (pendingChars > max) throw new LlmError('MALFORMED_RESPONSE', `${options.provider} stream event exceeded ${max} characters without ending`)
    }
    const tail = pieces.join('') + normalize(decoder.decode()) + carry.replace(/\r/g, '\n')
    for (const raw of tail.split('\n\n')) {
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
  return data.length > 0 ? { event, data: data.join('\n') } : undefined
}

/**
 * The first `cap` bytes of a non-OK response's body, the rest cancelled
 * unread. Never refuses and never throws: the status is the fact a policy
 * routes on (a 401 is AUTH however long its page), so a body past the cap is
 * cut, not turned into a TRANSPORT failure that the retry policy would repeat.
 */
export async function readErrorBody(response: Response, cap: number = MAX_ERROR_BODY_BYTES): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      const room = cap - total
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value)
      total += Math.min(value.byteLength, room)
    }
  } catch {
    // A body that fails mid-read still classifies by its status.
  } finally {
    reader.cancel().catch(() => {})
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/**
 * A base an endpoint can be built from and a person can read: http(s), and no
 * user info. A password in the URL reaches every error that quotes it — Node's
 * fetch refuses such a URL with a message that does — and from there the
 * session log and the model. Refused at a row's contract, so `minidsh config`
 * names the bad row (`tool-web-search` first; the three LLM rows since S20.5).
 */
export function isPlainHttpBase(text: string): boolean {
  try {
    const url = new URL(text)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** The refusal a row's schema attaches to `baseURL`; one wording for every row. */
export const PLAIN_HTTP_BASE_RULE = 'baseURL must be an http(s) URL with no user info'

/**
 * A base URL from the environment variable `name`, or `undefined` when it is
 * unset or blank. The environment is a configuration layer the row's schema
 * never sees, so the same rule is applied here, at apply, and a bad value
 * fails the row loudly — naming the variable, never quoting the value, which
 * may hold the very password the rule exists to keep out of messages.
 */
export function baseURLFromEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) return undefined
  if (!isPlainHttpBase(value)) throw new Error(`$${name} is not a usable endpoint: ${PLAIN_HTTP_BASE_RULE}`)
  return value
}

/**
 * `text` with every occurrence of `secret` replaced. Applied to every error
 * string built once a key is resolved: a provider or a proxy that echoes the
 * presented key in its error body would otherwise put it into a durable,
 * model-visible failure. An empty secret redacts nothing.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  return secret === undefined || secret.length === 0 ? text : text.split(secret).join('[redacted]')
}

/**
 * A stream chunk whose failure no longer carries `secret`. A failure an adapter
 * YIELDS — a stream's own error event (OpenAI's `response.failed`), an
 * unexpected finish — never passes the catch that redacts what it throws, so
 * each yield goes through this (S20.5 review).
 */
export function redactChunk(chunk: StreamChunk, secret: string | undefined): StreamChunk {
  if (chunk.type !== 'finish' || (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted')) return chunk
  const message = redactSecret(chunk.reason.failure.message, secret)
  return message === chunk.reason.failure.message ? chunk : { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message } } }
}

/**
 * What a failure says of the wait its provider asked for: `llm-retry` gives
 * up past its ceiling, and the turn's failure is then all a person or the
 * model reads of why (S20.5 review).
 */
export function retryAfterNote(retryAfterMs: number | undefined): string {
  return retryAfterMs === undefined ? '' : ` (the provider asks to wait ${Math.ceil(retryAfterMs / 1000)} s before a retry)`
}

/** An `LlmError` whose message no longer carries `secret`; the same instance when it never did. */
export function redactLlmError(error: LlmError, secret: string | undefined): LlmError {
  const message = redactSecret(error.message, secret)
  if (message === error.message) return error
  const { status, retryAfterMs, requestId } = error.failure
  return new LlmError(error.code, message, {
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(requestId === undefined ? {} : { requestId }),
  })
}
