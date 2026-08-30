import { LlmError, type LlmAdapter, type LlmErrorCode, type LlmRequest, type ModelInfo, type ResolvedModel, type StreamChunk } from '../../core/llm/index.ts'
import { parseSse } from './sse.ts'
import { DeepSeekTranslator, parseWireChunk } from './translate.ts'
import { serializeMessages, serializeTools } from './serialize.ts'

export const DEEPSEEK_PROVIDER = 'deepseek'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_MAX_TOKENS = 8192
const IDLE_TIMEOUT_MS = 300_000
const USER_AGENT = 'minidsh/0.1.0 (+https://github.com/earthwalker17/MiniDSH)'
/**
 * DeepSeek's own vocabulary. The provider silently maps `medium` and `xhigh`
 * to `high`; the adapter refuses them instead, because a request the log
 * records must be the request the provider served.
 */
const EFFORTS = ['off', 'low', 'high', 'max'] as const

const MODELS: readonly ModelInfo[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp' },
]

/** The one model that takes images; every other id — catalogued or not — is text only. */
const VISION_MODELS: ReadonlySet<string> = new Set(['deepseek-v4-flash-vision-exp'])

export interface DeepSeekAdapterOptions {
  /** The credential's NAME, for error messages; never the value. */
  readonly apiKeyRef: string
  /** Called per request, so a rotated key takes effect without a reload. */
  readonly resolveKey: () => string | undefined
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
    return MODELS
  }

  /** An uncatalogued id is accepted as text-only under the deployment defaults: the catalog is advisory, never a gate. */
  resolveModel(model: string): ResolvedModel {
    return {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: this.options.defaultMaxTokens,
      reasoning: { efforts: EFFORTS, defaultEffort: 'high' },
      inputModalities: VISION_MODELS.has(model) ? ['text', 'image'] : ['text'],
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    // Options first, before any I/O: an effort outside the vocabulary is
    // refused rather than handed to a provider that would quietly alias it.
    if (request.reasoningEffort !== undefined && !(EFFORTS as readonly string[]).includes(request.reasoningEffort)) {
      throw new LlmError('UNSUPPORTED_REASONING_EFFORT', `DeepSeek does not support reasoning effort "${request.reasoningEffort}" (one of ${EFFORTS.join(', ')})`)
    }
    const apiKey = this.options.resolveKey()
    if (!apiKey || apiKey.trim().length === 0) {
      throw new LlmError('MISSING_CREDENTIAL', `DeepSeek API key not set (expected credential ${this.options.apiKeyRef})`)
    }
    const wire = {
      model: request.model,
      messages: serializeMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens ?? this.options.defaultMaxTokens,
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

function classifyHttp(status: number, body: string, headers: Headers): LlmError {
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
