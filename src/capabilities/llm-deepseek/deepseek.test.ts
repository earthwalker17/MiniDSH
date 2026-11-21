import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from '../../kernel/index.ts'
import { asAttachmentId, type AttachmentRef, type Attachments } from '../../core/attachments/index.ts'
import { imageDescriptor } from '../../core/llm/content.ts'
import { BlockAssembler, llmPlugin, RETRYABLE_CODES, type LlmError, type LlmRequest, type Message, type StreamChunk } from '../../core/llm/index.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../../core/llm/message.ts'
import { asCallId } from '../../core/ids.ts'
import { credentialsLocalPlugin } from '../credentials-local/index.ts'
import { classifyHttp, DeepSeekAdapter } from './adapter.ts'
import { deepseekPlugin } from './index.ts'
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

  // A body that ends inside an event is the same dropped connection, one
  // event sooner: handed on, the half payload failed MALFORMED_RESPONSE,
  // which nothing retries.
  it('names a body cut in the middle of an event as STREAM_CLOSED, and still hands on a whole event that only lacked its blank line', async () => {
    const seen: string[] = []
    const cut = (async () => {
      for await (const data of parseSse(sseStream('data: {"a":1}\n\ndata: {"b"'), () => {})) seen.push(data)
    })()
    await expect(cut).rejects.toMatchObject({ code: 'STREAM_CLOSED', message: expect.stringContaining('middle of an event') })
    expect(seen).toEqual(['{"a":1}'])
    // Cut inside the sentinel itself: the same thing.
    await expect(collect(parseSse(sseStream('data: {"a":1}\n\ndata: [DON'), () => {}))).rejects.toMatchObject({ code: 'STREAM_CLOSED', message: expect.stringContaining('middle of an event') })
    // Whole, with no blank line after it: an event like any other, and the sentinel ends the stream.
    expect(await collect(parseSse(sseStream('data: {"a":1}\n\ndata: [DONE]'), () => {}))).toEqual(['{"a":1}', '[DONE]'])
    const whole: string[] = []
    const unterminated = (async () => {
      for await (const data of parseSse(sseStream('data: {"a":1}\n\ndata: {"b":2}'), () => {})) whole.push(data)
    })()
    await expect(unterminated).rejects.toThrowError(/without \[DONE\]/)
    expect(whole).toEqual(['{"a":1}', '{"b":2}'])
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

  // Empty means NO block opened. A thought with no answer after it opened one,
  // so it finishes `stop`: the OpenAI translator alone calls that EMPTY_RESPONSE.
  it('finishes a completion that only thought as stop, not as an empty response', () => {
    const translator = new DeepSeekTranslator()
    translator.push({ choices: [{ delta: { reasoning_content: 'hm' } }] })
    translator.push({ choices: [{ finish_reason: 'stop' }] })
    expect(translator.finalize().at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
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

  it('never presents another provider\'s reasoning as its own', () => {
    const wire = serializeMessages(undefined, [
      createAssistantMessage([{ type: 'reasoning', text: '**Reading the file** summary' }, { type: 'text', text: 'BRAVO-22' }], 'openai', 'gpt-5.4-mini'),
      createAssistantMessage([{ type: 'reasoning', text: 'a thought' }, { type: 'text', text: 'ok' }], 'anthropic', 'claude-sonnet-5'),
    ])
    expect(wire.map((message) => message.reasoning_content)).toEqual(['', ''])
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
    const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'never-used', baseURL: 'http://127.0.0.1:1', defaultMaxTokens: 8192 })
    expect(adapter.resolveModel('deepseek-flash')).toMatchObject({ contextWindow: 1_048_576, defaultMaxTokens: 8192 })
    expect(adapter.resolveModel('deepseek-v5-someday')).toMatchObject({ contextWindow: 131_072, defaultMaxTokens: 8192, inputModalities: ['text'] })
    // A deployment default above a model's cap is clamped to the cap, never sent as asked.
    const generous = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'never-used', baseURL: 'http://127.0.0.1:1', defaultMaxTokens: 500_000 })
    expect(generous.resolveModel('deepseek-flash').defaultMaxTokens).toBe(393_216)
    // An unknown id has no cap of ours to clamp to: the deployment default goes, and the provider judges it.
    expect(generous.resolveModel('deepseek-v5-someday').defaultMaxTokens).toBe(500_000)
  })

  it('refuses an output cap above the model\'s and a temperature thinking would ignore, before any I/O', async () => {
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
    await expect(first({ provider: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.2 })).rejects.toThrowError(/effort to "off", or route the session/)
    await expect(first({ provider: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.2, reasoningEffort: 'high' })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(resolved).toBe(0)
    // With thinking off the provider honours it, so it passes validation (and fails later, at the unreachable endpoint).
    expect(() => adapter.validateOptions({ provider: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.2, reasoningEffort: 'off' })).not.toThrow()
  })

  it('forbids a tool call when the request says none, keeping the tools on the wire', async () => {
    const bodies: Record<string, unknown>[] = []
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      request.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'sk-test', baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, defaultMaxTokens: 8192 })
      const tools = [{ name: 't', description: 'd', parameters: { type: 'object' } }]
      for (const toolChoice of ['none', undefined] as const) {
        for await (const _ of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [], tools, ...(toolChoice ? { toolChoice } : {}) })) {
          // drained
        }
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    expect(bodies[0]).toMatchObject({ tools: [{ type: 'function' }], tool_choice: 'none' })
    expect(bodies[1]).not.toHaveProperty('tool_choice')
  })

  it('refuses a key no HTTP header can carry by its reference, before any I/O, never quoting it', async () => {
    const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'sk-real-part\nsecond-line', baseURL: 'http://127.0.0.1:1', defaultMaxTokens: 8192 })
    const failure = await adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [] })[Symbol.asyncIterator]().next().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect((failure as Error).message).toContain('DEEPSEEK_API_KEY')
    expect((failure as Error).message).not.toContain('sk-real-part')
  })

  it('reads the unknown-model 400 as UNKNOWN_MODEL, which nothing retries', async () => {
    const body = JSON.stringify({ error: { message: 'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v9-ultra.', type: 'invalid_request_error', code: 'invalid_request_error' } })
    expect(classifyHttp(400, body, new Headers()).code).toBe('UNKNOWN_MODEL')
    const range = JSON.stringify({ error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]', type: 'invalid_request_error' } })
    expect(classifyHttp(400, range, new Headers()).code).toBe('INVALID_REQUEST')
  })
})

// ---- S20.5: the wire as a hostile, or merely different, endpoint serves it ----

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

const first = (adapter: DeepSeekAdapter): Promise<unknown> =>
  adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [] })[Symbol.asyncIterator]().next().catch((error: unknown) => error)

describe('DeepSeek wire framing and bounds', () => {
  it('frames CRLF and lone-CR line ends as the SSE grammar allows', async () => {
    const crlf = sseStream('data: {"a":1}\r\n\r\ndata: {"b":2}\r', '\n\r\ndata: [DONE]\r\n\r\n')
    expect(await collect(parseSse(crlf, () => {}))).toEqual(['{"a":1}', '{"b":2}', '[DONE]'])
    const cr = sseStream('data: {"a":1}\r\rdata: [DONE]\r\r')
    expect(await collect(parseSse(cr, () => {}))).toEqual(['{"a":1}', '[DONE]'])
  })

  it('fails one event that never ends past its cap as MALFORMED_RESPONSE, not as a buffer that grows', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    const parts = ['data: {"a":"', ...Array.from({ length: 9 }, () => chunk)]
    await expect(collect(parseSse(sseStream(...parts), () => {}))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('reads at most a bounded prefix of an error body, and still classifies by status', { timeout: 10_000 }, async () => {
    // A 503 whose body never ends: reading it whole hangs until the idle watchdog, five minutes later.
    const api = await loopback((response) => {
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.write('y'.repeat(200 * 1024))
    })
    try {
      const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'sk-test', baseURL: api.baseURL, defaultMaxTokens: 16 })
      expect(await first(adapter)).toMatchObject({ code: 'SERVER', failure: { status: 503 } })
    } finally {
      await api.close()
    }
  })

  it('takes a base URL with a trailing slash as the same endpoint', async () => {
    const api = await loopback((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    try {
      const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => 'sk-test', baseURL: `${api.baseURL}/`, defaultMaxTokens: 16 })
      for await (const _chunk of adapter.stream({ provider: 'deepseek', model: 'deepseek-flash', messages: [] })) {
        // drained
      }
      expect(api.seen).toEqual(['/chat/completions'])
    } finally {
      await api.close()
    }
  })

  it('never quotes the key a provider or a proxy echoes back in its error', async () => {
    const key = 'sk-ECHOED-0123456789'
    const api = await loopback((response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `Authentication Fails, Your api key: ${key} is invalid`, type: 'authentication_error' } }))
    })
    try {
      const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => key, baseURL: api.baseURL, defaultMaxTokens: 16 })
      const failure = await first(adapter)
      expect(failure).toMatchObject({ code: 'AUTH' })
      expect((failure as LlmError).message).not.toContain(key)
      expect((failure as LlmError).failure.message).not.toContain(key)
    } finally {
      await api.close()
    }
  })
})

describe('DeepSeek HTTP classification, status first', () => {
  const json = (message: string, extra: Record<string, string> = {}) => JSON.stringify({ error: { message, type: 'invalid_request_error', ...extra } })

  it('reads a 5xx as SERVER whatever its page says, and QUOTA only from a 402 or a 429 whose code names it', () => {
    // A load balancer's 503 page that happens to say "balance" is an outage, not an empty wallet.
    expect(classifyHttp(503, 'no healthy upstream behind the load balancer', new Headers()).code).toBe('SERVER')
    expect(classifyHttp(502, 'upstream connect error: balancer', new Headers()).code).toBe('SERVER')
    expect(classifyHttp(402, json('Insufficient Balance'), new Headers()).code).toBe('QUOTA')
    expect(classifyHttp(429, json('Rate limit reached', { type: 'rate_limit_error' }), new Headers()).code).toBe('RATE_LIMIT')
    expect(classifyHttp(429, json('You exceeded your current quota', { code: 'insufficient_quota' }), new Headers()).code).toBe('QUOTA')
    // Prose that mentions a quota under a rate-limit type is still a rate limit: the code or type decides, never the message.
    expect(classifyHttp(429, json('per-minute quota of requests reached', { type: 'rate_limit_error' }), new Headers()).code).toBe('RATE_LIMIT')
  })

  it('reads CONTEXT_WINDOW_EXCEEDED only from the overflow phrase or its code, never from "context" or "maximum" alone', () => {
    expect(classifyHttp(400, json("This model's maximum context length is 1048576 tokens. However, you requested 1100000 tokens."), new Headers()).code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(classifyHttp(400, json('too big', { code: 'context_length_exceeded' }), new Headers()).code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // Each of these once authorized a real compaction of the session, then a retry of the same invalid request.
    expect(classifyHttp(400, json('the maximum number of tools is 128'), new Headers()).code).toBe('INVALID_REQUEST')
    expect(classifyHttp(400, json('tool_call context id mismatch'), new Headers()).code).toBe('INVALID_REQUEST')
    expect(classifyHttp(400, json('the description is too long'), new Headers()).code).toBe('INVALID_REQUEST')
  })
})

describe('DeepSeek finish reasons and tool-call indices', () => {
  it('maps insufficient_system_resource to a retryable SERVER and content_filter to REFUSAL', () => {
    const shed = new DeepSeekTranslator()
    shed.push({ choices: [{ delta: { content: 'part' } }] })
    shed.push({ choices: [{ finish_reason: 'insufficient_system_resource' }] })
    expect(shed.finalize().at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: expect.any(String), code: 'SERVER' } } })
    const filtered = new DeepSeekTranslator()
    filtered.push({ choices: [{ delta: { content: 'part' } }] })
    filtered.push({ choices: [{ finish_reason: 'content_filter' }] })
    expect(filtered.finalize().at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: expect.any(String), code: 'REFUSAL' } } })
  })

  it('opens a second call when a new id arrives on a wire index already used, rather than splicing two calls into one', () => {
    const translator = new DeepSeekTranslator()
    const chunks: StreamChunk[] = []
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"p":1}' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'read', arguments: '{"p":2}' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ finish_reason: 'tool_calls' }] }))
    chunks.push(...translator.finalize())
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: asCallId('c1'), name: 'read', arguments: '{"p":1}' },
      { type: 'tool-call', id: asCallId('c2'), name: 'read', arguments: '{"p":2}' },
    ])
  })

  // The S20.5 review: a proxy that sends an empty or null id on continuation
  // deltas had each delta opened as a call of its own, then dropped nameless.
  it('reads an empty or null id on a continuation delta as more of the same call', () => {
    const translator = new DeepSeekTranslator()
    const chunks: StreamChunk[] = []
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"p":' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { arguments: '1' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: null as unknown as string, function: { arguments: '}' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ finish_reason: 'tool_calls' }] }))
    chunks.push(...translator.finalize())
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: asCallId('c1'), name: 'read', arguments: '{"p":1}' }])
  })

  // The name beside that id had kept the old test: anything but `undefined`
  // replaced it, so the same proxies renamed the call to '' or null.
  it('reads an empty or null name on a continuation delta as more of the same call, never as its new name', () => {
    const translator = new DeepSeekTranslator()
    const chunks: StreamChunk[] = []
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"p":' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '1' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '}' } }] } }] }))
    chunks.push(...translator.push({ choices: [{ finish_reason: 'tool_calls' }] }))
    chunks.push(...translator.finalize())
    // Every delta of the call names it as the first one did.
    expect(chunks.flatMap((chunk) => (chunk.type === 'tool-call-delta' ? [chunk.name] : []))).toEqual(['read', 'read', 'read'])
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: asCallId('c1'), name: 'read', arguments: '{"p":1}' }])
  })
})

// ---- S22.5: what the stream loop does with a cut, a failure it yields, a dead socket and an image ----

/** A loopback API that keeps each request's JSON body; `respond` writes the answer. */
async function capturing(respond: (response: ServerResponse) => void): Promise<{ baseURL: string; bodies: Record<string, unknown>[]; close: () => Promise<void> }> {
  const bodies: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      respond(response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
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

describe('DeepSeek stream loop', () => {
  let closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const close of closers) await close()
    closers = []
  })
  const KEY = 'sk-ECHOED-IN-STREAM-42'
  const adapterAt = (baseURL: string, attachments?: Attachments): DeepSeekAdapter =>
    new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => KEY, baseURL, defaultMaxTokens: 16, ...(attachments ? { resolveAttachments: () => attachments } : {}) })
  const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({ provider: 'deepseek', model: 'deepseek-flash', messages: [createUserMessage('hi')], ...over })
  const answering = (body: string) => (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(body)
  }
  const OK = 'data: {"choices":[{"delta":{"content":"a dot"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

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

  it('fails a body cut in the middle of an event as the retryable STREAM_CLOSED, never MALFORMED_RESPONSE', async () => {
    const api = await capturing(answering('data: {"choices":[{"delta":{"content":"whole "}}]}\n\ndata: {"choices":[{"delta":{"content":"par'))
    closers.push(api.close)
    const { chunks, failure } = await drain(adapterAt(api.baseURL).stream(request()))
    expect(failure).toMatchObject({ code: 'STREAM_CLOSED' })
    expect(RETRYABLE_CODES.has(failure!.code)).toBe(true)
    // What arrived whole was streamed; the half event was never read as one.
    expect(chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []))).toEqual(['whole '])
  })

  // The stream's own failure is YIELDED, so it never passes the catch that
  // redacts what is thrown: here a finish_reason, which is provider text.
  it('never quotes the key in a failure the stream itself reports', async () => {
    const api = await capturing(answering(`data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[{"finish_reason":"rejected ${KEY}"}]}\n\ndata: [DONE]\n\n`))
    closers.push(api.close)
    const { chunks, failure } = await drain(adapterAt(api.baseURL).stream(request()))
    expect(failure).toBeUndefined()
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } } })
    expect(JSON.stringify(finish)).not.toContain(KEY)
    expect(JSON.stringify(finish)).toContain('unexpected finish_reason \\"rejected [redacted]\\"')
  })

  // `fetch failed` alone reads the same offline, behind a mistyped base URL
  // and behind a proxy that refused: the reason is on the error's cause.
  it('says why a fetch failed, from the cause Node attached, with the key still redacted', async () => {
    // A real refused connection: a port that was listening a moment ago.
    const gone = await capturing(answering(OK))
    await gone.close()
    const refused = await drain(adapterAt(gone.baseURL).stream(request()))
    expect(refused.failure).toMatchObject({ code: 'TRANSPORT' })
    expect(refused.failure!.message).toContain(`ECONNREFUSED 127.0.0.1:${new URL(gone.baseURL).port}`)

    // The other shapes Node gives a cause, staged: one error per address, a
    // cause with a code and no words, and one that echoes the key.
    const shapes: [cause: unknown, expected: string][] = [
      [Object.assign(new Error('getaddrinfo ENOTFOUND api.deepseek.invalid'), { code: 'ENOTFOUND' }), 'fetch failed (getaddrinfo ENOTFOUND api.deepseek.invalid)'],
      [Object.assign(new AggregateError([new Error('connect ECONNREFUSED ::1:8080'), new Error('connect ECONNREFUSED 127.0.0.1:8080')], ''), { code: 'ECONNREFUSED' }), 'fetch failed (connect ECONNREFUSED ::1:8080; connect ECONNREFUSED 127.0.0.1:8080)'],
      [Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' }), 'fetch failed (UND_ERR_CONNECT_TIMEOUT)'],
      [new Error(`proxy refused the tunnel for Bearer ${KEY}`), 'fetch failed (proxy refused the tunnel for Bearer [redacted])'],
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
  // of the images the request carries.
  it('refuses an option before it reads a single image', async () => {
    const watched = watchingStore()
    const refused = await drain(adapterAt('http://127.0.0.1:9', watched.store).stream(request({ messages: [userWithImage('look')], reasoningEffort: 'medium' })))
    expect(refused.failure).toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(watched.reads()).toEqual([])
  })

  // Substitute at projection: `deepseek-v4-pro` accepts an image block and
  // ignores it without a word, so whether one is sent is this catalog's call.
  it('never reads an image for a text-only model, and sends its stored descriptor instead', async () => {
    const api = await capturing(answering(OK))
    closers.push(api.close)
    const watched = watchingStore()
    const adapter = adapterAt(api.baseURL, watched.store)
    const textOnly = await drain(adapter.stream(request({ model: 'deepseek-v4-pro', messages: [userWithImage('what is it?')] })))
    expect(textOnly.failure).toBeUndefined()
    expect(watched.reads()).toEqual([])
    expect(api.bodies[0]!.messages).toEqual([{ role: 'user', content: `what is it?${imageDescriptor(REF)}` }])
    // The same history on the vision row reads the bytes and sends them.
    await drain(adapter.stream(request({ messages: [userWithImage('what is it?')] })))
    expect(watched.reads()).toEqual([REF.id])
    expect(api.bodies[1]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'what is it?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(BYTES).toString('base64')}` } }] },
    ])
  })
})

describe('DeepSeek row contract', () => {
  const saved = process.env.DEEPSEEK_BASE_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.DEEPSEEK_BASE_URL
    else process.env.DEEPSEEK_BASE_URL = saved
  })

  it('refuses a base URL carrying user info, from config or from the environment, without quoting the password', async () => {
    expect(() => deepseekPlugin.config!.parse({ baseURL: 'https://proxyuser:proxy-PASSWORD-123@proxy.example' })).toThrow()
    expect(() => deepseekPlugin.config!.parse({ baseURL: 'https://proxy.example/deepseek' })).not.toThrow()
    process.env.DEEPSEEK_BASE_URL = 'https://proxyuser:proxy-PASSWORD-123@proxy.example'
    const root = createRoot({ logger: { warn: () => {}, error: () => {} } })
    root.plugin(llmPlugin)
    root.plugin(credentialsLocalPlugin)
    const handle = root.plugin(deepseekPlugin)
    const report = await root.settle()
    expect(handle.state).toBe('failed')
    const said = report.failed.map((entry) => String(entry.error)).join('\n')
    expect(said).toMatch(/DEEPSEEK_BASE_URL/)
    expect(said).not.toContain('proxy-PASSWORD-123')
    await root.dispose()
  })
})
