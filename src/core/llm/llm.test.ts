import { describe, expect, it } from 'vitest'
import { createRoot, type Logger } from '../../kernel/index.ts'
import { ScriptedAdapter, assistantText } from '../../test-support/scripted-adapter.ts'
import { asCallId } from '../ids.ts'
import { BlockAssembler } from './assembler.ts'
import { LLM, LLM_STREAM, llmPlugin } from './runtime.ts'
import { LlmError, type LlmRequest, type StreamChunk } from './types.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return { provider: 'scripted', model: 'scripted-model', messages: [], ...over }
}

async function harness() {
  const root = createRoot({ logger: silent })
  root.plugin(llmPlugin)
  await root.settle()
  return { root, llm: root.get(LLM) }
}

describe('BlockAssembler', () => {
  it('assembles text and tool-call blocks from deltas and prefers block-end', () => {
    const asm = new BlockAssembler()
    for (const chunk of assistantText('hello world')) asm.push(chunk)
    expect(asm.blocks()).toEqual([{ type: 'text', text: 'hello world' }])
    expect(asm.finish).toEqual({ kind: 'stop' })
    expect(asm.usage?.outputTokens).toBe(5)
  })

  it('concatenates tool-call argument fragments and caches id/name from the first fragment', () => {
    const asm = new BlockAssembler()
    const id = asCallId('c1')
    asm.push({ type: 'block-start', index: 0, blockType: 'tool-call' })
    asm.push({ type: 'tool-call-delta', index: 0, id, name: 'edit', argumentsDelta: '{"path":' })
    asm.push({ type: 'tool-call-delta', index: 0, argumentsDelta: '"a.txt"}' })
    asm.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(asm.blocks()).toEqual([{ type: 'tool-call', id, name: 'edit', arguments: '{"path":"a.txt"}' }])
  })

  it('drops incomplete tool-call blocks on a max-tokens finish', () => {
    const asm = new BlockAssembler()
    asm.push({ type: 'tool-call-delta', index: 0, id: asCallId('c1'), name: 'edit', argumentsDelta: '{' })
    asm.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(asm.blocks()).toEqual([])
  })

  it('treats empty tool-call arguments as {}', () => {
    const asm = new BlockAssembler()
    asm.push({ type: 'tool-call-delta', index: 0, id: asCallId('c1'), name: 'noop', argumentsDelta: '' })
    asm.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(asm.blocks()).toEqual([{ type: 'tool-call', id: asCallId('c1'), name: 'noop', arguments: '{}' }])
  })
})

describe('LlmRuntime', () => {
  it('streams through a registered adapter', async () => {
    const { root, llm } = await harness()
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    llm.registerAdapter(root, adapter)
    const chunks = await collect(llm.stream(request()))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(adapter.calls).toHaveLength(1)
  })

  it('rejects a duplicate adapter for the same provider', async () => {
    const { root, llm } = await harness()
    llm.registerAdapter(root, new ScriptedAdapter())
    expect(() => llm.registerAdapter(root, new ScriptedAdapter())).toThrowError(LlmError)
  })

  it('unregisters an adapter when its owning context disposes', async () => {
    const { root, llm } = await harness()
    const child = root.child({ label: 'owner' })
    llm.registerAdapter(child, new ScriptedAdapter())
    expect(llm.hasProvider('scripted')).toBe(true)
    await child.dispose()
    expect(llm.hasProvider('scripted')).toBe(false)
  })

  it('normalizes an adapter throw into a terminal error finish', async () => {
    const { root, llm } = await harness()
    const adapter: ScriptedAdapter = new ScriptedAdapter()
    adapter.script(() => {
      throw new LlmError('SERVER', 'upstream 500', { status: 500 })
    })
    llm.registerAdapter(root, adapter)
    const chunks = await collect(llm.stream(request()))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 500', code: 'SERVER', status: 500 } } }])
  })

  it('normalizes an aborted stream into a terminal aborted finish', async () => {
    const { root, llm } = await harness()
    const controller = new AbortController()
    const adapter = new ScriptedAdapter().script(() => {
      controller.abort()
      throw new LlmError('ABORTED', 'cancelled')
    })
    llm.registerAdapter(root, adapter)
    const chunks = await collect(llm.stream(request({ signal: controller.signal })))
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('yields a NO_ADAPTER error finish when the provider is unregistered', async () => {
    const { llm } = await harness()
    const chunks = await collect(llm.stream(request({ provider: 'ghost' })))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'error', failure: { message: expect.stringContaining('ghost'), code: 'NO_ADAPTER' } } }])
  })

  it('lets llm/stream middleware wrap the adapter stream', async () => {
    const { root, llm } = await harness()
    llm.registerAdapter(root, new ScriptedAdapter().script(assistantText('inner')))
    const seen: string[] = []
    root.on(LLM_STREAM, (req, next) => {
      seen.push(`before:${req.provider}`)
      return next()
    })
    const chunks = await collect(llm.stream(request()))
    expect(seen).toEqual(['before:scripted'])
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })

  it('enforces the stream protocol: exactly one finish, nothing after it', async () => {
    const { root, llm } = await harness()
    llm.registerAdapter(
      root,
      new ScriptedAdapter().script([
        { type: 'finish', reason: { kind: 'stop' } },
        { type: 'text-delta', index: 0, text: 'late' },
      ]),
    )
    await expect(collect(llm.stream(request()))).rejects.toThrowError(/after finish/)
  })

  it('enforces the stream protocol: a stream must end with a finish', async () => {
    const { root, llm } = await harness()
    llm.registerAdapter(root, new ScriptedAdapter().script([{ type: 'text-delta', index: 0, text: 'x' }]))
    await expect(collect(llm.stream(request()))).rejects.toThrowError(/without a finish/)
  })

  it('resolves adapter-owned model facts', async () => {
    const { root, llm } = await harness()
    llm.registerAdapter(root, new ScriptedAdapter())
    expect(llm.resolveModel('scripted', 'scripted-model').reasoning.efforts).toContain('high')
    expect(() => llm.resolveModel('ghost', 'm')).toThrowError(LlmError)
  })
})
