/**
 * One frame of the full-screen terminal, as a pure function of what the view
 * knows: no I/O, no clock, no session — so every screen a person can see can
 * be drawn in a test (`layout.test.ts`'s goldens) at any size.
 *
 * Bottom up: two footer rows that never move (Codewhale's posture and info
 * lines: authority and phase; route and context), the composer box — or, in
 * its place, the approval band, because a question the runtime is waiting on
 * is the one thing the person must do (the browser's card takes the composer's
 * place too) — then a notice row, a palette or list panel, and the transcript
 * in whatever is left, with a one-column scrollbar when it overflows.
 */
import { Frame } from './screen.ts'
import { lineWidth, span, wrapLine, type Line, type Span, type Style, type Theme } from './style.ts'
import { fitText, textWidth, truncateText } from './width.ts'

/** A footer segment: dropped lowest priority first when the row is too narrow. */
export interface Segment {
  readonly line: Line
  readonly priority: number
  readonly right?: true
}

export interface ComposerState {
  /** The draft's visual rows at the composer's inner width (`Editor.rows`). */
  readonly rows: readonly string[]
  readonly cursorRow: number
  readonly cursorCol: number
  readonly placeholder: string
  readonly empty: boolean
  /** Words on the box's bottom edge, right-aligned (what Enter does now). */
  readonly hint?: string
}

export interface BandState {
  readonly title: Line
  readonly body: readonly Line[]
  /** One row per answer, so none can be cut off at any width. */
  readonly keys: readonly Line[]
  readonly armed: boolean
  /** The draft kept underneath, one line. */
  readonly draft?: string
}

export interface PanelState {
  readonly title: Line
  readonly rows: readonly Line[]
  /** The highlighted row, if the panel is a picker. */
  readonly selected?: number
  readonly hint?: string
}

export interface ScreenState {
  readonly width: number
  readonly height: number
  readonly theme: Theme
  /** Every transcript row, top to bottom (the view caches per block). */
  readonly transcript: readonly Line[]
  /** The first visible row, or undefined to follow the bottom. */
  readonly top: number | undefined
  readonly composer: ComposerState
  readonly band?: BandState
  readonly panel?: PanelState
  readonly notice?: { readonly text: string; readonly style?: Style }
  readonly posture: readonly Segment[]
  readonly info: readonly Segment[]
}

export interface Drawn {
  readonly frame: Frame
  /** Rows the transcript had, and the top it showed (clamped), for the view's scroll anchor. */
  readonly transcriptRows: number
  readonly top: number
  readonly maxTop: number
}

/** The smallest screen worth drawing: Codewhale validates down to 40 x 12. */
export const MIN_WIDTH = 40
export const MIN_HEIGHT = 12

const FAINT: Style = { faint: true }

/** Fits segments into one row: the lowest priorities go first; right-aligned ones hug the edge. */
export function fitSegments(segments: readonly Segment[], width: number, gap = '   '): Line {
  let kept = [...segments]
  const total = (list: readonly Segment[]): number => list.reduce((sum, seg) => sum + lineWidth(seg.line), 0) + Math.max(0, list.length - 1) * gap.length
  while (kept.length > 1 && total(kept) > width) {
    const lowest = kept.reduce((low, seg) => (seg.priority < low.priority ? seg : low))
    kept = kept.filter((seg) => seg !== lowest)
  }
  const left = kept.filter((seg) => seg.right !== true)
  const right = kept.filter((seg) => seg.right === true)
  const out: Span[] = []
  left.forEach((seg, index) => {
    if (index > 0) out.push(span(gap))
    out.push(...seg.line)
  })
  const rightWidth = total(right)
  const pad = width - lineWidth(out) - rightWidth
  if (right.length > 0 && pad >= 1) {
    out.push(span(' '.repeat(pad)))
    right.forEach((seg, index) => {
      if (index > 0) out.push(span(gap))
      out.push(...seg.line)
    })
  }
  return out
}

export function drawScreen(state: ScreenState): Drawn {
  const { width, height, theme } = state
  const g = theme.glyphs
  const frame = new Frame(width, height)
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    const message = truncateText(`Enlarge the terminal to at least ${MIN_WIDTH}x${MIN_HEIGHT}`, width)
    frame.put(Math.floor(height / 2), Math.max(0, Math.floor((width - textWidth(message)) / 2)), [span(message, { bold: true })])
    return { frame, transcriptRows: 0, top: 0, maxTop: 0 }
  }
  const inner = width - 2
  let bottom = height

  // Footer: two rows, always.
  frame.put(height - 1, 1, fitSegments(state.info, inner), width - 1)
  frame.put(height - 2, 1, fitSegments(state.posture, inner), width - 1)
  bottom -= 2

  // The composer, or the band in its place.
  if (state.band !== undefined) {
    const band = state.band
    const maxBody = Math.max(1, Math.floor(height / 2) - 4)
    const body = band.body.slice(0, maxBody)
    const rows: Line[] = [[span(g.box.h.repeat(width), { ink: 'warn' })], band.title, ...body, ...band.keys]
    if (band.draft !== undefined && band.draft.length > 0) rows.push([span(`draft: ${truncateText(band.draft, inner - 8)}`, FAINT)])
    const start = bottom - rows.length
    rows.forEach((line, index) => frame.put(start + index, index === 0 ? 0 : 1, line, index === 0 ? width : width - 1))
    bottom = start
    frame.cursor = undefined
  } else {
    const composer = state.composer
    const maxRows = Math.max(1, Math.floor(height / 3) - 2)
    const scrollTop = Math.max(0, Math.min(composer.cursorRow - maxRows + 1, composer.rows.length - maxRows))
    const visible = composer.rows.slice(scrollTop, scrollTop + maxRows)
    const boxHeight = Math.max(1, visible.length) + 2
    const top = bottom - boxHeight
    const box: Style = FAINT
    frame.put(top, 0, [span(`${g.box.tl}${g.box.h.repeat(width - 2)}${g.box.tr}`, box)])
    const hint = composer.hint === undefined ? '' : ` ${composer.hint} `
    const bottomEdge = `${g.box.bl}${g.box.h.repeat(Math.max(0, width - 2 - textWidth(hint) - 1))}${hint}${g.box.h}${g.box.br}`
    frame.put(top + boxHeight - 1, 0, [span(fitText(bottomEdge, width).text, box)])
    const promptWidth = textWidth(g.prompt) + 1
    const rows = Math.max(1, visible.length)
    for (let row = 0; row < rows; row++) {
      const y = top + 1 + row
      frame.put(y, 0, [span(g.box.v, box)])
      frame.put(y, width - 1, [span(g.box.v, box)])
      const lead = row === 0 && scrollTop === 0 ? span(`${g.prompt} `, { ink: 'accent', bold: true }) : span(' '.repeat(promptWidth))
      const text = composer.empty ? span(composer.placeholder, FAINT) : span(visible[row] ?? '')
      frame.put(y, 2, [lead, text], width - 2)
    }
    if (!composer.empty || composer.cursorRow === 0) {
      const cursorY = top + 1 + (composer.cursorRow - scrollTop)
      frame.cursor = { x: Math.min(width - 3, 2 + promptWidth + composer.cursorCol), y: cursorY }
    }
    bottom = top
  }

  // A notice row above it.
  if (state.notice !== undefined) {
    bottom -= 1
    frame.put(bottom, 1, [span(truncateText(state.notice.text, inner), state.notice.style)], width - 1)
  }

  // A panel (palette, picker, help) above that.
  if (state.panel !== undefined) {
    const panel = state.panel
    const room = Math.max(3, Math.min(panel.rows.length + 2, Math.floor((bottom - 3) * 0.6)))
    const shown = room - 2
    const selected = panel.selected ?? 0
    const first = Math.max(0, Math.min(selected - Math.floor(shown / 2), panel.rows.length - shown))
    const top = bottom - room
    frame.put(top, 1, panel.title, width - 1)
    panel.rows.slice(first, first + shown).forEach((line, index) => {
      const at = first + index
      const chosen = panel.selected !== undefined && at === selected
      const lead = span(chosen ? `${g.folded} ` : '  ', chosen ? { ink: 'accent', bold: true } : undefined)
      frame.put(top + 1 + index, 1, [lead, ...(chosen ? line.map((piece) => span(piece.text, { ...piece.style, bold: true })) : line)], width - 1)
    })
    if (panel.hint !== undefined) frame.put(top + room - 1, 1, [span(truncateText(panel.hint, inner), FAINT)], width - 1)
    bottom = top
  }

  // The transcript in what is left.
  const rows = Math.max(0, bottom)
  const total = state.transcript.length
  const maxTop = Math.max(0, total - rows)
  const top = state.top === undefined ? maxTop : Math.max(0, Math.min(state.top, maxTop))
  for (let row = 0; row < rows; row++) {
    const line = state.transcript[top + row]
    if (line !== undefined) frame.put(row, 1, line, width - 2)
  }
  if (total > rows && rows > 0) {
    // A one-column track: where the window sits in the whole conversation.
    const thumb = Math.max(1, Math.round((rows * rows) / total))
    const at = maxTop === 0 ? 0 : Math.round(((rows - thumb) * top) / maxTop)
    for (let row = 0; row < rows; row++) frame.put(row, width - 1, [span(row >= at && row < at + thumb ? g.box.v : ' ', row >= at && row < at + thumb ? { ink: 'accent' } : FAINT)])
    if (top < maxTop) {
      const below = maxTop - top
      const marker = ` ${g.down} ${below} more below ${g.dot} ctrl+end `
      const x = Math.max(1, width - 2 - textWidth(marker))
      frame.put(rows - 1, x, [span(marker, { ink: 'accent', bold: true })], width - 1)
    }
  }
  return { frame, transcriptRows: rows, top, maxTop }
}

/** Plain lines wrapped for a panel (help, lists) at the panel's width. */
export function panelLines(lines: readonly Line[], width: number): Line[] {
  return lines.flatMap((line) => wrapLine(line, Math.max(10, width - 4), { rest: [span('    ')] }))
}
