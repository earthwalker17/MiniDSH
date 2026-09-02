/**
 * The one projection from a content block to human- and provider-facing text.
 *
 * It exists because a probe found the alternative: adding a variant to the
 * `ContentBlock` union today changes nothing at six separate sites — the meter
 * scores it 0, both serializers drop it on the wire, and three surfaces render
 * it as nothing — and none of those sites is a `switch` the type checker would
 * flag. `blockText` is exhaustive over the union, so the next variant is a
 * compile error here instead of a silence somewhere else.
 *
 * The projections it replaces were `.filter(block.type === 'text')` chains, and
 * it reproduces them exactly for the four original kinds: reasoning, tool calls
 * and the tool-result envelope contribute nothing, because none of them is part
 * of what a message SAYS. An image contributes its own stored descriptor.
 */
import type { AttachmentRef } from '../attachments/index.ts'
import type { ContentBlock } from './types.ts'

/** `12.4 KB`-style, for a descriptor a human reads in a transcript. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/**
 * The text an image block carries INSTEAD of its bytes, computed once when the
 * block is built and stored with it.
 *
 * Storing it rather than deriving it at render time is the point: this string
 * is what a text-only route is actually sent, so freezing it means a later
 * change to the wording cannot rewrite what an old log claims the model saw.
 * That is the same reason the log stores a message rather than a recipe for one.
 */
export function imageDescriptor(ref: AttachmentRef): string {
  const name = ref.name === undefined ? 'image' : ref.name
  return `[image ${name} · ${ref.mediaType} · ${ref.width}×${ref.height} · ${formatBytes(ref.bytes)}]`
}

/**
 * What one block says, as text. Exhaustive by construction: the `never`
 * assignment below is what makes a new variant fail to compile rather than
 * silently project to nothing.
 */
export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
      return block.text
    case 'reasoning':
    case 'tool-call':
    case 'tool-result':
      // Not part of what a message says: reasoning is not the answer, a tool
      // call is a request, and a tool result's own content is projected by
      // whoever unwraps it (`contentText`).
      return ''
    default: {
      const exhaustive: never = block
      throw new Error(`blockText: unhandled content block ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** The text a run of blocks says — the projection every serializer and surface shares. */
export function contentText(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) out += blockText(block)
  return out
}

/** Every image reference in a run of blocks, including inside a tool result, in order and deduped by id. */
export function collectImageRefs(blocks: readonly ContentBlock[], into: Map<string, AttachmentRef> = new Map()): Map<string, AttachmentRef> {
  for (const block of blocks) {
    if (block.type === 'image') {
      if (!into.has(block.attachment.id)) into.set(block.attachment.id, block.attachment)
    } else if (block.type === 'tool-result') {
      collectImageRefs(block.content, into)
    }
  }
  return into
}

/** True when any block, at any depth, carries an image. */
export function hasImage(blocks: readonly ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && hasImage(block.content)) return true
  }
  return false
}
