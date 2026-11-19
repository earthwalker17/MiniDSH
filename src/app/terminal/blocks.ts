/**
 * The conversation, drawn as terminal lines. The MODEL is the browser's
 * (`app/web/conversation.js`: the log folded into blocks joined by the ids it
 * records) and so is each call's card (`app/web/cards.js`: what the tool's own
 * `display` says, with its result side read from durable facts); this file
 * only decides how they look in cells. One presentation model, two renderers
 * (ARCHITECTURE §8): a visibility rule the parity gate holds for the browser
 * holds here by construction.
 *
 * The layout is Codewhale's calm transcript, cut to MiniDSH's facts:
 * - a person's message is a `▎` bar in the accent; a reply a `●` with its
 *   markdown hung under it, code blocks with no rail so a copy is clean;
 * - while a turn runs, every call is a card in sight: a status glyph (a
 *   spinner only where the live VIEW says running), the tool's title and
 *   summary, then a short excerpt under a dim rail — one head and two tail
 *   lines of a success, up to twenty ranked lines of a failure;
 * - once the turn ended, a group of two or more calls folds to one line
 *   naming the kinds of work (`processTitle`, as the browser and DSH do), with
 *   its step count, failures and duration; a single call keeps its title line;
 * - authority switches, decisions and a failed turn are blocks of their own,
 *   never inside a fold (the S22 rule);
 * - Ctrl+O opens everything: every fold, every full output.
 */
import { cardFor, processTitle, type Card, type CardContext } from '../web/cards.js'
import type { Block, Item, Live, Model, ProcessBlock, ToolItem } from '../web/conversation.js'
import { duration } from '../web/format.js'
import { subjectParts, tokens } from '../web/rows.js'
import type { ToolDisplay } from '../../core/tools/types.ts'
import { renderMarkdown } from './markdown.ts'
import { span, wrapLine, type Line, type Span, type Style, type Theme } from './style.ts'
import { cleanText, displayLines, textWidth, truncateText } from './width.ts'

export interface BlockContext {
  readonly theme: Theme
  /** The transcript's width in cells. */
  readonly width: number
  readonly cwd?: string
  /** Ctrl+O: every fold open, every output whole. */
  readonly details: boolean
  readonly cards: CardContext
  readonly display: (name: string) => ToolDisplay | undefined
  readonly now: number
  /** The spinner frame this paint shows. */
  readonly spinner: string
  /** A running child's own conversation, when this view attached it. */
  readonly child?: (childId: string) => Model | undefined
}

/** Result codes that are the authority plane's decision, not a tool failure (`app/present.ts` DENIALS). */
const DENIALS: ReadonlySet<string> = new Set(['DENIED', 'BLOCKED', 'ABORTED', 'ABORTED_BEFORE_DISPATCH', 'FS_SANDBOX_DENIED', 'SANDBOX_UNAVAILABLE', 'SANDBOX_ESCALATION_DENIED', 'SANDBOX_NOT_WIDER', 'SANDBOX_CEILING', 'NETWORK_DENIED'])

const FAINT: Style = { faint: true }
const indent = (n: number): Span => span(' '.repeat(n))

function railed(lines: readonly Line[], ctx: BlockContext, depth = 2): Line[] {
  const rail = [indent(depth), span(`${ctx.theme.glyphs.rail} `, FAINT)]
  return lines.map((line) => [...rail, ...line])
}

/** Plain text wrapped under a prefix, every row cleaned. */
function wrapped(text: string, width: number, style: Style | undefined, first: Line, rest?: Line): Line[] {
  const out: Line[] = []
  const lines = displayLines(text, { tabSize: 4 })
  lines.forEach((line, index) => {
    const head = index === 0 ? first : (rest ?? [indent(textWidth(first.map((piece) => piece.text).join('')))])
    out.push(...wrapLine([span(line, style)], width, { first: head, ...(rest === undefined ? {} : { rest }) }))
  })
  return out
}

// ---- top-level blocks ---------------------------------------------------------

/** The process groups a turn's end follows: those may fold (a running turn's never do). */
export function settledProcesses(blocks: readonly Block[]): Set<string> {
  const settled = new Set<string>()
  let seenTail = false
  for (let at = blocks.length - 1; at >= 0; at--) {
    const block = blocks[at]!
    if (block.kind === 'tail') seenTail = true
    else if (block.kind === 'process' && seenTail) settled.add(block.key)
  }
  return settled
}

/** Blocks that read as one quiet run of facts: no blank line between two of them. */
const QUIET = new Set(['system', 'note', 'opening', 'context', 'compaction'])

/** Whether a blank row separates a block from the one drawn before it. */
export const gapBetween = (previous: string | undefined, kind: string): boolean => previous !== undefined && !(QUIET.has(previous) && QUIET.has(kind))

/**
 * One block's lines. `settled` says the turn that holds a process group has
 * ended (a `tail` follows it), which is when it may fold.
 */
export function renderBlock(block: Block, settled: boolean, model: Model, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  switch (block.kind) {
    case 'bubble': {
      const text = block.text.trim().length === 0 && block.images.length > 0 ? '' : block.text
      const bar: Line = [span(`${g.userBar} `, { ink: 'accent', bold: true })]
      const rows = wrapped(text, ctx.width, undefined, bar, bar)
      for (const image of block.images) rows.push([...bar, span(image.type === 'image' ? (image.text ?? '[image]') : '[image]', FAINT)])
      return rows
    }
    case 'reply': {
      if (block.text.trim().length === 0) return []
      return replyLines(block.text, ctx, false, block.interrupted)
    }
    case 'process':
      return processLines(block, settled, ctx)
    case 'system':
      return systemLines(block.type, block.data, block.row.text, model, ctx)
    case 'tail':
      return tailLines(block.reason, ctx)
    case 'opening': {
      const what = block.rows.map((entry) => unbracket(entry.row.text)).join(` ${g.dot} `)
      return wrapped(`${block.resumed ? 'resumed' : 'opened'} ${g.dot} ${what}`, ctx.width, FAINT, [span(`${g.dot} `, FAINT)])
    }
    case 'context':
      return wrapped(contextLabel(block.plugin, block.form, block.replace), ctx.width, FAINT, [span(`${g.dot} `, FAINT)])
    case 'note':
      return wrapped(unbracket(block.row.text), ctx.width, FAINT, [span(`${g.dot} `, FAINT)])
    case 'compaction':
      return compactionLines(block, ctx)
    case 'fork': {
      const label = ' forked here '
      const side = Math.max(2, Math.floor((ctx.width - textWidth(label)) / 2))
      return [[span(`${g.box.h.repeat(side)}${label}${g.box.h.repeat(side)}`, FAINT)]]
    }
    default:
      return []
  }
}

/** A reply's markdown hung under its `●` (or the live preview's, still arriving). */
function replyLines(text: string, ctx: BlockContext, streaming: boolean, interrupted = false): Line[] {
  const g = ctx.theme.glyphs
  const body = renderMarkdown(text, Math.max(10, ctx.width - 2), ctx.theme, { streaming })
  if (body.length === 0) return []
  const out = body.map((line, index) => [index === 0 ? span(`${g.reply} `, { ink: 'accent', bold: true }) : indent(2), ...line])
  if (interrupted) out.push([indent(2), span('(interrupted)', FAINT)])
  return out
}

/** The streaming preview: reasoning as a dim tail, then the reply so far. */
export function renderLive(live: Live, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  const out: Line[] = []
  if (live.reasoning.trim().length > 0 && live.text.trim().length === 0) {
    out.push([span(`${g.thought} `, FAINT), span('Thinking', { faint: true, italic: true })])
    const tail = displayLines(live.reasoning.trim(), { tabSize: 4 }).filter((line) => line.trim().length > 0).slice(-2)
    for (const line of tail) out.push(...wrapLine([span(line, { faint: true, italic: true })], ctx.width, { first: [indent(2), span(`${g.thoughtRail} `, FAINT)] }))
  }
  if (live.text.trim().length > 0) out.push(...liveReply(live.text, ctx))
  return out
}

/** Below this a streaming reply is simply re-rendered whole each frame. */
const STABLE_FROM = 2000
let settledHead: { key: string; lines: Line[] } = { key: '', lines: [] }

/**
 * A long streaming reply re-parsed whole on every frame costs a parse of
 * everything already on screen per chunk. Markdown blocks end at a blank
 * line outside a fence, and nothing after such a line changes how the text
 * before it renders, so the head up to the last one is rendered once and
 * kept; only the tail still arriving is parsed per frame. The durable reply
 * that replaces the preview is rendered whole.
 */
function liveReply(text: string, ctx: BlockContext): Line[] {
  if (text.length < STABLE_FROM) return replyLines(text, ctx, true)
  const cut = stableCut(text)
  if (cut <= 0) return replyLines(text, ctx, true)
  const head = text.slice(0, cut)
  const key = `${ctx.width}|${ctx.theme.depth}|${ctx.theme.glyphs.reply}|${head}`
  if (settledHead.key !== key) settledHead = { key, lines: replyLines(head, ctx, false) }
  const tail = renderMarkdown(text.slice(cut), Math.max(10, ctx.width - 2), ctx.theme, { streaming: true }).map((line) => [indent(2), ...line])
  return tail.length === 0 ? settledHead.lines : [...settledHead.lines, [], ...tail]
}

/** The offset just past the last blank line that lies outside a fenced block, or 0. */
export function stableCut(text: string): number {
  let fence: string | undefined
  let offset = 0
  let cut = 0
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0]
      else if (marker[0] === fence) fence = undefined
    } else if (fence === undefined && line.trim() === '' && offset > 0) cut = offset + line.length + 1
    offset += line.length + 1
  }
  return Math.min(cut, text.length)
}

function unbracket(text: string): string {
  const trimmed = text.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

function contextLabel(plugin: string, form: string | undefined, replace: boolean): string {
  if (replace) return 'context compacted: earlier messages replaced by a summary'
  if (plugin === 'skills') return 'skills listed for the model'
  if (plugin === 'workspace-instructions') return 'workspace instructions (AGENTS.md) added'
  return `context added by ${plugin}${form === undefined ? '' : ` (${form})`}`
}

function compactionLines(block: Extract<Block, { kind: 'compaction' }>, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  const start = block.start ?? {}
  const applied = block.applied
  const end = block.end
  let text: string
  if (applied) text = `compacted ${Array.isArray(applied.shadowedSeqs) ? applied.shadowedSeqs.length : '?'} messages ${g.dot} ${String(applied.trigger ?? start.trigger ?? '')}`
  else if (end && end.outcome?.kind !== 'applied') text = `compaction declined: ${String(end.outcome?.reason ?? '')}`
  else text = `compacting ${String(start.plannedNodes ?? '')} messages ${g.dot} ${String(start.trigger ?? '')}`
  return wrapped(text, ctx.width, FAINT, [span(`${g.dot} `, FAINT)])
}

/** A failed or stopped turn says why, in sight; a completed one draws nothing. */
function tailLines(reason: Record<string, any>, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  const kind = String(reason.kind)
  if (kind === 'completed') return []
  if (kind === 'error') {
    const lead: Line = [span(`${g.fail} `, { ink: 'error', bold: true }), span('Turn failed ', { ink: 'error', bold: true })]
    return wrapped(`${String(reason.code)} ${g.dot} ${String(reason.message ?? '')}`, ctx.width, { ink: 'error' }, lead, [indent(2)])
  }
  const words: Record<string, string> = { cancelled: 'Turn cancelled', blocked: 'Turn blocked before it started', 'max-steps': 'Turn stopped at its step limit', interrupted: 'Turn interrupted' }
  return [[span(`${g.denied} `, FAINT), span(words[kind] ?? `Turn ${kind}`, FAINT)]]
}

/** Authority and decisions: always in sight, in the attention ink, in words. */
function systemLines(type: string, data: Record<string, any>, rowText: string, model: Model, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  if (type === 'approval/decided') {
    const outcome = String(data.outcome)
    const asked = model.asked.get(String(data.id))?.data
    const what: Line = asked?.subject ? subjectLine(asked.subject) : [span(String(asked?.toolName ?? 'a call'))]
    const by = data.decidedBy === undefined ? '' : ` ${g.dot} by ${String(data.decidedBy)}${data.grantId ? ` (${String(data.grantId)})` : ''}`
    const lead =
      outcome === 'allowed-once'
        ? [span(`${g.ok} `, { ink: 'ok', bold: true }), span('Allowed: ', { bold: true })]
        : outcome === 'rejected'
          ? [span(`${g.fail} `, { ink: 'error', bold: true }), span('Rejected: ', { bold: true })]
          : [span(`${g.denied} `, FAINT), span(`${outcome === 'cancelled' ? 'Cancelled' : 'Unanswered'}: `, FAINT)]
    return wrapLine([...what, span(by, FAINT)], ctx.width, { first: lead, rest: [indent(2)] })
  }
  if (type === 'approval/grant') {
    if (data.op === 'revoke') return [[span(`${g.attention} `, { ink: 'warn' }), span(`Grant ${String(data.id)} revoked`)]]
    return wrapLine([...(data.subject ? subjectLine(data.subject) : [span(String(data.toolName))]), span(` ${g.dot} ${String(data.id)}`, FAINT)], ctx.width, {
      first: [span(`${g.attention} `, { ink: 'warn' }), span('Allowed for this session: ', { bold: true })],
      rest: [indent(2)],
    })
  }
  return wrapped(unbracket(rowText), ctx.width, undefined, [span(`${g.attention} `, { ink: 'warn' })], [indent(2)])
}

/** A consent subject, its model-chosen value as code: from its parts, never split on backticks. */
export function subjectLine(subject: Parameters<typeof subjectParts>[0]): Line {
  return subjectParts(subject).map((part) => ('code' in part ? span(part.code, { ink: 'accent' }) : span(part.text)))
}

// ---- process groups and cards ---------------------------------------------------

function processLines(block: ProcessBlock, settled: boolean, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  const tools = block.items.filter((item): item is ToolItem => item.kind === 'tool')
  const cards = tools.map((item) => cardFor(item, ctx.display(item.name ?? ''), ctx.cards))
  if (settled && !ctx.details && block.items.length >= 2) {
    const denied = tools.filter((item) => DENIALS.has(item.result?.error?.code ?? '')).length
    const failed = cards.filter((card) => card.status === 'failed' || card.status === 'unknown').length - denied
    const thoughts = block.items.filter((item) => item.kind === 'thought').length
    const took = groupDuration(block)
    const head: Span[] = [span(`${g.folded} `, FAINT), span(processTitle(cards, thoughts))]
    const meta = [`${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`, ...(took ? [took] : [])]
    head.push(span(` ${g.dot} ${meta.join(` ${g.dot} `)}`, FAINT))
    if (failed > 0) head.push(span(` ${g.dot} ${failed} failed`, { ink: 'error' }))
    if (denied > 0) head.push(span(` ${g.dot} ${denied} denied`, { ink: 'warn' }))
    head.push(span(` ${g.more}`, FAINT))
    return wrapLine(head, ctx.width, { rest: [indent(2)] })
  }
  const out: Line[] = []
  let index = 0
  for (const item of block.items) {
    if (item.kind === 'tool') {
      const card = cards[index++]!
      // A finished call keeps only its title, except what a person still
      // needs to see: a shell command's output (Codewhale keeps those cells),
      // and anything that failed or was denied.
      // A successful read is one line while it runs too: the file is the model's, not the reader's (Codewhale).
      const quietRead = card.card === 'read' && card.status === 'done'
      out.push(...cardLines(item, card, !ctx.details && card.status === 'done' && (quietRead || (settled && card.card !== 'terminal')), ctx))
    }
    else out.push(...itemLines(item, ctx))
  }
  return out
}

function itemLines(item: Exclude<Item, ToolItem>, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  if (item.kind === 'note') return wrapped(unbracket(item.row.text), ctx.width, FAINT, [span(`${g.dot} `, FAINT)], [indent(2)])
  const lines = displayLines(item.text.trim(), { tabSize: 4 }).filter((line) => line.trim().length > 0)
  const head: Line = [span(`${g.thought} `, FAINT), span('Thought', { faint: true, italic: true })]
  if (lines.length === 0) return [head]
  if (!ctx.details) return [[...head, span(` ${g.dot} ${truncateText(lines[0]!, Math.max(8, ctx.width - 14))}`, { faint: true, italic: true })]]
  return [head, ...lines.flatMap((line) => wrapLine([span(line, { faint: true, italic: true })], ctx.width, { first: [indent(2), span(`${g.thoughtRail} `, FAINT)] }))]
}

function groupDuration(block: ProcessBlock): string {
  let end = 0
  for (const item of block.items) if (item.kind === 'tool' && item.result) end = Math.max(end, item.result.time)
  return end - block.time >= 1000 ? duration(end - block.time) : ''
}

/** The status glyph and the words a card's state needs. */
function statusOf(item: ToolItem, card: Card, ctx: BlockContext): { glyph: Span; words: Span[] } {
  const g = ctx.theme.glyphs
  const code = item.result?.error?.code
  if (code !== undefined && DENIALS.has(code)) return { glyph: span(`${g.denied} `, { ink: 'warn' }), words: [span(` ${g.dot} denied ${g.dot} ${code}`, { ink: 'warn' })] }
  switch (card.status) {
    case 'running': {
      const ran = ctx.now - item.time
      return { glyph: span(`${ctx.spinner} `, { ink: 'accent' }), words: [span(` ${g.dot} running${ran >= 3000 ? ` ${duration(ran)}` : ''}`, FAINT)] }
    }
    case 'preparing':
      return { glyph: span(`${ctx.spinner} `, FAINT), words: [] }
    case 'waiting':
      return { glyph: span(`${g.ask} `, { ink: 'warn', bold: true }), words: [span(` ${g.dot} waiting for approval`, { ink: 'warn' })] }
    case 'failed':
      return { glyph: span(`${g.fail} `, { ink: 'error', bold: true }), words: code === undefined ? [span(` ${g.dot} failed`, { ink: 'error' })] : [span(` ${g.dot} ${code}`, { ink: 'error' })] }
    case 'stopped':
      return { glyph: span(`${g.denied} `, FAINT), words: [span(` ${g.dot} not run`, FAINT)] }
    case 'unknown':
      return { glyph: span(`${g.ask} `, FAINT), words: [span(` ${g.dot} ${item.result ? 'outcome unknown' : 'no result recorded'}`, FAINT)] }
    default: {
      const took = item.result ? item.result.time - item.time : 0
      return { glyph: span(`${g.ok} `, { ink: 'ok' }), words: took >= 1000 ? [span(` ${g.dot} ${duration(took)}`, FAINT)] : [] }
    }
  }
}

/** A card's title line: glyph, title, summary, then its state, all on one wrapped row. */
export function cardTitle(item: ToolItem, card: Card, ctx: BlockContext): Line[] {
  const { glyph, words } = statusOf(item, card, ctx)
  const parts: Span[] = [span(card.title, { bold: card.status !== 'done' })]
  const summary = card.summary
  if (summary) parts.push(span(`  ${truncateText(cleanText(summary), Math.max(12, ctx.width - textWidth(card.title) - 18))}`))
  if (card.diffStat) parts.push(span(` +${card.diffStat.added}`, { ink: 'add' }), span(` −${card.diffStat.removed}`, { ink: 'del' }))
  if (card.exit) parts.push(span(` ${ctx.theme.glyphs.dot} ${card.exit.timedOut ? 'timed out' : card.exit.signal ? card.exit.signal : `exit ${card.exit.code}`}`, { ink: 'error' }))
  parts.push(...words)
  return wrapLine(parts, ctx.width, { first: [glyph], rest: [indent(2)] })
}

/** How many lines of output a calm card shows. */
const CALM = { headOk: 1, tailOk: 2, headFail: 10, tailFail: 6, middleFail: 4, diff: 14, code: 6, markdown: 3, command: 3 } as const
/** Ctrl+O still bounds what one card may print: a 50,000-line log is a file, not a screen. */
const DETAIL_CAP = 400

function cardLines(item: ToolItem, card: Card, quiet: boolean, ctx: BlockContext): Line[] {
  const out = cardTitle(item, card, ctx)
  const g = ctx.theme.glyphs
  const inner = Math.max(10, ctx.width - 4)
  const failed = card.status === 'failed'
  // A failure with no output of its own still says why, from its code and first line.
  const hasOutput = card.sections.some((section) => section.kind === 'output' && section.text.trim().length > 0)
  if (failed && card.failure && !hasOutput) out.push(...railed(wrapLine([span(cleanText(card.failure), { ink: 'error' })], inner), ctx))
  for (const image of card.images) out.push(...railed([[span(image.type === 'image' ? (image.text ?? '[image]') : '[image]', FAINT)]], ctx))
  if (card.child) out.push(...childLines(item, card, ctx))
  if (quiet) return out
  const body: Line[] = []
  for (const section of card.sections) {
    if (section.kind === 'command') {
      const lines = displayLines(section.text)
      const shown = ctx.details ? lines : lines.slice(0, CALM.command)
      for (const [index, line] of shown.entries()) body.push(...wrapLine([span(line)], inner, { first: [span(index === 0 ? '$ ' : '  ', FAINT)] }))
      if (shown.length < lines.length) body.push([span(`${g.ellipsis} +${lines.length - shown.length} lines`, FAINT)])
    } else if (section.kind === 'output') {
      body.push(...outputExcerpt(section.text, failed || section.error === true, inner, ctx))
    } else if (section.kind === 'diff') {
      const rows = section.lines.map((line): Line => {
        const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
        const style: Style | undefined = line.type === 'add' ? { ink: 'add' } : line.type === 'del' ? { ink: 'del' } : FAINT
        return [span(`${sign} ${displayLines(line.text, { tabSize: 4 })[0] ?? ''}`, style)]
      })
      const limit = ctx.details ? DETAIL_CAP : CALM.diff
      for (const row of rows.slice(0, limit)) body.push(...wrapLine(row, inner, { rest: [indent(2)] }))
      const hidden = rows.length - Math.min(limit, rows.length) + section.hidden
      if (hidden > 0) body.push([span(`${g.ellipsis} +${hidden} diff lines ${g.dot} ctrl+o`, FAINT)])
    } else if (section.kind === 'code') {
      const lines = displayLines(section.text, { tabSize: 4 })
      const limit = ctx.details ? DETAIL_CAP : CALM.code
      for (const line of lines.slice(0, limit)) body.push(...wrapLine([span(line, FAINT)], inner))
      if (lines.length > limit) body.push([span(`${g.ellipsis} +${lines.length - limit} lines ${g.dot} ctrl+o`, FAINT)])
    } else if (section.kind === 'markdown') {
      // The delegation's prompt is behind Ctrl+O: the title already names the task, and the child's own activity says what it is doing.
      if (card.card === 'delegate' && section === card.sections[0] && !ctx.details) continue
      const lines = renderMarkdown(section.text, inner, ctx.theme)
      const limit = ctx.details ? DETAIL_CAP : CALM.markdown
      body.push(...lines.slice(0, limit))
      if (lines.length > limit) body.push([span(`${g.ellipsis} +${lines.length - limit} lines ${g.dot} ctrl+o`, FAINT)])
    } else if (section.kind === 'approvals') {
      if (!ctx.details) continue
      for (const ask of section.items) body.push(...wrapLine([span(`${g.ask} ${ask.subject}`, FAINT), span(ask.outcome ? ` ${g.dot} ${ask.outcome}` : '', FAINT)], inner))
    }
  }
  if (ctx.details) for (const receipt of card.receipts) body.push([span(receipt, FAINT)])
  return [...out, ...railed(body, ctx)]
}

/**
 * Tool output, as much as a glance needs: a success shows one head and two
 * tail lines, a failure up to twenty — its head, its tail, and the middle
 * lines most likely to say what broke. Every line is clamped to two rows.
 */
function outputExcerpt(text: string, failed: boolean, width: number, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  const lines = displayLines(text)
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  if (lines.length === 0) return []
  const style: Style | undefined = failed ? undefined : FAINT
  const row = (line: string): Line[] => wrapLine([span(line, style)], width).slice(0, ctx.details ? undefined : 2)
  if (ctx.details) {
    const shown = lines.slice(0, DETAIL_CAP).flatMap(row)
    return lines.length > DETAIL_CAP ? [...shown, [span(`${g.ellipsis} +${lines.length - DETAIL_CAP} lines`, FAINT)]] : shown
  }
  const head = failed ? CALM.headFail : CALM.headOk
  const tail = failed ? CALM.tailFail : CALM.tailOk
  if (lines.length <= head + tail + (failed ? CALM.middleFail : 0) + 1) return lines.flatMap(row)
  const middle = failed ? rankMiddle(lines.slice(head, lines.length - tail), CALM.middleFail) : []
  const out: Line[] = lines.slice(0, head).flatMap(row)
  let shownMiddle = 0
  for (const [, line] of middle) {
    out.push(...row(line))
    shownMiddle++
  }
  out.push([span(`${g.ellipsis} (+${lines.length - head - tail - shownMiddle} lines) ${g.dot} ctrl+o`, FAINT)])
  out.push(...lines.slice(lines.length - tail).flatMap(row))
  return out
}

/** The middle lines a failure most likely hinges on, in their original order. */
function rankMiddle(lines: readonly string[], keep: number): [number, string][] {
  const score = (line: string): number =>
    /\b(error|fatal|panic|exception|denied|failed|failure|assert)/i.test(line) ? 3 : /\bwarn/i.test(line) ? 2 : /[\w.-]+[\\/][\w.\\/-]+(:\d+)?/.test(line) ? 1 : 0
  return lines
    .map((line, index): [number, string, number] => [index, line, score(line)])
    .filter(([, , value]) => value > 0)
    .toSorted((a, b) => b[2] - a[2] || a[0] - b[0])
    .slice(0, keep)
    .toSorted((a, b) => a[0] - b[0])
    .map(([index, line]) => [index, line])
}

/** A delegated child: its latest actions while it runs (from its own attached model), how it ended once it has. */
function childLines(item: ToolItem, card: Card, ctx: BlockContext): Line[] {
  const g = ctx.theme.glyphs
  const child = card.child!
  const out: Line[] = []
  const model = child.ended === undefined ? ctx.child?.(child.childId) : undefined
  if (model) {
    const items = [...model.items.values()].filter((one) => one.called || one.result)
    const recent = items.slice(-3)
    if (items.length > recent.length) out.push([span(`${g.ellipsis} ${items.length - recent.length} earlier`, FAINT)])
    const childCtx: BlockContext = { ...ctx, width: Math.max(10, ctx.width - 6), details: false, cards: { ...ctx.cards, running: true, pendingCallIds: new Set() } }
    for (const one of recent) out.push(...cardTitle(one, cardFor(one, ctx.display(one.name ?? ''), childCtx.cards), childCtx))
    if (model.live && model.live.text.trim().length > 0) out.push([span(`${g.reply} `, FAINT), span(truncateText(cleanText(model.live.text.trim().split('\n').at(-1) ?? ''), Math.max(8, ctx.width - 10)), FAINT)])
  }
  if (child.ended !== undefined) {
    out.push([span(`${g.childEnd} `, FAINT), span(child.ended === 'completed' ? 'done' : child.ended, child.ended === 'completed' ? { ink: 'ok' } : { ink: 'warn' }), span(`${child.route ? ` ${g.dot} ${child.route}` : ''}${usageText(item.subagent?.end?.usage, g.dot)}`, FAINT)])
  }
  return out.length === 0 ? [] : railed(out, ctx)
}

/**
 * A child's cost from its `subagent/end`, checked field by field: the browser's
 * model types that payload loosely, and a renamed field must read as absent,
 * never as `NaN` (the S5.5 lesson).
 */
function usageText(usage: unknown, dot: string): string {
  if (typeof usage !== 'object' || usage === null) return ''
  const read = (key: string): number => {
    const value = (usage as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  const input = read('inputTokens') + read('cacheReadTokens') + read('cacheWriteTokens')
  const output = read('outputTokens')
  return input + output === 0 ? '' : ` ${dot} ${tokens(input)} in ${dot} ${tokens(output)} out`
}
