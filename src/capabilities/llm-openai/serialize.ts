/**
 * MiniDSH history → Responses API input items.
 *
 * The request is stateless (`store: false`), so each request carries the whole
 * history as items: user messages, assistant text, `function_call` and
 * `function_call_output` pairs keyed by `call_id`, and — for history this
 * provider wrote — the reasoning items it sealed. The system prompt is not
 * here; it travels as `instructions`.
 *
 * REPLAY is decided per message, by a pure function of what the log records:
 * the message's `source.provider` and `source.model` against the request's
 * model, both folded to their canonical id (`catalog.ts`), plus an envelope
 * that still aligns with the blocks. Under REPLAY a sealed reasoning block
 * goes back as its `rs_` item (with `summary: []`), a text block as its `msg_`
 * item with its `phase`, a tool call with its `fc_` id. Anything else — another
 * provider's history, another model's, an unsealed thought — goes back as
 * plain `{role, content}` text and an id-less `function_call`, and its
 * reasoning is dropped, never forged. Because the drop depends only on logged
 * fields, what the model is shown is still what the log says
 * (`core/loop/invariant.ts`).
 *
 * Measured 2026-10-16: the API answers 200 to every one of these shapes AND to
 * the ones this file refuses to send — foreign call ids, items with or without
 * ids, one model's reasoning sent to another (silently omitted). Its leniency
 * proves nothing about this serializer, so the tests pin the shapes.
 */
import { blockText, contentText, type ResolvedImage } from '../../core/llm/content.ts'
import type { ContentBlock, Message, ToolSchema } from '../../core/llm/index.ts'
import { canonicalModel } from './catalog.ts'
import { OPENAI_PROVIDER, type OpenAIReplayBlock } from './translate.ts'

export type InputPart = { readonly type: 'input_text'; readonly text: string } | { readonly type: 'input_image'; readonly image_url: string }

export type InputItem =
  | { readonly role: 'user'; readonly content: InputPart[] }
  | { readonly role: 'assistant'; readonly content: string }
  | {
      readonly type: 'message'
      readonly role: 'assistant'
      readonly id: string
      readonly status: 'completed'
      readonly content: readonly { readonly type: 'output_text'; readonly text: string; readonly annotations: readonly never[] }[]
      readonly phase?: string
    }
  | { readonly type: 'reasoning'; readonly id: string; readonly summary: readonly never[]; readonly encrypted_content: string }
  | { readonly type: 'function_call'; readonly call_id: string; readonly name: string; readonly arguments: string; readonly id?: string }
  | { readonly type: 'function_call_output'; readonly call_id: string; readonly output: string | InputPart[] }

export interface WireTool {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly strict: false
}

export type ImageBytes = ReadonlyMap<string, ResolvedImage>

/** A data URL, which is how `input_image` takes inline bytes (measured: read correctly in a user message and inside a tool output). */
function dataUrl(image: ResolvedImage): string {
  return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

/**
 * Blocks as input parts, coalescing adjacent text. An image this request did
 * not resolve — a text-only route — contributes its stored descriptor through
 * `blockText`, never nothing.
 */
function partsOf(blocks: readonly ContentBlock[], images: ImageBytes): { parts: InputPart[]; sawImage: boolean } {
  const parts: InputPart[] = []
  let text = ''
  let sawImage = false
  const flush = (): void => {
    if (text.length > 0) parts.push({ type: 'input_text', text })
    text = ''
  }
  for (const block of blocks) {
    const image = block.type === 'image' ? images.get(block.attachment.id) : undefined
    if (image) {
      sawImage = true
      flush()
      parts.push({ type: 'input_image', image_url: dataUrl(image) })
      continue
    }
    text += blockText(block)
  }
  flush()
  return { parts, sawImage }
}

/**
 * The replay entries beside this message's blocks, when this provider wrote
 * them FOR THIS MODEL'S FAMILY and they still align; otherwise nothing, and
 * the message goes back as plain history.
 */
function replayEntriesOf(message: Message, requestModel: string): readonly unknown[] | undefined {
  const source = message.source
  if (source.kind !== 'assistant' || source.provider !== OPENAI_PROVIDER) return undefined
  if (canonicalModel(source.model) !== canonicalModel(requestModel)) return undefined
  const blocks = source.replayState?.blocks
  if (!blocks || blocks.length !== message.content.length) return undefined
  return blocks
}

/** One entry, read defensively: it came back from a durable log, and a malformed one replays as nothing. */
function entryAt(entries: readonly unknown[] | undefined, index: number): OpenAIReplayBlock {
  const entry = entries?.[index]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const fields = entry as Record<string, unknown>
  const id = fields.id
  if (typeof id !== 'string' || id.length === 0) return null
  switch (fields.type) {
    case 'reasoning':
      return typeof fields.encrypted_content === 'string' && fields.encrypted_content.length > 0 ? { type: 'reasoning', id, encrypted_content: fields.encrypted_content } : null
    case 'message':
      return typeof fields.phase === 'string' ? { type: 'message', id, phase: fields.phase } : { type: 'message', id }
    case 'function_call':
      return { type: 'function_call', id }
    default:
      return null
  }
}

/** No image path: an assistant message cannot carry one, because `validateStream` refuses the stream that would. */
function assistantItems(message: Message, requestModel: string): InputItem[] {
  const entries = replayEntriesOf(message, requestModel)
  const out: InputItem[] = []
  message.content.forEach((block, index) => {
    const entry = entryAt(entries, index)
    switch (block.type) {
      case 'reasoning':
        // Measured: a reasoning item replays with `summary: []`, and as the
        // last item with nothing after it. Foreign, another model's, or
        // unsealed: the model is not shown a thought the API cannot verify.
        if (entry?.type === 'reasoning') out.push({ type: 'reasoning', id: entry.id, summary: [], encrypted_content: entry.encrypted_content })
        break
      case 'text':
        if (block.text.length === 0) break
        if (entry?.type === 'message') {
          out.push({
            type: 'message',
            role: 'assistant',
            id: entry.id,
            status: 'completed',
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
            // OpenAI's guidance is to resend `phase` on every assistant message
            // it wrote; dropping it can degrade the next answer.
            ...(entry.phase === undefined ? {} : { phase: entry.phase }),
          })
        } else {
          out.push({ role: 'assistant', content: block.text })
        }
        break
      case 'tool-call':
        // A tool-call block's id IS the `call_id`, the key its output answers
        // to; the `fc_` item id is replay state and goes back only under REPLAY.
        out.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments, ...(entry?.type === 'function_call' ? { id: entry.id } : {}) })
        break
      case 'image':
      case 'tool-result':
        // Neither can be in an assistant message (`validateStream`).
        break
    }
  })
  return out
}

function toolOutputItem(callId: string, message: Message, images: ImageBytes): InputItem {
  const result = message.content.find((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
  // The array form only when the result actually carries an image, and a plain
  // string otherwise. There is no error flag on the wire: a failed result says
  // so in its own text, which is what the pipeline renders.
  const { parts, sawImage } = result ? partsOf(result.content, images) : { parts: [], sawImage: false }
  if (sawImage) return { type: 'function_call_output', call_id: callId, output: parts }
  const text = result ? contentText(result.content) : ''
  return { type: 'function_call_output', call_id: callId, output: text.length > 0 ? text : '(no output)' }
}

/**
 * Serializes history for a request to `requestModel`. `images` carries the
 * bytes the adapter resolved for this request; an empty map means every image
 * serializes as its stored descriptor.
 */
export function serializeInput(messages: readonly Message[], images: ImageBytes, requestModel: string): InputItem[] {
  const items: InputItem[] = []
  for (const message of messages) {
    if (message.source.kind === 'tool') {
      items.push(toolOutputItem(message.source.callId, message, images))
      continue
    }
    if (message.role === 'assistant') {
      items.push(...assistantItems(message, requestModel))
      continue
    }
    const { parts } = partsOf(message.content, images)
    if (parts.length > 0) items.push({ role: 'user', content: parts })
  }
  return items
}

/**
 * `strict: false`, sent explicitly: omitted, the API tries to normalize the
 * schema to strict and silently falls back when it cannot, so the same tool
 * would run under two contracts depending on its schema.
 */
export function serializeTools(tools: readonly ToolSchema[] | undefined): WireTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }))
}
