/**
 * The effect vocabulary's rendering, which is what a resumed model is told
 * about a call whose outcome is unknown — so every branch of it is a sentence
 * somebody acts on, and every branch is asserted here.
 */
import { describe, expect, it } from 'vitest'
import { clampIntent, describeEffect, describeEffects, describeIntent, intentKey, type EffectIntent, type EffectRecorded } from './events.ts'

const write = (over: Partial<Extract<EffectRecorded, { effect: 'fs-write' }>> = {}): EffectRecorded => ({
  callId: 'c1',
  effect: 'fs-write',
  path: '/ws/notes.txt',
  bytes: 15,
  sha256: 'a1b2c3d4e5f6a7b8c9d0',
  ...over,
})
const command = (over: Partial<Extract<EffectRecorded, { effect: 'shell-command' }>> = {}): EffectRecorded => ({
  callId: 'c1',
  effect: 'shell-command',
  durationMs: 1234,
  mode: 'workspace-write',
  enforcement: 'full',
  ...over,
})

describe('describeEffect', () => {
  it('names the file, its size and enough hash to check it against the disk', () => {
    expect(describeEffect(write())).toBe('wrote /ws/notes.txt (15 bytes, sha256 a1b2c3d4e5f6)')
  })

  it('neutralizes a control character in a path rather than passing it to a terminal', () => {
    // An ESC in a filename would erase the line a person is reading and
    // repaint another one; the path stays exact in the LOG, never in the line.
    expect(describeEffect(write({ path: '/ws/we\u001b[2Kird.txt' }))).toBe('wrote /ws/we [2Kird.txt (15 bytes, sha256 a1b2c3d4e5f6)')
  })

  it('tells the four shell outcomes apart', () => {
    expect(describeEffect(command({ exitCode: 0 }))).toBe('ran a shell command under workspace-write/full (exit 0, 1.2s)')
    expect(describeEffect(command({ exitCode: 127 }))).toBe('ran a shell command under workspace-write/full (exit 127, 1.2s)')
    // `timedOut` OUTRANKS a missing exit code: a killed command has neither,
    // and "no exit code" would lose the one fact that explains it.
    expect(describeEffect(command({ timedOut: true, durationMs: 120_000 }))).toBe('ran a shell command under workspace-write/full (timed out, 120.0s)')
    expect(describeEffect(command({ durationMs: 40 }))).toBe('ran a shell command under workspace-write/full (no exit code, 40ms)')
  })

  it('switches units at a second, so neither a fast command nor a slow one reads as noise', () => {
    expect(describeEffect(command({ exitCode: 0, durationMs: 999 }))).toContain('999ms')
    expect(describeEffect(command({ exitCode: 0, durationMs: 1000 }))).toContain('1.0s')
  })

  it('reports the authority the command actually got, whatever it was', () => {
    expect(describeEffect(command({ exitCode: 0, mode: 'danger-full-access', enforcement: 'none' }))).toContain('under danger-full-access/none')
  })
})

describe('describeEffects', () => {
  it('says nothing when the log recorded nothing', () => {
    expect(describeEffects([])).toBeUndefined()
  })

  it('states its own incompleteness, because a model reads a list as an inventory', () => {
    const sentence = describeEffects([write()])!
    expect(sentence).toContain('not a complete list')
    expect(sentence).toContain('wrote /ws/notes.txt')
    expect(sentence.endsWith('.')).toBe(true)
  })

  it('bounds the line and says how much it left out', () => {
    const many = Array.from({ length: 7 }, (_, index) => write({ path: `/ws/f${index}.txt` }))
    const sentence = describeEffects(many)!
    expect(sentence).toContain('/ws/f4.txt')
    expect(sentence).not.toContain('/ws/f5.txt')
    expect(sentence).toContain('and 2 more')
  })
})

// ---- the "about to do" half ------------------------------------------------

const intent = (over: Partial<EffectIntent> = {}): EffectIntent => ({
  effect: 'shell-command',
  command: 'pnpm check',
  mode: 'danger-full-access',
  enforcement: 'none',
  ...over,
})

describe('clampIntent', () => {
  it('neutralizes a command that would repaint the line a person is answering', () => {
    // The `reason` forgery (see approval.test.ts) applied to the field that
    // replaces it: an ESC in a command must not reach a terminal as an ESC.
    const CR = String.fromCharCode(13)
    const ESC = String.fromCharCode(27)
    const clamped = clampIntent(intent({ command: `echo ok${CR}${ESC}[2Kapprove pwsh (list a file)` }))
    const control = (ch: string): boolean => ch.codePointAt(0)! < 0x20 || (ch.codePointAt(0)! >= 0x7f && ch.codePointAt(0)! <= 0x9f)
    expect([...clamped.command].some(control)).toBe(false)
    expect(clamped.command).toContain('echo ok')
    expect(clamped.truncated).toBeUndefined()
  })

  it('leaves an ordinary command identical, object included', () => {
    const original = intent()
    expect(clampIntent(original)).toBe(original)
  })

  it('cuts an over-long command and SAYS it cut one', () => {
    const clamped = clampIntent(intent({ command: 'x'.repeat(5000) }))
    expect(clamped.command).toHaveLength(4000)
    expect(clamped.truncated).toBe(true)
  })
})

describe('intentKey', () => {
  it('separates two commands that differ only in the authority they would run under', () => {
    const wide = intentKey('bash', intent({ mode: 'danger-full-access' }))
    const narrow = intentKey('bash', intent({ mode: 'workspace-write' }))
    const unconfined = intentKey('bash', intent({ enforcement: 'none' }))
    const confined = intentKey('bash', intent({ enforcement: 'full' }))
    expect(wide).not.toBe(narrow)
    expect(unconfined).not.toBe(confined)
    // Consent to a command under one tool is not consent under another.
    expect(intentKey('bash', intent())).not.toBe(intentKey('pwsh', intent()))
  })

  it('cannot be collided by a command that contains the separator or the tool name', () => {
    // Length prefixes are why: without them `bash` + `\0x` and `bas` + `h\0x`
    // would flatten to the same string.
    const a = intentKey('bash', intent({ command: 'a\u0000shell-command\u0000danger-full-access' }))
    const b = intentKey('bash', intent({ command: 'a' }))
    expect(a).not.toBe(b)
    expect(intentKey('bash', intent({ command: 'ab' }))).not.toBe(intentKey('basha', intent({ command: 'b' })))
  })

  it('refuses a key for a truncated subject, so a cut command can never be granted', () => {
    // Two different 4000-character commands sharing a prefix would otherwise be
    // one grant. Losing the key is the fail-closed direction.
    expect(intentKey('bash', clampIntent(intent({ command: 'x'.repeat(5000) })))).toBeUndefined()
  })

  it('is stable across calls, because a grant outlives the process that took it', () => {
    expect(intentKey('bash', intent())).toBe(intentKey('bash', { ...intent() }))
  })
})

describe('describeIntent', () => {
  it('leads with the command and names the authority it would run under', () => {
    expect(describeIntent(intent())).toBe('run `pnpm check` under danger-full-access/none')
  })

  it('says a cut command was cut, rather than showing a shortened one as whole', () => {
    expect(describeIntent(clampIntent(intent({ command: 'x'.repeat(5000) })))).toContain('cut at 4000 characters')
  })
})
