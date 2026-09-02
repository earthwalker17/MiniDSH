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
import type { Message, ModelModality, TokenUsage } from '../llm/types.ts'
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

/**
 * Route metadata for the next request — the resolved provider and model and
 * the window the adapter advertises for them — logged only when one of them
 * changes. It sits OUTSIDE header equality (the window is not model-visible),
 * so a capacity change never forces a header snapshot, and a reader (the
 * meter, a replay, `sessions show`) learns the window from the log instead of
 * from a live adapter. DSH's `request/context`.
 */
export interface RequestContextRecord {
  readonly provider: string
  readonly model: string
  /** Maximum combined request and response tokens, when the adapter advertises one. */
  readonly contextWindow?: number
  /**
   * What this route can take as input, as its adapter advertises it. Absent
   * means text only — the same reading the adapter contract gives — and a
   * producer of non-text content refuses against this, so the log explains its
   * own refusals. It is also what lets a replay answer a recorded route's
   * modalities without a live adapter: without it a recorded vision session
   * would refuse its own image on replay.
   */
  readonly inputModalities?: readonly ModelModality[]
}

// ---- core event kinds -----------------------------------------------------

export const TURN_START = eventKind<{ turn: number }>('turn/start')
export const TURN_END = eventKind<{ turn: number; reason: TurnEndReason }>('turn/end')
export const STEP_START = eventKind<{ turn: number; step: number }>('step/start')
export const STEP_END = eventKind<{ turn: number; step: number }>('step/end')
export const USER_MESSAGE = eventKind<{ message: Message }>('user/message')
export const REQUEST_HEADER = eventKind<{ turn: number; step: number; header: RequestHeader; reason: RequestHeaderReason }>('request/header')
/** Log-only: the route and its window, written before the step's pre-step listeners run, iff it differs from the last one. */
export const REQUEST_CONTEXT = eventKind<RequestContextRecord>('request/context')
/** One raw stream chunk. `attempt` (1-based per step) separates a retried attempt's chunks from the one that succeeded. */
export const ASSISTANT_CHUNK = eventKind<{ turn: number; step: number; attempt: number; chunk: JsonValue }>('assistant/chunk')
export const ASSISTANT_MESSAGE = eventKind<{ turn: number; step: number; message: Message; usage?: TokenUsage; interrupted?: true }>('assistant/message')
export const TOOL_CALL = eventKind<{ turn: number; step: number; callId: string; name: string; arguments: string }>('tool/call')
export const TOOL_RESULT = eventKind<{ turn: number; step: number; callId: string; message: Message; error?: { name: string; code: string } }>('tool/result')
export const END_SEED = eventKind<Record<string, never>>('session/end-seed')

/** The three surface event type strings, hardcoded because the session owns them. */
export const SURFACE_TYPES: ReadonlySet<string> = new Set([USER_MESSAGE.type, ASSISTANT_MESSAGE.type, TOOL_RESULT.type])

/**
 * The log has three tiers. SURFACE events project into model history; every
 * other event is a log-only FACT the runtime folds (headers, stamps, records,
 * inbox splices) — except TRACE events, which are recorded for streaming
 * fidelity and replay and are never folded by anything at runtime. A trace
 * kind is the bulk of a long session by two orders of magnitude, so runtime
 * folds read `Session.facts`, the log without its trace, while persistence,
 * replay and the wire keep the whole `events`.
 */
export const TRACE_TYPES: ReadonlySet<string> = new Set([ASSISTANT_CHUNK.type])

export interface SessionHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd: string
  /** Fork lineage: the session this one was sliced from, with the length of the inherited prefix. */
  readonly parentId?: SessionId
  readonly seedLength?: number
  /** Delegation lineage: the session whose agent created this one as a child. Distinct from fork lineage — a spawned child inherits no history. */
  readonly delegatedBy?: SessionId
  /** Absent (zero) for a top-level session, the parent's depth + 1 for a delegated child. Durable, so a resumed child can never delegate as top-level. */
  readonly delegationDepth?: number
  /** The agent preset this session's world was composed from, when one was named — so a resume, or a child, can compose the same world. */
  readonly agentPreset?: string
}

/**
 * How this live session came to exist — deliberately NOT part of the durable
 * header (a resumed session's header is identical to its stored one). A
 * persistence provider keys its publication behavior on it: `resumed` attaches
 * to the existing store append-only; everything else is a fresh write.
 */
export type SessionOrigin = 'new' | 'seeded' | 'resumed'

/** One session event addressed for a surface or a wire: the interchange shape. */
export interface SessionEventFrame {
  readonly sessionId: SessionId
  readonly event: EventEnvelope
}
