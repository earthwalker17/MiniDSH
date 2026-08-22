/**
 * A scripted LLM adapter for tests: a queue of chunk scripts, one consumed per
 * `stream()` call, plus builders for the common turn shapes. Only the model is
 * scripted; everything downstream (loop, tools, session) stays real.
 */
import { asCallId } from '../core/ids.ts'
import type { LlmAdapter, LlmRequest, ModelInfo, ResolvedModel, StreamChunk, TokenUsage } from '../core/llm/types.ts'

export type ScriptedResponse = StreamChunk[] | ((request: LlmRequest) => StreamChunk[] | Promise<StreamChunk[]>)

const DEFAULT_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }

export class ScriptedAdapter implements LlmAdapter {
  readonly provider: string
  readonly calls: LlmRequest[] = []
  private readonly queue: ScriptedResponse[] = []

  constructor(options: { provider?: string } = {}) {
    this.provider = options.provider ?? 'scripted'
  }

  /** Enqueues responses; returns `this` for chaining. */
  script(...responses: ScriptedResponse[]): this {
    this.queue.push(...responses)
    return this
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    this.calls.push(request)
    const response = this.queue.shift()
    if (response === undefined) throw new Error('ScriptedAdapter: no scripted response remaining')
    const chunks = typeof response === 'function' ? await response(request) : response
    for (const chunk of chunks) {
      request.signal?.throwIfAborted()
      yield chunk
    }
  }

  resolveModel(_model: string): ResolvedModel {
    return { contextWindow: 100_000, defaultMaxTokens: 4096, reasoning: { efforts: ['off', 'low', 'high'], defaultEffort: 'high' } }
  }

  listModels(): readonly ModelInfo[] {
    return [{ id: 'scripted-model', name: 'Scripted Model' }]
  }
}

/** Chunks for an assistant turn that emits `text` and stops. */
export function assistantText(text: string, usage: TokenUsage = DEFAULT_USAGE): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Chunks for an assistant turn that calls one tool (finishes with `tool-calls`). */
export function assistantToolCall(callId: string, name: string, args: object, usage: TokenUsage = DEFAULT_USAGE): StreamChunk[] {
  const argsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: asCallId(callId), name, argumentsDelta: argsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: asCallId(callId), name, arguments: argsText } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
