/**
 * A scripted LLM adapter for tests: a queue of chunk scripts, one consumed per
 * `stream()` call (or per matching call, `scriptWhen`), plus builders for the
 * common turn shapes. Only the model is scripted; everything downstream (loop,
 * tools, session) stays real.
 */
import { asCallId } from '../core/ids.ts'
import type { LlmAdapter, LlmRequest, ModelInfo, ResolvedModel, StreamChunk, TokenUsage } from '../core/llm/types.ts'

/**
 * A hold inside a scripted stream: the adapter yields nothing past it until
 * `until` settles. A response is otherwise one burst, so without a hold no
 * test could see what a surface shows MID-stream — the first chunks recorded
 * and broadcast, the message not yet durable. Never yielded itself; a cancel
 * lands at the first chunk after the hold, never during it.
 */
export interface ScriptedGate {
  readonly type: 'gate'
  readonly until: PromiseLike<unknown>
}

export type ScriptedChunk = StreamChunk | ScriptedGate

export type ScriptedResponse = ScriptedChunk[] | ((request: LlmRequest) => ScriptedChunk[] | Promise<ScriptedChunk[]>)

const DEFAULT_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }

export class ScriptedAdapter implements LlmAdapter {
  readonly provider: string
  readonly calls: LlmRequest[] = []
  private readonly queue: ScriptedResponse[] = []
  private readonly keyed: { readonly match: (request: LlmRequest) => boolean; readonly queue: ScriptedResponse[] }[] = []

  constructor(options: { provider?: string } = {}) {
    this.provider = options.provider ?? 'scripted'
  }

  /** Enqueues responses; returns `this` for chaining. */
  script(...responses: ScriptedResponse[]): this {
    this.queue.push(...responses)
    return this
  }

  /**
   * Enqueues responses served only to a request `match` accepts, ahead of the
   * shared queue; the first registered queue that matches and still has one
   * answers. Sessions that run at once (sibling children of one step) ask in an
   * order no test controls, so one shared FIFO would hand each the other's
   * script: key each by what only its requests carry, such as a child's task.
   */
  scriptWhen(match: (request: LlmRequest) => boolean, ...responses: ScriptedResponse[]): this {
    this.keyed.push({ match, queue: [...responses] })
    return this
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    this.calls.push(request)
    const response = this.keyed.find((entry) => entry.queue.length > 0 && entry.match(request))?.queue.shift() ?? this.queue.shift()
    if (response === undefined) throw new Error('ScriptedAdapter: no scripted response remaining')
    const chunks = typeof response === 'function' ? await response(request) : response
    for (const chunk of chunks) {
      if (chunk.type === 'gate') {
        await chunk.until
        continue
      }
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

/** A hold to put between chunks (`ScriptedGate`). */
export function gate(until: PromiseLike<unknown>): ScriptedGate {
  return { type: 'gate', until }
}

/**
 * An assistant text streamed as two deltas, `head` then `tail`, with the
 * stream held OPEN between them until `until` settles: `head` is streamed and
 * the finished message (`head + tail`) is not yet durable for exactly as long
 * as the test looks.
 */
export function assistantTextPaused(head: string, tail: string, until: PromiseLike<unknown>, usage: TokenUsage = DEFAULT_USAGE): ScriptedChunk[] {
  const text = head + tail
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: head },
    gate(until),
    { type: 'text-delta', index: 0, text: tail },
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
