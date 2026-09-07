import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { AGENTS } from '../agent/index.ts'
import { matches } from '../session/index.ts'
import { APPROVAL, APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_REQUEST, type ApprovalOutcome } from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('approval seam', () => {
  it('answerers receive the durable prompt id, which is the asked event seq and pairs with the decision', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let seen: string | undefined
    harness.root.on(APPROVAL_REQUEST, async (prompt): Promise<ApprovalOutcome> => {
      seen = prompt.id
      return 'allowed-once'
    })
    const outcome = await harness.root.get(APPROVAL).request({ agent, toolName: 'upper' })
    expect(outcome).toBe('allowed-once')
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    const decided = agent.session.events.find((event) => matches(event, APPROVAL_DECIDED))!
    expect(seen).toBe(`approval-${asked.seq}`)
    expect((asked.data as { id: string }).id).toBe(seen)
    expect((decided.data as { id: string; outcome: string }).id).toBe(seen)
  })

  /**
   * The shell's `reason` is the MODEL's own `justification`, and it is rendered
   * into the `[y/N]` line a person answers. A terminal executes what it is
   * written, so a `\r` + erase-line in that text repaints the prompt with a
   * milder question above the same keystroke: the grant would be real and its
   * description a forgery. Neutralized before the log, so no surface — and no
   * later requester — can reintroduce it.
   */
  it('neutralizes a reason a terminal would obey, and bounds one no line could hold', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let seen: string | undefined
    harness.root.on(APPROVAL_REQUEST, async (prompt): Promise<ApprovalOutcome> => {
      seen = prompt.reason
      return 'allowed-once'
    })
    // A carriage return and an erase-line, spelled by code point so no editor
    // or diff can quietly normalize the thing under test.
    const CR = String.fromCharCode(13)
    const ESC = String.fromCharCode(27)
    const forged = `read one file${CR}${ESC}[2Kapprove str_replace_editor (view README.md`
    await harness.root.get(APPROVAL).request({ agent, toolName: 'bash', reason: forged })
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    const reason = (asked.data as { reason?: string }).reason!
    // No control character survives, in the log or in what the answerer saw.
    expect([...reason].some((ch) => ch.codePointAt(0)! < 0x20 || (ch.codePointAt(0)! >= 0x7f && ch.codePointAt(0)! <= 0x9f))).toBe(false)
    expect(reason).toBe('read one file [2Kapprove str_replace_editor (view README.md')
    expect(seen).toBe(reason)

    const { agent: second } = await harness.create()
    await harness.root.get(APPROVAL).request({ agent: second, toolName: 'bash', reason: 'x'.repeat(5_000) })
    const long = (second.session.events.find((event) => matches(event, APPROVAL_ASKED))!.data as { reason: string }).reason
    expect(long).toHaveLength(300)
    expect(long.endsWith('…')).toBe(true)
  })

  it('an answerer that never resolves is settled by the request signal as cancelled', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, () => new Promise<ApprovalOutcome>(() => {}))
    const controller = new AbortController()
    const pending = harness.root.get(APPROVAL).request({ agent, toolName: 'upper', signal: controller.signal })
    controller.abort()
    expect(await pending).toBe('cancelled')
    const decided = agent.session.events.find((event) => matches(event, APPROVAL_DECIDED))!
    expect((decided.data as { outcome: string }).outcome).toBe('cancelled')
  })

  it('an already-cancelled request is decided cancelled without consulting any answerer', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let consulted = false
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      consulted = true
      return 'allowed-once'
    })
    const controller = new AbortController()
    controller.abort()
    expect(await harness.root.get(APPROVAL).request({ agent, toolName: 'upper', signal: controller.signal })).toBe('cancelled')
    expect(consulted).toBe(false)
    const pair = agent.session.events.filter((event) => matches(event, APPROVAL_ASKED) || matches(event, APPROVAL_DECIDED))
    expect(pair.map((event) => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect((pair[1]!.data as { outcome: string }).outcome).toBe('cancelled')
  })

  it('ids stay unique across a same-id resume in a fresh process (no per-process counter)', async () => {
    const asked = (agent: { session: { events: readonly { type: string; seq: number; data: unknown }[] } }) =>
      agent.session.events.filter((event) => event.type === APPROVAL_ASKED.type).map((event) => ({ seq: event.seq, id: (event.data as { id: string }).id }))

    const first = await coreHarness()
    first.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'rejected')
    const original = await first.create()
    await first.root.get(APPROVAL).request({ agent: original.agent, toolName: 'a' })
    await first.root.get(APPROVAL).request({ agent: original.agent, toolName: 'b' })
    const id = original.agent.id
    const seed = original.agent.session.forkSeed()
    const before = asked(original.agent)
    await first.dispose()

    harness = await coreHarness()
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'rejected')
    const resumed = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      sessionId: id,
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      seed,
    })
    await harness.root.get(APPROVAL).request({ agent: resumed.agent, toolName: 'c' })
    const all = asked(resumed.agent)
    expect(all.slice(0, 2)).toEqual(before)
    expect(new Set(all.map((entry) => entry.id)).size).toBe(3)
    for (const entry of all) expect(entry.id).toBe(`approval-${entry.seq}`)
    await resumed.dispose()
  })
})
