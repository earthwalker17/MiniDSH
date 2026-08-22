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

  it('replays a log recorded before `attempt` existed, treating each finish as the attempt boundary', async () => {
    const legacy = (await recordRetried()).map((event) => {
      if (event.type !== 'assistant/chunk') return event
      const { attempt: _drop, ...data } = event.data as { attempt: number; turn: number; step: number; chunk: unknown }
      return { ...event, data }
    })
    await replayWithoutRetry(legacy)
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

/** No retry policy here: the failed attempt must not be replayed at all. */
async function replayWithoutRetry(events: Recorded): Promise<void> {
  const harness = await coreHarness()
  harnesses.push(harness)
  const replay = installLlmReplay(harness.root, { events, provider: 'replay' })
  harness.root.get(TOOLS).register(harness.root, echo)
  const handle = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
  handle.agent.followup(createUserMessage('run it'))
  await handle.agent.whenIdle()
  expect(replay.steps).toBe(2)
  replay.assertConsumed()
  expect(messageText(handle.agent.session.deriveMessages().at(-1)!)).toBe('recorded answer')
  await handle.dispose()
}
