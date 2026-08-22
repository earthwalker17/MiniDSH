/**
 * The scope contract: registration origin decides visibility and lifetime.
 * A registration or listener made through agent A's context is visible to A
 * alone — for tool definitions, guards, prompt sections and variables, and for
 * every event about an agent's operation (tools/*, approval/request,
 * system-prompt/assemble, fs/*). Unscoped registrations see every agent.
 */
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { fsLocalPlugin } from '../capabilities/fs-local/index.ts'
import { coreHarness, type CoreHarness } from '../test-support/harness.ts'
import type { Agent } from './agent/index.ts'
import { APPROVAL, APPROVAL_REQUEST, type ApprovalOutcome } from './approval/index.ts'
import { FS, FS_OBSERVED } from './fs/index.ts'
import { PROMPT, SYSTEM_PROMPT_ASSEMBLE, type PromptDraft } from './prompt/index.ts'
import { defineTool, toolCall, TOOLS, TOOLS_PRE_EXECUTE, TOOLS_RESULT, type PreToolDecision } from './tools/index.ts'

const probe = defineTool({
  name: 'probe',
  description: 'probe',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  execute: () => ({ ok: true }),
  render: () => [{ type: 'text', text: 'ok' }],
})

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function twoAgents() {
  harness = await coreHarness()
  const a = (await harness.create()).agent
  const b = (await harness.create()).agent
  const root = harness.root
  return { root, a, b, tools: root.get(TOOLS), prompt: root.get(PROMPT), signal: new AbortController().signal }
}

describe('scope contract', () => {
  it('tools/* events about agent A reach unscoped and A-scoped listeners, never B-scoped ones', async () => {
    const { root, a, b, tools, signal } = await twoAgents()
    tools.register(root, probe)
    const scoped: string[] = []
    const unscoped: string[] = []
    const results: string[] = []
    a.ctx.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => {
      scoped.push(execution.agent!.id)
      return next()
    })
    root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => {
      unscoped.push(execution.agent!.id)
      return next()
    })
    b.ctx.on(TOOLS_RESULT, (execution) => void results.push(execution.agent!.id))

    await tools.execute(toolCall('c1', 'probe', '{}', a, signal))
    await tools.execute(toolCall('c2', 'probe', '{}', b, signal))
    expect(scoped).toEqual([a.id])
    expect(unscoped).toEqual([a.id, b.id])
    expect(results).toEqual([b.id])
  })

  it('a guard registered through an agent context denies that agent alone', async () => {
    const { root, a, b, tools, signal } = await twoAgents()
    tools.register(root, probe)
    tools.guard(a.ctx, () => 'not for A')
    const forA = await tools.execute(toolCall('c1', 'probe', '{}', a, signal))
    const forB = await tools.execute(toolCall('c2', 'probe', '{}', b, signal))
    expect(forA.isError).toBe(true)
    expect(forA.error?.info?.code).toBe('DENIED')
    expect(forB.isError).toBe(false)
  })

  it('prompt sections and variables registered through an agent context are visible to that agent alone and shadow same-named globals', async () => {
    const { root, a, b, prompt } = await twoAgents()
    // The harness registers a global 'persona' section; A shadows it (a subagent persona).
    prompt.section(a.ctx, { name: 'persona', order: 0, text: 'I am agent A.' })
    prompt.variable(root, 'who', () => 'everyone')
    prompt.variable(a.ctx, 'who', () => 'A')
    prompt.section(root, { name: 'who', order: 10, text: 'who={{who}}' })

    const forA = (await prompt.assemble(a)).system
    const forB = (await prompt.assemble(b)).system
    expect(forA).toContain('I am agent A.')
    expect(forA).not.toContain('test agent')
    expect(forA).toContain('who=A')
    expect(forB).toContain('test agent')
    expect(forB).not.toContain('I am agent A.')
    expect(forB).toContain('who=everyone')
  })

  it('system-prompt/assemble listeners registered through an agent context run for that agent alone', async () => {
    const { a, b, prompt } = await twoAgents()
    a.ctx.on(SYSTEM_PROMPT_ASSEMBLE, async (_draft, next): Promise<PromptDraft> => {
      const base = await next()
      return { ...base, sections: [...base.sections, { name: 'extra', order: 99, text: 'EXTRA-FOR-A' }] }
    })
    expect((await prompt.assemble(a)).system).toContain('EXTRA-FOR-A')
    expect((await prompt.assemble(b)).system).not.toContain('EXTRA-FOR-A')
  })

  it('an approval answerer registered through an agent context answers that agent alone', async () => {
    const { root, a, b } = await twoAgents()
    a.ctx.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'allowed-once')
    const approval = root.get(APPROVAL)
    expect(await approval.request({ agent: a, toolName: 'probe' })).toBe('allowed-once')
    expect(await approval.request({ agent: b, toolName: 'probe' })).toBe('unavailable')
  })

  it('fs/observed is dispatched in the acting agent scope', async () => {
    const { root, a, b } = await twoAgents()
    root.plugin(fsLocalPlugin)
    await root.settle()
    const fs = root.get(FS)
    const seen: string[] = []
    a.ctx.on(FS_OBSERVED, (_target, _observation, actor) => void seen.push((actor.agent as Agent).id))
    const target = fs.resolve('package.json', process.cwd())
    await fs.readText(target, { agent: a })
    await fs.readText(target, { agent: b })
    expect(seen).toEqual([a.id])
  })

  it('refuses registrations through a non-object scope tag instead of filing them globally', async () => {
    const { root, tools, prompt } = await twoAgents()
    const weird = root.child({ scope: 'sub-1' })
    expect(() => tools.register(weird, probe)).toThrowError(/scope tag must be an object/)
    expect(() => prompt.section(weird, { name: 'x', order: 0, text: 'x' })).toThrowError(/scope tag must be an object/)
    expect(tools.get('probe')).toBeUndefined()
  })
})
