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

describe('agent creation', () => {
  it('rolls back a throwing setup: no session, no agent, no scope left behind', async () => {
    harness = await coreHarness()
    const { SESSIONS } = await import('../session/index.ts')
    const agents = harness.root.get(AGENTS)
    await expect(
      agents.create(harness.root, {
        cwd: process.cwd(),
        agentOptions: { provider: 'scripted', model: 'scripted-model' },
        setup: () => {
          throw new Error('bad setup')
        },
      }),
    ).rejects.toThrowError(/bad setup/)
    expect(agents.list()).toEqual([])
    expect(harness.root.get(SESSIONS).list()).toEqual([])
  })

  it('publishes the session only after the agent, so session/created can resolve its owner', async () => {
    harness = await coreHarness()
    const { SESSION_CREATED } = await import('../session/index.ts')
    const { AGENT_CREATED } = await import('../agent/index.ts')
    const agents = harness.root.get(AGENTS)
    const order: string[] = []
    harness.root.on(AGENT_CREATED, (agent) => void order.push(`agent:${agent.id}`))
    harness.root.on(SESSION_CREATED, (session) => {
      order.push(`session:${session.id}:${agents.get(session.id) ? 'owner-visible' : 'orphan'}`)
    })
    const handle = await harness.create()
    const id = handle.agent.id
    expect(order).toEqual([`agent:${id}`, `session:${id}:owner-visible`])
    expect(handle.agent.session.origin).toBe('new')
    await handle.dispose()
  })

  it('publishes the agent only once everything mounted during setup is active, and fails loud otherwise', async () => {
    harness = await coreHarness()
    const agents = harness.root.get(AGENTS)
    const tools = harness.root.get(TOOLS)
    const scopedTool = defineTool({
      name: 'scoped',
      description: 'scoped',
      input: z.object({}),
      output: z.object({}),
      execute: () => ({}),
      render: () => [],
    })
    const handle = await agents.create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      setup: (agentCtx) => {
        agentCtx.plugin({
          name: 'slow-scoped-tool',
          inject: [TOOLS],
          async apply(ctx) {
            await new Promise((resolve) => setTimeout(resolve, 20))
            ctx.get(TOOLS).register(ctx, scopedTool)
          },
        })
      },
    })
    expect(tools.get('scoped', handle.agent)).toBeDefined()
    expect(tools.get('scoped')).toBeUndefined()
    await handle.dispose()

    const { SESSIONS } = await import('../session/index.ts')
    await expect(
      agents.create(harness.root, {
        cwd: process.cwd(),
        agentOptions: { provider: 'scripted', model: 'scripted-model' },
        setup: (agentCtx) => {
          agentCtx.plugin({
            name: 'broken-scoped',
            apply: () => {
              throw new Error('cannot mount')
            },
          })
        },
      }),
    ).rejects.toThrowError(/did not settle/)
    expect(agents.list()).toEqual([])
    expect(harness.root.get(SESSIONS).list()).toEqual([])
  })

  it('hands setup the unpublished agent, whose session is appendable before publication', async () => {
    harness = await coreHarness()
    const { SESSIONS, eventKind } = await import('../session/index.ts')
    const SEEDED = eventKind<{ from: string }>('test/seeded')
    const agents = harness.root.get(AGENTS)
    const sessions = harness.root.get(SESSIONS)
    let seen: string[] = []
    const handle = await agents.create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      setup: (agentCtx, agent) => {
        seen = [String(agentCtx.scope === agent), String(agents.get(agent.id) === undefined), String(sessions.get(agent.id) === undefined)]
        agent.session.append(SEEDED, { from: 'setup' })
      },
    })
    expect(seen).toEqual(['true', 'true', 'true'])
    expect(handle.agent.session.events.map((event) => event.type)).toContain('test/seeded')
    await handle.dispose()
  })

  it('a per-agent preset that reaches into a deployment-global registry fails its agent setup loudly', async () => {
    harness = await coreHarness()
    const { LLM } = await import('../llm/index.ts')
    const { INVARIANTS } = await import('../invariants/index.ts')
    const { ScriptedAdapter } = await import('../../test-support/scripted-adapter.ts')
    const agents = harness.root.get(AGENTS)
    const create = (name: string, mount: (agentCtx: Parameters<NonNullable<Parameters<typeof agents.create>[1]['setup']>>[0]) => void) =>
      agents.create(harness!.root, {
        cwd: process.cwd(),
        agentOptions: { provider: 'scripted', model: 'scripted-model' },
        setup: (agentCtx) => void agentCtx.plugin({ name, inject: [LLM, INVARIANTS], apply: (ctx) => mount(ctx) }),
      })
    await expect(create('preset-adapter', (ctx) => void ctx.get(LLM).registerAdapter(ctx, new ScriptedAdapter({ provider: 'preset' })))).rejects.toThrowError(
      /did not settle.*preset-adapter/,
    )
    expect(harness.root.get(LLM).hasProvider('preset')).toBe(false)
    await expect(create('preset-invariant', (ctx) => void ctx.get(INVARIANTS).register(ctx, 'preset-owned', () => {}))).rejects.toThrowError(
      /did not settle.*preset-invariant/,
    )
    expect(agents.list()).toEqual([])
  })

  it('binds the agent lifetime to its owner context, without leaking a record on explicit dispose', async () => {
    harness = await coreHarness()
    const { SESSIONS } = await import('../session/index.ts')
    const agents = harness.root.get(AGENTS)
    const sessions = harness.root.get(SESSIONS)
    const owner = harness.root.child({ label: 'surface' })
    const before = owner.effects().length

    const explicit = await agents.create(owner, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    expect(owner.effects().length).toBe(before + 1)
    await explicit.dispose()
    expect(owner.effects().length).toBe(before)

    const ownerBound = await agents.create(owner, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    const id = ownerBound.agent.id
    await owner.dispose()
    expect(agents.get(id)).toBeUndefined()
    expect(sessions.get(id)).toBeUndefined()
    await ownerBound.dispose() // idempotent after the owner-driven disposal
  })

  it('disposes a live agent when the loop plugin that owns its scope unloads, world first, then the registry', async () => {
    harness = await coreHarness()
    const { AGENT_DISPOSED } = await import('../agent/index.ts')
    const { SESSIONS } = await import('../session/index.ts')
    const agents = harness.root.get(AGENTS)
    const handle = await agents.create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    const id = handle.agent.id
    const order: string[] = []
    handle.agent.ctx.effect(() => () => void order.push('scope-unwound'))
    harness.root.on(AGENT_DISPOSED, () => void order.push('agent/disposed'))
    await harness.loop.dispose()
    expect(order).toEqual(['scope-unwound', 'agent/disposed'])
    expect(agents.get(id)).toBeUndefined()
    expect(harness.root.get(SESSIONS).get(id)).toBeUndefined()
    await handle.dispose() // idempotent after the loop-driven disposal
  })

  it('a concurrent dispose resolves only once the agent is fully gone', async () => {
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
    harness.adapter.script(assistantToolCall('c1', 'hang', {}))
    const agents = harness.root.get(AGENTS)
    const owner = harness.root.child({ label: 'surface' })
    const handle = await agents.create(owner, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    handle.agent.followup(createUserMessage('go'))
    await waitFor(() => handle.agent.session.events.some((event) => event.type === 'tool/call'))
    const ownerGone = owner.dispose()
    await handle.dispose()
    expect(handle.agent.status).toBe('idle')
    expect(agents.get(handle.agent.id)).toBeUndefined()
    await ownerGone
  })

  it('a rolled-back creation leaves no session file behind', async () => {
    harness = await coreHarness()
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { persistenceJsonlPlugin } = await import('../../capabilities/persistence-jsonl/index.ts')
    const root = mkdtempSync(join(tmpdir(), 'minidsh-rollback-'))
    try {
      harness.root.plugin(persistenceJsonlPlugin, { root })
      await harness.root.settle()
      await expect(
        harness.root.get(AGENTS).create(harness.root, {
          cwd: process.cwd(),
          agentOptions: { provider: 'scripted', model: 'scripted-model' },
          setup: () => {
            throw new Error('bad setup')
          },
        }),
      ).rejects.toThrowError(/bad setup/)
      expect(readdirSync(root).filter((name) => name.endsWith('.jsonl'))).toEqual([])
    } finally {
      await harness.dispose()
      harness = undefined
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

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
      'agent/options', // the base route, recorded at creation
      'approval/policy', // the opening authority, recorded at creation
      'sandbox/mode',
      'inbox/spliced', // the followup's durable insert
      'turn/start',
      'request/context', // the step's route and window, before its pre-step listeners
      'step/start',
      'user/message',
      'inbox/spliced', // the claim, committed after the entered message
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
    // The claim is committed with the block that consumed it: durable = live.
    expect(types(agent.session.events)).toEqual(['agent/options', 'approval/policy', 'sandbox/mode', 'inbox/spliced', 'turn/start', 'request/context', 'inbox/spliced', 'turn/end'])
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

  it('logs a new request/header when an agent/request listener changes the temperature', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('one'), assistantText('two'))
    const { agent } = await harness.create()
    const { AGENT_REQUEST } = await import('../agent/index.ts')
    let temperature = 0.1
    agent.ctx.on(AGENT_REQUEST, async (_context, next) => ({ ...(await next()), temperature }))
    agent.followup(createUserMessage('first'))
    await agent.whenIdle()
    temperature = 0.9
    agent.followup(createUserMessage('second'))
    await agent.whenIdle()
    const headers = agent.session.events
      .filter((event) => event.type === 'request/header')
      .map((event) => (event.data as { header: { temperature?: number } }).header.temperature)
    expect(headers).toEqual([0.1, 0.9])
    expect(harness.adapter.calls.map((call) => call.temperature)).toEqual([0.1, 0.9])
  })

  it('a followup that lands during cancellation is not lost', async () => {
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
    harness.adapter.script(assistantToolCall('c1', 'hang', {}), assistantText('after'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await waitFor(() => agent.session.events.some((event) => event.type === 'tool/call'))
    agent.cancel({ kind: 'user' })
    // Arrives after cancel() but before the cancelled turn has converged.
    agent.followup(createUserMessage('again'))
    await agent.whenIdle()
    const reasons = agent.session.events
      .filter((event) => event.type === 'turn/end')
      .map((event) => (event.data as { reason: { kind: string } }).reason.kind)
    expect(reasons).toEqual(['cancelled', 'completed'])
    expect(messageText(agent.session.deriveMessages().at(-1)!)).toBe('after')
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
    // Injection alone does not wake the driver; its durable insert is the only fact.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agent.session.events.map((event) => event.type)).toEqual(['agent/options', 'approval/policy', 'sandbox/mode', 'inbox/spliced'])
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    const userMessages = agent.session.deriveMessages().filter((message) => message.role === 'user')
    expect(userMessages).toHaveLength(2)
    expect(userMessages.some((message) => message.source.kind === 'plugin')).toBe(true)
  })
})

describe('the route as durable facts', () => {
  it('writes request/context before the first pre-step, and again only when the route or its window changes', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('one'), assistantText('two'))
    const { AGENT_PRE_STEP } = await import('../agent/index.ts')
    const { foldRequestContext, REQUEST_CONTEXT } = await import('../session/index.ts')
    const { agent } = await harness.create()
    const seenAtPreStep: unknown[] = []
    harness.root.on(
      AGENT_PRE_STEP,
      async (context, next) => {
        seenAtPreStep.push(foldRequestContext(context.agent.session.facts))
        return next()
      },
      { global: true },
    )
    agent.followup(createUserMessage('first'))
    await agent.whenIdle()
    agent.followup(createUserMessage('second'))
    await agent.whenIdle()
    // The scripted adapter advertises a 100k window, and the record named the
    // route AND the window before the first pre-step listener ran — which is
    // what lets a pressure check measure against the route this step uses.
    expect(seenAtPreStep[0]).toEqual({ provider: 'scripted', model: 'scripted-model', contextWindow: 100_000 })
    expect(agent.session.events.filter((event) => event.type === REQUEST_CONTEXT.type)).toHaveLength(1)
  })

  /**
   * The gate compares the WHOLE record, not a named list of fields.
   *
   * With a three-field comparison, a field added to `RequestContextRecord` is
   * never written on a resumed session whose provider, model and window are
   * unchanged — so it is inherited as ABSENT for the life of that session. For
   * `inputModalities` that is not cosmetic: absent means text only, so a session
   * resumed on a vision route would refuse its own images forever and explain it
   * with the wrong reason.
   */
  it('rewrites request/context when any field of it changes, not only the three it used to compare', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('one'), assistantText('two'))
    const { REQUEST_CONTEXT } = await import('../session/index.ts')
    const { agent } = await harness.create()
    agent.followup(createUserMessage('first'))
    await agent.whenIdle()
    // Same provider, same model, same window — only the modalities move.
    const resolve = harness.adapter.resolveModel.bind(harness.adapter)
    harness.adapter.resolveModel = (model: string) => ({ ...resolve(model), inputModalities: ['text', 'image'] as const })
    agent.followup(createUserMessage('second'))
    await agent.whenIdle()
    const records = agent.session.events.filter((event) => event.type === REQUEST_CONTEXT.type).map((event) => event.data)
    expect(records).toHaveLength(2)
    expect(records[0]).not.toHaveProperty('inputModalities')
    expect(records[1]).toMatchObject({ provider: 'scripted', model: 'scripted-model', contextWindow: 100_000, inputModalities: ['text', 'image'] })
  })

  it('configure is one durable switch: logged iff it changes, effective at the next step, and an unnamed effort dies with a route change', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('one'), assistantText('two'))
    const { AGENT_OPTIONS } = await import('../agent/index.ts')
    const { agent } = await harness.create({ reasoningEffort: 'high' })
    agent.followup(createUserMessage('first'))
    await agent.whenIdle()
    // A restatement is not a switch.
    expect(agent.configure({ reasoningEffort: 'high' })).toBe(agent.options)
    const switched = agent.configure({ model: 'other-model' })
    expect(switched).toEqual({ provider: 'scripted', model: 'other-model' })
    expect(agent.options).toBe(switched)
    agent.followup(createUserMessage('second'))
    await agent.whenIdle()
    const records = agent.session.events.filter((event) => event.type === AGENT_OPTIONS.type).map((event) => event.data)
    expect(records).toEqual([
      { options: { provider: 'scripted', model: 'scripted-model', reasoningEffort: 'high' }, reason: 'initial' },
      { options: { provider: 'scripted', model: 'other-model' }, reason: 'change' },
    ])
    expect(harness.adapter.calls.map((call) => [call.model, call.reasoningEffort])).toEqual([
      ['scripted-model', 'high'],
      ['other-model', undefined],
    ])
    const routes = agent.session.events.filter((event) => event.type === 'request/context').map((event) => (event.data as { model: string }).model)
    expect(routes).toEqual(['scripted-model', 'other-model'])
  })

  it('a listener rewriting the route is consulted before pre-step and never touches the base', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('one'))
    const { AGENT_OPTIONS, AGENT_REQUEST } = await import('../agent/index.ts')
    harness.root.on(AGENT_REQUEST, async (_context, next) => ({ ...(await next()), model: 'cheap-model' }), { global: true })
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    expect(harness.adapter.calls[0]!.model).toBe('cheap-model')
    expect((agent.session.events.find((event) => event.type === 'request/context')!.data as { model: string }).model).toBe('cheap-model')
    expect(agent.session.foldRequestHeader()!.model).toBe('cheap-model')
    // The effective route is the header's and the context record's; the base is untouched.
    expect(agent.options.model).toBe('scripted-model')
    expect(agent.session.events.filter((event) => event.type === AGENT_OPTIONS.type)).toHaveLength(1)
  })
})

describe('creation under a signal, and the world a child can join', () => {
  it('rolls back a creation whose signal was aborted during setup: no agent, no session', async () => {
    harness = await coreHarness()
    const { SESSIONS } = await import('../session/index.ts')
    const agents = harness.root.get(AGENTS)
    const controller = new AbortController()
    await expect(
      agents.create(harness.root, {
        cwd: process.cwd(),
        agentOptions: { provider: 'scripted', model: 'scripted-model' },
        signal: controller.signal,
        setup: () => controller.abort(),
      }),
    ).rejects.toThrowError(/aborted during setup/)
    expect(agents.list()).toEqual([])
    expect(harness.root.get(SESSIONS).list()).toEqual([])
    await expect(
      agents.create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' }, signal: AbortSignal.abort() }),
    ).rejects.toThrowError(/before it began/)
  })

  it('exposes the inheritable world it was composed with, and records lineage and preset in its header', async () => {
    harness = await coreHarness()
    const { asSessionId } = await import('../ids.ts')
    const world = (): void => {}
    const handle = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      world,
      delegatedBy: asSessionId('session-parent'),
      delegationDepth: 1,
      agentPreset: 'reviewer',
    })
    expect(handle.agent.world).toBe(world)
    expect(handle.agent.session.header).toMatchObject({ delegatedBy: 'session-parent', delegationDepth: 1, agentPreset: 'reviewer' })
    expect(handle.agent.session.header).not.toHaveProperty('parentId')
    await handle.dispose()
  })
})
