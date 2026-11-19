/**
 * The frame writer held to a STRICT terminal model: only the sequences the
 * writer may emit are understood (anything else is a failure, not a no-op),
 * text may not run past the right edge, the bottom-right cell is never
 * written, and after any non-ASCII grapheme the cursor is UNKNOWN until the
 * writer moves it — the model a terminal that disagrees about an emoji's or an
 * ambiguous glyph's width actually presents. `apply(prev, render(prev, next))`
 * must equal `next`, cell for cell and style for style.
 */
import { describe, expect, it } from 'vitest'
import { Frame, renderFrame } from './screen.ts'
import { span, sgrParams, type Depth, type Line, type Style } from './style.ts'
import { graphemes, graphemeWidth } from './width.ts'

interface VCell {
  ch: string
  sgr: string
}

class StrictTerminal {
  readonly cells: VCell[][]
  private x = 0
  private y = 0
  private known = true
  private sgr = ''
  sync = 0
  cursorVisible = true
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ', sgr: '' })))
  }

  apply(bytes: string): void {
    let i = 0
    while (i < bytes.length) {
      if (bytes[i] === '\x1b') {
        const rest = bytes.slice(i)
        // oxlint-disable-next-line no-control-regex no-misleading-character-class
        const match = /^\x1b\[(\?2026[hl]|\?25[hl]|2J|H|(\d+);(\d+)H|([\d;]*)m)/.exec(rest)
        if (!match) throw new Error(`the writer emitted a sequence a strict terminal does not know: ${JSON.stringify(rest.slice(0, 12))}`)
        const [whole, body] = match
        if (body === '?2026h') this.sync++
        else if (body === '?2026l') this.sync--
        else if (body === '?25h') this.cursorVisible = true
        else if (body === '?25l') this.cursorVisible = false
        else if (body === '2J') for (const row of this.cells) for (const cell of row) Object.assign(cell, { ch: ' ', sgr: '' })
        else if (body === 'H') Object.assign(this, { x: 0, y: 0, known: true })
        else if (match[2] !== undefined) {
          this.y = Number(match[2]) - 1
          this.x = Number(match[3]) - 1
          this.known = true
          if (this.y < 0 || this.y >= this.height || this.x < 0 || this.x >= this.width) throw new Error(`cursor moved off screen to ${this.x},${this.y}`)
        } else {
          const params = match[4] ?? ''
          this.sgr = params === '0' || params === '' ? '' : params.replace(/^0;/, '')
        }
        i += whole!.length
        continue
      }
      // Text: one grapheme at a time, at a known position, inside the screen.
      const g = graphemes(bytes.slice(i, i + 16))[0]!
      for (const ch of g) {
        const code = ch.codePointAt(0)!
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) throw new Error(`control U+${code.toString(16)} reached the terminal`)
      }
      if (!this.known) throw new Error(`text ${JSON.stringify(g)} written at an unknown cursor (after a non-ASCII grapheme with no move)`)
      const w = graphemeWidth(g)
      if (this.x + w > this.width) throw new Error(`text ran past the right edge at row ${this.y}`)
      if (this.y === this.height - 1 && this.x + w >= this.width) throw new Error('the bottom-right cell was written')
      this.cells[this.y]![this.x] = { ch: g, sgr: this.sgr }
      if (w === 2) this.cells[this.y]![this.x + 1] = { ch: '', sgr: this.sgr }
      this.x += w
      if (/[^\x20-\x7e]/.test(g)) this.known = false
      i += g.length
    }
  }
}

const DEPTH: Depth = 24
const expectMatches = (terminal: StrictTerminal, frame: Frame): void => {
  for (let row = 0; row < frame.height; row++) {
    for (let col = 0; col < frame.width; col++) {
      if (row === frame.height - 1 && col === frame.width - 1) continue
      const want = frame.cell(row, col)
      const got = terminal.cells[row]![col]!
      expect({ row, col, ch: got.ch, sgr: got.sgr }).toEqual({ row, col, ch: want.ch, sgr: sgrParams(want.style, DEPTH).join(';') })
    }
  }
}

function draw(frame: Frame, rows: readonly Line[]): Frame {
  rows.forEach((line, row) => frame.put(row, 0, line))
  return frame
}

describe('the frame writer', () => {
  it('draws a first frame whole, inside synchronized output, and the strict terminal agrees', () => {
    const frame = draw(new Frame(30, 4), [[span('hello '), span('world', { ink: 'accent', bold: true })], [span('中文 and 👍🏽 ok')], [span('x'.repeat(40))]])
    const bytes = renderFrame(undefined, frame, DEPTH)
    expect(bytes.startsWith('\x1b[?2026h')).toBe(true)
    expect(bytes.endsWith('\x1b[?2026l')).toBe(true)
    const terminal = new StrictTerminal(30, 4)
    terminal.apply(bytes)
    expect(terminal.sync).toBe(0)
    expectMatches(terminal, frame)
  })

  it('writes only what changed, and the result is the next frame exactly', () => {
    const before = draw(new Frame(24, 5), [[span('line one')], [span('line two 中文')], [span('three', { ink: 'ok' })]])
    const after = draw(new Frame(24, 5), [[span('line one')], [span('line 2! 中文X')], [span('three', { ink: 'error' })], [span('four')]])
    const terminal = new StrictTerminal(24, 5)
    terminal.apply(renderFrame(undefined, before, DEPTH))
    const delta = renderFrame(before, after, DEPTH)
    expect(delta).not.toContain('line one')
    terminal.apply(delta)
    expectMatches(terminal, after)
    expect(renderFrame(after, after, DEPTH)).toBe('')
  })

  it('pads a wide grapheme that would straddle the edge, and repairs one it overwrites in half', () => {
    const frame = new Frame(5, 2)
    frame.put(0, 0, [span('abcd中')])
    expect(frame.rowText(0)).toBe('abcd')
    frame.put(1, 0, [span('中中')])
    frame.put(1, 1, [span('x')])
    expect(frame.rowText(1)).toBe(' x中')
    const terminal = new StrictTerminal(5, 2)
    terminal.apply(renderFrame(undefined, frame, DEPTH))
    expectMatches(terminal, frame)
  })

  it('places and shows the cursor, and hides it when there is none', () => {
    const frame = draw(new Frame(10, 3), [[span('❯ hi')]])
    frame.cursor = { x: 4, y: 0 }
    const shown = renderFrame(undefined, frame, DEPTH)
    expect(shown).toContain('\x1b[1;5H\x1b[?25h')
    const hidden = draw(new Frame(10, 3), [[span('❯ hi')]])
    expect(renderFrame(frame, hidden, DEPTH)).toContain('\x1b[?25l')
  })

  it('never lets a control, an escape or an invisible character through, whatever the text (fuzz)', () => {
    const alphabet = ['a', ' ', '\x1b', '[', '3', '1', 'm', ']', '\x07', '\x9b', '\x00', '\x7f', '\x08', '\r', '\n', '\t', '\u202e', '\u2066', '\u200d', '\ufe0f', '中', '👍', '🏽', '́', 'é', '\u{e0041}']
    let seed = 42
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let round = 0; round < 300; round++) {
      const text = Array.from({ length: 1 + random(40) }, () => alphabet[random(alphabet.length)]).join('')
      const style: Style | undefined = random(2) === 0 ? { ink: 'warn', italic: true } : undefined
      const frame = new Frame(1 + random(30), 1 + random(4))
      frame.put(random(frame.height), random(frame.width), [span(text, style)])
      const bytes = renderFrame(undefined, frame, DEPTH)
      // The strict terminal throws on any unknown sequence or control in text.
      new StrictTerminal(frame.width, frame.height).apply(bytes)
      // oxlint-disable-next-line no-control-regex no-misleading-character-class
      const withoutOwn = bytes.replace(/\x1b\[(?:\?2026[hl]|\?25[hl]|2J|H|\d+;\d+H|[\d;]*m)/g, '')
      // oxlint-disable-next-line no-control-regex no-misleading-character-class
      expect(withoutOwn, JSON.stringify(text)).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufe00-\ufe0f]/u)
    }
  })

  it('at 16 colours and with no colour at all, meaning stays in bold, faint and glyphs', () => {
    const frame = draw(new Frame(12, 2), [[span('✓ ok', { ink: 'ok', bold: true })], [span('note', { faint: true })]])
    expect(renderFrame(undefined, frame, 4)).toContain('\x1b[0;1;32m')
    const mono = renderFrame(undefined, frame, 1)
    expect(mono).toContain('\x1b[0;1m')
    expect(mono).toContain('\x1b[0;2m')
    // oxlint-disable-next-line no-control-regex no-misleading-character-class
    expect(mono).not.toMatch(/\x1b\[[\d;]*3\dm/)
  })
})
