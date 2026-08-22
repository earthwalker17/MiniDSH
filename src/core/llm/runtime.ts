import { type Context, type Disposer, type Plugin, serviceKey, waterfallEvent } from '../../kernel/index.ts'
import { LlmError, type LlmAdapter, type LlmRequest, type ResolvedModel, type StreamChunk } from './types.ts'

/** The adapter registry and provider-neutral stream service. */
export interface Llm {
  registerAdapter(owner: Context, adapter: LlmAdapter): Disposer
  hasProvider(provider: string): boolean
  resolveModel(provider: string, model: string): ResolvedModel
  stream(request: LlmRequest): AsyncIterable<StreamChunk>
}

export const LLM = serviceKey<Llm>('llm')

/**
 * `llm/stream` is around-middleware over one provider attempt. The terminal
 * continuation performs adapter lookup, so listeners (record, replay) can
 * short-circuit or reroute. Retry is NOT here — it lives on `agent/request-error`.
 */
export const LLM_STREAM = waterfallEvent<[request: LlmRequest], AsyncIterable<StreamChunk>>('llm/stream')

class LlmRuntime implements Llm {
  private readonly adapters = new Map<string, LlmAdapter>()
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  registerAdapter(owner: Context, adapter: LlmAdapter): Disposer {
    if (this.adapters.has(adapter.provider)) {
      throw new LlmError('DUPLICATE_ADAPTER', `an adapter for provider "${adapter.provider}" is already registered`)
    }
    this.adapters.set(adapter.provider, adapter)
    return owner.effect(() => () => {
      if (this.adapters.get(adapter.provider) === adapter) this.adapters.delete(adapter.provider)
    }, `llm.adapter("${adapter.provider}")`)
  }

  hasProvider(provider: string): boolean {
    return this.adapters.has(provider)
  }

  resolveModel(provider: string, model: string): ResolvedModel {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new LlmError('UNKNOWN_PROVIDER', `no adapter for provider "${provider}"`)
    return adapter.resolveModel(model)
  }

  stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    const inner = (): AsyncIterable<StreamChunk> => this.adapterStream(request)
    const composed = this.ctx.waterfall(LLM_STREAM, request, inner)
    return validateStream(composed)
  }

  /** One provider attempt. Adapter throws become a terminal finish; consumer/middleware throws propagate. */
  private async *adapterStream(request: LlmRequest): AsyncIterable<StreamChunk> {
    const adapter = this.adapters.get(request.provider)
    if (!adapter) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `no adapter for provider "${request.provider}"`, code: 'NO_ADAPTER' } } }
      return
    }
    try {
      for await (const chunk of adapter.stream(request)) yield chunk
    } catch (error) {
      yield adapterFailureChunk(error, request.signal)
    }
  }
}

function adapterFailureChunk(error: unknown, signal: AbortSignal | undefined): StreamChunk {
  const aborted = signal?.aborted === true || (error instanceof LlmError && error.code === 'ABORTED')
  const failure =
    error instanceof LlmError
      ? error.failure
      : { message: error instanceof Error ? error.message : String(error), code: aborted ? 'ABORTED' : 'TRANSPORT' }
  return { type: 'finish', reason: aborted ? { kind: 'aborted', failure } : { kind: 'error', failure } }
}

/**
 * Enforces the three stream-protocol invariants on the final stream: deltas
 * only into open blocks, usage before finish, and exactly one terminal finish.
 * A violation is a bug in an adapter or middleware and throws.
 */
async function* validateStream(source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const open = new Map<number, StreamChunk & { type: 'block-start' }>()
  let usageSeen = false
  let finished = false
  for await (const chunk of source) {
    if (finished) throw new LlmError('PROTOCOL_VIOLATION', `chunk "${chunk.type}" after finish`)
    switch (chunk.type) {
      case 'block-start':
        if (open.has(chunk.index)) throw new LlmError('PROTOCOL_VIOLATION', `block index ${chunk.index} opened twice`)
        open.set(chunk.index, chunk)
        break
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-delta':
        // Deltas may implicitly open a block (delta-only protocols); no assertion needed.
        break
      case 'block-end':
        open.delete(chunk.index)
        break
      case 'usage':
        if (usageSeen) throw new LlmError('PROTOCOL_VIOLATION', 'usage reported twice')
        usageSeen = true
        break
      case 'finish':
        finished = true
        break
    }
    yield chunk
  }
  if (!finished) throw new LlmError('PROTOCOL_VIOLATION', 'stream ended without a finish chunk')
}

/** The LLM seam plugin: provides `ctx.llm`. */
export const llmPlugin: Plugin = {
  name: 'core-llm',
  apply(ctx) {
    ctx.provide(LLM, new LlmRuntime(ctx))
  },
}
