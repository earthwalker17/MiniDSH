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
 */
import { contentText } from '../../core/llm/content.ts'
import type { ContentBlock, Message, ToolSchema } from '../../core/llm/index.ts'
import { ANTHROPIC_PROVIDER, type AnthropicReplayBlock } from './translate.ts'

export type WireBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'redacted_thinking'; readonly data: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error?: boolean }

export interface WireMessage {
  readonly role: 'user' | 'assistant'
  readonly content: WireBlock[]
}

export interface WireTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

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

/** The replay entries beside this message's blocks, when this provider wrote them. */
function replayBlocksOf(message: Message): readonly AnthropicReplayBlock[] | undefined {
  const source = message.source
  if (source.kind !== 'assistant' || source.provider !== ANTHROPIC_PROVIDER) return undefined
  const blocks = source.replayState?.blocks
  if (!blocks || blocks.length !== message.content.length) return undefined
  return blocks as readonly AnthropicReplayBlock[]
}

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

function userBlocks(message: Message): WireBlock[] {
  if (message.source.kind === 'tool') {
    const result = message.content.find((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    const content = result ? textOf(result.content) : ''
    return [{ type: 'tool_result', tool_use_id: message.source.callId, content: content.length > 0 ? content : '(no output)', ...(result?.isError ? { is_error: true } : {}) }]
  }
  const text = textOf(message.content)
  return text.length > 0 ? [{ type: 'text', text }] : []
}

/** Serializes history; the system prompt travels as its own field. Turns of one role merge, results first. */
export function serializeMessages(messages: readonly Message[]): WireMessage[] {
  const turns: { role: 'user' | 'assistant'; content: WireBlock[] }[] = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = role === 'assistant' ? assistantBlocks(message) : userBlocks(message)
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
