import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from '../../kernel/index.ts'
import { asCallId } from '../../core/ids.ts'
import { BlockAssembler, llmPlugin, type LlmError, type StreamChunk } from '../../core/llm/index.ts'
import { createAssistantMessage, createPluginMessage, createToolResultMessage, createUserMessage } from '../../core/llm/message.ts'
import { credentialsLocalPlugin } from '../credentials-local/index.ts'
import { AnthropicAdapter, classifyHttp } from './adapter.ts'
import { anthropicPlugin } from './index.ts'
import { serializeMessages, serializeTools } from './serialize.ts'
import { parseNamedSse } from './sse.ts'
import { AnthropicTranslator } from './translate.ts'

function sseStream(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of stream) out.push(value)
  return out
}

type Wire = readonly (readonly [string, Record<string, unknown>])[]

/**
 * The live capture of 2026-08-30 (Claude Sonnet 5, a tool-use turn with the
 * default omitted thinking), event shapes verbatim, the signature shortened.
 */
const CAPTURE: Wire = [
  ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5', id: 'msg_1', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 508, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
  ['ping', { type: 'ping' }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'Eo8CCpABCBEYAipAew8v…sig' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01KC', name: 'get_time', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"zone"' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ': "UTC' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 508, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 65, output_tokens_details: { thinking_tokens: 14 } } }],
  ['message_stop', { type: 'message_stop' }],
]

function translate(wire: Wire): StreamChunk[] {
  const translator = new AnthropicTranslator()
  const chunks: StreamChunk[] = []
  for (const [event, data] of wire) chunks.push(...translator.push(event, data))
  expect(translator.complete).toBe(true)
  chunks.push(...translator.finalize())
  return chunks
}

/** A minimal message: `text` blocks (or none) and the given stop reason. */
function messageWith(stopReason: string, texts: readonly string[]): Wire {
  const wire: (readonly [string, Record<string, unknown>])[] = [['message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 3, output_tokens: 1 } } }]]
  texts.forEach((text, index) => {
    wire.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    wire.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    wire.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  wire.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 4 } }])
  wire.push(['message_stop', { type: 'message_stop' }])
  return wire
}

describe('Anthropic translation', () => {
  it('folds the live capture: an omitted thinking block with its signature, a tool call from JSON deltas, cumulative usage', () => {
    const chunks = translate(CAPTURE)
    // The tool call's identity precedes its arguments, as the assembler expects.
    expect(chunks.find((chunk) => chunk.type === 'tool-call-delta')).toEqual({ type: 'tool-call-delta', index: 1, id: asCallId('toolu_01KC'), name: 'get_time', argumentsDelta: '' })
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: asCallId('toolu_01KC'), name: 'get_time', arguments: '{"zone": "UTC"}' },
    ])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.usage).toEqual({ inputTokens: 508, outputTokens: 65, reasoningTokens: 14 })
    // The signature rides beside its block; the tool call has nothing to replay.
    expect(assembler.replayState).toEqual({
      response: { kind: 'anthropic', model: 'claude-sonnet-5', stopReason: 'tool_use' },
      blocks: [{ type: 'thinking', signature: 'Eo8CCpABCBEYAipAew8v…sig' }, null],
    })
    const types = chunks.map((chunk) => chunk.type)
    expect(types.at(-2)).toBe('usage')
    expect(types.at(-1)).toBe('finish')
  })

  it('maps every stop reason, and a content-less end_turn to EMPTY_RESPONSE', () => {
    const finish = (stopReason: string, texts: readonly string[] = ['x']) => translate(messageWith(stopReason, texts)).at(-1)
    expect(finish('end_turn')).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(finish('stop_sequence')).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(finish('tool_use')).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(finish('max_tokens')).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(finish('end_turn', [])).toMatchObject({ reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
    expect(finish('model_context_window_exceeded')).toMatchObject({ reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } } })
    expect(finish('refusal')).toMatchObject({ reason: { kind: 'error', failure: { code: 'REFUSAL' } } })
    expect(finish('something_new')).toMatchObject({ reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } } })
    // No signed block, no envelope: the log does not grow a field with nothing in it.
    expect(finish('end_turn')).not.toHaveProperty('replayState')
  })

  it('reports cache reads and writes as their own disjoint counts', () => {
    const wire = messageWith('end_turn', ['x']).map(([event, data]) =>
      event === 'message_start' ? ([event, { type: 'message_start', message: { model: 'm', usage: { input_tokens: 8, cache_read_input_tokens: 300, cache_creation_input_tokens: 100, output_tokens: 1 } } }] as const) : ([event, data] as const),
    )
    const usage = translate(wire).find((chunk) => chunk.type === 'usage')
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 8, outputTokens: 4, cacheReadTokens: 300, cacheWriteTokens: 100 } })
  })

  it('turns an in-stream error event into the failure it names', () => {
    const translator = new AnthropicTranslator()
    expect(() => translator.push('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })).toThrowError(expect.objectContaining({ code: 'SERVER' }))
    expect(() => translator.push('error', { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })).toThrowError(expect.objectContaining({ code: 'RATE_LIMIT' }))
  })
})

describe('Anthropic SSE parser', () => {
  it('yields named events across split reads, and a body cut before message_stop is incomplete', async () => {
    const stream = sseStream('event: message_start\ndata: {"a":', '1}\n\nevent: ping\ndata: {"type": "ping"}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n')
    expect(await collect(parseNamedSse(stream, () => {}))).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: 'ping', data: '{"type": "ping"}' },
      { event: 'message_stop', data: '{"type":"message_stop"}' },
    ])
    const cut = new AnthropicTranslator()
    cut.push('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } })
    expect(cut.complete).toBe(false)
  })
})

describe('Anthropic serialization', () => {
  const ownSigned = createAssistantMessage(
    [
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: asCallId('c1'), name: 'get_time', arguments: '{"zone":"UTC"}' },
    ],
    'anthropic',
    'claude-sonnet-5',
    { response: { kind: 'anthropic' }, blocks: [{ type: 'thinking', signature: 'sig' }, null] },
  )

  it('merges consecutive user-role messages into one turn, results first, and echoes only its own signed thinking', () => {
    const foreign = createAssistantMessage([{ type: 'reasoning', text: 'a thought' }, { type: 'text', text: 'ok' }], 'deepseek', 'deepseek-v4-flash')
    const wire = serializeMessages([
      createUserMessage('hi'),
      ownSigned,
      createPluginMessage('test', 'a reminder'),
      createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'noon' }], false),
      foreign,
      createUserMessage('next'),
    ])
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'tool_use', id: 'c1', name: 'get_time', input: { zone: 'UTC' } },
        ],
      },
      // The plugin message arrived before the result; the API wants the result first.
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'noon' }, { type: 'text', text: 'a reminder' }] },
      // A foreign reasoning block is dropped, never forged into a thinking block.
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ])
  })

  it('drops an unsigned own reasoning block and empty text, marks failed results, and restores a redacted block', () => {
    const unsigned = createAssistantMessage([{ type: 'reasoning', text: 'lost signature' }, { type: 'text', text: '' }], 'anthropic', 'claude-sonnet-5')
    const redacted = createAssistantMessage([{ type: 'reasoning', text: '' }, { type: 'text', text: 'done' }], 'anthropic', 'claude-sonnet-5', {
      response: { kind: 'anthropic' },
      blocks: [{ type: 'redacted_thinking', data: 'opaque' }, null],
    })
    const wire = serializeMessages([
      createUserMessage('one'),
      unsigned, // nothing survives: the neighbouring user turns merge
      createToolResultMessage(asCallId('c9'), [], true),
      redacted,
    ])
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c9', content: '(no output)', is_error: true }, { type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'done' }] },
    ])
  })

  it('sends arguments that are not a JSON object as the text the log holds, never as no arguments', () => {
    const calls = ['{"path": "a', '[1, 2]'].map((args, k) =>
      createAssistantMessage([{ type: 'tool-call', id: asCallId(`c${k}`), name: 'view', arguments: args }], 'anthropic', 'claude-sonnet-5'),
    )
    const wire = serializeMessages([createUserMessage('go'), calls[0]!, createToolResultMessage(asCallId('c0'), [{ type: 'text', text: 'bad args' }], true), calls[1]!])
    const inputs = wire.flatMap((turn) => turn.content).flatMap((block) => (block.type === 'tool_use' ? [block.input] : []))
    expect(inputs).toEqual([{ _unparsed_arguments: '{"path": "a' }, { _unparsed_arguments: '[1, 2]' }])
  })

  it('serializes tools with their JSON schema as input_schema', () => {
    expect(serializeTools(undefined)).toBeUndefined()
    expect(serializeTools([{ name: 'x', description: 'd', parameters: { type: 'object' } }])).toEqual([{ name: 'x', description: 'd', input_schema: { type: 'object' } }])
  })
})

describe('Anthropic adapter', () => {
  let resolved = 0
  const adapter = new AnthropicAdapter({
    apiKeyRef: 'ANTHROPIC_API_KEY',
    resolveKey: () => {
      resolved += 1
      return 'never-used'
    },
    baseURL: 'http://127.0.0.1:1',
    defaultMaxTokens: 8192,
  })
  const base = { provider: 'anthropic', messages: [createUserMessage('hi')] }

  it('refuses what a model cannot honour before reading the key or sending a byte', async () => {
    expect(() => adapter.buildBody({ ...base, model: 'claude-sonnet-5', temperature: 0.2 })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }))
    expect(() => adapter.buildBody({ ...base, model: 'claude-fable-5', reasoningEffort: 'off' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
    expect(() => adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', reasoningEffort: 'xhigh' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
    expect(() => adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', reasoningEffort: 'high', maxTokens: 4096 })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }))
    const stream = adapter.stream({ ...base, model: 'claude-sonnet-5', temperature: 0.2 })
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(resolved).toBe(0)
  })

  it('forbids a tool call when the request says none, keeping the tools on the wire', () => {
    const tools = [{ name: 't', description: 'd', parameters: { type: 'object' } }]
    expect(adapter.buildBody({ ...base, model: 'claude-sonnet-5', tools, toolChoice: 'none' })).toMatchObject({ tools: [{ name: 't' }], tool_choice: { type: 'none' } })
    expect(adapter.buildBody({ ...base, model: 'claude-sonnet-5', tools })).not.toHaveProperty('tool_choice')
  })

  it('spells thinking per model generation and never leaks a runtime-only field onto the wire', () => {
    const sonnet = adapter.buildBody({ ...base, model: 'claude-sonnet-5', reasoningEffort: 'max', system: 'be terse', tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }], sessionId: 's' as never, purpose: 'compaction' })
    expect(sonnet).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      stream: true,
      cache_control: { type: 'ephemeral' },
      system: 'be terse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      output_config: { effort: 'max' },
    })
    expect(adapter.buildBody({ ...base, model: 'claude-opus-5', reasoningEffort: 'off' })).toMatchObject({ thinking: { type: 'disabled' } })
    expect(adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', reasoningEffort: 'high', maxTokens: 32_000 })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 6144 }, max_tokens: 32_000 })
    expect(adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', temperature: 0.3 })).toMatchObject({ temperature: 0.3 })
    expect(adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001' })).not.toHaveProperty('thinking')
  })

  it('advertises real per-model facts, and conservative ones for an id it does not know', () => {
    expect(adapter.resolveModel('claude-fable-5')).toMatchObject({ contextWindow: 1_000_000, defaultMaxTokens: 8192, inputModalities: ['text', 'image'] })
    expect(adapter.resolveModel('claude-fable-5').reasoning.efforts).not.toContain('off')
    expect(adapter.resolveModel('claude-haiku-4-5-20251001')).toMatchObject({ contextWindow: 200_000, reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'off' } })
    expect(adapter.resolveModel('claude-next-99')).toMatchObject({ contextWindow: 200_000 })
    // The 4 family disagrees with itself on every fact that matters, so each
    // minor version is its own row and the assertions are the measured 400s:
    // `xhigh` is refused by 4-6 and accepted by 4-8, and a temperature is
    // "deprecated" on 4-7/4-8 while 4-6 takes one.
    expect(adapter.resolveModel('claude-opus-4-8')).toMatchObject({ contextWindow: 1_000_000 })
    expect(adapter.resolveModel('claude-opus-4-8').reasoning.efforts).toContain('xhigh')
    expect(adapter.resolveModel('claude-sonnet-4-6')).toMatchObject({ contextWindow: 1_000_000 })
    expect(adapter.resolveModel('claude-sonnet-4-6').reasoning.efforts).not.toContain('xhigh')
    expect(adapter.resolveModel('claude-opus-4-5-20251101')).toMatchObject({ contextWindow: 200_000 })
    expect(adapter.resolveModel('claude-opus-4-5-20251101').reasoning.efforts).not.toContain('max')
    const request = { provider: 'anthropic', messages: [createUserMessage('hi')] }
    expect(() => adapter.buildBody({ ...request, model: 'claude-opus-4-8', temperature: 0.3 })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }))
    expect(() => adapter.buildBody({ ...request, model: 'claude-opus-4-6', temperature: 0.3 })).not.toThrow()
    expect(() => adapter.buildBody({ ...request, model: 'claude-opus-4-8', maxTokens: 100_000 })).not.toThrow()
    expect(() => adapter.buildBody({ ...request, model: 'claude-opus-4-5-20251101', maxTokens: 100_000 })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }))
  })

  /**
   * An exact-id table rots one model at a time, and it rots on the fields that
   * matter most. Before any version match, `claude-fable-5-1` — a model that
   * had already shipped — resolved to a 200K window (wrong by five times), an
   * 8192 output cap against its real 128K, and an effort set including `off`,
   * which the Fable family answers with a 400. Family granularity then rotted
   * the other way (5.5 inheriting 5), so the match is by minor version.
   */
  it('gives a dated snapshot its minor version’s facts, so the next one lands correctly', () => {
    expect(adapter.resolveModel('claude-sonnet-5-20261101')).toMatchObject({ contextWindow: 1_000_000, defaultMaxTokens: 8192 })
    expect(adapter.resolveModel('claude-fable-5-1-20261101').reasoning.efforts).not.toContain('off')
    expect(adapter.resolveModel('claude-haiku-4-5-20990101')).toMatchObject({ contextWindow: 200_000, reasoning: { defaultEffort: 'off' } })
    expect(adapter.resolveModel('claude-haiku-4-5')).toEqual(adapter.resolveModel('claude-haiku-4-5-20251001'))
    // An id no family claims still gets the conservative default, and still
    // gets images: every model this provider serves takes them, so a wrong
    // refusal would make a real capability unreachable with no override.
    expect(adapter.resolveModel('claude-next-99')).toMatchObject({ contextWindow: 200_000, inputModalities: ['text', 'image'] })
  })

  it('classifies HTTP failures by status and by the error the body names', () => {
    const headers = (extra: Record<string, string> = {}) => new Headers({ 'request-id': 'req_1', ...extra })
    const body = (type: string, message: string, details?: Record<string, string>) => JSON.stringify({ type: 'error', error: { type, message, ...(details ? { details } : {}) } })
    expect(classifyHttp(400, body('invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'), headers())).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED', failure: { requestId: 'req_1', status: 400 } })
    expect(classifyHttp(400, body('invalid_request_error', '`temperature` is deprecated for this model.'), headers())).toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(classifyHttp(400, body('invalid_request_error', 'messages: roles must alternate'), headers())).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(classifyHttp(401, body('authentication_error', 'bad key'), headers())).toMatchObject({ code: 'AUTH' })
    // The wait it asked for is in the message a turn ends on (S20.5 review).
    expect(classifyHttp(429, body('rate_limit_error', 'slow down'), headers({ 'retry-after': '90' })).message).toContain('wait 90 s')
    expect(classifyHttp(404, body('not_found_error', 'model: nope'), headers())).toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(classifyHttp(429, body('rate_limit_error', 'slow'), headers({ 'retry-after': '7' }))).toMatchObject({ code: 'RATE_LIMIT', failure: { retryAfterMs: 7000 } })
    expect(classifyHttp(429, body('rate_limit_error', 'cap', { error_code: 'enforced_spend_limit_reached' }), headers())).toMatchObject({ code: 'QUOTA' })
    expect(classifyHttp(529, body('overloaded_error', 'Overloaded'), headers())).toMatchObject({ code: 'SERVER' })
    expect(classifyHttp(504, body('timeout_error', 'slow'), headers())).toMatchObject({ code: 'TIMEOUT' })
    expect(classifyHttp(502, '<html>bad gateway</html>', headers())).toMatchObject({ code: 'SERVER' })
  })
})

// ---- S20.5: the catalog against the measured listing, and thinking actually on ----

describe('Anthropic catalog (GET /v1/models, 2026-10-25)', () => {
  const adapter = new AnthropicAdapter({ apiKeyRef: 'ANTHROPIC_API_KEY', resolveKey: () => 'never-used', baseURL: 'http://127.0.0.1:1', defaultMaxTokens: 8192 })
  const base = { provider: 'anthropic', messages: [createUserMessage('hi')] }
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']

  it('carries the 5.5 generation as its own rows, never its predecessor’s', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(adapter.resolveModel(id), id).toMatchObject({ contextWindow: 1_000_000, inputModalities: ['text', 'image'] })
    }
    // Thinking cannot be disabled on Opus 5.5 or Sonnet 5.5 (measured: a 400
    // naming "thinking.type.disabled"), so `off` is not theirs to offer; Haiku 5.5 takes it.
    expect(adapter.resolveModel('claude-opus-5-5').reasoning).toEqual({ efforts: FIVE, defaultEffort: 'medium' })
    expect(adapter.resolveModel('claude-sonnet-5-5').reasoning).toEqual({ efforts: FIVE, defaultEffort: 'high' })
    expect(adapter.resolveModel('claude-haiku-5-5').reasoning).toEqual({ efforts: ['off', ...FIVE], defaultEffort: 'medium' })
    expect(() => adapter.buildBody({ ...base, model: 'claude-opus-5-5', reasoningEffort: 'off' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
    expect(() => adapter.buildBody({ ...base, model: 'claude-haiku-5-5', maxTokens: 100_000 })).not.toThrow()
    expect(adapter.listModels().map((model) => model.id)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ])
  })

  it('offers `off` exactly where the listing says thinking can be disabled', () => {
    const offers = (id: string): boolean => adapter.resolveModel(id).reasoning.efforts.includes('off')
    expect(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5'].filter(offers)).toEqual([])
    expect(['claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001'].every(offers)).toBe(true)
  })

  it('gives Sonnet 4.5 its 200K window: the 1M one needs a beta header MiniDSH never sends', () => {
    expect(adapter.resolveModel('claude-sonnet-4-5-20250929')).toMatchObject({ contextWindow: 200_000 })
  })

  it('matches a family at minor-version granularity, and gives an unknown id no output cap of its own', () => {
    // A dated snapshot lands on its own minor version...
    expect(adapter.resolveModel('claude-opus-5-20261201').reasoning.efforts).toContain('off')
    // ...but 5.5 never inherits 5's row, and an unknown minor gets the fallback.
    expect(adapter.resolveModel('claude-opus-5-5-20261201').reasoning.efforts).not.toContain('off')
    expect(adapter.resolveModel('claude-fable-5-2')).toMatchObject({ contextWindow: 200_000, defaultMaxTokens: 8192 })
    // The provider judges a cap for an id this table does not know: a guessed
    // 8192 refused 16000 for models that serve 128K.
    expect(() => adapter.buildBody({ ...base, model: 'claude-mythos-5-1', maxTokens: 16_000 })).not.toThrow()
    expect(() => adapter.buildBody({ ...base, model: 'claude-next-99', maxTokens: 100_000 })).not.toThrow()
    expect(new AnthropicAdapter({ apiKeyRef: 'K', resolveKey: () => 'x', baseURL: 'http://127.0.0.1:1', defaultMaxTokens: 500_000 }).resolveModel('claude-next-99').defaultMaxTokens).toBe(500_000)
  })

  it('turns thinking on where the model does not think unasked, and leaves it to the model where it does', () => {
    // Measured: Opus 4.8 at effort `max` with no thinking field used 0 thinking tokens; with adaptive, 2,723.
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(adapter.buildBody({ ...base, model: id, reasoningEffort: 'high' }), id).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
      expect(adapter.buildBody({ ...base, model: id, reasoningEffort: 'off' }), id).toMatchObject({ thinking: { type: 'disabled' } })
      expect(adapter.buildBody({ ...base, model: id }), id).not.toHaveProperty('thinking')
      // Its default is what it serves with nothing named: no thinking.
      expect(adapter.resolveModel(id).reasoning.defaultEffort, id).toBe('off')
    }
    // Measured: Opus 5 at `high` with no thinking field DID think.
    const opus5 = adapter.buildBody({ ...base, model: 'claude-opus-5', reasoningEffort: 'high' })
    expect(opus5).toMatchObject({ output_config: { effort: 'high' } })
    expect(opus5).not.toHaveProperty('thinking')
  })

  it('gives Opus 4.5 a thinking budget beside its own effort, since it has no adaptive thinking', () => {
    expect(adapter.resolveModel('claude-opus-4-5-20251101').reasoning).toEqual({ efforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'off' })
    expect(adapter.buildBody({ ...base, model: 'claude-opus-4-5-20251101', reasoningEffort: 'medium' })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4096 }, output_config: { effort: 'medium' } })
    expect(adapter.buildBody({ ...base, model: 'claude-opus-4-5-20251101', reasoningEffort: 'off' })).not.toHaveProperty('thinking')
  })

  it('refuses a temperature beside thinking before any I/O, naming both ways out', () => {
    // Measured: Haiku 4.5, temperature 0.2 and a 1024 budget answered 400
    // "`temperature` may only be set to 1 when thinking is enabled".
    expect(() => adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low', temperature: 0.2 })).toThrowError(/effort to "off", or route the session/)
    expect(() => adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low', temperature: 0.2 })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }))
    expect(() => adapter.buildBody({ ...base, model: 'claude-opus-4-6', reasoningEffort: 'high', temperature: 0.2 })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPTION' }))
    expect(() => adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', reasoningEffort: 'off', temperature: 0.2 })).not.toThrow()
    expect(() => adapter.buildBody({ ...base, model: 'claude-haiku-4-5-20251001', temperature: 0.2 })).not.toThrow()
  })
})

/** A loopback stand-in for the API: `respond` writes each answer; every request's path is kept. */
async function loopback(respond: (response: ServerResponse) => void): Promise<{ baseURL: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      seen.push(request.url ?? '')
      respond(response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

describe('Anthropic wire framing and bounds', () => {
  const first = (adapter: AnthropicAdapter): Promise<unknown> =>
    adapter.stream({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', messages: [createUserMessage('hi')] })[Symbol.asyncIterator]().next().catch((error: unknown) => error)

  it('frames CRLF and lone-CR line ends as the SSE grammar allows', async () => {
    const crlf = sseStream('event: message_start\r\ndata: {"a":1}\r', '\n\r\nevent: message_stop\r\ndata: {"b":2}\r\n\r\n')
    expect(await collect(parseNamedSse(crlf, () => {}))).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: 'message_stop', data: '{"b":2}' },
    ])
    const cr = sseStream('event: ping\rdata: {}\r\r')
    expect(await collect(parseNamedSse(cr, () => {}))).toEqual([{ event: 'ping', data: '{}' }])
  })

  it('fails one event that never ends past its cap as MALFORMED_RESPONSE', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    await expect(collect(parseNamedSse(sseStream('event: x\ndata: "', ...Array.from({ length: 9 }, () => chunk)), () => {}))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('reads at most a bounded prefix of an error body, takes a trailing slash, and never quotes an echoed key', { timeout: 10_000 }, async () => {
    const key = 'sk-ant-ECHOED-0123456789'
    let mode: 'endless' | 'echo' = 'endless'
    const api = await loopback((response) => {
      if (mode === 'endless') {
        response.writeHead(529, { 'content-type': 'text/plain' })
        response.write('y'.repeat(200 * 1024))
        return
      }
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${key}` } }))
    })
    try {
      const adapter = new AnthropicAdapter({ apiKeyRef: 'ANTHROPIC_API_KEY', resolveKey: () => key, baseURL: `${api.baseURL}/`, defaultMaxTokens: 1024 })
      expect(await first(adapter)).toMatchObject({ code: 'SERVER', failure: { status: 529 } })
      mode = 'echo'
      const failure = (await first(adapter)) as LlmError
      expect(failure).toMatchObject({ code: 'AUTH' })
      expect(failure.message).not.toContain(key)
      expect(api.seen).toEqual(['/v1/messages', '/v1/messages'])
    } finally {
      await api.close()
    }
  })

  it('refuses a tool_use block with no id or name as MALFORMED_RESPONSE, as the OpenAI translator does', () => {
    const translator = new AnthropicTranslator()
    translator.push('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } })
    expect(() => translator.push('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', input: {} } })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    const unnamed = new AnthropicTranslator()
    expect(() => unnamed.push('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: '', input: {} } })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })
})

describe('Anthropic row contract', () => {
  const saved = process.env.ANTHROPIC_BASE_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = saved
  })

  it('refuses a base URL carrying user info, from config or from the environment, without quoting the password', async () => {
    expect(() => anthropicPlugin.config!.parse({ baseURL: 'https://proxyuser:proxy-PASSWORD-123@proxy.example' })).toThrow()
    process.env.ANTHROPIC_BASE_URL = 'https://proxyuser:proxy-PASSWORD-123@proxy.example'
    const root = createRoot({ logger: { warn: () => {}, error: () => {} } })
    root.plugin(llmPlugin)
    root.plugin(credentialsLocalPlugin)
    const handle = root.plugin(anthropicPlugin)
    const report = await root.settle()
    expect(handle.state).toBe('failed')
    const said = report.failed.map((entry) => String(entry.error)).join('\n')
    expect(said).toMatch(/ANTHROPIC_BASE_URL/)
    expect(said).not.toContain('proxy-PASSWORD-123')
    await root.dispose()
  })
})
