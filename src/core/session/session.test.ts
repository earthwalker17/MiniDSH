import { describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { asCallId, asSessionId } from '../ids.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../llm/message.ts'
import { APPROVAL_ASKED } from '../approval/events.ts'
import { EFFECT_RECORDED } from '../effects/index.ts'
import { invariantsPlugin } from '../invariants/index.ts'
import { repairInterruptedTail } from './repair.ts'
import { deriveEventMessage, foldRequestHeader } from './surface.ts'
import {
  ASSISTANT_MESSAGE,
  REQUEST_HEADER,
  SESSION_LIFECYCLE,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_DISPATCH,
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

    const replay = new Session({ version: 0, id: asSessionId('replay'), createdAt: 1, cwd: '/w' }, { prepare: () => () => {}, flush: async () => {} }, seed)
    expect(JSON.stringify(replay.deriveMessages())).toBe(JSON.stringify(origin.deriveMessages()))
    expect(replay.foldRequestHeader()).toEqual(origin.foldRequestHeader())
    // A seeded session marks where its own writes begin.
    expect(replay.liveStart).toBe(origin.events.length)
    expect(replay.events.at(-1)?.type).toBe('session/end-seed')
  })

  it('derives a fork seed at a boundary and refuses an open turn', async () => {
    const { sessions } = await harness()
    sessions.create({ cwd: '/w', id: asSessionId('src') })
    runTextTurn(sessions, 1, 'hi', 'hello')
    const src = sessions.get(asSessionId('src'))!
    const boundary = src.events.findIndex((event) => event.type === 'turn/end')
    const seed = src.forkSeed(boundary)
    const child = sessions.create({ cwd: src.header.cwd, id: asSessionId('child'), parentId: src.id, seed, seedLength: seed.length })
    expect(child.header.parentId).toBe('src')
    expect(child.header.seedLength).toBe(seed.length)
    expect(child.origin).toBe('seeded')
    expect(child.deriveMessages()).toHaveLength(2)

    src.append(TURN_START, { turn: 2 })
    expect(() => src.forkSeed()).toThrowError(/open turn/)
  })

  it('defers publication until publish() and detaches an unpublished session silently', async () => {
    const { root, sessions } = await harness()
    const announced: string[] = []
    root.on({ kind: 'event', mode: 'emit', name: 'session/created' } as never, ((s: { id: string }) => announced.push(`created:${s.id}`)) as never)
    root.on({ kind: 'event', mode: 'emit', name: 'session/disposed' } as never, ((s: { id: string }) => announced.push(`disposed:${s.id}`)) as never)

    const session = sessions.create({ cwd: '/w', id: asSessionId('deferred'), publish: false })
    // Invisible but id-claiming: the duplicate-id throw is the liveness guard.
    expect(sessions.get(asSessionId('deferred'))).toBeUndefined()
    expect(sessions.list()).toHaveLength(0)
    expect(() => sessions.create({ cwd: '/w', id: asSessionId('deferred') })).toThrowError(/already exists/)
    expect(announced).toEqual([])

    sessions.publish(session)
    expect(announced).toEqual(['created:deferred'])
    expect(sessions.get(asSessionId('deferred'))).toBe(session)
    expect(() => sessions.publish(session)).toThrowError(/already published/)

    const rollback = sessions.create({ cwd: '/w', id: asSessionId('gone'), publish: false })
    await sessions.detach(rollback)
    expect(announced).toEqual(['created:deferred']) // no disposed for the never-published one
    await sessions.detach(session)
    expect(announced).toEqual(['created:deferred', 'disposed:deferred'])
  })

  it('refuses an append once detached, already closed when session/disposed is heard, and leaves the log as it was', async () => {
    const { root, sessions } = await harness()
    const session = sessions.create({ cwd: '/w' })
    runTextTurn(sessions, 1, 'hi', 'hello')
    const length = session.events.length

    // A listener of the disposal is exactly who might be tempted to write a
    // closing fact: persistence has stopped writing by then, so it must be refused.
    let heardClosed: boolean | undefined
    let refusedInListener: unknown
    root.on({ kind: 'event', mode: 'emit', name: 'session/disposed' } as never, ((s: Session) => {
      heardClosed = s.isClosed
      try {
        s.append(TURN_START, { turn: 2 })
      } catch (error) {
        refusedInListener = error
      }
    }) as never)

    expect(session.isClosed).toBe(false)
    await sessions.detach(session)
    expect(heardClosed).toBe(true)
    expect(refusedInListener).toMatchObject({ name: 'SessionClosedError', code: 'SESSION_CLOSED' })
    expect(() => session.append(TURN_START, { turn: 2 })).toThrowError(/is closed: "turn\/start" was not appended/)
    // Nothing entered the in-memory log either: memory and disk may not part ways quietly.
    expect(session.events).toHaveLength(length)
    expect(session.deriveMessages()).toHaveLength(2)

    // A never-published session that is rolled back is closed too.
    const rollback = sessions.create({ cwd: '/w', id: asSessionId('gone'), publish: false })
    await sessions.detach(rollback)
    expect(() => rollback.append(TURN_START, { turn: 1 })).toThrowError(/is closed/)
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
    const repaired = new Session({ version: 0, id: asSessionId('r'), createdAt: 1, cwd: '/w' }, { prepare: () => () => {}, flush: async () => {} }, seed)
    expect(repaired.deriveMessages().at(-1)?.content[0]).toMatchObject({ type: 'tool-result', isError: true })
  })

  it('returns nothing for a balanced log', async () => {
    const { sessions } = await harness()
    sessions.create({ cwd: '/w' })
    runTextTurn(sessions, 1, 'hi', 'hello')
    expect(repairInterruptedTail(sessions.list()[0]!.events)).toEqual([])
  })
})

/**
 * The four rows of the recovery table (see `repair.ts`). What separates them is
 * evidence in the log, never a guess, and the one direction that must never
 * happen is calling a body that ran "not started".
 */
describe('Session: the recovery contract', () => {
  const call = (id: string) => ({ type: 'tool-call' as const, id: asCallId(id), name: 'str_replace_editor', arguments: '{}' })
  // A tool result is user-role with ONE `tool-result` block wrapping the text.
  const resultText = (event: { data: unknown }): string =>
    (event.data as { message: { content: { content: { text: string }[] }[] } }).message.content[0]!.content[0]!.text
  const codeOf = (event: { data: unknown }): string => (event.data as { error: { code: string } }).error.code

  /** An open step whose single call is unanswered, with whatever evidence the caller adds. */
  async function crashedAt(build: (append: (kind: never, data: never, intent?: never) => unknown) => void) {
    const { sessions } = await harness(false)
    const session = sessions.create({ cwd: '/w' })
    build(session.append.bind(session) as never)
    const closers = repairInterruptedTail(session.events)
    return { session, closers, result: closers.find((event) => event.type === TOOL_RESULT.type)! }
  }

  it('reads a dispatched call as outcome-unknown, and says what it provably did', async () => {
    const { result } = await crashedAt((append) => {
      const a = append as unknown as Session['append']
      a(TURN_START, { turn: 1 })
      a(STEP_START, { turn: 1, step: 1 })
      a(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([call('c1')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
      a(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'str_replace_editor', arguments: '{}' })
      a(TOOL_DISPATCH, { turn: 1, step: 1, callId: 'c1' })
      a(EFFECT_RECORDED, { callId: 'c1', effect: 'fs-write', path: '/w/notes.txt', bytes: 12, sha256: 'abc123def4567890abcdef' })
    })
    expect(codeOf(result)).toBe('TOOL_OUTCOME_UNKNOWN')
    const text = resultText(result)
    expect(text).toContain('wrote /w/notes.txt (12 bytes, sha256 abc123def456)')
    // It is evidence, not an inventory, and the model is told which retry is safe.
    expect(text).toContain('not a complete list')
    expect(text).toMatch(/read-only or idempotent/)
    expect(text).toMatch(/never blindly/)
  })

  /** A log whose first step completed a dispatched call, then opened a second call — as a writer from before S16 wrote it, with no lifecycle record. */
  const recordsDispatches = (a: Session['append']): void => {
    a(TURN_START, { turn: 1 })
    a(STEP_START, { turn: 1, step: 1 })
    a(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([call('c0')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
    a(TOOL_CALL, { turn: 1, step: 1, callId: 'c0', name: 'str_replace_editor', arguments: '{}' })
    a(TOOL_DISPATCH, { turn: 1, step: 1, callId: 'c0' })
    a(TOOL_RESULT, { turn: 1, step: 1, callId: 'c0', message: createToolResultMessage(asCallId('c0'), [{ type: 'text', text: 'ok' }], false) }, { surfaceOp: { op: 'append' } })
    a(STEP_END, { turn: 1, step: 1 })
    a(STEP_START, { turn: 1, step: 2 })
    a(ASSISTANT_MESSAGE, { turn: 1, step: 2, message: createAssistantMessage([call('c1')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
    a(TOOL_CALL, { turn: 1, step: 2, callId: 'c1', name: 'str_replace_editor', arguments: '{}' })
  }

  /** The same log written by an S16 driver over a syncing store: its first fact says so. */
  const syncedWriter = (a: Session['append']): void => {
    a(SESSION_LIFECYCLE, { origin: 'new', dispatch: true, durability: 'synced' })
    recordsDispatches(a)
  }

  /**
   * S14 read this as NOT_STARTED because the ask survived after the call. The
   * S16 design critique showed that unsound under a power cut: the gate writes
   * the ask BEFORE the dispatch, so a lost page cache can keep the ask, lose the
   * dispatch, and leave a body that ran reading "safe to call again". Without a
   * writer that synced its checkpoints, the answer is unknown.
   */
  it("stays unknown for an unsynced writer even when the gate's own events survived the call", async () => {
    const { result } = await crashedAt((append) => {
      const a = append as unknown as Session['append']
      recordsDispatches(a)
      a(APPROVAL_ASKED, { id: 'approval-11', toolName: 'str_replace_editor', callId: 'c1' })
    })
    expect(codeOf(result)).toBe('TOOL_OUTCOME_UNKNOWN')
  })

  it('reads a call that never left its gate as not started, when its writer synced the dispatch before any body', async () => {
    const { result } = await crashedAt((append) => {
      const a = append as unknown as Session['append']
      syncedWriter(a)
      // The host died while a person deliberated over the ask.
      a(APPROVAL_ASKED, { id: 'approval-11', toolName: 'str_replace_editor', callId: 'c1' })
    })
    expect(codeOf(result)).toBe('TOOL_NOT_STARTED')
    expect(resultText(result)).toMatch(/policy and approval gate/)
    expect(resultText(result)).toMatch(/safe to make the call again/)
  })

  it("reads a synced writer's call as not started even when its `tool/call` is the last line — the shape S14 had to call unknown", async () => {
    const { result } = await crashedAt((append) => syncedWriter(append as unknown as Session['append']))
    expect(codeOf(result)).toBe('TOOL_NOT_STARTED')
  })

  it('stays unknown when the `tool/call` is the last surviving line of an unsynced writer, because truncation explains it too', async () => {
    const { result } = await crashedAt((append) => recordsDispatches(append as unknown as Session['append']))
    expect(codeOf(result)).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(resultText(result)).toMatch(/may or may not have taken effect/)
  })

  it("reads the claims of the open turn's OWN lifecycle, never an earlier one", async () => {
    // The downgrade hole: an S16 lifecycle, then one written by an older build
    // (no record, no dispatch facts). The open call is the older writer's.
    const { sessions } = await harness(false)
    const first = sessions.create({ cwd: '/w' })
    syncedWriter(first.append.bind(first) as Session['append'])
    const closed = [...first.events, ...repairInterruptedTail(first.events)]
    const later = sessions.create({ cwd: '/w', seed: closed.map((event) => ({ ...event })) })
    const a = later.append.bind(later) as Session['append']
    a(TURN_START, { turn: 2 })
    a(STEP_START, { turn: 2, step: 1 })
    a(ASSISTANT_MESSAGE, { turn: 2, step: 1, message: createAssistantMessage([call('c9')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
    a(TOOL_CALL, { turn: 2, step: 1, callId: 'c9', name: 'str_replace_editor', arguments: '{}' })
    a(APPROVAL_ASKED, { id: 'approval-99', toolName: 'str_replace_editor', callId: 'c9' })
    const result = repairInterruptedTail(later.events).find((event) => event.type === TOOL_RESULT.type)!
    expect(codeOf(result)).toBe('TOOL_OUTCOME_UNKNOWN')
  })

  it('under salvage answers every owed block unknown, even one whose `tool/call` line is gone', async () => {
    const { sessions } = await harness(false)
    const session = sessions.create({ cwd: '/w' })
    const a = session.append.bind(session) as Session['append']
    a(SESSION_LIFECYCLE, { origin: 'new', dispatch: true, durability: 'synced' })
    a(TURN_START, { turn: 1 })
    a(STEP_START, { turn: 1, step: 1 })
    // The readable prefix stopped at the assistant message: the damaged line
    // may have been c1's own `tool/call`, and its body may have run.
    a(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([call('c1'), call('c2')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
    const closers = repairInterruptedTail(session.events, session.events.length, 1, { salvage: true })
    const results = closers.filter((event) => event.type === TOOL_RESULT.type)
    expect(results.map(codeOf)).toEqual(['TOOL_OUTCOME_UNKNOWN', 'TOOL_OUTCOME_UNKNOWN'])
    expect(results.map((event) => (event.data as { error: { name: string } }).error.name)).toEqual(['SalvagedError', 'SalvagedError'])
    expect(resultText(results[0]!)).toMatch(/forked from a DAMAGED log/)
    // And the salvaged seed is one a session will continue: the invariant
    // accepts a salvage answer for a block that logged no call.
    const { sessions: checked } = await harness(true)
    const seeded = checked.create({ cwd: '/w', seed: [...session.events, ...closers].map((event) => ({ ...event })) })
    seeded.append(TURN_START, { turn: 2 })
    expect(seeded.events.at(-1)!.type).toBe(TURN_START.type)
  })

  it('stays unknown when the body left an effect, whatever else the log lost', async () => {
    const { result } = await crashedAt((append) => {
      const a = append as unknown as Session['append']
      recordsDispatches(a)
      // No `tool/dispatch` for c1 — but an effect recorded against it, which
      // only the body could have produced. Proof beats the absence rule.
      a(EFFECT_RECORDED, { callId: 'c1', effect: 'fs-write', path: '/w/landed.txt', bytes: 4, sha256: 'bbbbbbbbbbbb' })
    })
    expect(codeOf(result)).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(resultText(result)).toContain('wrote /w/landed.txt')
  })

  it('stays conservative on a log from before the dispatch fact existed', async () => {
    // The same shape as above with step 1's dispatch removed: absence is no
    // longer evidence, so the call a 1.0.0 log left open reads as it always did.
    const { result } = await crashedAt((append) => {
      const a = append as unknown as Session['append']
      a(TURN_START, { turn: 1 })
      a(STEP_START, { turn: 1, step: 1 })
      a(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([call('c1')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
      a(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'str_replace_editor', arguments: '{}' })
    })
    expect(codeOf(result)).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(resultText(result)).toContain('No effect was recorded for it, which is not proof that none happened')
  })

  it('never attributes an earlier step’s effects to a repeated call id', async () => {
    const { result } = await crashedAt((append) => {
      const a = append as unknown as Session['append']
      a(TURN_START, { turn: 1 })
      a(STEP_START, { turn: 1, step: 1 })
      a(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([call('c1')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
      a(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'str_replace_editor', arguments: '{}' })
      a(TOOL_DISPATCH, { turn: 1, step: 1, callId: 'c1' })
      a(EFFECT_RECORDED, { callId: 'c1', effect: 'fs-write', path: '/w/from-step-one.txt', bytes: 3, sha256: 'aaaaaaaaaaaa' })
      a(TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'ok' }], false) }, { surfaceOp: { op: 'append' } })
      a(STEP_END, { turn: 1, step: 1 })
      // The SAME id again — nothing makes a call id unique across steps.
      a(STEP_START, { turn: 1, step: 2 })
      a(ASSISTANT_MESSAGE, { turn: 1, step: 2, message: createAssistantMessage([call('c1')], 'p', 'm') }, { surfaceOp: { op: 'append' } })
      a(TOOL_CALL, { turn: 1, step: 2, callId: 'c1', name: 'str_replace_editor', arguments: '{}' })
      a(TOOL_DISPATCH, { turn: 1, step: 2, callId: 'c1' })
    })
    expect(codeOf(result)).toBe('TOOL_OUTCOME_UNKNOWN')
    expect(resultText(result)).not.toContain('from-step-one.txt')
    expect(resultText(result)).toContain('No effect was recorded')
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

  /**
   * The gate-to-body fact is only meaningful about a call this step logged. A
   * second writer appending one for an answered or unknown call would make
   * repair read "the body may have run" about something that never dispatched
   * — which is the whole reason the recovery rule trusts it.
   */
  it('throws when a tool/dispatch names a call this step never logged', async () => {
    const { sessions } = await harness(true)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    expect(() => session.append(TOOL_DISPATCH, { turn: 1, step: 1, callId: 'ghost' })).toThrowError(/tool\/dispatch for "ghost" has no pending tool\/call/)
  })

  it('throws when a tool/dispatch lands outside an open step', async () => {
    const { sessions } = await harness(true)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    expect(() => session.append(TOOL_DISPATCH, { turn: 1, step: 1, callId: 'c1' })).toThrowError(/outside an open step/)
  })

  /**
   * An ARRIVING user message belongs to a turn: it is input, and input is what
   * a turn is made of. A message that REPLACES a range is not input at all —
   * it is a rewrite of the model-visible surface, and rewriting between turns
   * is exactly when a human asks for it (`/compact` on an idle session).
   */
  it('refuses an arriving user message outside a turn but allows a surface rewrite', async () => {
    const { sessions } = await harness(true)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    const a = session.append(USER_MESSAGE, { message: createUserMessage('first') }, { surfaceOp: { op: 'append' } })
    const b = session.append(
      ASSISTANT_MESSAGE,
      { turn: 1, step: 1, message: createAssistantMessage([{ type: 'text', text: 'reply' }], 'p', 'm') },
      { surfaceOp: { op: 'append' } },
    )
    session.append(STEP_END, { turn: 1, step: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })

    // Between turns: an arrival is refused.
    expect(() => session.append(USER_MESSAGE, { message: createUserMessage('late') }, { surfaceOp: { op: 'append' } })).toThrowError(
      /user\/message outside a turn/,
    )
    // …and a rewrite is not.
    const summary = session.append(
      USER_MESSAGE,
      { message: createUserMessage('summary') },
      { surfaceOp: { op: 'replace', start: a.seq, end: b.seq }, sourceEventSeqs: [a.seq, b.seq] },
    )
    expect(session.surfaceSeqs()).toEqual([summary.seq])
    expect(session.events[a.seq]).toBeDefined()
  })

  it('rejects an invariant-violating event before it is committed, leaving the log intact', async () => {
    const { sessions } = await harness(true)
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    const before = session.events.length
    const orphan = createToolResultMessage(asCallId('missing'), [{ type: 'text', text: 'x' }], false)
    expect(() =>
      session.append(TOOL_RESULT, { turn: 1, step: 1, callId: 'missing', message: orphan }, { surfaceOp: { op: 'append' }, sourceEventSeqs: [] }),
    ).toThrowError(/no pending tool\/call/)
    // Pre-commit: the rejected event never entered the log or the surface.
    expect(session.events.length).toBe(before)
    expect(session.deriveMessages()).toEqual([])
    // The session is still usable and the next valid event gets the expected seq.
    const next = session.append(STEP_END, { turn: 1, step: 1 })
    expect(next.seq).toBe(before)
  })

  it('keeps its trace in step with the log when a later observer rejects an event', async () => {
    const { root, sessions } = await harness(true)
    let veto = false
    root.observe((info) => {
      if (veto && info.name === 'session/event' && (info.args[1] as { type: string }).type === 'step/start') throw new Error('vetoed')
    })
    const session = sessions.create({ cwd: '/w' })
    session.append(TURN_START, { turn: 1 })
    veto = true
    expect(() => session.append(STEP_START, { turn: 1, step: 1 })).toThrowError(/vetoed/)
    veto = false
    // The relational trace must not have advanced past the vetoed event.
    expect(session.append(STEP_START, { turn: 1, step: 1 }).seq).toBe(1)
    session.append(STEP_END, { turn: 1, step: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    expect(session.events.length).toBe(4)
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

describe('the three tiers', () => {
  it('keeps the trace tier out of facts while preserving seqs, so folds never walk a chunk', async () => {
    const { sessions } = await harness()
    const { ASSISTANT_CHUNK } = await import('./types.ts')
    const session = sessions.create({ cwd: '/w', id: asSessionId('tiers') })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    session.append(USER_MESSAGE, { message: createUserMessage('hi') }, { surfaceOp: { op: 'append' } })
    session.append(REQUEST_HEADER, { turn: 1, step: 1, header, reason: 'initial' })
    for (let i = 0; i < 50; i++) session.append(ASSISTANT_CHUNK, { turn: 1, step: 1, attempt: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } })
    session.append(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([{ type: 'text', text: 'x'.repeat(50) }], 'p', 'm') }, { surfaceOp: { op: 'append' } })
    session.append(STEP_END, { turn: 1, step: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    expect(session.events).toHaveLength(57)
    expect(session.facts).toHaveLength(7)
    expect(session.facts.some((event) => event.type === 'assistant/chunk')).toBe(false)
    expect(session.facts.map((event) => event.seq)).toEqual([0, 1, 2, 3, 54, 55, 56])
    expect(foldRequestHeader(session.facts)).toEqual(foldRequestHeader(session.events))
    // A seeded session classifies its seed the same way.
    const reseeded = new Session(session.header, { prepare: () => () => {}, flush: async () => {} }, session.events)
    expect(reseeded.facts.map((event) => event.seq)).toEqual([0, 1, 2, 3, 54, 55, 56, 57])
    expect(reseeded.events.at(-1)!.type).toBe('session/end-seed')
  })
})
