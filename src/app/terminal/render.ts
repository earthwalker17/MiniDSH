/**
 * Rendering for the terminal surface. Live output streams straight from
 * durable `assistant/chunk` events (text deltas as they arrive), so streaming
 * fidelity costs nothing beyond the log itself; every non-streaming line comes
 * from the projection every plain-text surface shares (`app/present.ts`). No
 * terminal state leaks in here — the controller owns interaction.
 */
import { formatTokens, type ContextMetrics } from '../../core/metering/index.ts'
import { ASSISTANT_CHUNK, ASSISTANT_MESSAGE, matches, TURN_END, type EventEnvelope } from '../../core/session/index.ts'
import { APPROVAL_ASKED } from '../../core/approval/index.ts'
import type { StreamChunk } from '../../core/llm/index.ts'
import type { SessionView } from '../../capabilities/protocol/index.ts'
import { describeEvent, transcriptLines } from '../present.ts'

/**
 * Folds live session events into raw terminal writes (may be partial lines).
 *
 * It retains NOTHING of the session. Context pressure used to be metered here
 * from a client-side copy of every fact, which only worked while the client was
 * handed the whole log; a client holding a page cannot fold it, so the host —
 * which owns the fold already — publishes the numbers and this renders them.
 */
export class TerminalRenderer {
  private streaming = false
  private thinking = false
  /** The last numbers published, so an unchanged view prints nothing. */
  private context: ContextMetrics | undefined

  /**
   * `[ctx 34% · 12.4k/128k]`, or '' when the host has nothing to report.
   *
   * The denominator is the window the log names for the route in use. A
   * deployment may compact earlier than that — its own `budgetTokens` is policy
   * the wire does not carry — so this line answers "how full is the window",
   * and the `[compacted …]` line answers "and the runtime acted".
   */
  onView(view: SessionView): string {
    const next = view.context
    if (!next || next.budgetTokens <= 0 || next.projectedTokens === 0) return ''
    if (this.context?.projectedTokens === next.projectedTokens && this.context.budgetTokens === next.budgetTokens) return ''
    this.context = next
    return `[ctx ${Math.round(next.ratio * 100)}% · ${formatTokens(next.projectedTokens)}/${formatTokens(next.budgetTokens)}]\n`
  }

  onEvent(event: EventEnvelope): string {
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
    // The text already streamed, and the shared projection would print it
    // again; the pressure it changed arrives as the view that follows it.
    if (matches(event, ASSISTANT_MESSAGE)) return ''
    // A completed turn needs no line; the prompt returning says it. An ask is
    // rendered by the controller's `[y/N]` prompt, so its line would be a twin.
    if (matches(event, TURN_END) && event.data.reason.kind === 'completed') return ''
    if (matches(event, APPROVAL_ASKED)) return ''
    const line = describeEvent(event)
    return line === undefined ? '' : `${line}\n`
  }
}

/** Folds a stored log into a conversation transcript for an attaching client. */
export function renderHistory(events: readonly EventEnvelope[]): string {
  const lines = transcriptLines(events)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
