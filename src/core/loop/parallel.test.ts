/**
 * S21: concurrency joined at the step. A step's calls whose tool declares
 * `concurrencySafe` overlap their BODIES behind one ordered lane; every other
 * call is a barrier; results commit in model order (ARCHITECTURE §6).
 *
 * Every interleaving here is forced with deferreds the test resolves, never
 * with timing: a test that passed because a timer happened to fire first would
 * say nothing about the order the executor guarantees.
 */
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { repairTail } from '../agent/index.ts'
import { asCallId } from '../ids.ts'
import { createUserMessage } from '../llm/message.ts'
import type { StreamChunk } from '../llm/index.ts'
import { SESSION_EVENT, SESSION_FLUSH, type EventEnvelope } from '../session/index.ts'
import { defineTool, TOOLS, TOOLS_EXECUTE, type ToolResult } from '../tools/index.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText } from '../../test-support/scripted-adapter.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** One assistant message calling each `[id, tool, n]` in order. */
function calls(...list: readonly (readonly [string, string, number])[]): StreamChunk[] {
  return [
    ...list.map(([id, name, n], index) => ({ type: 'tool-call-delta' as const, index, id: asCallId(id), name, argumentsDelta: JSON.stringify({ n }) })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * A concurrency-safe tool whose body for `n` waits on `gates[n]`, recording
 * when each body starts and ends, and how many run at once.
 */
function gatedTools(h: CoreHarness, options: { safe: boolean; name?: string }) {
  const gates = new Map<number, Deferred>()
  const gate = (n: number): Deferred => {
    let d = gates.get(n)
    if (!d) gates.set(n, (d = deferred()))
    return d
  }
  const trace: string[] = []
  const signals = new Map<number, AbortSignal>()
  let inFlight = 0
  let peak = 0
  h.root.get(TOOLS).register(
    h.root,
    defineTool({
      name: options.name ?? (options.safe ? 'safe' : 'plain'),
      description: 'waits for its gate',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      ...(options.safe ? { concurrencySafe: true as const, timeoutMs: null } : {}),
      execute: async (args, exec) => {
        trace.push(`start ${args.n}`)
        signals.set(args.n, exec.signal)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        try {
          await Promise.race([
            gate(args.n).promise,
            new Promise<void>((_resolve, reject) => exec.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
          ])
        } finally {
          inFlight -= 1
          trace.push(`end ${args.n}`)
        }
        return { n: args.n }
      },
      render: (_args, value) => [{ type: 'text', text: `done ${value.n}` }],
    }),
  )
  return { gate, trace, signals, peak: () => peak }
}

/** The step's call/dispatch/result records, as `type:callId`, in log order. */
function callRecords(events: readonly EventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'tool/call' || event.type === 'tool/dispatch' || event.type === 'tool/result')
    .map((event) => `${event.type.slice(5)}:${(event.data as { callId: string }).callId}`)
}

function results(events: readonly EventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'tool/result')
    .map((event) => {
      const data = event.data as { callId: string; error?: { code: string } }
      return `${data.callId}:${data.error?.code ?? 'ok'}`
    })
}

describe('S21: a step\'s concurrency-safe calls overlap, joined at the step', () => {
  it('overlaps the bodies and commits the results in model order, whatever order they finish in', async () => {
    harness = await coreHarness()
    const tool = gatedTools(harness, { safe: true })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2]), assistantText('both done'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await waitFor(() => tool.trace.includes('start 2'))
    // Both bodies run at once: the second started before the first ended.
    expect(tool.trace).toEqual(['start 1', 'start 2'])
    tool.gate(2).resolve()
    await waitFor(() => tool.trace.includes('end 2'))
    // The second FINISHED, but its result waits for the first: no result is logged yet.
    expect(results(agent.session.events)).toEqual([])
    tool.gate(1).resolve()
    await agent.whenIdle()
    expect(results(agent.session.events)).toEqual(['a:ok', 'b:ok'])
    // The lane: each call's dispatch before the next call is logged; results last, in order.
    expect(callRecords(agent.session.events)).toEqual(['call:a', 'dispatch:a', 'call:b', 'dispatch:b', 'result:a', 'result:b'])
    // Each result cites its own call.
    const callSeq = new Map(agent.session.events.filter((e) => e.type === 'tool/call').map((e) => [(e.data as { callId: string }).callId, e.seq]))
    for (const event of agent.session.events.filter((e) => e.type === 'tool/result')) {
      expect(event.sourceEventSeqs).toEqual([callSeq.get((event.data as { callId: string }).callId)])
    }
  })

  it('runs any other call as a barrier: logged only once every earlier result has committed, then alone', async () => {
    harness = await coreHarness()
    const safe = gatedTools(harness, { safe: true })
    const plain = gatedTools(harness, { safe: false })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2], ['c', 'plain', 3]), assistantText('done'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await waitFor(() => safe.trace.includes('start 2'))
    safe.gate(2).resolve()
    await waitFor(() => safe.trace.includes('end 2'))
    expect(plain.trace).toEqual([]) // the barrier has not even been logged
    expect(callRecords(agent.session.events)).not.toContain('call:c')
    safe.gate(1).resolve()
    await waitFor(() => plain.trace.includes('start 3'))
    plain.gate(3).resolve()
    await agent.whenIdle()
    expect(callRecords(agent.session.events)).toEqual(['call:a', 'dispatch:a', 'call:b', 'dispatch:b', 'result:a', 'result:b', 'call:c', 'dispatch:c', 'result:c'])
  })

  it('holds at most the agent\'s width in flight, and a width of 1 runs every call alone', async () => {
    harness = await coreHarness()
    const tool = gatedTools(harness, { safe: true })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2], ['c', 'safe', 3]), assistantText('done'))
    const { agent } = await harness.create({ maxParallelToolCalls: 2 })
    agent.followup(createUserMessage('go'))
    await waitFor(() => tool.trace.includes('start 2'))
    // The third waits for a slot, and is not even logged while it does: a
    // crash now reads it as never started, not as in flight.
    expect(callRecords(agent.session.events)).toEqual(['call:a', 'dispatch:a', 'call:b', 'dispatch:b'])
    tool.gate(1).resolve()
    await waitFor(() => tool.trace.includes('start 3'))
    tool.gate(2).resolve()
    tool.gate(3).resolve()
    await agent.whenIdle()
    expect(tool.peak()).toBe(2)
    expect(results(agent.session.events)).toEqual(['a:ok', 'b:ok', 'c:ok'])

    await harness.dispose()
    harness = await coreHarness()
    const serial = gatedTools(harness, { safe: true })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2]), assistantText('done'))
    const second = await harness.create({ maxParallelToolCalls: 1 })
    second.agent.followup(createUserMessage('go'))
    await waitFor(() => serial.trace.includes('start 1'))
    serial.gate(1).resolve()
    await waitFor(() => serial.trace.includes('start 2'))
    serial.gate(2).resolve()
    await second.agent.whenIdle()
    expect(serial.peak()).toBe(1)
    expect(serial.trace).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('on a cancel, drains what runs and answers what never started, all in model order', async () => {
    harness = await coreHarness()
    const tool = gatedTools(harness, { safe: true })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2], ['c', 'safe', 3]))
    const { agent } = await harness.create({ maxParallelToolCalls: 2 })
    agent.followup(createUserMessage('go'))
    await waitFor(() => tool.trace.includes('start 2'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    // Both running bodies were told and ended; the third never started.
    expect(tool.trace).toEqual(['start 1', 'start 2', 'end 1', 'end 2'])
    expect(results(agent.session.events)).toEqual(['a:TOOL_FAILED', 'b:TOOL_FAILED', 'c:ABORTED_BEFORE_DISPATCH'])
    const turnEnd = agent.session.events.findLast((event) => event.type === 'turn/end')!
    expect((turnEnd.data as { reason: { kind: string } }).reason.kind).toBe('cancelled')
  })

  it('after a lost write starts nothing more, tells the bodies in flight, and still ends DURABILITY_LOST', async () => {
    harness = await coreHarness()
    const tool = gatedTools(harness, { safe: true })
    // The provider loses the write of the SECOND call's record.
    let lose = false
    harness.root.on(SESSION_EVENT, (_session, event) => {
      if (event.type === 'tool/call' && (event.data as { callId: string }).callId === 'b') lose = true
    })
    harness.root.on(SESSION_FLUSH, () => {
      if (lose) throw new Error('disk gone')
    })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2]), assistantText('never sent'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    // The second body never started; the first was told why and drained.
    expect(tool.trace).toEqual(['start 1', 'end 1'])
    expect(tool.signals.get(1)?.aborted).toBe(true)
    expect(tool.signals.get(1)?.reason).toMatchObject({ code: 'DURABILITY_LOST' })
    expect(results(agent.session.events)).toEqual(['a:TOOL_FAILED', 'b:DURABILITY_LOST'])
    const turnEnd = agent.session.events.findLast((event) => event.type === 'turn/end')!
    expect((turnEnd.data as { reason: { kind: string; code?: string } }).reason).toMatchObject({ kind: 'error', code: 'DURABILITY_LOST' })
    expect(harness.adapter.calls).toHaveLength(1) // no second request was paid for
  })

  it('runs a repeated call id as a barrier, so the step never holds two pending calls it cannot tell apart', async () => {
    harness = await coreHarness()
    const tool = gatedTools(harness, { safe: true })
    harness.adapter.script(calls(['a', 'safe', 1], ['a', 'safe', 2]), assistantText('done'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await waitFor(() => tool.trace.includes('start 1'))
    tool.gate(1).resolve()
    await waitFor(() => tool.trace.includes('start 2'))
    tool.gate(2).resolve()
    await agent.whenIdle()
    expect(tool.trace).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
    expect(callRecords(agent.session.events)).toEqual(['call:a', 'dispatch:a', 'result:a', 'call:a', 'dispatch:a', 'result:a'])
  })

  it('runs serially, never deadlocks, when the pipeline answers without reaching a body (no dispatch to hand the lane on)', async () => {
    harness = await coreHarness()
    gatedTools(harness, { safe: true })
    // An around-middleware answering without next(), as an effect-free replay does.
    const answers: Deferred[] = []
    const seen: string[] = []
    harness.root.on(TOOLS_EXECUTE, async (execution) => {
      seen.push(String(execution.callId))
      const answer = deferred()
      answers.push(answer)
      await answer.promise
      return { isError: false, content: [{ type: 'text', text: 'answered' }] } satisfies ToolResult
    })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2]), assistantText('done'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await waitFor(() => answers.length === 1)
    expect(seen).toEqual(['a']) // the second waits for the first: nothing handed the lane on
    answers[0]!.resolve()
    await waitFor(() => answers.length === 2)
    answers[1]!.resolve()
    await agent.whenIdle()
    expect(callRecords(agent.session.events)).toEqual(['call:a', 'result:a', 'call:b', 'result:b'])
  })

  it('leaves a crash mid-batch nothing repair cannot read: in flight is unknown, waiting for a slot was never logged', async () => {
    harness = await coreHarness()
    const tool = gatedTools(harness, { safe: true })
    harness.adapter.script(calls(['a', 'safe', 1], ['b', 'safe', 2], ['c', 'safe', 3]))
    const { agent } = await harness.create({ maxParallelToolCalls: 2 })
    agent.followup(createUserMessage('go'))
    await waitFor(() => tool.trace.includes('start 2'))
    // The log as a crash would leave it, closed by repair.
    const closers = repairTail(agent.session.events)
    const repaired = closers
      .filter((event) => event.type === 'tool/result')
      .map((event) => `${(event.data as { callId: string }).callId}:${(event.data as { error?: { code: string } }).error?.code}`)
    expect(repaired).toEqual(['a:TOOL_OUTCOME_UNKNOWN', 'b:TOOL_OUTCOME_UNKNOWN', 'c:TOOL_NOT_STARTED'])
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
  })

  it('refuses a concurrency-safe tool that does not own its clock', async () => {
    harness = await coreHarness()
    const base = {
      description: 'x',
      input: z.object({}),
      output: z.object({}),
      execute: () => ({}),
      render: () => [{ type: 'text' as const, text: 'x' }],
      concurrencySafe: true as const,
    }
    const tools = harness.root.get(TOOLS)
    expect(() => tools.register(harness!.root, defineTool({ ...base, name: 'defaulted' }))).toThrowError(/must own its clock/)
    expect(() => tools.register(harness!.root, defineTool({ ...base, name: 'timed', timeoutMs: 5_000 }))).toThrowError(/must own its clock/)
    expect(() => tools.register(harness!.root, defineTool({ ...base, name: 'owned', timeoutMs: null }))).not.toThrow()
  })
})
