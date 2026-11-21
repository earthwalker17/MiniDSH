import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Plugin } from '../../kernel/index.ts'
import { asAttachmentId, type AttachmentRef, type Attachments } from '../../core/attachments/index.ts'
import { CREDENTIALS, type CredentialRef } from '../../core/credentials/index.ts'
import { asCallId } from '../../core/ids.ts'
import { imageDescriptor } from '../../core/llm/content.ts'
import { BlockAssembler, LLM, llmPlugin, RETRYABLE_CODES, type LlmError, type LlmRequest, type Message, type StreamChunk } from '../../core/llm/index.ts'
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

  // Empty means NO block opened. A turn that only thought opened one, so it
  // finishes `stop` with its signature kept: the OpenAI translator alone
  // calls a thought with no answer EMPTY_RESPONSE.
  it('finishes a turn that only thought as stop, with its signature, not as an empty response', () => {
    const wire: Wire = [
      ['message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 3, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    expect(translate(wire).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'anthropic', model: 'm', stopReason: 'end_turn' }, blocks: [{ type: 'thinking', signature: 'sig' }] } })
  })
})

describe('Anthropic SSE parser', () => {
  it('yields named events across split reads, and a translator that saw no message_stop says it is not complete', async () => {
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

  // A body that ends inside an event is the dropped connection the adapter
  // names when `message_stop` never came, one event sooner: handed on, the
  // half payload failed MALFORMED_RESPONSE, which nothing retries.
  it('names a body cut in the middle of an event as STREAM_CLOSED, and still hands on a whole event that only lacked its blank line', async () => {
    const seen: unknown[] = []
    const cut = (async () => {
      for await (const event of parseNamedSse(sseStream('event: ping\ndata: {"type":"ping"}\n\nevent: content_block_delta\ndata: {"type":"content_bl'), () => {})) seen.push(event)
    })()
    await expect(cut).rejects.toMatchObject({ code: 'STREAM_CLOSED', message: expect.stringContaining('middle of an event') })
    expect(seen).toEqual([{ event: 'ping', data: '{"type":"ping"}' }])
    // Whole, with no blank line after it: an event like any other, with no mark of where it came from.
    expect(await collect(parseNamedSse(sseStream('event: message_stop\ndata: {"type":"message_stop"}'), () => {}))).toEqual([{ event: 'message_stop', data: '{"type":"message_stop"}' }])
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

  // The logged arguments are well-formed TEXT that may hold a lone-surrogate
  // ESCAPE. This wire parses them and re-encodes the object, so the escape
  // would go out as the lone surrogate itself, which the API answers with a
  // 400 on this and every later request of the session.
  it('sends parsed arguments well-formed when their text held a lone-surrogate escape, in a value, a key or a nested list', () => {
    const escape = String.raw`\ud83d`
    const args = `{"text":"cut ${escape}","k${escape}":1,"list":["${escape}x",{"deep":"${escape}"}],"whole":"${escape}${String.raw`\ude00`}"}`
    // The premise: the text itself is well-formed, and parsing it is what makes the lone surrogate.
    expect(args.isWellFormed()).toBe(true)
    expect((JSON.parse(args) as { text: string }).text.isWellFormed()).toBe(false)
    const wire = serializeMessages([createUserMessage('go'), createAssistantMessage([{ type: 'tool-call', id: asCallId('c1'), name: 'write', arguments: args }], 'anthropic', 'claude-sonnet-5')])
    const input = wire.flatMap((turn) => turn.content).flatMap((block) => (block.type === 'tool_use' ? [block.input] : []))[0]
    // A paired escape is the character it spells; only the lone ones are replaced.
    expect(input).toEqual({ text: 'cut �', 'k�': 1, list: ['�x', { deep: '�' }], whole: '\u{1F600}' })
    // On the wire: no lone-surrogate escape anywhere in the body.
    expect(JSON.stringify(wire)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i)
  })

  // The runtime strips a foreign envelope before any adapter sees it; this is
  // the serializer's own guard, for a message that reached it unstripped.
  it('never turns another provider\'s reasoning into a signed thinking block, even when an envelope came with it', () => {
    const foreign = createAssistantMessage([{ type: 'reasoning', text: 'a thought' }, { type: 'text', text: 'ok' }], 'deepseek', 'deepseek-flash', {
      response: { kind: 'anthropic' },
      blocks: [{ type: 'thinking', signature: 'not-ours' }, null],
    })
    expect(serializeMessages([createUserMessage('hi'), foreign])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ])
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

  // Every 404 used to read UNKNOWN_MODEL, so a base URL already ending in /v1
  // (which asks for /v1/v1/messages) sent a person to check a model id that
  // was fine.
  it('reads a 404 as an unknown model only when the answer names the model, and says what a wrong path is', () => {
    const body = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message } })
    const verdicts = [
      classifyHttp(404, body('not_found_error', 'model: claude-nope-9'), new Headers()),
      classifyHttp(404, body('not_found_error', 'Not Found'), new Headers()),
      classifyHttp(404, '<html><body>404 page not found</body></html>', new Headers()),
      // A gateway's page that happens to say "model" is still not the API saying so.
      classifyHttp(404, 'no route for this model path', new Headers()),
      // A compatible gateway's error object that names the model under another type IS: the path was right.
      classifyHttp(404, body('invalid_request_error', "model 'claude-nope-9' not found"), new Headers()),
    ].map((failure) => [failure.code, failure.message.includes('check the base URL')])
    expect(verdicts).toEqual([
      ['UNKNOWN_MODEL', false],
      ['INVALID_REQUEST', true],
      ['INVALID_REQUEST', true],
      ['INVALID_REQUEST', true],
      ['UNKNOWN_MODEL', false],
    ])
    // Only a 404 carries the note: another refused request is not a wrong path.
    expect(classifyHttp(400, body('invalid_request_error', 'messages: roles must alternate'), new Headers()).message).not.toContain('base URL')
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
      'claude-fable-5-2',
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
    expect(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5'].filter(offers)).toEqual([])
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
    expect(adapter.resolveModel('claude-fable-5-3')).toMatchObject({ contextWindow: 200_000, defaultMaxTokens: 8192 })
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

// ---- S22.5: the stream loop itself, over a socket ------------------------------
// Until here nothing under `pnpm check` drove `AnthropicAdapter.stream` through
// a body: only an option refusal and a non-OK status reached it.

interface Captured {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** A loopback API that keeps every request whole; `respond` writes the answer. */
async function capturing(respond: (response: ServerResponse) => void): Promise<{ baseURL: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (body += chunk))
    request.on('end', () => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      respond(response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const sse = (wire: Wire): string => wire.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const answering = (body: string) => (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_ok' })
  response.end(body)
}

/** The credential seam, in memory. */
function credentialsPlugin(values: Readonly<Record<string, string>>): Plugin {
  return {
    name: 'test-credentials',
    apply(ctx) {
      const declared: CredentialRef[] = []
      ctx.provide(CREDENTIALS, {
        resolve: (ref) => values[ref],
        describe: (ref) => `the ${ref} environment variable`,
        declare: (ref) => void declared.push(ref),
        declaredRefs: () => declared,
      })
    },
  }
}

const BYTES = new Uint8Array([1, 2, 3, 4])
const REF: AttachmentRef = { id: asAttachmentId(`sha256:${'cd'.repeat(32)}`), mediaType: 'image/png', bytes: BYTES.length, width: 8, height: 8, name: 'dot.png' }

function userWithImage(text: string): Message {
  const message = createUserMessage(text)
  return { ...message, content: [...message.content, { type: 'image', attachment: REF, text: imageDescriptor(REF) }] }
}

/** A store that keeps what was read from it, so a test can say no attachment I/O happened. */
function watchingStore(): { store: Attachments; reads: () => readonly string[] } {
  const reads: string[] = []
  return {
    store: {
      imageLimits: { maxImageBytes: 1, maxImageDimension: 1, maxImagePixels: 1, maxImagesPerRequest: 1, maxRequestImageBytes: 1, mediaTypes: ['image/png'] },
      saveImage: () => Promise.reject(new Error('not used')),
      readImage: (ref) => {
        reads.push(ref.id)
        return Promise.resolve(BYTES)
      },
      hostPath: () => undefined,
    },
    reads: () => reads,
  }
}

describe('Anthropic stream loop', () => {
  let closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const close of closers) await close()
    closers = []
  })
  const KEY = 'sk-ant-ECHOED-IN-STREAM-42'
  const adapterAt = (baseURL: string, attachments?: Attachments): AnthropicAdapter =>
    new AnthropicAdapter({ apiKeyRef: 'ANTHROPIC_API_KEY', resolveKey: () => KEY, baseURL, defaultMaxTokens: 1024, ...(attachments ? { resolveAttachments: () => attachments } : {}) })
  const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({ provider: 'anthropic', model: 'claude-sonnet-5', messages: [createUserMessage('hi')], ...over })

  /** Everything a stream yielded, and what it threw if it threw. */
  async function drain(stream: AsyncIterable<StreamChunk>): Promise<{ chunks: StreamChunk[]; failure: LlmError | undefined }> {
    const chunks: StreamChunk[] = []
    try {
      for await (const chunk of stream) chunks.push(chunk)
      return { chunks, failure: undefined }
    } catch (error) {
      return { chunks, failure: error as LlmError }
    }
  }

  it('streams the measured turn over a real socket: the endpoint, the headers, the body, and a protocol-valid fold', async () => {
    const api = await capturing(answering(sse(CAPTURE)))
    closers.push(api.close)
    const root = createRoot({ logger: { warn: () => {}, error: () => {} } })
    closers.push(() => root.dispose())
    root.plugin(llmPlugin)
    root.plugin(credentialsPlugin({ ANTHROPIC_API_KEY: 'test-key' }))
    const handle = root.plugin(anthropicPlugin, { baseURL: api.baseURL })
    await root.settle()
    expect(handle.state).toBe('active')
    // Through the runtime, so `validateStream` holds the translator to the protocol.
    const chunks = await collect(
      root.get(LLM).stream({ provider: 'anthropic', model: 'claude-sonnet-5', system: 'be terse', reasoningEffort: 'high', messages: [createUserMessage('what time is it?')], tools: [{ name: 'get_time', description: 'd', parameters: { type: 'object' } }] }),
    )
    expect(api.requests).toHaveLength(1)
    const [sent] = api.requests
    expect(sent).toMatchObject({ method: 'POST', url: '/v1/messages' })
    expect(sent!.headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': expect.stringMatching(/^minidsh /) })
    expect(JSON.parse(sent!.body)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      stream: true,
      cache_control: { type: 'ephemeral' },
      system: 'be terse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what time is it?' }] }],
      tools: [{ name: 'get_time', description: 'd', input_schema: { type: 'object' } }],
      output_config: { effort: 'high' },
    })
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: asCallId('toolu_01KC'), name: 'get_time', arguments: '{"zone": "UTC"}' },
    ])
    expect(assembler.replayState?.blocks).toEqual([{ type: 'thinking', signature: 'Eo8CCpABCBEYAipAew8v…sig' }, null])
    // The loop stops at `message_stop`: nothing after the terminal finish.
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  })

  it('reports an HTTP failure with its request-id, and a body cut before message_stop or inside an event as the retryable STREAM_CLOSED', async () => {
    const missing = await capturing((response) => {
      response.writeHead(404, { 'content-type': 'application/json', 'request-id': 'req_404' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope-9' } }))
    })
    closers.push(missing.close)
    expect((await drain(adapterAt(missing.baseURL).stream(request({ model: 'claude-nope-9' })))).failure).toMatchObject({ code: 'UNKNOWN_MODEL', failure: { status: 404, requestId: 'req_404' } })

    // Every event whole, the terminator missing: a turn that would otherwise
    // have finalized as a tool call the model never finished asking for.
    const unterminated = await capturing(answering(sse(CAPTURE.slice(0, -1))))
    closers.push(unterminated.close)
    const early = await drain(adapterAt(unterminated.baseURL).stream(request()))
    expect(early.failure).toMatchObject({ code: 'STREAM_CLOSED', message: expect.stringContaining('without message_stop') })
    expect(early.chunks.some((chunk) => chunk.type === 'finish'), 'a cut stream yielded a finish').toBe(false)

    // The same connection dropped one event sooner, in the middle of it.
    const half = sse(CAPTURE.slice(0, 4))
    const midEvent = await capturing(answering(half.slice(0, half.length - 25)))
    closers.push(midEvent.close)
    const cut = await drain(adapterAt(midEvent.baseURL).stream(request()))
    expect(cut.failure).toMatchObject({ code: 'STREAM_CLOSED', message: expect.stringContaining('middle of an event') })
    expect([early.failure!.code, cut.failure!.code].map((code) => RETRYABLE_CODES.has(code))).toEqual([true, true])
  })

  // `message_stop` ends the message; a connection the server keeps open
  // after it must not hold the turn until the idle watchdog, minutes later.
  it('finishes at message_stop without waiting for the body to close', { timeout: 10_000 }, async () => {
    const api = await capturing((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(sse(messageWith('end_turn', ['done'])))
    })
    closers.push(api.close)
    const { chunks, failure } = await drain(adapterAt(api.baseURL).stream(request()))
    expect(failure).toBeUndefined()
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('maps a caller abort mid-stream to ABORTED', async () => {
    const api = await capturing((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // One block opens, then the body stays open: only the abort can end it.
      response.write(sse(CAPTURE.slice(0, 2)))
    })
    closers.push(api.close)
    const controller = new AbortController()
    const iterator = adapterAt(api.baseURL).stream(request({ signal: controller.signal }))[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ABORTED' })
  })

  // Both in-stream failures carry provider text: the `error` event is THROWN
  // from inside the loop, an unexpected stop reason is YIELDED as the finish.
  it('never quotes the key in a failure the stream itself reports, thrown or yielded', async () => {
    const thrown = await capturing(answering(sse([CAPTURE[0]!, ['error', { type: 'error', error: { type: 'overloaded_error', message: `upstream rejected ${KEY}` } }]])))
    closers.push(thrown.close)
    const failed = await drain(adapterAt(thrown.baseURL).stream(request()))
    expect(failed.failure).toMatchObject({ code: 'SERVER' })
    expect([failed.failure!.message, failed.failure!.failure.message]).toEqual(['Anthropic stream error: upstream rejected [redacted]', 'Anthropic stream error: upstream rejected [redacted]'])

    const yielded = await capturing(answering(sse(messageWith(`refused ${KEY}`, ['x']))))
    closers.push(yielded.close)
    const finished = await drain(adapterAt(yielded.baseURL).stream(request()))
    expect(finished.failure).toBeUndefined()
    const finish = finished.chunks.find((chunk) => chunk.type === 'finish')
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } } })
    expect(JSON.stringify(finish)).not.toContain(KEY)
    expect(JSON.stringify(finish)).toContain('unexpected stop_reason \\"refused [redacted]\\"')
  })

  // `fetch failed` alone reads the same offline, behind a mistyped base URL
  // and behind a proxy that refused: the reason is on the error's cause.
  it('says why a fetch failed, from the cause Node attached, with the key still redacted', async () => {
    const gone = await capturing(answering(''))
    await gone.close()
    const refused = await drain(adapterAt(gone.baseURL).stream(request()))
    expect(refused.failure).toMatchObject({ code: 'TRANSPORT' })
    expect(refused.failure!.message).toContain(`ECONNREFUSED 127.0.0.1:${new URL(gone.baseURL).port}`)

    const shapes: [cause: unknown, expected: string][] = [
      [Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.invalid'), { code: 'ENOTFOUND' }), 'fetch failed (getaddrinfo ENOTFOUND api.anthropic.invalid)'],
      [Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:8080'), new Error('connect ECONNREFUSED 127.0.0.1:8080')], ''), { code: 'ECONNREFUSED' }), 'fetch failed (connect ECONNREFUSED ::1:8080; connect ECONNREFUSED 127.0.0.1:8080)'],
      [Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' }), 'fetch failed (UND_ERR_CONNECT_TIMEOUT)'],
      [new Error(`proxy refused the tunnel for x-api-key ${KEY}`), 'fetch failed (proxy refused the tunnel for x-api-key [redacted])'],
      [undefined, 'fetch failed'],
    ]
    const said: string[] = []
    for (const [cause] of shapes) {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed', { cause }))
      const { failure } = await drain(adapterAt('http://127.0.0.1:9').stream(request()))
      expect(failure).toMatchObject({ code: 'TRANSPORT' })
      said.push(failure!.message)
    }
    expect(said).toEqual(shapes.map(([, expected]) => expected))
  })

  // The order the comments promise, pinned: an option refusal costs no read
  // of the images the request carries. `buildBody` validates again after the
  // reads, so without the first check the refusal still came, one read late.
  it('refuses an option before it reads a single image, and reads it for a request it serves', async () => {
    const watched = watchingStore()
    const refused = await drain(adapterAt('http://127.0.0.1:9', watched.store).stream(request({ messages: [userWithImage('look')], temperature: 0.3 })))
    expect(refused.failure).toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(watched.reads()).toEqual([])
    // The control: the same history, served, is read and sent as bytes.
    const api = await capturing(answering(sse(messageWith('end_turn', ['a dot']))))
    closers.push(api.close)
    expect((await drain(adapterAt(api.baseURL, watched.store).stream(request({ messages: [userWithImage('look')] })))).failure).toBeUndefined()
    expect(watched.reads()).toEqual([REF.id])
    expect((JSON.parse(api.requests[0]!.body) as { messages: unknown }).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(BYTES).toString('base64') } }] },
    ])
  })

  // The wrong base path, end to end: the answer is the gateway's own page.
  it('names the base URL, not the model, when the path it built was not found', async () => {
    const api = await capturing((response) => {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<html><body>404 page not found</body></html>')
    })
    closers.push(api.close)
    const { failure } = await drain(adapterAt(`${api.baseURL}/v1`).stream(request()))
    expect(api.requests.map((sent) => sent.url)).toEqual(['/v1/v1/messages'])
    expect(failure).toMatchObject({ code: 'INVALID_REQUEST', failure: { status: 404 } })
    expect(failure!.message).toContain('check the base URL, which must not end in /v1')
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
