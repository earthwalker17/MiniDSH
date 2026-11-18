/**
 * The card a call draws, held to the two rules `cards.js` is built on:
 *
 * - the TOOL decides its card (its declared `display`, including a per-call
 *   selector over one of its own arguments), and an undeclared name draws the
 *   generic card rather than a guess;
 * - the result side reads only durable structure: an exit code from the
 *   effect record, never parsed out of the model-facing text, and "running" or
 *   "waiting" only where the live view says so.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDisplay } from '../../core/tools/types.ts'
import { cardFor, displayCase, languageOf, lineDiff, processTitle, type CardContext } from './cards.js'
import type { ToolItem } from './conversation.js'

const EDITOR: ToolDisplay = {
  card: 'edit',
  title: 'Edit file',
  fields: { path: 'path' },
  by: {
    arg: 'command',
    cases: {
      view: { card: 'read', title: 'Read file', fields: { path: 'path' } },
      create: { card: 'edit', title: 'Create file', fields: { path: 'path', content: 'file_text' } },
      str_replace: { card: 'edit', title: 'Edit file', fields: { path: 'path', oldText: 'old_str', newText: 'new_str' } },
      insert: { card: 'edit', title: 'Insert lines', fields: { path: 'path', newText: 'new_str', line: 'insert_line' } },
    },
  },
}
const SHELL: ToolDisplay = { card: 'terminal', title: 'Run command', fields: { command: 'command' } }

function item(patch: Partial<ToolItem> & { args?: string }): ToolItem {
  return { kind: 'tool', key: 'call:c1', callId: 'c1', groupKey: 'g', seqs: [], time: 0, called: true, dispatched: true, effects: [], asked: [], name: 'tool', ...patch }
}

const idle: CardContext = { cwd: '/ws', running: false, pendingCallIds: new Set(), asked: new Map(), decided: new Map() }

describe('a call card', () => {
  it('takes its card and title from the case the call selects, never from the tool name', () => {
    expect(displayCase(EDITOR, { command: 'view', path: 'a.ts' })?.title).toBe('Read file')
    expect(displayCase(EDITOR, { command: 'insert' })?.card).toBe('edit')
    // A value the tool did not declare falls back to the base, not to another case.
    expect(displayCase(EDITOR, { command: 'toString' })?.title).toBe('Edit file')
    expect(displayCase(EDITOR, { command: 'constructor' })?.title).toBe('Edit file')
    const read = cardFor(item({ name: 'str_replace_editor', args: JSON.stringify({ command: 'view', path: '/ws/src/a.ts' }) }), EDITOR, idle)
    expect(read).toMatchObject({ card: 'read', title: 'Read file', summary: 'src/a.ts' })
  })

  it('draws an undeclared tool as the generic card, its arguments verbatim', () => {
    const card = cardFor(item({ name: 'mystery', args: '{"a":1,"b":"two"}', result: { seq: 2, time: 1, text: 'ok', images: [], isError: false } }), undefined, idle)
    expect(card.card).toBe('generic')
    expect(card.title).toBe('mystery')
    expect(card.summary).toBe('a: 1 · b: two')
    expect(card.sections.map((section) => section.kind)).toEqual(['code', 'output'])
  })

  it('shows arguments that do not parse as they are, rather than guessing', () => {
    const card = cardFor(item({ name: 'pwsh', args: '{"command": "ls' }), SHELL, idle)
    expect(card.sections[0]).toEqual({ kind: 'code', text: '{"command": "ls' })
  })

  it('reads an exit code from the effect record only — never from the text the model was shown', () => {
    const failing = item({ name: 'pwsh', args: '{"command":"pnpm test"}', result: { seq: 3, time: 2, text: '1 failing\n[exit code: 1]', images: [], isError: false } })
    expect(cardFor(failing, SHELL, idle).exit).toBeUndefined()
    const recorded = { ...failing, effects: [{ effect: 'shell-command', exitCode: 1, durationMs: 900, mode: 'workspace-write', enforcement: 'none' }] }
    const card = cardFor(recorded, SHELL, idle)
    expect(card.exit).toEqual({ code: 1 })
    expect(card.receipts).toEqual(['exit 1 · 0.9s · workspace-write/none'])
    expect(card.summary).toBe('pnpm test')
    // An exit 0 is no news.
    expect(cardFor({ ...failing, effects: [{ effect: 'shell-command', exitCode: 0, durationMs: 10, mode: 'read-only', enforcement: 'full' }] }, SHELL, idle).exit).toBeUndefined()
  })

  it('a call with no result is "running" only where the live view says the session runs', () => {
    const open = item({ name: 'pwsh', args: '{"command":"sleep 1"}' })
    expect(cardFor(open, SHELL, idle).status).toBe('unknown')
    expect(cardFor(open, SHELL, { ...idle, running: true }).status).toBe('running')
    expect(cardFor({ ...open, dispatched: false }, SHELL, { ...idle, running: true }).status).toBe('preparing')
    expect(cardFor(open, SHELL, { ...idle, running: true, pendingCallIds: new Set(['c1']) }).status).toBe('waiting')
  })

  it('names a call that never ran, or whose outcome is unknown, as such', () => {
    const notRun = item({ result: { seq: 4, time: 3, text: 'Error: aborted', images: [], isError: true, error: { name: 'ToolError', code: 'ABORTED_BEFORE_DISPATCH' } } })
    expect(cardFor(notRun, SHELL, idle).status).toBe('stopped')
    const unknown = item({ result: { seq: 4, time: 3, text: '', images: [], isError: true, error: { name: 'ToolError', code: 'TOOL_OUTCOME_UNKNOWN' } } })
    expect(cardFor(unknown, SHELL, idle).status).toBe('unknown')
    const denied = item({ args: '{"command":"rm -rf /"}', result: { seq: 4, time: 3, text: 'Error: write outside the workspace', images: [], isError: true, error: { name: 'ToolError', code: 'FS_SANDBOX_DENIED' } } })
    expect(cardFor(denied, SHELL, idle)).toMatchObject({ status: 'failed', failure: 'FS_SANDBOX_DENIED: write outside the workspace' })
  })

  it('diffs an edit from its own old and new text, with the counts on the row', () => {
    const edit = item({ name: 'str_replace_editor', args: JSON.stringify({ command: 'str_replace', path: '/ws/slug.js', old_str: "a\nreturn x.replace(' ', '-')\nb", new_str: "a\nreturn x.replace(/ /g, '-')\nb" }) })
    const card = cardFor(edit, EDITOR, idle)
    expect(card.diffStat).toEqual({ added: 1, removed: 1 })
    const diff = card.sections[0]
    expect(diff?.kind).toBe('diff')
    expect(diff?.kind === 'diff' && diff.lines.map((line) => line.type)).toEqual(['ctx', 'del', 'add', 'ctx'])
    expect(card.lang).toBe('js')
  })

  it('bounds a huge diff and says how much it hid', () => {
    const many = Array.from({ length: 1000 }, (_, at) => `line ${at}`).join('\n')
    const { lines, hidden } = lineDiff('', many)
    expect(lines.length).toBe(400)
    expect(hidden).toBe(600)
    // Past the table bound it shows removed-then-added instead of building a table.
    const wide = lineDiff(Array.from({ length: 600 }, (_, at) => `a${at}`).join('\n'), Array.from({ length: 600 }, (_, at) => `b${at}`).join('\n'))
    expect(wide.lines[0]?.type).toBe('del')
  })

  it('carries a delegation\'s child and an approval\'s decision, joined by id', () => {
    const delegate: ToolDisplay = { card: 'delegate', title: 'Delegate a task', fields: { description: 'description', prompt: 'prompt' } }
    const card = cardFor(
      item({ name: 'subagent', args: '{"description":"Review it","prompt":"Read slug.js"}', subagent: { start: { childId: 's-1', provider: 'deepseek', model: 'deepseek-v4-flash', sandbox: 'read-only' } }, asked: ['approval-1'] }),
      delegate,
      { ...idle, asked: new Map([['approval-1', { callId: 'c1', data: { toolName: 'subagent', subject: { effect: 'shell-command', command: 'ls', mode: 'read-only', enforcement: 'full' } } }]]), decided: new Map([['approval-1', { outcome: 'allowed-once', decidedBy: 'user' }]]) },
    )
    expect(card.summary).toBe('Review it')
    expect(card.child).toEqual({ childId: 's-1', route: 'deepseek/deepseek-v4-flash', sandbox: 'read-only' })
    expect(card.sections[0]).toEqual({ kind: 'approvals', items: [{ subject: 'run `ls` under read-only/full', outcome: 'allowed-once', decidedBy: 'user' }] })
  })

  it('titles a settled group by the kinds of work it did', () => {
    const shell = cardFor(item({ args: '{"command":"ls"}' }), SHELL, idle)
    const edit = cardFor(item({ args: '{"command":"create","path":"a","file_text":"x"}' }), EDITOR, idle)
    expect(processTitle([shell, edit, shell], 0)).toBe('Ran commands and edited files')
    expect(processTitle([], 2)).toBe('Thought')
    expect(languageOf('C:\\ws\\x.TSX')).toBe('tsx')
    expect(languageOf('Makefile')).toBeUndefined()
  })
})
