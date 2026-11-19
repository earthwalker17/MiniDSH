/**
 * Whole screens of the full-screen terminal, drawn from a REAL session log
 * (the S22 fixture: a person, a model, approvals, a delegation, a job) at
 * three sizes, plus the screens a person meets only now and then: the
 * approval band, the ASCII and no-colour tables, a CJK conversation, a
 * terminal too small. Goldens keep both the text and a style channel, so
 * losing a colour or a bold is a diff, not a silent change. And the budget:
 * a 50,000-line conversation still draws within a frame.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../../core/session/index.ts'
import type { CardContext } from '../web/cards.js'
import { fold } from '../web/conversation.js'
import { gapBetween, renderBlock, renderLive, settledProcesses, type BlockContext } from './blocks.ts'
import { drawScreen, type ScreenState, type Segment } from './layout.ts'
import { Frame, renderFrame } from './screen.ts'
import { ASCII_GLYPHS, span, UNICODE_GLYPHS, type Line, type Style, type Theme } from './style.ts'

const FIXTURE = fileURLToPath(new URL('../../test-support/fixtures/sessions/minidsh-s22-web.jsonl', import.meta.url))
const events = (): EventEnvelope[] =>
  readFileSync(FIXTURE, 'utf8')
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
    .filter((event) => event.type !== 'assistant/chunk')

const NOW = 1_763_500_000_000

function context(theme: Theme, width: number, model: ReturnType<typeof fold>, details = false): BlockContext {
  const cards: CardContext = { cwd: 'C:\\fx-s22', running: false, pendingCallIds: new Set(), asked: model.asked, decided: model.decided }
  return { theme, width, cwd: 'C:\\fx-s22', details, cards, display: () => undefined, now: NOW, spinner: theme.glyphs.spinner[0]! }
}

/** The transcript the view composes: blocks in order, a blank row between unlike ones. */
function transcript(source: readonly EventEnvelope[], theme: Theme, width: number, details = false): Line[] {
  const model = fold(source)
  const ctx = context(theme, width, model, details)
  const settled = settledProcesses(model.blocks)
  const lines: Line[] = []
  let previous: string | undefined
  for (const block of model.blocks) {
    const rows = renderBlock(block, settled.has(block.key), model, ctx)
    if (rows.length === 0) continue
    if (gapBetween(previous, block.kind)) lines.push([])
    lines.push(...rows)
    previous = block.kind
  }
  if (model.live) lines.push([], ...renderLive(model.live, ctx))
  return lines
}

const footer = (theme: Theme = { depth: 24, glyphs: UNICODE_GLYPHS }): { posture: Segment[]; info: Segment[] } => ({
  posture: [
    { line: [span(`${theme.glyphs.reply} `, { ink: 'ok' }), span('Workspace write', { bold: true }), span(` ${theme.glyphs.dot} ask`)], priority: 100 },
    { line: [span('ready', { faint: true })], priority: 30 },
    { line: [span('/ for commands', { faint: true })], priority: 20, right: true },
  ],
  info: [
    { line: [span('deepseek/', { faint: true }), span('deepseek-flash')], priority: 100 },
    { line: [span('ctx ', { faint: true }), span('12%'), span(' 120k/1049k', { faint: true })], priority: 80 },
    { line: [span('/help', { faint: true })], priority: 15, right: true },
  ],
})

function screen(theme: Theme, width: number, height: number, extra: Partial<ScreenState> = {}): Frame {
  return drawScreen({
    width,
    height,
    theme,
    transcript: transcript(events(), theme, width - 3),
    top: undefined,
    composer: { rows: [''], cursorRow: 0, cursorCol: 0, placeholder: 'Reply, or / for commands', empty: true },
    ...footer(theme),
    ...extra,
  }).frame
}

/** One letter per cell for its style: the ink first, then bold, faint, italic. */
function styleLetter(style: Style | undefined): string {
  if (style === undefined) return ' '
  const ink: Record<string, string> = { accent: 'a', ok: 'o', warn: 'w', error: 'e', add: '+', del: '-' }
  if (style.ink !== undefined) return ink[style.ink] ?? '?'
  if (style.bold) return 'B'
  if (style.faint) return 'f'
  if (style.italic) return 'i'
  return ' '
}

function golden(frame: Frame, styles = true): string {
  const text = frame.text()
  if (!styles) return `${text}\n`
  const channel = Array.from({ length: frame.height }, (_row, row) => Array.from({ length: frame.width }, (_cell, col) => styleLetter(frame.cell(row, col).style)).join('').replace(/ +$/, '')).join('\n')
  return `${text}\n\n--- styles (a accent, o ok, w warn, e error, +/- diff, B bold, f faint, i italic) ---\n${channel}\n`
}

const DARK: Theme = { depth: 24, glyphs: UNICODE_GLYPHS }

describe('whole screens', () => {
  it('draws the real S22 session at 80x24, text and styles', async () => {
    await expect(golden(screen(DARK, 80, 24))).toMatchFileSnapshot('goldens/s22-session-80x24.txt')
  })

  it('draws the real S22 session at 120x36 and at the 40x12 minimum', async () => {
    await expect(golden(screen(DARK, 120, 36), false)).toMatchFileSnapshot('goldens/s22-session-120x36.txt')
    await expect(golden(screen(DARK, 40, 12), false)).toMatchFileSnapshot('goldens/s22-session-40x12.txt')
  })

  it('opens every fold and full output with Ctrl+O', async () => {
    const theme = DARK
    const lines = transcript(events(), theme, 117, true)
    const frame = drawScreen({ width: 120, height: 36, theme, transcript: lines, top: 0, composer: { rows: [''], cursorRow: 0, cursorCol: 0, placeholder: '', empty: true }, ...footer() }).frame
    await expect(golden(frame, false)).toMatchFileSnapshot('goldens/s22-session-details-120x36.txt')
  })

  it('draws the approval band in the composer’s place', async () => {
    const frame = screen(DARK, 80, 24, {
      band: {
        title: [span('◆ ', { ink: 'warn', bold: true }), span('Approval needed', { bold: true }), span(' · pwsh')],
        body: [[span('  Run '), span('pnpm test', { ink: 'accent' }), span(' under danger-full-access/none')], [span('  model says: the suite needs the network', { faint: true, italic: true })]],
        keys: [
          [span('  '), span('y', { ink: 'accent', bold: true }), span('  allow once')],
          [span('  '), span('a', { ink: 'accent', bold: true }), span('  allow this exact action again until the session ends or its authority changes')],
          [span('  '), span('n', { ink: 'accent', bold: true }), span('  deny')],
        ],
        armed: true,
        draft: 'and then the docs',
      },
    })
    await expect(golden(frame)).toMatchFileSnapshot('goldens/approval-band-80x24.txt')
    expect(frame.cursor).toBeUndefined()
  })

  it('reads the same with no colour and with the ASCII glyphs', async () => {
    const frame = screen({ depth: 1, glyphs: ASCII_GLYPHS }, 80, 24)
    await expect(golden(frame, false)).toMatchFileSnapshot('goldens/s22-session-ascii-80x24.txt')
    // With no colour, every state is still a glyph or a word, and no structural glyph
    // is outside 7-bit ASCII (what the model wrote, an em dash, is its own text).
    const structural = [...new Set(Object.values(UNICODE_GLYPHS).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value : Object.values(value))))].filter((glyph) => /[^\x20-\x7e]/.test(glyph) && glyph !== '…')
    expect(structural.filter((glyph) => frame.text().includes(glyph))).toEqual([])
  })

  it('aligns a CJK conversation and says when the terminal is too small', async () => {
    const cjk: EventEnvelope[] = [
      { type: 'turn/start', seq: 0, time: NOW, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: NOW, data: { turn: 1, step: 1, message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '请修复解析器里的尾随逗号问题，并运行测试。' }], source: { kind: 'user' } } }, surfaceOp: { op: 'append' } },
      { type: 'assistant/message', seq: 2, time: NOW, data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '已修复：`parseLine` 现在只去掉**一个**尾随空字段。\n\n| 用例 | 结果 |\n|---|---|\n| `a,b,` | 两个字段 |\n| `a,,b` | 三个字段 |' }], source: { kind: 'assistant', provider: 'deepseek', model: 'deepseek-flash' } } }, surfaceOp: { op: 'append' } },
      { type: 'turn/end', seq: 3, time: NOW, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as EventEnvelope[]
    const frame = drawScreen({ width: 60, height: 16, theme: DARK, transcript: transcript(cjk, DARK, 57), top: undefined, composer: { rows: ['写一点中文'], cursorRow: 0, cursorCol: 10, placeholder: '', empty: false }, ...footer() }).frame
    await expect(golden(frame, false)).toMatchFileSnapshot('goldens/cjk-60x16.txt')
    // The cursor sits after the CJK draft, counted in cells: ❯, a space, then 10 cells of text.
    expect(frame.cursor).toEqual({ x: 14, y: 12 })
    const tooSmall = drawScreen({ width: 30, height: 10, theme: DARK, transcript: [], top: undefined, composer: { rows: [''], cursorRow: 0, cursorCol: 0, placeholder: '', empty: true }, ...footer() }).frame
    expect(tooSmall.text()).toContain('Enlarge the terminal')
  })
})

describe('the frame budget', () => {
  it('draws a frame of a 50,000-line conversation, and redraws a changed one, within a frame', () => {
    const lines: Line[] = Array.from({ length: 50_000 }, (_, index) => [span(`line ${index} of a long conversation, with a `), span('styled', { ink: 'accent' }), span(' word')])
    const state = (top: number | undefined): ScreenState => ({ width: 120, height: 40, theme: DARK, transcript: lines, top, composer: { rows: [''], cursorRow: 0, cursorCol: 0, placeholder: '', empty: true }, ...footer() })
    const start = performance.now()
    const first = drawScreen(state(undefined)).frame
    const bytes = renderFrame(undefined, first, 24)
    const next = drawScreen(state(25_000)).frame
    const delta = renderFrame(first, next, 24)
    const took = performance.now() - start
    expect(bytes.length).toBeGreaterThan(0)
    expect(delta.length).toBeGreaterThan(0)
    // Two frames well inside 16 ms on this laptop; the bound is for a loaded CI runner.
    expect(took, `${took.toFixed(1)} ms for two frames`).toBeLessThan(250)
  })

  it('streams a long reply at 200 chunks a second without re-parsing what has settled', () => {
    const theme = DARK
    const model = fold([])
    const ctx = context(theme, 100, model)
    const paragraph = 'A paragraph of streamed text that keeps going for a while so the reply grows long. '.repeat(4)
    let text = ''
    const start = performance.now()
    for (let chunk = 0; chunk < 200; chunk++) {
      text += chunk % 10 === 9 ? `${paragraph}\n\n` : paragraph.slice(0, 40)
      renderLive({ turn: 1, step: 1, attempt: 1, text, reasoning: '' }, ctx)
    }
    const took = performance.now() - start
    expect(took, `${took.toFixed(1)} ms for 200 frames of a ${text.length}-character reply`).toBeLessThan(2000)
  })
})
