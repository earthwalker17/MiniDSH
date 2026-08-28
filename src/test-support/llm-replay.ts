/**
 * Replay-from-the-log adapter. The model script is DERIVED from a recorded
 * session's `assistant/chunk` events (grouped by turn/step), so recording is
 * free: run the real agent once, harvest its JSONL, replay it keylessly.
 * `assertConsumed()` fails if any recorded step was not replayed.
 *
 * There are TWO scripts, because there are two kinds of call. Loop steps come
 * from `assistant/chunk`; out-of-loop calls (a compaction summary) come from
 * the `llm/aux-call` records their caller wrote, and are told apart by the
 * request's `purpose` — a loop-built request never carries one. Both cursors
 * are asserted, so a compacted log replays its compaction at the same point,
 * with the same summary, or the oracle fails.
 */
import type { Context, Disposer } from '../kernel/index.ts'
import { LLM, type LlmAdapter, type LlmRequest, type ModelInfo, type ResolvedModel, type StreamChunk } from '../core/llm/index.ts'
import { foldAuxCalls, type AuxCallRecord } from '../core/llm/aux-call.ts'
import { matches, ASSISTANT_CHUNK, type EventEnvelope } from '../core/session/index.ts'

/**
 * How a retried step replays.
 *
 * `every` (the default) replays each recorded attempt, failures included, so a
 * recovery the log describes actually happens again. This is the faithful
 * oracle, and it is required whenever recovery CHANGED THE LOG — a compaction
 * answering `CONTEXT_WINDOW_EXCEEDED` writes a surface replace, and eliding the
 * failure would leave the replayed session with a history the recording never
 * had. The cost is that the replaying composition must carry the same recovery
 * capabilities; every real one does.
 *
 * `acted-on` replays only the attempt whose result the agent used, so a log can
 * replay under a composition with no recovery listeners at all.
 */
export type ReplayAttempts = 'every' | 'acted-on'

/**
 * Groups recorded `assistant/chunk` payloads into chunk lists per (turn, step),
 * in order. Logs written before `attempt` existed count as a single attempt.
 */
export function deriveReplayScript(events: readonly EventEnvelope[], attempts: ReplayAttempts = 'every'): StreamChunk[][] {
  const groups = new Map<string, { attempt: number; chunks: StreamChunk[] }[]>()
  const order: string[] = []
  for (const event of events) {
    if (!matches(event, ASSISTANT_CHUNK)) continue
    const key = `${event.data.turn}:${event.data.step}`
    let list = groups.get(key)
    if (!list) {
      list = []
      groups.set(key, list)
      order.push(key)
    }
    const open = list.at(-1)
    let attempt = event.data.attempt as number | undefined
    if (attempt === undefined) {
      // Exactly one finish ends an attempt, so a chunk arriving after a finish
      // belongs to the next one.
      attempt = !open ? 1 : open.chunks.at(-1)?.type === 'finish' ? open.attempt + 1 : open.attempt
    }
    if (!open || attempt > open.attempt) list.push({ attempt, chunks: [event.data.chunk as unknown as StreamChunk] })
    else if (attempt === open.attempt) open.chunks.push(event.data.chunk as unknown as StreamChunk)
    // A lower attempt after a higher one cannot happen; ignore it rather than reorder.
  }
  const script: StreamChunk[][] = []
  for (const key of order) {
    const list = groups.get(key)!
    const chosen = attempts === 'every' ? list : list.slice(-1)
    for (const entry of chosen) {
      // A group with no terminal finish is a crash artifact: the runtime always
      // normalizes to a terminal finish, so its absence means the process died
      // mid-stream and the agent never acted on it. In a resumed log the
      // artifact sits MID-log (completed turns follow it), so every finish-less
      // group is dropped — replaying one would silently desynchronize the script.
      if (entry.chunks.some((chunk) => chunk.type === 'finish')) script.push(entry.chunks)
    }
  }
  return script
}

/**
 * Rebuilds a recorded auxiliary call as a chunk stream. Only the finished text
 * and usage were recorded — that is what the call's consumer read, so it is
 * exactly what a replay owes it.
 */
export function auxCallChunks(record: AuxCallRecord): StreamChunk[] {
  if (record.outcome.kind === 'error') {
    return [{ type: 'finish', reason: { kind: 'error', failure: record.outcome.failure } }]
  }
  const text = record.outcome.text
  const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  if (text.length > 0) chunks.push({ type: 'text-delta', index: 0, text })
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  if (record.usage) chunks.push({ type: 'usage', usage: record.usage })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

/** A recorded out-of-loop call: its purpose travels with its chunks, so a replay can refuse to serve one purpose's record to another's request. */
interface AuxGroup {
  readonly purpose: string
  readonly chunks: StreamChunk[]
}

class ReplayAdapter implements LlmAdapter {
  readonly provider: string
  private readonly script: StreamChunk[][]
  private readonly auxScript: AuxGroup[]
  private readonly contextWindow: number
  private cursor = 0
  private auxCursor = 0
  constructor(provider: string, script: StreamChunk[][], auxScript: AuxGroup[], contextWindow: number) {
    this.provider = provider
    this.script = script
    this.auxScript = auxScript
    this.contextWindow = contextWindow
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    // `purpose` is the whole discriminator: the loop never sets one.
    if (request.purpose !== undefined) {
      const group = this.auxScript[this.auxCursor]
      if (!group) throw new Error(`llm-replay: no recorded "${request.purpose}" call ${this.auxCursor} to replay`)
      // Log order is the cursor, but the purpose must agree: once a session
      // records more than one kind of out-of-loop call, a drift in ordering
      // would otherwise hand a compaction summary to a verifier's request.
      if (group.purpose !== request.purpose) {
        throw new Error(`llm-replay: out-of-loop call ${this.auxCursor} was recorded as "${group.purpose}" but the request asks for "${request.purpose}"`)
      }
      this.auxCursor += 1
      for (const chunk of group.chunks) yield chunk
      return
    }
    const group = this.script[this.cursor]
    if (!group) throw new Error(`llm-replay: no recorded step ${this.cursor} to replay`)
    this.cursor += 1
    for (const chunk of group) yield chunk
  }

  resolveModel(_model: string): ResolvedModel {
    return { contextWindow: this.contextWindow, defaultMaxTokens: 8192, reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' } }
  }

  listModels(): readonly ModelInfo[] {
    return [{ id: 'replay', name: 'Replay' }]
  }

  consumed(): number {
    return this.cursor
  }

  total(): number {
    return this.script.length
  }

  auxConsumed(): number {
    return this.auxCursor
  }

  auxTotal(): number {
    return this.auxScript.length
  }
}

export interface ReplayHandle {
  dispose: Disposer
  assertConsumed(): void
  readonly steps: number
  /** Recorded out-of-loop calls (compaction summaries) available to replay. */
  readonly auxCalls: number
}

/** Registers a replay adapter derived from `events` on `owner.llm`. */
export function installLlmReplay(
  owner: Context,
  options: { events: readonly EventEnvelope[]; provider?: string; contextWindow?: number; attempts?: ReplayAttempts },
): ReplayHandle {
  const script = deriveReplayScript(options.events, options.attempts)
  const auxScript = foldAuxCalls(options.events).map((record) => ({ purpose: record.purpose, chunks: auxCallChunks(record) }))
  // The window is a live adapter fact the log does not carry. A replay that
  // needs compaction to trigger where it did should pin an absolute budget on
  // the compaction row rather than hope two adapters agree about a window.
  const adapter = new ReplayAdapter(options.provider ?? 'deepseek', script, auxScript, options.contextWindow ?? 1_000_000)
  const dispose = owner.get(LLM).registerAdapter(owner, adapter)
  return {
    dispose,
    steps: script.length,
    auxCalls: auxScript.length,
    assertConsumed() {
      if (adapter.consumed() !== adapter.total()) {
        throw new Error(`llm-replay: replayed ${adapter.consumed()} of ${adapter.total()} recorded steps`)
      }
      if (adapter.auxConsumed() !== adapter.auxTotal()) {
        throw new Error(`llm-replay: replayed ${adapter.auxConsumed()} of ${adapter.auxTotal()} recorded out-of-loop calls`)
      }
    },
  }
}
