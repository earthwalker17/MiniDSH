import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { APPROVAL_REQUEST } from '../approval/index.ts'
import type { Agent } from '../agent/types.ts'
import { defineTool, TOOLS, TOOLS_POST_EXECUTE, TOOLS_PRE_EXECUTE, toolCall, type Tools } from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const upper = defineTool({
  name: 'upper',
  description: 'uppercase text',
  input: z.object({ text: z.string() }),
  output: z.object({ result: z.string() }),
  execute: (args) => ({ result: args.text.toUpperCase() }),
  render: (_args, value) => [{ type: 'text', text: value.result }],
})

async function setup(): Promise<{ tools: Tools; agent: Agent; signal: AbortSignal }> {
  harness = await coreHarness()
  const tools = harness.root.get(TOOLS)
  const { agent } = await harness.create()
  return { tools, agent, signal: new AbortController().signal }
}

function call(name: string, args: object, agent: Agent, signal: AbortSignal) {
  return toolCall('c1', name, JSON.stringify(args), agent, signal)
}

describe('tool registry', () => {
  it('projects only name/description/parameters to the model, deterministically ordered', async () => {
    const { tools } = await setup()
    tools.register(harness!.root, upper)
    tools.register(harness!.root, { ...upper, name: 'aaa' })
    const schemas = tools.schemas()
    expect(schemas.map((s) => s.name)).toEqual(['aaa', 'upper'])
    expect(Object.keys(schemas[0]!)).toEqual(['name', 'description', 'parameters'])
    expect(schemas[1]!.parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
  })

  it('scoped registrations shadow globals for their agent only', async () => {
    const { tools, agent } = await setup()
    tools.register(harness!.root, upper)
    // Register a same-named tool through the agent's scoped context.
    tools.register(agent.ctx, { ...upper, description: 'scoped variant' })
    expect(tools.get('upper')?.description).toBe('uppercase text')
    expect(tools.get('upper', agent)?.description).toBe('scoped variant')
  })

  it('removes a tool when its owning context disposes', async () => {
    const { tools } = await setup()
    const child = harness!.root.child({ label: 'owner' })
    tools.register(child, upper)
    expect(tools.get('upper')).toBeDefined()
    await child.dispose()
    expect(tools.get('upper')).toBeUndefined()
  })
})

describe('tool execution pipeline', () => {
  it('validates arguments against the schema (INVALID_ARGS)', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, upper)
    const result = await tools.execute(call('upper', { text: 42 }, agent, signal))
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('normalizes an unknown tool into an isError result', async () => {
    const { tools, agent, signal } = await setup()
    const result = await tools.execute(call('ghost', {}, agent, signal))
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('runs the body and renders the value on the happy path', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, upper)
    const result = await tools.execute(call('upper', { text: 'hi' }, agent, signal))
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'HI' }])
    expect(result.value).toEqual({ result: 'HI' })
  })

  it('denies via tools/pre-execute', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, upper)
    harness!.root.on(TOOLS_PRE_EXECUTE, async () => ({ kind: 'deny', reason: 'not allowed' }))
    const result = await tools.execute(call('upper', { text: 'x' }, agent, signal))
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('DENIED')
  })

  it('routes ask to the approval seam; allowed-once proceeds, otherwise denies', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, upper)
    harness!.root.on(TOOLS_PRE_EXECUTE, async () => ({ kind: 'ask' }))
    let outcome: 'allowed-once' | 'rejected' = 'allowed-once'
    harness!.root.on(APPROVAL_REQUEST, async () => outcome)
    expect((await tools.execute(call('upper', { text: 'x' }, agent, signal))).isError).toBe(false)
    outcome = 'rejected'
    expect((await tools.execute(call('upper', { text: 'x' }, agent, signal))).isError).toBe(true)
  })

  it('fails closed when an ask has no answerer', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, upper)
    harness!.root.on(TOOLS_PRE_EXECUTE, async () => ({ kind: 'ask' }))
    const result = await tools.execute(call('upper', { text: 'x' }, agent, signal))
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('DENIED')
  })

  it('blocks via tools/post-execute', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, upper)
    harness!.root.on(TOOLS_POST_EXECUTE, async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }))
    const result = await tools.execute(call('upper', { text: 'x' }, agent, signal))
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('BLOCKED')
  })

  it('normalizes a thrown tool body into an isError result', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, {
      ...upper,
      name: 'boom',
      execute: () => {
        throw new Error('kaboom')
      },
    })
    const result = await tools.execute(call('boom', { text: 'x' }, agent, signal))
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Error: kaboom' })
  })

  it('applies monotonic guards after pre-execute', async () => {
    const { tools, agent, signal } = await setup()
    tools.register(harness!.root, upper)
    tools.guard(harness!.root, (execution) => (execution.name === 'upper' ? 'guarded off' : undefined))
    const result = await tools.execute(call('upper', { text: 'x' }, agent, signal))
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('DENIED')
  })
})
