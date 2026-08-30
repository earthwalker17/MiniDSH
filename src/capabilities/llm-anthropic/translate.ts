/**
 * Folds the Messages API's named stream events into MiniDSH `StreamChunk`s.
 *
 * What the wire does, as captured live against Claude Sonnet 5 (2026-08-30):
 * `message_start` carries the prompt-side usage (uncached, cache read, cache
 * written); every content block opens with `content_block_start`, streams
 * `text_delta` / `thinking_delta` / `input_json_delta` / `signature_delta`
 * deltas, and closes with `content_block_stop`; a thinking block whose text
 * is omitted (the default on the 5 family) opens, gets an empty
 * `thinking_delta` and ONE `signature_delta`, and closes; `message_delta`
 * carries the stop reason and the cumulative output usage (with
 * `thinking_tokens`); `message_stop` ends the message; `ping`s are noise; a
 * mid-stream failure arrives as an `error` event after the 200.
 *
 * The signature (and a redacted block's data) is provider-private replay
 * state: it rides in the finish's `ReplayEnvelope.blocks`, one entry per
 * opened block, so the assembler can prune it in step and the serializer can
 * echo it verbatim on the next request to THIS provider.
 */
import { asCallId } from '../../core/ids.ts'
import type { JsonValue } from '../../core/json.ts'
import { LlmError, type ContentBlock, type FinishReason, type LlmErrorCode, type ReplayEnvelope, type StreamChunk, type TokenUsage } from '../../core/llm/index.ts'

export const ANTHROPIC_PROVIDER = 'anthropic'

/** A per-block replay entry: what the provider must see again, beside the block it belongs to. */
export type AnthropicReplayBlock = { readonly type: 'thinking'; readonly signature: string } | { readonly type: 'redacted_thinking'; readonly data: string } | null

interface WireUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly output_tokens_details?: { readonly thinking_tokens?: number }
}

interface Block {
  readonly index: number
  readonly type: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  name?: string
  json: string
  replay: AnthropicReplayBlock
}

export class AnthropicTranslator {
  private readonly blocks = new Map<number, Block>()
  private readonly order: Block[] = []
  private nextIndex = 0
  private usage: Partial<WireUsage> = {}
  private stopReason: string | undefined
  private model: string | undefined
  private stopped = false

  /** Translates one named event; throws an `LlmError` for an in-stream `error` event. */
  push(event: string, data: Record<string, unknown>): StreamChunk[] {
    const out: StreamChunk[] = []
    switch (event) {
      case 'message_start': {
        const message = data.message as { usage?: WireUsage; model?: string } | undefined
        if (message?.usage) this.usage = { ...this.usage, ...message.usage }
        if (typeof message?.model === 'string') this.model = message.model
        break
      }
      case 'content_block_start': {
        const wireIndex = data.index as number
        const start = data.content_block as { type: string; id?: string; name?: string; text?: string; thinking?: string; data?: string }
        const block = this.open(wireIndex, start)
        out.push({ type: 'block-start', index: block.index, blockType: block.type })
        // The assembler learns a tool call's identity from its first delta.
        if (block.type === 'tool-call' && block.id !== undefined && block.name !== undefined) {
          out.push({ type: 'tool-call-delta', index: block.index, id: asCallId(block.id), name: block.name, argumentsDelta: '' })
        }
        break
      }
      case 'content_block_delta': {
        const block = this.blocks.get(data.index as number)
        if (!block) throw new LlmError('MALFORMED_RESPONSE', `Anthropic delta for an unopened block ${String(data.index)}`)
        const delta = data.delta as { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string; data?: string }
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          block.text += delta.text
          out.push({ type: 'text-delta', index: block.index, text: delta.text })
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          block.text += delta.thinking
          out.push({ type: 'reasoning-delta', index: block.index, text: delta.thinking })
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.replay = { type: 'thinking', signature: (block.replay?.type === 'thinking' ? block.replay.signature : '') + delta.signature }
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.json += delta.partial_json
          out.push({ type: 'tool-call-delta', index: block.index, argumentsDelta: delta.partial_json })
        }
        break
      }
      case 'content_block_stop': {
        const block = this.blocks.get(data.index as number)
        if (block) out.push({ type: 'block-end', index: block.index, block: finished(block) })
        break
      }
      case 'message_delta': {
        const delta = data.delta as { stop_reason?: string | null } | undefined
        if (typeof delta?.stop_reason === 'string') this.stopReason = delta.stop_reason
        const usage = data.usage as WireUsage | undefined
        if (usage) this.usage = { ...this.usage, ...usage }
        break
      }
      case 'message_stop':
        this.stopped = true
        break
      case 'error': {
        const failure = data.error as { type?: string; message?: string } | undefined
        throw new LlmError(errorCode(failure?.type), `Anthropic stream error: ${failure?.message ?? 'unknown'}`)
      }
      default:
        break // ping, and whatever the API adds later
    }
    return out
  }

  /** True once `message_stop` arrived: a body that ends before it was cut. */
  get complete(): boolean {
    return this.stopped
  }

  /** Emitted after `message_stop`: usage, then the terminal finish with the replay envelope. */
  finalize(): StreamChunk[] {
    const out: StreamChunk[] = []
    out.push({ type: 'usage', usage: mapUsage(this.usage) })
    const reason = this.finishReason()
    const replayState = reason.kind === 'error' || reason.kind === 'aborted' ? undefined : this.replayState()
    out.push(replayState === undefined ? { type: 'finish', reason } : { type: 'finish', reason, replayState })
    return out
  }

  private open(wireIndex: number, start: { type: string; id?: string; name?: string; data?: string }): Block {
    const existing = this.blocks.get(wireIndex)
    if (existing) return existing
    const type: Block['type'] = start.type === 'tool_use' ? 'tool-call' : start.type === 'thinking' || start.type === 'redacted_thinking' ? 'reasoning' : 'text'
    const block: Block = {
      index: this.nextIndex++,
      type,
      text: '',
      json: '',
      replay: start.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: start.data ?? '' } : null,
      ...(start.id === undefined ? {} : { id: start.id }),
      ...(start.name === undefined ? {} : { name: start.name }),
    }
    this.blocks.set(wireIndex, block)
    this.order.push(block)
    return block
  }

  private replayState(): ReplayEnvelope | undefined {
    if (!this.order.some((block) => block.replay !== null)) return undefined
    return {
      response: { kind: ANTHROPIC_PROVIDER, ...(this.model === undefined ? {} : { model: this.model }), ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }) },
      blocks: this.order.map((block) => block.replay as JsonValue),
    }
  }

  private finishReason(): FinishReason {
    switch (this.stopReason) {
      case 'end_turn':
      case 'stop_sequence':
      case 'pause_turn':
      case 'compaction':
      case undefined:
        if (this.order.length === 0) return { kind: 'error', failure: { message: 'model returned no content', code: 'EMPTY_RESPONSE' } }
        return { kind: 'stop' }
      case 'tool_use':
        return { kind: 'tool-calls' }
      case 'max_tokens':
        return { kind: 'max-tokens' }
      case 'model_context_window_exceeded':
        return { kind: 'error', failure: { message: 'generation reached the model context window', code: 'CONTEXT_WINDOW_EXCEEDED' } }
      case 'refusal':
        return { kind: 'error', failure: { message: 'the model refused to continue', code: 'REFUSAL' } }
      default:
        return { kind: 'error', failure: { message: `unexpected stop_reason "${this.stopReason}"`, code: 'MALFORMED_RESPONSE' } }
    }
  }
}

function finished(block: Block): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'tool-call', id: asCallId(block.id ?? ''), name: block.name ?? '', arguments: block.json || '{}' }
}

/** Anthropic's `input_tokens` is already cache-exclusive: the three prompt counts are disjoint on the wire. */
function mapUsage(usage: Partial<WireUsage>): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const reasoning = usage.output_tokens_details?.thinking_tokens
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  }
}

/** The provider's error types, as codes a policy can route on. */
export function errorCode(type: string | undefined): LlmErrorCode {
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'AUTH'
    case 'billing_error':
      return 'QUOTA'
    case 'rate_limit_error':
      return 'RATE_LIMIT'
    case 'not_found_error':
      return 'UNKNOWN_MODEL'
    case 'invalid_request_error':
    case 'request_too_large':
      return 'INVALID_REQUEST'
    case 'timeout_error':
      return 'TIMEOUT'
    case 'overloaded_error':
    case 'api_error':
      return 'SERVER'
    default:
      return 'SERVER'
  }
}
