import { describe, expect, it } from 'vitest'
import { cleanText, displayLines, expandTabs, fitText, graphemeWidth, stripEscapes, textWidth, truncateText } from './width.ts'
import { ASCII_GLYPHS, glyphsFor, lineText, span, UNICODE_GLYPHS, wrapLine } from './style.ts'

describe('widths', () => {
  it('counts CJK and fullwidth as two cells, emoji presentation as two, marks as none, the rest as one', () => {
    expect(textWidth('abc')).toBe(3)
    expect(textWidth('中文')).toBe(4)
    expect(textWidth('ｆｕｌｌ')).toBe(8)
    expect(textWidth('한국어')).toBe(6)
    expect(graphemeWidth('👍')).toBe(2)
    expect(graphemeWidth('👍🏽')).toBe(2)
    expect(graphemeWidth('🇯🇵')).toBe(2)
    expect(textWidth('é')).toBe(1)
    expect(textWidth('●◆▎─…')).toBe(5) // ambiguous: narrow here, as Windows Terminal draws them
  })

  it('fits and truncates by cells, never splitting a wide grapheme', () => {
    expect(fitText('中文字', 5)).toEqual({ text: '中文', width: 4 })
    expect(truncateText('hello world', 8)).toBe('hello w…')
    expect(truncateText('中文中文', 5)).toBe('中文…')
    expect(truncateText('short', 10)).toBe('short')
  })
})

describe('cleaning and display lines', () => {
  it('blanks every control and invisible character, keeping the length', () => {
    const hostile = 'a\x1b[2Jb\x07c\u202ed\u200de\x9bf'
    const clean = cleanText(hostile)
    expect([...clean]).toHaveLength([...hostile].length)
    // oxlint-disable-next-line no-control-regex
    expect(clean).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e\u200d]/u)
  })

  it('drops terminal escapes from tool output, keeps a progress line last state, expands tabs', () => {
    expect(stripEscapes('\x1b[32mPASS\x1b[0m done \x1b]0;title\x07!')).toBe('PASS done !')
    expect(displayLines('one\r\ntwo\rTWO\nthree\r')).toEqual(['one', 'TWO', 'three'])
    expect(displayLines('10%\r50%\r100%')).toEqual(['100%'])
    expect(expandTabs('a\tb', 4)).toBe('a   b')
    expect(expandTabs('中\tb', 4)).toBe('中  b')
    expect(displayLines('x\ty', { tabSize: 8 })).toEqual(['x       y'])
    // An unterminated escape is not swallowed whole: its ESC is blanked instead.
    expect(displayLines('\x1b[31')).toEqual([' [31'])
  })
})

describe('wrapping spans', () => {
  it('wraps at spaces, keeps styles, and hangs continuation rows under the prefix', () => {
    const rows = wrapLine([span('the quick brown '), span('fox', { bold: true }), span(' jumps over')], 14, { first: [span('● ')] })
    expect(rows.map(lineText)).toEqual(['● the quick', '  brown fox', '  jumps over'])
    expect(rows[1]!.find((piece) => piece.text === 'fox')?.style).toEqual({ bold: true })
  })

  it('cuts a word wider than the room, and wraps CJK without splitting a character', () => {
    expect(wrapLine([span('abcdefghij')], 4).map(lineText)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapLine([span('中文中文中')], 5).map(lineText)).toEqual(['中文', '中文', '中'])
    expect(wrapLine([], 10).map(lineText)).toEqual([''])
    // A word ending exactly at the edge stays on its row (Lane B found this one).
    expect(wrapLine([span('abcd efgh ij')], 9).map(lineText)).toEqual(['abcd efgh', 'ij'])
  })
})

describe('glyph tables', () => {
  it('picks ASCII for a dumb terminal, a non-UTF-8 POSIX locale, or on request', () => {
    expect(glyphsFor({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, 'linux')).toBe(UNICODE_GLYPHS)
    expect(glyphsFor({ TERM: 'dumb' }, 'linux')).toBe(ASCII_GLYPHS)
    expect(glyphsFor({ LANG: 'C' }, 'linux')).toBe(ASCII_GLYPHS)
    expect(glyphsFor({ MINIDSH_ASCII: '1' }, 'win32')).toBe(ASCII_GLYPHS)
    expect(glyphsFor({}, 'win32')).toBe(UNICODE_GLYPHS)
  })
})
