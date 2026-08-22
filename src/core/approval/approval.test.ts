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

  it('ids stay unique in a session seeded from an earlier lifecycle', async () => {
    harness = await coreHarness()
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'rejected')
    const approval = harness.root.get(APPROVAL)
    const first = await harness.create()
    await approval.request({ agent: first.agent, toolName: 'a' })
    await approval.request({ agent: first.agent, toolName: 'b' })
    const seeded = first.agent.session.events.filter((event) => matches(event, APPROVAL_ASKED)).map((event) => (event.data as { id: string }).id)
    expect(new Set(seeded).size).toBe(2)

    const resumed = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      seed: first.agent.session.forkSeed(),
    })
    await approval.request({ agent: resumed.agent, toolName: 'c' })
    const ids = resumed.agent.session.events.filter((event) => matches(event, APPROVAL_ASKED)).map((event) => (event.data as { id: string }).id)
    expect(ids.slice(0, 2)).toEqual(seeded)
    expect(seeded).not.toContain(ids[2])
    await resumed.dispose()
  })
})
