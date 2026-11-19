/**
 * The composer's text model: one buffer, one cursor, the history a person
 * recalls with Up, and the soft-wrapped rows the screen draws. Pure — no
 * terminal, no keys; the surface maps keys to these calls.
 *
 * The cursor is a UTF-16 offset that only ever rests on a grapheme boundary,
 * so a CJK character, a combining sequence or a skin-toned emoji moves and
 * deletes as one. Line breaks are `\n` only: a paste's `\r\n` and `\r` are
 * normalized on the way in, so the text submitted is the text shown.
 *
 * Rows wrap by CELL width, character by character (a composer is not a
 * paragraph: word wrap would move the cursor's cell under a person typing).
 * Each grapheme is measured as the screen will DRAW it — after `cleanText`,
 * which turns a tab, a control or a joiner into a space — so the cursor's cell
 * and the drawn text cannot disagree. A wide grapheme never straddles a row
 * edge; one wider than the whole row still takes a row of its own, so any
 * width terminates. The cursor at the end of a row that is full goes to the
 * start of the next row, as a terminal's pending wrap would draw it; for the
 * last row of a line that means one more, empty row while the cursor is there.
 */
import { cleanText, graphemes, textWidth } from './width.ts'

export interface VisualRow {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** A row as laid out: `wrapped` when the next row continues the same line. */
interface Row {
  readonly start: number
  readonly end: number
  readonly width: number
  readonly wrapped: boolean
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const newlines = (text: string): string => text.replace(/\r\n?/g, '\n')

/** Cells one grapheme takes on screen, measured after the screen's cleaning. */
function cells(grapheme: string): number {
  const code = grapheme.charCodeAt(0)
  if (grapheme.length === 1 && code >= 0x20 && code < 0x7f) return 1
  return textWidth(cleanText(grapheme))
}

function widthOf(text: string): number {
  let width = 0
  for (const g of graphemes(text)) width += cells(g)
  return width
}

function lineStartOf(text: string, pos: number): number {
  return pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1
}

function lineEndOf(text: string, pos: number): number {
  const end = text.indexOf('\n', pos)
  return end < 0 ? text.length : end
}

/** The grapheme containing `pos` (within its line; a `\n` is always its own). */
function graphemeAt(text: string, pos: number): { readonly start: number; readonly end: number } {
  if (text[pos] === '\n') return { start: pos, end: pos + 1 }
  const lineStart = lineStartOf(text, pos)
  const line = text.slice(lineStart, lineEndOf(text, pos))
  const seg = SEGMENTER.segment(line).containing(pos - lineStart)
  if (seg === undefined) return { start: pos, end: pos }
  return { start: lineStart + seg.index, end: lineStart + seg.index + seg.segment.length }
}

function previousBoundary(text: string, pos: number): number {
  return pos <= 0 ? 0 : graphemeAt(text, pos - 1).start
}

function nextBoundary(text: string, pos: number): number {
  return pos >= text.length ? text.length : graphemeAt(text, pos).end
}

/** `pos` clamped into the text and moved forward to a grapheme boundary if it fell inside one. */
function snap(text: string, pos: number): number {
  const at = Math.max(0, Math.min(text.length, Number.isFinite(pos) ? Math.floor(pos) : text.length))
  if (at === 0 || at === text.length) return at
  const g = graphemeAt(text, at)
  return g.start === at ? at : g.end
}

const WORD = /^[\p{L}\p{N}_]/u
const SPACE = /^\s/u
type Kind = 'word' | 'space' | 'other'
const kindOf = (g: string): Kind => (WORD.test(g) ? 'word' : SPACE.test(g) ? 'space' : 'other')

/** Start of the word before `pos`: whitespace backwards, then one run of the same kind. */
function wordStartBefore(text: string, pos: number): number {
  const parts = graphemes(text.slice(0, pos))
  let i = parts.length - 1
  let at = pos
  while (i >= 0 && kindOf(parts[i]!) === 'space') at -= parts[i--]!.length
  if (i >= 0) {
    const kind = kindOf(parts[i]!)
    while (i >= 0 && kindOf(parts[i]!) === kind) at -= parts[i--]!.length
  }
  return at
}

/** End of the word after `pos`: whitespace forwards, then one run of the same kind. */
function wordEndAfter(text: string, pos: number): number {
  const parts = graphemes(text.slice(pos))
  let i = 0
  let at = pos
  while (i < parts.length && kindOf(parts[i]!) === 'space') at += parts[i++]!.length
  if (i < parts.length) {
    const kind = kindOf(parts[i]!)
    while (i < parts.length && kindOf(parts[i]!) === kind) at += parts[i++]!.length
  }
  return at
}

function layout(text: string, width: number): Row[] {
  const rows: Row[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    let start = lineStart
    let offset = lineStart
    let col = 0
    for (const g of graphemes(line)) {
      const w = cells(g)
      if (col > 0 && col + w > width) {
        rows.push({ start, end: offset, width: col, wrapped: true })
        start = offset
        col = 0
      }
      col += w
      offset += g.length
    }
    rows.push({ start, end: offset, width: col, wrapped: false })
    lineStart = offset + 1
  }
  return rows
}

export class Editor {
  private buffer = ''
  private at = 0
  private history: string[] = []
  /** The history entry shown while browsing; undefined when editing a draft. */
  private browsing: number | undefined
  private draft = ''
  private draftCursor = 0
  /** The sticky cell column of consecutive up/down moves, valid while text and cursor are as they left them. */
  private goal: { readonly col: number; readonly text: string; readonly cursor: number } | undefined

  get text(): string {
    return this.buffer
  }

  get cursor(): number {
    return this.at
  }

  get isEmpty(): boolean {
    return this.buffer === ''
  }

  get browsingHistory(): boolean {
    return this.browsing !== undefined
  }

  set(text: string, cursor?: number): void {
    this.edit(newlines(text), cursor)
  }

  insert(text: string): void {
    const add = newlines(text)
    if (add === '') return
    this.edit(this.buffer.slice(0, this.at) + add + this.buffer.slice(this.at), this.at + add.length)
  }

  newline(): void {
    this.insert('\n')
  }

  backspace(): void {
    if (this.at === 0) return
    const from = previousBoundary(this.buffer, this.at)
    this.edit(this.buffer.slice(0, from) + this.buffer.slice(this.at), from)
  }

  deleteForward(): void {
    if (this.at >= this.buffer.length) return
    const to = nextBoundary(this.buffer, this.at)
    this.edit(this.buffer.slice(0, this.at) + this.buffer.slice(to), this.at)
  }

  left(): void {
    this.at = previousBoundary(this.buffer, this.at)
  }

  right(): void {
    this.at = nextBoundary(this.buffer, this.at)
  }

  wordLeft(): void {
    this.at = wordStartBefore(this.buffer, this.at)
  }

  wordRight(): void {
    this.at = wordEndAfter(this.buffer, this.at)
  }

  lineStart(): void {
    this.at = lineStartOf(this.buffer, this.at)
  }

  lineEnd(): void {
    this.at = lineEndOf(this.buffer, this.at)
  }

  bufferStart(): void {
    this.at = 0
  }

  bufferEnd(): void {
    this.at = this.buffer.length
  }

  deleteWordBack(): void {
    const from = wordStartBefore(this.buffer, this.at)
    if (from === this.at) return
    this.edit(this.buffer.slice(0, from) + this.buffer.slice(this.at), from)
  }

  /** To the end of the line; at the end of a line, the line break itself (joining the next line), as Emacs does. */
  killToLineEnd(): void {
    const end = lineEndOf(this.buffer, this.at)
    const to = end === this.at && end < this.buffer.length ? end + 1 : end
    if (to === this.at) return
    this.edit(this.buffer.slice(0, this.at) + this.buffer.slice(to), this.at)
  }

  clear(): string {
    const text = this.buffer
    this.edit('', 0)
    return text
  }

  rows(width: number): { rows: VisualRow[]; cursorRow: number; cursorCol: number } {
    const { rows, cursorRow, cursorCol } = this.place(width)
    return { rows: rows.map((r) => ({ text: this.buffer.slice(r.start, r.end), start: r.start, end: r.end })), cursorRow, cursorCol }
  }

  up(width: number): boolean {
    return this.vertical(width, -1)
  }

  down(width: number): boolean {
    return this.vertical(width, 1)
  }

  seedHistory(entries: readonly string[]): void {
    this.history = []
    for (const entry of entries) this.pushHistory(entry)
    this.browsing = undefined
  }

  /** Skips a blank entry and an exact repeat of the newest. */
  pushHistory(entry: string): void {
    const text = newlines(entry)
    if (text.trim() === '' || this.history.at(-1) === text) return
    this.history.push(text)
  }

  historyPrev(): boolean {
    if (this.browsing === undefined) {
      if (this.history.length === 0) return false
      this.draft = this.buffer
      this.draftCursor = this.at
      this.show(this.history.length - 1)
      return true
    }
    if (this.browsing === 0) return false
    this.show(this.browsing - 1)
    return true
  }

  historyNext(): boolean {
    if (this.browsing === undefined) return false
    if (this.browsing < this.history.length - 1) {
      this.show(this.browsing + 1)
      return true
    }
    this.browsing = undefined
    this.buffer = this.draft
    this.at = this.draftCursor
    return true
  }

  submit(): string {
    const text = this.buffer
    this.pushHistory(text)
    this.edit('', 0)
    return text
  }

  /** Every change to the text: snaps the cursor and ends history browsing (the edited text is kept). */
  private edit(text: string, cursor: number | undefined): void {
    this.buffer = text
    this.at = snap(text, cursor ?? text.length)
    this.browsing = undefined
  }

  private show(index: number): void {
    this.browsing = index
    this.buffer = this.history[index] ?? ''
    this.at = this.buffer.length
  }

  private place(width: number): { rows: Row[]; cursorRow: number; cursorCol: number } {
    const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
    const rows = layout(this.buffer, w)
    let cursorRow = rows.length - 1
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!
      if (this.at >= row.start && (this.at < row.end || (this.at === row.end && !row.wrapped))) {
        cursorRow = r
        break
      }
    }
    const row = rows[cursorRow]!
    if (this.at === row.end && row.width >= w) {
      rows.splice(cursorRow + 1, 0, { start: row.end, end: row.end, width: 0, wrapped: false })
      return { rows, cursorRow: cursorRow + 1, cursorCol: 0 }
    }
    return { rows, cursorRow, cursorCol: widthOf(this.buffer.slice(row.start, this.at)) }
  }

  private vertical(width: number, direction: -1 | 1): boolean {
    const { rows, cursorRow, cursorCol } = this.place(width)
    const target = rows[cursorRow + direction]
    if (target === undefined) return false
    const goal = this.goal !== undefined && this.goal.text === this.buffer && this.goal.cursor === this.at ? this.goal.col : cursorCol
    const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
    // The last grapheme start at or before the goal column; the row's end only where the cursor would still draw on it.
    let best = target.start
    let offset = target.start
    let col = 0
    for (const g of graphemes(this.buffer.slice(target.start, target.end))) {
      if (col > goal) break
      best = offset
      col += cells(g)
      offset += g.length
    }
    if (!target.wrapped && target.width < w && target.width <= goal) best = target.end
    this.at = best
    this.goal = { col: goal, text: this.buffer, cursor: best }
    return true
  }
}
