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

  it('maps a content-less stream that never named a finish_reason to EMPTY_RESPONSE too', () => {
    // The conventional empty first delta, then a usage-only chunk and [DONE]:
    // the same emptiness as a bare `stop`, which the S16.5 review found
    // answered `stop` with zero blocks, so the driver appended an empty
    // message and no retry fired.
    const translator = new DeepSeekTranslator()
    translator.push({ choices: [{ delta: { content: '' } }] })
    translator.push({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 0 } })
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
    // `reasoning_content` is always present, empty when the turn had none: in
    // thinking mode with tools attached, omitting it is a 400.
    expect(wire[2]).toEqual({ role: 'assistant', content: '', reasoning_content: '', tool_calls: [{ id: call, type: 'function', function: { name: 'edit', arguments: '{}' } }] })
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

describe('DeepSeek adapter options', () => {
  it('refuses an effort outside its vocabulary before any I/O, and advertises modalities per model', async () => {
    const { DeepSeekAdapter } = await import('./adapter.ts')
    let resolved = 0
    const adapter = new DeepSeekAdapter({
      apiKeyRef: 'DEEPSEEK_API_KEY',
      resolveKey: () => {
        resolved += 1
        return 'never-used'
      },
      baseURL: 'http://127.0.0.1:1',
      defaultMaxTokens: 16,
    })
    // The provider would quietly map `medium` to `high`; the adapter refuses instead, before touching the key or the wire.
    const stream = adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [], reasoningEffort: 'medium' })
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(resolved).toBe(0)
    expect(adapter.resolveModel('deepseek-flash').inputModalities).toEqual(['text', 'image'])
    expect(adapter.resolveModel('deepseek-v4-pro').inputModalities).toEqual(['text'])
    // The retired names are served AS deepseek-flash, so they take its facts — images included.
    expect(adapter.resolveModel('deepseek-v4-flash')).toEqual(adapter.resolveModel('deepseek-flash'))
    expect(adapter.resolveModel('deepseek-v4-flash-vision-exp')).toEqual(adapter.resolveModel('deepseek-flash'))
    expect(adapter.listModels().map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('gives an id it does not know conservative facts, and the catalog its measured ones', async () => {
    const { DeepSeekAdapter } = await import('./adapter.ts')
    const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'never-used', baseURL: 'http://127.0.0.1:1', defaultMaxTokens: 8192 })
    expect(adapter.resolveModel('deepseek-flash')).toMatchObject({ contextWindow: 1_048_576, defaultMaxTokens: 8192 })
    expect(adapter.resolveModel('deepseek-v5-someday')).toMatchObject({ contextWindow: 131_072, defaultMaxTokens: 8192, inputModalities: ['text'] })
    // A deployment default above a model's cap is clamped to the cap, never sent as asked.
    const generous = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'never-used', baseURL: 'http://127.0.0.1:1', defaultMaxTokens: 500_000 })
    expect(generous.resolveModel('deepseek-flash').defaultMaxTokens).toBe(393_216)
    expect(generous.resolveModel('deepseek-v5-someday').defaultMaxTokens).toBe(8192)
  })

  it('refuses an output cap above the model\'s and a temperature thinking would ignore, before any I/O', async () => {
    const { DeepSeekAdapter } = await import('./adapter.ts')
    let resolved = 0
    const adapter = new DeepSeekAdapter({
      apiKeyRef: 'DEEPSEEK_API_KEY',
      resolveKey: () => {
        resolved += 1
        return 'never-used'
      },
      baseURL: 'http://127.0.0.1:1',
      defaultMaxTokens: 8192,
    })
    const first = (request: Parameters<typeof adapter.stream>[0]) => adapter.stream(request)[Symbol.asyncIterator]().next()
    await expect(first({ provider: 'deepseek', model: 'deepseek-flash', messages: [], maxTokens: 393_217 })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(first({ provider: 'deepseek', model: 'deepseek-v5-someday', messages: [], maxTokens: 9000 })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(first({ provider: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.2 })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(first({ provider: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.2, reasoningEffort: 'high' })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(resolved).toBe(0)
    // With thinking off the provider honours it, so it passes validation (and fails later, at the unreachable endpoint).
    expect(() => adapter.validateOptions({ provider: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.2, reasoningEffort: 'off' })).not.toThrow()
  })

  it('reads the unknown-model 400 as UNKNOWN_MODEL, which nothing retries', async () => {
    const { classifyHttp } = await import('./adapter.ts')
    const body = JSON.stringify({ error: { message: 'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v9-ultra.', type: 'invalid_request_error', code: 'invalid_request_error' } })
    expect(classifyHttp(400, body, new Headers()).code).toBe('UNKNOWN_MODEL')
    const range = JSON.stringify({ error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]', type: 'invalid_request_error' } })
    expect(classifyHttp(400, range, new Headers()).code).toBe('INVALID_REQUEST')
  })
})
