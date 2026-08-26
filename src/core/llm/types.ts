/**
 * Provider-neutral LLM vocabulary. This is owned by the seam; wire translation
 * lives only in adapters. The `ContentBlock` and `StreamChunk` unions are
 * closed — consumers switch exhaustively.
 */
import type { CallId, MessageId, SessionId } from '../ids.ts'

export type Role = 'system' | 'user' | 'assistant'

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: CallId; readonly name: string; readonly arguments: string }
  | { readonly type: 'tool-result'; readonly toolCallId: CallId; readonly content: readonly ContentBlock[]; readonly isError?: boolean }

export type ContentBlockType = ContentBlock['type']

/** How a message entered the conversation. A tool result is a user-role message. */
export type MessageSource =
  | { readonly kind: 'user' }
  | { readonly kind: 'assistant'; readonly provider: string; readonly model: string }
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

/** Disjoint token counts: billed input = inputTokens + cacheReadTokens; reasoningTokens ⊆ outputTokens. */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
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
  | { readonly type: 'finish'; readonly reason: FinishReason }

export interface ResolvedModel {
  readonly contextWindow: number
  readonly defaultMaxTokens: number
  readonly reasoning: { readonly efforts: readonly string[]; readonly defaultEffort?: string }
}

export interface ModelInfo {
  readonly id: string
  readonly name: string
}

/**
 * A provider adapter. `stream` performs one provider attempt; `resolveModel`
 * exposes adapter-owned facts (context window, default max tokens, the opaque
 * reasoning-effort ids). Effort ids never leak beyond the adapter and the CLI
 * flag that the adapter validates.
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
