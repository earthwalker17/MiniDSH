/**
 * Replay-from-the-log adapter. The model script is DERIVED from a recorded
 * session's `assistant/chunk` events (grouped by turn/step), so recording is
 * free: run the real agent once, harvest its JSONL, replay it keylessly.
 * `assertConsumed()` fails if any recorded step was not replayed.
 */
import type { Context, Disposer } from '../kernel/index.ts'
import { LLM, type LlmAdapter, type LlmRequest, type ModelInfo, type ResolvedModel, type StreamChunk } from '../core/llm/index.ts'
import { matches, ASSISTANT_CHUNK, type EventEnvelope } from '../core/session/index.ts'

/**
 * Groups recorded `assistant/chunk` payloads into one chunk list per (turn,
 * step), in order. A step that was retried carries several attempts; only the
 * last attempt is what the agent acted on, so it alone is replayed (logs
 * written before `attempt` existed count as a single attempt).
 */
export function deriveReplayScript(events: readonly EventEnvelope[]): StreamChunk[][] {
  const groups = new Map<string, { attempt: number; chunks: StreamChunk[] }>()
  const order: string[] = []
  for (const event of events) {
    if (!matches(event, ASSISTANT_CHUNK)) continue
    const key = `${event.data.turn}:${event.data.step}`
    let group = groups.get(key)
    let attempt = event.data.attempt as number | undefined
    if (attempt === undefined) {
      // Logs recorded before `attempt` existed: exactly one finish ends an attempt,
      // so a chunk arriving after a finish belongs to the next attempt.
      attempt = !group ? 1 : group.chunks.at(-1)?.type === 'finish' ? group.attempt + 1 : group.attempt
    }
    if (!group) {
      group = { attempt, chunks: [] }
      groups.set(key, group)
      order.push(key)
    } else if (attempt > group.attempt) {
      group.attempt = attempt
      group.chunks = []
    } else if (attempt < group.attempt) {
      continue
    }
    group.chunks.push(event.data.chunk as unknown as StreamChunk)
  }
  return order.map((key) => groups.get(key)!.chunks)
}

class ReplayAdapter implements LlmAdapter {
  readonly provider: string
  private readonly script: StreamChunk[][]
  private cursor = 0
  constructor(provider: string, script: StreamChunk[][]) {
    this.provider = provider
    this.script = script
  }

  async *stream(_request: LlmRequest): AsyncIterable<StreamChunk> {
    const group = this.script[this.cursor]
    if (!group) throw new Error(`llm-replay: no recorded step ${this.cursor} to replay`)
    this.cursor += 1
    for (const chunk of group) yield chunk
  }

  resolveModel(_model: string): ResolvedModel {
    return { contextWindow: 1_000_000, defaultMaxTokens: 8192, reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' } }
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
}

export interface ReplayHandle {
  dispose: Disposer
  assertConsumed(): void
  readonly steps: number
}

/** Registers a replay adapter derived from `events` on `owner.llm`. */
export function installLlmReplay(owner: Context, options: { events: readonly EventEnvelope[]; provider?: string }): ReplayHandle {
  const script = deriveReplayScript(options.events)
  const adapter = new ReplayAdapter(options.provider ?? 'deepseek', script)
  const dispose = owner.get(LLM).registerAdapter(owner, adapter)
  return {
    dispose,
    steps: script.length,
    assertConsumed() {
      if (adapter.consumed() !== adapter.total()) {
        throw new Error(`llm-replay: replayed ${adapter.consumed()} of ${adapter.total()} recorded steps`)
      }
    },
  }
}
