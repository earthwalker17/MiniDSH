/**
 * Permanent regressions for the Session 1 adversarial review. Each test fails
 * against the code as it was before the corresponding fix.
 */
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Logger, type Plugin } from '../../kernel/index.ts'
import { serviceKey } from '../../kernel/index.ts'
import { AGENTS } from '../agent/index.ts'
import { asCallId } from '../ids.ts'
import { createUserMessage } from '../llm/message.ts'
import { LLM, LlmError } from '../llm/index.ts'
import { defineTool, TOOLS } from '../tools/index.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('review regressions: cancellation', () => {
  it('never persists an assistant message whose tool calls have no results', async () => {
    harness = await coreHarness()
    const hang = defineTool({
      name: 'hang',
      description: 'waits for abort',
      input: z.object({}),
      output: z.object({}),
      execute: (_args, exec) =>
        new Promise((_resolve, reject) => exec.signal.addEventListener('abort', () => reject(new Error('aborted')))),
      render: () => [{ type: 'text', text: 'never' }],
    })
    harness.root.get(TOOLS).register(harness.root, hang)
    harness.adapter.script(assistantToolCall('c1', 'hang', {}))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await waitFor(() => agent.session.events.some((event) => event.type === 'tool/call'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    // Every tool-call block in derived history must have a matching tool result.
    const messages = agent.session.deriveMessages()
    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'tool-call') callIds.add(block.id)
        if (block.type === 'tool-result') resultIds.add(block.toolCallId)
      }
    }
    for (const id of callIds) expect(resultIds.has(id)).toBe(true)
  })

  it('reports a cancellation during request-error recovery as cancelled, not error', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const { AGENT_REQUEST_ERROR } = await import('../agent/index.ts')
    harness.adapter.script(() => {
      throw new LlmError('SERVER', 'boom')
    })
    agent.ctx.on(AGENT_REQUEST_ERROR, async (context, next) => {
      await next()
      // A recovery policy that is interrupted by the user mid-backoff.
      agent.cancel({ kind: 'user' })
      void context
      return undefined
    })
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    const turnEnd = agent.session.events.at(-1)!
    expect((turnEnd.data as { reason: { kind: string } }).reason.kind).toBe('cancelled')
  })

  /**
   * S5 design verification. A recovery listener may legally change the log —
   * this is exactly what a compaction answering `CONTEXT_WINDOW_EXCEEDED`
   * does. Before the driver built its request per ATTEMPT rather than per step,
   * the retry re-sent the frozen message list and the turn died on
   * "request messages diverge from deriveMessages()".
   */
  it('re-derives the request for a retried attempt, so a recovery that shadowed history is reflected', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const { AGENT_REQUEST_ERROR } = await import('../agent/index.ts')
    const { USER_MESSAGE } = await import('../session/index.ts')
    const { createPluginMessage } = await import('../llm/message.ts')

    // Turn 1 succeeds, leaving two surface nodes to shadow.
    harness.adapter.script(assistantText('first answer'))
    agent.followup(createUserMessage('hello'))
    await agent.whenIdle()
    const shadowed = agent.session.surfaceSeqs().slice(0, 2)

    // Turn 2's first attempt overflows; the listener compacts, then retries.
    harness.adapter.script(
      () => {
        throw new LlmError('CONTEXT_WINDOW_EXCEEDED', 'context size has been exceeded')
      },
      assistantText('second answer'),
    )
    let compacted = false
    agent.ctx.on(AGENT_REQUEST_ERROR, async (context, next) => {
      const prior = await next()
      if (prior || compacted || context.failure.code !== 'CONTEXT_WINDOW_EXCEEDED') return prior
      compacted = true
      agent.session.append(
        USER_MESSAGE,
        { message: createPluginMessage('test-compactor', 'summary of the earlier exchange', 'summary') },
        { surfaceOp: { op: 'replace', start: shadowed[0]!, end: shadowed[1]! }, sourceEventSeqs: [...shadowed] },
      )
      return { kind: 'retry' }
    })
    agent.followup(createUserMessage('again'))
    await agent.whenIdle()

    expect(compacted).toBe(true)
    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends.map((event) => (event.data as { reason: { kind: string } }).reason.kind)).toEqual(['completed', 'completed'])

    // The retried attempt was sent the COMPACTED history, not the frozen one:
    // three messages went out, two came back after the replace shadowed a pair.
    const [, overflowed, retried] = harness.adapter.calls
    expect(overflowed!.messages).toHaveLength(3)
    expect(retried!.messages).toHaveLength(2)
    expect(retried!.messages[0]!.source).toMatchObject({ kind: 'plugin', plugin: 'test-compactor', form: 'summary' })
    // And the log kept everything it shadowed: the nodes are gone from the
    // surface, not from history.
    for (const seq of shadowed) expect(agent.session.events[seq]).toBeDefined()
    expect(agent.session.surfaceSeqs()).not.toContain(shadowed[0])
    expect(agent.session.surfaceSeqs()).not.toContain(shadowed[1])
  })
})

describe('S5.5 regressions: the reconstruction invariant cannot be ordered behind', () => {
  /**
   * `prepend` is an unshift, so the LAST prepended listener runs first: a
   * short-circuiting `llm/stream` middleware registered after the invariant used
   * to send a request the invariant never saw. The invariant is now an observer,
   * which runs in the dispatch preflight before any listener is selected.
   */
  it('trips on a divergent loop request even when a later prepend:true listener short-circuits the stream', async () => {
    harness = await coreHarness()
    const { LLM_STREAM } = await import('../llm/index.ts')
    const { markLoopRequest } = await import('./marker.ts')
    const { agent } = await harness.create()
    // Registered AFTER the invariant and prepended: with a listener-based
    // invariant this ran first and answered the stream itself.
    let rogue = 0
    harness.root.on(
      LLM_STREAM,
      () => {
        rogue += 1
        return harness!.adapter.stream({ provider: 'scripted', model: 'scripted-model', messages: [] })
      },
      { prepend: true, global: true },
    )
    harness.adapter.script(assistantText('rogue'))
    // A loop-marked request whose messages are not what the log derives.
    const request = Object.freeze({ provider: 'scripted', model: 'scripted-model', system: '', tools: [], messages: [createUserMessage('not in the log')] })
    markLoopRequest(request, agent.session)
    expect(() => harness!.root.get(LLM).stream(request)).toThrowError(/diverge/)
    expect(rogue).toBe(0)
  })
})

describe('review regressions: seeded sessions', () => {
  it('continues turn numbering over a forked session instead of restarting at 1', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('first'), assistantText('second'))
    const first = await harness.create()
    first.agent.followup(createUserMessage('hi'))
    await first.agent.whenIdle()
    // The fork seed becomes a NEW agent's session with lineage in its header.
    const seed = first.agent.session.forkSeed()

    const handle = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      seed,
      parentId: first.agent.session.id,
      seedLength: seed.length,
    })
    handle.agent.followup(createUserMessage('again'))
    await handle.agent.whenIdle()
    const turnNumbers = handle.agent.session.events
      .filter((event) => event.type === 'turn/start')
      .map((event) => (event.data as { turn: number }).turn)
    expect(new Set(turnNumbers).size).toBe(turnNumbers.length) // no duplicates
    expect(turnNumbers.at(-1)).toBe(2)
    await handle.dispose()
  })
})

describe('S5.5 regressions: durability is a checkpoint before every action', () => {
  /**
   * A dropped durable write used to surface only at turn-end flush, so every
   * tool effect in the rest of the turn ran with no durable record. The driver
   * now checkpoints before each model request and each tool dispatch.
   */
  it('ends the turn as DURABILITY_LOST before the next effect once a write is lost, with the surface still balanced', async () => {
    harness = await coreHarness()
    const { SESSION_EVENT, SESSION_FLUSH } = await import('../session/index.ts')
    const ran: string[] = []
    const tool = defineTool({
      name: 'effect',
      description: 'an effect',
      input: z.object({ n: z.number() }),
      output: z.object({}),
      execute: (args) => {
        ran.push(`effect-${args.n}`)
        return {}
      },
      render: () => [{ type: 'text', text: 'done' }],
    })
    harness.root.get(TOOLS).register(harness.root, tool)
    // A provider that loses the write of the first tool/call record.
    let lost = false
    harness.root.on(SESSION_EVENT, (_session, event) => {
      if (event.type === 'tool/call') lost = true
    })
    harness.root.on(SESSION_FLUSH, () => {
      if (lost) throw new Error('disk gone')
    })
    harness.adapter.script(
      [
        { type: 'tool-call-delta', index: 0, id: asCallId('c1'), name: 'effect', argumentsDelta: '{"n":1}' },
        { type: 'tool-call-delta', index: 1, id: asCallId('c2'), name: 'effect', argumentsDelta: '{"n":2}' },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      assistantText('never sent'),
    )
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()

    expect(ran).toEqual([]) // no effect followed the lost write
    const turnEnd = agent.session.events.findLast((event) => event.type === 'turn/end')!
    expect((turnEnd.data as { reason: { kind: string; code?: string } }).reason).toMatchObject({ kind: 'error', code: 'DURABILITY_LOST' })
    // Both calls were answered, so no reader sees an assistant message with dangling tool calls.
    const results = agent.session.events.filter((event) => event.type === 'tool/result').map((event) => (event.data as { callId: string; error?: { code: string } }))
    expect(results.map((result) => `${result.callId}:${result.error?.code}`)).toEqual(['c1:DURABILITY_LOST', 'c2:DURABILITY_LOST'])
    expect(harness.adapter.calls).toHaveLength(1) // and no second request was paid for
  })
})

describe('review regressions: driver containment', () => {
  it('contains a rejecting session/flush listener instead of an unhandled rejection', async () => {
    harness = await coreHarness()
    const { SESSION_FLUSH } = await import('../session/index.ts')
    harness.root.on(SESSION_FLUSH, () => {
      throw new Error('durability failure')
    })
    harness.adapter.script(assistantText('ok'))
    const { agent } = await harness.create()
    const errors: unknown[] = []
    const { AGENT_ERROR } = await import('../agent/index.ts')
    agent.ctx.on(AGENT_ERROR, (_agent, error) => void errors.push(error))
    agent.followup(createUserMessage('hi'))
    await expect(agent.whenIdle()).resolves.toBeUndefined()
    expect(agent.status).toBe('idle')
    // Reported (the checkpoint before the request, then the turn-boundary
    // flush), never thrown unobserved — and the request was never sent.
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(harness.adapter.calls).toHaveLength(0)
  })
})

describe('review regressions: kernel', () => {
  it('reloads a failed plugin when its provider is replaced', async () => {
    const KEY = serviceKey<{ ok: boolean }>('flaky')
    const root = createRoot({ logger: silent })
    const loads: boolean[] = []
    const dependent: Plugin = {
      name: 'dependent',
      inject: [KEY],
      apply(ctx) {
        const value = ctx.get(KEY)
        loads.push(value.ok)
        if (!value.ok) throw new Error('bad provider')
      },
    }
    const bad = root.plugin({ name: 'bad', apply: (ctx) => void ctx.provide(KEY, { ok: false }) })
    const handle = root.plugin(dependent)
    await root.settle()
    expect(handle.state).toBe('failed')

    await bad.dispose()
    root.plugin({ name: 'good', apply: (ctx) => void ctx.provide(KEY, { ok: true }) })
    await root.settle()
    expect(handle.state).toBe('active')
    expect(loads).toEqual([false, true])
    await root.dispose()
  })
})

describe('review regressions: stream protocol', () => {
  it('rejects a delta addressing a closed block', async () => {
    const root = createRoot({ logger: silent })
    const { llmPlugin } = await import('../llm/index.ts')
    root.plugin(llmPlugin)
    await root.settle()
    const llm = root.get(LLM)
    llm.registerAdapter(
      root,
      new ScriptedAdapter().script([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
        { type: 'text-delta', index: 0, text: 'late' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    )
    const consume = async (): Promise<void> => {
      for await (const _chunk of llm.stream({ provider: 'scripted', model: 'm', messages: [] })) void _chunk
    }
    await expect(consume()).rejects.toThrowError(/closed block/)
    await root.dispose()
  })

  it('rejects a delta whose type does not match its block', async () => {
    const root = createRoot({ logger: silent })
    const { llmPlugin } = await import('../llm/index.ts')
    root.plugin(llmPlugin)
    await root.settle()
    const llm = root.get(LLM)
    llm.registerAdapter(
      root,
      new ScriptedAdapter().script([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'tool-call-delta', index: 0, id: asCallId('c'), name: 'x', argumentsDelta: '{}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    )
    const consume = async (): Promise<void> => {
      for await (const _chunk of llm.stream({ provider: 'scripted', model: 'm', messages: [] })) void _chunk
    }
    await expect(consume()).rejects.toThrowError(/of type "text"/)
    await root.dispose()
  })
})
