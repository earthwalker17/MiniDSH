/**
 * `agent/narrowing` read cold: the fold fails closed on what it cannot
 * believe, and the invariant holds the record to the agent's opening.
 */
import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../session/index.ts'
import { describeEvent } from '../../app/present.ts'
import { describeNarrowing, foldNarrowing, NarrowingError } from './events.ts'
import { checkNarrowingLog } from './invariant.ts'

const NARROW = { tools: [{ deny: ['job_start'], denyTags: ['network'] }], sections: [{ name: 'persona', order: -50, text: 'You are a subagent.' }] }

function log(...records: [type: string, data: unknown][]): EventEnvelope[] {
  return records.map(([type, data], seq) => ({ type, seq, time: 0, data }))
}

const opening = (narrowing: unknown = NARROW): [string, unknown][] => [
  ['session/lifecycle', { origin: 'live', dispatch: true }],
  ['agent/options', { options: { provider: 'p', model: 'm' }, reason: 'initial' }],
  ['agent/narrowing', narrowing],
  ['sandbox/mode', { mode: 'workspace-write', enforcement: 'none', reason: 'delegation' }],
]

describe('foldNarrowing', () => {
  it('reads the first record, and an agent nobody narrowed as none', () => {
    expect(foldNarrowing(log(...opening()))).toEqual(NARROW)
    expect(foldNarrowing(log(['session/lifecycle', {}]))).toBeUndefined()
    // A repeat that says the same thing changes nothing.
    expect(foldNarrowing(log(...opening(), ['agent/narrowing', NARROW]))).toEqual(NARROW)
  })

  it('throws on a malformed record and on a second, different one, rather than composing wider', () => {
    for (const bad of [null, [], { tools: 'all' }, { tools: [{ deny: [''] }] }, { tools: [{ hide: ['x'] }] }, { sections: [{ name: 'persona', order: 'first', text: 'x' }] }, { extra: true }]) {
      expect(() => foldNarrowing(log(...opening(bad))), JSON.stringify(bad)).toThrow(NarrowingError)
    }
    expect(() => foldNarrowing(log(...opening(), ['agent/narrowing', { tools: [] }]))).toThrow(/second, different narrowing/)
  })
})

describe('checkNarrowingLog', () => {
  it('admits one well-formed narrowing in the opening', () => {
    expect(checkNarrowingLog(log(...opening(), ['turn/start', { turn: 1 }]))).toBeUndefined()
  })

  it('refuses a second narrowing, one after a turn, an authority stamp or a lifecycle boundary, and a malformed one', () => {
    const cases: [string, EventEnvelope[], RegExp][] = [
      ['second', log(...opening(), ['agent/narrowing', NARROW]), /at most one/],
      ['after a turn', log(['session/lifecycle', {}], ['turn/start', { turn: 1 }], ['agent/narrowing', NARROW]), /after a turn\/start/],
      ['after a stamp', log(['session/lifecycle', {}], ['sandbox/mode', { mode: 'read-only' }], ['agent/narrowing', NARROW]), /after a sandbox\/mode/],
      ['after an end-seed', log(['session/lifecycle', {}], ['session/end-seed', {}], ['agent/narrowing', NARROW]), /after a session\/end-seed/],
      ['malformed', log(['session/lifecycle', {}], ['agent/narrowing', { tools: 7 }]), /not a list/],
    ]
    for (const [what, events, message] of cases) {
      const violation = checkNarrowingLog(events)
      expect(violation, what).toBeDefined()
      expect(violation!.message, what).toMatch(message)
      expect(violation!.seq, what).toBe(events.length - 1)
    }
  })
})

describe('a narrowing in a reader’s words', () => {
  it('names each term and never quotes a section', () => {
    expect(describeNarrowing(NARROW)).toBe('no job_start, network tools · its own persona')
    expect(describeNarrowing({ tools: [{ allow: ['shell'], allowTags: ['recall'], denyTags: ['network'] }] })).toBe('only shell, recall tools · no network tools')
    expect(describeEvent({ type: 'agent/narrowing', seq: 2, time: 0, data: NARROW })).toBe('[narrowed: no job_start, network tools · its own persona]')
    expect(describeEvent({ type: 'agent/narrowing', seq: 2, time: 0, data: { tools: 'all' } })).toBe('[narrowed: a record this reader cannot read]')
  })
})
