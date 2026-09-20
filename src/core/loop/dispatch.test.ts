/**
 * The gate-to-body fact, through the real loop.
 *
 * What is being pinned is not that an event exists but that its ABSENCE is
 * evidence: `tool/dispatch` appears exactly when a body was about to run, and
 * never for a call the gate refused, a guard denied, a person rejected, or a
 * lost durable write stopped. The recovery rule (`core/session/repair.ts`)
 * reads it that way, so anything that writes one loosely makes repair lie.
 */
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText, assistantToolCall } from '../../test-support/scripted-adapter.ts'
import { APPROVAL_REQUEST } from '../approval/index.ts'
import { createUserMessage } from '../llm/message.ts'
import { SESSION_FLUSH, TOOL_CALL, TOOL_DISPATCH, TOOL_RESULT, TURN_END, type EventEnvelope } from '../session/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE } from '../tools/index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** Records whether its body ever ran, so "the gate stopped it" is checkable. */
function probe(ran: { value: boolean }) {
  return defineTool({
    name: 'probe',
    description: 'a tool that remembers being run',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    execute: () => {
      ran.value = true
      return { ok: true }
    },
    render: () => [{ type: 'text', text: 'ok' }],
  })
}

async function world(ran: { value: boolean }) {
  harness = await coreHarness()
  harness.root.get(TOOLS).register(harness.root, probe(ran))
  return harness
}

const types = (events: readonly EventEnvelope[]): string[] => events.map((event) => event.type)
const codeOf = (event: EventEnvelope): string | undefined => (event.data as { error?: { code: string } }).error?.code

describe('the gate-to-body fact', () => {
  it('lands between the call and its result, once, when the body runs', async () => {
    const ran = { value: false }
    const h = await world(ran)
    h.adapter.script(assistantToolCall('c1', 'probe', {}), assistantText('done'))
    const handle = await h.create()
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()

    expect(ran.value).toBe(true)
    const order = types(handle.agent.session.facts).filter((type) => type.startsWith('tool/'))
    expect(order).toEqual(['tool/call', 'tool/dispatch', 'tool/result'])
    const dispatch = handle.agent.session.facts.find((event) => event.type === TOOL_DISPATCH.type)!
    expect(dispatch.data).toEqual({ turn: 1, step: 1, callId: 'c1' })
    await handle.dispose()
  })

  it('is never written for a call the gate refused, and the body never runs', async () => {
    const ran = { value: false }
    const h = await world(ran)
    h.root.on(TOOLS_PRE_EXECUTE, async () => ({ kind: 'deny', reason: 'policy says no' }))
    h.adapter.script(assistantToolCall('c1', 'probe', {}), assistantText('done'))
    const handle = await h.create()
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()

    expect(ran.value).toBe(false)
    expect(types(handle.agent.session.facts)).not.toContain(TOOL_DISPATCH.type)
    expect(codeOf(handle.agent.session.facts.find((event) => event.type === TOOL_RESULT.type)!)).toBe('DENIED')
    await handle.dispose()
  })

  it('is never written for a call a person rejected', async () => {
    const ran = { value: false }
    const h = await world(ran)
    h.root.on(TOOLS_PRE_EXECUTE, async () => ({ kind: 'ask' }))
    h.root.on(APPROVAL_REQUEST, async () => 'rejected' as const)
    h.adapter.script(assistantToolCall('c1', 'probe', {}), assistantText('done'))
    const handle = await h.create()
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()

    expect(ran.value).toBe(false)
    // The ask is durable; the dispatch is not, because the body never ran.
    expect(types(handle.agent.session.facts)).toContain('approval/asked')
    expect(types(handle.agent.session.facts)).not.toContain(TOOL_DISPATCH.type)
    await handle.dispose()
  })

  /**
   * The reason the DRIVER writes this fact rather than the pipeline. A lost
   * write must end the TURN the way every lost write ends it — a pipeline that
   * only returned an error result would leave the loop free to close the turn
   * `completed`, because this call concludes it.
   */
  it('refuses the body and ends the turn when the durability write is lost', async () => {
    const ran = { value: false }
    const h = await world(ran)
    h.adapter.script(assistantToolCall('c1', 'probe', {}), assistantText('done'))
    const handle = await h.create()
    // Exactly the checkpoint between the gate and the body, identified by what
    // it is flushing — a counter would have caught the driver's own
    // pre-dispatch checkpoint instead and tested nothing new.
    h.root.on(SESSION_FLUSH, (session) => {
      if (session.events.at(-1)?.type === TOOL_DISPATCH.type) throw new Error('disk full')
    })
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()

    expect(ran.value).toBe(false)
    // The record IS on the log and the body still did not run. Harmless: the
    // call is answered, so repair never reads it — and had the host died in
    // that instant, "outcome unknown" is the safe direction anyway.
    expect(types(handle.agent.session.facts)).toContain(TOOL_DISPATCH.type)
    const result = handle.agent.session.facts.find((event) => event.type === TOOL_RESULT.type)!
    expect(codeOf(result)).toBe('DURABILITY_LOST')
    const end = handle.agent.session.facts.findLast((event) => event.type === TURN_END.type)!
    expect((end.data as { reason: { kind: string; code?: string } }).reason).toMatchObject({ kind: 'error', code: 'DURABILITY_LOST' })
    // The call is still on the record, so repair can see it was attempted.
    expect(types(handle.agent.session.facts)).toContain(TOOL_CALL.type)
    await handle.dispose()
  })
})
