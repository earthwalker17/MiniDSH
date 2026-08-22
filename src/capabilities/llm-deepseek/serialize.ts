import type { ContentBlock, Message, ToolSchema } from '../../core/llm/index.ts'

export interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly reasoning_content?: string
  readonly tool_call_id?: string
  readonly tool_calls?: readonly { readonly id: string; readonly type: 'function'; readonly function: { readonly name: string; readonly arguments: string } }[]
}

export interface WireTool {
  readonly type: 'function'
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function reasoningOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
}

/** Serializes MiniDSH messages to DeepSeek wire messages. Assistant `content` is `""`, never null. */
export function serializeMessages(system: string | undefined, messages: readonly Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  if (system && system.length > 0) wire.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.source.kind === 'tool') {
      const block = message.content.find((b): b is Extract<ContentBlock, { type: 'tool-result' }> => b.type === 'tool-result')
      wire.push({ role: 'tool', tool_call_id: message.source.callId, content: block ? textOf(block.content) || '(no output)' : '(no output)' })
      continue
    }
    if (message.role === 'assistant') {
      const toolCalls = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: b.arguments } }))
      const reasoning = reasoningOf(message.content)
      wire.push({
        role: 'assistant',
        content: textOf(message.content),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    wire.push({ role: 'user', content: textOf(message.content) })
  }
  return wire
}

export function serializeTools(tools: readonly ToolSchema[] | undefined): WireTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}
