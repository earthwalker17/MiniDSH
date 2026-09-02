import { LlmError, type LlmAdapter, type LlmErrorCode, type LlmRequest, type ModelInfo, type ModelModality, type ResolvedModel, type StreamChunk } from '../../core/llm/index.ts'
import { parseNamedSse, parseWireEvent } from './sse.ts'
import { AnthropicTranslator, ANTHROPIC_PROVIDER, errorCode } from './translate.ts'
import type { Attachments } from '../../core/attachments/index.ts'
import { resolveRequestImages } from '../../core/llm/content.ts'
import { serializeMessages, serializeTools, type ImageBytes } from './serialize.ts'

export { ANTHROPIC_PROVIDER }
export const DEFAULT_BASE_URL = 'https://api.anthropic.com'
export const DEFAULT_MAX_TOKENS = 8192
const API_VERSION = '2023-06-01'
const IDLE_TIMEOUT_MS = 300_000
const USER_AGENT = 'minidsh/0.1.0 (+https://github.com/earthwalker17/MiniDSH)'

/**
 * How a model takes its thinking configuration. `adaptive` models (the 5
 * family, Opus 4.7+) accept `output_config.effort` and refuse manual budgets;
 * `manual` models (Haiku 4.5 and older) accept `thinking: {enabled,
 * budget_tokens}` and know no effort. Neither is guessed at request time:
 * the catalog says, and an unlisted id gets the current default (`adaptive`).
 */
interface CatalogModel extends ModelInfo {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly thinking: 'adaptive' | 'manual'
  /** Effort ids this model accepts; `off` means thinking disabled. */
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
  /** Whether `temperature` is honoured; the 5 family returns 400 for any non-default value. */
  readonly sampling: boolean
  /**
   * What the model takes as input. A per-model fact, not a constant: the
   * adapter used to answer `['text','image']` for every id including ones it
   * had never heard of, which inverts the seam's own rule — an unknowable
   * capability was advertised as present, turning a refusal that could have
   * happened before any I/O into a provider 400.
   */
  readonly modalities: readonly ModelModality[]
}

const TEXT_AND_IMAGE: readonly ModelModality[] = ['text', 'image']
const ADAPTIVE_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** Budgets for a manual-thinking model's effort ids; each must stay below `max_tokens`. */
const MANUAL_BUDGETS: Readonly<Record<string, number>> = { low: 2048, high: 6144, max: 24_576 }

/** A dated snapshot answers to its undated alias: `claude-haiku-4-5` IS `claude-haiku-4-5-20251001`. */
const ALIASES: Readonly<Record<string, string>> = { 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' }

/** Verified against the live models overview on 2026-08-30; ids are pinned snapshots. */
const CATALOG: readonly CatalogModel[] = [
  // Fable 5 refuses `thinking.type: "disabled"`, so `off` is not in its set.
  { id: 'claude-fable-5', name: 'Claude Fable 5', contextWindow: 1_000_000, maxOutputTokens: 128_000, thinking: 'adaptive', efforts: ADAPTIVE_EFFORTS.filter((effort) => effort !== 'off'), defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, maxOutputTokens: 128_000, thinking: 'adaptive', efforts: ADAPTIVE_EFFORTS, defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxOutputTokens: 128_000, thinking: 'adaptive', efforts: ADAPTIVE_EFFORTS, defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutputTokens: 64_000, thinking: 'manual', efforts: ['off', ...Object.keys(MANUAL_BUDGETS)], defaultEffort: 'off', sampling: true, modalities: TEXT_AND_IMAGE },
]

/**
 * An id the catalog does not know: a conservative window, the current thinking
 * shape, no sampling — and images, deliberately.
 *
 * The permissive side is the right one here and the choice is asymmetric. Every
 * model Anthropic currently serves accepts images, so a wrong ALLOW costs one
 * provider 400 that names itself; a wrong REFUSE makes a capability the model
 * has unreachable, with no override, on any id this table has not caught up
 * with — and this table demonstrably lags (it was written three days before
 * `claude-fable-5-1` shipped). The sibling DeepSeek adapter makes the opposite
 * call for the opposite reason: there, one known id has vision and an unknown
 * one almost certainly does not.
 */
function unlisted(id: string): CatalogModel {
  return { id, name: id, contextWindow: 200_000, maxOutputTokens: 8192, thinking: 'adaptive', efforts: ADAPTIVE_EFFORTS, sampling: false, modalities: TEXT_AND_IMAGE }
}

export interface AnthropicAdapterOptions {
  /** The credential's NAME, for error messages; never the value. */
  readonly apiKeyRef: string
  /** Called per request, so a rotated key takes effect without a reload. */
  readonly resolveKey: () => string | undefined
  /**
   * The mounted attachment store, read per request for the same reason the key
   * is: a store that appears later must take effect without a reload, and an
   * adapter that captured one at construction would hold a disposed instance.
   * Absent is legal and means this deployment stores no attachments.
   */
  readonly resolveAttachments?: () => Attachments | undefined
  readonly baseURL: string
  readonly defaultMaxTokens: number
}

/** Direct fetch + SSE adapter for the Anthropic Messages API. */
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = ANTHROPIC_PROVIDER
  private readonly options: AnthropicAdapterOptions
  constructor(options: AnthropicAdapterOptions) {
    this.options = options
  }

  listModels(): readonly ModelInfo[] {
    return CATALOG.map(({ id, name }) => ({ id, name }))
  }

  private catalog(model: string): CatalogModel {
    const id = ALIASES[model] ?? model
    return CATALOG.find((entry) => entry.id === id) ?? unlisted(model)
  }

  /**
   * The output cap for a request. A named effort on a manual-thinking model
   * needs room for its budget AND an answer, so a caller who named an effort
   * but no cap gets one large enough to honour it — refusing here would make
   * an effort this adapter advertises unusable at its own default.
   */
  private capFor(entry: CatalogModel, request: LlmRequest): number {
    if (request.maxTokens !== undefined) return request.maxTokens
    const base = Math.min(this.options.defaultMaxTokens, entry.maxOutputTokens)
    const budget = entry.thinking === 'manual' && request.reasoningEffort !== undefined ? MANUAL_BUDGETS[request.reasoningEffort] : undefined
    return budget === undefined ? base : Math.min(entry.maxOutputTokens, Math.max(base, budget + base))
  }

  resolveModel(model: string): ResolvedModel {
    const entry = this.catalog(model)
    return {
      contextWindow: entry.contextWindow,
      defaultMaxTokens: Math.min(this.options.defaultMaxTokens, entry.maxOutputTokens),
      reasoning: { efforts: entry.efforts, ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }) },
      inputModalities: entry.modalities,
    }
  }

  /**
   * Every option refusal, and nothing else — no I/O, no serialization.
   *
   * It is split out because resolving an image reads bytes off disk, and doing
   * that before an option refusal would mean a request with an illegal
   * temperature spent a disk read before saying so. The seam's rule is that an
   * option the provider cannot honour is refused before any I/O, and attachment
   * I/O is I/O. `buildBody` still calls it, so the public method's contract is
   * unchanged for its direct callers.
   */
  validateOptions(request: LlmRequest): void {
    const entry = this.catalog(request.model)
    const maxTokens = this.capFor(entry, request)
    if (request.temperature !== undefined && !entry.sampling) {
      throw new LlmError('UNSUPPORTED_OPTION', `Anthropic model "${request.model}" does not accept a temperature (the API returns 400 for any non-default value)`)
    }
    if (request.maxTokens !== undefined && request.maxTokens > entry.maxOutputTokens) {
      throw new LlmError('UNSUPPORTED_OPTION', `Anthropic model "${request.model}" caps output at ${entry.maxOutputTokens} tokens, but the request asks for ${request.maxTokens}`)
    }
    const effort = request.reasoningEffort
    if (effort === undefined) return
    if (!entry.efforts.includes(effort)) {
      throw new LlmError('UNSUPPORTED_REASONING_EFFORT', `Anthropic model "${request.model}" does not support reasoning effort "${effort}" (one of ${entry.efforts.join(', ')})`)
    }
    if (entry.thinking === 'manual' && effort !== 'off') {
      const budget = MANUAL_BUDGETS[effort]!
      // Only an EXPLICIT cap can be too small: `capFor` sizes an implicit one to
      // fit. Refuse rather than shrink the budget the caller asked for.
      if (budget >= maxTokens) {
        throw new LlmError('UNSUPPORTED_OPTION', `reasoning effort "${effort}" on "${request.model}" needs max_tokens above ${budget}, got ${maxTokens}`)
      }
    }
  }

  /**
   * The wire body, or an `LlmError` for an option this model cannot honour —
   * decided BEFORE the key is read or a byte is sent, so the log's request is
   * the provider's request. `images` carries whatever the caller resolved; an
   * empty map means every image serializes as its own stored descriptor.
   */
  buildBody(request: LlmRequest, images: ImageBytes = new Map()): Record<string, unknown> {
    this.validateOptions(request)
    const entry = this.catalog(request.model)
    if (request.temperature !== undefined && !entry.sampling) {
      throw new LlmError('UNSUPPORTED_OPTION', `Anthropic model "${request.model}" does not accept a temperature (the API returns 400 for any non-default value)`)
    }
    if (request.maxTokens !== undefined && request.maxTokens > entry.maxOutputTokens) {
      throw new LlmError('UNSUPPORTED_OPTION', `Anthropic model "${request.model}" caps output at ${entry.maxOutputTokens} tokens, but the request asks for ${request.maxTokens}`)
    }
    const maxTokens = this.capFor(entry, request)
    const effort = request.reasoningEffort
    let thinking: Record<string, unknown> = {}
    if (effort !== undefined) {
      if (!entry.efforts.includes(effort)) {
        throw new LlmError('UNSUPPORTED_REASONING_EFFORT', `Anthropic model "${request.model}" does not support reasoning effort "${effort}" (one of ${entry.efforts.join(', ')})`)
      }
      if (entry.thinking === 'adaptive') {
        thinking = effort === 'off' ? { thinking: { type: 'disabled' } } : { output_config: { effort } }
      } else if (effort !== 'off') {
        const budget = MANUAL_BUDGETS[effort]!
        // Only an EXPLICIT cap can be too small now: `capFor` sizes an implicit
        // one to fit. Refuse rather than shrink the budget the caller asked for.
        if (budget >= maxTokens) {
          throw new LlmError('UNSUPPORTED_OPTION', `reasoning effort "${effort}" on "${request.model}" needs max_tokens above ${budget}, got ${maxTokens}`)
        }
        thinking = { thinking: { type: 'enabled', budget_tokens: budget } }
      }
    }
    const tools = serializeTools(request.tools)
    return {
      model: request.model,
      max_tokens: maxTokens,
      stream: true,
      // One automatic breakpoint at the last cacheable block: the conversation
      // prefix is served from the provider's cache on every later request.
      cache_control: { type: 'ephemeral' },
      ...(request.system && request.system.length > 0 ? { system: request.system } : {}),
      messages: serializeMessages(request.messages, images),
      ...(tools ? { tools } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...thinking,
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    // Order matters and the panel that found it was right: options first (no
    // I/O), then the attachment reads, then serialization. Resolving first would
    // read megabytes off disk for a request that was going to be refused for an
    // illegal temperature.
    this.validateOptions(request)
    const images = await resolveRequestImages(request.messages, {
      takesImages: this.catalog(request.model).modalities.includes('image'),
      attachments: this.options.resolveAttachments?.(),
      provider: this.provider,
      model: request.model,
    })
    const body = this.buildBody(request, images)
    const apiKey = this.options.resolveKey()
    if (!apiKey || apiKey.trim().length === 0) {
      throw new LlmError('MISSING_CREDENTIAL', `Anthropic API key not set (expected credential ${this.options.apiKeyRef})`)
    }

    const idle = new AbortController()
    const combined = request.signal ? AbortSignal.any([idle.signal, request.signal]) : idle.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const resetIdle = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new LlmError('TIMEOUT', 'Anthropic stream idle timeout')), IDLE_TIMEOUT_MS)
    }

    let response: Response
    try {
      resetIdle()
      response = await fetch(`${this.options.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
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
      throw new LlmError('TRANSPORT', 'Anthropic response had no body')
    }

    const translator = new AnthropicTranslator()
    try {
      for await (const event of parseNamedSse(response.body, resetIdle)) {
        for (const chunk of translator.push(event.event, parseWireEvent(event.data))) yield chunk
        if (translator.complete) break
      }
    } catch (error) {
      throw mapAbort(error, request.signal, idle.signal)
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!translator.complete) throw new LlmError('STREAM_CLOSED', 'Anthropic stream ended without message_stop')
    for (const chunk of translator.finalize()) yield chunk
  }
}

function mapAbort(error: unknown, caller: AbortSignal | undefined, idle: AbortSignal): LlmError {
  if (error instanceof LlmError) return error
  if (caller?.aborted) return new LlmError('ABORTED', 'request aborted by caller')
  if (idle.aborted) return new LlmError('TIMEOUT', 'Anthropic stream idle timeout')
  return new LlmError('TRANSPORT', error instanceof Error ? error.message : String(error))
}

/** HTTP failures, as codes; the body's own `error.type` decides where the status is ambiguous. */
export function classifyHttp(status: number, body: string, headers: Headers): LlmError {
  let message = body.slice(0, 500)
  let type: string | undefined
  let detailCode: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string; details?: { error_code?: string } } }
    if (parsed.error?.message) message = parsed.error.message
    type = parsed.error?.type
    detailCode = parsed.error?.details?.error_code
  } catch {
    // Non-JSON error body; keep the truncated text.
  }
  const requestId = headers.get('request-id') ?? undefined
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const options = { status, ...(requestId ? { requestId } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  let code: LlmErrorCode
  // Two real 400 forms mean overflow: the input alone exceeding the window, and
  // input + max_tokens exceeding it. Only the first says "prompt is too long".
  if (status === 400 && /prompt is too long|context window|context limit|exceed context|too many tokens/i.test(message)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 && /temperature|top_p|top_k|is deprecated for this model|not supported for this model/i.test(message)) code = 'UNSUPPORTED_OPTION'
  else if (status === 401 || status === 403) code = 'AUTH'
  else if (status === 402) code = 'QUOTA'
  else if (status === 404) code = 'UNKNOWN_MODEL'
  else if (status === 429) code = detailCode === 'enforced_spend_limit_reached' ? 'QUOTA' : 'RATE_LIMIT'
  else if (status === 504) code = 'TIMEOUT'
  else if (status >= 500) code = 'SERVER'
  else code = type === undefined ? 'INVALID_REQUEST' : errorCode(type) === 'SERVER' ? 'INVALID_REQUEST' : errorCode(type)
  return new LlmError(code, `Anthropic ${status}: ${message}`, options)
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}
