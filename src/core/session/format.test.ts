/**
 * What a reader may assume about a stored log's shape (`format.ts`), and the
 * per-lifecycle record every later reader leans on (`session/lifecycle`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText } from '../../test-support/scripted-adapter.ts'
import { AGENTS } from '../agent/index.ts'
import { asCallId, asSessionId } from '../ids.ts'
import { createAssistantMessage, createUserMessage } from '../llm/message.ts'
import {
  ASSISTANT_MESSAGE,
  END_SEED,
  envelopeFault,
  SESSION_FORMAT_VERSION,
  SESSION_LIFECYCLE,
  SessionFormatError,
  SESSIONS,
  STEP_START,
  TOOL_CALL,
  TURN_START,
  repairInterruptedTail,
  type EventEnvelope,
} from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('the envelope is closed', () => {
  it('accepts exactly what a writer of this format writes', () => {
    expect(envelopeFault({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })).toBeUndefined()
    expect(envelopeFault({ type: 'user/message', seq: 3, time: 1, data: {}, surfaceOp: { op: 'append' }, sourceEventSeqs: [1] })).toBeUndefined()
    // An unknown FACT kind is still an envelope: plugins add kinds freely.
    expect(envelopeFault({ type: 'plugin/thing', seq: 0, time: 1, data: null })).toBeUndefined()
  })

  it('names what is wrong with anything else', () => {
    expect(envelopeFault({ type: 'turn/start', seq: 0, time: 1, data: {}, extra: 1 })).toMatch(/envelope field this format does not have \("extra"\)/)
    expect(envelopeFault({ type: 'turn/start', seq: 0, time: 1 })).toBe('no payload')
    expect(envelopeFault({ type: 'turn/start', seq: 1.5, time: 1, data: {} })).toBe('no integer seq')
    expect(envelopeFault({ type: 'turn/start', seq: 0, time: 'x', data: {} })).toBe('no timestamp')
    // The surface fields are the envelope's too: a range the seed cannot place, or seqs that are not seqs.
    expect(envelopeFault({ type: 'user/message', seq: 3, time: 1, data: {}, surfaceOp: { op: 'replace', start: 0 } })).toBe('a malformed surface operation')
    expect(envelopeFault({ type: 'user/message', seq: 3, time: 1, data: {}, surfaceOp: { op: 'append', extra: 1 } })).toBe('a malformed surface operation')
    expect(envelopeFault({ type: 'user/message', seq: 3, time: 1, data: {}, surfaceOp: { op: 'append' }, sourceEventSeqs: 'x' })).toBe('malformed source event seqs')
    expect(envelopeFault({ type: 'user/message', seq: 3, time: 1, data: {}, surfaceOp: { op: 'append' }, sourceEventSeqs: [-1] })).toBe('malformed source event seqs')
    expect(envelopeFault({ seq: 0, time: 1, data: {} })).toBe('no event type')
    expect(envelopeFault([1, 2])).toBe('not an event envelope')
    expect(envelopeFault({ type: 'future/surface', seq: 0, time: 1, data: {}, surfaceOp: { op: 'append' } })).toMatch(/surface operation on "future\/surface"/)
    expect(envelopeFault({ type: 'tool/result', seq: 0, time: 1, data: {} })).toMatch(/"tool\/result" with no surface operation/)
  })
})

describe('the format is the header', () => {
  it('continues only a log of its own format, and says which way to go otherwise', async () => {
    harness = await coreHarness()
    const sessions = harness.root.get(SESSIONS)
    const future = { version: SESSION_FORMAT_VERSION + 1, id: asSessionId('future'), createdAt: 1, cwd: '/w' }
    // The store builds headers at the current version, so reach the Session directly.
    const { Session } = await import('./session.ts')
    const host = { prepare: () => () => {}, flush: async () => {} }
    expect(() => new Session(future, host)).toThrowError(SessionFormatError)
    expect(() => new Session(future, host)).toThrowError(/written by a newer MiniDSH/)
    expect(sessions.create({ cwd: '/w' }).header.version).toBe(SESSION_FORMAT_VERSION)
  })

  it('refuses a seed carrying an envelope field rather than silently dropping it', async () => {
    harness = await coreHarness()
    const seed = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 }, causedBy: 0 } as unknown as EventEnvelope]
    expect(() => harness!.root.get(SESSIONS).create({ cwd: '/w', seed })).toThrowError(/seed event 0: an envelope field this format does not have/)
  })
})

describe('session/lifecycle: first in its lifecycle, once', () => {
  const record = { origin: 'new', dispatch: true } as const

  it('opens a new session at seq 0 and a seeded one right after its end-seed', async () => {
    harness = await coreHarness()
    const sessions = harness.root.get(SESSIONS)
    const fresh = sessions.create({ cwd: '/w' })
    fresh.append(SESSION_LIFECYCLE, record)
    const seeded = sessions.create({ cwd: '/w', seed: fresh.events.slice() })
    expect(seeded.events.at(-1)!.type).toBe(END_SEED.type)
    seeded.append(SESSION_LIFECYCLE, { ...record, origin: 'seeded' })
    expect(seeded.events.filter((event) => event.type === SESSION_LIFECYCLE.type)).toHaveLength(2)
  })

  it('refuses one anywhere but the opening of its lifecycle — so a second one too — or a malformed one', async () => {
    harness = await coreHarness()
    const sessions = harness.root.get(SESSIONS)
    const late = sessions.create({ cwd: '/w' })
    late.append(TURN_START, { turn: 1 })
    // Repair trusts this record about everything after it in its segment, so a
    // record appended mid-lifecycle would vouch for events its writer never wrote.
    expect(() => late.append(SESSION_LIFECYCLE, record)).toThrowError(/not the first fact of its lifecycle/)

    const twice = sessions.create({ cwd: '/w' })
    twice.append(SESSION_LIFECYCLE, record)
    expect(() => twice.append(SESSION_LIFECYCLE, record)).toThrowError(/at seq 1 is not the first fact of its lifecycle \(seq 0\)/)

    const forged = sessions.create({ cwd: '/w' })
    expect(() => forged.append(SESSION_LIFECYCLE, { origin: 'new', durability: 1 as never })).toThrowError(/durability is not a string/)
  })

  it('admits a claim value this build does not know, and repair reads it as no claim', async () => {
    // A later build may record a new durability or origin without a format
    // bump: this reader must neither refuse the log nor trust the claim.
    harness = await coreHarness()
    const sessions = harness.root.get(SESSIONS)
    const later = sessions.create({ cwd: '/w' })
    later.append(SESSION_LIFECYCLE, { origin: 'migrated' as never, dispatch: true, durability: 'synced-batch' as never })
    later.append(TURN_START, { turn: 1 })
    later.append(STEP_START, { turn: 1, step: 1 })
    later.append(
      ASSISTANT_MESSAGE,
      { turn: 1, step: 1, message: createAssistantMessage([{ type: 'tool-call', id: asCallId('c1'), name: 'bash', arguments: '{}' }], 'p', 'm') },
      { surfaceOp: { op: 'append' } },
    )
    later.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    const [result] = repairInterruptedTail(later.events)
    expect((result!.data as { error: { code: string } }).error.code).toBe('TOOL_OUTCOME_UNKNOWN')
  })

  it('is written by the creation transaction first, for every lifecycle, with the driver claiming dispatch', async () => {
    harness = await coreHarness()
    harness.adapter.script(assistantText('one'))
    const { agent } = await harness.create()
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    expect(agent.session.events[0]).toMatchObject({ type: SESSION_LIFECYCLE.type, data: { origin: 'new', dispatch: true } })
    // No persistence provider is mounted, so no durability is claimed.
    expect((agent.session.events[0]!.data as { durability?: string }).durability).toBeUndefined()

    const fork = await harness.root.get(AGENTS).fork(harness.root, agent.session)
    const opening = fork.agent.session.events.slice(fork.agent.session.liveStart)
    expect(opening.map((event) => event.type).slice(0, 2)).toEqual([END_SEED.type, SESSION_LIFECYCLE.type])
    expect(opening[1]!.data).toEqual({ origin: 'seeded', dispatch: true })
    await fork.dispose()
  })
})
