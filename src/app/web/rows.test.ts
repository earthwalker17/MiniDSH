/**
 * The browser's row projection held to the plain-text one.
 *
 * `rows.js` and `app/present.ts` are two projections of the same durable
 * events, and the rule between them is one sentence: they may differ in FORM,
 * never in whether an event is visible at all. Until S13 that rule was kept by
 * hand in an untyped `switch` inside `app.js` that no test imported, and it had
 * already drifted (`request/context` rendered in every terminal and nowhere in
 * the browser). This file is the gate, in both directions:
 *
 * - every kind `describeEvent` has a branch for must have a sample here, so a
 *   new `matches(event, KIND)` in `present.ts` fails until someone decides what
 *   the browser shows for it;
 * - every `case` in `rows.js` must have a sample here too;
 * - and for every sample, "has a transcript line" equals "has a browser row".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_OPTIONS, INBOX_SPLICED, SUBAGENT_END, SUBAGENT_START } from '../../core/agent/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_POLICY } from '../../core/approval/index.ts'
import { COMPACTION_APPLIED, COMPACTION_END, COMPACTION_START } from '../../core/compaction/index.ts'
import { asAttachmentId } from '../../core/attachments/index.ts'
import { EFFECT_RECORDED } from '../../core/effects/index.ts'
import { asCallId } from '../../core/ids.ts'
import { createAssistantMessage, createPluginMessage, createToolResultMessage, createUserMessage } from '../../core/llm/message.ts'
import { AUTHORITY_PRESET } from '../../core/presets/index.ts'
import { SANDBOX_MODE } from '../../core/sandbox/index.ts'
import {
  ASSISTANT_CHUNK,
  ASSISTANT_MESSAGE,
  REQUEST_CONTEXT,
  SESSION_TITLE,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_DISPATCH,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type EventEnvelope,
  type EventKind,
} from '../../core/session/index.ts'
import { transcriptLines } from '../present.ts'
import { describeRow } from './rows.js'

interface Sample {
  /** The constant's NAME as `present.ts` spells it: what the coverage check reads out of the source. */
  readonly constant: string
  readonly label: string
  readonly event: EventEnvelope
}

let seq = 0
function sample<Data>(constant: string, label: string, kind: EventKind<string, Data>, data: Data, surface = false): Sample {
  const event: EventEnvelope = { type: kind.type, seq: seq++, time: 1, data, ...(surface ? { surfaceOp: { op: 'append' as const } } : {}) }
  return { constant, label, event }
}

const usage = { inputTokens: 1200, outputTokens: 80 }
const image = { type: 'image' as const, attachment: { id: asAttachmentId('sha256-ab'), mediaType: 'image/png' as const, bytes: 10, width: 2, height: 2 }, text: '[image: 2x2 png]' }

const SAMPLES: readonly Sample[] = [
  sample('USER_MESSAGE', 'a person', USER_MESSAGE, { message: createUserMessage('fix the slug') }, true),
  sample('USER_MESSAGE', 'plugin context', USER_MESSAGE, { message: createPluginMessage('workspace-instructions', 'AGENTS.md says…', 'instructions') }, true),
  // Context is visible whatever its body holds; only a PERSON's empty message has nothing to show.
  sample('USER_MESSAGE', 'empty plugin context', USER_MESSAGE, { message: createPluginMessage('context-runtime', '') }, true),
  sample('USER_MESSAGE', 'an empty message from a person', USER_MESSAGE, { message: createUserMessage('') }, true),
  sample('ASSISTANT_MESSAGE', 'text', ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([{ type: 'text', text: 'done' }], 'deepseek', 'deepseek-v4-flash'), usage }, true),
  sample('ASSISTANT_MESSAGE', 'tool calls only', ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([{ type: 'tool-call', id: asCallId('c1'), name: 'pwsh', arguments: '{}' }], 'deepseek', 'deepseek-v4-flash') }, true),
  sample('TOOL_CALL', 'call', TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"node --test"}' }),
  sample('TOOL_RESULT', 'ok', TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: '9/9' }], false) }, true),
  sample('TOOL_RESULT', 'error', TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'no' }], true), error: { name: 'ToolError', code: 'FS_SANDBOX_DENIED' } }, true),
  sample('TOOL_RESULT', 'image', TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [image], false) }, true),
  sample('TURN_END', 'completed', TURN_END, { turn: 1, reason: { kind: 'completed' } }),
  sample('TURN_END', 'error', TURN_END, { turn: 1, reason: { kind: 'error', code: 'MISSING_CREDENTIAL', message: 'set DEEPSEEK_API_KEY' } }),
  sample('TURN_END', 'interrupted', TURN_END, { turn: 1, reason: { kind: 'interrupted' } }),
  sample('SANDBOX_MODE', 'stamp', SANDBOX_MODE, { mode: 'workspace-write', enforcement: 'none', reason: 'initial' }),
  sample('APPROVAL_POLICY', 'policy', APPROVAL_POLICY, { policy: 'ask', reason: 'initial' }),
  sample('AGENT_OPTIONS', 'initial', AGENT_OPTIONS, { options: { provider: 'deepseek', model: 'deepseek-v4-flash' }, reason: 'initial' }),
  sample('AGENT_OPTIONS', 'change', AGENT_OPTIONS, { options: { provider: 'anthropic', model: 'claude-sonnet-5', reasoningEffort: 'high' }, reason: 'change' }),
  sample('REQUEST_CONTEXT', 'route', REQUEST_CONTEXT, { provider: 'anthropic', model: 'claude-sonnet-5', contextWindow: 1_000_000 }),
  sample('AUTHORITY_PRESET', 'preset', AUTHORITY_PRESET, { name: 'workspace-write' }),
  sample('APPROVAL_ASKED', 'asked', APPROVAL_ASKED, { id: 'approval-7', toolName: 'pwsh', callId: 'c1', reason: 'run under "danger-full-access": tests' }),
  sample('APPROVAL_ASKED', 'with a subject', APPROVAL_ASKED, {
    id: 'approval-9',
    toolName: 'pwsh',
    callId: 'c2',
    reason: 'run under "danger-full-access": tests',
    subject: { effect: 'shell-command', command: 'pnpm check', mode: 'danger-full-access', enforcement: 'none' },
  }),
  sample('APPROVAL_DECIDED', 'decided', APPROVAL_DECIDED, { id: 'approval-7', outcome: 'allowed-once' }),
  sample('APPROVAL_DECIDED', 'decided by a person', APPROVAL_DECIDED, { id: 'approval-9', outcome: 'allowed-once', decidedBy: 'user' }),
  sample('EFFECT_RECORDED', 'fs write', EFFECT_RECORDED, { callId: 'c1', effect: 'fs-write', path: '/ws/notes.txt', bytes: 15, sha256: 'a1b2c3d4e5f6a7b8c9d0' }),
  sample('EFFECT_RECORDED', 'shell command', EFFECT_RECORDED, { callId: 'c1', effect: 'shell-command', exitCode: 0, durationMs: 1234, mode: 'workspace-write', enforcement: 'full' }),
  sample('EFFECT_RECORDED', 'shell command killed', EFFECT_RECORDED, { callId: 'c1', effect: 'shell-command', durationMs: 120_000, mode: 'read-only', enforcement: 'none', timedOut: true }),
  sample('SUBAGENT_START', 'start', SUBAGENT_START, { callId: 'c2', childId: 's-child', depth: 1, provider: 'deepseek', model: 'deepseek-v4-flash', sandbox: 'read-only', approval: 'never' }),
  sample('SUBAGENT_END', 'end', SUBAGENT_END, { callId: 'c2', childId: 's-child', reason: { kind: 'completed' }, usage }),
  sample('COMPACTION_START', 'start', COMPACTION_START, { trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, plannedStart: 2, plannedEnd: 9, plannedNodes: 6 }),
  sample('COMPACTION_END', 'applied', COMPACTION_END, { startSeq: 3, outcome: { kind: 'applied' } }),
  sample('COMPACTION_END', 'declined', COMPACTION_END, { startSeq: 3, outcome: { kind: 'declined', reason: 'summary-not-smaller' } }),
  sample('COMPACTION_APPLIED', 'applied', COMPACTION_APPLIED, {
    trigger: 'explicit',
    budgetTokens: 1000,
    projectedTokens: 900,
    surfaceTokensBefore: 800,
    surfaceTokensAfter: 200,
    shadowedSeqs: [2, 3, 4],
    retainedNodes: 2,
    auxCallSeq: 11,
    startSeq: 9,
  }),
  // Kinds neither projection renders. Listed so that giving one of them a line
  // in EITHER projection fails here until the other is decided too.
  sample('TURN_START', 'structure', TURN_START, { turn: 1 }),
  sample('STEP_START', 'structure', STEP_START, { turn: 1, step: 1 }),
  sample('STEP_END', 'structure', STEP_END, { turn: 1, step: 1 }),
  // Pure structure, like the two above: the gate-to-body fact is one per tool
  // call and says nothing a reader wants in a transcript. Listed so that giving
  // it a line in EITHER projection fails here until the other is decided too.
  sample('TOOL_DISPATCH', 'structure', TOOL_DISPATCH, { turn: 1, step: 1, callId: 'c1' }),
  sample('ASSISTANT_CHUNK', 'trace', ASSISTANT_CHUNK, { turn: 1, step: 1, attempt: 1, chunk: { type: 'text-delta', index: 0, text: 'd' } }),
  sample('INBOX_SPLICED', 'inbox', INBOX_SPLICED, { op: 'clear' }),
  sample('SESSION_TITLE', 'title', SESSION_TITLE, { title: 'fix the slug', messageSeqs: [2], source: { kind: 'fallback' } }),
]

describe('the browser row projection against the plain-text one', () => {
  it.each(SAMPLES.map((entry) => [`${entry.event.type} (${entry.label})`, entry] as const))('%s is visible in both or in neither', (_name, entry) => {
    const line = transcriptLines([entry.event])[0]
    const row = describeRow(entry.event)
    expect({ kind: entry.event.type, browser: row !== undefined }).toEqual({ kind: entry.event.type, browser: line !== undefined })
    if (row) {
      expect(row.text.length).toBeGreaterThan(0)
      expect(row.cls.startsWith('row ')).toBe(true)
    }
  })

  it('has a sample for every kind present.ts renders and for every case rows.js handles', () => {
    const present = readFileSync(join(import.meta.dirname, '..', 'present.ts'), 'utf8')
    // The WHOLE file, not `describeEvent` alone: `transcriptLine` is the oracle
    // above and has branches of its own, and a kind rendered only there (or only
    // in the audit) would otherwise gain a terminal line with no sample here.
    const rendered = new Set([...present.matchAll(/matches\(event, ([A-Z_]+)\)/g)].map((match) => match[1]!))
    expect(rendered.size).toBeGreaterThan(10) // the regex still finds the branches
    const sampledConstants = new Set(SAMPLES.map((entry) => entry.constant))
    expect([...rendered].filter((constant) => !sampledConstants.has(constant))).toEqual([])

    const rows = readFileSync(join(import.meta.dirname, 'rows.js'), 'utf8')
    const cases = new Set([...rows.matchAll(/case '([^']+)'/g)].map((match) => match[1]!))
    expect(cases.size).toBeGreaterThan(10)
    const sampledTypes = new Set(SAMPLES.map((entry) => entry.event.type))
    expect([...cases].filter((type) => !sampledTypes.has(type))).toEqual([])
  })

  it('shows the consent SUBJECT and the decider in both projections', () => {
    // The kind-level coverage check above cannot catch these: `subject` and
    // `decidedBy` are new fields on kinds that already had a branch and a case,
    // so one projection could render them and the other not, silently.
    const find = (constant: string, label: string): EventEnvelope => SAMPLES.find((entry) => entry.constant === constant && entry.label === label)!.event
    const askedRow = describeRow(find('APPROVAL_ASKED', 'with a subject'))!.text
    const askedLine = transcriptLines([find('APPROVAL_ASKED', 'with a subject')]).join('')
    for (const rendered of [askedRow, askedLine]) {
      expect(rendered).toContain('pnpm check')
      expect(rendered).toContain('danger-full-access')
      // And the model's own words stay, beside the runtime's account.
      expect(rendered).toContain('tests')
    }
    const decidedRow = describeRow(find('APPROVAL_DECIDED', 'decided by a person'))!.text
    const decidedLine = transcriptLines([find('APPROVAL_DECIDED', 'decided by a person')]).join('')
    for (const rendered of [decidedRow, decidedLine]) expect(rendered).toContain('user')
    // An approval nobody decided says nothing about a decider, rather than guessing.
    expect(describeRow(find('APPROVAL_DECIDED', 'decided'))!.text).not.toContain('by ')
  })

  it('says what the plain-text line says where a reader would compare them', () => {
    const find = (constant: string, label: string): EventEnvelope => SAMPLES.find((entry) => entry.constant === constant && entry.label === label)!.event
    // The drift this gate was built on: a step's effective route, shown in every terminal and nowhere in the browser.
    expect(describeRow(find('REQUEST_CONTEXT', 'route'))).toEqual({ cls: 'row note', text: '[route: anthropic/claude-sonnet-5 · window 1000k]' })
    // A delegation names the route the child ran on, as the terminal's line does.
    expect(describeRow(find('SUBAGENT_START', 'start'))?.text).toContain('deepseek/deepseek-v4-flash')
    expect(describeRow(find('TURN_END', 'error'))?.text).toBe('[turn error: MISSING_CREDENTIAL — set DEEPSEEK_API_KEY]')
    expect(describeRow(find('USER_MESSAGE', 'a person'))).toEqual({ cls: 'row user', who: 'you', text: 'fix the slug' })
    expect(describeRow(find('USER_MESSAGE', 'plugin context'))?.text).toBe('context (plugin: instructions)')
    expect(describeRow(find('ASSISTANT_MESSAGE', 'text'))).toEqual({ cls: 'row assistant', who: 'deepseek-v4-flash', text: 'done' })
    expect(describeRow(find('TOOL_RESULT', 'image'))?.text).toBe('✓ [image: 2x2 png]')
  })
})
