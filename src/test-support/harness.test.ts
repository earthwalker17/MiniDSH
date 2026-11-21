/**
 * The harness's tripwire. `coreHarness` mounts the runtime invariants, and a
 * violation used to be something a test had to go looking for: the driver
 * turns one raised in a turn into `turn/end{error}`, one raised past the turn
 * into a line for a logger the harness silences, and the tools pipeline turns
 * one raised under a body into that call's error result. Each case here
 * provokes one of those through the REAL registry (a test-owned invariant that
 * refuses one event kind) and holds `dispose()` to failing for it.
 */
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { INVARIANTS } from '../core/invariants/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { eventKind, SESSION_EVENT, type EventEnvelope } from '../core/session/index.ts'
import { defineTool, TOOLS } from '../core/tools/index.ts'
import { coreHarness, type CoreHarness } from './harness.ts'
import { assistantText, assistantToolCall } from './scripted-adapter.ts'

const POKE = eventKind<Record<string, never>>('test/poke')

const open: CoreHarness[] = []
afterEach(async () => {
  // Whatever a failed case left open; its own dispose already reported.
  for (const harness of open.splice(0)) await harness.dispose().catch(() => undefined)
})

/** A harness with a test-owned invariant that refuses every event of one kind, as a real one refuses a broken rule. */
async function refusing(kind: string): Promise<CoreHarness> {
  const harness = await coreHarness()
  open.push(harness)
  harness.root.get(INVARIANTS).register(harness.root, 'test-refuses', (ctx, fail) => {
    ctx.observe((info) => {
      if (info.name === SESSION_EVENT.name && (info.args[1] as EventEnvelope).type === kind) fail(`${kind} is refused by this test`)
    })
  })
  return harness
}

/** Disposes once, out of the afterEach's reach. */
function disposed(harness: CoreHarness): Promise<void> {
  open.splice(open.indexOf(harness), 1)
  return harness.dispose()
}

const endings = (events: readonly EventEnvelope[]): string[] => events.filter((event) => event.type === 'turn/end').map((event) => (event.data as { reason: { kind: string } }).reason.kind)

describe('coreHarness: a swallowed runtime-invariant violation fails dispose()', () => {
  it('one raised inside a turn, which the driver had turned into a failed turn', async () => {
    const harness = await refusing('assistant/message')
    harness.adapter.script(assistantText('an answer the invariant refuses'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    // All a test saw before: an idle agent, and a turn that ended `error` if it looked.
    expect(endings(agent.session.events)).toEqual(['error'])
    await expect(disposed(harness)).rejects.toThrowError(
      new RegExp(`coreHarness: 1 runtime-invariant violation\\(s\\) were raised where no test saw them[^\\n]*\\n  failed a turn of ${agent.id}: invariant violated by "test-refuses": assistant/message is refused by this test`),
    )
  })

  it('one raised past the turn boundary, which went to the logger the harness silences: counted once though it is reported twice', async () => {
    const harness = await refusing('turn/end')
    harness.adapter.script(assistantText('fine'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    expect(endings(agent.session.events), 'the turn never closed').toEqual([])
    const failure = await disposed(harness).then(
      () => undefined,
      (error: Error) => error.message,
    )
    expect(failure).toContain(`failed a turn of ${agent.id}: invariant violated by "test-refuses": turn/end is refused by this test`)
    // The driver reports that one error to agent/error AND to the logger: it is
    // listed under the first and not again under the second.
    expect(failure!.match(/logged \([^)]*turn boundary failure\)/g) ?? [], `the same error was listed twice:\n${failure}`).toEqual([])
  })

  it('one raised under a tool body, which the pipeline had answered as that call’s error result', async () => {
    const harness = await refusing(POKE.type)
    harness.root.get(TOOLS).register(
      harness.root,
      defineTool({
        name: 'poke',
        description: 'appends an event the invariant refuses',
        input: z.object({}),
        output: z.string(),
        render: (_args, value) => [{ type: 'text', text: value }],
        execute: (_args, exec) => {
          exec.agent!.session.append(POKE, {})
          return 'poked'
        },
      }),
    )
    harness.adapter.script(assistantToolCall('c1', 'poke', {}), assistantText('done'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    // The turn COMPLETED: nothing a test awaiting whenIdle() could have noticed.
    expect(endings(agent.session.events)).toEqual(['completed'])
    await expect(disposed(harness)).rejects.toThrowError(/answered call c1 of \S+: Error: invariant violated by "test-refuses": test\/poke is refused by this test/)
  })

  it('lets a test that provokes one on purpose claim it, and still fails on one raised after the claim', async () => {
    const harness = await refusing('assistant/message')
    harness.adapter.script(assistantText('refused'), assistantText('refused again'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    expect(harness.expectViolations()).toEqual([`failed a turn of ${agent.id}: invariant violated by "test-refuses": assistant/message is refused by this test`])
    expect(harness.expectViolations(), 'claimed once').toEqual([])
    agent.followup(createUserMessage('again'))
    await agent.whenIdle()
    await expect(disposed(harness)).rejects.toThrowError(/coreHarness: 1 runtime-invariant violation/)
  })

  it('does not count a violation thrown straight back at the test’s own call, and passes when nothing was raised', async () => {
    const harness = await refusing(POKE.type)
    harness.adapter.script(assistantText('fine'))
    const { agent } = await harness.create()
    // The test's own append: the throw IS the report.
    expect(() => agent.session.append(POKE, {})).toThrowError(/invariant violated by "test-refuses"/)
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    expect(endings(agent.session.events)).toEqual(['completed'])
    expect(harness.expectViolations()).toEqual([])
    await disposed(harness)
  })
})
