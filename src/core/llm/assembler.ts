import { asCallId } from '../ids.ts'
import type { ContentBlock, FinishReason, ReplayEnvelope, StreamChunk, TokenUsage } from './types.ts'

interface Partial {
  blockType: ContentBlock['type']
  text: string
  toolId?: string
  toolName?: string
  toolArgs: string
  finalized?: ContentBlock
}

/**
 * Folds a chunk stream into assembled content blocks plus usage and finish.
 * Tolerant of delta-only protocols (a delta opens its block); `block-end`'s
 * block, when present, is authoritative. A `max-tokens` finish drops
 * incomplete tool-call blocks — and the replay envelope's per-block entries
 * are pruned in the same pass, so what is stored beside a message always
 * aligns with the blocks the message actually carries.
 */
export class BlockAssembler {
  private readonly partials = new Map<number, Partial>()
  private readonly order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason = { kind: 'stop' }
  private _replay: ReplayEnvelope | undefined

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start':
        this.open(chunk.index, chunk.blockType)
        break
      case 'text-delta': {
        const partial = this.open(chunk.index, 'text')
        partial.text += chunk.text
        break
      }
      case 'reasoning-delta': {
        const partial = this.open(chunk.index, 'reasoning')
        partial.text += chunk.text
        break
      }
      case 'tool-call-delta': {
        const partial = this.open(chunk.index, 'tool-call')
        if (chunk.id !== undefined) partial.toolId = chunk.id
        if (chunk.name !== undefined) partial.toolName = chunk.name
        partial.toolArgs += chunk.argumentsDelta
        break
      }
      case 'block-end': {
        const partial = this.open(chunk.index, chunk.block.type)
        partial.finalized = chunk.block
        break
      }
      case 'usage':
        this._usage = chunk.usage
        break
      case 'finish':
        this._finish = chunk.reason
        this._replay = chunk.replayState
        break
    }
  }

  private open(index: number, blockType: ContentBlock['type']): Partial {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolArgs: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: Partial): ContentBlock | undefined {
    if (partial.finalized) return partial.finalized
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text }
      case 'reasoning':
        return { type: 'reasoning', text: partial.text }
      case 'tool-call':
        if (partial.toolId === undefined || partial.toolName === undefined) return undefined
        return { type: 'tool-call', id: asCallId(partial.toolId), name: partial.toolName, arguments: partial.toolArgs || '{}' }
      case 'tool-result':
        return undefined
    }
  }

  /** The assembled blocks, and which opened positions survived (for pruning the replay envelope in step). */
  private fold(): { blocks: ContentBlock[]; kept: number[] } {
    const dropToolCalls = this._finish.kind === 'max-tokens'
    const blocks: ContentBlock[] = []
    const kept: number[] = []
    this.order.forEach((index, position) => {
      const block = this.assemble(this.partials.get(index)!)
      if (!block) return
      if (dropToolCalls && block.type === 'tool-call') return
      blocks.push(block)
      kept.push(position)
    })
    return { blocks, kept }
  }

  blocks(): ContentBlock[] {
    return this.fold().blocks
  }

  /**
   * The finish's replay envelope, its per-block entries pruned to the blocks
   * `blocks()` kept. An envelope whose `blocks` do not align one-to-one with
   * the opened blocks is discarded whole: a misaligned signature is worse
   * than none, because the provider would reject or misattribute it.
   */
  get replayState(): ReplayEnvelope | undefined {
    const envelope = this._replay
    if (!envelope) return undefined
    if (envelope.blocks === undefined) return envelope
    if (envelope.blocks.length !== this.order.length) return undefined
    const { kept } = this.fold()
    return { response: envelope.response, blocks: kept.map((position) => envelope.blocks![position]!) }
  }

  get usage(): TokenUsage | undefined {
    return this._usage
  }

  get finish(): FinishReason {
    return this._finish
  }
}
