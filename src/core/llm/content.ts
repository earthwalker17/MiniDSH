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
import type { AttachmentRef, Attachments } from '../attachments/index.ts'
import { LlmError, type ContentBlock, type Message } from './types.ts'

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

/**
 * One block with every string a provider is sent made well-formed UTF-16: a
 * lone surrogate, which is what a cut between the two halves of an emoji
 * leaves, becomes U+FFFD. `JSON.stringify` writes a lone surrogate as an escape
 * that Anthropic, DeepSeek and OpenAI each answer with HTTP 400 "invalid JSON"
 * (measured 2026-11-21), and a logged message is part of every later request,
 * so one such character would fail its session for good, compaction included.
 *
 * Applied where a message is BUILT (`message.ts`, the tool pipeline, the
 * driver), never at serialization, so the log holds exactly what is sent (§4);
 * `core-session` refuses a surface event that got past it. Exhaustive like
 * `blockText`, and it returns the block it was given when nothing changed. A
 * call's id is left alone: it pairs records, it is not text. A call's
 * arguments get one rule more (`wellFormedArguments`).
 */
export function wellFormedBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
    case 'reasoning':
    case 'image':
      return block.text.isWellFormed() ? block : { ...block, text: block.text.toWellFormed() }
    case 'tool-call': {
      const name = block.name.toWellFormed()
      const args = wellFormedArguments(block.arguments)
      return name === block.name && args === block.arguments ? block : { ...block, name, arguments: args }
    }
    case 'tool-result': {
      const content = wellFormedContent(block.content)
      return content.every((inner, index) => inner === block.content[index]) ? block : { ...block, content }
    }
    default: {
      const exhaustive: never = block
      throw new Error(`wellFormedBlock: unhandled content block ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * One escape at a time: a surrogate PAIR written as two escapes, a lone
 * surrogate escape, or any other backslash and the character it escapes (so
 * the `ud83d` after an escaped backslash is never read as an escape).
 */
const ARGUMENT_ESCAPE = /\\(?:u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|u([dD][89a-fA-F][0-9a-fA-F]{2})|[\s\S])/g

/**
 * A tool call's arguments, made safe to send back. They are JSON TEXT, so they
 * can hold a lone surrogate a second way: as an ESCAPE (`"\ud83d"`), six
 * ordinary characters that decode to half a pair. Such a string is well-formed
 * and `toWellFormed` leaves it alone; a provider that decodes the arguments
 * does not. Measured 2026-11-21, the arguments sent back as history: OpenAI
 * answers HTTP 500 every time, Anthropic is sent them decoded and answers 400,
 * DeepSeek accepts. So an unpaired surrogate escape becomes `�`, and a
 * pair, an escaped backslash and every other character stay as written.
 *
 * A message built now passes through here (`wellFormedBlock`). A serializer
 * calls it too where the provider refuses, for a log written before this rule.
 */
export function wellFormedArguments(text: string): string {
  const formed = text.toWellFormed()
  if (!formed.includes('\\u')) return formed
  return formed.replace(ARGUMENT_ESCAPE, (escape: string, lone: string | undefined) => (lone === undefined ? escape : '\\ufffd'))
}

/** A fresh list of the same blocks, each made well-formed (`wellFormedBlock`). */
export function wellFormedContent(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map(wellFormedBlock)
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


/** One image an adapter is about to send: the reference the log carries, and the bytes for it. */
export interface ResolvedImage {
  readonly ref: AttachmentRef
  readonly data: Uint8Array
}

export interface ImageResolutionOptions {
  /** Whether the routed model advertises `image` — absent modalities mean text only. */
  readonly takesImages: boolean
  /** The mounted store, or nothing when the deployment has none. */
  readonly attachments: Attachments | undefined
  /** For the refusal messages, so a log names the route that could not take the content. */
  readonly provider: string
  readonly model: string
}

/**
 * The bytes an adapter will serialize, keyed by attachment id.
 *
 * The three outcomes are three different facts and each gets its own answer:
 *
 * - the route cannot take images -> an EMPTY map, and the serializer sends each
 *   block's stored descriptor. This is the only path that substitutes, and it
 *   exists because durable history outlives the model that first consumed it: a
 *   session that attached an image and later switched to a text-only route must
 *   stay usable, which is why admission (never let an image into history the
 *   CURRENT route cannot take) and projection (make history the current route
 *   cannot take readable) are both needed, not one or the other.
 * - the route takes images but nothing is mounted to hold them -> refused
 *   before any I/O, because the request cannot be served and the log should say
 *   so rather than quietly describing what the model was supposed to see.
 * - the bytes are gone or corrupt -> refused, loudly, for the same reason.
 *
 * A history with no image at all never touches the store.
 */
export async function resolveRequestImages(messages: readonly Message[], options: ImageResolutionOptions): Promise<ReadonlyMap<string, ResolvedImage>> {
  const refs = new Map<string, AttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  if (refs.size === 0 || !options.takesImages) return new Map()
  if (!options.attachments) {
    throw new LlmError('UNSUPPORTED_CONTENT', `no attachment store is mounted, so the image content this request carries cannot be sent to ${options.provider}/${options.model}`)
  }
  const resolved = new Map<string, ResolvedImage>()
  for (const [id, ref] of refs) {
    try {
      resolved.set(id, { ref, data: await options.attachments.readImage(ref) })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new LlmError('ATTACHMENT_UNREADABLE', `attachment ${id} cannot be read, so the request cannot be sent as the log records it: ${detail}`)
    }
  }
  return resolved
}
