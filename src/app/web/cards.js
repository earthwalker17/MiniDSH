// @ts-check
/**
 * What one call's card says, without the DOM: a pure function of the item
 * the conversation model joined, the presentation its TOOL declared, and the
 * live view.
 *
 * The card never knows a tool by its name. A tool owns `display` (its card,
 * its title, which of its arguments plays which role, and a per-call selector
 * over one of its own arguments: `core/tools/types.ts`), and the host sends it
 * in `initialize` and `session/attach`. A name nobody declared, or one whose
 * `display` is out of reach (a preset's tool on a cold read, the other shell
 * dialect's), draws the generic card: the call's arguments and its result,
 * honestly unlabelled.
 *
 * The RESULT side reads only durable structure: `effect/recorded` for an exit
 * code and the bytes a write left, `subagent/*` for a child, `job/*` for a
 * job, image blocks for pictures. The model-facing text of a result is shown
 * as text and never parsed for a status — and a shell call with no effect
 * record shows no exit code at all: an absent record proves nothing (§4).
 *
 * "Running" and "waiting" are the VIEW's to say (`frames.ts`: a page cannot
 * tell a call in flight from one whose writer died). Without a live view that
 * says so, a call with no result is "no result recorded".
 */
import { bytes, duration, relativePath } from './format.js'
import { subjectText } from './rows.js'

/** @typedef {import('./conversation.js').ToolItem} ToolItem */
/** @typedef {import('../../core/llm/types.ts').ContentBlock} ContentBlock */
/** @typedef {import('../../core/tools/types.ts').ToolDisplay} ToolDisplay */
/** @typedef {import('../../core/tools/types.ts').ToolDisplayCase} ToolDisplayCase */
/** @typedef {import('../../core/tools/types.ts').ToolCard} ToolCard */

/**
 * @typedef {{ kind: 'command', text: string }
 *   | { kind: 'output', text: string, error?: boolean }
 *   | { kind: 'diff', lines: DiffLine[], hidden: number }
 *   | { kind: 'code', text: string, lang?: string }
 *   | { kind: 'markdown', text: string }
 *   | { kind: 'fields', rows: [string, string][] }
 *   | { kind: 'approvals', items: { subject: string, reason?: string, outcome?: string, decidedBy?: string }[] }} Section
 */
/** @typedef {{ type: 'add' | 'del' | 'ctx', text: string }} DiffLine */

/**
 * @typedef {{
 *   card: ToolCard,
 *   title: string,
 *   name: string,
 *   summary: string,
 *   status: 'preparing' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'unknown',
 *   failure?: string,
 *   exit?: { code?: number, signal?: string, timedOut?: boolean },
 *   receipts: string[],
 *   diffStat?: { added: number, removed: number },
 *   sections: Section[],
 *   images: ContentBlock[],
 *   child?: { childId: string, route?: string, sandbox?: string, ended?: string },
 *   job?: { jobId: string, label?: string, ended?: string },
 *   path?: string,
 *   lang?: string,
 * }} Card
 */

/**
 * The live context a card reads its status from.
 * @typedef {{
 *   cwd?: string,
 *   running: boolean,
 *   pendingCallIds: ReadonlySet<string>,
 *   asked: ReadonlyMap<string, { callId?: string, data: Record<string, any> }>,
 *   decided: ReadonlyMap<string, Record<string, any>>,
 * }} CardContext
 */

/** Codes the runtime writes when a call never ran or its outcome is unknown (`TOOL_NOT_STARTED`: §4; the other two: §6). */
const STOPPED_CODES = new Set(['ABORTED_BEFORE_DISPATCH', 'TOOL_NOT_STARTED', 'DURABILITY_LOST'])
const UNKNOWN_CODES = new Set(['TOOL_OUTCOME_UNKNOWN'])

/** @param {string | undefined} raw @returns {Record<string, unknown> | undefined} */
function parseArgs(raw) {
  if (raw === undefined || raw.trim().length === 0) return {}
  try {
    const value = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** @param {unknown} value @returns {string | undefined} */
const str = (value) => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined)

/** @param {string} text */
const firstLine = (text) => {
  const trimmed = text.trim()
  const end = trimmed.indexOf('\n')
  return end === -1 ? trimmed : `${trimmed.slice(0, end)} …`
}

/**
 * The case of `display` this call selects: the value of the declared argument
 * picks a declared case; anything else is the base.
 * @param {ToolDisplay | undefined} display
 * @param {Record<string, unknown> | undefined} args
 * @returns {ToolDisplayCase | undefined}
 */
export function displayCase(display, args) {
  if (!display) return undefined
  const selector = display.by
  if (selector && args) {
    const value = str(args[selector.arg])
    const chosen = value === undefined ? undefined : Object.hasOwn(selector.cases, value) ? selector.cases[value] : undefined
    if (chosen) return chosen
  }
  return { card: display.card, title: display.title, ...(display.fields ? { fields: display.fields } : {}) }
}

/**
 * @param {ToolItem} item
 * @param {ToolDisplay | undefined} display the tool's declared presentation, from the catalog
 * @param {CardContext} context
 * @returns {Card}
 */
export function cardFor(item, display, context) {
  const args = parseArgs(item.args)
  const chosen = displayCase(display, args)
  const card = chosen?.card ?? 'generic'
  const fields = chosen?.fields ?? {}
  /** @param {keyof NonNullable<ToolDisplayCase['fields']>} wanted */
  const role = (wanted) => {
    const name = fields[wanted]
    return name === undefined || !args ? undefined : str(args[name])
  }
  const name = item.name ?? 'tool'
  const title = chosen?.title ?? (item.name ? name : 'Tool result')
  const command = role('command')
  const path = role('path')
  const shown = path === undefined ? undefined : relativePath(path, context.cwd ?? '')

  /** @type {Card} */
  const result = { card, title, name, summary: '', status: statusOf(item, context), receipts: receiptsOf(item), sections: [], images: item.result?.images ?? [] }
  if (item.result?.error) result.failure = failureLine(item)
  if (shown !== undefined) result.path = shown

  const shell = item.effects.find((effect) => effect.effect === 'shell-command')
  if (shell && (shell.timedOut === true || (typeof shell.exitCode === 'number' && shell.exitCode !== 0) || (shell.exitCode === undefined && shell.signal !== undefined))) {
    result.exit = {
      ...(typeof shell.exitCode === 'number' ? { code: shell.exitCode } : {}),
      ...(typeof shell.signal === 'string' ? { signal: shell.signal } : {}),
      ...(shell.timedOut === true ? { timedOut: true } : {}),
    }
  }

  const output = item.result?.text ?? ''
  const outputSection = () => (item.result ? [/** @type {Section} */ ({ kind: 'output', text: output, ...(item.result.isError ? { error: true } : {}) })] : [])

  if (!args) {
    // Arguments that do not parse (a model's malformed JSON, a truncated
    // record) are shown verbatim rather than guessed at.
    result.summary = firstLine(item.args ?? '')
    result.sections = [{ kind: 'code', text: item.args ?? '' }, ...outputSection()]
  } else if (card === 'terminal' || (card === 'job' && command !== undefined)) {
    result.summary = command === undefined ? '' : firstLine(command)
    result.sections = [...(command === undefined ? [] : [/** @type {Section} */ ({ kind: 'command', text: command })]), ...outputSection()]
  } else if (card === 'edit') {
    const oldText = role('oldText')
    const newText = role('newText')
    const content = role('content')
    const line = role('line')
    result.summary = shown === undefined ? '' : line === undefined ? shown : `${shown}:${line}`
    const lang = languageOf(path)
    if (lang) result.lang = lang
    // The counts are of a change made or being made. A call whose result is an
    // error (refused, denied, never run) changed nothing, and `+5 −1` beside
    // its error text would say it had; what it ASKED to change stays below.
    const changed = item.result?.isError !== true
    if (oldText !== undefined || newText !== undefined) {
      const diff = lineDiff(oldText ?? '', newText ?? '')
      if (changed) result.diffStat = { added: diff.lines.filter((l) => l.type === 'add').length, removed: diff.lines.filter((l) => l.type === 'del').length }
      result.sections = [{ kind: 'diff', ...diff }]
      if (item.result?.isError) result.sections.push(...outputSection())
    } else if (content !== undefined) {
      if (changed) result.diffStat = { added: content.length === 0 ? 0 : content.split('\n').length, removed: 0 }
      result.sections = [{ kind: 'code', text: content, ...(result.lang ? { lang: result.lang } : {}) }]
      if (item.result?.isError) result.sections.push(...outputSection())
    } else result.sections = outputSection()
  } else if (card === 'read') {
    result.summary = shown ?? ''
    const lang = languageOf(path)
    if (lang) result.lang = lang
    result.sections = outputSection()
  } else if (card === 'image') {
    result.summary = shown ?? role('ref') ?? ''
    result.sections = item.result?.isError || result.images.length === 0 ? outputSection() : []
  } else if (card === 'search') {
    result.summary = role('query') ?? ''
    result.sections = item.result ? [{ kind: 'markdown', text: output }] : []
  } else if (card === 'browse') {
    const action = [role('action'), role('ref')].filter(Boolean).join(' ')
    result.summary = role('url') ?? (action || undefined) ?? firstLine(role('expression') ?? '') ?? ''
    const expression = role('expression')
    result.sections = [...(expression === undefined ? [] : [/** @type {Section} */ ({ kind: 'code', text: expression, lang: 'js' })]), ...outputSection()]
  } else if (card === 'delegate') {
    const prompt = role('prompt')
    result.summary = role('description') ?? firstLine(prompt ?? '')
    const start = item.subagent?.start
    const end = item.subagent?.end
    if (start || end) {
      result.child = {
        childId: String((start ?? end)?.childId),
        ...(start ? { route: `${start.provider}/${start.model}`, sandbox: String(start.sandbox) } : {}),
        ...(end ? { ended: String(end.reason?.kind ?? 'ended') } : {}),
      }
    }
    result.sections = [...(prompt === undefined ? [] : [/** @type {Section} */ ({ kind: 'markdown', text: prompt })]), ...(item.result ? [/** @type {Section} */ ({ kind: 'markdown', text: output })] : [])]
  } else if (card === 'job') {
    result.summary = role('jobId') ?? ''
    result.sections = outputSection()
  } else {
    result.summary = argsPreview(args)
    result.sections = [{ kind: 'code', text: JSON.stringify(args, null, 2), lang: 'json' }, ...outputSection()]
  }
  if (item.job) {
    result.job = {
      jobId: item.job.jobId,
      ...(item.job.start ? { label: String(item.job.start.label) } : {}),
      ...(item.job.end ? { ended: String(item.job.end.cause) } : {}),
    }
  }
  const approvals = approvalsOf(item, context)
  if (approvals.length > 0) result.sections.unshift({ kind: 'approvals', items: approvals })
  return result
}

/** @param {ToolItem} item @param {CardContext} context @returns {Card['status']} */
function statusOf(item, context) {
  const result = item.result
  if (result) {
    const code = result.error?.code
    if (code !== undefined && STOPPED_CODES.has(code)) return 'stopped'
    if (code !== undefined && UNKNOWN_CODES.has(code)) return 'unknown'
    return result.isError ? 'failed' : 'done'
  }
  if (context.pendingCallIds.has(item.callId)) return 'waiting'
  if (context.running) return item.dispatched ? 'running' : 'preparing'
  return 'unknown'
}

/** @param {ToolItem} item */
function failureLine(item) {
  const error = item.result?.error
  if (!error) return ''
  const text = (item.result?.text ?? '').replace(/^Error:\s*/, '')
  const first = text.split('\n').find((line) => line.trim().length > 0)
  return first ? `${error.code}: ${first.trim()}` : error.code
}

/**
 * What a call left behind, in the receipt form the browser shows as chips:
 * the runtime's own record of an effect, never the model's account of it.
 * @param {ToolItem} item
 * @returns {string[]}
 */
function receiptsOf(item) {
  return item.effects.map((effect) => {
    if (effect.effect === 'fs-write') {
      const path = String(effect.path)
      const name = path.split(/[\\/]/).pop() ?? path
      return `wrote ${name} · ${bytes(Number(effect.bytes))} · sha256 ${String(effect.sha256).slice(0, 12)}`
    }
    const outcome = effect.timedOut === true ? 'timed out' : effect.exitCode === undefined ? 'no exit code' : `exit ${effect.exitCode}`
    const took = typeof effect.durationMs === 'number' ? ` · ${duration(effect.durationMs)}` : ''
    return `${outcome}${took} · ${effect.mode}/${effect.enforcement}`
  })
}

/** @param {ToolItem} item @param {CardContext} context */
function approvalsOf(item, context) {
  return item.asked.map((id) => {
    const asked = context.asked.get(id)?.data ?? {}
    const decided = context.decided.get(id)
    return {
      subject: asked.subject ? subjectText(asked.subject) : `use ${asked.toolName ?? item.name ?? 'a tool'}`,
      ...(typeof asked.reason === 'string' && asked.reason.length > 0 ? { reason: asked.reason } : {}),
      ...(decided ? { outcome: String(decided.outcome) } : {}),
      ...(decided?.decidedBy ? { decidedBy: String(decided.decidedBy) } : {}),
    }
  })
}

/** @param {Record<string, unknown>} args */
function argsPreview(args) {
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${key}: ${text}`)
  }
  const joined = parts.join(' · ').replace(/\s+/g, ' ')
  return joined.length <= 140 ? joined : `${joined.slice(0, 139)}…`
}

/** The highlighter's language for a path's extension. */
const LANGUAGES = /** @type {Readonly<Record<string, string>>} */ ({
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', json: 'json', jsonc: 'json',
  py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'ps1', psm1: 'ps1', rs: 'rs', go: 'go', java: 'java', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'cs', css: 'css', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', diff: 'diff', patch: 'diff', md: 'md',
})

/** @param {string | undefined} path @returns {string | undefined} */
export function languageOf(path) {
  if (!path) return undefined
  const base = path.split(/[\\/]/).pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? undefined : LANGUAGES[base.slice(dot + 1).toLowerCase()]
}

/** Lines of unchanged context kept around a change. */
const CONTEXT = 3
/** Beyond this many cells the LCS table is not built: the change shows as removed-then-added. */
const LCS_CELLS = 250_000
/** A diff longer than this is cut, and says how much it hid. */
const MAX_LINES = 400

/**
 * A line diff of an edit's old and new text, for the card's body. Not a patch
 * of the file: an edit names snippets, so this shows exactly what the call
 * asked to replace, with its common head and tail as context.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ lines: DiffLine[], hidden: number }}
 */
export function lineDiff(oldText, newText) {
  const a = oldText.length === 0 ? [] : oldText.split('\n')
  const b = newText.length === 0 ? [] : newText.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  /** @type {DiffLine[]} */
  let middle
  if (midA.length * midB.length > LCS_CELLS) {
    middle = [...midA.map((text) => /** @type {DiffLine} */ ({ type: 'del', text })), ...midB.map((text) => /** @type {DiffLine} */ ({ type: 'add', text }))]
  } else middle = lcsDiff(midA, midB)
  /** @type {DiffLine[]} */
  const lines = [
    ...a.slice(Math.max(0, start - CONTEXT), start).map((text) => /** @type {DiffLine} */ ({ type: 'ctx', text })),
    ...middle,
    ...a.slice(endA, Math.min(a.length, endA + CONTEXT)).map((text) => /** @type {DiffLine} */ ({ type: 'ctx', text })),
  ]
  if (lines.length <= MAX_LINES) return { lines, hidden: 0 }
  return { lines: lines.slice(0, MAX_LINES), hidden: lines.length - MAX_LINES }
}

/** @param {string[]} a @param {string[]} b @returns {DiffLine[]} */
function lcsDiff(a, b) {
  const m = a.length
  const n = b.length
  const width = n + 1
  const table = new Uint32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  /** @type {DiffLine[]} */
  const out = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] ?? '' })
      i++
      j++
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) out.push({ type: 'del', text: a[i++] ?? '' })
    else out.push({ type: 'add', text: b[j++] ?? '' })
  }
  while (i < m) out.push({ type: 'del', text: a[i++] ?? '' })
  while (j < n) out.push({ type: 'add', text: b[j++] ?? '' })
  return out
}

/**
 * The one-line summary of a finished turn's process, as DSH titles it: what
 * KINDS of work it did, never how many of each.
 * @param {readonly Card[]} cards
 * @param {number} thoughts
 * @returns {string}
 */
export function processTitle(cards, thoughts) {
  /** @type {string[]} */
  const parts = []
  /** @param {string} phrase */
  const add = (phrase) => {
    if (!parts.includes(phrase)) parts.push(phrase)
  }
  for (const card of cards) {
    if (card.card === 'terminal' || card.card === 'job') add('ran commands')
    else if (card.card === 'edit') add('edited files')
    else if (card.card === 'read') add('read files')
    else if (card.card === 'search') add('searched the web')
    else if (card.card === 'browse') add('used the browser')
    else if (card.card === 'image') add('looked at images')
    else if (card.card === 'delegate') add('delegated work')
    else if (card.card === 'recall') add('recalled history')
    else add('used tools')
  }
  if (parts.length === 0) return thoughts > 0 ? 'Thought' : 'Worked'
  const shown = parts.length > 3 ? [...parts.slice(0, 3), 'more'] : parts
  const sentence = shown.length === 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}
