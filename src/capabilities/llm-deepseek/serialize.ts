/**
 * MiniDSH history → DeepSeek wire messages.
 *
 * Content is a plain STRING wherever a message carries no image, byte for byte
 * as it always was. Only a message that actually holds one becomes an array of
 * parts. That is not a style choice: widening every message would change the
 * bytes of every message serialized BEFORE the first image, so attaching one at
 * turn 12 would retroactively rewrite turns 1-11 and cost the provider's prefix
 * cache for the rest of the session — and every pre-S8 session would re-pay its
 * whole prompt on the first request after the upgrade. (Measured: the provider
 * normalizes `[{type:'text',text}]` to the same tokens as a string, so array
 * form costs nothing per se — 5120 cached tokens either way. The rule is about
 * not moving a prefix that already exists.)
 *
 * An image the caller could not resolve — a text-only route — is serialized as
 * the block's own stored descriptor by `contentText`. It is never dropped.
 */
import { blockText, contentText, type ResolvedImage } from '../../core/llm/content.ts'
import type { ContentBlock, Message, ToolSchema } from '../../core/llm/index.ts'

/** One part of a multimodal message; the provider's OpenAI-compatible shape. */
export type WirePart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }

export interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | WirePart[]
  readonly reasoning_content?: string
  readonly tool_call_id?: string
  readonly tool_calls?: readonly { readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }[]
}

export interface WireTool {
  readonly type: 'function'
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }
}

export type ImageBytes = ReadonlyMap<string, ResolvedImage>

/**
 * The text a run of blocks says. `contentText`, not a `type === 'text'` filter:
 * an image block carries its own descriptor, and dropping it would put a message
 * on the wire that the log says had one more thing in it.
 */
function textOf(blocks: readonly ContentBlock[]): string {
  return contentText(blocks)
}

function reasoningOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
}

/** A data URI, which is how this provider takes inline bytes. */
function dataUrl(image: ResolvedImage): string {
  return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

/**
 * Blocks as wire parts, in order, coalescing adjacent text so a message with one
 * image is `[text, image]` rather than a part per block. Returns `undefined`
 * when nothing here resolved to an image, so the caller keeps the string form.
 */
function partsOf(blocks: readonly ContentBlock[], images: ImageBytes): WirePart[] | undefined {
  const parts: WirePart[] = []
  let text = ''
  let sawImage = false
  const flush = (): void => {
    if (text.length > 0) parts.push({ type: 'text', text })
    text = ''
  }
  for (const block of blocks) {
    const image = block.type === 'image' ? images.get(block.attachment.id) : undefined
    if (image) {
      sawImage = true
      flush()
      parts.push({ type: 'image_url', image_url: { url: dataUrl(image) } })
      continue
    }
    text += blockText(block)
  }
  flush()
  return sawImage ? parts : undefined
}

/**
 * Serializes MiniDSH messages to DeepSeek wire messages. Assistant `content` is
 * `""`, never null. `images` carries the bytes the adapter resolved for this
 * request; an empty map means every image serializes as its descriptor.
 */
export function serializeMessages(system: string | undefined, messages: readonly Message[], images: ImageBytes = new Map()): WireMessage[] {
  const wire: WireMessage[] = []
  if (system && system.length > 0) wire.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.source.kind === 'tool') {
      const block = message.content.find((b): b is Extract<ContentBlock, { type: 'tool-result' }> => b.type === 'tool-result')
      // Probed: this provider accepts an array-shaped `tool` message carrying an
      // image, which is where every image MiniDSH produces actually lives.
      const parts = block ? partsOf(block.content, images) : undefined
      wire.push({ role: 'tool', tool_call_id: message.source.callId, content: parts ?? (block ? textOf(block.content) || '(no output)' : '(no output)') })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: b.arguments } }))
      // `reasoning_content` is ALWAYS present, empty when the turn had none:
      // in thinking mode with tools attached, DeepSeek refuses an assistant
      // tool-call turn that omits it (400, probed 2026-08-30) — and a turn
      // another provider produced has none to give. An empty string is
      // accepted; omission is not. No image path here: an assistant message
      // cannot carry one (`validateStream` refuses the stream that would).
      wire.push({
        role: 'assistant',
        content: textOf(message.content),
        reasoning_content: reasoningOf(message.content),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    const parts = partsOf(message.content, images)
    wire.push({ role: 'user', content: parts ?? textOf(message.content) })
  }
  return wire
}

export function serializeTools(tools: readonly ToolSchema[] | undefined): WireTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}
