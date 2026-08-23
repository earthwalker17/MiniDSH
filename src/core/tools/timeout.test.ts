/**
 * Tool deadlines. A tool that never returns must not be able to hold the loop,
 * and a human deliberating over an approval must not spend the tool's budget.
 */
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { APPROVAL_REQUEST, type ApprovalOutcome } from '../approval/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE, toolCall, type PreToolDecision } from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const never = new AbortController().signal

/** A tool whose body hangs until its own signal aborts (or forever, if told to ignore it). */
function hangingTool(name: string, timeoutMs: number | null | undefined, options: { cooperative?: boolean } = {}) {
  return defineTool({
    name,
    description: 'hangs',
    input: z.object({}),
    output: z.object({ done: z.string() }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    render: (_args, value) => [{ type: 'text', text: value.done }],
    execute: (_args, exec) =>
      new Promise((resolve) => {
        if (options.cooperative !== false) exec.signal.addEventListener('abort', () => resolve({ done: 'aborted' }), { once: true })
      }),
  })
}

async function run(name: string, args: object = {}) {
  const { agent } = await harness!.create()
  const result = await harness!.root.get(TOOLS).execute(toolCall('call-1', name, JSON.stringify(args), agent, never))
  return { agent, isError: result.isError, code: result.error?.info?.code, text: result.content.map((b) => (b.type === 'text' ? b.text : '')).join('') }
}

describe('tool deadlines', () => {
  it('ends a call that never returns, with a code that names the failure', async () => {
    harness = await coreHarness()
    harness.root.get(TOOLS).register(harness.root, hangingTool('stuck', 40, { cooperative: false }))
    const result = await run('stuck')
    expect(result.isError).toBe(true)
    expect(result.code).toBe('TOOL_TIMEOUT')
    expect(result.text).toContain('timed out after 40ms')
  })

  it('aborts the body it gave up on, so a cooperative tool can release what it holds', async () => {
    harness = await coreHarness()
    let released = false
    harness.root.get(TOOLS).register(
      harness.root,
      defineTool({
        name: 'polite',
        description: 'hangs politely',
        input: z.object({}),
        output: z.object({ done: z.string() }),
        timeoutMs: 40,
        render: (_args, value) => [{ type: 'text', text: value.done }],
        execute: (_args, exec) =>
          new Promise((resolve) => {
            exec.signal.addEventListener('abort', () => {
              released = true
              resolve({ done: 'late' })
            })
          }),
      }),
    )
    const result = await run('polite')
    // The deadline decides the outcome; the late result is discarded.
    expect(result.code).toBe('TOOL_TIMEOUT')
    expect(released).toBe(true)
  })

  it('applies the registry default to a tool that declares none', async () => {
    harness = await coreHarness()
    harness.root.get(TOOLS).register(harness.root, hangingTool('defaulted', undefined, { cooperative: false }))
    // The default is minutes long, so the call must still be running.
    const { agent } = await harness.create()
    const pending = harness.root.get(TOOLS).execute(toolCall('call-1', 'defaulted', '{}', agent, never))
    const settled = await Promise.race([pending.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('running'), 60))])
    expect(settled).toBe('running')
  })

  it('a tool that opts out with null is never deadlined', async () => {
    harness = await coreHarness()
    harness.root.get(TOOLS).register(harness.root, hangingTool('forever', null, { cooperative: false }))
    const { agent } = await harness.create()
    const pending = harness.root.get(TOOLS).execute(toolCall('call-1', 'forever', '{}', agent, never))
    const settled = await Promise.race([pending.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('running'), 60))])
    expect(settled).toBe('running')
  })

  it('does not spend the budget while a human is deciding', async () => {
    harness = await coreHarness()
    harness.root.get(TOOLS).register(harness.root, hangingTool('gated', 60))
    harness.root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> =>
      execution.name === 'gated' ? { kind: 'ask', reason: 'careful' } : next(),
    )
    // The answerer takes longer than the whole budget to reply.
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return 'allowed-once'
    })
    const started = Date.now()
    const result = await run('gated')
    // Approval time plus the body's own budget: the clock started after the gate.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(result.code).toBe('TOOL_TIMEOUT')
  })
})
