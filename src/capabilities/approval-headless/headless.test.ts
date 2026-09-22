/**
 * The headless answerer, which is the only one an unattended run has.
 *
 * `--approve` and the fail-closed default are the two honest postures; the
 * allow-list is the rung between them, and its whole safety is that it can
 * express exactly what the runtime can identify — the same `intentKey` a grant
 * uses, and nothing looser.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { APPROVAL, APPROVAL_DECIDED } from '../../core/approval/index.ts'
import type { EffectIntent } from '../../core/effects/index.ts'
import { matches } from '../../core/session/index.ts'
import { approvalHeadlessPlugin, type ApprovalHeadlessConfig } from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const subject = (over: Partial<EffectIntent> = {}): EffectIntent => ({
  effect: 'shell-command',
  command: 'pnpm check',
  mode: 'workspace-write',
  enforcement: 'none',
  ...over,
})

async function withConfig(config: ApprovalHeadlessConfig): Promise<CoreHarness> {
  harness = await coreHarness()
  harness.root.plugin(approvalHeadlessPlugin, config)
  await harness.root.settle()
  return harness
}

describe('the headless answerer', () => {
  it('denies by default, because nobody is there to ask', async () => {
    const test = await withConfig({})
    const { agent } = await test.create()
    expect(await test.root.get(APPROVAL).request({ agent, toolName: 'bash', subject: subject() })).toBe('unavailable')
  })

  it('approves exactly the subjects a deployment declared, and nothing adjacent to them', async () => {
    const test = await withConfig({ allow: [{ tool: 'bash', command: 'pnpm check', mode: 'workspace-write' }] })
    const { agent } = await test.create()
    const approval = test.root.get(APPROVAL)

    expect(await approval.request({ agent, toolName: 'bash', subject: subject() })).toBe('allowed-once')
    // A different command, a different mode, a different tool, and the same
    // command with no subject at all are four different questions — none of
    // which this list answers.
    expect(await approval.request({ agent, toolName: 'bash', subject: subject({ command: 'pnpm check --fix' }) })).toBe('unavailable')
    expect(await approval.request({ agent, toolName: 'bash', subject: subject({ mode: 'danger-full-access' }) })).toBe('unavailable')
    expect(await approval.request({ agent, toolName: 'pwsh', subject: subject() })).toBe('unavailable')
    expect(await approval.request({ agent, toolName: 'bash' })).toBe('unavailable')
  })

  it('records itself as auto, never as a person, and never mints a grant', async () => {
    const test = await withConfig({ allow: [{ tool: 'bash', command: 'pnpm check', mode: 'workspace-write' }] })
    const { agent } = await test.create()
    const approval = test.root.get(APPROVAL)
    await approval.request({ agent, toolName: 'bash', subject: subject() })
    expect(agent.session.events.findLast((event) => matches(event, APPROVAL_DECIDED))!.data).toMatchObject({
      outcome: 'allowed-once',
      decidedBy: 'auto',
    })
    // A grant is a consent somebody gave; no host offers a scope in a headless
    // run, so an unattended approval leaves no standing consent behind.
    expect(approval.grants(agent.session)).toHaveLength(0)
  })

  it('still lets --approve answer everything, including an ask with no subject', async () => {
    const test = await withConfig({ approve: true })
    const { agent } = await test.create()
    expect(await test.root.get(APPROVAL).request({ agent, toolName: 'anything' })).toBe('allowed-once')
  })
})
