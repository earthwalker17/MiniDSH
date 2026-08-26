import { restoreMessage } from '../llm/message.ts'
import type { Message } from '../llm/types.ts'
import {
  ASSISTANT_MESSAGE,
  matches,
  REQUEST_HEADER,
  SURFACE_TYPES,
  TOOL_RESULT,
  USER_MESSAGE,
  type EventEnvelope,
  type RequestHeader,
} from './types.ts'

/**
 * THE per-node projection rule, shared by the store and the reconstruction
 * invariant so no two paths can disagree. `assistant/chunk` is never a surface
 * event, so it never reaches here; an empty assistant message projects to null.
 */
export function deriveEventMessage(event: EventEnvelope): Message | null {
  if (matches(event, USER_MESSAGE)) return restoreMessage(event.data.message)
  if (matches(event, ASSISTANT_MESSAGE)) {
    const message = event.data.message
    return message.content.length === 0 ? null : restoreMessage(message)
  }
  if (matches(event, TOOL_RESULT)) return restoreMessage(event.data.message)
  return null
}

/** The latest request header folded from the log, or undefined if none written. */
export function foldRequestHeader(events: readonly EventEnvelope[]): RequestHeader | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, REQUEST_HEADER)) return event.data.header
  }
  return undefined
}

/**
 * The current surface node list folded from a raw event stream — the same rule
 * a live `Session` maintains incrementally, for readers that hold only events
 * (a protocol client, the metering fold, a stored log). Structural validation
 * already happened at append, so this only applies.
 */
export function foldSurfaceSeqs(events: readonly EventEnvelope[]): readonly number[] {
  const surface = new Surface()
  for (const event of events) surface.apply(event)
  return surface.seqs()
}

/**
 * Ordered list of surface-event seqs with replace support. `append` pushes;
 * `replace` collapses a contiguous run of current nodes into the new node.
 * Message derivation folds `nodes` through `deriveEventMessage`.
 */
export class Surface {
  private readonly nodes: number[] = []
  private generation = 0

  get replaceGeneration(): number {
    return this.generation
  }

  seqs(): readonly number[] {
    return this.nodes
  }

  /** Validates a surface event's placement; throws before the event is committed. */
  validate(event: EventEnvelope): void {
    const isSurface = SURFACE_TYPES.has(event.type)
    if (isSurface !== (event.surfaceOp !== undefined)) {
      throw new Error(`event "${event.type}" ${isSurface ? 'requires' : 'must not carry'} a surfaceOp`)
    }
    if (!isSurface) {
      if (event.sourceEventSeqs !== undefined) throw new Error(`non-surface event "${event.type}" carries sourceEventSeqs`)
      return
    }
    const seqs = event.sourceEventSeqs ?? []
    for (const seq of seqs) {
      if (!Number.isInteger(seq) || seq < 0 || seq >= event.seq) throw new Error(`sourceEventSeqs must reference earlier events`)
    }
    if (new Set(seqs).size !== seqs.length) throw new Error('sourceEventSeqs has duplicates')
    const op = event.surfaceOp!
    if (op.op === 'replace') {
      const start = this.nodes.indexOf(op.start)
      const end = this.nodes.indexOf(op.end)
      if (start < 0 || end < 0 || start > end) throw new Error(`replace range [${op.start}, ${op.end}] is not a current contiguous surface run`)
      const shadowed = this.nodes.slice(start, end + 1)
      for (const seq of shadowed) {
        if (!seqs.includes(seq)) throw new Error(`replace must cite every shadowed node (missing ${seq})`)
      }
    }
  }

  /** Applies a validated surface event to the node list. */
  apply(event: EventEnvelope): void {
    const op = event.surfaceOp
    if (!op) return
    if (op.op === 'append') {
      this.nodes.push(event.seq)
      return
    }
    const start = this.nodes.indexOf(op.start)
    const end = this.nodes.indexOf(op.end)
    this.nodes.splice(start, end - start + 1, event.seq)
    this.generation++
  }
}
