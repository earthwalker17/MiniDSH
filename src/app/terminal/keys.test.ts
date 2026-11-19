/**
 * The stdin decoder against what terminals were measured to send (Windows
 * Terminal and ConPTY under Node 24 raw mode, plus the POSIX forms), the
 * replies a terminal writes back on the same stream, chunking at every byte,
 * the unbracketed-paste burst rule under an injected clock, and the bounds.
 */
import { describe, expect, it } from 'vitest'
import { KeyDecoder, type Key } from './keys.ts'

const fixed = (): number => 0

/** Feeds each chunk, then flushes: every key the stream produces. */
function decode(...chunks: (string | Uint8Array)[]): Key[] {
  const decoder = new KeyDecoder({ now: fixed })
  const keys = chunks.flatMap((chunk) => decoder.feed(chunk))
  return [...keys, ...decoder.flush()]
}

const text = (t: string): Key => ({ kind: 'text', text: t })
const pasted = (t: string): Key => ({ kind: 'text', text: t, paste: true })
const key = (name: string, mods: { ctrl?: true; alt?: true; shift?: true } = {}): Key => ({ kind: 'key', name, ...mods })

/** Typed text coalesces per chunk by contract, so a split may divide a run: compare with adjacent plain text joined. */
function joined(keys: readonly Key[]): Key[] {
  const out: Key[] = []
  for (const k of keys) {
    const last = out.at(-1)
    if (k.kind === 'text' && k.paste === undefined && last?.kind === 'text' && last.paste === undefined) out[out.length - 1] = text(last.text + k.text)
    else out.push(k)
  }
  return out
}

describe('measured sequences', () => {
  const MEASURED: readonly (readonly [string, string, readonly Key[]])[] = [
    ['Enter, Shift+Enter, Alt+Enter on Windows', '\r', [key('enter')]],
    ['Ctrl+Enter and Ctrl+J', '\n', [key('linefeed')]],
    ['Alt+x on Windows (alt lost)', 'x', [text('x')]],
    ['Alt+Left', '\x1b[1;3D', [key('left', { alt: true })]],
    ['Alt+Backspace', '\x1b\x7f', [key('backspace', { alt: true })]],
    ['Backspace', '\x7f', [key('backspace')]],
    ['Ctrl+Backspace', '\x08', [key('backspace', { ctrl: true })]],
    ['Ctrl+C', '\x03', [key('c', { ctrl: true })]],
    ['Shift+Up', '\x1b[1;2A', [key('up', { shift: true })]],
    ['Ctrl+Left', '\x1b[1;5D', [key('left', { ctrl: true })]],
    ['Home', '\x1b[H', [key('home')]],
    ['End', '\x1b[F', [key('end')]],
    ['Ctrl+Home', '\x1b[1;5H', [key('home', { ctrl: true })]],
    ['PgUp', '\x1b[5~', [key('pageup')]],
    ['Delete', '\x1b[3~', [key('delete')]],
    ['IME text in one chunk', '中文', [text('中文')]],
    ['SS3 Up', '\x1bOA', [key('up')]],
    ['CSI u Shift+Enter', '\x1b[13;2u', [key('enter', { shift: true })]],
    ['modifyOtherKeys Shift+Enter', '\x1b[27;2;13~', [key('enter', { shift: true })]],
    ['POSIX Alt+Enter', '\x1b\r', [key('enter', { alt: true })]],
    ['POSIX Alt+x', '\x1bx', [key('x', { alt: true })]],
  ]

  for (const [label, input, expected] of MEASURED) {
    it(`${label}: ${JSON.stringify(input)}`, () => {
      for (const chunk of [input, new TextEncoder().encode(input)]) {
        const decoder = new KeyDecoder({ now: fixed })
        expect(decoder.feed(chunk)).toEqual(expected)
        expect(decoder.pending).toBe(false)
      }
    })
  }

  it('Esc arrives alone and is held until the caller flushes', () => {
    const decoder = new KeyDecoder({ now: fixed })
    expect(decoder.feed('\x1b')).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.flush()).toEqual([key('escape')])
    expect(decoder.pending).toBe(false)
    expect(decoder.flush()).toEqual([])
  })

  it('the wheel on the alternate screen is arrow keys, one per chunk', () => {
    const decoder = new KeyDecoder({ now: fixed })
    expect(decoder.feed('\x1b[A')).toEqual([key('up')])
    expect(decoder.feed('\x1b[B')).toEqual([key('down')])
    expect(decoder.feed('\x1b[A\x1b[A\x1b[B')).toEqual([key('up'), key('up'), key('down')])
  })

  it('a bracketed paste split across 1024-byte chunks ~20 ms apart is one paste, nothing emitted before its end', () => {
    const lines = Array.from({ length: 120 }, (_, n) => `line ${n}: 中文 and ascii, a little longer`)
    const bytes = new TextEncoder().encode(`\x1b[200~${lines.join('\r')}\x1b[201~`)
    let t = 0
    const decoder = new KeyDecoder({ now: () => t })
    const out: Key[] = []
    for (let at = 0; at < bytes.length; at += 1024) {
      t += 20
      const keys = decoder.feed(bytes.subarray(at, at + 1024))
      if (at + 1024 < bytes.length) {
        expect(keys).toEqual([])
        expect(decoder.pending).toBe(true)
        expect(decoder.pasting).toBe(true)
      }
      out.push(...keys)
    }
    expect(bytes.length).toBeGreaterThan(4 * 1024)
    expect(out).toEqual([pasted(lines.join('\n'))])
    expect(decoder.pending).toBe(false)
  })

  it('a plain paste in 1024-byte chunks with CR separators never becomes Enter', () => {
    const content = `${Array.from({ length: 150 }, (_, n) => `row ${n} of the pasted text`).join('\r')}\r`
    const bytes = new TextEncoder().encode(content)
    let t = 0
    const decoder = new KeyDecoder({ now: () => t })
    const out: Key[] = []
    for (let at = 0; at < bytes.length; at += 1024) {
      t += 20
      out.push(...decoder.feed(bytes.subarray(at, at + 1024)))
    }
    expect(out.every((k) => k.kind === 'text' && k.paste === true)).toBe(true)
    expect(out.map((k) => (k.kind === 'text' ? k.text : '')).join('')).toBe(content.replace(/\r/g, '\n'))
  })
})

describe('the rest of the key map', () => {
  it('control bytes', () => {
    expect(decode('\t')).toEqual([key('tab')])
    expect(decode('\x00')).toEqual([key(' ', { ctrl: true })])
    expect(decode('\x01')).toEqual([key('a', { ctrl: true })])
    expect(decode('\x1a')).toEqual([key('z', { ctrl: true })])
    expect(decode('\x1c\x1d\x1e\x1f')).toEqual(['\\', ']', '^', '_'].map((name) => key(name, { ctrl: true })))
  })

  it('CSI ~ keys, function keys and back-tab', () => {
    expect(decode('\x1b[1~\x1b[7~\x1b[4~\x1b[8~')).toEqual([key('home'), key('home'), key('end'), key('end')])
    expect(decode('\x1b[2~\x1b[6~\x1b[5;5~')).toEqual([key('insert'), key('pagedown'), key('pageup', { ctrl: true })])
    expect(decode('\x1b[11~\x1b[15~\x1b[17~\x1b[21~\x1b[23~\x1b[24~')).toEqual(['f1', 'f5', 'f6', 'f10', 'f11', 'f12'].map((name) => key(name)))
    expect(decode('\x1b[3;8~')).toEqual([key('delete', { ctrl: true, alt: true, shift: true })])
    expect(decode('\x1b[Z')).toEqual([key('tab', { shift: true })])
    expect(decode('\x1b[99~')).toEqual([])
  })

  it('SS3 keys, with and without a modifier digit', () => {
    expect(decode('\x1bOP\x1bOS\x1bOH\x1bOF\x1bOM')).toEqual([key('f1'), key('f4'), key('home'), key('end'), key('enter')])
    expect(decode('\x1bO5C')).toEqual([key('right', { ctrl: true })])
  })

  it('CSI u and modifyOtherKeys: modified characters are keys, unmodified ones are text', () => {
    expect(decode('\x1b[97;5u')).toEqual([key('a', { ctrl: true })])
    expect(decode('\x1b[9;2u\x1b[27u\x1b[127;3u')).toEqual([key('tab', { shift: true }), key('escape'), key('backspace', { alt: true })])
    expect(decode('\x1b[27;5;106~')).toEqual([key('j', { ctrl: true })])
    expect(decode('\x1b[97u\x1b[97;2u')).toEqual([text('aA')])
    expect(decode('\x1b[13:13;2:1u')).toEqual([key('enter', { shift: true })])
  })

  it('ESC before a character is Alt; uppercase is shift; ESC ESC is Escape then a fresh ESC', () => {
    expect(decode('\x1bX')).toEqual([key('x', { alt: true, shift: true })])
    expect(decode('\x1b.')).toEqual([key('.', { alt: true })])
    expect(decode('\x1b\x08')).toEqual([key('backspace', { ctrl: true, alt: true })])
    expect(decode('\x1b\x1b')).toEqual([key('escape'), key('escape')])
    expect(decode('\x1b\x1b[A')).toEqual([key('escape'), key('up')])
  })

  it('a broken CSI prefix is dropped and the character that interrupted it is read', () => {
    expect(decode('\x1b[1;\r')).toEqual([key('enter')])
    expect(decode('\x1b[\x1b[B')).toEqual([key('down')])
  })

  it('UTF-8 split inside a code point still decodes', () => {
    const bytes = new TextEncoder().encode('中👍🏽')
    expect(joined(decode(...Array.from(bytes, (b) => Uint8Array.of(b))))).toEqual([text('中👍🏽')])
  })

  it('text runs coalesce into one key per chunk, around keys', () => {
    expect(decode('ab\x1b[Acd')).toEqual([text('ab'), key('up'), text('cd')])
  })
})

describe('terminal replies are swallowed', () => {
  const DA1 = '\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c'
  const DECRPM = '\x1b[?2026;2$y'
  const OSC = '\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\'
  const replies = DA1 + DECRPM + OSC

  it('all three in one chunk', () => {
    const decoder = new KeyDecoder({ now: fixed })
    expect(decoder.feed(replies)).toEqual([])
    expect(decoder.pending).toBe(false)
  })

  it('between typed characters, which still read as one text', () => {
    expect(decode(`a${replies}b`)).toEqual([text('ab')])
  })

  it('split across chunks at every position', () => {
    for (let at = 0; at <= replies.length; at++) {
      const decoder = new KeyDecoder({ now: fixed })
      expect([...decoder.feed(replies.slice(0, at)), ...decoder.feed(replies.slice(at))]).toEqual([])
      expect(decoder.pending).toBe(false)
    }
    // One byte at a time, too.
    const decoder = new KeyDecoder({ now: fixed })
    expect([...replies].flatMap((ch) => decoder.feed(ch))).toEqual([])
    expect(decoder.pending).toBe(false)
  })

  it('other reports and strings: CPR, focus, mouse, OSC with BEL, DCS, APC, PM', () => {
    expect(decode('\x1b[12;40R\x1b[I\x1b[O\x1b[<0;10;5M\x1b[>0;10;1c')).toEqual([])
    expect(decode('\x1b]0;title\x07\x1bP1$r0m\x1b\\\x1b_payload\x1b\\\x1b^private\x1b\\')).toEqual([])
    expect(decode('\x1b]52;c;aGk=\x9cq')).toEqual([text('q')])
  })
})

describe('byte-split invariance', () => {
  const CORPUS = [
    '\r',
    '\n',
    'ab\r',
    '\x1b[1;3D',
    '\x1b\x7f',
    '\x7f\x08\x03',
    '\x1b[1;2A\x1b[1;5D',
    '\x1b[H\x1b[F\x1b[1;5H\x1b[5~\x1b[3~',
    '\x1bOA\x1bOP\x1bO5C',
    '\x1b[13;2u\x1b[27;2;13~\x1b[97;5u',
    '\x1b\r\x1bx\x1bX',
    'a\x1b',
    '\x1b\x1b[A',
    '\x1b[Z\t',
    '\x1b[200~line one\r\nline two\rthree 中文 👍🏽 \x1b[A\x1b[201~',
    '中文',
    '👍🏽',
    'é',
    '\x1b[?61;4;6c\x1b[?2026;2$y\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\',
    '\x1b]0;title\x07\x1bP1$r0m\x1b\\',
  ]
  // Every non-burst input at once: no top-level line break, so no chunk of it is ever a paste burst.
  const topLevelBreak = (s: string): boolean => {
    const esc = s.indexOf('\x1b')
    const br = s.search(/[\r\n]/)
    return br >= 0 && (esc < 0 || br < esc)
  }
  const all = CORPUS.filter((s) => !topLevelBreak(s)).join('')

  for (const input of [...CORPUS, all]) {
    it(JSON.stringify(input), () => {
      const bytes = new TextEncoder().encode(input)
      const whole = joined(decode(bytes))
      for (let at = 0; at <= bytes.length; at++) {
        expect(joined(decode(bytes.subarray(0, at), bytes.subarray(at))), `split at byte ${at}`).toEqual(whole)
      }
    })
  }
})

describe('held sequences', () => {
  it('a held ESC continues into the next chunk', () => {
    const decoder = new KeyDecoder({ now: fixed })
    expect(decoder.feed('a\x1b')).toEqual([text('a')])
    expect(decoder.pending).toBe(true)
    expect(decoder.feed('[A')).toEqual([key('up')])
    expect(decoder.pending).toBe(false)
  })

  it('flush drops an unfinished sequence, and input after it reads normally', () => {
    const decoder = new KeyDecoder({ now: fixed })
    expect(decoder.feed('\x1b[1;')).toEqual([])
    expect(decoder.flush()).toEqual([])
    expect(decoder.feed('x')).toEqual([text('x')])
    expect(decoder.feed('\x1b]11;rgb:')).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.flush()).toEqual([])
    expect(decoder.pending).toBe(false)
  })
})

describe('bracketed paste', () => {
  it('interprets nothing inside and normalizes line breaks', () => {
    expect(decode('\x1b[200~a\x1b[Ab\x03\x1b]11;x\x07\r\nc\rd\x1b[201~')).toEqual([pasted('a\x1b[Ab\x03\x1b]11;x\x07\nc\nd')])
  })

  it('finds its end marker split across chunks, and not a lookalike', () => {
    expect(decode('\x1b[200~abc\x1b[20', '1~z')).toEqual([pasted('abc'), text('z')])
    expect(decode('\x1b[200~a\x1b[2', 'xb\x1b[201~')).toEqual([pasted('a\x1b[2xb')])
  })

  it('flush emits an open paste; an empty paste emits nothing; a stray end marker is swallowed', () => {
    const decoder = new KeyDecoder({ now: fixed })
    expect(decoder.feed('\x1b[200~abc\r\x1b[20')).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.flush()).toEqual([pasted('abc\n\x1b[20')])
    expect(decoder.pending).toBe(false)
    expect(decoder.feed('\x1b[201~')).toEqual([])
    expect(decode('\x1b[200~\x1b[201~')).toEqual([])
  })
})

describe('unbracketed paste bursts', () => {
  it('a chunk of three or more printable characters with a line break is one paste, a CR at its end included', () => {
    expect(decode('abc\rdef')).toEqual([pasted('abc\ndef')])
    expect(decode('hello\r')).toEqual([pasted('hello\n')])
    expect(decode('a\r\nb\r\nc')).toEqual([pasted('a\nb\nc')])
    expect(decode('col1\tcol2\n')).toEqual([pasted('col1\tcol2\n')])
  })

  it('fewer than three printable characters is typing: text then Enter', () => {
    expect(decode('ab\r')).toEqual([text('ab'), key('enter')])
    expect(decode('abc')).toEqual([text('abc')])
  })

  it('escape sequences and other controls inside a burst still decode, splitting it', () => {
    expect(decode('one\r\x1b[Atwo')).toEqual([pasted('one\n'), key('up'), pasted('two')])
    expect(decode('one\rtwo\x03')).toEqual([pasted('one\ntwo'), key('c', { ctrl: true })])
  })

  it('a line-break chunk within the grace window continues the paste; after it, CR is Enter again', () => {
    let t = 1000
    const decoder = new KeyDecoder({ now: () => t, pasteGraceMs: 120 })
    expect(decoder.feed('first line\rsecond')).toEqual([pasted('first line\nsecond')])
    t += 50
    expect(decoder.feed('\r')).toEqual([pasted('\n')])
    t += 100 // within the window of the previous line-break chunk
    expect(decoder.feed('x\r')).toEqual([pasted('x\n')])
    t += 121
    expect(decoder.feed('\r')).toEqual([key('enter')])
    t += 10
    expect(decoder.feed('\r')).toEqual([key('enter')])
  })

  it('a chunk without a line break never opens or extends a burst', () => {
    let t = 0
    const decoder = new KeyDecoder({ now: () => t })
    expect(decoder.feed('abc\rdef')).toEqual([pasted('abc\ndef')])
    t += 10
    expect(decoder.feed('tail')).toEqual([text('tail')])
    t += 10
    expect(decoder.feed('\x1b[A')).toEqual([key('up')])
  })
})

describe('bounds', () => {
  it('a CSI past the bound is swallowed whole, in one chunk or across many', () => {
    expect(decode(`\x1b[${'1;'.repeat(200)}5Az`)).toEqual([text('z')])
    const decoder = new KeyDecoder({ now: fixed })
    expect(decoder.feed('\x1b[')).toEqual([])
    for (let n = 0; n < 100; n++) expect(decoder.feed('1;'.repeat(25))).toEqual([])
    expect(decoder.feed('A')).toEqual([])
    expect(decoder.pending).toBe(false)
    expect(decoder.feed('q')).toEqual([text('q')])
  })

  it('an unterminated OSC never grows the held buffer: 4 MiB in 1 KiB chunks stays linear', () => {
    const decoder = new KeyDecoder({ now: fixed })
    const junk = 'x'.repeat(1024)
    expect(decoder.feed('\x1b]52;c;')).toEqual([])
    const started = performance.now()
    for (let n = 0; n < 4096; n++) decoder.feed(junk)
    // Re-scanning an unbounded buffer would be ~8 G character visits here; bounded it is ~20 M.
    expect(performance.now() - started).toBeLessThan(5000)
    expect(decoder.pending).toBe(true)
    expect(decoder.feed('\x1b')).toEqual([])
    expect(decoder.feed('\\q')).toEqual([text('q')])
    expect(decoder.pending).toBe(false)
  })

  it('a bracketed paste keeps its first 4 MiB and still closes cleanly', () => {
    const decoder = new KeyDecoder({ now: fixed })
    const mib = 'a'.repeat(1024 * 1024)
    expect(decoder.feed('\x1b[200~')).toEqual([])
    for (let n = 0; n < 5; n++) expect(decoder.feed(mib)).toEqual([])
    const keys = decoder.feed('\x1b[201~z')
    expect(keys).toHaveLength(2)
    const [paste, after] = keys
    expect(paste?.kind === 'text' && paste.paste === true && paste.text.length).toBe(4 * 1024 * 1024)
    expect(after).toEqual(text('z'))
  })

  it('the paste cap never splits a surrogate pair', () => {
    const decoder = new KeyDecoder({ now: fixed })
    decoder.feed(`\x1b[200~${'a'.repeat(4 * 1024 * 1024 - 1)}`)
    const [paste] = decoder.feed('👍\x1b[201~')
    expect(paste?.kind === 'text' && paste.text.length).toBe(4 * 1024 * 1024 - 1)
  })
})
