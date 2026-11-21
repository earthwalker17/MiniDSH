/**
 * Tool deadlines. A tool that never returns must not be able to hold the loop,
 * and a human deliberating over an approval must not spend the tool's budget.
 */
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from '../../kernel/index.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { APPROVAL_REQUEST, type ApprovalOutcome } from '../approval/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE, toolCall, toolsPlugin, type PreToolDecision } from './index.ts'

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
    harness = await coreHarness({ tools: { defaultTimeoutMs: 40 } })
    harness.root.get(TOOLS).register(harness.root, hangingTool('defaulted', undefined, { cooperative: false }))
    const result = await run('defaulted')
    expect(result.code).toBe('TOOL_TIMEOUT')
    expect(result.text).toContain('timed out after 40ms')
  })

  // `AbortSignal.timeout` throws on a fraction, so every call of every tool
  // that took the default failed TOOL_FAILED; a timer past 2^31-1 ms fires
  // after one millisecond, so each timed out at once. Both are a bad ROW, and
  // the row is where they are refused, by name, before any tool runs.
  it('refuses a default budget the deadline timer cannot honour when the row is parsed, naming the key', async () => {
    const outcome = async (defaultTimeoutMs: number): Promise<string> => {
      const root = createRoot({ logger: { warn: () => {}, error: () => {} } })
      try {
        root.plugin(toolsPlugin, { defaultTimeoutMs })
        const report = await root.settle()
        const failure = report.failed.map((entry) => (entry.error instanceof Error ? entry.error.message : String(entry.error)))
        return failure.length === 0 ? 'loaded' : failure.every((message) => /invalid config: defaultTimeoutMs: /.test(message)) ? 'refused' : `failed otherwise: ${failure.join(' | ')}`
      } finally {
        await root.dispose()
      }
    }
    const rows = [2500.5, 0, -1, 2 ** 31, 3_000_000_000, Number.NaN, Number.POSITIVE_INFINITY, 1, 40, 2 ** 31 - 1]
    const outcomes: Record<string, string> = {}
    for (const row of rows) outcomes[String(row)] = await outcome(row)
    expect(outcomes).toEqual({
      '2500.5': 'refused',
      '0': 'refused',
      '-1': 'refused',
      '2147483648': 'refused',
      '3000000000': 'refused',
      NaN: 'refused',
      Infinity: 'refused',
      '1': 'loaded',
      '40': 'loaded',
      '2147483647': 'loaded',
    })
  })

  it('a tool that opts out with null is never deadlined, even under a short default', async () => {
    harness = await coreHarness({ tools: { defaultTimeoutMs: 40 } })
    harness.root.get(TOOLS).register(harness.root, hangingTool('forever', null))
    const { agent } = await harness.create()
    const controller = new AbortController()
    const pending = harness.root.get(TOOLS).execute(toolCall('call-1', 'forever', '{}', agent, controller.signal))
    const settled = await Promise.race([pending.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('running'), 120))])
    expect(settled).toBe('running')
    // Let the body go, so nothing is left pending behind the test.
    controller.abort()
    await pending
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
