/**
 * The effect vocabulary's rendering, which is what a resumed model is told
 * about a call whose outcome is unknown — so every branch of it is a sentence
 * somebody acts on, and every branch is asserted here.
 */
import { describe, expect, it } from 'vitest'
import { clampIntent, describeEffect, describeEffects, describeIntent, intentKey, type EffectRecorded, type NetworkIntent, type ShellIntent } from './events.ts'

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

const intent = (over: Partial<ShellIntent> = {}): ShellIntent => ({
  effect: 'shell-command',
  command: 'pnpm check',
  mode: 'danger-full-access',
  enforcement: 'none',
  ...over,
})

const request = (over: Partial<NetworkIntent> = {}): NetworkIntent => ({
  effect: 'network-request',
  destination: 'https://api.tavily.com/search',
  credential: 'TAVILY_API_KEY',
  payload: 'node 24 release date',
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

  it('keeps the shell key byte-identical to the one every shipped grant was minted under', () => {
    // Pinned literally: a second family must not move the first one's key, or
    // every standing consent in a stored log silently stops matching.
    expect(intentKey('bash', intent())).toBe(['v1', '4', 'bash', 'shell-command', 'danger-full-access', 'none', 'raw', '10', 'pnpm check'].join('\u0000'))
  })
})

describe('the network family', () => {
  it('keys where it goes and as whom, so consent to one is not consent to another', () => {
    const base = intentKey('web_search', request())
    expect(base).toBeDefined()
    expect(intentKey('web_search', request({ destination: 'https://api.tavily.com/extract' }))).not.toBe(base)
    expect(intentKey('web_search', request({ destination: 'https://evil.example/search' }))).not.toBe(base)
    expect(intentKey('web_search', request({ credential: 'OTHER_KEY' }))).not.toBe(base)
    expect(intentKey('web_search', request({ payload: 'node 24 release dates' }))).not.toBe(base)
    expect(intentKey('fetch', request())).not.toBe(base)
    // Length prefixes again: moving a character across a field boundary is a different key.
    expect(intentKey('t', request({ destination: 'https://a/bc', payload: 'd' }))).not.toBe(intentKey('t', request({ destination: 'https://a/b', payload: 'cd' })))
  })

  it('never shares a key with a shell intent, whatever the fields hold', () => {
    const shellLike = request({ destination: 'danger-full-access', credential: 'none', payload: 'pnpm check' })
    expect(intentKey('bash', shellLike)).not.toBe(intentKey('bash', intent()))
    expect(intentKey('bash', request())?.split('\u0000')[3]).toBe('network-request')
  })

  it('escapes every field when any one carries a control character, and the mark keeps the key injective', () => {
    const NL = String.fromCharCode(10)
    const ESC = String.fromCharCode(27)
    const clamped = clampIntent(request({ payload: `q${ESC}[2Kapprove` }))
    expect(clamped.escaped).toBe(true)
    expect(clamped.payload).toBe('q\\x1b[2Kapprove')
    // The other fields went through the same escape (a backslash would double), so one mark covers all three.
    expect(clampIntent(request({ destination: 'https://a/x\\y', payload: `q${NL}` })).destination).toBe('https://a/x\\\\y')
    // A literal backslash-n typed verbatim and a real newline must stay two subjects.
    const literal = clampIntent(request({ payload: 'a\\nb' }))
    const real = clampIntent(request({ payload: `a${NL}b` }))
    expect(literal.escaped).toBeUndefined()
    expect(intentKey('web_search', literal)).not.toBe(intentKey('web_search', real))
    // An ordinary request is left verbatim, object included.
    const plain = request()
    expect(clampIntent(plain)).toBe(plain)
  })

  it('cuts an over-long payload or destination, says so, and leaves it ungrantable', () => {
    const long = clampIntent(request({ payload: 'q'.repeat(5000) }))
    expect(long.payload).toHaveLength(4000)
    expect(long.truncated).toBe(true)
    expect(intentKey('web_search', long)).toBeUndefined()
    const far = clampIntent(request({ destination: `https://a/${'p'.repeat(5000)}` }))
    expect(far.destination).toHaveLength(4000)
    expect(intentKey('web_search', far)).toBeUndefined()
  })
})

describe('describeIntent', () => {
  it('leads with the command and names the authority it would run under', () => {
    expect(describeIntent(intent())).toBe('run `pnpm check` under danger-full-access/none')
  })

  it('says a cut command was cut, rather than showing a shortened one as whole', () => {
    expect(describeIntent(clampIntent(intent({ command: 'x'.repeat(5000) })))).toContain('cut at 4000 characters')
  })

  it('names what a network request sends, where to, and as whom', () => {
    expect(describeIntent(request())).toBe('send `node 24 release date` to https://api.tavily.com/search as TAVILY_API_KEY')
    expect(describeIntent(clampIntent(request({ payload: 'a\u0007b' })))).toBe(
      'send `a\\x07b` to https://api.tavily.com/search as TAVILY_API_KEY […control or invisible characters shown escaped]',
    )
  })

  // The S18 review's reproduction: a visible query with a secret encoded in
  // Unicode TAG characters after it rendered as the query alone, unmarked,
  // while the hidden text went out in the request body.
  it('shows every invisible character a payload or a command would carry, so a consent covers what is sent', () => {
    const hidden = [...'sk-1'].map((ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0)!)).join('')
    const tagged = clampIntent(request({ payload: `node 24 release date${hidden}` }))
    expect(tagged.escaped).toBe(true)
    expect(describeIntent(tagged)).toContain('\\u{e0073}\\u{e006b}\\u{e002d}\\u{e0031}')
    for (const sneaky of ['a​b', 'a‮b', 'a b', 'a️b', 'ab']) {
      expect(clampIntent(intent({ command: sneaky })).escaped, JSON.stringify(sneaky)).toBe(true)
      expect(intentKey('bash', clampIntent(intent({ command: sneaky })))).not.toBe(intentKey('bash', clampIntent(intent({ command: 'ab' }))))
    }
    // Ordinary non-ASCII text is not invisible and stays verbatim.
    expect(clampIntent(intent({ command: 'echo café 中文' })).escaped).toBeUndefined()
  })
})
