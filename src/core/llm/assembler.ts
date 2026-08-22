import { asCallId } from '../ids.ts'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from './types.ts'

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
 * incomplete tool-call blocks.
 */
export class BlockAssembler {
  private readonly partials = new Map<number, Partial>()
  private readonly order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason = { kind: 'stop' }

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

  blocks(): ContentBlock[] {
    const dropToolCalls = this._finish.kind === 'max-tokens'
    const out: ContentBlock[] = []
    for (const index of this.order) {
      const block = this.assemble(this.partials.get(index)!)
      if (!block) continue
      if (dropToolCalls && block.type === 'tool-call') continue
      out.push(block)
    }
    return out
  }

  get usage(): TokenUsage | undefined {
    return this._usage
  }

  get finish(): FinishReason {
    return this._finish
  }
}
