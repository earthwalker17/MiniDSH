/**
 * Rendering for the terminal surface. Live output streams straight from
 * durable `assistant/chunk` events (text deltas as they arrive), so streaming
 * fidelity costs nothing beyond the log itself; every non-streaming line comes
 * from the projection every plain-text surface shares (`app/present.ts`). No
 * terminal state leaks in here — the controller owns interaction.
 */
import { formatTokens, meterSession } from '../../core/metering/index.ts'
import { ASSISTANT_CHUNK, ASSISTANT_MESSAGE, matches, TRACE_TYPES, TURN_END, type EventEnvelope } from '../../core/session/index.ts'
import type { StreamChunk } from '../../core/llm/index.ts'
import { describeEvent, transcriptLines } from '../present.ts'

/**
 * Folds live session events into raw terminal writes (may be partial lines).
 *
 * It also keeps the events it has seen so it can run the shared metering fold
 * (`core/metering`) — the client computes context pressure from the same
 * durable facts the runtime does, rather than being told a number. `seed` takes
 * the attach snapshot so a resumed session meters its whole history.
 */
export class TerminalRenderer {
  private streaming = false
  private thinking = false
  private readonly seen: EventEnvelope[] = []
  /** Learned from the `initialize` catalog, which the client reads after construction. */
  private contextWindow = 0

  useContextWindow(tokens: number): void {
    this.contextWindow = tokens
  }

  /** Records history rendered by `renderHistory`, which never passes through `onEvent`. */
  seed(events: readonly EventEnvelope[]): void {
    for (const event of events) if (!TRACE_TYPES.has(event.type)) this.seen.push(event)
  }

  /**
   * `[ctx 34% · 12.4k/128k]`, or '' when no window is known.
   *
   * The denominator is the MODEL's window, which is a fact this client can
   * know. A deployment may compact earlier than that — `budgetTokens` is
   * policy the wire does not carry — so this line answers "how full is the
   * window", and the `[compacted …]` line answers "and the runtime acted".
   * Claiming to show the runtime's own budget would be claiming to know
   * something the client cannot see.
   */
  private contextLine(): string {
    const budget = this.contextWindow
    if (budget <= 0) return ''
    const metrics = meterSession(this.seen, budget)
    if (metrics.projectedTokens === 0) return ''
    const percent = Math.round(metrics.ratio * 100)
    return `[ctx ${percent}% · ${formatTokens(metrics.projectedTokens)}/${formatTokens(budget)}]\n`
  }

  onEvent(event: EventEnvelope): string {
    // The trace tier is the bulk of a long session by two orders of magnitude
    // and the meter never reads it: keeping it would make every rendered line
    // an O(all chunks) fold and retain the whole stream in the client. The same
    // classification the runtime's own folds use (`Session.facts`).
    if (!TRACE_TYPES.has(event.type)) this.seen.push(event)
    // The streaming cases are the terminal's own; everything else is the shared projection.
    if (matches(event, ASSISTANT_CHUNK)) {
      const chunk = event.data.chunk as unknown as StreamChunk
      if (chunk.type === 'text-delta') {
        this.streaming = true
        return chunk.text
      }
      if (chunk.type === 'reasoning-delta' && !this.thinking) {
        this.thinking = true
        return '… thinking\n'
      }
      if (chunk.type === 'finish') {
        const closer = this.streaming ? '\n' : ''
        this.streaming = false
        this.thinking = false
        return closer
      }
      return ''
    }
    // The step is priced here, so this is where the number can change; the
    // text itself already streamed.
    if (matches(event, ASSISTANT_MESSAGE)) return this.contextLine()
    // A completed turn needs no line; the prompt returning says it.
    if (matches(event, TURN_END) && event.data.reason.kind === 'completed') return ''
    const line = describeEvent(event)
    return line === undefined ? '' : `${line}\n`
  }
}

/** Folds a stored log into a conversation transcript for an attaching client. */
export function renderHistory(events: readonly EventEnvelope[]): string {
  const lines = transcriptLines(events)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
