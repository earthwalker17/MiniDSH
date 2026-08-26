import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENTS } from '../core/agent/index.ts'
import { createUserMessage, messageText } from '../core/llm/message.ts'
import { defineTool, TOOLS } from '../core/tools/index.ts'
import { coreHarness, type CoreHarness } from './harness.ts'
import { assistantText, assistantToolCall } from './scripted-adapter.ts'
import { installLlmReplay } from './llm-replay.ts'

let harnesses: CoreHarness[] = []
afterEach(async () => {
  for (const harness of harnesses.toReversed()) await harness.dispose()
  harnesses = []
})

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  execute: (args) => ({ echoed: args.text }),
  render: (_args, value) => [{ type: 'text', text: value.echoed }],
})

async function record(): Promise<{ events: readonly import('../core/session/index.ts').EventEnvelope[]; text: string }> {
  const harness = await coreHarness()
  harnesses.push(harness)
  harness.root.get(TOOLS).register(harness.root, echo)
  harness.adapter.script(assistantToolCall('c1', 'echo', { text: 'pong' }), assistantText('recorded answer'))
  const { agent } = await harness.create()
  agent.followup(createUserMessage('run it'))
  await agent.whenIdle()
  return { events: agent.session.events.map((event) => ({ ...event })), text: messageText(agent.session.deriveMessages().at(-1)!) }
}

describe('llm-replay', () => {
  it('reproduces a recorded run from its session log', async () => {
    const recorded = await record()
    expect(recorded.text).toBe('recorded answer')

    const harness = await coreHarness()
    harnesses.push(harness)
    // Replay registers a distinct 'replay' provider; the agent routes to it.
    const replay = installLlmReplay(harness.root, { events: recorded.events, provider: 'replay' })
    harness.root.get(TOOLS).register(harness.root, echo)
    const handle = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'replay', model: 'replay' },
    })
    handle.agent.followup(createUserMessage('run it'))
    await handle.agent.whenIdle()

    expect(replay.steps).toBe(2)
    replay.assertConsumed()
    expect(messageText(handle.agent.session.deriveMessages().at(-1)!)).toBe('recorded answer')
    await handle.dispose()
  })

  it('replays a session whose step was retried, using the attempt the agent acted on', async () => {
    const events = await recordRetried()
    const attempts = events.filter((event) => event.type === 'assistant/chunk').map((event) => (event.data as { attempt: number }).attempt)
    expect(new Set(attempts)).toEqual(new Set([1, 2]))
    await replayWithoutRetry(events)
  })

  it('replays the failure too by default, so a recovery that changed the log happens again', async () => {
    const events = await recordRetried()
    const harness = await coreHarness()
    harnesses.push(harness)
    // The default mode replays every recorded attempt, so the composition must
    // be able to recover — exactly as the recording's composition could. This
    // is what an overflow-triggered compaction depends on: elide the failure
    // and the replayed session never compacts, so its history diverges.
    const replay = installLlmReplay(harness.root, { events, provider: 'replay' })
    expect(replay.steps).toBe(3)
    harness.root.get(TOOLS).register(harness.root, echo)
    const handle = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    const { AGENT_REQUEST_ERROR } = await import('../core/agent/index.ts')
    handle.agent.ctx.on(AGENT_REQUEST_ERROR, async (_context, next) => (await next()) ?? { kind: 'retry' })
    handle.agent.followup(createUserMessage('run it'))
    await handle.agent.whenIdle()
    replay.assertConsumed()
    expect(messageText(handle.agent.session.deriveMessages().at(-1)!)).toBe('recorded answer')
    await handle.dispose()
  })

  it('replays a log recorded before `attempt` existed, treating each finish as the attempt boundary', async () => {
    const legacy = (await recordRetried()).map((event) => {
      if (event.type !== 'assistant/chunk') return event
      const { attempt: _drop, ...data } = event.data as { attempt: number; turn: number; step: number; chunk: unknown }
      return { ...event, data }
    })
    await replayWithoutRetry(legacy)
  })

  it('drops every finish-less chunk group (a crash mid-stream), trailing or mid-log', async () => {
    const recorded = await record()
    const { deriveReplayScript } = await import('./llm-replay.ts')
    const whole = deriveReplayScript(recorded.events)
    expect(whole).toHaveLength(2)
    const seq = recorded.events.length
    const crashChunk = (offset: number, turn: number, chunk: unknown): unknown => ({
      type: 'assistant/chunk',
      seq: seq + offset,
      time: 1,
      data: { turn, step: 1, attempt: 1, chunk },
    })
    // A crash on the trailing step: chunks with no terminal finish.
    const trailing = [
      ...recorded.events,
      crashChunk(0, 2, { type: 'block-start', index: 0, blockType: 'text' }),
      crashChunk(1, 2, { type: 'text-delta', index: 0, text: 'cut of' }),
    ] as unknown as Recorded
    expect(deriveReplayScript(trailing)).toHaveLength(2)
    // A resumed log carries the artifact MID-log: completed turns follow it.
    const resumed = [
      ...trailing,
      crashChunk(2, 3, { type: 'block-start', index: 0, blockType: 'text' }),
      crashChunk(3, 3, { type: 'text-delta', index: 0, text: 'after the resume' }),
      crashChunk(4, 3, { type: 'finish', reason: { kind: 'stop' } }),
    ] as unknown as Recorded
    const script = deriveReplayScript(resumed)
    expect(script).toHaveLength(3)
    expect(script.every((group) => group.some((chunk) => chunk.type === 'finish'))).toBe(true)
  })
})

type Recorded = readonly import('../core/session/index.ts').EventEnvelope[]

/** Records a run whose first step fails once (retryable) and is retried. */
async function recordRetried(): Promise<Recorded> {
  const recorder = await coreHarness()
  harnesses.push(recorder)
  recorder.root.get(TOOLS).register(recorder.root, echo)
  recorder.adapter.script(
    () => {
      throw new Error('flaky provider')
    },
    assistantToolCall('c1', 'echo', { text: 'pong' }),
    assistantText('recorded answer'),
  )
  const { agent } = await recorder.create()
  const { AGENT_REQUEST_ERROR } = await import('../core/agent/index.ts')
  agent.ctx.on(AGENT_REQUEST_ERROR, async (_context, next) => (await next()) ?? { kind: 'retry' })
  agent.followup(createUserMessage('run it'))
  await agent.whenIdle()
  return agent.session.events.map((event) => ({ ...event }))
}

/**
 * No retry policy here, so the composition cannot recover: `acted-on` is the
 * mode that lets such a log replay at all, and the failed attempt is elided.
 */
async function replayWithoutRetry(events: Recorded): Promise<void> {
  const harness = await coreHarness()
  harnesses.push(harness)
  const replay = installLlmReplay(harness.root, { events, provider: 'replay', attempts: 'acted-on' })
  harness.root.get(TOOLS).register(harness.root, echo)
  const handle = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
  handle.agent.followup(createUserMessage('run it'))
  await handle.agent.whenIdle()
  expect(replay.steps).toBe(2)
  replay.assertConsumed()
  expect(messageText(handle.agent.session.deriveMessages().at(-1)!)).toBe('recorded answer')
  await handle.dispose()
}
