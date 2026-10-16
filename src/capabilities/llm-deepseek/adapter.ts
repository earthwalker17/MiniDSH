import { LlmError, type LlmAdapter, type LlmErrorCode, type LlmRequest, type ModelInfo, type ModelModality, type ResolvedModel, type StreamChunk } from '../../core/llm/index.ts'
import { parseSse } from './sse.ts'
import { DeepSeekTranslator, parseWireChunk } from './translate.ts'
import type { Attachments } from '../../core/attachments/index.ts'
import { resolveRequestImages } from '../../core/llm/content.ts'
import { serializeMessages, serializeTools } from './serialize.ts'

export const DEEPSEEK_PROVIDER = 'deepseek'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MAX_TOKENS = 8192
const IDLE_TIMEOUT_MS = 300_000
// No version in it: `package.json` is the one string that knows, and a
// capability may not read the app's copy of it. A second spelling here would
// say `0.1.0` to the provider for the life of 1.x.
const USER_AGENT = 'minidsh (+https://github.com/earthwalker17/MiniDSH)'
/**
 * DeepSeek's own vocabulary. The provider silently maps `medium` and `xhigh`
 * to `high`; the adapter refuses them instead, because a request the log
 * records must be the request the provider served.
 */
const EFFORTS = ['off', 'low', 'high', 'max'] as const

interface CatalogModel extends ModelInfo {
  /** Input and output together: DeepSeek's `context_window` counts both. */
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly modalities: readonly ModelModality[]
}

/**
 * A snapshot, dated, and held honest by a live drift probe rather than
 * fetched (`catalog.e2e.test.ts`; ARCHITECTURE §5): `resolveModel` is
 * synchronous and feeds admission and metering, every step's facts are
 * recorded in `request/context` so a replay never asks, and DeepSeek documents
 * the rich `GET /models` fields as optional and unversioned.
 *
 * Measured 2026-10-16 against `GET /models` and real requests. `deepseek-flash`
 * (DeepSeek-V4.1-Flash) reads an image in a user message AND inside a tool
 * message, which is where every image MiniDSH produces lives.
 * `deepseek-v4-pro` accepts an image block and ignores it — a confident wrong
 * answer from 24 prompt tokens, and "the image couldn't be displayed" inside a
 * tool message — so admission is this catalog's decision, never the
 * provider's. A `max_tokens` above 393,216 is a 400 naming the range.
 */
const CATALOG: readonly CatalogModel[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxOutputTokens: 393_216, modalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_048_576, maxOutputTokens: 393_216, modalities: ['text'] },
]

/**
 * Retired names DeepSeek still answers to, and what serves them. Both `v4-flash`
 * ids are served AS `deepseek-flash` (the response's `model`; "temporarily
 * routed", no end date, changelog 2026-09-10) and read images correctly, so they
 * take its facts, images included. Unlisted, because a catalog should not offer
 * a name its provider has retired; the log still records the REQUESTED id.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

/**
 * An id this snapshot does not know: conservative on every axis it could get
 * wrong. Text only, because a model that ignores an image says nothing about
 * it (`deepseek-v4-pro`, above); a window that makes compaction act early
 * rather than an overflow the meter never saw coming; the deployment's default
 * output cap. Today the provider refuses any such id with a 400 naming the two
 * it serves (`UNKNOWN_MODEL`), so this matters for the model it ships next.
 */
const UNLISTED = { contextWindow: 131_072, maxOutputTokens: 8192, modalities: ['text'] as readonly ModelModality[] }

/** The snapshot, for the live drift probe that holds it to `GET /models`. */
export function deepseekCatalog(): readonly CatalogModel[] {
  return CATALOG
}

export interface DeepSeekAdapterOptions {
  /** The credential's NAME, for error messages; never the value. */
  readonly apiKeyRef: string
  /** Called per request, so a rotated key takes effect without a reload. */
  readonly resolveKey: () => string | undefined
  /** Where the key would be looked for, for the refusal that names the fix; absent falls back to naming the reference alone. */
  readonly describeKey?: () => string
  /**
   * The mounted attachment store, read per request for the same reason the key
   * is. Absent is legal and means this deployment stores no attachments.
   */
  readonly resolveAttachments?: () => Attachments | undefined
  readonly baseURL: string
  readonly defaultMaxTokens: number
}

/** Direct fetch + SSE adapter for the DeepSeek OpenAI-compatible chat API. */
export class DeepSeekAdapter implements LlmAdapter {
  readonly provider = DEEPSEEK_PROVIDER
  private readonly options: DeepSeekAdapterOptions
  constructor(options: DeepSeekAdapterOptions) {
    this.options = options
  }

  listModels(): readonly ModelInfo[] {
    return CATALOG.map(({ id, name }) => ({ id, name }))
  }

  /** The facts for an id: its row, its alias's row, or the conservative unlisted ones. */
  private catalog(model: string): Omit<CatalogModel, 'id' | 'name'> {
    const id = ALIASES[model] ?? model
    return CATALOG.find((entry) => entry.id === id) ?? UNLISTED
  }

  /** The output cap a request gets when it names none: the deployment default, never above the model's own. */
  private capFor(model: string): number {
    return Math.min(this.options.defaultMaxTokens, this.catalog(model).maxOutputTokens)
  }

  resolveModel(model: string): ResolvedModel {
    const entry = this.catalog(model)
    return {
      contextWindow: entry.contextWindow,
      defaultMaxTokens: this.capFor(model),
      reasoning: { efforts: EFFORTS, defaultEffort: 'high' },
      inputModalities: entry.modalities,
    }
  }

  /**
   * Every option refusal, and nothing else: no I/O. Split out for the reason
   * the sibling adapter gives — an image read before an option refusal is the
   * very I/O the rule exists to avoid.
   */
  validateOptions(request: LlmRequest): void {
    // An effort outside the vocabulary is refused rather than handed to a
    // provider that would quietly alias it.
    if (request.reasoningEffort !== undefined && !(EFFORTS as readonly string[]).includes(request.reasoningEffort)) {
      throw new LlmError('UNSUPPORTED_REASONING_EFFORT', `DeepSeek does not support reasoning effort "${request.reasoningEffort}" (one of ${EFFORTS.join(', ')})`)
    }
    const cap = this.catalog(request.model).maxOutputTokens
    if (request.maxTokens !== undefined && request.maxTokens > cap) {
      throw new LlmError('UNSUPPORTED_OPTION', `DeepSeek model "${request.model}" caps output at ${cap} tokens, but the request asks for ${request.maxTokens}`)
    }
    // Thinking is on unless the effort is `off`, and in thinking mode the
    // provider ignores `temperature` without a word (its own docs): a request
    // whose log says 0.2 would be served at the default. Both ways out are the
    // caller's to choose, so the refusal names them.
    if (request.temperature !== undefined && request.reasoningEffort !== 'off') {
      throw new LlmError(
        'UNSUPPORTED_OPTION',
        `DeepSeek ignores temperature while thinking, which is on unless reasoning effort is "off"; set the effort to "off" or drop the temperature`,
      )
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    // Options first, before any I/O; attachment reads come after, because
    // reading bytes for a request that was going to be refused anyway is
    // exactly the I/O this rule exists to avoid.
    this.validateOptions(request)
    const images = await resolveRequestImages(request.messages, {
      takesImages: this.catalog(request.model).modalities.includes('image'),
      attachments: this.options.resolveAttachments?.(),
      provider: this.provider,
      model: request.model,
    })
    const apiKey = this.options.resolveKey()
    if (!apiKey || apiKey.trim().length === 0) {
      // The first failure a fresh install meets, so it names BOTH places a key
      // may go — the store is the only thing that knows its own layers.
      const where = this.options.describeKey?.()
      throw new LlmError('MISSING_CREDENTIAL', `DeepSeek API key not set (expected credential ${this.options.apiKeyRef}${where === undefined ? '' : `: set ${where}`})`)
    }
    const wire = {
      model: request.model,
      messages: serializeMessages(request.system, request.messages, images),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens ?? this.capFor(request.model),
      ...reasoningBody(request.reasoningEffort),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(() => {
        const tools = serializeTools(request.tools)
        return tools ? { tools } : {}
      })(),
    }

    const idle = new AbortController()
    const combined = request.signal ? AbortSignal.any([idle.signal, request.signal]) : idle.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const resetIdle = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new LlmError('TIMEOUT', 'DeepSeek stream idle timeout')), IDLE_TIMEOUT_MS)
    }

    let response: Response
    try {
      resetIdle()
      response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(wire),
        signal: combined,
      })
    } catch (error) {
      if (timer) clearTimeout(timer)
      throw mapAbort(error, request.signal, idle.signal)
    }

    if (!response.ok) {
      if (timer) clearTimeout(timer)
      const body = await response.text().catch(() => '')
      throw classifyHttp(response.status, body, response.headers)
    }
    if (!response.body) {
      if (timer) clearTimeout(timer)
      throw new LlmError('TRANSPORT', 'DeepSeek response had no body')
    }

    const translator = new DeepSeekTranslator()
    try {
      for await (const data of parseSse(response.body, resetIdle)) {
        if (data === '[DONE]') {
          for (const chunk of translator.finalize()) yield chunk
          return
        }
        for (const chunk of translator.push(parseWireChunk(data))) yield chunk
      }
    } catch (error) {
      throw mapAbort(error, request.signal, idle.signal)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

function reasoningBody(effort: string | undefined): Record<string, unknown> {
  if (effort === undefined) return {}
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'enabled' }, reasoning_effort: effort }
}

function mapAbort(error: unknown, caller: AbortSignal | undefined, idle: AbortSignal): LlmError {
  if (error instanceof LlmError) return error
  if (caller?.aborted) return new LlmError('ABORTED', 'request aborted by caller')
  if (idle.aborted) return new LlmError('TIMEOUT', 'DeepSeek stream idle timeout')
  return new LlmError('TRANSPORT', error instanceof Error ? error.message : String(error))
}

export function classifyHttp(status: number, body: string, headers: Headers): LlmError {
  let message = body.slice(0, 500)
  let providerCode = ''
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } }
    if (parsed.error?.message) message = parsed.error.message
    providerCode = `${parsed.error?.code ?? ''} ${parsed.error?.type ?? ''}`.toLowerCase()
  } catch {
    // Non-JSON error body; keep the truncated text.
  }
  const detail = `${providerCode} ${message}`.toLowerCase()
  const requestId = headers.get('x-request-id') ?? headers.get('x-ds-request-id') ?? undefined
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const options = { status, ...(requestId ? { requestId } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  let code: LlmErrorCode
  if (status === 401 || status === 403) code = 'AUTH'
  // Measured 2026-10-16: "The supported API model names are deepseek-flash,
  // deepseek-v4-pro, but you passed …" — a 400, not a 404.
  else if (status === 400 && detail.includes('supported api model names')) code = 'UNKNOWN_MODEL'
  else if (detail.includes('insufficient') || detail.includes('quota') || detail.includes('balance')) code = 'QUOTA'
  else if (status === 429) code = 'RATE_LIMIT'
  else if (status === 400 && (detail.includes('context') || detail.includes('too long') || detail.includes('maximum'))) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status >= 500) code = 'SERVER'
  else code = 'INVALID_REQUEST'
  return new LlmError(code, `DeepSeek ${status}: ${message}`, options)
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}
