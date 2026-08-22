/**
 * The session log vocabulary.
 *
 * Events are addressed by typed `EventKind` tokens (no declaration merging):
 * the owning module exports its kinds, `append` takes a kind plus its payload,
 * and readers narrow with `matches`. The store treats an unknown kind as an
 * opaque `{type, seq, time, data}` record, so plugins extend the vocabulary
 * without the core knowing every event.
 */
import type { SessionId } from '../ids.ts'
import type { Message, TokenUsage } from '../llm/types.ts'
import type { JsonValue } from '../json.ts'

export const SESSION_FORMAT_VERSION = 0

export type SurfaceOp = { readonly op: 'append' } | { readonly op: 'replace'; readonly start: number; readonly end: number }

export interface SurfaceIntent {
  readonly surfaceOp: SurfaceOp
  readonly sourceEventSeqs?: readonly number[]
}

export interface EventEnvelope<D = unknown> {
  readonly type: string
  readonly seq: number
  readonly time: number
  /** Always JSON-lossless at runtime (checked at append); typed per event via `matches`. */
  readonly data: D
  readonly surfaceOp?: SurfaceOp
  readonly sourceEventSeqs?: readonly number[]
  /** Marks a plugin event the core may skip on load without refusing the log. */
  readonly ignorable?: true
}

export interface EventKind<Name extends string, Data> {
  readonly type: Name
  readonly surface: boolean
  /** Phantom; never set at runtime. */
  readonly __data?: Data
}

/** Declares an event kind. `surface: true` events participate in message derivation. */
export function eventKind<Data>(type: string, options: { surface?: boolean } = {}): EventKind<string, Data> {
  return Object.freeze({ type, surface: options.surface ?? false }) as EventKind<string, Data>
}

/** Narrows an envelope to a kind's payload type. */
export function matches<Name extends string, Data>(event: EventEnvelope, kind: EventKind<Name, Data>): event is EventEnvelope<Data> {
  return event.type === kind.type
}

// ---- reasons and headers --------------------------------------------------

export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'max-steps' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }

/** Everything about a request that is not conversation history. */
export interface RequestHeader {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: JsonValue }[]
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

export type RequestHeaderReason = 'initial' | 'change' | 'resume'

// ---- core event kinds -----------------------------------------------------

export const TURN_START = eventKind<{ turn: number }>('turn/start')
export const TURN_END = eventKind<{ turn: number; reason: TurnEndReason }>('turn/end')
export const STEP_START = eventKind<{ turn: number; step: number }>('step/start')
export const STEP_END = eventKind<{ turn: number; step: number }>('step/end')
export const USER_MESSAGE = eventKind<{ message: Message }>('user/message', { surface: true })
export const REQUEST_HEADER = eventKind<{ turn: number; step: number; header: RequestHeader; reason: RequestHeaderReason }>('request/header')
export const ASSISTANT_CHUNK = eventKind<{ turn: number; step: number; chunk: JsonValue }>('assistant/chunk')
export const ASSISTANT_MESSAGE = eventKind<{ turn: number; step: number; message: Message; usage?: TokenUsage; interrupted?: true }>(
  'assistant/message',
  { surface: true },
)
export const TOOL_CALL = eventKind<{ turn: number; step: number; callId: string; name: string; arguments: string }>('tool/call')
export const TOOL_RESULT = eventKind<{ turn: number; step: number; callId: string; message: Message; error?: { name: string; code: string } }>(
  'tool/result',
  { surface: true },
)
export const END_SEED = eventKind<Record<string, never>>('session/end-seed')

/** The three surface event type strings, hardcoded because the session owns them. */
export const SURFACE_TYPES: ReadonlySet<string> = new Set([USER_MESSAGE.type, ASSISTANT_MESSAGE.type, TOOL_RESULT.type])

export interface SessionHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd: string
  readonly parentId?: SessionId
  readonly seedLength?: number
}
