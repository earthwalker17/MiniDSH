/**
 * The session log vocabulary.
 *
 * Events are addressed by typed `EventKind` tokens (no declaration merging):
 * the owning module exports its kinds, `append` takes a kind plus its payload,
 * and readers narrow with `matches`. The vocabulary is merge-extensible: a
 * kind the core does not know is an opaque log-only `{type, seq, time, data}`
 * record, accepted on load and skipped by derivation, so plugins add events
 * without the core (or a client) knowing every type. The three surface kinds
 * that project into model history are closed and owned here.
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
}

export interface EventKind<Name extends string, Data> {
  readonly type: Name
  /** Phantom; never set at runtime. */
  readonly __data?: Data
}

/** Declares an event kind. Only the session's own surface kinds (`SURFACE_TYPES`) project into history. */
export function eventKind<Data>(type: string): EventKind<string, Data> {
  return Object.freeze({ type }) as EventKind<string, Data>
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

/** Everything about a request that is not conversation history — every model-visible field outside `messages`. */
export interface RequestHeader {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: JsonValue }[]
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly temperature?: number
}

export type RequestHeaderReason = 'initial' | 'change' | 'resume'

// ---- core event kinds -----------------------------------------------------

export const TURN_START = eventKind<{ turn: number }>('turn/start')
export const TURN_END = eventKind<{ turn: number; reason: TurnEndReason }>('turn/end')
export const STEP_START = eventKind<{ turn: number; step: number }>('step/start')
export const STEP_END = eventKind<{ turn: number; step: number }>('step/end')
export const USER_MESSAGE = eventKind<{ message: Message }>('user/message')
export const REQUEST_HEADER = eventKind<{ turn: number; step: number; header: RequestHeader; reason: RequestHeaderReason }>('request/header')
/** One raw stream chunk. `attempt` (1-based per step) separates a retried attempt's chunks from the one that succeeded. */
export const ASSISTANT_CHUNK = eventKind<{ turn: number; step: number; attempt: number; chunk: JsonValue }>('assistant/chunk')
export const ASSISTANT_MESSAGE = eventKind<{ turn: number; step: number; message: Message; usage?: TokenUsage; interrupted?: true }>('assistant/message')
export const TOOL_CALL = eventKind<{ turn: number; step: number; callId: string; name: string; arguments: string }>('tool/call')
export const TOOL_RESULT = eventKind<{ turn: number; step: number; callId: string; message: Message; error?: { name: string; code: string } }>('tool/result')
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
