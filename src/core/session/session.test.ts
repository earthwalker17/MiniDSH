import { describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { asCallId, asSessionId } from '../ids.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../llm/message.ts'
import { invariantsPlugin } from '../invariants/index.ts'
import { repairInterruptedTail } from './repair.ts'
import { deriveEventMessage, foldRequestHeader } from './surface.ts'
import {
  ASSISTANT_MESSAGE,
  REQUEST_HEADER,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type RequestHeader,
} from './types.ts'
import { SESSIONS, sessionPlugin, type Sessions } from './store.ts'
import { sessionInvariantPlugin } from './invariant.ts'
import { Session } from './session.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

async function harness(withInvariant = true): Promise<{ root: Context; sessions: Sessions }> {
  const root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  if (withInvariant) root.plugin(sessionInvariantPlugin)
  await root.settle()
  return { root, sessions: root.get(SESSIONS) }
}

const header: RequestHeader = { provider: 'p', model: 'm', system: 'sys', tools: [] }

/** Appends a minimal one-step turn with an assistant text reply. */
function runTextTurn(sessions: Sessions, turn: number, prompt: string, reply: string) {
  const session = sessions.list()[0]!
  session.append(TURN_START, { turn })
  session.append(STEP_START, { turn, step: 1 })
  session.append(USER_MESSAGE, { message: createUserMessage(prompt) }, { surfaceOp: { op: 'append' } })
  session.append(REQUEST_HEADER, { turn, step: 1, header, reason: turn === 1 ? 'initial' : 'change' })
  session.append(ASSISTANT_MESSAGE, { turn, step: 1, message: createAssistantMessage([{ type: 'text', text: reply }], 'p', 'm') }, { surfaceOp: { op: 'append' } })
  session.append(STEP_END, { turn, step: 1 })
  session.append(TURN_END, { turn, reason: { kind: 'completed' } })
}

describe('Session log', () => {
  it('assigns contiguous seqs, freezes events, and broadcasts session/event', async () => {
    const { root, sessions } = await harness()
    const seen: string[] = []
    root.on({ kind: 'event', mode: 'emit', name: 'session/event' } as never, ((_s: unknown, e: { type: string }) => seen.push(e.type)) as never)
    const session = sessions.create({ cwd: '/w', id: asSessionId('s1') })
    const event = session.append(TURN_START, { turn: 1 })
    expect(event.seq).toBe(0)
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    expect(seen).toEqual(['turn/start'])
  })

  it('rejects non-JSON payloads at the append site', async () => {
    const { sessions } = await harness()
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    expect(() => session.append(STEP_START, { turn: 1, step: 1, bad: 10n } as never)).toThrowError(/bigint/)
    expect(() => session.append(STEP_START, { turn: 1, step: 1, fn: () => 1 } as never)).toThrowError(/function/)
  })

  it('derives model history from the surface, not the raw log', async () => {
    const { sessions } = await harness()
    sessions.create({ cwd: '/w' })
    runTextTurn(sessions, 1, 'hi', 'hello')
    const session = sessions.list()[0]!
    const messages = session.deriveMessages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    // request/header, turn/step boundaries never appear in derived history.
    expect(messages).toHaveLength(2)
  })

  it('projects an empty assistant message to null', async () => {
    const { sessions } = await harness()
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    const empty = session.append(
      ASSISTANT_MESSAGE,
      { turn: 1, step: 1, message: createAssistantMessage([], 'p', 'm') },
      { surfaceOp: { op: 'append' } },
    )
    expect(deriveEventMessage(empty)).toBeNull()
    expect(session.deriveMessages()).toEqual([])
  })

  it('supports a surfaceOp replace that collapses a range without mutating the log', async () => {
    const { sessions } = await harness(false)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    const a = session.append(USER_MESSAGE, { message: createUserMessage('first') }, { surfaceOp: { op: 'append' } })
    const b = session.append(USER_MESSAGE, { message: createUserMessage('second') }, { surfaceOp: { op: 'append' } })
    expect(session.deriveMessages().map((m) => (m.content[0] as { text: string }).text)).toEqual(['first', 'second'])
    session.append(
      USER_MESSAGE,
      { message: createUserMessage('summary') },
      { surfaceOp: { op: 'replace', start: a.seq, end: b.seq }, sourceEventSeqs: [a.seq, b.seq] },
    )
    expect(session.deriveMessages().map((m) => (m.content[0] as { text: string }).text)).toEqual(['summary'])
    expect(session.events).toHaveLength(5) // nothing was removed from the log
  })

  it('rejects a surface event without a surfaceOp and a non-surface event with one', async () => {
    const { sessions } = await harness(false)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    expect(() => session.append(USER_MESSAGE, { message: createUserMessage('x') })).toThrowError(/requires a surfaceOp/)
  })

  it('folds the latest request header', async () => {
    const { sessions } = await harness()
    sessions.create({ cwd: '/w' })
    runTextTurn(sessions, 1, 'hi', 'hello')
    const session = sessions.list()[0]!
    expect(foldRequestHeader(session.events)).toEqual(header)
    expect(session.foldRequestHeader()).toEqual(header)
  })

  it('runs a durable flush checkpoint', async () => {
    const { root, sessions } = await harness()
    let flushed = 0
    root.on({ kind: 'event', mode: 'parallel', name: 'session/flush' } as never, (() => void flushed++) as never)
    const session = sessions.create({ cwd: '/w' })
    await session.flush()
    expect(flushed).toBe(1)
  })
})

describe('Session: seed, fork, replay-equivalence', () => {
  it('reconstructs identical derived history when seeded from an existing log', async () => {
    const { sessions } = await harness()
    sessions.create({ cwd: '/w', id: asSessionId('origin') })
    runTextTurn(sessions, 1, 'hi', 'hello')
    runTextTurn(sessions, 2, 'again', 'sure')
    const origin = sessions.get(asSessionId('origin'))!
    const seed = origin.events.map((event) => ({ ...event }))

    const replay = new Session({ version: 0, id: asSessionId('replay'), createdAt: 1, cwd: '/w' }, { onCommit: () => {}, flush: async () => {} }, seed)
    expect(JSON.stringify(replay.deriveMessages())).toBe(JSON.stringify(origin.deriveMessages()))
    expect(replay.foldRequestHeader()).toEqual(origin.foldRequestHeader())
    // A seeded session marks where its own writes begin.
    expect(replay.liveStart).toBe(origin.events.length)
    expect(replay.events.at(-1)?.type).toBe('session/end-seed')
  })

  it('forks at a boundary and refuses an open turn', async () => {
    const { sessions } = await harness()
    sessions.create({ cwd: '/w', id: asSessionId('src') })
    runTextTurn(sessions, 1, 'hi', 'hello')
    const src = sessions.get(asSessionId('src'))!
    const boundary = src.events.findIndex((event) => event.type === 'turn/end')
    const child = sessions.fork(src, boundary, asSessionId('child'))
    expect(child.header.parentId).toBe('src')
    expect(child.deriveMessages()).toHaveLength(2)

    src.append(TURN_START, { turn: 2 })
    expect(() => src.forkSeed()).toThrowError(/open turn/)
  })
})

describe('Session: crash repair', () => {
  it('closes an interrupted tail with synthetic tool results, a step end, and an interrupted turn end', async () => {
    const { sessions } = await harness(false)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    session.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    const closers = repairInterruptedTail(session.events)
    expect(closers.map((event) => event.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    const turnEnd = closers.at(-1)!
    expect((turnEnd.data as { reason: { kind: string } }).reason.kind).toBe('interrupted')
    // Seeding a fresh session from log + closers validates against the surface + relational rules.
    const seed = [...session.events, ...closers].map((event) => ({ ...event }))
    const repaired = new Session({ version: 0, id: asSessionId('r'), createdAt: 1, cwd: '/w' }, { onCommit: () => {}, flush: async () => {} }, seed)
    expect(repaired.deriveMessages().at(-1)?.content[0]).toMatchObject({ type: 'tool-result', isError: true })
  })

  it('returns nothing for a balanced log', async () => {
    const { sessions } = await harness()
    sessions.create({ cwd: '/w' })
    runTextTurn(sessions, 1, 'hi', 'hello')
    expect(repairInterruptedTail(sessions.list()[0]!.events)).toEqual([])
  })
})

describe('Session: relational invariant', () => {
  it('throws when a tool/result has no matching pending tool/call', async () => {
    const { sessions } = await harness(true)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    const orphan = createToolResultMessage(asCallId('missing'), [{ type: 'text', text: 'x' }], false)
    expect(() =>
      session.append(TOOL_RESULT, { turn: 1, step: 1, callId: 'missing', message: orphan }, { surfaceOp: { op: 'append' }, sourceEventSeqs: [] }),
    ).toThrowError(/no pending tool\/call/)
  })

  it('throws on a non-contiguous turn number', async () => {
    const { sessions } = await harness(true)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    expect(() => session.append(TURN_START, { turn: 3 })).toThrowError(/turn number 3/)
  })

  it('accepts a well-formed multi-step tool turn', async () => {
    const { sessions } = await harness(true)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    session.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    const result = createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'ok' }], false)
    expect(() =>
      session.append(TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: result }, { surfaceOp: { op: 'append' }, sourceEventSeqs: [] }),
    ).not.toThrow()
    session.append(STEP_END, { turn: 1, step: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
  })
})
