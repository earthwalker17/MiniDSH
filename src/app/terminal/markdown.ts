/**
 * Model-written markdown as styled terminal rows. The browser's parser
 * (`web/markdown.js`) and highlighter (`web/highlight.js`) are shared; this
 * module only lays their tree out in cells, so the two surfaces never disagree
 * about what a reply's structure IS.
 *
 * The look is a calm transcript, not a document viewer: no background, body
 * text in the terminal's own colour, the accent for structure (headings,
 * bullets, quote bars, code spans), faint for what is secondary (a link's
 * target, a rule, quoted text). A code block is indented and nothing else —
 * no rail, no box, no fence — so a person who selects it off the screen copies
 * clean code; and it HARD-wraps, because a word-wrapped code line would read
 * as different code.
 *
 * Two guarantees the caller builds on: every span is one clean line (model
 * text reaches a span only through `cleanText` or `displayLines`), and no row
 * is wider than `width` — a last pass clips the rows a pathological nesting
 * depth pushed past it, so the guarantee does not depend on every layout rule
 * getting the arithmetic right.
 */
import { highlight, type Kind } from '../web/highlight.js'
import {
  parseMarkdown,
  type Block,
  type BlockquoteNode,
  type CodeNode,
  type HeadingNode,
  type Inline,
  type ListNode,
  type TableNode,
} from '../web/markdown.js'
import { lineText, lineWidth, span, wrapLine, type Line, type Span, type Style, type Theme } from './style.ts'
import { cleanText, displayLines, fitText, graphemes, graphemeWidth, textWidth, truncateText } from './width.ts'

export interface MarkdownOptions {
  /** The text is a reply still arriving: a fence open at its end is the code so far. */
  readonly streaming?: boolean
}

/** Narrower than this, a reply is laid out as if this wide and the caller clips. */
const MIN_WIDTH = 10
/** A width no terminal has: keeps `Infinity` away from `repeat`. */
const MAX_WIDTH = 10_000
const RULE_MAX = 60
const H1_RULE_MAX = 40
const CODE_INDENT = '  '
const CODE_CONTINUATION = '    '
const TAB_SIZE = 4
/** Quote bars stop stacking here; a deeper quote is still faint, just not narrower. */
const MAX_BARS = 4
const COLUMN_GAP = '  '

const BOLD: Style = { bold: true }
const ITALIC: Style = { italic: true }
const FAINT: Style = { faint: true }
const UNDERLINE: Style = { underline: true }
const ACCENT: Style = { ink: 'accent' }
const OK: Style = { ink: 'ok' }
const HEADING: Style = { bold: true, ink: 'accent' }

/** Highlighter kinds to styles; a kind not listed is body text. */
const TOKEN: Partial<Record<Kind, Style>> = {
  comment: { faint: true, italic: true },
  string: OK,
  number: { ink: 'warn' },
  constant: { ink: 'warn' },
  keyword: ACCENT,
  type: ACCENT,
  function: BOLD,
  inserted: { ink: 'add' },
  deleted: { ink: 'del' },
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

interface Ctx {
  readonly theme: Theme
  /** What every span inherits: faint inside a quote. */
  readonly base: Style | undefined
  /** Quote bars already drawn to the left. */
  readonly bars: number
}

const merge = (base: Style | undefined, extra: Style): Style => (base === undefined ? extra : { ...base, ...extra })

/** Pushes without spreading: a long reply's rows would overflow an argument list. */
function append(out: Line[], rows: readonly Line[]): void {
  for (const row of rows) out.push(row)
}

const ruleText = (glyph: string, cells: number): string => glyph.repeat(Math.max(0, Math.floor(cells / Math.max(1, textWidth(glyph)))))

/**
 * Whether a line fits `width` cells, measured exactly only when a cheap bound
 * cannot tell: no grapheme is wider than 2 cells, every wide one starts at or
 * above U+1100 (a surrogate included), and each has at least one code unit —
 * so counting a unit from U+1100 as 2 and any other as 1 never undercounts.
 * Segmenting graphemes is the costly part of measuring; most rows skip it.
 */
function fits(line: Line, width: number): boolean {
  let bound = 0
  for (const piece of line) {
    const text = piece.text
    for (let i = 0; i < text.length; i++) bound += text.charCodeAt(i) >= 0x1100 ? 2 : 1
    if (bound > width) return lineWidth(line) <= width
  }
  return true
}

/** Model-written markdown → styled terminal lines no wider than `width` cells (no prefix: the caller adds rails). */
export function renderMarkdown(text: string, width: number, theme: Theme, options: MarkdownOptions = {}): Line[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  const room = width >= MIN_WIDTH ? Math.min(Math.floor(width), MAX_WIDTH) : MIN_WIDTH
  const root = parseMarkdown(text, { streaming: options.streaming === true })
  const rows = blockRows(root.children, room, { theme, base: undefined, bars: 0 }, false)
  return rows.map((row) => (fits(row, room) ? row : clip(row, room)))
}

/** A row cut to `width` cells: the backstop for nesting deeper than the width can indent. */
function clip(row: Line, width: number): Line {
  const out: Span[] = []
  let used = 0
  for (const piece of row) {
    const w = textWidth(piece.text)
    if (used + w <= width) {
      out.push(piece)
      used += w
      continue
    }
    const fit = fitText(piece.text, width - used)
    if (fit.text !== '') out.push(span(fit.text, piece.style))
    break
  }
  return out
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * Blocks one blank row apart. Inside a list item a nested list hangs straight
 * under the item's text, the way a tight list reads.
 */
function blockRows(blocks: readonly Block[], width: number, ctx: Ctx, inItem: boolean): Line[] {
  const out: Line[] = []
  for (const block of blocks) {
    const rows = oneBlock(block, width, ctx)
    if (rows.length === 0) continue
    if (out.length > 0 && !(inItem && block.type === 'list')) out.push([])
    append(out, rows)
  }
  return out
}

function oneBlock(block: Block, width: number, ctx: Ctx): Line[] {
  switch (block.type) {
    case 'paragraph':
      return textRows(block.children, width, ctx.base)
    case 'heading':
      return headingRows(block, width, ctx)
    case 'code':
      return codeRows(block, width, ctx)
    case 'list':
      return listRows(block, width, ctx)
    case 'blockquote':
      return quoteRows(block, width, ctx)
    case 'table':
      return tableRows(block, width, ctx)
    case 'rule':
      return [[span(ruleText(ctx.theme.glyphs.box.h, Math.min(width, RULE_MAX)), merge(ctx.base, FAINT))]]
    default:
      return []
  }
}

/** Inline content word-wrapped to `width`; nothing at all when it shows nothing. */
function textRows(nodes: readonly Inline[], width: number, style: Style | undefined): Line[] {
  const pieces = inlinePieces(nodes, style)
  if (pieces.every((piece) => piece.length === 0)) return []
  const out: Line[] = []
  for (const piece of pieces) {
    if (fits(piece, width)) out.push(piece)
    else append(out, wrapLine(piece, width))
  }
  return out
}

function headingRows(block: HeadingNode, width: number, ctx: Ctx): Line[] {
  const rows = textRows(block.children, width, merge(ctx.base, HEADING))
  if (block.depth !== 1 || rows.length === 0) return rows
  let widest = 0
  for (const row of rows) widest = Math.max(widest, lineWidth(row))
  const rule = ruleText(ctx.theme.glyphs.box.h, Math.min(widest, H1_RULE_MAX, width))
  if (rule !== '') rows.push([span(rule, merge(ctx.base, FAINT))])
  return rows
}

function listRows(node: ListNode, width: number, ctx: Ctx): Line[] {
  const start = node.start ?? 1
  const markers = node.items.map((_, i) => (node.ordered ? `${start + i}.` : '-'))
  // Numbers right-aligned to the widest, so every item's text starts in one column.
  let markerWidth = 0
  for (const marker of markers) markerWidth = Math.max(markerWidth, marker.length)
  // The parser does not record looseness; an item holding more than its text
  // (and a nested list) is what a loose list looks like, and earns the gaps.
  const loose = node.items.some((item) => item.children.some((child, i) => i > 0 && child.type !== 'list'))
  const bullet = merge(ctx.base, ACCENT)
  const out: Line[] = []
  node.items.forEach((item, i) => {
    const head: Span[] = [span((markers[i] ?? '-').padStart(markerWidth), bullet), span(' ')]
    if (item.checked === true) head.push(span('[', ctx.base), span('x', merge(ctx.base, OK)), span('] ', ctx.base))
    else if (item.checked === false) head.push(span('[ ] ', ctx.base))
    const indent = lineWidth(head)
    const body = blockRows(item.children, Math.max(1, width - indent), ctx, true)
    if (out.length > 0 && loose) out.push([])
    if (body.length === 0) {
      out.push(head)
      return
    }
    const hang = span(' '.repeat(indent))
    body.forEach((row, r) => out.push(r === 0 ? [...head, ...row] : row.length === 0 ? [] : [hang, ...row]))
  })
  return out
}

function quoteRows(node: BlockquoteNode, width: number, ctx: Ctx): Line[] {
  const inner: Ctx = { theme: ctx.theme, base: merge(ctx.base, FAINT), bars: ctx.bars + 1 }
  if (ctx.bars >= MAX_BARS) return blockRows(node.children, width, inner, false)
  const bar = span(ctx.theme.glyphs.box.v, ACCENT)
  const body = blockRows(node.children, Math.max(1, width - textWidth(bar.text) - 1), inner, false)
  return body.map((row) => (row.length === 0 ? [bar] : [bar, span(' '), ...row]))
}

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

/** Inline nodes as styled pieces, one per hard break; every text cleaned. */
function inlinePieces(nodes: readonly Inline[], base: Style | undefined): Span[][] {
  let current: Span[] = []
  const pieces: Span[][] = [current]
  const put = (text: string, style: Style | undefined): void => {
    const clean = cleanText(text)
    if (clean !== '') current.push(span(clean, style))
  }
  // Recursion is bounded: the parser flattens spans past 24 levels to text.
  const walk = (list: readonly Inline[], style: Style | undefined): void => {
    for (const node of list) {
      switch (node.type) {
        case 'text':
          put(node.text, style)
          break
        case 'code':
          put(node.text, merge(style, ACCENT))
          break
        case 'break':
          current = []
          pieces.push(current)
          break
        case 'strong':
          walk(node.children, merge(style, BOLD))
          break
        case 'emphasis':
          walk(node.children, merge(style, ITALIC))
          break
        case 'delete':
          // No strike in our Style: struck text is the faint, superseded kind.
          walk(node.children, merge(style, FAINT))
          break
        case 'link':
          walk(node.children, merge(style, UNDERLINE))
          // A terminal cannot hide a target behind its text, and must not
          // pretend to: where the text is not the target, the target follows.
          if (!sameTarget(node.href, plainOf(node.children))) put(` (${node.href})`, merge(style, FAINT))
          break
      }
    }
  }
  walk(nodes, base)
  return pieces
}

/** Whether a link's text already says where it goes (`www.` and e-mail autolinks gain a scheme in the parser). */
const sameTarget = (href: string, text: string): boolean => href === text || href === `http://${text}` || href === `mailto:${text}`

function plainOf(nodes: readonly Inline[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'code') out += node.text
    else if (node.type === 'break') out += ' '
    else out += plainOf(node.children)
  }
  return out
}

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

function codeRows(block: CodeNode, width: number, ctx: Ctx): Line[] {
  const out: Line[] = []
  const lang = block.lang === undefined ? '' : cleanText(block.lang).trim()
  if (lang !== '') {
    const label = truncateText(lang, Math.max(1, width - CODE_INDENT.length), ctx.theme.glyphs.ellipsis)
    out.push([span(CODE_INDENT), span(label, merge(ctx.base, FAINT))])
  }
  if (block.text === '') return out
  const first = Math.max(1, width - CODE_INDENT.length)
  const rest = Math.max(1, width - CODE_CONTINUATION.length)
  for (const line of codeLines(block.text, block.lang, ctx.base)) {
    if (line.length === 0) out.push([])
    else if (fits(line, first)) out.push([span(CODE_INDENT), ...line])
    else hardWrap(line, first, rest).forEach((row, i) => out.push([span(i === 0 ? CODE_INDENT : CODE_CONTINUATION), ...row]))
  }
  return out.every((row) => row.length === 0) ? [] : out
}

/**
 * The display lines of a code block, styled by the highlighter. The text of
 * each line is `displayLines`'s — tabs at stops of 4, every control blanked —
 * and the highlighter's tokens are laid over it by walking the raw code the
 * same way. (No `\r` reaches here: the parser ends a line at one, as
 * CommonMark does.) A line whose walk does not reproduce `displayLines`' text
 * exactly is shown plain: the colours are a nicety, the characters are not.
 */
function codeLines(code: string, lang: string | undefined, base: Style | undefined): Line[] {
  const display = displayLines(code, { tabSize: TAB_SIZE, escapes: false })
  const plain = (text: string): Line => (text === '' ? [] : [span(text, base)])
  const ends: number[] = []
  const kinds: (Kind | undefined)[] = []
  let total = 0
  for (const token of highlight(code, lang)) {
    total += token.text.length
    ends.push(total)
    kinds.push(token.kind)
  }
  if (total !== code.length) return display.map(plain)

  const styles = new Map<Kind | undefined, Style | undefined>()
  const styleOf = (kind: Kind | undefined): Style | undefined => {
    if (!styles.has(kind)) {
      const own = kind === undefined ? undefined : TOKEN[kind]
      styles.set(kind, own === undefined ? base : merge(base, own))
    }
    return styles.get(kind)
  }
  // One forward pointer over the tokens: positions only ever increase.
  let token = 0
  const kindAt = (index: number): Kind | undefined => {
    while (token < ends.length && ends[token]! <= index) token++
    return kinds[token]
  }

  const out: Line[] = []
  let start = 0
  for (let n = 0; ; n++) {
    const newline = code.indexOf('\n', start)
    const end = newline < 0 ? code.length : newline
    const spans: Span[] = []
    const put = (text: string, kind: Kind | undefined): void => {
      const style = styleOf(kind)
      const last = spans.at(-1)
      if (last !== undefined && last.style === style) spans[spans.length - 1] = span(last.text + text, style)
      else spans.push(span(text, style))
    }
    const line = code.slice(start, end)
    if (PRINTABLE_ASCII.test(line)) {
      for (let pos = start; pos < end; ) {
        const kind = kindAt(pos)
        const stop = Math.min(ends[token] ?? end, end)
        put(code.slice(pos, stop), kind)
        pos = stop
      }
    } else {
      // Tab stops count cells of the RAW graphemes, as `expandTabs` does.
      const tabs = line.includes('\t')
      let pos = start
      let column = 0
      for (const g of graphemes(line)) {
        const kind = kindAt(pos)
        pos += g.length
        if (g === '\t') {
          const pad = TAB_SIZE - (column % TAB_SIZE)
          put(' '.repeat(pad), kind)
          column += pad
        } else {
          put(cleanText(g), kind)
          if (tabs) column += graphemeWidth(g)
        }
      }
    }
    const expected = display[n] ?? ''
    out.push(lineText(spans) === expected ? spans : plain(expected))
    if (newline < 0) break
    start = newline + 1
  }
  return out.length === display.length ? out : display.map(plain)
}

interface Cell {
  readonly text: string
  readonly width: number
  readonly style: Style | undefined
}

function cellsOf(line: Line): Cell[] {
  const out: Cell[] = []
  for (const piece of line) {
    if (PRINTABLE_ASCII.test(piece.text)) for (const ch of piece.text) out.push({ text: ch, width: 1, style: piece.style })
    else for (const g of graphemes(piece.text)) out.push({ text: g, width: graphemeWidth(g), style: piece.style })
  }
  return out
}

function joinCells(cells: readonly Cell[], from: number, to: number): Line {
  const out: Span[] = []
  let text = ''
  let style = cells[from]?.style
  for (let i = from; i < to; i++) {
    const cell = cells[i]!
    if (cell.style !== style) {
      if (text !== '') out.push(span(text, style))
      text = ''
      style = cell.style
    }
    text += cell.text
  }
  if (text !== '') out.push(span(text, style))
  return out
}

/** A code line cut by cells, never at words: `first` cells on the first row, `rest` on each after. */
function hardWrap(line: Line, first: number, rest: number): Line[] {
  const cells = cellsOf(line)
  const rows: Line[] = []
  let index = 0
  let room = first
  while (index < cells.length) {
    let used = 0
    let end = index
    while (end < cells.length && used + cells[end]!.width <= room) used += cells[end++]!.width
    if (end === index) end++ // a grapheme wider than the room still advances
    rows.push(joinCells(cells, index, end))
    index = end
    room = rest
  }
  return rows
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** A cell's inline content on one line (a cell has no hard break; one would be a space). */
function cellLine(nodes: readonly Inline[], style: Style | undefined): Line {
  const out: Span[] = []
  inlinePieces(nodes, style).forEach((piece, i) => {
    if (i > 0) out.push(span(' '))
    for (const part of piece) out.push(part)
  })
  return out
}

/**
 * Aligned columns when the natural widths fit; otherwise one record per row
 * (`header: value`), which reads at any width where a squeezed grid does not.
 */
function tableRows(node: TableNode, width: number, ctx: Ctx): Line[] {
  const headStyle = merge(ctx.base, BOLD)
  const head = node.head.map((cell) => cellLine(cell, headStyle))
  const body = node.rows.map((row) => row.map((cell) => cellLine(cell, ctx.base)))
  const widths = head.map(lineWidth)
  for (const row of body) {
    row.forEach((cell, j) => {
      widths[j] = Math.max(widths[j] ?? 0, lineWidth(cell))
    })
  }
  if (widths.every((w) => w === 0)) return []
  const total = widths.reduce((sum, w) => sum + w, 0) + COLUMN_GAP.length * (widths.length - 1)

  if (total <= width) {
    const aligned = (cells: readonly Line[]): Line => {
      const out: Span[] = []
      widths.forEach((w, j) => {
        const cell = cells[j] ?? []
        const pad = w - lineWidth(cell)
        const align = node.align[j] ?? null
        const left = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0
        if (j > 0) out.push(span(COLUMN_GAP))
        if (left > 0) out.push(span(' '.repeat(left)))
        for (const piece of cell) out.push(piece)
        if (j < widths.length - 1 && pad - left > 0) out.push(span(' '.repeat(pad - left)))
      })
      while (out.length > 0 && out.at(-1)!.style === undefined && out.at(-1)!.text.trim() === '') out.pop()
      return out
    }
    const rows: Line[] = [aligned(head), [span(ruleText(ctx.theme.glyphs.box.h, total), merge(ctx.base, FAINT))]]
    for (const row of body) rows.push(aligned(row))
    return rows
  }

  const out: Line[] = []
  const fill = (line: Line): void => append(out, fits(line, width) ? [line] : wrapLine(line, width, { rest: [span('  ')] }))
  if (body.length === 0) {
    const joined: Span[] = []
    head.forEach((label, j) => {
      if (j > 0) joined.push(span(COLUMN_GAP))
      for (const piece of label) joined.push(piece)
    })
    fill(joined)
    return out
  }
  body.forEach((row, r) => {
    if (r > 0) out.push([])
    head.forEach((label, j) => {
      const value = row[j] ?? []
      if (label.length === 0 && value.length === 0) return
      if (label.length === 0) fill(value)
      else fill(value.length === 0 ? [...label, span(':', headStyle)] : [...label, span(':', headStyle), span(' '), ...value])
    })
  })
  return out
}
