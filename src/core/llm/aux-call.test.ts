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

  it('never lets `purpose` reach the model-visible request the loop builds', async () => {
    const test = await newHarness()
    const { agent } = await test.create()
    test.adapter.script(assistantText('hi'))
    agent.followup(createUserMessage('hello'))
    await agent.whenIdle()
    expect(test.adapter.calls.every((call) => call.purpose === undefined)).toBe(true)
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
