import { LlmError, type LlmAdapter, type LlmErrorCode, type LlmRequest, type ModelInfo, type ModelModality, type ResolvedModel, type StreamChunk } from '../../core/llm/index.ts'
import { isHeaderSafe } from '../../core/credentials/index.ts'
import { readErrorBody, redactLlmError } from '../../core/llm/wire.ts'
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
// No version in it, for the reason the sibling adapter gives: one version string, in package.json.
const USER_AGENT = 'minidsh (+https://github.com/earthwalker17/MiniDSH)'

/** A `thinking.type` the API accepts, as `capabilities.thinking.types` lists them. */
export type ThinkingType = 'enabled' | 'adaptive' | 'disabled'

/**
 * One model's facts. The first five fields are the `GET /v1/models` listing's
 * own (`max_input_tokens`, `max_tokens`, `capabilities.effort`,
 * `capabilities.thinking.types`, `capabilities.image_input`), so the drift
 * probe compares them one for one (`catalog.e2e.test.ts`). The effort
 * vocabulary MiniDSH offers is DERIVED from them, never listed beside them:
 * `off` exactly where `disabled` is accepted, the API's own levels where the
 * model takes an effort, and the budget names where it takes neither.
 */
export interface CatalogModel extends ModelInfo {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  /** The levels `output_config.effort` takes; empty where the model takes no effort. */
  readonly effortLevels: readonly string[]
  /** `adaptive` means effort steers thinking; without it a model thinks only on a budget (`enabled`). */
  readonly thinkingTypes: readonly ThinkingType[]
  /**
   * Whether the model thinks when the request sends no `thinking` field — the
   * one fact here the listing does not give, so it is MEASURED, paid: Opus 5
   * at effort `high` with no field thought; Opus 4.8 at `max` with no field
   * used 0 thinking tokens, and 2,723 with `{type:'adaptive'}`. Where it is
   * false the adapter sends `adaptive` beside a named effort, or the logged
   * effort would be served without reasoning.
   */
  readonly thinksUnasked: boolean
  /** What the model serves when the request names no effort, in MiniDSH's vocabulary (`off`: no thinking). */
  readonly defaultEffort?: string
  /** Whether `temperature` is honoured; the 5 family and 4.7+ return 400 for any non-default value. */
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
const FIVE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const FOUR_LEVELS = ['low', 'medium', 'high', 'max'] as const
const ADAPTIVE_ONLY: readonly ThinkingType[] = ['adaptive']
const ADAPTIVE_OR_OFF: readonly ThinkingType[] = ['adaptive', 'disabled']
const BUDGET_OR_OFF: readonly ThinkingType[] = ['enabled', 'disabled']
/** Budgets for a budget-thinking model's effort ids; each must stay below `max_tokens`. */
const MANUAL_BUDGETS: Readonly<Record<string, number>> = { low: 2048, medium: 4096, high: 6144, max: 24_576 }
/** The effort ids of a budget-thinking model that takes no effort of its own (Haiku and Sonnet 4.5). */
const BUDGET_EFFORTS = ['low', 'high', 'max'] as const

/**
 * Verified against the live `GET /v1/models` on 2026-10-25, reading each
 * model's own `max_input_tokens`, `max_tokens`, `capabilities.effort`,
 * `.thinking.types` and `.image_input`; the default efforts are the API
 * reference's (high, except `medium` on Opus 5.5 and Haiku 5.5). Other
 * values are MEASURED provider answers, not doc readings: `temperature` is
 * "deprecated for this model" on 4-7 and 4-8 and accepted by 4-6 and the 4.5
 * rows; `thinking.type.disabled` "is not supported" on Opus 5.5.
 */
const CATALOG: readonly CatalogModel[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_ONLY, thinksUnasked: true, defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_ONLY, thinksUnasked: true, defaultEffort: 'medium', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_ONLY, thinksUnasked: true, defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_OR_OFF, thinksUnasked: true, defaultEffort: 'medium', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-fable-5', name: 'Claude Fable 5', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_ONLY, thinksUnasked: true, defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_OR_OFF, thinksUnasked: true, defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_OR_OFF, thinksUnasked: true, defaultEffort: 'high', sampling: false, modalities: TEXT_AND_IMAGE },
  // The 4 family, which one prefix could never have expressed: its members
  // disagree about the window, the output cap, the effort set, whether they
  // take a temperature AND whether they think unasked. None of 4.6–4.8 does,
  // so each serves `off` when nothing is named.
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_OR_OFF, thinksUnasked: false, defaultEffort: 'off', sampling: false, modalities: TEXT_AND_IMAGE },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_OR_OFF, thinksUnasked: false, defaultEffort: 'off', sampling: false, modalities: TEXT_AND_IMAGE },
  // 4.6 still accepts a budget (`enabled`, deprecated); adaptive is how it is driven here.
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FOUR_LEVELS, thinkingTypes: ['enabled', 'adaptive', 'disabled'], thinksUnasked: false, defaultEffort: 'off', sampling: true, modalities: TEXT_AND_IMAGE },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: FOUR_LEVELS, thinkingTypes: ['enabled', 'adaptive', 'disabled'], thinksUnasked: false, defaultEffort: 'off', sampling: true, modalities: TEXT_AND_IMAGE },
  // Opus 4.5 has an effort but no adaptive thinking: it thinks only on a
  // budget, and its effort sets the token spend beside it.
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200_000, maxOutputTokens: 64_000, effortLevels: ['low', 'medium', 'high'], thinkingTypes: BUDGET_OR_OFF, thinksUnasked: false, defaultEffort: 'off', sampling: true, modalities: TEXT_AND_IMAGE },
  // 200K, not 1M: the larger window needs a beta header MiniDSH does not send.
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 64_000, effortLevels: [], thinkingTypes: BUDGET_OR_OFF, thinksUnasked: false, defaultEffort: 'off', sampling: true, modalities: TEXT_AND_IMAGE },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutputTokens: 64_000, effortLevels: [], thinkingTypes: BUDGET_OR_OFF, thinksUnasked: false, defaultEffort: 'off', sampling: true, modalities: TEXT_AND_IMAGE },
]

/**
 * An id's MINOR version: `claude-<family>-<major>[-<minor>]`, any 8-digit date
 * snapshot dropped. `claude-opus-4-5-20251101`, `claude-opus-4-5` and
 * `claude-opus-4-5-20990101` share one; `claude-opus-5-5` and `claude-opus-5`
 * do not.
 *
 * Family granularity was the S19 rule and it rotted on the first new
 * generation: `claude-opus-5-5` inherited Opus 5's row, including `off`,
 * which it answers with a 400. Members of one family disagree about exactly
 * the facts that matter — the window, the effort set, whether thinking can be
 * disabled — so only the same minor version, or a dated snapshot of it, may
 * borrow a row.
 */
function versionKey(id: string): string | undefined {
  const match = /^(claude-[a-z]+-\d+)(-\d{1,2})?(?:-\d{8})?$/u.exec(id)
  return match ? `${match[1]}${match[2] ?? ''}` : undefined
}

/** The catalogued row an id answers to — exact, or the same minor version — or `undefined` when none does. */
export function catalogRowFor(id: string): CatalogModel | undefined {
  const exact = CATALOG.find((entry) => entry.id === id)
  if (exact) return exact
  const key = versionKey(id)
  const known = key === undefined ? undefined : CATALOG.find((entry) => versionKey(entry.id) === key)
  return known ? { ...known, id, name: id } : undefined
}

/** The snapshot, for the live drift probe that holds it to `GET /v1/models`. */
export function anthropicCatalog(): readonly CatalogModel[] {
  return CATALOG
}

/**
 * An id no row answers to: the current generation's thinking shape, no
 * sampling, a conservative window — and no output cap of ours, and images.
 *
 * The cap is the sibling adapters' rule: one would be a guess, and a guessed
 * cap refusing what the provider serves is worse than none — the old 8192
 * refused `maxTokens: 16000` before any I/O for models that serve 128K. The
 * deployment default applies and the provider judges. Images and `off` are
 * permissive for the reason the asymmetry gives: every model Anthropic serves
 * takes images, so a wrong ALLOW costs one provider 400 that names itself,
 * while a wrong REFUSE makes a capability unreachable with no override. The
 * sibling DeepSeek adapter makes the opposite call for the opposite reason:
 * there, one known id has vision and an unknown one almost certainly does not.
 */
function unlisted(id: string): CatalogModel {
  return { id, name: id, contextWindow: 200_000, maxOutputTokens: Number.POSITIVE_INFINITY, effortLevels: FIVE_LEVELS, thinkingTypes: ADAPTIVE_OR_OFF, thinksUnasked: true, sampling: false, modalities: TEXT_AND_IMAGE }
}

const adaptive = (entry: CatalogModel): boolean => entry.thinkingTypes.includes('adaptive')

/** MiniDSH's effort vocabulary for a row, derived from what the listing says it accepts. */
function effortsOf(entry: CatalogModel): readonly string[] {
  const levels = adaptive(entry) || entry.effortLevels.length > 0 ? entry.effortLevels : BUDGET_EFFORTS
  return entry.thinkingTypes.includes('disabled') ? ['off', ...levels] : [...levels]
}

/** Whether a request at `effort` runs with thinking on. */
function thinks(entry: CatalogModel, effort: string | undefined): boolean {
  if (effort === undefined) return entry.thinksUnasked
  return effort !== 'off'
}

export interface AnthropicAdapterOptions {
  /** The credential's NAME, for error messages; never the value. */
  readonly apiKeyRef: string
  /** Called per request, so a rotated key takes effect without a reload. */
  readonly resolveKey: () => string | undefined
  /** Where the key would be looked for, for the refusal that names the fix; absent falls back to naming the reference alone. */
  readonly describeKey?: () => string
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
    return catalogRowFor(model) ?? unlisted(model)
  }

  /**
   * The output cap for a request. A named effort on a budget-thinking model
   * needs room for its budget AND an answer, so a caller who named an effort
   * but no cap gets one large enough to honour it — refusing here would make
   * an effort this adapter advertises unusable at its own default.
   */
  private capFor(entry: CatalogModel, request: LlmRequest): number {
    if (request.maxTokens !== undefined) return request.maxTokens
    const base = Math.min(this.options.defaultMaxTokens, entry.maxOutputTokens)
    const budget = !adaptive(entry) && request.reasoningEffort !== undefined ? MANUAL_BUDGETS[request.reasoningEffort] : undefined
    return budget === undefined ? base : Math.min(entry.maxOutputTokens, Math.max(base, budget + base))
  }

  resolveModel(model: string): ResolvedModel {
    const entry = this.catalog(model)
    return {
      contextWindow: entry.contextWindow,
      defaultMaxTokens: Math.min(this.options.defaultMaxTokens, entry.maxOutputTokens),
      reasoning: { efforts: effortsOf(entry), ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }) },
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
    const efforts = effortsOf(entry)
    if (effort !== undefined && !efforts.includes(effort)) {
      throw new LlmError('UNSUPPORTED_REASONING_EFFORT', `Anthropic model "${request.model}" does not support reasoning effort "${effort}" (one of ${efforts.join(', ')})`)
    }
    // Measured on Haiku 4.5 with a 1024 budget: 400 "`temperature` may only be
    // set to 1 when thinking is enabled". The rule names thinking, not its
    // shape, so it holds for the adaptive field this adapter adds on 4.6 too.
    if (request.temperature !== undefined && thinks(entry, effort)) {
      throw new LlmError(
        'UNSUPPORTED_OPTION',
        `Anthropic model "${request.model}" refuses a temperature while thinking, which reasoning effort "${effort ?? entry.defaultEffort ?? 'default'}" turns on: set the effort to "off", or route the session to a model that honours a temperature (a recorded temperature cannot be cleared)`,
      )
    }
    if (!adaptive(entry) && effort !== undefined && effort !== 'off') {
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
    // Every refusal lives in `validateOptions` and nowhere else. Keeping a
    // second copy here would mean the next change to a rule — a family that
    // accepts temperature, a different budget table — has two sites and the
    // compiler flags neither if only one is edited.
    this.validateOptions(request)
    const entry = this.catalog(request.model)
    const maxTokens = this.capFor(entry, request)
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
      ...thinkingBody(entry, request.reasoningEffort),
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
      const where = this.options.describeKey?.()
      throw new LlmError('MISSING_CREDENTIAL', `Anthropic API key not set (expected credential ${this.options.apiKeyRef}${where === undefined ? '' : `: set ${where}`})`)
    }
    // Refused by reference, never by value: the platform's error for a bad
    // header quotes it, and an error message is logged (`isHeaderSafe`).
    if (!isHeaderSafe(apiKey)) {
      throw new LlmError('INVALID_CREDENTIAL', `Anthropic API key in credential ${this.options.apiKeyRef} contains characters no HTTP header can carry`)
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
      response = await fetch(`${this.options.baseURL.replace(/\/+$/, '')}/v1/messages`, {
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
      throw redactLlmError(mapAbort(error, request.signal, idle.signal), apiKey)
    }

    if (!response.ok) {
      // The watchdog stays armed through the error body: one that stalls after
      // its headers would otherwise hang a run nobody can cancel. Read only to
      // its cap — the status classifies — and redacted, as every error is once
      // the key is resolved: a proxy that echoes it would put it in the log.
      const text = await readErrorBody(response)
      if (timer) clearTimeout(timer)
      throw redactLlmError(classifyHttp(response.status, text, response.headers), apiKey)
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
      throw redactLlmError(mapAbort(error, request.signal, idle.signal), apiKey)
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!translator.complete) throw new LlmError('STREAM_CLOSED', 'Anthropic stream ended without message_stop')
    for (const chunk of translator.finalize()) yield chunk
  }
}

/**
 * The thinking fields for an effort, per the row:
 * - `off` is `{type:'disabled'}` on an adaptive model, and nothing on a budget
 *   model (where nothing already means no thinking);
 * - an adaptive model gets `output_config.effort`, plus `{type:'adaptive'}`
 *   when it does not think unasked (4.6–4.8: the effort alone was served with
 *   0 thinking tokens);
 * - a budget model gets `{type:'enabled', budget_tokens}`, plus its own effort
 *   where it has one (Opus 4.5).
 * No effort named sends nothing: the row's `defaultEffort` says what that serves.
 */
function thinkingBody(entry: CatalogModel, effort: string | undefined): Record<string, unknown> {
  if (effort === undefined) return {}
  if (effort === 'off') return adaptive(entry) ? { thinking: { type: 'disabled' } } : {}
  if (adaptive(entry)) return { ...(entry.thinksUnasked ? {} : { thinking: { type: 'adaptive' } }), output_config: { effort } }
  return { thinking: { type: 'enabled', budget_tokens: MANUAL_BUDGETS[effort]! }, ...(entry.effortLevels.includes(effort) ? { output_config: { effort } } : {}) }
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
