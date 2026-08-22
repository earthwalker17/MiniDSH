import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENTS } from '../agent/index.ts'
import { createUserMessage, messageText } from '../llm/message.ts'
import { assistantText, assistantToolCall } from '../../test-support/scripted-adapter.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { defineTool, TOOLS } from '../tools/index.ts'
import type { EventEnvelope } from '../session/index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.type)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('agent loop: turn/step lifecycle', () => {
  it('runs a text turn with the canonical event order', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('hello there'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()

    // Every raw stream chunk is logged; collapse them to check the skeleton.
    const skeleton = types(agent.session.events).filter((type, index, all) => type !== 'assistant/chunk' || all[index - 1] !== 'assistant/chunk')
    expect(skeleton).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'request/header',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(agent.session.events.filter((event) => event.type === 'assistant/chunk').length).toBeGreaterThan(0)
    const messages = agent.session.deriveMessages()
    expect(messageText(messages.at(-1)!)).toBe('hello there')
    const turnEnd = agent.session.events.at(-1)!
    expect((turnEnd.data as { reason: { kind: string } }).reason.kind).toBe('completed')
  })

  it('gives each followup its own turn (one send, at most one turn)', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('one'), assistantText('two'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('first'))
    agent.followup(createUserMessage('second'))
    await agent.whenIdle()
    const turnStarts = agent.session.events.filter((event) => event.type === 'turn/start')
    expect(turnStarts).toHaveLength(2)
    expect(harness.adapter.calls).toHaveLength(2)
  })

  it('closes a blocked, step-less turn when pre-step rejects', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('never used'))
    const { agent } = await harness.create()
    // A pre-step listener rejects the claim.
    const { AGENT_PRE_STEP } = await import('../agent/index.ts')
    agent.ctx.on(AGENT_PRE_STEP, async () => ({ kind: 'reject' }))
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    expect(types(agent.session.events)).toEqual(['turn/start', 'turn/end'])
    expect((agent.session.events.at(-1)!.data as { reason: { kind: string } }).reason.kind).toBe('blocked')
    expect(harness.adapter.calls).toHaveLength(0)
  })

  it('runs a tool call, feeds the result back, and finishes on the next step', async () => {
    harness = await coreHarness()
    const echo = defineTool({
      name: 'echo',
      description: 'echo text back',
      input: z.object({ text: z.string() }),
      output: z.object({ echoed: z.string() }),
      execute: (args) => ({ echoed: args.text }),
      render: (_args, value) => [{ type: 'text', text: value.echoed }],
    })
    harness.root.get(TOOLS).register(harness.root, echo)
    harness.adapter.script(assistantToolCall('c1', 'echo', { text: 'ping' }), assistantText('done'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('use the tool'))
    await agent.whenIdle()

    expect(harness.adapter.calls).toHaveLength(2)
    const toolResult = agent.session.events.find((event) => event.type === 'tool/result')!
    expect(toolResult).toBeDefined()
    // The second request's history includes the tool result.
    const secondCall = harness.adapter.calls[1]!
    const toolMessages = secondCall.messages.filter((message) => message.source.kind === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(messageText(agent.session.deriveMessages().at(-1)!)).toBe('done')
  })

  it('ends the turn with max-tokens when the model is truncated', async () => {
    harness = await coreHarness()
    harness.adapter.script([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const { agent } = await harness.create()
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    expect((agent.session.events.at(-1)!.data as { reason: { kind: string } }).reason.kind).toBe('max-tokens')
  })

  it('retries a failed request when agent/request-error returns retry', async () => {
    harness = await coreHarness()
    harness.adapter.script(
      () => {
        throw new (class extends Error {})('flaky')
      },
      assistantText('recovered'),
    )
    const { agent } = await harness.create()
    const { AGENT_REQUEST_ERROR } = await import('../agent/index.ts')
    let retries = 0
    agent.ctx.on(AGENT_REQUEST_ERROR, async (_context, next) => {
      retries += 1
      await next()
      return { kind: 'retry' }
    })
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    expect(retries).toBe(1)
    expect(messageText(agent.session.deriveMessages().at(-1)!)).toBe('recovered')
    expect((agent.session.events.at(-1)!.data as { reason: { kind: string } }).reason.kind).toBe('completed')
  })

  it('cancels a running turn and closes it as cancelled', async () => {
    harness = await coreHarness()
    const hang = defineTool({
      name: 'hang',
      description: 'wait until aborted',
      input: z.object({}),
      output: z.object({}),
      execute: (_args, exec) =>
        new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      render: () => [{ type: 'text', text: 'never' }],
    })
    harness.root.get(TOOLS).register(harness.root, hang)
    harness.adapter.script(assistantToolCall('c1', 'hang', {}), assistantText('unreached'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await waitFor(() => agent.status === 'running')
    await waitFor(() => agent.session.events.some((event) => event.type === 'tool/call'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect((agent.session.events.at(-1)!.data as { reason: { kind: string } }).reason.kind).toBe('cancelled')
  })
})

describe('agent loop: ownership', () => {
  it('publishes on create and detaches on dispose', async () => {
    harness = await coreHarness()
    const registry = harness.root.get(AGENTS)
    const handle = await harness.create()
    expect(registry.get(handle.agent.id)).toBe(handle.agent)
    await handle.dispose()
    expect(registry.get(handle.agent.id)).toBeUndefined()
    expect(handle.agent.status).toBe('idle')
  })

  it('delivers injected context as a durable user message within the next turn', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('ok'))
    const { agent } = await harness.create()
    const { createPluginMessage } = await import('../llm/message.ts')
    agent.inject(createPluginMessage('test', 'remember: be brief'))
    // Injection alone does not wake the driver.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agent.session.events).toHaveLength(0)
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    const userMessages = agent.session.deriveMessages().filter((message) => message.role === 'user')
    expect(userMessages).toHaveLength(2)
    expect(userMessages.some((message) => message.source.kind === 'plugin')).toBe(true)
  })
})
