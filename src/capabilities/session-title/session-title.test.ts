/**
 * The writer, against a real session store: what it records, when it records
 * it, and — the part a fold cannot check — WHERE in the log it lands.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { createPluginMessage, createUserMessage } from '../../core/llm/message.ts'
import { PERSISTENCE } from '../../core/persistence/index.ts'
import {
  SESSIONS,
  SESSION_EVENT,
  SESSION_FORMAT_VERSION,
  SESSION_TITLE,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  foldSessionTitle,
  sessionPlugin,
  type EventEnvelope,
  type Sessions,
} from '../../core/session/index.ts'
import { persistenceJsonlPlugin } from '../persistence-jsonl/index.ts'
import { sessionTitlePlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
let root: Context | undefined
let dir: string | undefined
/** The seq of every event, in the order a listener registered AFTER the writer was handed it. */
let delivered: number[] = []

afterEach(async () => {
  await root?.dispose()
  root = undefined
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

async function mount(): Promise<Sessions> {
  root = createRoot({ logger: silent })
  root.plugin(sessionPlugin)
  root.plugin(sessionTitlePlugin)
  await root.settle()
  // Registered after the title row's own listener, which is where persistence
  // and the protocol sit in a real composition: what THIS hears, in this
  // order, is what reaches the file and the wire. The in-memory log cannot
  // show an early append, because the cause is pushed before it is delivered.
  delivered = []
  root.on(SESSION_EVENT, (_session, event) => void delivered.push(event.seq))
  return root.get(SESSIONS)
}

/** The writer defers to a microtask on purpose, so a reader must let one run. */
const settled = (): Promise<void> => Promise.resolve()

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.type)
}

describe('the session-title writer', () => {
  it('records the first prompt as a title, AFTER the prompt, never before it', async () => {
    const sessions = await mount()
    const session = sessions.create({ cwd: '/w', id: asSessionId('s1') })
    session.append(TURN_START, { turn: 1 })
    session.append(USER_MESSAGE, { message: createUserMessage('add a health check endpoint') }, { surfaceOp: { op: 'append' } })
    await settled()

    // The ordering IS the contract. A listener that appended synchronously
    // would put this line ahead of the prompt that caused it on disk and on the
    // wire, and the next resume would read the log as damaged. That ordering
    // is the DELIVERY's: the log below reads the same either way.
    expect(delivered, 'the order later listeners were handed the events in').toEqual([0, 1, 2])
    expect(types(session.events)).toEqual(['turn/start', 'user/message', 'session/title'])
    expect(session.events.at(-1)!.data).toEqual({
      title: 'add a health check endpoint',
      messageSeqs: [1],
      source: { kind: 'fallback' },
    })
    expect(session.events.at(-1)!.surfaceOp).toBeUndefined()
  })

  it('records once, however many prompts follow', async () => {
    const sessions = await mount()
    const session = sessions.create({ cwd: '/w', id: asSessionId('s2') })
    for (const text of ['first', 'second', 'third']) {
      session.append(USER_MESSAGE, { message: createUserMessage(text) }, { surfaceOp: { op: 'append' } })
      await settled()
    }
    expect(types(session.events).filter((type) => type === SESSION_TITLE.type)).toHaveLength(1)
    expect(foldSessionTitle(session.events)).toBe('first')
  })

  it('waits for a prompt a person actually sent', async () => {
    const sessions = await mount()
    const session = sessions.create({ cwd: '/w', id: asSessionId('s3') })
    // An injected note is a `user/message` too. Naming a session after the
    // workspace instructions it was handed would name every session the same.
    session.append(USER_MESSAGE, { message: createPluginMessage('workspace-instructions', 'The project uses pnpm.') }, { surfaceOp: { op: 'append' } })
    await settled()
    expect(types(session.events)).toEqual(['user/message'])

    session.append(USER_MESSAGE, { message: createUserMessage('why is the build slow') }, { surfaceOp: { op: 'append' } })
    await settled()
    expect(foldSessionTitle(session.events)).toBe('why is the build slow')
  })

  it('leaves a session that already has a name alone, and never renames a fork', async () => {
    const sessions = await mount()
    const parent = sessions.create({ cwd: '/w', id: asSessionId('parent') })
    parent.append(USER_MESSAGE, { message: createUserMessage('the parent task') }, { surfaceOp: { op: 'append' } })
    await settled()
    const seed = parent.events.slice()

    // A fork inherits the title in its seed. The branch's own next prompt must
    // not overwrite it — a resumed or forked session keeps what it recorded.
    const fork = sessions.create({ cwd: '/w', id: asSessionId('fork'), seed, seedLength: seed.length, parentId: asSessionId('parent') })
    fork.append(USER_MESSAGE, { message: createUserMessage('a different direction') }, { surfaceOp: { op: 'append' } })
    await settled()
    expect(types(fork.events).filter((type) => type === SESSION_TITLE.type)).toHaveLength(1)
    expect(foldSessionTitle(fork.events)).toBe('the parent task')
  })

  it('backfills a log written before titles existed, from its FIRST prompt', async () => {
    const sessions = await mount()
    // A seed with no `session/title` anywhere: what every stored log looked
    // like until this row existed.
    const seed: EventEnvelope[] = [
      { type: TURN_START.type, seq: 0, time: 1, data: { turn: 1 } },
      { type: USER_MESSAGE.type, seq: 1, time: 2, data: { message: createUserMessage('the original question') }, surfaceOp: { op: 'append' } },
      { type: TURN_END.type, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const resumed = sessions.create({ cwd: '/w', id: asSessionId('old'), seed, origin: 'resumed' })
    resumed.append(USER_MESSAGE, { message: createUserMessage('a follow-up months later') }, { surfaceOp: { op: 'append' } })
    await settled()

    // The name comes from what the session was always about, not from whatever
    // was typed the day it was picked up again.
    expect(foldSessionTitle(resumed.events)).toBe('the original question')
    expect(resumed.events.at(-1)!.type).toBe(SESSION_TITLE.type)
  })

  /**
   * The same backfill with the real writer mounted AFTER this row, as the
   * shipped composition mounts it, over a stored log that has a prompt and no
   * title. This is where an early append does its damage: a resumed session's
   * file is open from publication, so a title appended inside the prompt's
   * delivery would reach the writer before the prompt did.
   */
  it('lands in the stored log after the prompt that caused it, and the log reads back whole', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-title-'))
    const header = { kind: 'session', version: SESSION_FORMAT_VERSION, id: 'old', createdAt: 1000, cwd: '/w' }
    const seed: EventEnvelope[] = [
      { type: TURN_START.type, seq: 0, time: 1, data: { turn: 1 } },
      { type: USER_MESSAGE.type, seq: 1, time: 2, data: { message: createUserMessage('the original question') }, surfaceOp: { op: 'append' } },
      { type: TURN_END.type, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    writeFileSync(join(dir, 'old.jsonl'), [header, ...seed].map((line) => `${JSON.stringify(line)}\n`).join(''))
    root = createRoot({ logger: silent })
    root.plugin(sessionPlugin)
    root.plugin(sessionTitlePlugin)
    root.plugin(persistenceJsonlPlugin, { root: dir })
    await root.settle()
    const persistence = root.get(PERSISTENCE)
    const stored = persistence.load('old')!
    expect({ damaged: stored.damaged, events: stored.events.length }).toEqual({ damaged: undefined, events: 3 })

    const resumed = root.get(SESSIONS).create({ cwd: stored.header.cwd, id: stored.header.id, createdAt: stored.header.createdAt, seed: stored.events, origin: 'resumed' })
    resumed.append(USER_MESSAGE, { message: createUserMessage('a follow-up months later') }, { surfaceOp: { op: 'append' } })
    await settled()
    // The writer refuses an event that arrives ahead of its cause, and says so here.
    await expect(resumed.flush()).resolves.toBeUndefined()

    const after = persistence.load('old')!
    expect({ damaged: after.damaged, tail: after.integrity?.tail, stop: after.integrity?.stop }).toEqual({ damaged: undefined, tail: 'none', stop: undefined })
    expect(after.events.map((event) => `${event.seq} ${event.type}`)).toEqual(['0 turn/start', '1 user/message', '2 turn/end', '3 session/end-seed', '4 user/message', '5 session/title'])
    expect(foldSessionTitle(after.events)).toBe('the original question')
  })
})
