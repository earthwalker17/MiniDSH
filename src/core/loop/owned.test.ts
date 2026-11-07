/**
 * `Agent.own` (S21.1): work an agent owns outside any turn is cancelled by the
 * agent's LIFETIME, joined by its disposal before the session detaches, and
 * bounded — the agent-owned-work primitive BLUEPRINT §3 asked for first.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../../kernel/index.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { AGENT_PRE_STEP, foldInbox } from '../agent/index.ts'
import { createUserMessage, messageText, restoreMessage } from '../llm/message.ts'
import { SESSION_TITLE } from '../session/index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** A promise that settles when `signal` aborts, never before. */
const aborted = (signal: AbortSignal): Promise<void> => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

describe('work an agent owns outside a turn', () => {
  it('is aborted by the disposal and joined before the session detaches, so its own record lands', async () => {
    harness = await coreHarness()
    const handle = await harness.create()
    const { agent } = handle
    let reason: unknown
    const work = agent.own(async (signal) => {
      await aborted(signal)
      reason = signal.reason
      // Still an open log: the disposal waits for this before it detaches.
      agent.session.append(SESSION_TITLE, { title: 'owned work ended', messageSeqs: [], source: { kind: 'user' } })
      return 'stopped'
    })
    // `whenIdle` is the loop's idle, and owned work is no turn.
    await agent.whenIdle()
    // A person's cancel stops a turn, not this.
    agent.cancel({ kind: 'user' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reason).toBeUndefined()

    await handle.dispose()
    expect(await work).toBe('stopped')
    expect(reason).toEqual({ kind: 'disposed' })
    expect(agent.session.events.at(-1)?.type).toBe(SESSION_TITLE.type)
    expect(agent.session.isClosed).toBe(true)
  })

  it('is refused once disposal has begun', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    agent.cancel({ kind: 'disposed' })
    let ran = false
    await expect(
      agent.own(async () => {
        ran = true
      }),
    ).rejects.toMatchObject({ code: 'AGENT_DISPOSED' })
    expect(ran).toBe(false)
  })

  it('cannot hold a disposal open: work that ignores its signal is waited for only up to the bound', async () => {
    const warnings: string[] = []
    const logger: Logger = { warn: (message) => void warnings.push(message), error: () => {} }
    harness = await coreHarness({ logger, loop: { ownedWorkBoundMs: 150 } })
    const handle = await harness.create()
    void handle.agent.own(() => new Promise<never>(() => {}))
    const started = Date.now()
    await handle.dispose()
    const took = Date.now() - started
    expect(took, `the disposal took ${took} ms`).toBeLessThan(2_000)
    expect(took).toBeGreaterThanOrEqual(140)
    expect(warnings.some((message) => message.includes('did not stop within 150 ms'))).toBe(true)
  })
})

describe('a turn a disposal stops before its prompt entered', () => {
  /**
   * A disposal's inbox clear is non-durable, so the log keeps the prompt
   * queued for the next lifecycle. The aborted turn then used to COMMIT its
   * claim anyway, durably consuming a prompt nobody saw — the refused resume
   * flags of S21.1 hit exactly this. It now forgets the claim instead.
   */
  it('leaves the claimed prompt queued in the log, for the next lifecycle', async () => {
    harness = await coreHarness()
    const handle = await harness.create()
    let reached!: () => void
    const atPreStep = new Promise<void>((resolve) => (reached = resolve))
    harness.root.on(
      AGENT_PRE_STEP,
      async (context, next) => {
        reached()
        await aborted(context.signal)
        return next()
      },
      { global: true },
    )
    handle.agent.followup(createUserMessage('NEVER-ENTERED'))
    await atPreStep
    await handle.dispose()
    const events = handle.agent.session.events
    expect(events.filter((event) => event.type === 'user/message'), 'the prompt never entered').toHaveLength(0)
    expect(foldInbox(events).turnQueue.map((message) => messageText(restoreMessage(message)))).toEqual(['NEVER-ENTERED'])
  })
})
