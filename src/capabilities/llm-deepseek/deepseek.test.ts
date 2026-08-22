import { describe, expect, it } from 'vitest'
import { BlockAssembler, type StreamChunk } from '../../core/llm/index.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../../core/llm/message.ts'
import { asCallId } from '../../core/ids.ts'
import { parseSse } from './sse.ts'
import { DeepSeekTranslator, parseWireChunk, type WireChunk } from './translate.ts'
import { serializeMessages, serializeTools } from './serialize.ts'

function sseStream(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const value of stream) out.push(value)
  return out
}

describe('DeepSeek SSE parser', () => {
  it('yields each data payload then [DONE], across split reads', async () => {
    const stream = sseStream('data: {"a":', '1}\n\ndata: {"b":2}\n\n', 'data: [DONE]\n\n')
    expect(await collect(parseSse(stream, () => {}))).toEqual(['{"a":1}', '{"b":2}', '[DONE]'])
  })

  it('throws when the stream ends without [DONE]', async () => {
    const stream = sseStream('data: {"a":1}\n\n')
    await expect(collect(parseSse(stream, () => {}))).rejects.toThrowError(/without \[DONE\]/)
  })
})

describe('DeepSeek translation', () => {
  it('folds reasoning, text, and a fragmented tool call into protocol-correct chunks', () => {
    const wire: WireChunk[] = [
      { choices: [{ delta: { reasoning_content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'let me think' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'edit', arguments: '{"p":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      {
        choices: [{ finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } },
      },
    ]
    const translator = new DeepSeekTranslator()
    const chunks: StreamChunk[] = []
    for (const w of wire) chunks.push(...translator.push(w))
    chunks.push(...translator.finalize())

    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'Hello' },
      { type: 'tool-call', id: asCallId('c1'), name: 'edit', arguments: '{"p":1}' },
    ])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.usage).toEqual({ inputTokens: 8, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 3 })
  })

  it('maps a stop finish with no content to EMPTY_RESPONSE', () => {
    const translator = new DeepSeekTranslator()
    translator.push({ choices: [{ finish_reason: 'stop' }] })
    const finish = translator.finalize().at(-1)
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: expect.any(String), code: 'EMPTY_RESPONSE' } } })
  })

  it('maps length to max-tokens', () => {
    const translator = new DeepSeekTranslator()
    translator.push({ choices: [{ delta: { content: 'partial' } }] })
    translator.push({ choices: [{ finish_reason: 'length' }] })
    expect(translator.finalize().at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('rejects a non-JSON chunk', () => {
    expect(() => parseWireChunk('not json')).toThrowError(/non-JSON/)
  })
})

describe('DeepSeek serialization', () => {
  it('serializes user, assistant (content never null), and tool-result messages', () => {
    const call = asCallId('c1')
    const messages = [
      createUserMessage('hi'),
      createAssistantMessage([{ type: 'tool-call', id: call, name: 'edit', arguments: '{}' }], 'deepseek', 'deepseek-v4-flash'),
      createToolResultMessage(call, [{ type: 'text', text: 'done' }], false),
    ]
    const wire = serializeMessages('be helpful', messages)
    expect(wire[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(wire[1]).toEqual({ role: 'user', content: 'hi' })
    expect(wire[2]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ id: call, type: 'function', function: { name: 'edit', arguments: '{}' } }] })
    expect(wire[3]).toEqual({ role: 'tool', tool_call_id: call, content: 'done' })
  })

  it('passes reasoning_content back on a reasoning-carrying assistant turn', () => {
    const wire = serializeMessages(undefined, [
      createAssistantMessage([{ type: 'reasoning', text: 'because' }, { type: 'text', text: 'answer' }], 'deepseek', 'deepseek-v4-flash'),
    ])
    expect(wire[0]).toEqual({ role: 'assistant', content: 'answer', reasoning_content: 'because' })
  })

  it('omits tools when there are none', () => {
    expect(serializeTools(undefined)).toBeUndefined()
    expect(serializeTools([{ name: 'x', description: 'd', parameters: { type: 'object' } }])).toEqual([
      { type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object' } } },
    ])
  })
})
