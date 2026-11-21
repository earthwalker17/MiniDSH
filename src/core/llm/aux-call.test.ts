/**
 * The out-of-loop model call. What matters is that it is DURABLE, that it does
 * not touch model history, and that the loop's own reconstruction invariant
 * ignores it — a call the model never sees must not be held to a contract
 * about what the model sees.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText } from '../../test-support/scripted-adapter.ts'
import { createUserMessage, messageText } from './message.ts'
import { LLM } from './runtime.ts'
import { AuxCallError, foldAuxCalls, LLM_AUX_CALL, runAuxCall, type AuxCallRecord } from './aux-call.ts'
import type { LlmRequest, StreamChunk } from './types.ts'

const harnesses: CoreHarness[] = []
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

async function newHarness(): Promise<CoreHarness> {
  const created = await coreHarness()
  harnesses.push(created)
  return created
}

function auxRequest(over: Partial<LlmRequest> = {}): LlmRequest & { purpose: string } {
  return { provider: 'scripted', model: 'scripted-model', messages: [createUserMessage('summarise this')], purpose: 'compaction', maxTokens: 512, ...over }
}

describe('an out-of-loop model call', () => {
  it('records one durable log-only fact carrying route, usage, and the answer', async () => {
    const test = await newHarness()
    const { agent } = await test.create()
    test.adapter.script(assistantText('a terse summary', { inputTokens: 400, outputTokens: 9 }))

    const before = agent.session.deriveMessages().length
    const result = await runAuxCall(test.root.get(LLM), agent.session, auxRequest(), [3, 4, 5])

    const record = agent.session.events.at(-1)!
    expect(record.type).toBe(LLM_AUX_CALL.type)
    // Log-only: a non-surface event may carry neither a surfaceOp nor sourceEventSeqs.
    expect(record.surfaceOp).toBeUndefined()
    expect(record.sourceEventSeqs).toBeUndefined()

    const data = record.data as AuxCallRecord
    expect(data).toMatchObject({ purpose: 'compaction', provider: 'scripted', model: 'scripted-model', maxTokens: 512, inputSeqs: [3, 4, 5] })
    expect(data.usage).toEqual({ inputTokens: 400, outputTokens: 9 })
    expect(data.outcome).toEqual({ kind: 'text', text: 'a terse summary' })

    expect(result.text).toBe('a terse summary')
    expect(result.seq).toBe(record.seq)
    // The model's own history is untouched: this was never a turn.
    expect(agent.session.deriveMessages()).toHaveLength(before)
  })

  // The S20.5 audit's reproduction: an answer cut off at maxTokens was
  // recorded as an ordinary `text` outcome, and compaction applied the cut
  // summary in place of the history it replaced.
  it('says when the answer was cut off at its output cap, in the record and to the caller', async () => {
    const test = await newHarness()
    const { agent } = await test.create()
    const cut: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '## Primary Request\n- the user asked to refactor the par' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '## Primary Request\n- the user asked to refactor the par' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]
    test.adapter.script(cut, assistantText('complete'))
    const result = await runAuxCall(test.root.get(LLM), agent.session, auxRequest())
    expect(result.truncated).toBe(true)
    expect((agent.session.events.at(-1)!.data as AuxCallRecord).outcome).toMatchObject({ kind: 'text', truncated: true })
    const whole = await runAuxCall(test.root.get(LLM), agent.session, auxRequest())
    expect(whole.truncated).toBeUndefined()
  })

  it('writes no assistant/chunk, so the replay script’s turn/step grouping cannot be corrupted', async () => {
    const test = await newHarness()
    const { agent } = await test.create()
    test.adapter.script(assistantText('summary'))
    await runAuxCall(test.root.get(LLM), agent.session, auxRequest())
    expect(agent.session.events.some((event) => event.type === 'assistant/chunk')).toBe(false)
  })

  it('records a failure before throwing it, so an abandoned call still explains itself', async () => {
    const test = await newHarness()
    const { agent } = await test.create()
    const failing: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'nope', code: 'SERVER' } } }]
    test.adapter.script(failing)

    await expect(runAuxCall(test.root.get(LLM), agent.session, auxRequest())).rejects.toBeInstanceOf(AuxCallError)
    const data = agent.session.events.at(-1)!.data as AuxCallRecord
    expect(data.outcome).toEqual({ kind: 'error', failure: { message: 'nope', code: 'SERVER' } })
  })

  it('runs beside a live turn without tripping the request-reconstruction invariant', async () => {
    const test = await newHarness()
    const { agent } = await test.create()
    // One real turn, then an auxiliary call, then another real turn: the
    // invariant is mounted and would fail the loop request if the aux call
    // were mistaken for one.
    test.adapter.script(assistantText('first'))
    agent.followup(createUserMessage('hello'))
    await agent.whenIdle()

    test.adapter.script(assistantText('a summary'))
    await runAuxCall(test.root.get(LLM), agent.session, auxRequest())

    test.adapter.script(assistantText('second'))
    agent.followup(createUserMessage('again'))
    await agent.whenIdle()

    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect(ends.map((event) => (event.data as { reason: { kind: string } }).reason.kind)).toEqual(['completed', 'completed'])
    expect(messageText(agent.session.deriveMessages().at(-1)!)).toBe('second')
  })

  // The loop builds its request field by field from the resolved route, so a
  // route listener that returns a `purpose` beside it (a role that confused
  // the two kinds of call) cannot make a step look like an auxiliary call:
  // the listeners that tell them apart by this field would then skip the step.
  it('never lets `purpose` reach the model-visible request the loop builds, even from a route listener that returns one', async () => {
    const test = await newHarness()
    const { AGENT_REQUEST } = await import('../agent/index.ts')
    const { agent } = await test.create()
    agent.ctx.on(AGENT_REQUEST, async (_context, next) => ({ ...(await next()), purpose: 'smuggled' }) as Awaited<ReturnType<typeof next>>)
    test.adapter.script(assistantText('hi'), assistantText('a summary'))
    agent.followup(createUserMessage('hello'))
    await agent.whenIdle()
    await runAuxCall(test.root.get(LLM), agent.session, auxRequest())
    // One loop request and one auxiliary call, and only the second carries a purpose.
    expect(test.adapter.calls.map((call) => ({ purpose: call.purpose, hasKey: 'purpose' in call }))).toEqual([
      { purpose: undefined, hasKey: false },
      { purpose: 'compaction', hasKey: true },
    ])
    expect(agent.session.foldRequestHeader()).not.toHaveProperty('purpose')
  })

  /**
   * What a failed call RECORDS is what its caller routes on (`code`, never the
   * message): compaction counts a summariser failure toward giving up, and a
   * cancellation must not count. Three ways to fail besides a provider's own
   * error finish: a listener on `llm/stream` throwing an `LlmError`, one
   * throwing anything else, and a request cancelled before it was sent.
   */
  it('records the failure a thrown or cancelled call ended with, under its own code', async () => {
    const { LLM_STREAM } = await import('./runtime.ts')
    const { LlmError } = await import('./types.ts')
    const cases: [name: string, arrange: (test: CoreHarness) => Partial<LlmRequest>, failure: { message: string; code: string }][] = [
      [
        'a middleware throwing an LlmError',
        (test) => {
          test.root.on(LLM_STREAM, () => {
            throw new LlmError('RATE_LIMIT', 'slow down')
          })
          return {}
        },
        { message: 'slow down', code: 'RATE_LIMIT' },
      ],
      [
        'a middleware throwing a plain Error',
        (test) => {
          test.root.on(LLM_STREAM, () => {
            throw new Error('a listener broke')
          })
          return {}
        },
        { message: 'a listener broke', code: 'AUX_CALL_FAILED' },
      ],
      ['a request cancelled before it was sent', () => ({ signal: AbortSignal.abort() }), { message: 'request aborted before the provider was called', code: 'ABORTED' }],
    ]
    const outcomes: Record<string, unknown> = {}
    for (const [name, arrange] of cases) {
      const test = await newHarness()
      const { agent } = await test.create()
      const over = arrange(test)
      const thrown = await runAuxCall(test.root.get(LLM), agent.session, auxRequest(over)).then(
        (result) => `returned ${JSON.stringify(result.text)}`,
        (error: unknown) => error,
      )
      const records = foldAuxCalls(agent.session.events)
      const last = agent.session.events.at(-1)!
      outcomes[name] = {
        thrown: thrown instanceof AuxCallError ? { failure: thrown.failure, namesItsRecord: thrown.seq === last.seq && last.type === LLM_AUX_CALL.type } : thrown,
        recorded: records.map((record) => record.outcome),
        adapterCalls: test.adapter.calls.length,
      }
    }
    expect(outcomes).toEqual(
      Object.fromEntries(cases.map(([name, , failure]) => [name, { thrown: { failure, namesItsRecord: true }, recorded: [{ kind: 'error', failure }], adapterCalls: 0 }])),
    )
  })

  it('folds every recorded call in log order, which is what a replay script needs', async () => {
    const test = await newHarness()
    const { agent } = await test.create()
    test.adapter.script(assistantText('one'), assistantText('two'))
    await runAuxCall(test.root.get(LLM), agent.session, auxRequest())
    await runAuxCall(test.root.get(LLM), agent.session, auxRequest({ purpose: 'verification' }))

    const folded = foldAuxCalls(agent.session.events)
    expect(folded.map((record) => record.purpose)).toEqual(['compaction', 'verification'])
    expect(folded.map((record) => (record.outcome.kind === 'text' ? record.outcome.text : ''))).toEqual(['one', 'two'])
  })
})
