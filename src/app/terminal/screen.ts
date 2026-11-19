/**
 * The full-screen terminal's frame: a grid of cells a layout composes, and
 * the writer that turns the difference between two frames into the fewest
 * bytes a terminal needs.
 *
 * **The one cell writer.** `Frame.put` is the only way text enters a frame,
 * and it cleans every grapheme with the `core/text.ts` rule (`width.ts`), so
 * no layout bug can deliver an ESC, a C1 control or a bidi override to the
 * terminal: the only escape sequences `renderFrame` ever emits are its own.
 *
 * **What the writer guarantees** (held by the strict applier in
 * `screen.test.ts`): every changed run starts with an absolute cursor move,
 * and so does the cell after any non-ASCII grapheme — terminals disagree about
 * emoji and East Asian Ambiguous widths, and a run positioned per grapheme
 * cannot drift past the glyph they disagree on. A wide grapheme never starts
 * in the last column (it is padded), the bottom-right cell is never written (a
 * terminal with autowrap would scroll), and a frame is wrapped in DEC 2026
 * synchronized output, which Windows Terminal supports (measured) and others
 * ignore, so a person never sees half a frame.
 */
import { cleanText, graphemes, graphemeWidth } from './width.ts'
import { sameStyle, sgrParams, type Depth, type Line, type Style } from './style.ts'

export interface Cell {
  /** One grapheme, or '' for the right half of a wide one. */
  readonly ch: string
  /** 1 or 2 for a grapheme's first cell, 0 for a wide grapheme's second. */
  readonly width: 0 | 1 | 2
  readonly style?: Style
}

const BLANK: Cell = { ch: ' ', width: 1 }

export interface CursorPos {
  readonly x: number
  readonly y: number
}

export class Frame {
  readonly width: number
  readonly height: number
  readonly cells: Cell[]
  /** Where the hardware cursor shows (the composer's insertion point), or hidden. */
  cursor: CursorPos | undefined

  constructor(width: number, height: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.cells = Array.from({ length: this.width * this.height }, () => BLANK)
    this.cursor = undefined
  }

  cell(row: number, col: number): Cell {
    return this.cells[row * this.width + col] ?? BLANK
  }

  private set(row: number, col: number, cell: Cell): void {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) return
    this.cells[row * this.width + col] = cell
  }

  /**
   * Writes a styled line at (row, col), clipped at `maxCol` (exclusive,
   * default the frame's width). Every grapheme is cleaned; a wide one that
   * would straddle the clip is replaced by a blank. Overwriting half of a wide
   * cell blanks its other half. Returns the column after the last cell written.
   */
  put(row: number, col: number, line: Line, maxCol: number = this.width): number {
    if (row < 0 || row >= this.height) return col
    // The bottom-right cell is never content: a terminal with autowrap scrolls
    // the whole screen when it is written.
    const limit = Math.min(maxCol, row === this.height - 1 ? this.width - 1 : this.width)
    let x = col
    for (const piece of line) {
      for (const g of graphemes(cleanText(piece.text))) {
        const w = graphemeWidth(g)
        if (w === 0) continue // a combining mark with no base after cleaning: nothing to draw
        if (x >= limit) return x
        if (x + w > limit) {
          this.place(row, x, { ch: ' ', width: 1, ...(piece.style === undefined ? {} : { style: piece.style }) })
          return x + 1
        }
        this.place(row, x, { ch: g, width: w as 1 | 2, ...(piece.style === undefined ? {} : { style: piece.style }) })
        if (w === 2) this.place(row, x + 1, { ch: '', width: 0, ...(piece.style === undefined ? {} : { style: piece.style }) })
        x += w
      }
    }
    return x
  }

  /** Places one cell, repairing any wide grapheme it cuts in half. */
  private place(row: number, col: number, cell: Cell): void {
    if (col < 0 || col >= this.width) return
    const old = this.cell(row, col)
    if (old.width === 0 && col > 0) this.set(row, col - 1, BLANK)
    if (old.width === 2 && cell.width !== 0 && col + 1 < this.width) this.set(row, col + 1, BLANK)
    this.set(row, col, cell)
  }

  /** Blanks a rectangle (default: one row from `col`). */
  clear(row: number, col = 0, count = this.width - col): void {
    for (let x = col; x < Math.min(this.width, col + count); x++) this.place(row, x, BLANK)
  }

  /** A row's plain text, trailing blanks trimmed (tests and goldens). */
  rowText(row: number): string {
    let out = ''
    for (let x = 0; x < this.width; x++) out += this.cell(row, x).ch
    return out.replace(/ +$/, '')
  }

  text(): string {
    return Array.from({ length: this.height }, (_, row) => this.rowText(row)).join('\n')
  }
}

const SYNC_ON = '\x1b[?2026h'
const SYNC_OFF = '\x1b[?2026l'
const cup = (row: number, col: number): string => `\x1b[${row + 1};${col + 1}H`

function sgr(style: Style | undefined, depth: Depth): string {
  const params = sgrParams(style, depth)
  return params.length === 0 ? '\x1b[0m' : `\x1b[0;${params.join(';')}m`
}

function sameCell(a: Cell, b: Cell, depth: Depth): boolean {
  return a.ch === b.ch && a.width === b.width && sameStyle(a.style, b.style, depth)
}

/**
 * The bytes that turn the screen `prev` showed into `next`. With no `prev`,
 * or a different size, the screen is cleared and drawn whole. Empty when
 * nothing changed.
 */
export function renderFrame(prev: Frame | undefined, next: Frame, depth: Depth): string {
  const full = prev === undefined || prev.width !== next.width || prev.height !== next.height
  let out = ''
  let current: Style | undefined
  let styled = false
  const last = next.height - 1
  for (let row = 0; row < next.height; row++) {
    // The cells this row changes, as [start, end) runs; a gap of up to three
    // unchanged cells joins two runs (rewriting them is cheaper than a move).
    const runs: [number, number][] = []
    const end = row === last ? next.width - 1 : next.width
    let x = 0
    while (x < end) {
      if (!full && sameCell(prev!.cell(row, x), next.cell(row, x), depth)) {
        x++
        continue
      }
      let start = x
      // A change to either half of a wide grapheme redraws it from its first cell.
      if (next.cell(row, start).width === 0 && start > 0) start--
      let stop = x + 1
      let gap = 0
      while (stop < end && gap <= 3) {
        if (!full && sameCell(prev!.cell(row, stop), next.cell(row, stop), depth)) gap++
        else gap = 0
        stop++
      }
      stop -= gap
      if (next.cell(row, stop - 1).width === 2 && stop < end) stop++
      const previous = runs.at(-1)
      if (previous !== undefined && start <= previous[1]) previous[1] = Math.max(previous[1], stop)
      else runs.push([start, stop])
      x = stop
    }
    for (const [start, stop] of runs) {
      out += cup(row, start)
      for (let col = start; col < stop; col++) {
        const cell = next.cell(row, col)
        if (cell.width === 0) continue
        if (!styled || !sameStyle(current, cell.style, depth)) {
          out += sgr(cell.style, depth)
          current = cell.style
          styled = true
        }
        out += cell.ch
        // Re-anchor after any grapheme a terminal might measure differently.
        const after = col + cell.width
        if (after < stop && /[^\x20-\x7e]/.test(cell.ch)) out += cup(row, after)
      }
    }
  }
  const cursorChanged = full || prev!.cursor?.x !== next.cursor?.x || prev!.cursor?.y !== next.cursor?.y || (prev!.cursor === undefined) !== (next.cursor === undefined)
  if (out === '' && !cursorChanged) return ''
  let frame = SYNC_ON
  if (full) frame += '\x1b[0m\x1b[H\x1b[2J'
  frame += out
  if (styled) frame += '\x1b[0m'
  if (next.cursor !== undefined) frame += `${cup(next.cursor.y, next.cursor.x)}\x1b[?25h`
  else frame += '\x1b[?25l'
  return `${frame}${SYNC_OFF}`
}
