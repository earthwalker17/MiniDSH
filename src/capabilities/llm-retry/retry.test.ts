/**
 * llm-retry through the real loop: the row decides which failures are retried,
 * how many times, how long it waits, and that a cancel ends the wait. Before
 * S20.5 no test mounted it — every retry in the tree came from an ad-hoc
 * listener — so retrying QUOTA, or never retrying at all, passed everything.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError, type LlmErrorCode } from '../../core/llm/index.ts'
import { createUserMessage, messageText } from '../../core/llm/message.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText } from '../../test-support/scripted-adapter.ts'
import { retryPlugin, type RetryConfig } from './index.ts'

let harness: CoreHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function mount(config?: RetryConfig): Promise<CoreHarness> {
  harness = await coreHarness()
  harness.root.plugin(retryPlugin, config)
  expect((await harness.root.settle()).failed).toEqual([])
  return harness
}

/** A scripted attempt that fails as the adapter would, with the code (and wait) given. */
const failing = (code: LlmErrorCode, retryAfterMs?: number) => (): never => {
  throw new LlmError(code, `scripted ${code}`, retryAfterMs === undefined ? {} : { retryAfterMs })
}

interface TurnEnd {
  readonly reason: { readonly kind: string; readonly code?: string }
}

async function run(h: CoreHarness): Promise<{ calls: number; end: TurnEnd['reason']; last: string; elapsed: number }> {
  const { agent } = await h.create()
  const started = Date.now()
  agent.followup(createUserMessage('go'))
  await agent.whenIdle()
  const end = agent.session.events.findLast((event) => event.type === 'turn/end')!.data as TurnEnd
  const last = agent.session.deriveMessages().at(-1)!
  return { calls: h.adapter.calls.length, end: end.reason, last: messageText(last), elapsed: Date.now() - started }
}

describe('llm-retry', () => {
  it('retries a SERVER failure, and the retried attempt answers the turn', async () => {
    const h = await mount({ initialDelayMs: 0 })
    h.adapter.script(failing('SERVER'), assistantText('recovered'))
    const outcome = await run(h)
    expect(outcome.calls).toBe(2)
    expect(outcome.end.kind).toBe('completed')
    expect(outcome.last).toBe('recovered')
  })

  it('never retries QUOTA: no retry can refill a wallet', async () => {
    const h = await mount({ initialDelayMs: 0 })
    h.adapter.script(failing('QUOTA'), assistantText('unreached'))
    const outcome = await run(h)
    expect(outcome.calls).toBe(1)
    expect(outcome.end).toMatchObject({ kind: 'error', code: 'QUOTA' })
  })

  it('stops at its cap and lets the last failure end the turn', async () => {
    const h = await mount({ initialDelayMs: 0, maxRetries: 2 })
    h.adapter.script(failing('SERVER'), failing('SERVER'), failing('SERVER'), assistantText('unreached'))
    const outcome = await run(h)
    expect(outcome.calls).toBe(3)
    expect(outcome.end).toMatchObject({ kind: 'error', code: 'SERVER' })
  })

  it('waits at least the provider’s retry-after before trying again', async () => {
    const h = await mount({ initialDelayMs: 0 })
    h.adapter.script(failing('RATE_LIMIT', 300), assistantText('after the wait'))
    const outcome = await run(h)
    expect(outcome.calls).toBe(2)
    expect(outcome.last).toBe('after the wait')
    expect(outcome.elapsed).toBeGreaterThanOrEqual(280)
  })

  it('gives up at once on a retry-after past its ceiling, rather than sleeping the turn away in silence', async () => {
    // An hour's `retry-after` (or an HTTP date) once slept the turn for an hour
    // with nothing logged; one past 2^31-1 ms overflowed the timer and retried at once.
    const h = await mount({ initialDelayMs: 0, maxRetryAfterMs: 5_000 })
    h.adapter.script(failing('RATE_LIMIT', 3_600_000), assistantText('unreached'))
    const outcome = await run(h)
    expect(outcome.calls).toBe(1)
    expect(outcome.end).toMatchObject({ kind: 'error', code: 'RATE_LIMIT' })
    expect(outcome.elapsed).toBeLessThan(2_000)
    // The default ceiling holds without any configuration, and a timer bound it cannot honour is refused at the row.
    const plain = await coreHarness()
    try {
      plain.root.plugin(retryPlugin, {})
      const handle = plain.root.plugin({ ...retryPlugin, name: 'llm-retry-overflow' }, { maxDelayMs: 2 ** 31 })
      await plain.root.settle()
      expect(handle.state).toBe('failed')
      plain.adapter.script(failing('RATE_LIMIT', 2 ** 31), assistantText('unreached'))
      const { agent } = await plain.create()
      agent.followup(createUserMessage('go'))
      await agent.whenIdle()
      expect(plain.adapter.calls).toHaveLength(1)
    } finally {
      await plain.dispose()
    }
  })

  it('spreads siblings that share one retry-after, never below it (S21 review)', async () => {
    const h = await mount({ initialDelayMs: 400 })
    const waits: number[] = []
    const realSetTimeout = globalThis.setTimeout
    // Record each retry's wait as the row asks for it, and run it at once.
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if ((ms ?? 0) >= 1_000) waits.push(ms ?? 0)
      return realSetTimeout(handler, 0)
    }) as typeof setTimeout
    try {
      for (let sibling = 0; sibling < 4; sibling++) {
        h.adapter.script(failing('RATE_LIMIT', 1_000), assistantText('recovered'))
        const outcome = await run(h)
        expect(outcome.end.kind).toBe('completed')
      }
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(waits).toHaveLength(4)
    for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(1_000)
    expect(new Set(waits).size, `four siblings with one retry-after waited ${waits.join(', ')} ms: in lockstep`).toBeGreaterThan(1)
  })

  it('ends its wait when the turn is cancelled, and retries nothing after', async () => {
    const h = await mount({ initialDelayMs: 0 })
    h.adapter.script(failing('SERVER', 30_000), assistantText('unreached'))
    const { agent } = await h.create()
    const started = Date.now()
    agent.followup(createUserMessage('go'))
    while (h.adapter.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    // Let the failure reach the row and its sleep begin.
    await new Promise((resolve) => setTimeout(resolve, 100))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(h.adapter.calls).toHaveLength(1)
    const end = agent.session.events.findLast((event) => event.type === 'turn/end')!.data as TurnEnd
    expect(end.reason.kind).toBe('cancelled')
  })
})
