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
  it('assembles a text block from deltas, and prefers the block-end form when it differs', () => {
    const asm = new BlockAssembler()
    for (const chunk of assistantText('hello world')) asm.push(chunk)
    expect(asm.blocks()).toEqual([{ type: 'text', text: 'hello world' }])
    expect(asm.finish).toEqual({ kind: 'stop' })
    expect(asm.usage?.outputTokens).toBe(5)

    // A block-end that disagrees with the folded deltas wins: it is the
    // provider's finalized form, and the deltas were only its stream.
    const finalized = new BlockAssembler()
    finalized.push({ type: 'block-start', index: 0, blockType: 'text' })
    finalized.push({ type: 'text-delta', index: 0, text: 'hel' })
    finalized.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } })
    finalized.push({ type: 'finish', reason: { kind: 'stop' } })
    expect(finalized.blocks()).toEqual([{ type: 'text', text: 'hello' }])
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

  it('refuses an adapter registered from a scoped context: the registry is deployment-global', async () => {
    const { root, llm } = await harness()
    const scoped = root.child({ scope: { id: 'agent' } })
    expect(() => llm.registerAdapter(scoped, new ScriptedAdapter())).toThrowError(/deployment-global/)
    expect(llm.hasProvider('scripted')).toBe(false)
    // An unscoped child (a label-only owner) is still a legal owner.
    llm.registerAdapter(root.child({ label: 'owner' }), new ScriptedAdapter())
    expect(llm.hasProvider('scripted')).toBe(true)
  })

  it('lists registered providers with their advertised models', async () => {
    const { root, llm } = await harness()
    expect(llm.providers()).toEqual([])
    llm.registerAdapter(root, new ScriptedAdapter())
    const catalog = llm.providers()
    expect(catalog).toHaveLength(1)
    expect(catalog[0]!.id).toBe('scripted')
    // The adapter's own facts plus the window `resolveModel` enriches it with (`core/llm/runtime.ts`).
    expect(catalog[0]!.models).toHaveLength(1)
    expect(catalog[0]!.models[0]).toMatchObject({ id: 'scripted-model', name: 'Scripted Model', contextWindow: 100_000 })
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

  /**
   * The block and usage rules: the one place a malformed adapter (or
   * middleware) stream is stopped before the driver records it. Each stream
   * below breaks exactly one rule, and is otherwise a stream the seam accepts.
   */
  it('enforces the stream protocol: blocks are opened once, addressed while open and by their own type, and usage is reported once', async () => {
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const text = (index: number): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text: 'x' },
      { type: 'block-end', index, block: { type: 'text', text: 'x' } },
    ]
    const streams: [rule: string, chunks: StreamChunk[], refusal: string][] = [
      ['a delta after its block closed', [...text(0), { type: 'text-delta', index: 0, text: 'late' }, finish], '"text-delta" addresses closed block 0'],
      ['a delta of another type than its block', [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'reasoning-delta', index: 0, text: 'x' }, finish], '"reasoning-delta" addresses block 0 of type "text"'],
      ['a delta of another type than the delta that opened its block', [{ type: 'text-delta', index: 0, text: 'x' }, { type: 'tool-call-delta', index: 0, argumentsDelta: '{}' }, finish], '"tool-call-delta" addresses block 0 of type "text"'],
      ['an open block opened again', [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-start', index: 0, blockType: 'text' }, finish], 'block index 0 opened twice'],
      ['a closed block opened again', [...text(0), { type: 'block-start', index: 0, blockType: 'reasoning' }, finish], 'block index 0 opened twice'],
      ['usage twice', [...text(0), usage, usage, finish], 'usage reported twice'],
    ]
    const outcomes: Record<string, string> = {}
    for (const [rule, chunks] of streams) {
      const { root, llm } = await harness()
      llm.registerAdapter(root, new ScriptedAdapter().script(chunks))
      outcomes[rule] = await collect(llm.stream(request())).then(
        (seen) => `accepted ${seen.length} chunks`,
        (error: unknown) => (error instanceof LlmError ? `${error.code}: ${error.message}` : `threw ${String(error)}`),
      )
      await root.dispose()
    }
    expect(outcomes).toEqual(Object.fromEntries(streams.map(([rule, , refusal]) => [rule, `PROTOCOL_VIOLATION: ${refusal}`])))

    // The control: the same pieces in a legal order, two blocks and one usage, pass whole.
    const { root, llm } = await harness()
    const legal = [...text(0), ...text(1), usage, finish]
    llm.registerAdapter(root, new ScriptedAdapter().script(legal))
    expect(await collect(llm.stream(request()))).toEqual(legal)
    await root.dispose()
  })

  // An adapter that throws is normalized into a terminal finish, never an
  // unfinished stream. What it threw decides the code: its own `LlmError`
  // keeps its failure; anything else is a transport failure, unless the
  // request was cancelled, which is what the turn must then end as.
  it('turns an adapter throw into a terminal finish: its own code, TRANSPORT for a plain error, aborted under a cancelled signal', async () => {
    const controller = new AbortController()
    const cases: [name: string, thrown: () => unknown, signal: AbortSignal | undefined][] = [
      ['an LlmError', () => new LlmError('RATE_LIMIT', 'slow down', { status: 429 }), undefined],
      ['a plain Error', () => new Error('socket hang up'), undefined],
      ['a thrown string', () => 'no error object at all', undefined],
      ['a plain Error under an aborted signal', () => new Error('the body was cut'), controller.signal],
    ]
    const finishes: Record<string, unknown> = {}
    for (const [name, thrown, signal] of cases) {
      const { root, llm } = await harness()
      llm.registerAdapter(
        root,
        new ScriptedAdapter().script(() => {
          // Aborted INSIDE the adapter: an already-aborted request never reaches it.
          if (signal !== undefined) controller.abort()
          throw thrown()
        }),
      )
      const chunks = await collect(llm.stream(request(signal === undefined ? {} : { signal })))
      finishes[name] = chunks.map((chunk) => (chunk.type === 'finish' ? chunk.reason : chunk.type))
      await root.dispose()
    }
    expect(finishes).toEqual({
      'an LlmError': [{ kind: 'error', failure: { message: 'slow down', code: 'RATE_LIMIT', status: 429 } }],
      'a plain Error': [{ kind: 'error', failure: { message: 'socket hang up', code: 'TRANSPORT' } }],
      'a thrown string': [{ kind: 'error', failure: { message: 'no error object at all', code: 'TRANSPORT' } }],
      'a plain Error under an aborted signal': [{ kind: 'aborted', failure: { message: 'the body was cut', code: 'ABORTED' } }],
    })
  })

  /**
   * An image is user- and tool-side only, and the refusal has to live HERE.
   *
   * The driver appends `assistant/chunk` to the log and only then pushes the
   * chunk to `BlockAssembler`, so a refusal in the assembler would arrive one
   * line after the durable record it exists to prevent — and would leave a log
   * that can never be replayed, because the replay script hands the same chunks
   * back and it would throw again on every run. `validateStream` runs before the
   * driver sees a chunk at all.
   */
  it('refuses an assistant stream that opens an image block, before the driver could record it', async () => {
    const { root, llm } = await harness()
    llm.registerAdapter(root, new ScriptedAdapter().script([{ type: 'block-start', index: 0, blockType: 'image' }, { type: 'finish', reason: { kind: 'stop' } }]))
    await expect(collect(llm.stream(request()))).rejects.toThrowError(/may not open a "image" block/)
  })

  it('refuses an assistant stream that ends an image block', async () => {
    const { root, llm } = await harness()
    const ref = { id: 'sha256:x', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    llm.registerAdapter(
      root,
      new ScriptedAdapter().script([
        { type: 'block-end', index: 0, block: { type: 'image', attachment: ref as never, text: '[image]' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    )
    await expect(collect(llm.stream(request()))).rejects.toThrowError(/may not end a "image" block/)
  })

  /**
   * A cancellation landing between the request being built and the adapter
   * being entered is invisible to an adapter that only listens for the `abort`
   * event: on an already-aborted signal it never fires. Found live — a turn
   * hung forever at `llm.stream`, and the whole agent with it.
   */
  it('finishes a request whose signal was already aborted, without entering the adapter', async () => {
    const { root, llm } = await harness()
    const adapter = new ScriptedAdapter().script(
      (call) =>
        new Promise<StreamChunk[]>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(new LlmError('ABORTED', 'aborted')))
        }),
    )
    llm.registerAdapter(root, adapter)
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(llm.stream(request({ signal: controller.signal })))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted before the provider was called', code: 'ABORTED' } } }])
    // The adapter was never called, so it had nothing to hang on.
    expect(adapter.calls).toHaveLength(0)
  })

  it('resolves adapter-owned model facts', async () => {
    const { root, llm } = await harness()
    llm.registerAdapter(root, new ScriptedAdapter())
    expect(llm.resolveModel('scripted', 'scripted-model').reasoning.efforts).toContain('high')
    expect(() => llm.resolveModel('ghost', 'm')).toThrowError(LlmError)
  })
})

describe('replay state', () => {
  it('prunes the envelope in step with the blocks a max-tokens finish drops, and discards a misaligned one', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
    assembler.push({ type: 'reasoning-delta', index: 0, text: 'hm' })
    assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 1, text: 'partial' })
    assembler.push({ type: 'tool-call-delta', index: 2, id: asCallId('c1'), name: 'edit', argumentsDelta: '{"p' })
    assembler.push({ type: 'finish', reason: { kind: 'max-tokens' }, replayState: { response: { id: 'r1' }, blocks: [{ sig: 'a' }, null, { sig: 'c' }] } })
    // The truncated tool call is dropped, and so is its signature — nothing else moves.
    expect(assembler.blocks().map((block) => block.type)).toEqual(['reasoning', 'text'])
    expect(assembler.replayState).toEqual({ response: { id: 'r1' }, blocks: [{ sig: 'a' }, null] })

    const misaligned = new BlockAssembler()
    misaligned.push({ type: 'text-delta', index: 0, text: 'x' })
    misaligned.push({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'r', blocks: [1, 2] } })
    expect(misaligned.replayState).toBeUndefined()

    const whole = new BlockAssembler()
    whole.push({ type: 'text-delta', index: 0, text: 'x' })
    whole.push({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'r2' } } })
    expect(whole.replayState).toEqual({ response: { id: 'r2' } })
  })

  it('reaches only the provider that produced it: a foreign replay state is stripped before the adapter, the history untouched', async () => {
    const { root, llm } = await harness()
    const a = new ScriptedAdapter({ provider: 'a' }).script(assistantText('from a'))
    const b = new ScriptedAdapter({ provider: 'b' }).script(assistantText('from b'))
    llm.registerAdapter(root, a)
    llm.registerAdapter(root, b)
    const { createAssistantMessage, createUserMessage } = await import('./message.ts')
    const signed = createAssistantMessage([{ type: 'text', text: 'earlier' }], 'a', 'a-model', { response: { sig: 's' } })
    const messages = Object.freeze([createUserMessage('hi'), signed])
    await collect(llm.stream(request({ provider: 'a', model: 'a-model', messages })))
    await collect(llm.stream(request({ provider: 'b', model: 'b-model', messages })))
    // Its own provider sees the very same history (nothing to strip); the other sees the neutral message.
    expect(a.calls[0]!.messages).toBe(messages)
    expect((b.calls[0]!.messages[1]!.source as { replayState?: unknown }).replayState).toBeUndefined()
    expect(b.calls[0]!.messages[1]!.content).toEqual(signed.content)
    expect((messages[1]!.source as { replayState?: unknown }).replayState).toEqual({ response: { sig: 's' } })
  })
})
