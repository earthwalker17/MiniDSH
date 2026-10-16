import { LlmError, type LlmAdapter, type LlmErrorCode, type LlmRequest, type ModelInfo, type ResolvedModel, type StreamChunk } from '../../core/llm/index.ts'
import type { Attachments } from '../../core/attachments/index.ts'
import { resolveRequestImages } from '../../core/llm/content.ts'
import { catalogEntry, factsFor, OPENAI_CATALOG, type OpenAICatalogModel } from './catalog.ts'
import { serializeInput, serializeTools, type ImageBytes } from './serialize.ts'
import { parseNamedSse, parseWireEvent } from './sse.ts'
import { isQuotaCode, OpenAITranslator, OPENAI_PROVIDER } from './translate.ts'

export { OPENAI_PROVIDER }
/** The OpenAI SDK's convention: the base includes `/v1`, so `$OPENAI_BASE_URL` means the same thing here as there. */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
/**
 * Per-request output cap when the request sets none, capped by the row.
 * `max_output_tokens` counts reasoning as well as the answer, so this is sized
 * for a high-effort turn, not for the visible text alone.
 */
export const DEFAULT_MAX_TOKENS = 32_768
const IDLE_TIMEOUT_MS = 300_000
// No version in it, for the reason the sibling adapters give: one version string, in package.json.
const USER_AGENT = 'minidsh (+https://github.com/earthwalker17/MiniDSH)'

export interface OpenAIAdapterOptions {
  /** The credential's NAME, for error messages; never the value. */
  readonly apiKeyRef: string
  /** Called per request, so a rotated key takes effect without a reload. */
  readonly resolveKey: () => string | undefined
  /** Where the key would be looked for, for the refusal that names the fix; absent falls back to naming the reference alone. */
  readonly describeKey?: () => string
  /** The mounted attachment store, read per request (see the sibling adapters). Absent is legal: no attachments here. */
  readonly resolveAttachments?: () => Attachments | undefined
  readonly baseURL: string
  readonly defaultMaxTokens: number
  /**
   * Whether a reasoning request asks for summaries (`reasoning.summary:
   * 'auto'`); absent means yes. OpenAI may refuse summaries to an
   * organization it has not verified, and a row turns them off rather than
   * lose the route — the sealed reasoning is requested either way.
   */
  readonly reasoningSummaries?: boolean
}

/** Direct fetch + SSE adapter for the OpenAI Responses API, stateless (`store: false`). */
export class OpenAIAdapter implements LlmAdapter {
  readonly provider = OPENAI_PROVIDER
  private readonly options: OpenAIAdapterOptions
  constructor(options: OpenAIAdapterOptions) {
    this.options = options
  }

  listModels(): readonly ModelInfo[] {
    return OPENAI_CATALOG.map(({ id, name }) => ({ id, name }))
  }

  resolveModel(model: string): ResolvedModel {
    const entry = factsFor(model)
    return {
      contextWindow: entry.contextWindow,
      defaultMaxTokens: Math.min(this.options.defaultMaxTokens, entry.maxOutputTokens),
      reasoning: { efforts: entry.efforts, ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }) },
      inputModalities: entry.modalities,
    }
  }

  /**
   * Every option refusal, and nothing else — no I/O, no serialization, so an
   * illegal temperature never costs a disk read of the images the request
   * carries (see the sibling adapter's note on the same split).
   */
  validateOptions(request: LlmRequest): void {
    const entry = factsFor(request.model)
    const known = catalogEntry(request.model) !== undefined
    const effort = request.reasoningEffort
    if (effort !== undefined && !entry.efforts.includes(effort)) {
      throw new LlmError(
        'UNSUPPORTED_REASONING_EFFORT',
        known
          ? `OpenAI model "${request.model}" does not support reasoning effort "${effort}" (one of ${entry.efforts.join(', ')})`
          : `OpenAI model "${request.model}" is not in this adapter's catalog, so its reasoning efforts are unknown; "${effort}" is refused rather than guessed (name no effort, or a catalogued model)`,
      )
    }
    if (request.temperature !== undefined) {
      const effective = effort ?? entry.defaultEffort
      if (!known) {
        throw new LlmError('UNSUPPORTED_OPTION', `OpenAI model "${request.model}" is not in this adapter's catalog, so whether it accepts a temperature is unknown; it is refused rather than sent`)
      }
      if (entry.sampling === 'never') {
        throw new LlmError('UNSUPPORTED_OPTION', `OpenAI model "${request.model}" does not accept a temperature at any reasoning effort (the API returns 400)`)
      }
      if (effective !== 'none') {
        throw new LlmError('UNSUPPORTED_OPTION', `OpenAI model "${request.model}" accepts a temperature only at reasoning effort "none", and this request's effort is "${effective ?? 'unknown'}" (the API returns 400): name effort none, or drop the temperature`)
      }
    }
    if (request.maxTokens !== undefined && request.maxTokens > entry.maxOutputTokens) {
      throw new LlmError('UNSUPPORTED_OPTION', `OpenAI model "${request.model}" caps output at ${entry.maxOutputTokens} tokens, but the request asks for ${request.maxTokens}`)
    }
  }

  /**
   * The wire body, or an `LlmError` for an option this model cannot honour —
   * decided BEFORE the key is read or a byte is sent. `images` carries
   * whatever the caller resolved; an empty map means every image serializes
   * as its own stored descriptor.
   */
  buildBody(request: LlmRequest, images: ImageBytes = new Map()): Record<string, unknown> {
    // Every refusal lives in `validateOptions`, as in the sibling adapter: one site per rule.
    this.validateOptions(request)
    const entry = factsFor(request.model)
    const tools = serializeTools(request.tools)
    return {
      model: request.model,
      ...(request.system && request.system.length > 0 ? { instructions: request.system } : {}),
      input: serializeInput(request.messages, images, request.model),
      stream: true,
      // ALWAYS explicit: the API default is `true`, which keeps every request
      // on OpenAI's side for at least 30 days. Replay here is self-contained
      // (sealed reasoning, below) and needs none of it.
      store: false,
      max_output_tokens: request.maxTokens ?? Math.min(this.options.defaultMaxTokens, entry.maxOutputTokens),
      // The obfuscation padding on every delta is bandwidth and nothing else.
      stream_options: { include_obfuscation: false },
      ...(tools ? { tools } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...this.reasoningFields(entry, request),
      // Deliberately absent: `truncation` (its default, `disabled`, makes an
      // overflow a 400 this adapter classifies, where `auto` would silently
      // drop history the log says was sent), `prompt_cache_key` and
      // `safety_identifier` (caching worked without them, and what identity a
      // session presents is an open question), `user` (deprecated), and
      // `parallel_tool_calls` (the API default is the loop's contract).
    }
  }

  /**
   * The reasoning fields, from the row and the request alone. A catalogued
   * row whose effective effort is not `none` asks for its reasoning SEALED
   * (`include`), because a stateless replay can only send back what it was
   * given; an explicit `none` is sent as such; an unknown id is sent no
   * reasoning field at all, since it may be a model that takes none.
   */
  private reasoningFields(entry: OpenAICatalogModel, request: LlmRequest): Record<string, unknown> {
    if (catalogEntry(request.model) === undefined) return {}
    const effort = request.reasoningEffort
    if (effort === 'none') return { reasoning: { effort: 'none' } }
    if ((effort ?? entry.defaultEffort) === 'none') return {}
    const reasoning = {
      ...(effort === undefined ? {} : { effort }),
      ...(this.options.reasoningSummaries === false ? {} : { summary: 'auto' }),
    }
    return { ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}), include: ['reasoning.encrypted_content'] }
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    // Options first (no I/O), then the attachment reads, then serialization,
    // then the key — the sibling adapters' order, for their reasons.
    this.validateOptions(request)
    const images = await resolveRequestImages(request.messages, {
      takesImages: factsFor(request.model).modalities.includes('image'),
      attachments: this.options.resolveAttachments?.(),
      provider: this.provider,
      model: request.model,
    })
    const body = this.buildBody(request, images)
    const apiKey = this.options.resolveKey()
    if (!apiKey || apiKey.trim().length === 0) {
      const where = this.options.describeKey?.()
      throw new LlmError('MISSING_CREDENTIAL', `OpenAI API key not set (expected credential ${this.options.apiKeyRef}${where === undefined ? '' : `: set ${where}`})`)
    }

    const idle = new AbortController()
    const combined = request.signal ? AbortSignal.any([idle.signal, request.signal]) : idle.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const resetIdle = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new LlmError('TIMEOUT', 'OpenAI stream idle timeout')), IDLE_TIMEOUT_MS)
    }

    let response: Response
    try {
      resetIdle()
      response = await fetch(`${this.options.baseURL.replace(/\/+$/, '')}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      if (timer) clearTimeout(timer)
      throw mapAbort(error, request.signal, idle.signal)
    }

    if (!response.ok) {
      if (timer) clearTimeout(timer)
      const text = await response.text().catch(() => '')
      throw classifyHttp(response.status, text, response.headers)
    }
    if (!response.body) {
      if (timer) clearTimeout(timer)
      throw new LlmError('TRANSPORT', 'OpenAI response had no body')
    }

    const translator = new OpenAITranslator()
    try {
      for await (const event of parseNamedSse(response.body, resetIdle)) {
        const data = parseWireEvent(event.data)
        // Every event names itself in its own `type`; the SSE name is the fallback.
        for (const chunk of translator.push(typeof data.type === 'string' ? data : { ...data, type: event.event })) yield chunk
        if (translator.complete) break
      }
    } catch (error) {
      throw mapAbort(error, request.signal, idle.signal)
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!translator.complete) throw new LlmError('STREAM_CLOSED', 'OpenAI stream ended without a terminal response event')
  }
}

function mapAbort(error: unknown, caller: AbortSignal | undefined, idle: AbortSignal): LlmError {
  if (error instanceof LlmError) return error
  if (caller?.aborted) return new LlmError('ABORTED', 'request aborted by caller')
  if (idle.aborted) return new LlmError('TIMEOUT', 'OpenAI stream idle timeout')
  return new LlmError('TRANSPORT', error instanceof Error ? error.message : String(error))
}

/** HTTP failures, as codes; the body's own `error.code` decides where the status is ambiguous. */
export function classifyHttp(status: number, body: string, headers: Headers): LlmError {
  let message = body.slice(0, 500)
  let code: string | undefined
  let type: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; type?: unknown; code?: unknown; param?: unknown } }
    if (typeof parsed.error?.message === 'string' && parsed.error.message.length > 0) message = parsed.error.message
    if (typeof parsed.error?.code === 'string') code = parsed.error.code
    if (typeof parsed.error?.type === 'string') type = parsed.error.type
  } catch {
    // Non-JSON error body; keep the truncated text.
  }
  const requestId = headers.get('x-request-id') ?? undefined
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const options = { status, ...(requestId ? { requestId } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  let result: LlmErrorCode
  // 504 before the 5xx row: a gateway that gave up is a timeout, and the retry
  // policy treats the two alike only by accident.
  if (status === 504) result = 'TIMEOUT'
  else if (status === 400 && (code === 'context_length_exceeded' || /context window|context length|maximum context/i.test(message))) result = 'CONTEXT_WINDOW_EXCEEDED'
  // Measured: "Unsupported parameter: 'temperature' is not supported with this
  // model." — the shape of every option this adapter failed to refuse first.
  else if (status === 400 && (code === 'unsupported_value' || code === 'unsupported_parameter' || /Unsupported parameter|Unsupported value/i.test(message))) result = 'UNSUPPORTED_OPTION'
  else if (status === 401 || status === 403) result = 'AUTH'
  // Measured: "The model `x` does not exist or you do not have access to it.", code model_not_found.
  else if (status === 404 && code === 'model_not_found') result = 'UNKNOWN_MODEL'
  // A 429 is "slow down" OR "out of money", and only the body says which:
  // retrying the second can never succeed.
  else if (status === 429) result = isQuotaCode(code) || isQuotaCode(type) ? 'QUOTA' : 'RATE_LIMIT'
  else if (status >= 500) result = 'SERVER'
  else result = 'INVALID_REQUEST'
  return new LlmError(result, `OpenAI ${status}: ${message}`, options)
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}
