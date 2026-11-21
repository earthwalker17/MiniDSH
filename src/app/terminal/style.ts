/**
 * The full-screen terminal's visual vocabulary: styled spans, the theme that
 * turns a style into SGR at the colour depth this terminal has, the glyphs
 * (with an ASCII table), and wrapping spans to a width.
 *
 * **Inks are roles, not colours** (Codewhale's status-bar grammar, cut to
 * ours): `accent` is MiniDSH's sea teal (the S22 web accent), the voice of the
 * product — the user's bar, headings, links, code spans; `ok`, `warn` and
 * `error` are outcomes and attention; `add`/`del` a diff. Body text is the
 * terminal's OWN foreground, muted text is SGR faint, and no background is
 * ever painted: the person's terminal theme, light or dark, stays theirs
 * (the S22.1 user decision). So each ink is a mid-tone chosen to read on both,
 * and meaning never rides on colour alone — every state has its glyph or word,
 * which is what `NO_COLOR` and a 16-colour terminal still show.
 *
 * Depth (`getColorDepth()`, which already honours `NO_COLOR`, `FORCE_COLOR`,
 * `COLORTERM` and `TERM`): 24-bit truecolor, 8-bit the nearest of the 256
 * cube, 4-bit a fixed role table, 1-bit no colour at all.
 */
import { graphemes, graphemeWidth, textWidth } from './width.ts'

export type Ink = 'accent' | 'ok' | 'warn' | 'error' | 'add' | 'del'

export interface Style {
  readonly ink?: Ink
  readonly bold?: boolean
  readonly faint?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly inverse?: boolean
}

export interface Span {
  readonly text: string
  readonly style?: Style
}

export type Line = readonly Span[]

export const span = (text: string, style?: Style): Span => (style === undefined ? { text } : { text, style })

/** Truecolor values: mid-tones legible on a light and a dark background alike. */
const RGB: Readonly<Record<Ink, readonly [number, number, number]>> = {
  accent: [0x1f, 0x9e, 0x8f],
  ok: [0x2e, 0xa0, 0x43],
  warn: [0xd2, 0x99, 0x22],
  error: [0xe5, 0x53, 0x4b],
  add: [0x2e, 0xa0, 0x43],
  del: [0xe5, 0x53, 0x4b],
}

/** The 16-colour role table: SGR foreground codes. */
const BASIC: Readonly<Record<Ink, number>> = { accent: 36, ok: 32, warn: 33, error: 31, add: 32, del: 31 }

export type Depth = 1 | 4 | 8 | 24

function nearest256([r, g, b]: readonly [number, number, number]): number {
  const level = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  return 16 + 36 * level(r) + 6 * level(g) + level(b)
}

/** SGR parameters for a style at a depth (no leading reset). */
export function sgrParams(style: Style | undefined, depth: Depth): string[] {
  const out: string[] = []
  if (style === undefined) return out
  if (style.bold) out.push('1')
  if (style.faint) out.push('2')
  if (style.italic) out.push('3')
  if (style.underline) out.push('4')
  if (style.inverse) out.push('7')
  if (style.ink !== undefined && depth > 1) {
    if (depth === 24) out.push(`38;2;${RGB[style.ink].join(';')}`)
    else if (depth === 8) out.push(`38;5;${nearest256(RGB[style.ink])}`)
    else out.push(String(BASIC[style.ink]))
  }
  return out
}

/** Whether two styles render identically at a depth (so a writer can skip an SGR). */
export function sameStyle(a: Style | undefined, b: Style | undefined, depth: Depth): boolean {
  return sgrParams(a, depth).join(';') === sgrParams(b, depth).join(';')
}

export interface Glyphs {
  readonly userBar: string
  readonly rail: string
  readonly reply: string
  readonly ok: string
  readonly fail: string
  readonly denied: string
  readonly ask: string
  readonly attention: string
  readonly thought: string
  readonly thoughtRail: string
  readonly more: string
  readonly folded: string
  readonly child: string
  readonly childEnd: string
  readonly prompt: string
  readonly dot: string
  readonly ellipsis: string
  readonly down: string
  readonly arrow: string
  readonly box: { readonly tl: string; readonly tr: string; readonly bl: string; readonly br: string; readonly h: string; readonly v: string }
  readonly spinner: readonly string[]
}

export const UNICODE_GLYPHS: Glyphs = {
  userBar: '▎',
  rail: '▏',
  reply: '●',
  ok: '✓',
  fail: '✕',
  denied: '⊘',
  ask: '?',
  attention: '◆',
  thought: '…',
  thoughtRail: '╎',
  more: '›',
  folded: '▸',
  child: '◐',
  childEnd: '╰',
  prompt: '❯',
  dot: '·',
  ellipsis: '…',
  down: '↓',
  arrow: '→',
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
}

/** For `TERM=linux|dumb`, a non-UTF-8 locale, or a CJK font that draws ambiguous glyphs wide (`MINIDSH_ASCII=1`). */
export const ASCII_GLYPHS: Glyphs = {
  userBar: '>',
  rail: '|',
  reply: '*',
  ok: '+',
  fail: 'x',
  denied: '!',
  ask: '?',
  attention: '*',
  thought: '~',
  thoughtRail: ':',
  more: '>',
  folded: '>',
  child: '@',
  childEnd: '`',
  prompt: '>',
  dot: '-',
  ellipsis: '...',
  down: 'v',
  arrow: '->',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  spinner: ['-', '\\', '|', '/'],
}

/**
 * Which glyph table an environment gets. POSIX is read from its locale; on
 * Windows the Unicode table is unconditional, because no variable there says
 * what the terminal draws. A console that draws East Asian Ambiguous glyphs
 * two cells wide (a legacy console host under a CJK code page and font;
 * `width.ts` counts them as one) is answered only by the person:
 * `MINIDSH_ASCII=1`, or the line view (`--plain`).
 */
export function glyphsFor(env: Readonly<Record<string, string | undefined>>, platform: string = process.platform): Glyphs {
  if (env.MINIDSH_ASCII === '1') return ASCII_GLYPHS
  const term = env.TERM ?? ''
  if (term === 'linux' || term === 'dumb') return ASCII_GLYPHS
  if (platform !== 'win32') {
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
    if (locale !== '' && !/utf-?8/i.test(locale)) return ASCII_GLYPHS
  }
  return UNICODE_GLYPHS
}

/** The theme a renderer is handed: a depth and a glyph table. Nothing else is configurable. */
export interface Theme {
  readonly depth: Depth
  readonly glyphs: Glyphs
}

/** The display width of a line in cells. */
export function lineWidth(line: Line): number {
  let width = 0
  for (const piece of line) width += textWidth(piece.text)
  return width
}

/** Plain text of a line (tests, goldens). */
export const lineText = (line: Line): string => line.map((piece) => piece.text).join('')

interface Cluster {
  readonly text: string
  readonly width: number
  readonly style: Style | undefined
  readonly space: boolean
}

function clustersOf(line: Line): Cluster[] {
  const out: Cluster[] = []
  for (const piece of line) {
    for (const g of graphemes(piece.text)) out.push({ text: g, width: graphemeWidth(g), style: piece.style, space: g === ' ' })
  }
  return out
}

function toLine(clusters: readonly Cluster[]): Span[] {
  const out: Span[] = []
  for (const cluster of clusters) {
    const last = out.at(-1)
    if (last !== undefined && last.style === cluster.style) out[out.length - 1] = span(last.text + cluster.text, cluster.style)
    else out.push(span(cluster.text, cluster.style))
  }
  return out
}

export interface WrapOptions {
  /** Spans put before the first row (a glyph and its gap). */
  readonly first?: Line
  /** Spans put before every later row; defaults to blanks as wide as `first`. */
  readonly rest?: Line
}

/**
 * Word-wraps a styled line to `width` cells, prefixes included. Breaks at
 * spaces; a word wider than the room is cut by grapheme; the spaces a break
 * consumes are dropped from both rows. Always returns at least one row.
 */
export function wrapLine(line: Line, width: number, options: WrapOptions = {}): Line[] {
  const first = options.first ?? []
  const rest = options.rest ?? (first.length === 0 ? [] : [span(' '.repeat(lineWidth(first)))])
  const rows: Line[] = []
  const clusters = clustersOf(line)
  let index = 0
  let prefix = first
  for (;;) {
    const room = Math.max(1, width - lineWidth(prefix))
    // Skip the spaces a break left at the head of a continuation row.
    if (rows.length > 0) while (index < clusters.length && clusters[index]!.space) index++
    let used = 0
    let end = index
    let lastBreak = -1
    while (end < clusters.length && used + clusters[end]!.width <= room) {
      if (clusters[end]!.space) lastBreak = end
      used += clusters[end]!.width
      end++
    }
    // A word that ends exactly at the edge (a space comes next) stays whole on this row.
    if (end < clusters.length && !clusters[end]!.space && lastBreak > index) end = lastBreak
    if (end === index && index < clusters.length) end = index + 1 // a grapheme wider than the room still advances
    let take = clusters.slice(index, end)
    if (end < clusters.length) while (take.length > 0 && take.at(-1)!.space) take = take.slice(0, -1)
    rows.push([...prefix, ...toLine(take)])
    index = end
    prefix = rest
    if (index >= clusters.length) break
  }
  return rows
}
