/**
 * MiniDSH history → Messages API turns.
 *
 * The API wants strict user/assistant alternation, tool results as
 * `tool_result` blocks FIRST in the user turn that follows the assistant's
 * `tool_use`, and — inside a tool-use turn — the assistant's own thinking
 * blocks echoed verbatim with their signatures. MiniDSH history is a flat
 * list where a tool result is a user-role message, so consecutive user-role
 * messages merge into one turn (results first, then text), and a reasoning
 * block is sent back as `thinking` only when this provider produced it and
 * the message's replay envelope still holds its signature: a foreign or
 * unsigned reasoning block is dropped, never forged. Empty text is never
 * sent (the API refuses it).
 *
 * A `tool_result`'s content stays a plain STRING unless it actually carries an
 * image, for the same reason the sibling adapter keeps its string form: not
 * moving a prefix that already exists. An image the caller could not resolve —
 * a text-only route — is serialized as the block's own stored descriptor.
 */
import { blockText, contentText, type ResolvedImage } from '../../core/llm/content.ts'
import type { ContentBlock, Message, ToolSchema } from '../../core/llm/index.ts'
import { ANTHROPIC_PROVIDER, type AnthropicReplayBlock } from './translate.ts'

export type WireBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'redacted_thinking'; readonly data: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string } }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string | WireBlock[]; readonly is_error?: boolean }

export interface WireMessage {
  readonly role: 'user' | 'assistant'
  readonly content: WireBlock[]
}

export interface WireTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

export type ImageBytes = ReadonlyMap<string, ResolvedImage>

/** See the DeepSeek serializer: `contentText`, so an image contributes its descriptor rather than vanishing. */
function textOf(blocks: readonly ContentBlock[]): string {
  return contentText(blocks)
}

function parseInput(args: string): unknown {
  try {
    const parsed: unknown = JSON.parse(args)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function imageBlock(image: ResolvedImage): WireBlock {
  return { type: 'image', source: { type: 'base64', media_type: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') } }
}

/**
 * Blocks as wire blocks, coalescing adjacent text. `undefined` when nothing here
 * resolved to an image, so the caller keeps the string form it already had.
 */
function blocksOf(blocks: readonly ContentBlock[], images: ImageBytes): WireBlock[] | undefined {
  const out: WireBlock[] = []
  let text = ''
  let sawImage = false
  const flush = (): void => {
    if (text.length > 0) out.push({ type: 'text', text })
    text = ''
  }
  for (const block of blocks) {
    const image = block.type === 'image' ? images.get(block.attachment.id) : undefined
    if (image) {
      sawImage = true
      flush()
      out.push(imageBlock(image))
      continue
    }
    text += blockText(block)
  }
  flush()
  return sawImage ? out : undefined
}

/** No image path: an assistant message cannot carry one, because `validateStream` refuses the stream that would. */
function assistantBlocks(message: Message): WireBlock[] {
  const replay = replayBlocksOf(message)
  const out: WireBlock[] = []
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      if (block.text.length > 0) out.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning') {
      const entry = replay?.[index] ?? null
      if (entry?.type === 'thinking') out.push({ type: 'thinking', thinking: block.text, signature: entry.signature })
      else if (entry?.type === 'redacted_thinking') out.push({ type: 'redacted_thinking', data: entry.data })
      // Foreign or unsigned reasoning: the model is not shown a thought it cannot verify.
    } else if (block.type === 'tool-call') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: parseInput(block.arguments) })
    }
  })
  return out
}

/** The replay entries beside this message's blocks, when this provider wrote them. */
function replayBlocksOf(message: Message): readonly AnthropicReplayBlock[] | undefined {
  const source = message.source
  if (source.kind !== 'assistant' || source.provider !== ANTHROPIC_PROVIDER) return undefined
  const blocks = source.replayState?.blocks
  if (!blocks || blocks.length !== message.content.length) return undefined
  return blocks as readonly AnthropicReplayBlock[]
}

function userBlocks(message: Message, images: ImageBytes): WireBlock[] {
  if (message.source.kind === 'tool') {
    const result = message.content.find((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    // Probed: an image inside a `tool_result`'s content array is accepted and
    // downscaled like any other, which is where every image MiniDSH produces
    // lives. The nested blocks stay INSIDE the tool result; the turn-level sort
    // below only ever reorders top-level blocks.
    const nested = result ? blocksOf(result.content, images) : undefined
    const content = nested ?? (result ? textOf(result.content) : '')
    const body = typeof content === 'string' ? (content.length > 0 ? content : '(no output)') : content
    return [{ type: 'tool_result', tool_use_id: message.source.callId, content: body, ...(result?.isError ? { is_error: true } : {}) }]
  }
  const blocks = blocksOf(message.content, images)
  if (blocks) return blocks
  const text = textOf(message.content)
  return text.length > 0 ? [{ type: 'text', text }] : []
}

/** Serializes history; the system prompt travels as its own field. Turns of one role merge, results first. */
export function serializeMessages(messages: readonly Message[], images: ImageBytes = new Map()): WireMessage[] {
  const turns: { role: 'user' | 'assistant'; content: WireBlock[] }[] = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = role === 'assistant' ? assistantBlocks(message) : userBlocks(message, images)
    if (blocks.length === 0) continue
    const last = turns.at(-1)
    if (last && last.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }
  // Within a user turn, every tool_result precedes any text — the API's rule.
  for (const turn of turns) {
    if (turn.role === 'user') turn.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'))
  }
  return turns
}

export function serializeTools(tools: readonly ToolSchema[] | undefined): WireTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
}
