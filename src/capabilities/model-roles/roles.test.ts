/**
 * Model roles through the real loop: a role reroutes a purposeful call and
 * nothing else, and the log says which route each call actually took.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_OPTIONS, resolveCallConfig } from '../../core/agent/index.ts'
import { COMPACTION, COMPACTION_APPLIED } from '../../core/compaction/index.ts'
import { type AuxCallRecord } from '../../core/llm/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { assistantText, type ScriptedResponse } from '../../test-support/scripted-adapter.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { compactionBasicPlugin } from '../compaction-basic/index.ts'
import { modelRolesPlugin, type ModelRolesConfig } from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function withRoles(config: ModelRolesConfig): Promise<CoreHarness> {
  harness = await coreHarness()
  harness.root.plugin(compactionBasicPlugin, { retainRatio: 0.25, maxTokens: 256 })
  harness.root.plugin(modelRolesPlugin, config)
  await harness.root.settle()
  return harness
}

/** One responder for every call: a summary for a compaction, a bulky reply for a step. */
function responder(): ScriptedResponse {
  let steps = 0
  return (request) => {
    if (request.purpose === 'compaction') return assistantText('## Primary Request\n- keep going')
    steps += 1
    return assistantText(`reply ${steps} ${'y'.repeat(320)}`, { inputTokens: steps * 130, outputTokens: 6 })
  }
}

describe('model roles', () => {
  it('routes a purposeful call to its role and leaves the loop step on the base route', async () => {
    const h = await withRoles({ roles: { compaction: { provider: 'scripted', model: 'cheap-model', reasoningEffort: 'low' } } })
    const shared = responder()
    h.adapter.script(...Array.from({ length: 12 }, () => shared))
    const { agent } = await h.create({ reasoningEffort: 'high' })
    for (let turn = 1; turn <= 3; turn++) {
      agent.followup(createUserMessage(`prompt ${turn} ${'x'.repeat(320)}`))
      await agent.whenIdle()
    }
    const outcome = await h.root.get(COMPACTION).compactNow(agent)
    expect(outcome.kind).toBe('compacted')
    const applied = agent.session.events.find((event) => event.type === COMPACTION_APPLIED.type)!.data as { auxCallSeq: number }
    const aux = agent.session.events[applied.auxCallSeq]!.data as AuxCallRecord
    expect([aux.provider, aux.model]).toEqual(['scripted', 'cheap-model'])
    // The summary request itself went down the role's route with the role's effort.
    const summary = h.adapter.calls.find((call) => call.purpose === 'compaction')!
    expect([summary.model, summary.reasoningEffort]).toEqual(['cheap-model', 'low'])
    // Every loop step stayed on the base route, and the base never moved.
    expect(h.adapter.calls.filter((call) => call.purpose === undefined).every((call) => call.model === 'scripted-model' && call.reasoningEffort === 'high')).toBe(true)
    expect(agent.session.foldRequestHeader()!.model).toBe('scripted-model')
    expect(agent.session.events.filter((event) => event.type === AGENT_OPTIONS.type)).toHaveLength(1)
  })

  it('passes an unknown purpose through, and a role never inherits the base effort', async () => {
    const h = await withRoles({ roles: { subagent: { provider: 'scripted', model: 'child-model' } } })
    const { agent } = await h.create({ reasoningEffort: 'high', maxSteps: 2 })
    expect(await resolveCallConfig(agent, { purpose: 'verifier' })).toEqual({ provider: 'scripted', model: 'scripted-model', reasoningEffort: 'high' })
    expect(await resolveCallConfig(agent, { purpose: 'subagent' })).toEqual({ provider: 'scripted', model: 'child-model' })
    expect(await resolveCallConfig(agent, { turn: 1, step: 1 })).toEqual({ provider: 'scripted', model: 'scripted-model', reasoningEffort: 'high' })
  })

  it('declares a strict config contract, so a misspelt role fails at the row', () => {
    const parse = (value: unknown) => modelRolesPlugin.config!.parse(value)
    expect(() => parse({ roles: { compaction: { provider: 'x' } } })).toThrowError()
    expect(() => parse({ rolls: {} })).toThrowError()
    expect(parse({ roles: {} })).toEqual({ roles: {} })
    expect(parse(undefined)).toBeUndefined()
  })
})
