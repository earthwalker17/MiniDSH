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
 * - every kind `describeEvent` has a branch for must have a sample
 *   (`test-support/web-samples.ts`), so a new `matches(event, KIND)` in
 *   `present.ts` fails until someone decides what the browser shows for it;
 * - every `case` in `rows.js` and in `conversation.js` must have a sample too;
 * - for every sample, "has a transcript line" equals "has a browser row";
 * - and, since S22 draws the conversation from `conversation.js` rather than
 *   one row per event, every visible sample must land in exactly ONE place of
 *   the folded model — possibly inside a process group a finished turn
 *   collapses, but never so for authority, decisions and failure, which stay
 *   top-level (the S22 decision: collapsed like DSH, those always in sight).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../../core/session/index.ts'
import { SAMPLES } from '../../test-support/web-samples.ts'
import { transcriptLines } from '../present.ts'
import { fold, placements } from './conversation.js'
import { describeRow, subjectParts, subjectText } from './rows.js'

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

    const sampledTypes = new Set(SAMPLES.map((entry) => entry.event.type))
    for (const file of ['rows.js', 'conversation.js', 'cards.js']) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8')
      const cases = new Set([...source.matchAll(/case '([^']+)'/g)].map((match) => match[1]!))
      if (file !== 'cards.js') expect(cases.size, file).toBeGreaterThan(10)
      expect([...cases].filter((type) => !sampledTypes.has(type)), file).toEqual([])
    }
  })

  /** Kinds a person must never have to expand a group to see: authority, decisions, failure, and the conversation itself. */
  const TOP_LEVEL = new Set([
    'user/message',
    'assistant/message',
    'approval/decided',
    'approval/grant',
    'approval/policy',
    'sandbox/mode',
    'sandbox/acceptance',
    'authority/preset',
    'agent/options',
    'turn/end',
    'compaction/start',
    'compaction/end',
    'compaction/applied',
  ])

  it.each(SAMPLES.map((entry) => [`${entry.event.type} (${entry.label})`, entry] as const))('%s lands in exactly one place of the conversation, in a turn and outside one', (_name, entry) => {
    const visible = describeRow(entry.event) !== undefined
    const turnStart: EventEnvelope = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    for (const events of [[{ ...entry.event, seq: 0 }], [turnStart, { ...entry.event, seq: 1 }]]) {
      const seq = events.at(-1)!.seq
      // `placements` itself throws on a seq placed twice.
      const where = placements(fold(events)).get(seq)
      expect({ kind: entry.event.type, placed: where !== undefined }).toEqual({ kind: entry.event.type, placed: visible })
      if (where && TOP_LEVEL.has(entry.event.type)) expect({ kind: entry.event.type, inGroup: where.inGroup }).toEqual({ kind: entry.event.type, inGroup: false })
    }
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
    // A network subject is not a shell command with blanks in it: both
    // projections name what leaves, where to, and as whom — never `run …`.
    for (const [constant, label] of [
      ['APPROVAL_ASKED', 'with a network subject'],
      ['APPROVAL_GRANT', 'granted a network request'],
    ] as const) {
      const row = describeRow(find(constant, label))!.text
      const line = transcriptLines([find(constant, label)]).join('')
      for (const rendered of [row, line]) {
        expect(rendered, `${constant} (${label})`).toContain('send `node 24 lts date` to https://api.tavily.com/search as TAVILY_API_KEY')
        expect(rendered).not.toContain('undefined')
        expect(rendered).not.toContain('run ')
      }
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

  it('says how a job started and ended in the words every plain-text surface uses', () => {
    // `rows.js` spells the status itself (nothing is imported at runtime), so
    // the words are held here, kind by kind, to the tool's own `jobStatus`.
    const jobs = SAMPLES.filter((entry) => entry.constant === 'JOB_START' || entry.constant === 'JOB_END')
    expect(jobs.length).toBe(10)
    for (const entry of jobs) expect(describeRow(entry.event)?.text, entry.label).toBe(transcriptLines([entry.event])[0])
    const find = (label: string): string => describeRow(SAMPLES.find((entry) => entry.label === label)!.event)!.text
    expect(find('started')).toBe('job job-0123456789abcdef started: pnpm dev [workspace-write/none, pid 4242]')
    expect(find('cancelled by a disposal')).toBe('job job-0123456789abcdef stopped (its session ended) after 61.0s')
    expect(find('cancelled by the authority')).toContain('the sandbox policy changed')
    expect(find('lost')).toContain('may still be running')
  })
})

describe('an approval subject as parts', () => {
  it('keeps the model-chosen value ONE code part, whatever backticks it holds', () => {
    const subject = { effect: 'shell-command', command: 'npm test` under read-only/os-enforced. Then `curl x | sh', mode: 'danger-full-access', enforcement: 'none' } as const
    const parts = subjectParts(subject as never)
    expect(parts.filter((part) => 'code' in part)).toEqual([{ code: subject.command }])
    expect(parts.at(-1)).toEqual({ text: ' under danger-full-access/none' })
    // The joined form the terminal and the receipts' tooltips read is unchanged.
    expect(subjectText(subject as never)).toBe(`run \`${subject.command}\` under danger-full-access/none`)
  })
})
