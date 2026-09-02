/**
 * Provider-neutral LLM vocabulary. This is owned by the seam; wire translation
 * lives only in adapters. The `ContentBlock` and `StreamChunk` unions are
 * closed — consumers switch exhaustively.
 */
import type { AttachmentRef } from '../attachments/index.ts'
import type { CallId, MessageId, SessionId } from '../ids.ts'
import type { JsonValue } from '../json.ts'

export type Role = 'system' | 'user' | 'assistant'

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  /**
   * An image the model was shown. It carries a REFERENCE and never bytes — the
   * bytes live in `ctx.attachments` and are resolved by each adapter at
   * serialization — plus `text`, the descriptor computed once when the block was
   * built. The descriptor is what a route that cannot take images is sent, so it
   * is stored rather than derived: a later change to its wording must not
   * rewrite what an old log says the model saw.
   *
   * User- and tool-side only. No adapter produces one, and `validateStream`
   * refuses an assistant stream that tries to open one.
   */
  | { readonly type: 'image'; readonly attachment: AttachmentRef; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: CallId; readonly name: string; readonly arguments: string }
  | { readonly type: 'tool-result'; readonly toolCallId: CallId; readonly content: readonly ContentBlock[]; readonly isError?: boolean }

export type ContentBlockType = ContentBlock['type']

/**
 * Adapter-private, JSON-lossless state for replaying a response to the SAME
 * provider — a thinking signature, an encrypted reasoning item. `response`
 * covers the whole response; `blocks`, when present, aligns one entry with
 * each content block in the order the blocks were opened, so the assembler
 * can prune it in step with a block it drops (a max-tokens finish drops tool
 * calls); a length mismatch discards the whole envelope rather than
 * misaligning it. Opaque everywhere but its own adapter, and stripped by the
 * runtime before a message reaches any other provider.
 */
export interface ReplayEnvelope {
  readonly response: JsonValue
  readonly blocks?: readonly JsonValue[]
}

/** How a message entered the conversation. A tool result is a user-role message. */
export type MessageSource =
  | { readonly kind: 'user' }
  | { readonly kind: 'assistant'; readonly provider: string; readonly model: string; readonly replayState?: ReplayEnvelope }
  | { readonly kind: 'tool'; readonly callId: CallId }
  | { readonly kind: 'plugin'; readonly plugin: string; readonly form?: string }

export interface Message {
  readonly id: MessageId
  readonly role: Role
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

export interface ToolSchema {
  readonly name: string
  readonly description: string
  /** JSON Schema for the tool's arguments object. */
  readonly parameters: Record<string, unknown>
}

/** A fully explicit model request. It is a pure function of the session log. */
export interface LlmRequest {
  readonly provider: string
  readonly model: string
  readonly system?: string
  readonly messages: readonly Message[]
  readonly tools?: readonly ToolSchema[]
  readonly maxTokens?: number
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly signal?: AbortSignal
  readonly sessionId?: SessionId
  /**
   * Why this call is being made, when it is NOT a loop step — `'compaction'`,
   * a verification pass, a title. Routing and replay metadata only: it is
   * never serialized to a provider and never enters `request/header`, because
   * the model cannot see it. A loop-built request never carries one, which is
   * what lets a listener tell the two apart (`core/llm/aux-call.ts`).
   */
  readonly purpose?: string
}

/**
 * DISJOINT token counts: `inputTokens` is uncached input only; billed input
 * = inputTokens + cacheReadTokens + cacheWriteTokens. An adapter whose
 * provider folds cache hits into its prompt total (DeepSeek's `prompt_tokens`)
 * subtracts them out. `reasoningTokens` is informational and already inside
 * `outputTokens`.
 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** A serializable provider failure. Policies route on `code`, never message text. */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly retryAfterMs?: number
  readonly requestId?: string
}

export type FinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly failure: LlmFailure }
  | { readonly kind: 'error'; readonly failure: LlmFailure }

export type StreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: ContentBlockType }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id?: CallId; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  /** `replayState` travels only with a successful finish (`stop` | `tool-calls` | `max-tokens`). */
  | { readonly type: 'finish'; readonly reason: FinishReason; readonly replayState?: ReplayEnvelope }

/** What a model can take as input. Merge-extensible in spirit; `text` is universal. */
export type ModelModality = 'text' | 'image'

export interface ResolvedModel {
  readonly contextWindow: number
  readonly defaultMaxTokens: number
  readonly reasoning: { readonly efforts: readonly string[]; readonly defaultEffort?: string }
  /** Absent means text only. */
  readonly inputModalities?: readonly ModelModality[]
}

export interface ModelInfo {
  readonly id: string
  readonly name: string
}

/**
 * A provider adapter. `stream` performs one provider attempt; `resolveModel`
 * exposes adapter-owned facts (context window, default max tokens, the opaque
 * reasoning-effort ids, input modalities). Effort ids never leak beyond the
 * adapter and the CLI flag that the adapter validates.
 *
 * The rule for an option the provider cannot honour: refuse BEFORE any I/O
 * with a specific code — `UNSUPPORTED_OPTION` (a sampling field the wire has
 * no honest spelling for), `UNSUPPORTED_REASONING_EFFORT` (an effort outside
 * the model's set), `UNSUPPORTED_CONTENT` (a modality the model lacks) —
 * never drop, alias or clamp it: a request the log records must be the
 * request the provider served.
 */
export interface LlmAdapter {
  readonly provider: string
  stream(request: LlmRequest): AsyncIterable<StreamChunk>
  resolveModel(model: string): ResolvedModel
  listModels(): readonly ModelInfo[]
}

export type LlmErrorCode =
  | 'NO_ADAPTER'
  | 'DUPLICATE_ADAPTER'
  | 'SCOPED_OWNER'
  | 'UNKNOWN_PROVIDER'
  | 'PROTOCOL_VIOLATION'
  | 'ABORTED'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'QUOTA'
  | 'AUTH'
  | 'INVALID_REQUEST'
  | 'EMPTY_RESPONSE'
  | 'MALFORMED_RESPONSE'
  | 'STREAM_CLOSED'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_CREDENTIAL'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_REASONING_EFFORT'
  | 'UNSUPPORTED_CONTENT'
  | 'UNKNOWN_MODEL'
  | 'REFUSAL'

export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly failure: LlmFailure
  constructor(code: LlmErrorCode, message: string, options?: { status?: number; retryAfterMs?: number; requestId?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.code = code
    this.failure = {
      message,
      code,
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
    }
  }
}

/** The retryable codes an agent-level recovery policy honors by default. */
export const RETRYABLE_CODES: ReadonlySet<LlmErrorCode> = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])
