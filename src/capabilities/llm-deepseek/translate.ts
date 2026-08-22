import { asCallId } from '../../core/ids.ts'
import { LlmError, type FinishReason, type StreamChunk, type TokenUsage } from '../../core/llm/index.ts'

/** One streamed chat-completion chunk from DeepSeek. */
export interface WireChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null
      readonly reasoning_content?: string | null
      readonly tool_calls?: readonly {
        readonly index: number
        readonly id?: string
        readonly function?: { readonly name?: string; readonly arguments?: string }
      }[]
    }
    readonly finish_reason?: string | null
  }[]
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
    readonly prompt_cache_hit_tokens?: number
    readonly prompt_tokens_details?: { readonly cached_tokens?: number }
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number }
  } | null
}

interface Block {
  readonly index: number
  readonly type: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  name?: string
  args: string
}

/**
 * Folds DeepSeek's streamed deltas into MiniDSH `StreamChunk`s. Block-start and
 * deltas emit as they arrive; every block-end, `usage`, and the terminal
 * `finish` are deferred to `[DONE]`, which guarantees the protocol ordering.
 */
export class DeepSeekTranslator {
  private nextIndex = 0
  private reasoning: Block | undefined
  private text: Block | undefined
  private readonly tools = new Map<number, Block>()
  private readonly order: Block[] = []
  private usage: TokenUsage | undefined
  private wireFinish: string | undefined

  push(chunk: WireChunk): StreamChunk[] {
    const out: StreamChunk[] = []
    if (chunk.usage) this.usage = mapUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice) return out
    if (choice.finish_reason) this.wireFinish = choice.finish_reason
    const delta = choice.delta
    if (!delta) return out

    // Only real content opens a block: DeepSeek's conventional empty first delta
    // must not create an empty block (which would defeat EMPTY_RESPONSE detection).
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      const block = this.ensure('reasoning', out)
      block.text += delta.reasoning_content
      out.push({ type: 'reasoning-delta', index: block.index, text: delta.reasoning_content })
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const block = this.ensure('text', out)
      block.text += delta.content
      out.push({ type: 'text-delta', index: block.index, text: delta.content })
    }
    for (const call of delta.tool_calls ?? []) {
      let block = this.tools.get(call.index)
      if (!block) {
        block = { index: this.nextIndex++, type: 'tool-call', text: '', args: '' }
        this.tools.set(call.index, block)
        this.order.push(block)
        out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
      }
      if (call.id !== undefined) block.id = call.id
      if (call.function?.name !== undefined) block.name = call.function.name
      const argsDelta = call.function?.arguments ?? ''
      block.args += argsDelta
      const deltaChunk: StreamChunk = {
        type: 'tool-call-delta',
        index: block.index,
        argumentsDelta: argsDelta,
        ...(block.id === undefined ? {} : { id: asCallId(block.id) }),
        ...(block.name === undefined ? {} : { name: block.name }),
      }
      out.push(deltaChunk)
    }
    return out
  }

  /** Emitted at `[DONE]`: every block-end, then usage, then the terminal finish. */
  finalize(): StreamChunk[] {
    const out: StreamChunk[] = []
    for (const block of this.order) {
      if (block.type === 'reasoning') out.push({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      else if (block.type === 'text') out.push({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      else if (block.id !== undefined && block.name !== undefined) {
        out.push({ type: 'block-end', index: block.index, block: { type: 'tool-call', id: asCallId(block.id), name: block.name, arguments: block.args || '{}' } })
      }
    }
    if (this.usage) out.push({ type: 'usage', usage: this.usage })
    out.push({ type: 'finish', reason: this.finishReason() })
    return out
  }

  private ensure(type: 'reasoning' | 'text', out: StreamChunk[]): Block {
    const existing = type === 'reasoning' ? this.reasoning : this.text
    if (existing) return existing
    const block: Block = { index: this.nextIndex++, type, text: '', args: '' }
    if (type === 'reasoning') this.reasoning = block
    else this.text = block
    this.order.push(block)
    out.push({ type: 'block-start', index: block.index, blockType: type })
    return block
  }

  private finishReason(): FinishReason {
    switch (this.wireFinish) {
      case 'stop':
        if (this.order.length === 0) return { kind: 'error', failure: { message: 'model returned no content', code: 'EMPTY_RESPONSE' } }
        return { kind: 'stop' }
      case 'tool_calls':
        return { kind: 'tool-calls' }
      case 'length':
        return { kind: 'max-tokens' }
      case undefined:
        return { kind: 'stop' }
      default:
        return { kind: 'error', failure: { message: `unexpected finish_reason "${this.wireFinish}"`, code: 'MALFORMED_RESPONSE' } }
    }
  }
}

function mapUsage(usage: NonNullable<WireChunk['usage']>): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  const prompt = usage.prompt_tokens ?? 0
  return {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: usage.completion_tokens ?? 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
  }
}

/** Parses one SSE data payload as a wire chunk. */
export function parseWireChunk(data: string): WireChunk {
  try {
    return JSON.parse(data) as WireChunk
  } catch {
    throw new LlmError('MALFORMED_RESPONSE', 'DeepSeek returned a non-JSON stream chunk')
  }
}
