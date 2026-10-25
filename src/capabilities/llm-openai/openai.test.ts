import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Logger, type Plugin } from '../../kernel/index.ts'
import { asAttachmentId, type AttachmentRef, type Attachments } from '../../core/attachments/index.ts'
import { CREDENTIALS, type CredentialRef } from '../../core/credentials/index.ts'
import { asCallId } from '../../core/ids.ts'
import { imageDescriptor, type ResolvedImage } from '../../core/llm/content.ts'
import { BlockAssembler, LLM, llmPlugin, type ContentBlock, type LlmRequest, type Message, type StreamChunk } from '../../core/llm/index.ts'
import { createAssistantMessage, createPluginMessage, createToolResultMessage, createUserMessage } from '../../core/llm/message.ts'
import { OpenAIAdapter, classifyHttp, type OpenAIAdapterOptions } from './adapter.ts'
import { canonicalModel } from './catalog.ts'
import { openaiPlugin } from './index.ts'
import { serializeInput, serializeTools } from './serialize.ts'
import { parseNamedSse } from './sse.ts'
import { OpenAITranslator } from './translate.ts'

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

type Wire = readonly Record<string, unknown>[]

function translate(wire: Wire): StreamChunk[] {
  const translator = new OpenAITranslator()
  const chunks: StreamChunk[] = []
  for (const event of wire) chunks.push(...translator.push(event))
  expect(translator.complete).toBe(true)
  return chunks
}

function assemble(chunks: readonly StreamChunk[]): BlockAssembler {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}

const created = (model = 'gpt-6-luna'): Record<string, unknown> => ({ type: 'response.created', sequence_number: 0, response: { id: 'resp_01', object: 'response', status: 'in_progress', model, output: [], usage: null } })
const completed = (usage: Record<string, unknown> = { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } }): Record<string, unknown> => ({
  type: 'response.completed',
  response: { id: 'resp_01', status: 'completed', model: 'gpt-6-luna', usage },
})
const incomplete = (reason: string): Record<string, unknown> => ({
  type: 'response.incomplete',
  response: { id: 'resp_01', status: 'incomplete', model: 'gpt-6-luna', incomplete_details: { reason }, usage: { input_tokens: 30, output_tokens: 16, output_tokens_details: { reasoning_tokens: 16 } } },
})

/** A whole reasoning item: added (unsealed, as the `.added` copy may be), one summary part per text, done SEALED. */
function reasoningItem(outputIndex: number, id: string, texts: readonly string[], seal: string): Record<string, unknown>[] {
  return [
    { type: 'response.output_item.added', output_index: outputIndex, item: { id, type: 'reasoning', summary: [] } },
    ...texts.map((text, summaryIndex) => ({ type: 'response.reasoning_summary_text.delta', item_id: id, output_index: outputIndex, summary_index: summaryIndex, delta: text })),
    { type: 'response.output_item.done', output_index: outputIndex, item: { id, type: 'reasoning', summary: texts.map((text) => ({ type: 'summary_text', text })), encrypted_content: seal } },
  ]
}

/** A whole message item: one content part per text, closed with the authoritative content. */
function messageItem(outputIndex: number, id: string, texts: readonly string[], phase = 'final_answer'): Record<string, unknown>[] {
  return [
    { type: 'response.output_item.added', output_index: outputIndex, item: { id, type: 'message', status: 'in_progress', role: 'assistant', content: [], phase } },
    ...texts.flatMap((text, contentIndex) => [
      { type: 'response.content_part.added', item_id: id, output_index: outputIndex, content_index: contentIndex, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: id, output_index: outputIndex, content_index: contentIndex, delta: text },
      { type: 'response.output_text.done', item_id: id, output_index: outputIndex, content_index: contentIndex, text },
      { type: 'response.content_part.done', item_id: id, output_index: outputIndex, content_index: contentIndex, part: { type: 'output_text', text, annotations: [] } },
    ]),
    { type: 'response.output_item.done', output_index: outputIndex, item: { id, type: 'message', status: 'completed', role: 'assistant', content: texts.map((text) => ({ type: 'output_text', text, annotations: [] })), phase } },
  ]
}

const SEAL = 'gAAAAABo5x…sealed-reasoning'

/**
 * The live capture of 2026-10-16 (gpt-6-luna, effort `high`, one tool turn),
 * in its measured order: created > in_progress > reasoning item > function
 * call item > completed, no `[DONE]`. Shapes verbatim, the seal shortened.
 */
const CAPTURE: Wire = [
  created(),
  { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_01', status: 'in_progress', model: 'gpt-6-luna' } },
  { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { id: 'rs_01', type: 'reasoning', summary: [] } },
  { type: 'response.reasoning_summary_part.added', sequence_number: 3, item_id: 'rs_01', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
  { type: 'response.reasoning_summary_text.delta', sequence_number: 4, item_id: 'rs_01', output_index: 0, summary_index: 0, delta: '**Reading the file**' },
  { type: 'response.reasoning_summary_text.done', sequence_number: 5, item_id: 'rs_01', output_index: 0, summary_index: 0, text: '**Reading the file**' },
  { type: 'response.reasoning_summary_part.done', sequence_number: 6, item_id: 'rs_01', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '**Reading the file**' } },
  { type: 'response.output_item.done', sequence_number: 7, output_index: 0, item: { id: 'rs_01', type: 'reasoning', summary: [{ type: 'summary_text', text: '**Reading the file**' }], encrypted_content: SEAL } },
  { type: 'response.output_item.added', sequence_number: 8, output_index: 1, item: { id: 'fc_01', type: 'function_call', status: 'in_progress', arguments: '', call_id: 'call_Xy7', name: 'read' } },
  { type: 'response.function_call_arguments.delta', sequence_number: 9, item_id: 'fc_01', output_index: 1, delta: '{"path":' },
  { type: 'response.function_call_arguments.delta', sequence_number: 10, item_id: 'fc_01', output_index: 1, delta: '"bravo.txt"}' },
  { type: 'response.function_call_arguments.done', sequence_number: 11, item_id: 'fc_01', output_index: 1, arguments: '{"path":"bravo.txt"}' },
  { type: 'response.output_item.done', sequence_number: 12, output_index: 1, item: { id: 'fc_01', type: 'function_call', status: 'completed', arguments: '{"path":"bravo.txt"}', call_id: 'call_Xy7', name: 'read' } },
  {
    type: 'response.completed',
    sequence_number: 13,
    response: { id: 'resp_01', status: 'completed', model: 'gpt-6-luna', usage: { input_tokens: 412, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 180, output_tokens_details: { reasoning_tokens: 149 }, total_tokens: 592 } },
  },
]

describe('OpenAI translation', () => {
  it('folds the measured tool turn: a reasoning item sealed at .done, a function call from argument deltas, usage before finish', () => {
    const chunks = translate(CAPTURE)
    // The tool call's identity precedes its arguments, as the assembler expects.
    expect(chunks.find((chunk) => chunk.type === 'tool-call-delta')).toEqual({ type: 'tool-call-delta', index: 1, id: asCallId('call_Xy7'), name: 'read', argumentsDelta: '' })
    const assembler = assemble(chunks)
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: '**Reading the file**' },
      { type: 'tool-call', id: asCallId('call_Xy7'), name: 'read', arguments: '{"path":"bravo.txt"}' },
    ])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.usage).toEqual({ inputTokens: 412, outputTokens: 180, reasoningTokens: 149 })
    // The seal arrived only at .done and overwrote the null the .added copy gave.
    expect(assembler.replayState).toEqual({
      response: { kind: 'openai', model: 'gpt-6-luna', id: 'resp_01' },
      blocks: [{ type: 'reasoning', id: 'rs_01', encrypted_content: SEAL }, { type: 'function_call', id: 'fc_01' }],
    })
    const types = chunks.map((chunk) => chunk.type)
    expect(types.filter((type) => type === 'usage')).toHaveLength(1)
    expect(types.slice(-2)).toEqual(['usage', 'finish'])
  })

  it('folds a text answer into one block whose replay entry keeps its message id and phase', () => {
    const chunks = translate([created(), ...messageItem(0, 'msg_01', ['All markers found.']), completed()])
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'All markers found.' }])
    const assembler = assemble(chunks)
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'All markers found.' }])
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.replayState).toEqual({ response: { kind: 'openai', model: 'gpt-6-luna', id: 'resp_01' }, blocks: [{ type: 'message', id: 'msg_01', phase: 'final_answer' }] })
  })

  it('separates reasoning summary parts by a blank line, in the deltas and the closing block alike', () => {
    const wire: Wire = [
      created(),
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_01', type: 'reasoning', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'First.' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: 'Second' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: ' part.' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_01', type: 'reasoning', summary: [{ type: 'summary_text', text: 'First.' }, { type: 'summary_text', text: 'Second part.' }], encrypted_content: SEAL } },
      ...messageItem(1, 'msg_01', ['ok']),
      completed(),
    ]
    const chunks = translate(wire)
    const deltas = chunks.flatMap((chunk) => (chunk.type === 'reasoning-delta' ? [chunk.text] : []))
    expect(deltas).toEqual(['First.', '\n\nSecond', ' part.'])
    const closed = chunks.find((chunk) => chunk.type === 'block-end' && chunk.index === 0)
    expect(closed).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'First.\n\nSecond part.' } })
    // What streamed and what closed say the same thing.
    expect(deltas.join('')).toBe('First.\n\nSecond part.')
  })

  it('reports usage disjointly: input_tokens INCLUDES both cache reads and cache writes', () => {
    const usageOf = (usage: Record<string, unknown>) => translate([created(), ...messageItem(0, 'msg_01', ['x']), completed(usage)]).find((chunk) => chunk.type === 'usage')
    // The measured write: 1,889 input = 1,886 written + 3 uncached.
    expect(usageOf({ input_tokens: 1889, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1886 }, output_tokens: 12 })).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 12, cacheWriteTokens: 1886 } })
    expect(usageOf({ input_tokens: 1900, input_tokens_details: { cached_tokens: 1886 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } })).toEqual({ type: 'usage', usage: { inputTokens: 14, outputTokens: 9, cacheReadTokens: 1886, reasoningTokens: 4 } })
    expect(usageOf({ input_tokens: 2000, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 900 }, output_tokens: 1 })).toEqual({ type: 'usage', usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 1000, cacheWriteTokens: 900 } })
    // A count the log could not hold is no count at all.
    expect(usageOf({ input_tokens: 'many', output_tokens: Number.NaN })).toEqual({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } })
  })

  it('answers EMPTY_RESPONSE for a reasoning-only completion, so the retry policy still sees it', () => {
    const finish = translate([created(), ...reasoningItem(0, 'rs_01', ['Just thinking.'], SEAL), completed()]).at(-1)
    expect(finish).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: expect.any(String), code: 'EMPTY_RESPONSE' } } })
    // An empty message beside it is still nothing said.
    expect(translate([created(), ...reasoningItem(0, 'rs_01', ['Hm.'], SEAL), ...messageItem(1, 'msg_01', ['']), completed()]).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
  })

  it('answers REFUSAL for a refusal part, and never emits the refusal as text', () => {
    const wire: Wire = [
      created(),
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_01', type: 'message', status: 'in_progress', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'refusal', refusal: '' } },
      { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'I can’t help with that.' },
      { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: 'I can’t help with that.' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_01', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'I can’t help with that.' }] } },
      completed(),
    ]
    const chunks = translate(wire)
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: 'the model refused: I can’t help with that.', code: 'REFUSAL' } } })
    // The refusal part alone, without its deltas, says the same.
    const partOnly = wire.filter((event) => event.type !== 'response.refusal.delta')
    expect(translate(partOnly).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'REFUSAL' } } })
  })

  it('maps incomplete reasons, failed codes and in-stream error events by code, never by message text', () => {
    const answer = [created(), ...messageItem(0, 'msg_01', ['partial'])]
    expect(translate([...answer, incomplete('max_output_tokens')]).at(-1)).toMatchObject({ reason: { kind: 'max-tokens' }, replayState: { blocks: [{ type: 'message', id: 'msg_01' }] } })
    expect(translate([...answer, incomplete('content_filter')]).at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: expect.any(String), code: 'REFUSAL' } } })
    expect(translate([...answer, incomplete('max_messages')]).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: expect.stringContaining('max_messages') } } })

    const failed = (code: string | null, usage?: Record<string, unknown>) => translate([created(), { type: 'response.failed', response: { id: 'resp_01', status: 'failed', error: { code, message: 'it broke' }, ...(usage ? { usage } : {}) } }])
    const failedCode = (code: string | null) => {
      const finish = failed(code).at(-1)
      return finish?.type === 'finish' && finish.reason.kind === 'error' ? finish.reason.failure.code : undefined
    }
    expect(failedCode('rate_limit_exceeded')).toBe('RATE_LIMIT')
    expect(failedCode('server_error')).toBe('SERVER')
    expect(failedCode('context_length_exceeded')).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(failedCode('invalid_prompt')).toBe('INVALID_REQUEST')
    expect(failedCode('invalid_image_format')).toBe('INVALID_REQUEST')
    expect(failedCode('failed_to_download_image')).toBe('INVALID_REQUEST')
    expect(failedCode('insufficient_quota')).toBe('QUOTA')
    expect(failedCode('vector_store_timeout')).toBe('SERVER')
    expect(failedCode(null)).toBe('SERVER')
    // Usage only when the failure reports it, and then before the finish.
    expect(failed('server_error').map((chunk) => chunk.type)).toEqual(['finish'])
    expect(failed('server_error', { input_tokens: 7, output_tokens: 0 }).map((chunk) => chunk.type)).toEqual(['usage', 'finish'])

    const translator = new OpenAITranslator()
    expect(() => translator.push({ type: 'error', code: 'insufficient_quota', message: 'You exceeded your current quota.', param: null })).toThrowError(expect.objectContaining({ code: 'QUOTA' }))
    expect(() => translator.push({ type: 'error', code: 'rate_limit_exceeded', message: 'slow down', param: null })).toThrowError(expect.objectContaining({ code: 'RATE_LIMIT' }))
    // The code can be null and the message empty: still a failure, never a hang.
    expect(() => translator.push({ type: 'error', code: null, message: '', param: null })).toThrowError(expect.objectContaining({ code: 'SERVER' }))
    expect(() => translator.push({ type: 'error', error: { code: 'context_length_exceeded', message: 'too long' } })).toThrowError(expect.objectContaining({ code: 'CONTEXT_WINDOW_EXCEEDED' }))
  })

  it('refuses an output item it never asked for, or a delta for an item it never opened', () => {
    const hosted = new OpenAITranslator()
    hosted.push(created())
    expect(() => hosted.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'ws_01', type: 'web_search_call', status: 'in_progress' } })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    const stray = new OpenAITranslator()
    expect(() => stray.push({ type: 'response.output_text.delta', output_index: 3, content_index: 0, delta: 'x' })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
    const mistyped = new OpenAITranslator()
    mistyped.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_01', type: 'reasoning', summary: [] } })
    expect(() => mistyped.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'x' })).toThrowError(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }))
  })

  it('ignores event types it does not know, and is incomplete until a terminal event arrives', () => {
    const translator = new OpenAITranslator()
    expect(translator.push(created())).toEqual([])
    expect(translator.push({ type: 'response.output_text.annotation.added', output_index: 0, annotation: {} })).toEqual([])
    expect(translator.push({ type: 'response.something_new', whatever: true })).toEqual([])
    translator.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_01', type: 'message', content: [] } })
    expect(translator.complete).toBe(false)
  })
})

describe('OpenAI replay alignment through BlockAssembler', () => {
  it('incomplete with an open function_call: the envelope survives, and the tool call is pruned with its entry in step', () => {
    const wire: Wire = [
      created(),
      ...reasoningItem(0, 'rs_01', ['Plan.'], SEAL),
      ...messageItem(1, 'msg_01', ['Reading it now.'], 'commentary'),
      { type: 'response.output_item.added', output_index: 2, item: { id: 'fc_01', type: 'function_call', status: 'in_progress', arguments: '', call_id: 'call_1', name: 'read' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"pa' },
      incomplete('max_output_tokens'),
    ]
    const chunks = translate(wire)
    // One entry per OPENED block, the open one included: that is the alignment.
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'max-tokens' }, replayState: { blocks: [{ type: 'reasoning' }, { type: 'message' }, { type: 'function_call', id: 'fc_01' }] } })
    const assembler = assemble(chunks)
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'Plan.' },
      { type: 'text', text: 'Reading it now.' },
    ])
    expect(assembler.replayState?.blocks).toEqual([
      { type: 'reasoning', id: 'rs_01', encrypted_content: SEAL },
      { type: 'message', id: 'msg_01', phase: 'commentary' },
    ])
    expect(assembler.usage).toEqual({ inputTokens: 30, outputTokens: 16, reasoningTokens: 16 })
  })

  it('incomplete mid-reasoning: the open item keeps a null entry, so nothing unsealed is ever replayed', () => {
    const wire: Wire = [
      created(),
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_01', type: 'reasoning', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Thinking about' },
      incomplete('max_output_tokens'),
    ]
    const assembler = assemble(translate(wire))
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
    expect(assembler.blocks()).toEqual([{ type: 'reasoning', text: 'Thinking about' }])
    expect(assembler.replayState?.blocks).toEqual([null])
    const message = createAssistantMessage(assembler.blocks(), 'openai', 'gpt-6-luna', assembler.replayState)
    expect(serializeInput([message], new Map(), 'gpt-6-luna')).toEqual([])
  })

  it('a two-part message is ONE text block with ONE msg_ entry', () => {
    const assembler = assemble(translate([created(), ...messageItem(0, 'msg_01', ['Hello ', 'world']), completed()]))
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(assembler.replayState?.blocks).toEqual([{ type: 'message', id: 'msg_01', phase: 'final_answer' }])
  })

  it('two reasoning items in one response are two blocks, each beside its own seal', () => {
    const wire: Wire = [created(), ...reasoningItem(0, 'rs_01', ['A'], 'seal-a'), ...reasoningItem(1, 'rs_02', ['B'], 'seal-b'), ...messageItem(2, 'msg_01', ['done']), completed()]
    const assembler = assemble(translate(wire))
    expect(assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'A' },
      { type: 'reasoning', text: 'B' },
      { type: 'text', text: 'done' },
    ])
    expect(assembler.replayState?.blocks).toEqual([
      { type: 'reasoning', id: 'rs_01', encrypted_content: 'seal-a' },
      { type: 'reasoning', id: 'rs_02', encrypted_content: 'seal-b' },
      { type: 'message', id: 'msg_01', phase: 'final_answer' },
    ])
  })
})

describe('OpenAI SSE parser', () => {
  it('yields named events across split reads, tolerates CRLF split across reads, and skips a [DONE] and comments', async () => {
    // The CR that ends the second read and the LF that starts the third are ONE
    // line end: read as two, they would be a blank line that cuts the event
    // from its data.
    const stream = sseStream(
      'event: response.created\ndata: {"a":',
      '1}\n\n: keep-alive\n\nevent: response.output_text.delta\r',
      '\ndata: {"b":2}\r\n\r\ndata: [DONE]\n\n',
      'event: response.completed\ndata: {"c":3}',
    )
    expect(await collect(parseNamedSse(stream, () => {}))).toEqual([
      { event: 'response.created', data: '{"a":1}' },
      { event: 'response.output_text.delta', data: '{"b":2}' },
      { event: 'response.completed', data: '{"c":3}', tail: true },
    ])
  })

  // The S18 review's reproduction: a body cut cleanly in the middle of an
  // event read as MALFORMED_RESPONSE, which nothing retries, where the same cut
  // at an event boundary is the retryable STREAM_CLOSED.
  it('reads a body cut in the middle of an event as the retryable STREAM_CLOSED', async () => {
    const server = await loopback((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`${sse([created('gpt-6-luna')])}data: {"type":"response.output_item.ad`)
    })
    try {
      const adapter = new OpenAIAdapter({ apiKeyRef: 'OPENAI_API_KEY', resolveKey: () => 'sk-test', baseURL: server.baseURL, defaultMaxTokens: 1024 })
      const failure = await collect(adapter.stream({ provider: 'openai', model: 'gpt-6-luna', messages: [] })).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'STREAM_CLOSED' })
    } finally {
      await server.close()
    }
  })
})

const BYTES = new Uint8Array([1, 2, 3, 4])
const REF: AttachmentRef = { id: asAttachmentId(`sha256:${'cd'.repeat(32)}`), mediaType: 'image/png', bytes: BYTES.length, width: 8, height: 8, name: 'dot.png' }
const IMAGE: ContentBlock = { type: 'image', attachment: REF, text: imageDescriptor(REF) }
const RESOLVED: ReadonlyMap<string, ResolvedImage> = new Map([[REF.id, { ref: REF, data: BYTES }]])
const DATA_URL = `data:image/png;base64,${Buffer.from(BYTES).toString('base64')}`

function userWithImage(text: string): Message {
  const message = createUserMessage(text)
  return { ...message, content: [...message.content, IMAGE] }
}

describe('OpenAI serialization', () => {
  const call = asCallId('call_1')
  const own = (model: string): Message =>
    createAssistantMessage(
      [
        { type: 'reasoning', text: 'Plan.' },
        { type: 'text', text: 'Let me look.' },
        { type: 'tool-call', id: call, name: 'read', arguments: '{"path":"a"}' },
      ],
      'openai',
      model,
      { response: { kind: 'openai', model, id: 'resp_01' }, blocks: [{ type: 'reasoning', id: 'rs_01', encrypted_content: SEAL }, { type: 'message', id: 'msg_01', phase: 'commentary' }, { type: 'function_call', id: 'fc_01' }] },
    )
  const history = (assistant: Message): Message[] => [createUserMessage('hi'), assistant, createToolResultMessage(call, [{ type: 'text', text: 'noon' }], false), createUserMessage('next')]
  const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] })
  const output = { type: 'function_call_output', call_id: 'call_1', output: 'noon' }
  const REPLAYED = [
    user('hi'),
    { type: 'reasoning', id: 'rs_01', summary: [], encrypted_content: SEAL },
    { type: 'message', role: 'assistant', id: 'msg_01', status: 'completed', content: [{ type: 'output_text', text: 'Let me look.', annotations: [] }], phase: 'commentary' },
    { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}', id: 'fc_01' },
    output,
    user('next'),
  ]
  const PLAIN = [user('hi'), { role: 'assistant', content: 'Let me look.' }, { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' }, output, user('next')]

  it('replays its own items to the same model: the sealed reasoning, the message id and phase, the fc_ id', () => {
    expect(serializeInput(history(own('gpt-6-luna')), new Map(), 'gpt-6-luna')).toEqual(REPLAYED)
  })

  it('sends a different model none of them: plain text and the call_id only, its reasoning dropped', () => {
    expect(serializeInput(history(own('gpt-6-luna')), new Map(), 'gpt-5.4')).toEqual(PLAIN)
    // The family split is exact, never a prefix.
    expect(serializeInput(history(own('gpt-5.4')), new Map(), 'gpt-5.4-mini')).toEqual(PLAIN)
  })

  it('replays across a dated snapshot or the alias, because the family is the canonical id', () => {
    expect(canonicalModel('gpt-6-luna-2026-10-01')).toBe('gpt-6-luna')
    expect(canonicalModel('gpt-5.6')).toBe('gpt-5.6-sol')
    expect(serializeInput(history(own('gpt-6-luna')), new Map(), 'gpt-6-luna-2026-10-01')).toEqual(REPLAYED)
    expect(serializeInput(history(own('gpt-5.6')), new Map(), 'gpt-5.6-sol-2026-07-09')).toEqual(REPLAYED)
  })

  it('sends foreign history as plain text and function_call, its reasoning dropped and its replay state ignored', () => {
    const deepseek = createAssistantMessage(
      [
        { type: 'reasoning', text: 'because' },
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: asCallId('call_00_ab'), name: 'edit', arguments: '{}' },
      ],
      'deepseek',
      'deepseek-flash',
    )
    // Unstripped on purpose: the runtime strips a foreign envelope, and the
    // serializer must not depend on that to stay honest.
    const anthropic = createAssistantMessage(
      [
        { type: 'reasoning', text: '' },
        { type: 'tool-call', id: asCallId('toolu_01'), name: 'read', arguments: '{"path":"b"}' },
      ],
      'anthropic',
      'claude-sonnet-5',
      { response: { kind: 'anthropic' }, blocks: [{ type: 'thinking', signature: 'sig' }, null] },
    )
    expect(serializeInput([deepseek, createToolResultMessage(asCallId('call_00_ab'), [], false), anthropic, createToolResultMessage(asCallId('toolu_01'), [{ type: 'text', text: 'b!' }], true)], new Map(), 'gpt-6-luna')).toEqual([
      { role: 'assistant', content: 'answer' },
      { type: 'function_call', call_id: 'call_00_ab', name: 'edit', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_00_ab', output: '(no output)' },
      { type: 'function_call', call_id: 'toolu_01', name: 'read', arguments: '{"path":"b"}' },
      { type: 'function_call_output', call_id: 'toolu_01', output: 'b!' },
    ])
  })

  it('replays nothing from an envelope that does not align with its blocks, or an entry that is malformed', () => {
    const misaligned = createAssistantMessage([{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'y' }], 'openai', 'gpt-6-luna', { response: { kind: 'openai' }, blocks: [{ type: 'reasoning', id: 'rs_01', encrypted_content: SEAL }] })
    expect(serializeInput([misaligned], new Map(), 'gpt-6-luna')).toEqual([{ role: 'assistant', content: 'y' }])
    const malformed = createAssistantMessage([{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'y' }], 'openai', 'gpt-6-luna', { response: { kind: 'openai' }, blocks: [{ type: 'reasoning', id: 'rs_01', encrypted_content: '' }, { type: 'message', id: 7 }] })
    expect(serializeInput([malformed], new Map(), 'gpt-6-luna')).toEqual([{ role: 'assistant', content: 'y' }])
  })

  it('carries an image as a data URL in a user message and as an output array in a tool result, else the stored descriptor', () => {
    const result = createToolResultMessage(call, [{ type: 'text', text: 'here' }, IMAGE], false)
    expect(serializeInput([userWithImage('what colour?'), result], RESOLVED, 'gpt-6-luna')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'what colour?' }, { type: 'input_image', image_url: DATA_URL }] },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'here' }, { type: 'input_image', image_url: DATA_URL }] },
    ])
    // Not resolved — a text-only route — and both say what the log stored.
    expect(serializeInput([userWithImage('what colour?'), result], new Map(), 'gpt-6-luna')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: `what colour?${imageDescriptor(REF)}` }] },
      { type: 'function_call_output', call_id: 'call_1', output: `here${imageDescriptor(REF)}` },
    ])
  })

  it('coalesces a message’s text, keeps a plugin message as user input, and skips a message with nothing in it', () => {
    const twoTexts: Message = { ...createUserMessage('a'), content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }
    expect(serializeInput([twoTexts, createUserMessage(''), createPluginMessage('test', 'a reminder')], new Map(), 'gpt-6-luna')).toEqual([user('ab'), user('a reminder')])
  })

  it('serializes tools with strict false, explicitly', () => {
    expect(serializeTools(undefined)).toBeUndefined()
    expect(serializeTools([])).toBeUndefined()
    expect(serializeTools([{ name: 'x', description: 'd', parameters: { type: 'object' } }])).toEqual([{ type: 'function', name: 'x', description: 'd', parameters: { type: 'object' }, strict: false }])
  })
})

/** A store that counts reads, so a test can say no attachment I/O happened. */
function watchingStore(): { store: Attachments; reads: () => number } {
  let reads = 0
  return {
    store: {
      imageLimits: { maxImageBytes: 1, maxImageDimension: 1, maxImagePixels: 1, maxImagesPerRequest: 1, maxRequestImageBytes: 1, mediaTypes: ['image/png'] },
      saveImage: () => Promise.reject(new Error('not used')),
      readImage: () => {
        reads += 1
        return Promise.resolve(BYTES)
      },
      hostPath: () => undefined,
    },
    reads: () => reads,
  }
}

interface Captured {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** A loopback stand-in for the API that this test owns: every request is captured, and `respond` writes the answer. */
async function loopback(respond: (request: Captured, response: ServerResponse) => void): Promise<{ baseURL: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (body += chunk))
    request.on('end', () => {
      const captured = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body }
      requests.push(captured)
      respond(captured, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const sse = (wire: Wire): string => wire.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')

function answering(wire: Wire): (request: Captured, response: ServerResponse) => void {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_ok' })
    response.end(sse(wire))
  }
}

describe('OpenAI adapter', () => {
  let closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const close of closers) await close()
    closers = []
  })

  const adapterWith = (overrides: Partial<OpenAIAdapterOptions> = {}): { adapter: OpenAIAdapter; resolved: () => number } => {
    let resolved = 0
    const adapter = new OpenAIAdapter({
      apiKeyRef: 'OPENAI_API_KEY',
      resolveKey: () => {
        resolved += 1
        return 'test-key'
      },
      baseURL: 'http://127.0.0.1:1/v1',
      defaultMaxTokens: 32_768,
      ...overrides,
    })
    return { adapter, resolved: () => resolved }
  }
  const base = { provider: 'openai', messages: [createUserMessage('hi')] }

  it('refuses what a model cannot honour before reading the key or sending a byte', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch must not be called'))
    const { store } = watchingStore()
    const { adapter, resolved } = adapterWith()
    const refusals: [Partial<LlmRequest> & { model: string }, string][] = [
      [{ model: 'gpt-6-luna', reasoningEffort: 'minimal' }, 'UNSUPPORTED_REASONING_EFFORT'],
      [{ model: 'gpt-6-astra', reasoningEffort: 'none' }, 'UNSUPPORTED_REASONING_EFFORT'],
      // The default effort is medium, so a bare temperature is the measured 400.
      [{ model: 'gpt-6-luna', temperature: 0.2 }, 'UNSUPPORTED_OPTION'],
      [{ model: 'gpt-6-luna', reasoningEffort: 'high', temperature: 0.2 }, 'UNSUPPORTED_OPTION'],
      // A `never` row refuses a temperature at every level it has.
      [{ model: 'gpt-6-astra', reasoningEffort: 'low', temperature: 0.2 }, 'UNSUPPORTED_OPTION'],
      [{ model: 'gpt-5-mini', reasoningEffort: 'minimal', temperature: 0.2 }, 'UNSUPPORTED_OPTION'],
      // Measured: the API itself accepts 10,000,000, so the cap is ours.
      [{ model: 'gpt-6-luna', maxTokens: 128_001 }, 'UNSUPPORTED_OPTION'],
      [{ model: 'gpt-7-nova', reasoningEffort: 'low' }, 'UNSUPPORTED_REASONING_EFFORT'],
      [{ model: 'gpt-7-nova', temperature: 0.2 }, 'UNSUPPORTED_OPTION'],
      // Below the API's measured minimum of 16, for any model.
      [{ model: 'gpt-6-luna', maxTokens: 15 }, 'UNSUPPORTED_OPTION'],
    ]
    for (const [options, code] of refusals) {
      const stream = adapter.stream({ ...base, ...options })
      await expect(stream[Symbol.asyncIterator]().next(), JSON.stringify(options)).rejects.toMatchObject({ code })
    }
    // An image route with no store mounted cannot be served as the log records it.
    const noStore = adapter.stream({ provider: 'openai', model: 'gpt-6-luna', messages: [userWithImage('look')] })
    await expect(noStore[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(resolved()).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()

    const unknownEffort = adapter.stream({ ...base, model: 'gpt-7-nova', reasoningEffort: 'low' })
    await expect(unknownEffort[Symbol.asyncIterator]().next()).rejects.toThrowError(/efforts are unknown/)
    const lunaEffort = adapter.stream({ ...base, model: 'gpt-6-luna', reasoningEffort: 'minimal' })
    await expect(lunaEffort[Symbol.asyncIterator]().next()).rejects.toThrowError(/none, low, medium, high, xhigh, max/)

    // No key: refused, naming the reference and where it would be looked for, still before the wire.
    const keyless = adapterWith({ resolveKey: () => undefined, describeKey: () => 'the OPENAI_API_KEY environment variable', resolveAttachments: () => store }).adapter
    const missing = keyless.stream({ ...base, model: 'gpt-6-luna' })
    await expect(missing[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL', message: expect.stringContaining('OPENAI_API_KEY environment variable') })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // The order the comments promise, pinned: an option refusal costs no disk
  // read of the images the request carries (S18 review: deleting the first
  // `validateOptions` in `stream()` used to pass every test).
  it('refuses an option before it reads a single image', async () => {
    const watched = watchingStore()
    const { adapter } = adapterWith({ resolveAttachments: () => watched.store })
    const refused = adapter.stream({ provider: 'openai', model: 'gpt-6-luna', messages: [userWithImage('look')], temperature: 0.3 })
    await expect(refused[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(watched.reads()).toBe(0)
  })

  it('forbids a tool call when the request says none, keeping the tools on the wire', () => {
    const { adapter } = adapterWith()
    const tools = [{ name: 't', description: 'd', parameters: { type: 'object' } }]
    expect(adapter.buildBody({ ...base, model: 'gpt-5.4', tools, toolChoice: 'none' })).toMatchObject({ tools: [{ name: 't' }], tool_choice: 'none' })
    expect(adapter.buildBody({ ...base, model: 'gpt-5.4', tools })).not.toHaveProperty('tool_choice')
  })

  it('honours a temperature exactly where the API does: effort none on an effort-none row', () => {
    const { adapter } = adapterWith()
    expect(adapter.buildBody({ ...base, model: 'gpt-6-luna', reasoningEffort: 'none', temperature: 0.3 })).toMatchObject({ temperature: 0.3, reasoning: { effort: 'none' } })
    // gpt-5.4 defaults to `none`, so no effort named is still none.
    const body = adapter.buildBody({ ...base, model: 'gpt-5.4', temperature: 0.3 })
    expect(body).toMatchObject({ temperature: 0.3 })
    expect(body).not.toHaveProperty('reasoning')
  })

  it('spells reasoning per row: sealed with a summary when it reasons, effort none alone, nothing for an unknown id', () => {
    const { adapter } = adapterWith()
    const fields = (request: Partial<LlmRequest> & { model: string }, on: OpenAIAdapter = adapter) => {
      const body = on.buildBody({ ...base, ...request })
      return { reasoning: body.reasoning, include: body.include }
    }
    const sealed = ['reasoning.encrypted_content']
    expect(fields({ model: 'gpt-6-luna' })).toEqual({ reasoning: { summary: 'auto' }, include: sealed })
    expect(fields({ model: 'gpt-6-luna', reasoningEffort: 'high' })).toEqual({ reasoning: { effort: 'high', summary: 'auto' }, include: sealed })
    expect(fields({ model: 'gpt-6-luna', reasoningEffort: 'none' })).toEqual({ reasoning: { effort: 'none' }, include: undefined })
    expect(fields({ model: 'gpt-5.4' })).toEqual({ reasoning: undefined, include: undefined })
    expect(fields({ model: 'gpt-5.4-2026-03-05', reasoningEffort: 'low' })).toEqual({ reasoning: { effort: 'low', summary: 'auto' }, include: sealed })
    expect(fields({ model: 'gpt-5-nano', reasoningEffort: 'minimal' })).toEqual({ reasoning: { effort: 'minimal', summary: 'auto' }, include: sealed })
    expect(fields({ model: 'gpt-7-nova' })).toEqual({ reasoning: undefined, include: undefined })
    // The escape for an organization the API refuses summaries to: the seal is still asked for.
    const quiet = adapterWith({ reasoningSummaries: false }).adapter
    expect(fields({ model: 'gpt-6-luna', reasoningEffort: 'high' }, quiet)).toEqual({ reasoning: { effort: 'high' }, include: sealed })
    expect(fields({ model: 'gpt-6-luna' }, quiet)).toEqual({ reasoning: undefined, include: sealed })
  })

  it('sends the measured wire, and never a field it does not mean', () => {
    const { adapter } = adapterWith()
    const body = adapter.buildBody({
      ...base,
      model: 'gpt-6-luna',
      system: 'be terse',
      reasoningEffort: 'high',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      sessionId: 's' as never,
      purpose: 'compaction',
    })
    expect(body).toEqual({
      model: 'gpt-6-luna',
      instructions: 'be terse',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
      store: false,
      max_output_tokens: 32_768,
      stream_options: { include_obfuscation: false },
      tools: [{ type: 'function', name: 't', description: 'd', parameters: { type: 'object' }, strict: false }],
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    })
    for (const absent of ['truncation', 'prompt_cache_key', 'safety_identifier', 'user', 'parallel_tool_calls', 'previous_response_id']) expect(body).not.toHaveProperty(absent)
    // An empty system prompt is no instructions, not an empty one.
    expect(adapter.buildBody({ ...base, model: 'gpt-6-luna', system: '' })).not.toHaveProperty('instructions')
  })

  it('caps output at the request, else the configured default, never past the row', () => {
    const cap = (model: string, maxTokens?: number, defaultMaxTokens = 32_768) =>
      adapterWith({ defaultMaxTokens }).adapter.buildBody({ ...base, model, ...(maxTokens === undefined ? {} : { maxTokens }) }).max_output_tokens
    expect(cap('gpt-6-luna')).toBe(32_768)
    expect(cap('gpt-6-luna', 1000)).toBe(1000)
    expect(cap('gpt-6-luna', 128_000)).toBe(128_000)
    expect(cap('gpt-6-luna', undefined, 200_000)).toBe(128_000)
    // An unknown id has no cap of ours: the deployment default goes, and a larger explicit cap is the provider's to judge.
    expect(cap('gpt-7-nova')).toBe(32_768)
  })

  it('advertises per-row facts; a snapshot and the alias resolve to their row, and an unknown id gets conservative ones', () => {
    const { adapter } = adapterWith()
    expect(adapter.resolveModel('gpt-6-luna')).toEqual({
      contextWindow: 922_000,
      defaultMaxTokens: 32_768,
      reasoning: { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
      inputModalities: ['text', 'image'],
    })
    expect(adapter.resolveModel('gpt-6-astra').reasoning.efforts).not.toContain('none')
    expect(adapter.resolveModel('gpt-5-mini').reasoning).toEqual({ efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' })
    expect(adapter.resolveModel('gpt-5.4-mini-2026-03-17')).toMatchObject({ contextWindow: 272_000, reasoning: { defaultEffort: 'none' } })
    expect(adapter.resolveModel('gpt-5.6')).toEqual(adapter.resolveModel('gpt-5.6-sol'))
    // Exact, never a prefix: 5.4 is a 922K row and 5.4-mini a 272K one, and an id neither names is neither.
    expect(adapter.resolveModel('gpt-5.4').contextWindow).toBe(922_000)
    expect(adapter.resolveModel('gpt-5.4-mini').contextWindow).toBe(272_000)
    expect(adapter.resolveModel('gpt-5.4-pro').contextWindow).toBe(128_000)
    expect(adapter.resolveModel('gpt-7-nova')).toEqual({ contextWindow: 128_000, defaultMaxTokens: 32_768, reasoning: { efforts: [] }, inputModalities: ['text'] })
    expect(adapterWith({ defaultMaxTokens: 4096 }).adapter.resolveModel('gpt-6-luna').defaultMaxTokens).toBe(4096)
    expect(adapter.listModels().map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2',
      'gpt-5-mini',
      'gpt-5-nano',
    ])
  })

  it('classifies HTTP failures by status and by the code the body names', () => {
    const headers = (extra: Record<string, string> = {}) => new Headers({ 'x-request-id': 'req_1', ...extra })
    const body = (message: string, code: string | null, type = 'invalid_request_error') => JSON.stringify({ error: { message, type, param: null, code } })
    expect(classifyHttp(400, body('Your input exceeds the context window of this model.', 'context_length_exceeded'), headers())).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED', failure: { requestId: 'req_1', status: 400 } })
    expect(classifyHttp(400, body("This model's maximum context length is 128000 tokens.", null), headers())).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
    expect(classifyHttp(400, body("Unsupported parameter: 'temperature' is not supported with this model.", null), headers())).toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(classifyHttp(400, body("Unsupported value: 'reasoning.effort' does not support 'minimal' with this model.", 'unsupported_value'), headers())).toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(classifyHttp(400, body('Invalid input.', 'invalid_value'), headers())).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(classifyHttp(401, body('Incorrect API key provided.', 'invalid_api_key'), headers())).toMatchObject({ code: 'AUTH' })
    expect(classifyHttp(403, body('Country not supported.', 'unsupported_country_region_territory'), headers())).toMatchObject({ code: 'AUTH' })
    expect(classifyHttp(404, body('The model `gpt-7` does not exist or you do not have access to it.', 'model_not_found'), headers())).toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(classifyHttp(404, '<html>not found</html>', headers())).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(classifyHttp(429, body('Rate limit reached.', 'rate_limit_exceeded', 'requests'), headers({ 'retry-after': '7' }))).toMatchObject({ code: 'RATE_LIMIT', failure: { retryAfterMs: 7000 } })
    expect(classifyHttp(429, body('You exceeded your current quota.', 'insufficient_quota', 'insufficient_quota'), headers())).toMatchObject({ code: 'QUOTA' })
    expect(classifyHttp(429, body('Spend limit.', 'organization_spend_limit_exceeded'), headers())).toMatchObject({ code: 'QUOTA' })
    expect(classifyHttp(429, body('Usage limit.', 'project_usage_limit_exceeded'), headers())).toMatchObject({ code: 'QUOTA' })
    expect(classifyHttp(429, body('No credit.', null, 'credit_balance_exhausted'), headers())).toMatchObject({ code: 'QUOTA' })
    // 504 before the 5xx row.
    expect(classifyHttp(504, '<html>gateway timeout</html>', headers())).toMatchObject({ code: 'TIMEOUT' })
    expect(classifyHttp(503, body('The engine is currently overloaded.', null, 'server_error'), headers())).toMatchObject({ code: 'SERVER' })
    expect(classifyHttp(500, 'oops', headers())).toMatchObject({ code: 'SERVER' })
  })

  it('streams the measured turn over a real socket: the endpoint, the headers, the body, and a protocol-valid fold', async () => {
    const server = await loopback(answering(CAPTURE))
    closers.push(server.close)
    const silent: Logger = { warn: () => {}, error: () => {} }
    const root = createRoot({ logger: silent })
    closers.push(() => root.dispose())
    root.plugin(llmPlugin)
    root.plugin(credentialsPlugin({ OPENAI_API_KEY: 'test-key' }))
    const handle = root.plugin(openaiPlugin, { baseURL: server.baseURL })
    await root.settle()
    expect(handle.state).toBe('active')
    // Through the runtime, so `validateStream` holds the translator to the protocol.
    const chunks = await collect(
      root.get(LLM).stream({ provider: 'openai', model: 'gpt-6-luna', system: 'be terse', reasoningEffort: 'high', messages: [createUserMessage('read bravo.txt')], tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }] }),
    )
    expect(server.requests).toHaveLength(1)
    const [request] = server.requests
    expect(request).toMatchObject({ method: 'POST', url: '/v1/responses' })
    expect(request!.headers).toMatchObject({ authorization: 'Bearer test-key', 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': expect.stringMatching(/^minidsh /) })
    expect(JSON.parse(request!.body)).toEqual({
      model: 'gpt-6-luna',
      instructions: 'be terse',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'read bravo.txt' }] }],
      stream: true,
      store: false,
      max_output_tokens: 32_768,
      stream_options: { include_obfuscation: false },
      tools: [{ type: 'function', name: 'read', description: 'd', parameters: { type: 'object' }, strict: false }],
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    })
    const assembler = assemble(chunks)
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.blocks().map((block) => block.type)).toEqual(['reasoning', 'tool-call'])
    expect(assembler.replayState?.blocks).toEqual([{ type: 'reasoning', id: 'rs_01', encrypted_content: SEAL }, { type: 'function_call', id: 'fc_01' }])
  })

  it('reports an HTTP failure with its x-request-id, and a body cut before its terminal event as STREAM_CLOSED', async () => {
    const missing = await loopback((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json', 'x-request-id': 'req_404' })
      response.end(JSON.stringify({ error: { message: 'The model `gpt-7` does not exist or you do not have access to it.', type: 'invalid_request_error', param: null, code: 'model_not_found' } }))
    })
    closers.push(missing.close)
    const { adapter } = adapterWith({ baseURL: missing.baseURL })
    await expect(collect(adapter.stream({ ...base, model: 'gpt-7' }))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL', failure: { status: 404, requestId: 'req_404' } })

    const cut = await loopback(answering([created(), ...messageItem(0, 'msg_01', ['half an ans'])]))
    closers.push(cut.close)
    const cutAdapter = adapterWith({ baseURL: cut.baseURL }).adapter
    await expect(collect(cutAdapter.stream({ ...base, model: 'gpt-6-luna' }))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('maps a caller abort mid-stream to ABORTED', async () => {
    const server = await loopback((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // One block opens, then the body stays open: only the abort can end it.
      response.write(sse([created(), { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_01', type: 'message', content: [] } }]))
    })
    closers.push(server.close)
    const controller = new AbortController()
    const { adapter } = adapterWith({ baseURL: server.baseURL })
    const iterator = adapter.stream({ ...base, model: 'gpt-6-luna', signal: controller.signal })[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'ABORTED' })
  })

  /**
   * Substitute at projection, never refuse a durable history: an image an
   * unknown (text-only) id cannot take goes as its stored descriptor, and its
   * bytes are never read. Admission — never letting an image INTO a history
   * the current route cannot take — is the loop's, before any adapter (§5).
   */
  it('never reads an image for an unknown text-only id, and sends its stored descriptor instead', async () => {
    const server = await loopback(answering([created('gpt-7-nova'), ...messageItem(0, 'msg_01', ['a dot']), completed()]))
    closers.push(server.close)
    const { store, reads } = watchingStore()
    const { adapter } = adapterWith({ baseURL: server.baseURL, resolveAttachments: () => store })
    const chunks = await collect(adapter.stream({ provider: 'openai', model: 'gpt-7-nova', messages: [userWithImage('what is it?')] }))
    expect(reads()).toBe(0)
    expect(JSON.parse(server.requests[0]!.body).input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: `what is it?${imageDescriptor(REF)}` }] }])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    // The same history on a catalogued vision row reads the bytes and sends them.
    const vision = await loopback(answering([created(), ...messageItem(0, 'msg_01', ['a dot']), completed()]))
    closers.push(vision.close)
    await collect(adapterWith({ baseURL: vision.baseURL, resolveAttachments: () => store }).adapter.stream({ provider: 'openai', model: 'gpt-6-luna', messages: [userWithImage('what is it?')] }))
    expect(reads()).toBe(1)
    expect(JSON.parse(vision.requests[0]!.body).input[0].content[1]).toEqual({ type: 'input_image', image_url: DATA_URL })
  })
})

/** The credential seam, in memory: what a row declares is what a child would be denied. */
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

describe('llm-openai row', () => {
  const silent: Logger = { warn: () => {}, error: () => {} }

  it('declares its credential (renamed, when its config renames it) and advertises the catalog with windows', async () => {
    const root = createRoot({ logger: silent })
    root.plugin(llmPlugin)
    root.plugin(credentialsPlugin({}))
    root.plugin(openaiPlugin)
    await root.settle()
    expect(root.get(CREDENTIALS).declaredRefs()).toEqual(['OPENAI_API_KEY'])
    const provider = root.get(LLM).providers().find((entry) => entry.id === 'openai')
    expect(provider?.models).toHaveLength(14)
    expect(provider?.models.find((model) => model.id === 'gpt-5.2')).toEqual({ id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272_000, inputModalities: ['text', 'image'] })
    await root.dispose()

    const renamed = createRoot({ logger: silent })
    renamed.plugin(llmPlugin)
    renamed.plugin(credentialsPlugin({}))
    renamed.plugin(openaiPlugin, { apiKeyEnv: 'CORP_OPENAI_CRED' })
    await renamed.settle()
    expect(renamed.get(CREDENTIALS).declaredRefs()).toEqual(['CORP_OPENAI_CRED'])
    await renamed.dispose()
  })

  it('refuses a config key it does not know, so a typo fails the row loudly', async () => {
    const root = createRoot({ logger: silent })
    root.plugin(llmPlugin)
    root.plugin(credentialsPlugin({}))
    const handle = root.plugin(openaiPlugin, { reasoningSummary: false } as never)
    await root.settle()
    expect(handle.state).toBe('failed')
    expect(root.get(LLM).hasProvider('openai')).toBe(false)
    await root.dispose()
  })

  it('refuses a base URL carrying user info, from config or from the environment, without quoting the password', async () => {
    expect(() => openaiPlugin.config!.parse({ baseURL: 'https://proxyuser:proxy-PASSWORD-123@proxy.example/v1' })).toThrow()
    const saved = process.env.OPENAI_BASE_URL
    process.env.OPENAI_BASE_URL = 'https://proxyuser:proxy-PASSWORD-123@proxy.example/v1'
    try {
      const root = createRoot({ logger: silent })
      root.plugin(llmPlugin)
      root.plugin(credentialsPlugin({}))
      const handle = root.plugin(openaiPlugin)
      const report = await root.settle()
      expect(handle.state).toBe('failed')
      const said = report.failed.map((entry) => String(entry.error)).join('\n')
      expect(said).toMatch(/OPENAI_BASE_URL/)
      expect(said).not.toContain('proxy-PASSWORD-123')
      await root.dispose()
    } finally {
      if (saved === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = saved
    }
  })
})

describe('OpenAI wire bounds (S20.5)', () => {
  let closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const close of closers) await close()
    closers = []
  })
  const base = { provider: 'openai', model: 'gpt-6-luna', messages: [createUserMessage('hi')] }

  it('fails one event that never ends past its cap as MALFORMED_RESPONSE', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    await expect(collect(parseNamedSse(sseStream('event: x\ndata: "', ...Array.from({ length: 9 }, () => chunk)), () => {}))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('reads at most a bounded prefix of an error body, still classifying by status, and never quotes an echoed key', { timeout: 10_000 }, async () => {
    const key = 'sk-proj-ECHOED-0123456789'
    let mode: 'endless' | 'echo' = 'endless'
    const api = await loopback((_request, response) => {
      if (mode === 'endless') {
        response.writeHead(503, { 'content-type': 'text/plain' })
        response.write('y'.repeat(200 * 1024))
        return
      }
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.`, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }))
    })
    closers.push(api.close)
    const adapter = new OpenAIAdapter({ apiKeyRef: 'OPENAI_API_KEY', resolveKey: () => key, baseURL: api.baseURL, defaultMaxTokens: 1024 })
    const first = (): Promise<unknown> => adapter.stream(base)[Symbol.asyncIterator]().next().catch((error: unknown) => error)
    expect(await first()).toMatchObject({ code: 'SERVER', failure: { status: 503 } })
    mode = 'echo'
    const failure = (await first()) as Error
    expect(failure).toMatchObject({ code: 'AUTH' })
    expect(failure.message).not.toContain(key)
  })

  // The S20.5 review: a failure the stream itself carries (response.failed)
  // is YIELDED, and only thrown errors passed the redaction.
  it('never quotes the key in a failure the stream itself reports', async () => {
    const key = 'sk-proj-ECHOED-IN-STREAM-42'
    const api = await loopback((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sse([created('gpt-6-luna'), { type: 'response.failed', response: { id: 'resp_01', status: 'failed', error: { code: 'server_error', message: `upstream rejected ${key}` } } }]))
    })
    closers.push(api.close)
    const adapter = new OpenAIAdapter({ apiKeyRef: 'OPENAI_API_KEY', resolveKey: () => key, baseURL: api.baseURL, defaultMaxTokens: 1024 })
    const chunks = await collect(adapter.stream(base))
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    expect(finish).toMatchObject({ reason: { kind: 'error' } })
    expect(JSON.stringify(finish)).not.toContain(key)
    expect(JSON.stringify(finish)).toContain('[redacted]')
  })

  // The S20.5 review: past llm-retry's ceiling the turn ends on this message,
  // and it did not say how long the provider had asked to wait.
  it('names the wait a provider asked for in the failure itself', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached.', type: 'requests', param: null, code: 'rate_limit_exceeded' } })
    expect(classifyHttp(429, body, new Headers({ 'retry-after': '3600' })).message).toContain('wait 3600 s')
    expect(classifyHttp(429, body, new Headers()).message).not.toContain('wait')
  })

  it('reads the retry-after-ms header, which OpenAI sends beside retry-after, and prefers it', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached.', type: 'requests', param: null, code: 'rate_limit_exceeded' } })
    expect(classifyHttp(429, body, new Headers({ 'retry-after-ms': '1500', 'retry-after': '2' }))).toMatchObject({ failure: { retryAfterMs: 1500 } })
    expect(classifyHttp(429, body, new Headers({ 'retry-after-ms': '250' }))).toMatchObject({ failure: { retryAfterMs: 250 } })
    expect(classifyHttp(429, body, new Headers({ 'retry-after': '2' }))).toMatchObject({ failure: { retryAfterMs: 2000 } })
  })
})
