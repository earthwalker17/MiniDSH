/**
 * Text for a terminal cell grid: what a string LOOKS like in cells, and the
 * one rule that keeps a byte nobody vetted from reaching the screen.
 *
 * Every string the full-screen terminal draws — a model's answer, a tool's
 * output, a path from a log, a session title — passes `cleanText` before it
 * is measured, and the screen's cell writer (`screen.ts`) cleans again per
 * grapheme, so nothing laid out elsewhere can smuggle a control through. The
 * rule is `core/text.ts`'s (§8): a C0/C1 control and anything that renders as
 * NOTHING (a bidi override, a joiner, a variation selector, a TAG) becomes a
 * space, so what a person reads is what the model was shown. Structure is
 * layout's job, BEFORE cleaning: `\r\n` is a line break, a bare `\r` is a
 * progress line keeping its last segment, a tab expands to the next stop, and
 * a terminal escape sequence in tool output (colour, cursor moves) is dropped
 * from the display rather than shown as `[32m`.
 *
 * Widths: Intl.Segmenter graphemes, East Asian Wide and Fullwidth ranges and
 * emoji presentation are two cells, combining marks none, everything else
 * one. East Asian AMBIGUOUS glyphs (`● ◆ ▎ ─ …`) are one cell here, as Windows
 * Terminal and most Western fonts draw them; a CJK font that draws them wide
 * is answered by the ASCII glyph table (`style.ts`), and the writer positions
 * every run with CUP so a disagreement cannot drift past one run. Joiners and
 * variation selectors never reach a measurement: cleaning made them spaces,
 * and the terminal is shown those spaces too, so both sides count the same.
 */
import { isInvisible } from '../../core/text.ts'

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** East Asian Wide (W) and Fullwidth (F) ranges outside emoji, Unicode 15. Sorted, inclusive. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cd5],
  [0x1b000, 0x1b2fb],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const ZERO_WIDTH = /^[\p{Mn}\p{Me}]$/u
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u

function inWide(cp: number): boolean {
  let lo = 0
  let hi = WIDE.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [from, to] = WIDE[mid]!
    if (cp < from) hi = mid - 1
    else if (cp > to) lo = mid + 1
    else return true
  }
  return false
}

/** One grapheme's width in cells: 0, 1 or 2. */
export function graphemeWidth(grapheme: string): number {
  const cp = grapheme.codePointAt(0)
  if (cp === undefined) return 0
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (ZERO_WIDTH.test(grapheme)) return 0
  if (cp < 0x1100) return 1
  if (inWide(cp)) return 2
  if (REGIONAL.test(grapheme)) return 2
  if (EMOJI_PRESENTATION.test(String.fromCodePoint(cp))) return 2
  return 1
}

/** The graphemes of a string, in order. */
export function graphemes(text: string): string[] {
  const out: string[] = []
  for (const { segment } of SEGMENTER.segment(text)) out.push(segment)
  return out
}

/** Display width in cells of text that is already clean (one line, no controls). */
export function textWidth(text: string): number {
  let width = 0
  // ASCII fast path: most of a transcript is.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length
  for (const g of graphemes(text)) width += graphemeWidth(g)
  return width
}

/**
 * The cleaning rule, for ONE line: every C0/C1 control and every invisible
 * character becomes a space (`core/text.ts`), so the result has as many code
 * points as the input. A tab or a newline here is a caller's layout bug and is
 * blanked like any other control.
 */
export function cleanText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) || isInvisible(ch) ? ' ' : ch
  }
  return out
}

/**
 * Terminal escape sequences, as a terminal would consume them: CSI (`ESC [`
 * … final byte), OSC (`ESC ]` … BEL or ST), other string sequences (DCS, SOS,
 * PM, APC, terminated by ST) and two-byte escapes. Matched lazily and bounded,
 * so a hostile unterminated one costs linear time and leaves its ESC to be
 * blanked by `cleanText`.
 */
// oxlint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\[[\x30-\x3f]{0,64}[\x20-\x2f]{0,8}[\x40-\x7e]|\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)|[PX^_][^\x1b]{0,4096}\x1b\\|[\x40-\x5a\x5c\x5e\x5f])|\x9b[\x30-\x3f]{0,64}[\x20-\x2f]{0,8}[\x40-\x7e]/g

/** Drops well-formed terminal escape sequences from tool output (the display only; the log keeps the bytes). */
export function stripEscapes(text: string): string {
  return text.includes('\x1b') || text.includes('\x9b') ? text.replace(ESCAPES, '') : text
}

/** Tabs to spaces at `tabSize` stops, measured in cells from the start of the line. */
export function expandTabs(line: string, tabSize: number): string {
  if (!line.includes('\t')) return line
  let out = ''
  let column = 0
  for (const g of graphemes(line)) {
    if (g === '\t') {
      const pad = tabSize - (column % tabSize)
      out += ' '.repeat(pad)
      column += pad
    } else {
      out += g
      column += graphemeWidth(g)
    }
  }
  return out
}

/**
 * Raw text (a tool's output, a model's code block) to display lines:
 * escapes dropped, `\r\n` a break, a bare `\r` keeping the segment after the
 * last one (a progress bar shows its final state), tabs expanded, each line
 * cleaned. The one entry point for multi-line text this surface did not write.
 */
export function displayLines(text: string, { tabSize = 8, escapes = true }: { tabSize?: number; escapes?: boolean } = {}): string[] {
  const source = escapes ? stripEscapes(text) : text
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const cr = line.lastIndexOf('\r', line.length - 2)
      const visible = cr >= 0 ? line.slice(cr + 1) : line
      return cleanText(expandTabs(visible.replace(/\r$/, ''), tabSize))
    })
}

/**
 * The longest prefix of clean text that fits `width` cells, and the width it
 * takes. A wide grapheme that would straddle the edge is left out.
 */
export function fitText(text: string, width: number): { text: string; width: number } {
  if (width <= 0) return { text: '', width: 0 }
  if (/^[\x20-\x7e]*$/.test(text)) return text.length <= width ? { text, width: text.length } : { text: text.slice(0, width), width }
  let used = 0
  let out = ''
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g)
    if (used + w > width) break
    out += g
    used += w
  }
  return { text: out, width: used }
}

/** Clean text cut to `width` cells with a trailing ellipsis when it did not fit. */
export function truncateText(text: string, width: number, ellipsis = '…'): string {
  if (textWidth(text) <= width) return text
  const room = Math.max(0, width - textWidth(ellipsis))
  return `${fitText(text, room).text}${ellipsis}`
}
