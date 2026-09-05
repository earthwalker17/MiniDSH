/**
 * What a session is called, and — the half that matters — what it is never
 * called: its own compaction summary, an injected note, a tool result, or a
 * string that can move a terminal's cursor.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createMessage, createPluginMessage, createToolResultMessage, createUserMessage } from '../llm/message.ts'
import { asAttachmentId } from '../attachments/index.ts'
import { asCallId } from '../ids.ts'
import { foldSessionTitle, scanSessionTitle, SESSION_TITLE, TITLE_MAX_CHARS, TITLE_MAX_WORDS } from './title.ts'
import { ASSISTANT_MESSAGE, TOOL_RESULT, USER_MESSAGE, type EventEnvelope } from './types.ts'

let seq = 0
function event<D>(type: string, data: D): EventEnvelope<D> {
  return { type, seq: seq++, time: 0, data }
}
function prompt(text: string): EventEnvelope {
  return event(USER_MESSAGE.type, { message: createUserMessage(text) })
}

describe('a session title', () => {
  it('is the first thing a person said', () => {
    seq = 0
    expect(foldSessionTitle([event('turn/start', { turn: 1 }), prompt('fix the flaky login test'), prompt('and the other one')])).toBe(
      'fix the flaky login test',
    )
  })

  it('is never taken from a summary, an injected note, a tool result or the assistant', () => {
    seq = 0
    const events = [
      event(USER_MESSAGE.type, { message: createPluginMessage('compaction-basic', 'Earlier conversation, summarized: …', 'summary') }),
      event(USER_MESSAGE.type, { message: createPluginMessage('workspace-instructions', 'The project uses pnpm.') }),
      event(TOOL_RESULT.type, { message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'ok' }], false) }),
      event(ASSISTANT_MESSAGE.type, { message: createAssistantMessage([{ type: 'text', text: 'Hello' }], 'p', 'm') }),
    ]
    expect(foldSessionTitle(events)).toBeUndefined()
    // …and the real prompt after them still names the session.
    expect(foldSessionTitle([...events, prompt('rename the widget')])).toBe('rename the widget')
  })

  it('skips a prompt that says nothing rather than becoming a blank name', () => {
    seq = 0
    expect(foldSessionTitle([prompt('   \n\t  '), prompt('the real one')])).toBe('the real one')
  })

  it('carries no character that can move a cursor or reorder what it says', () => {
    seq = 0
    const escape = String.fromCharCode(0x1b)
    const del = String.fromCharCode(0x7f)
    const bell = String.fromCharCode(0x07)
    const rtlOverride = String.fromCharCode(0x202e)
    const title = foldSessionTitle([prompt(`${escape}[2Jred${bell}${del} ${rtlOverride}alert`)])!
    for (const character of title) {
      const code = character.codePointAt(0)!
      expect(code).toBeGreaterThanOrEqual(0x20)
      expect(code === 0x7f || (code >= 0x80 && code <= 0x9f)).toBe(false)
      expect(code === 0x202e).toBe(false)
    }
    expect(title).toContain('red')
    expect(title).toContain('alert')
  })

  it('is bounded in words and in code points, and never cut through a character', () => {
    seq = 0
    const many = foldSessionTitle([prompt(Array.from({ length: 40 }, (_unused, index) => `w${index}`).join(' '))])!
    expect(many.split(' ')).toHaveLength(TITLE_MAX_WORDS)

    // One long word of astral characters: the cut lands between code points, so
    // no surrogate half survives — a byte-wise slice would leave one.
    const long = foldSessionTitle([prompt('🙂'.repeat(200))])!
    expect([...long]).toHaveLength(TITLE_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    expect(long.includes('�')).toBe(false)
    expect([...long].slice(0, -1).every((character) => character === '🙂')).toBe(true)
  })

  it('collapses a multi-line prompt onto one line', () => {
    seq = 0
    expect(foldSessionTitle([prompt('first line\n\n   second line')])).toBe('first line second line')
  })

  it('prefers what the log recorded over what it would derive, last one winning', () => {
    seq = 0
    const events = [
      prompt('the original prompt'),
      event(SESSION_TITLE.type, { title: 'a chosen name', messageSeqs: [0], source: { kind: 'fallback' } }),
      event(SESSION_TITLE.type, { title: 'a renamed one', messageSeqs: [], source: { kind: 'user' } }),
    ]
    expect(foldSessionTitle(events)).toBe('a renamed one')
    // The derivation is still computed beside it: the writer needs both at once
    // to know whether it has anything to record.
    const state = scanSessionTitle(events)
    expect(state.recorded?.source).toEqual({ kind: 'user' })
    expect(state.fallback).toEqual({ title: 'the original prompt', messageSeqs: [0] })
  })

  it('cleans a RECORDED title too, not only a derived one', () => {
    seq = 0
    // A record is whatever the log says — this writer's, a later writer's, or a
    // hand-edited line. Two surfaces print it into a terminal and one into a
    // tab-separated row, so the escape and the tab may not survive the read.
    const hostile = `${String.fromCharCode(27)}[2K pwned${String.fromCharCode(9)}second-column`
    const title = foldSessionTitle([prompt('the real prompt'), event(SESSION_TITLE.type, { title: hostile, messageSeqs: [], source: { kind: 'user' } })])!
    expect(title).not.toContain(String.fromCharCode(27))
    expect(title).not.toContain(String.fromCharCode(9))
    expect(title).toContain('pwned')
    // A record that cleans to nothing falls through to the derivation rather
    // than naming the session with an empty string.
    expect(foldSessionTitle([prompt('the real prompt'), event(SESSION_TITLE.type, { title: '   ', messageSeqs: [], source: { kind: 'user' } })])).toBe('the real prompt')
  })

  it('never throws on a message shape it does not know', () => {
    seq = 0
    // Stored logs come back as untyped JSON, and `blockText`'s exhaustiveness
    // default is a THROW. A session that cannot be named must still be listed:
    // the caller here is a directory listing, and a throw there loses the whole
    // session, not just its name.
    for (const message of [null, 'oops', { content: 'oops', source: { kind: 'user' } }, { content: [{ type: 'audio' }], source: { kind: 'user' } }]) {
      expect(() => foldSessionTitle([event(USER_MESSAGE.type, { message })])).not.toThrow()
    }
    expect(foldSessionTitle([event(USER_MESSAGE.type, { message: { content: [{ type: 'audio' }], source: { kind: 'user' } } }), prompt('the good one')])).toBe(
      'the good one',
    )
  })

  it('has nothing to say about a session nobody has prompted', () => {
    seq = 0
    expect(foldSessionTitle([])).toBeUndefined()
    expect(foldSessionTitle([event('turn/start', { turn: 1 })])).toBeUndefined()
    expect(scanSessionTitle([])).toEqual({})
  })

  it('reads an image-only prompt through the same projection every surface uses', () => {
    seq = 0
    // `messageText`, not a filter for text blocks: an image contributes the
    // stored descriptor rather than vanishing and leaving a nameless session.
    const attachment = { id: asAttachmentId('sha256:abc'), mediaType: 'image/png', bytes: 12, width: 32, height: 32 } as const
    const message = createMessage('user', [{ type: 'image', attachment, text: '[image 32×32 png]' }], { kind: 'user' })
    expect(foldSessionTitle([event(USER_MESSAGE.type, { message })])).toBe('[image 32×32 png]')
  })
})
