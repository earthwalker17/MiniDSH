import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { toolSubagentPlugin } from '../capabilities/tool-subagent/index.ts'
import { AGENT_CREATED, AGENTS, SUBAGENT_START, type Agent } from '../core/agent/index.ts'
import { asCallId } from '../core/ids.ts'
import { LLM, type LlmRequest, type StreamChunk } from '../core/llm/index.ts'
import { createUserMessage, messageText } from '../core/llm/message.ts'
import { matches, TOOL_RESULT } from '../core/session/index.ts'
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

describe('llm-replay: out-of-loop calls', () => {
  it('refuses to serve a call recorded for one purpose to a request made for another', async () => {
    const harness = await coreHarness()
    harnesses.push(harness)
    const recorded: Recorded = [
      {
        type: 'llm/aux-call',
        seq: 0,
        time: 0,
        data: { purpose: 'compaction', provider: 'replay', model: 'replay', outcome: { kind: 'text', text: 'a summary' } },
      },
    ]
    installLlmReplay(harness.root, { events: recorded, provider: 'replay' })
    const llm = harness.root.get(LLM)
    const consume = async (purpose: string): Promise<import('../core/llm/index.ts').StreamChunk[]> => {
      const out: import('../core/llm/index.ts').StreamChunk[] = []
      for await (const chunk of llm.stream({ provider: 'replay', model: 'replay', messages: [], purpose })) out.push(chunk)
      return out
    }
    // The seam normalizes the adapter's refusal into a terminal error finish.
    const refused = await consume('verification')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { message: expect.stringMatching(/recorded as "compaction" but the request asks for "verification"/) as string } } })
    // The record is still there for the request it was made for.
    expect((await consume('compaction')).map((chunk) => chunk.type)).toContain('text-delta')
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

/**
 * A log is its own oracle for the agent that WROTE it. A delegated child is a
 * different session making its own calls through the same seam, so it needs its
 * own log — found through the call that delegated it, because sibling children
 * ask in an order that is a race once they run at once (S21) — and asking for
 * one it was not given must fail loudly rather than quietly serving it the
 * parent's next recorded step, or a sibling's.
 */
describe('replay across a delegation', () => {
  /** One delegated task: its prompt (unique, so the recording can key the child by it) and the child's steps. */
  interface Task {
    readonly prompt: string
    readonly steps: readonly StreamChunk[][]
  }

  interface RecordedChild {
    readonly id: string
    readonly callId: string
    readonly events: Recorded
  }

  /** A harness whose agents can delegate: the real delegation tool over the core composition. */
  async function delegating(): Promise<CoreHarness> {
    const harness = await coreHarness()
    harnesses.push(harness)
    harness.root.plugin(toolSubagentPlugin, {})
    await harness.root.settle()
    harness.root.get(TOOLS).register(harness.root, echo)
    return harness
  }

  /** Every agent the composition creates from here on, children included, so a disposed child's log can still be read. */
  function created(harness: CoreHarness): Agent[] {
    const agents: Agent[] = []
    harness.root.on(AGENT_CREATED, (agent) => void agents.push(agent))
    return agents
  }

  /** The request a session whose task is `prompt` makes: its first message is that task. */
  const asks =
    (prompt: string) =>
    (request: LlmRequest): boolean => {
      const first = request.messages[0]
      return first !== undefined && messageText(first) === prompt
    }

  /**
   * A parent whose one step delegates every task at once, then answers. Each
   * child — and each deeper session one of them delegates to (`deeper`) — is
   * scripted by its own prompt, so no child's script depends on when it asks.
   */
  async function recordDelegation(tasks: readonly Task[], deeper: readonly Task[] = []): Promise<{ parent: Recorded; children: RecordedChild[] }> {
    const harness = await delegating()
    const agents = created(harness)
    for (const task of [...tasks, ...deeper]) harness.adapter.scriptWhen(asks(task.prompt), ...task.steps)
    harness.adapter.script(
      callsInOneStep(...tasks.map((task, index) => [`call-${index}`, 'subagent', { description: `task ${index}`, prompt: task.prompt }] as const)),
      assistantText('the parent answer'),
    )
    const { agent: parent } = await harness.create()
    parent.followup(createUserMessage('delegate them'))
    await parent.whenIdle()
    expect(parent.session.facts.filter((event) => matches(event, SUBAGENT_START))).toHaveLength(tasks.length)
    // Every delegated session, sorted by the call that made it: an order the
    // recording's own scheduling cannot change.
    const children = agents
      .filter((agent) => agent.session.header.delegatedBy !== undefined)
      .map((agent) => ({ id: agent.id, callId: agent.session.header.delegatedByCallId!, events: agent.session.events.map((event) => ({ ...event })) }))
      .toSorted((a, b) => a.callId.localeCompare(b.callId))
    return { parent: parent.session.events.map((event) => ({ ...event })), children }
  }

  /** Replays a recording under a fresh delegating composition: the parent asks, and its children are whoever its replayed calls create. */
  async function replayDelegation(parent: Recorded, children: readonly { readonly id: string; readonly events: Recorded }[]) {
    const harness = await delegating()
    const agents = created(harness)
    const replay = installLlmReplay(harness.root, { events: parent, children, provider: 'replay' })
    const handle = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    handle.agent.followup(createUserMessage('delegate them'))
    await handle.agent.whenIdle()
    await handle.dispose()
    /** The last thing the replayed child given `prompt` said. */
    const answerOf = (prompt: string): string => {
      const child = agents.find((agent) => agent.id !== handle.agent.id && messageText(agent.session.deriveMessages()[0]!) === prompt)
      return child === undefined ? '(no such child)' : messageText(child.session.deriveMessages().at(-1)!)
    }
    return { replay, parent: handle.agent, answerOf }
  }

  /** Two children with nothing in common: different prompts, different answers, and a different number of steps. */
  const TWO: readonly Task[] = [
    { prompt: 'task A', steps: [assistantToolCall('c1', 'echo', { text: 'from A' }), assistantText('answer A')] },
    { prompt: 'task B', steps: [assistantText('answer B')] },
  ]

  it('refuses to serve the root’s recording to a second top-level session', async () => {
    const recorded = await record()
    const harness = await coreHarness()
    harnesses.push(harness)
    harness.root.get(TOOLS).register(harness.root, echo)
    const replay = installLlmReplay(harness.root, { events: recorded.events, provider: 'replay' })
    const agents = harness.root.get(AGENTS)
    const first = await agents.create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    first.agent.followup(createUserMessage('run it'))
    await first.agent.whenIdle()
    expect(messageText(first.agent.session.deriveMessages().at(-1)!)).toBe('recorded answer')

    // A second session with no parent has nothing recorded for it. It used to
    // take the next log in line; now the failure names what it is.
    const second = await agents.create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    second.agent.followup(createUserMessage('run it'))
    await second.agent.whenIdle()
    const ended = second.agent.session.facts.findLast((event) => event.type === 'turn/end')!
    expect(JSON.stringify(ended.data)).toContain('second top-level session')
    // And the refusal outlives the failed step that carried it.
    expect(() => replay.assertConsumed()).toThrow(new RegExp(`left its recording: session "${second.agent.id}" is a second top-level session`))
    await second.dispose()
    await first.dispose()
  })

  it('replays a delegated child from its own log, and asserts both logs were drained', async () => {
    const { parent, children } = await recordDelegation([TWO[0]!])
    const { replay, answerOf } = await replayDelegation(parent, children)
    expect(answerOf('task A')).toBe('answer A')
    replay.assertConsumed()
  })

  it('binds each of two children to the log its own delegating call recorded, whatever order the logs come in', async () => {
    const { parent, children } = await recordDelegation(TWO)
    expect(children.map((child) => child.callId)).toEqual(['call-0', 'call-1'])
    // Reversed: binding by first request would hand the child that asks first
    // (A's, today) B's one-step log, and B A's two — and the parent's own two
    // steps would still be drained.
    const { replay, parent: replayed, answerOf } = await replayDelegation(parent, children.toReversed())
    expect(answerOf('task A')).toBe('answer A')
    expect(answerOf('task B')).toBe('answer B')
    // Each answer reached the parent through the call that asked for it.
    const results = replayed.session.facts.filter((event) => matches(event, TOOL_RESULT)).map((event) => [(event.data as { callId: string }).callId, JSON.stringify(event.data)] as const)
    expect(results.find(([callId]) => callId === 'call-0')?.[1]).toContain('answer A')
    expect(results.find(([callId]) => callId === 'call-1')?.[1]).toContain('answer B')
    replay.assertConsumed()
  })

  it('finds a grandchild through its own parent’s recording', async () => {
    const { parent, children } = await recordDelegation(
      [{ prompt: 'task A', steps: [assistantToolCall('call-g', 'subagent', { description: 'deeper', prompt: 'task G' }), assistantText('answer A')] }],
      [{ prompt: 'task G', steps: [assistantText('answer G')] }],
    )
    expect(children.map((child) => child.callId)).toEqual(['call-0', 'call-g'])
    const { replay, answerOf } = await replayDelegation(parent, children.toReversed())
    expect(answerOf('task G')).toBe('answer G')
    expect(answerOf('task A')).toBe('answer A')
    replay.assertConsumed()
  })

  it('refuses a child whose recorded log was not installed, naming the session and the call', async () => {
    const { parent, children } = await recordDelegation(TWO)
    const [a, b] = children as [RecordedChild, RecordedChild]
    // Only B's log: A asks, and is refused rather than handed B's.
    const { replay, answerOf } = await replayDelegation(parent, [b])
    expect(answerOf('task B')).toBe('answer B')
    expect(() => replay.assertConsumed()).toThrow(
      new RegExp(`left its recording: child session ".+" was delegated by call 1:1:call-0, which the recording delegated to "${a.id}", and no child log with that id was installed`),
    )
  })

  it('names the child log a replay never reached, and why', async () => {
    const { parent, children } = await recordDelegation([TWO[0]!])
    // Replayed WITHOUT the delegation tool: the recorded call is refused as an
    // unknown tool, no child is created, and the parent's next recorded step
    // replays anyway — exactly what a delegation that failed to happen looks like.
    const harness = await coreHarness()
    harnesses.push(harness)
    const replay = installLlmReplay(harness.root, { events: parent, children, provider: 'replay' })
    const handle = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    handle.agent.followup(createUserMessage('delegate them'))
    await handle.agent.whenIdle()
    expect(() => replay.assertConsumed()).toThrow(new RegExp(`child log "${children[0]!.id}" was never bound to a session — the recording delegated to it`))
    await handle.dispose()
  })

  it('fails the oracle on a log no recorded delegation names, and refuses two logs under one id', async () => {
    const { parent, children } = await recordDelegation([TWO[0]!])
    const stray = { id: 'stray', events: (await record()).events }
    const { replay } = await replayDelegation(parent, [...children, stray])
    expect(() => replay.assertConsumed()).toThrow(/child log "stray" was never bound to a session — no installed log records a subagent\/start for it/)
    const harness = await coreHarness()
    harnesses.push(harness)
    expect(() => installLlmReplay(harness.root, { events: parent, children: [children[0]!, children[0]!], provider: 'replay' })).toThrow(/two child logs were installed under the session id/)
  })

  it('counts a child log with no recorded steps as consumed: a delegation cancelled before its child started', async () => {
    const { parent, children } = await recordDelegation([TWO[0]!])
    // What a child the cancelled call never started leaves: its opening facts,
    // and no step.
    const opening = children[0]!.events.slice(0, children[0]!.events.findIndex((event) => event.type === 'user/message'))
    expect(opening.some((event) => event.type === 'assistant/chunk')).toBe(false)
    const { replay } = await replayDelegation(parent, [...children, { id: 'never-started', events: opening }])
    replay.assertConsumed()
  })
})

/**
 * The route facts a replay answers FROM THE LOG.
 *
 * The window has been answered this way since S6. Modalities matter more,
 * because absent means text only and a producer refuses against that: without
 * this fold a recorded vision session would refuse its own recorded image on
 * replay, the tool would return an error, no attachment would be written, and
 * the recorded answer would replay anyway — `assertConsumed()` passing on
 * arithmetic while nothing under test had run. That is the S7.5 defect class,
 * one subsystem over.
 */
describe('replay answers a recorded route from the log', () => {
  const context = (provider: string, model: string, data: Record<string, unknown>) => ({
    type: 'request/context',
    seq: 0,
    time: 0,
    data: { provider, model, ...data },
  })

  it('folds the window and the modalities per route, last write winning', async () => {
    const { modalitiesIn, windowsIn } = await import('./llm-replay.ts')
    const events = [
      context('deepseek', 'deepseek-v4-flash', { contextWindow: 1_000_000, inputModalities: ['text'] }),
      context('deepseek', 'deepseek-v4-flash-vision-exp', { contextWindow: 1_000_000, inputModalities: ['text', 'image'] }),
    ]
    expect(windowsIn(events).get('deepseek/deepseek-v4-flash-vision-exp')).toBe(1_000_000)
    expect(modalitiesIn(events).get('deepseek/deepseek-v4-flash')).toEqual(['text'])
    expect(modalitiesIn(events).get('deepseek/deepseek-v4-flash-vision-exp')).toEqual(['text', 'image'])
  })

  /**
   * Renaming the seam does not rename the recording. `installLlmReplay({provider})`
   * registers an adapter under a name the log never used, and both maps are keyed
   * by the RECORDED route — so without a model-keyed fallback every lookup misses:
   * the window becomes a default that moves where compaction fires relative to the
   * recording, and absent modalities read as text-only, which makes a recorded
   * vision session refuse its own image, write no attachment, replay its recorded
   * answer anyway, and pass `assertConsumed()` on arithmetic.
   */
  it('answers a renamed provider from the log by model, rather than losing the route facts', async () => {
    const harness = await coreHarness()
    harnesses.push(harness)
    const log = [context('recorded', 'vision-model', { contextWindow: 60_000, inputModalities: ['text', 'image'] })]
    const replay = installLlmReplay(harness.root, { events: log, provider: 'renamed' })
    const resolved = harness.root.get(LLM).resolveModel('renamed', 'vision-model')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.contextWindow).toBe(60_000)
    await replay.dispose()
  })
  it('leaves modalities absent for a log recorded before the field existed, which reads as text only', async () => {
    const { modalitiesIn } = await import('./llm-replay.ts')
    expect(modalitiesIn([context('deepseek', 'deepseek-v4-flash', { contextWindow: 1_000_000 })]).size).toBe(0)
  })

  it('a replayed adapter reports the modalities the recording used, merged across a child log', async () => {
    const harness = await coreHarness()
    harnesses.push(harness)
    // A provider name the harness has not already claimed for its scripted adapter.
    const parentLog = [context('recorded', 'text-model', { contextWindow: 50_000, inputModalities: ['text'] })]
    const childLog = [context('recorded', 'vision-model', { contextWindow: 60_000, inputModalities: ['text', 'image'] })]
    // Registered under the provider the LOG names, which is what `providersIn`
    // does for every real caller: the route key is provider/model on both sides.
    const replay = installLlmReplay(harness.root, { events: parentLog, children: [{ id: 'child', events: childLog }] })
    const llm = harness.root.get(LLM)
    expect(replay.providers).toEqual(['recorded'])
    expect(llm.resolveModel('recorded', 'text-model').inputModalities).toEqual(['text'])
    expect(llm.resolveModel('recorded', 'vision-model').inputModalities).toEqual(['text', 'image'])
    expect(llm.resolveModel('recorded', 'vision-model').contextWindow).toBe(60_000)
    // A route the log never recorded modalities for stays absent, which reads as text only.
    expect(llm.resolveModel('recorded', 'never-recorded').inputModalities).toBeUndefined()
    await replay.dispose()
  })
})

describe('llm-replay: effects recorded', () => {
  /** A tool whose body counts, so a replay that ran it cannot hide. */
  function counting(): { tool: typeof echo; runs: { value: number } } {
    const runs = { value: 0 }
    const tool = defineTool({
      name: 'echo',
      description: 'echo',
      input: z.object({ text: z.string() }),
      output: z.object({ echoed: z.string() }),
      execute: (args) => {
        runs.value += 1
        return { echoed: `${args.text} (live)` }
      },
      render: (_args, value) => [{ type: 'text', text: value.echoed }],
    })
    return { tool, runs }
  }

  async function replayed(events: readonly import('../core/session/index.ts').EventEnvelope[], withTool = true) {
    const harness = await coreHarness()
    harnesses.push(harness)
    const replay = installLlmReplay(harness.root, { events, provider: 'replay', effects: 'recorded' })
    const { tool, runs } = counting()
    if (withTool) harness.root.get(TOOLS).register(harness.root, tool)
    const handle = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    handle.agent.followup(createUserMessage('run it'))
    await handle.agent.whenIdle()
    return { replay, runs, handle }
  }

  it('answers every call from the recording: no body runs and no tool/dispatch is written', async () => {
    const recorded = await record()
    const { replay, runs, handle } = await replayed(recorded.events)
    replay.assertConsumed()
    expect(runs.value).toBe(0)
    const types = handle.agent.session.events.map((event) => event.type)
    expect(types).not.toContain('tool/dispatch')
    // The recorded answer, not the live body's.
    const result = handle.agent.session.events.find((event) => event.type === 'tool/result')!
    expect(JSON.stringify(result.data)).toContain('pong')
    expect(JSON.stringify(result.data)).not.toContain('(live)')
    await handle.dispose()
  })

  it('fails the oracle when the replay refuses a call the recording answered with a body', async () => {
    const recorded = await record()
    // No echo tool registered here: the replay answers UNKNOWN_TOOL before any
    // body, so the recorded answer is never asked for.
    const { replay, handle } = await replayed(recorded.events, false)
    expect(() => replay.assertConsumed()).toThrowError(/recorded tool answer\(s\) were never asked for: 1:1:c1/)
    await handle.dispose()
  })

  it('refuses a log with a repaired interruption, and refuses children', async () => {
    const recorded = await record()
    const harness = await coreHarness()
    harnesses.push(harness)
    const repaired = [
      ...recorded.events,
      { type: 'turn/end', seq: recorded.events.length, time: 1, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ]
    expect(() => installLlmReplay(harness.root, { events: repaired, provider: 'replay', effects: 'recorded' })).toThrowError(/repaired interruption/)
    expect(() => installLlmReplay(harness.root, { events: recorded.events, children: [{ id: 'child', events: recorded.events }], provider: 'replay', effects: 'recorded' })).toThrowError(
      /never runs a child/,
    )
  })

  it('refuses every repair closer, not only an interrupted turn: a lost job, an interrupted child, an unclosed compaction', async () => {
    // Each is written by crash repair (or a fork) about a writer that died,
    // so the log beside it is not all a body's account either.
    const recorded = await record()
    const harness = await coreHarness()
    harnesses.push(harness)
    const n = recorded.events.length
    for (const closer of [
      { type: 'job/end', seq: n, time: 1, data: { jobId: 'j1', cause: 'lost' } },
      { type: 'subagent/end', seq: n, time: 1, data: { callId: 'c9', childId: 'child', reason: { kind: 'interrupted' } } },
      { type: 'compaction/end', seq: n, time: 1, data: { startSeq: 3, outcome: { kind: 'declined', reason: 'unclosed' } } },
    ]) {
      expect(() => installLlmReplay(harness.root, { events: [...recorded.events, closer], provider: 'replay', effects: 'recorded' }), closer.type).toThrowError(/repaired interruption/)
    }
  })

  it('leaves its recording, and says how, when a call is a different tool here than there', async () => {
    const recorded = await record()
    // The recording's tool/call names "renamed"; the replayed model still calls "echo".
    const renamed = recorded.events.map((event) => (event.type === 'tool/call' ? { ...event, data: { ...(event.data as object), name: 'renamed' } } : event))
    const { replay, runs, handle } = await replayed(renamed)
    expect(runs.value).toBe(0)
    expect(() => replay.assertConsumed()).toThrowError(/left its recording: call 1:1:c1 is "echo" here and "renamed" in the recording/)
    await handle.dispose()
  })

  it('leaves its recording when a call the recording refused before any body reaches one here', async () => {
    // Recorded with no echo tool: UNKNOWN_TOOL at the gate, no tool/dispatch,
    // in a lifecycle that claims it records dispatches — provably no body.
    const harness = await coreHarness()
    harnesses.push(harness)
    harness.adapter.script(assistantToolCall('c1', 'echo', { text: 'pong' }), assistantText('recorded answer'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('run it'))
    await agent.whenIdle()
    const recordedEvents = agent.session.events.map((event) => ({ ...event }))
    expect(recordedEvents.some((event) => event.type === 'tool/dispatch')).toBe(false)
    // Replayed with the gate lifted: echo is registered now.
    const { replay, runs, handle } = await replayed(recordedEvents)
    expect(runs.value).toBe(0)
    expect(() => replay.assertConsumed()).toThrowError(/call 1:1:c1 \(echo\) reached a body here, and the recording refused it before one/)
    await handle.dispose()
  })

  it('serves an undispatched call that reaches a body when its lifecycle claims nothing, though the segment holds a dispatch', async () => {
    // Record two calls in one step: echo runs (dispatched), `missing` is
    // refused at the gate (undispatched). Then strip the lifecycle's claim, as
    // an S14–S15 writer recorded dispatches without claiming them.
    const harness = await coreHarness()
    harnesses.push(harness)
    harness.root.get(TOOLS).register(harness.root, echo)
    harness.adapter.script(twoCalls(), assistantText('recorded answer'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('run it'))
    await agent.whenIdle()
    const claimless = agent.session.events.map((event) =>
      event.type === 'session/lifecycle' ? { ...event, data: { ...(event.data as Record<string, unknown>), dispatch: undefined } } : { ...event },
    )
    expect(claimless.filter((event) => event.type === 'tool/dispatch')).toHaveLength(1)
    // Replayed with `missing` registered, so its call reaches a body: the
    // claim says nothing either way, so the recorded answer is served — a
    // presence rule would read "no dispatch" as proof and refuse it.
    const replayHarness = await coreHarness()
    harnesses.push(replayHarness)
    const replay = installLlmReplay(replayHarness.root, { events: claimless, provider: 'replay', effects: 'recorded' })
    const { tool, runs } = counting()
    replayHarness.root.get(TOOLS).register(replayHarness.root, tool)
    replayHarness.root.get(TOOLS).register(replayHarness.root, defineTool({ ...missingTool, execute: () => ((runs.value += 1), { echoed: 'live' }) }))
    const handle = await replayHarness.root.get(AGENTS).create(replayHarness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    handle.agent.followup(createUserMessage('run it'))
    await handle.agent.whenIdle()
    expect(runs.value).toBe(0)
    replay.assertConsumed()
    await handle.dispose()
  })

  it('advertises every effort the recording ran at, so a recording at one the default set lacks still replays as recorded', async () => {
    const harness = await coreHarness()
    harnesses.push(harness)
    harness.adapter.script(assistantText('at medium'))
    const { agent } = await harness.create({ reasoningEffort: 'medium' })
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    const replayHarness = await coreHarness()
    harnesses.push(replayHarness)
    installLlmReplay(replayHarness.root, { events: agent.session.events.map((event) => ({ ...event })), provider: 'replay', effects: 'recorded' })
    expect(replayHarness.root.get(LLM).resolveModel('replay', 'scripted-model').reasoning.efforts).toContain('medium')
  })
})

const missingTool = {
  name: 'missing',
  description: 'absent when recorded',
  input: z.object({}),
  output: z.object({ echoed: z.string() }),
  render: (_args: unknown, value: { echoed: string }) => [{ type: 'text' as const, text: value.echoed }],
}

/** One step calling echo and `missing` together. */
function twoCalls(): StreamChunk[] {
  return callsInOneStep(['c1', 'echo', { text: 'pong' }], ['c2', 'missing', {}])
}

/** One step making every given call at once, in order. */
function callsInOneStep(...calls: readonly (readonly [callId: string, name: string, args: object])[]): StreamChunk[] {
  return [
    ...calls.flatMap(([callId, name, args], index): StreamChunk[] => {
      const argsText = JSON.stringify(args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id: asCallId(callId), name, argumentsDelta: argsText },
        { type: 'block-end', index, block: { type: 'tool-call', id: asCallId(callId), name, arguments: argsText } },
      ]
    }),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
