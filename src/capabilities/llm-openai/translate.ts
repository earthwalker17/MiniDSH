/**
 * Folds the Responses API's stream events into MiniDSH `StreamChunk`s.
 *
 * What the wire does, as captured live against gpt-6-luna at effort `high`
 * (2026-10-16): `response.created` and `response.in_progress` carry the
 * response id and served model; every output ITEM opens with
 * `response.output_item.added`, streams its deltas, and closes with
 * `response.output_item.done`; one terminal event ends the response —
 * `response.completed`, `.incomplete` or `.failed` — carrying the usage. The
 * measured tool turn is reasoning item → function_call item → completed. There
 * is no `[DONE]`. A reasoning item is `rs_…` with an `encrypted_content` of
 * 1.5–3.3 KB and a `summary[]`; an assistant message is `msg_…` with `phase:
 * "final_answer"`; at effort `low` gpt-6-luna often emits no reasoning item at
 * all. A mid-stream failure arrives as an `error` event after the 200.
 *
 * A block is an ITEM, keyed by `output_index`: a message whose text arrives in
 * two content parts is one text block, not two. The item ids and the sealed
 * reasoning are provider-private replay state, one `ReplayEnvelope.blocks`
 * entry per OPENED block, pushed at `.added` and overwritten at `.done` (the
 * `.added` copy may be incomplete). Pushing at `.added` rather than `.done` is
 * what keeps the envelope aligned when `response.incomplete` leaves an item
 * open: the assembler drops that item's tool call and prunes its entry in the
 * same pass (`core/llm/assembler.ts`).
 */
import { asCallId } from '../../core/ids.ts'
import type { JsonValue } from '../../core/json.ts'
import { LlmError, type ContentBlock, type FinishReason, type LlmErrorCode, type ReplayEnvelope, type StreamChunk, type TokenUsage } from '../../core/llm/index.ts'

export const OPENAI_PROVIDER = 'openai'

/**
 * A per-block replay entry: what this provider must see again, beside the
 * block it belongs to. A reasoning entry exists only once the item is SEALED
 * (`encrypted_content` present); an unsealed one is `null` and is never sent
 * back, because a reasoning item the API cannot verify is a forgery.
 */
export type OpenAIReplayBlock =
  | { readonly type: 'reasoning'; readonly id: string; readonly encrypted_content: string }
  | { readonly type: 'message'; readonly id: string; readonly phase?: string }
  | { readonly type: 'function_call'; readonly id: string }
  | null

interface WireUsage {
  readonly input_tokens?: unknown
  readonly input_tokens_details?: { readonly cached_tokens?: unknown; readonly cache_write_tokens?: unknown } | null
  readonly output_tokens?: unknown
  readonly output_tokens_details?: { readonly reasoning_tokens?: unknown } | null
}

interface WirePart {
  readonly type?: unknown
  readonly text?: unknown
  readonly refusal?: unknown
}

interface WireItem {
  readonly type?: unknown
  readonly id?: unknown
  readonly encrypted_content?: unknown
  readonly summary?: unknown
  readonly content?: unknown
  readonly phase?: unknown
  readonly call_id?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
}

interface WireResponse {
  readonly id?: unknown
  readonly model?: unknown
  readonly usage?: WireUsage | null
  readonly incomplete_details?: { readonly reason?: unknown } | null
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | null
}

interface Block {
  /** The chunk index — this translator's own, so a gap in `output_index` never reaches the protocol. */
  readonly index: number
  readonly type: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** The summary or content part the last reasoning delta belonged to, for the blank line between parts. */
  part: string | undefined
  callId: string | undefined
  name: string | undefined
  args: string
  /** Refusal text, recorded and never emitted: a refusal is not an answer. */
  refusal: string
  done: boolean
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export class OpenAITranslator {
  private readonly blocks = new Map<number, Block>()
  private readonly order: Block[] = []
  /** One entry per opened block, in opening order: index-aligned with `order`. */
  private readonly entries: OpenAIReplayBlock[] = []
  private responseId: string | undefined
  private model: string | undefined
  private refused = false
  private ended = false

  /** Translates one event (its `type` names it); throws an `LlmError` for a malformed or failed stream. */
  push(data: Record<string, unknown>): StreamChunk[] {
    const out: StreamChunk[] = []
    if (this.ended) return out
    switch (data.type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.queued':
        this.capture(data.response as WireResponse | undefined)
        break
      case 'response.output_item.added':
        this.added(data, out)
        break
      case 'response.reasoning_summary_text.delta':
        this.reasoningDelta(data, `summary:${String(data.summary_index)}`, out)
        break
      case 'response.reasoning_text.delta':
        this.reasoningDelta(data, `content:${String(data.content_index)}`, out)
        break
      case 'response.output_text.delta': {
        const block = this.openBlock(data, 'text')
        const delta = str(data.delta)
        if (delta !== undefined && delta.length > 0) {
          block.text += delta
          out.push({ type: 'text-delta', index: block.index, text: delta })
        }
        break
      }
      case 'response.refusal.delta':
        this.openBlock(data, 'text').refusal += str(data.delta) ?? ''
        break
      case 'response.function_call_arguments.delta': {
        const block = this.openBlock(data, 'tool-call')
        const delta = str(data.delta) ?? ''
        block.args += delta
        out.push({ type: 'tool-call-delta', index: block.index, argumentsDelta: delta })
        break
      }
      case 'response.output_item.done':
        this.done(data, out)
        break
      case 'response.completed': {
        const response = data.response as WireResponse | undefined
        this.capture(response)
        this.end(out, response?.usage, this.completedReason())
        break
      }
      case 'response.incomplete': {
        const response = data.response as WireResponse | undefined
        this.capture(response)
        this.end(out, response?.usage, incompleteReason(str(response?.incomplete_details?.reason)))
        break
      }
      case 'response.failed': {
        const response = data.response as WireResponse | undefined
        const error = response?.error
        const code = str(error?.code)
        const failure = { message: `OpenAI response failed: ${str(error?.message) || code || 'no error given'}`, code: failureCode(code) }
        // Usage only when the failure reports it: a zero count would tell the
        // meter a request cost nothing when the provider never said so.
        if (response?.usage) out.push({ type: 'usage', usage: mapUsage(response.usage) })
        out.push({ type: 'finish', reason: { kind: 'error', failure } })
        this.ended = true
        break
      }
      case 'error': {
        // Both spellings: the documented `{code, message}` at the top level,
        // and an `{error: {…}}` envelope the SDK also treats as a failure.
        const nested = data.error as { readonly code?: unknown; readonly message?: unknown } | undefined
        const code = str(data.code) ?? str(nested?.code)
        const message = str(data.message) || str(nested?.message) || code || 'unknown'
        throw new LlmError(failureCode(code), `OpenAI stream error: ${message}`)
      }
      default:
        break // content_part, *.done, annotations, and whatever the API adds later
    }
    return out
  }

  /** True once a terminal event arrived: a body that ends before one was cut. */
  get complete(): boolean {
    return this.ended
  }

  private capture(response: WireResponse | undefined): void {
    const id = str(response?.id)
    const model = str(response?.model)
    if (id !== undefined) this.responseId = id
    if (model !== undefined) this.model = model
  }

  private added(data: Record<string, unknown>, out: StreamChunk[]): void {
    const outputIndex = outputIndexOf(data)
    if (this.blocks.has(outputIndex)) throw new LlmError('MALFORMED_RESPONSE', `OpenAI opened output item ${outputIndex} twice`)
    const item = (data.item ?? {}) as WireItem
    const type = blockTypeOf(item.type)
    // This adapter requests no hosted tool, so any other item — a search
    // call, a compaction, a program — is a response it cannot honestly fold.
    // Dropping it would put a message in the log that is missing part of what
    // the model did.
    if (type === undefined) throw new LlmError('MALFORMED_RESPONSE', `OpenAI returned an output item of type "${String(item.type)}", which this adapter never requests`)
    const block: Block = { index: this.order.length, type, text: '', part: undefined, callId: str(item.call_id), name: str(item.name), args: '', refusal: '', done: false }
    this.blocks.set(outputIndex, block)
    this.order.push(block)
    this.entries.push(entryOf(item))
    out.push({ type: 'block-start', index: block.index, blockType: type })
    // The assembler learns a tool call's identity from its first delta.
    if (type === 'tool-call') {
      out.push({ type: 'tool-call-delta', index: block.index, ...(block.callId === undefined ? {} : { id: asCallId(block.callId) }), ...(block.name === undefined ? {} : { name: block.name }), argumentsDelta: '' })
    }
  }

  private reasoningDelta(data: Record<string, unknown>, part: string, out: StreamChunk[]): void {
    const block = this.openBlock(data, 'reasoning')
    const delta = str(data.delta)
    if (delta === undefined || delta.length === 0) return
    const text = block.text.length > 0 && block.part !== part ? `\n\n${delta}` : delta
    block.part = part
    block.text += text
    out.push({ type: 'reasoning-delta', index: block.index, text })
  }

  private done(data: Record<string, unknown>, out: StreamChunk[]): void {
    const item = (data.item ?? {}) as WireItem
    const kind = blockTypeOf(item.type)
    if (item.type !== undefined && kind === undefined) throw new LlmError('MALFORMED_RESPONSE', `OpenAI closed an output item of type "${String(item.type)}", which this adapter never requests`)
    const block = this.openBlock(data, kind)
    // A block's chunk index is its opening position, so it addresses its entry too.
    this.entries[block.index] = entryOf(item) ?? this.entries[block.index] ?? null
    let final: ContentBlock
    if (block.type === 'text') {
      const parts = Array.isArray(item.content) ? (item.content as readonly WirePart[]) : undefined
      if (parts?.some((part) => part.type === 'refusal')) this.refused = true
      block.text = parts ? parts.filter((part) => part.type === 'output_text').map((part) => str(part.text) ?? '').join('') : block.text
      final = { type: 'text', text: block.text }
    } else if (block.type === 'reasoning') {
      block.text = textsOf(item.summary, 'summary_text') ?? textsOf(item.content, 'reasoning_text') ?? block.text
      final = { type: 'reasoning', text: block.text }
    } else {
      const callId = str(item.call_id) ?? block.callId
      const name = str(item.name) ?? block.name
      // A call with no id cannot be answered: its result would have nothing to name.
      if (callId === undefined || name === undefined) throw new LlmError('MALFORMED_RESPONSE', 'OpenAI closed a function call without its call_id or name')
      block.callId = callId
      block.name = name
      final = { type: 'tool-call', id: asCallId(callId), name, arguments: str(item.arguments) || block.args || '{}' }
    }
    block.done = true
    out.push({ type: 'block-end', index: block.index, block: final })
  }

  /** The block an item event addresses, which must be open and, when named, of the expected kind. */
  private openBlock(data: Record<string, unknown>, expected: Block['type'] | undefined): Block {
    const outputIndex = outputIndexOf(data)
    const block = this.blocks.get(outputIndex)
    if (!block) throw new LlmError('MALFORMED_RESPONSE', `OpenAI "${String(data.type)}" for an unopened output item ${outputIndex}`)
    if (block.done) throw new LlmError('MALFORMED_RESPONSE', `OpenAI "${String(data.type)}" for output item ${outputIndex} after it closed`)
    if (expected !== undefined && block.type !== expected) throw new LlmError('MALFORMED_RESPONSE', `OpenAI "${String(data.type)}" addresses output item ${outputIndex}, which is not ${expected === 'text' ? 'a message' : `a ${expected}`}`)
    return block
  }

  /**
   * Usage once, then the finish — on `completed` AND `incomplete`, because the
   * meter reads usage off `assistant/message` and a max-tokens answer is
   * still a billed one.
   */
  private end(out: StreamChunk[], usage: WireUsage | null | undefined, reason: FinishReason): void {
    out.push({ type: 'usage', usage: mapUsage(usage) })
    const success = reason.kind === 'stop' || reason.kind === 'tool-calls' || reason.kind === 'max-tokens'
    out.push(success ? { type: 'finish', reason, replayState: this.envelope() } : { type: 'finish', reason })
    this.ended = true
  }

  private completedReason(): FinishReason {
    if (this.refused || this.order.some((block) => block.refusal.length > 0)) {
      const said = this.order.map((block) => block.refusal).join('').slice(0, 500)
      return { kind: 'error', failure: { message: said.length > 0 ? `the model refused: ${said}` : 'the model refused to answer', code: 'REFUSAL' } }
    }
    const toolCall = this.order.some((block) => block.type === 'tool-call')
    // Reasoning alone is not an answer: a completion with nothing else in it
    // is EMPTY_RESPONSE, as the sibling adapters say it, so the retry policy
    // sees it instead of the driver appending a thought and stopping.
    if (!toolCall && !this.order.some((block) => block.type === 'text' && block.text.length > 0)) {
      return { kind: 'error', failure: { message: 'model returned no answer', code: 'EMPTY_RESPONSE' } }
    }
    return toolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
  }

  private envelope(): ReplayEnvelope {
    return {
      response: { kind: OPENAI_PROVIDER, ...(this.model === undefined ? {} : { model: this.model }), ...(this.responseId === undefined ? {} : { id: this.responseId }) },
      blocks: this.entries.map((entry) => entry as JsonValue),
    }
  }
}

/** The block an output item folds into, or `undefined` for an item type this adapter never requests. */
function blockTypeOf(type: unknown): Block['type'] | undefined {
  if (type === 'reasoning') return 'reasoning'
  if (type === 'message') return 'text'
  if (type === 'function_call') return 'tool-call'
  return undefined
}

function outputIndexOf(data: Record<string, unknown>): number {
  const index = data.output_index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new LlmError('MALFORMED_RESPONSE', `OpenAI "${String(data.type)}" without an output_index`)
  return index
}

/** The replay entry an item carries, or `null` when it carries nothing that can be replayed. */
function entryOf(item: WireItem): OpenAIReplayBlock {
  const id = str(item.id)
  if (id === undefined) return null
  switch (item.type) {
    case 'reasoning': {
      const sealed = str(item.encrypted_content)
      return sealed !== undefined && sealed.length > 0 ? { type: 'reasoning', id, encrypted_content: sealed } : null
    }
    case 'message': {
      const phase = str(item.phase)
      return phase === undefined ? { type: 'message', id } : { type: 'message', id, phase }
    }
    case 'function_call':
      return { type: 'function_call', id }
    default:
      return null
  }
}

/** The non-empty texts of one part kind, a blank line between them; `undefined` when there are none. */
function textsOf(parts: unknown, kind: string): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const texts = (parts as readonly WirePart[]).filter((part) => part.type === kind).map((part) => str(part.text) ?? '').filter((text) => text.length > 0)
  return texts.length > 0 ? texts.join('\n\n') : undefined
}

function incompleteReason(reason: string | undefined): FinishReason {
  if (reason === 'max_output_tokens') return { kind: 'max-tokens' }
  if (reason === 'content_filter') return { kind: 'error', failure: { message: 'the response was stopped by the content filter', code: 'REFUSAL' } }
  return { kind: 'error', failure: { message: `OpenAI response incomplete: "${reason ?? 'no reason given'}"`, code: 'MALFORMED_RESPONSE' } }
}

/** A finite, positive wire count, else 0: a NaN would be refused by the log, and a negative one is nonsense. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * DISJOINT usage. `input_tokens` INCLUDES both cache reads and cache writes
 * (measured 2026-10-16: 1,889 input = 1,886 written + 3), so both come out of
 * the uncached count; `output_tokens` already includes the reasoning.
 */
function mapUsage(usage: WireUsage | null | undefined): TokenUsage {
  const cacheRead = count(usage?.input_tokens_details?.cached_tokens)
  const cacheWrite = count(usage?.input_tokens_details?.cache_write_tokens)
  const reasoning = count(usage?.output_tokens_details?.reasoning_tokens)
  return {
    inputTokens: Math.max(0, count(usage?.input_tokens) - cacheRead - cacheWrite),
    outputTokens: count(usage?.output_tokens),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * The 429 codes that mean "out of money", never "slow down": retrying one
 * cannot succeed, so it must not reach the retry policy as a RATE_LIMIT.
 */
export function isQuotaCode(code: string | undefined): boolean {
  return code !== undefined && /^(insufficient_quota|credit_balance_exhausted|billing_not_active|access_terminated|\w*spend_limit_exceeded|\w*usage_limit_exceeded)$/.test(code)
}

/** A failure's wire `code`, as a code a policy can route on. Unknown codes are SERVER: retryable, bounded by the policy. */
export function failureCode(code: string | undefined): LlmErrorCode {
  if (isQuotaCode(code)) return 'QUOTA'
  switch (code) {
    case 'rate_limit_exceeded':
      return 'RATE_LIMIT'
    case 'server_error':
      return 'SERVER'
    case 'context_length_exceeded':
      return 'CONTEXT_WINDOW_EXCEEDED'
    case 'invalid_prompt':
      return 'INVALID_REQUEST'
    default:
      // The image codes (`invalid_image`, `image_too_large`,
      // `failed_to_download_image`, …): the same bytes fail the same way twice.
      return code !== undefined && code.includes('image') ? 'INVALID_REQUEST' : 'SERVER'
  }
}
