import { type Context, type Disposer, type Plugin, serviceKey, waterfallEvent } from '../../kernel/index.ts'
import { LlmError, type ContentBlockType, type LlmAdapter, type LlmRequest, type ModelInfo, type ResolvedModel, type StreamChunk } from './types.ts'

/**
 * A model as the catalog advertises it: the adapter's own facts plus the
 * context window. The window travels with the catalog because a surface that
 * must meter context (§ `core/metering`) has no other way to learn it — and
 * because it is a model fact, not a runtime one.
 */
export interface ModelCatalogEntry extends ModelInfo {
  readonly contextWindow: number
}

/** One registered provider and the models it advertises. */
export interface ProviderInfo {
  readonly id: string
  readonly models: readonly ModelCatalogEntry[]
}

/** The adapter registry and provider-neutral stream service. */
export interface Llm {
  registerAdapter(owner: Context, adapter: LlmAdapter): Disposer
  hasProvider(provider: string): boolean
  /** The catalog: registered providers with their advertised models (surface handshakes). */
  providers(): ProviderInfo[]
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
    // The adapter registry is deployment-global. A registration from an agent
    // scope would be visible to every agent while that one lived and would
    // collide with the next agent mounting the same preset — refused here, so a
    // preset that reaches for a global registry fails its agent's setup loudly.
    if (owner.scope !== undefined) {
      throw new LlmError('SCOPED_OWNER', `an adapter for provider "${adapter.provider}" cannot be registered from a scoped context; adapters are deployment-global`)
    }
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

  providers(): ProviderInfo[] {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.provider,
      // Enriched here rather than widening `LlmAdapter.listModels`: one adapter
      // method stays the source of the window, and no adapter has to repeat it.
      models: adapter.listModels().map((model) => ({ ...model, contextWindow: adapter.resolveModel(model.id).contextWindow })),
    }))
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
    // A cancellation that lands BEFORE the adapter starts is invisible to it:
    // `addEventListener('abort')` on an already-aborted signal never fires, so
    // an adapter that waits on the event alone would hang the agent forever.
    // The seam already normalizes every other adapter failure into a terminal
    // finish; normalizing this one keeps cancellation a property of the
    // contract rather than of each adapter's diligence.
    if (request.signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted before the provider was called', code: 'ABORTED' } } }
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

const DELTA_BLOCK_TYPE = {
  'text-delta': 'text',
  'reasoning-delta': 'reasoning',
  'tool-call-delta': 'tool-call',
} as const

/**
 * Enforces the stream-protocol invariants on the final stream: a delta may only
 * address an open block of its own type (a first delta implicitly opens one, as
 * delta-only protocols require, but a closed or mistyped block is a violation),
 * usage appears at most once and before finish, and exactly one terminal finish
 * ends the stream. A violation is a bug in an adapter or middleware and throws.
 */
async function* validateStream(source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const open = new Map<number, ContentBlockType>()
  const closed = new Set<number>()
  let usageSeen = false
  let finished = false
  for await (const chunk of source) {
    if (finished) throw new LlmError('PROTOCOL_VIOLATION', `chunk "${chunk.type}" after finish`)
    switch (chunk.type) {
      case 'block-start':
        if (open.has(chunk.index) || closed.has(chunk.index)) throw new LlmError('PROTOCOL_VIOLATION', `block index ${chunk.index} opened twice`)
        open.set(chunk.index, chunk.blockType)
        break
      case 'text-delta':
      case 'reasoning-delta':
      case 'tool-call-delta': {
        const expected = DELTA_BLOCK_TYPE[chunk.type]
        if (closed.has(chunk.index)) throw new LlmError('PROTOCOL_VIOLATION', `"${chunk.type}" addresses closed block ${chunk.index}`)
        const current = open.get(chunk.index)
        if (current === undefined) open.set(chunk.index, expected)
        else if (current !== expected) {
          throw new LlmError('PROTOCOL_VIOLATION', `"${chunk.type}" addresses block ${chunk.index} of type "${current}"`)
        }
        break
      }
      case 'block-end':
        open.delete(chunk.index)
        closed.add(chunk.index)
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
