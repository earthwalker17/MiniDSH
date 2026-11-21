/**
 * The conversation model held to its four promises (`conversation.js`):
 *
 * - the live path (`step` over facts AND trace) lands where the cold fold does
 *   once the stream is quiet;
 * - an older page prepended at ANY message boundary lands where one fold of
 *   the whole window does — items and compaction brackets the newer page had
 *   to show early move to where their creating event is;
 * - every join is by an id the log records, and a late fact (a job's end, a
 *   subagent closed by repair) updates the card it names, wherever it is;
 * - and the real logs MiniDSH has written since 1.0.0 fold without a throw,
 *   every visible event placed exactly once.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { asCallId } from '../../core/ids.ts'
import { createAssistantMessage, createPluginMessage, createToolResultMessage, createUserMessage } from '../../core/llm/message.ts'
import type { ContentBlock } from '../../core/llm/types.ts'
import type { EventEnvelope, SurfaceOp } from '../../core/session/index.ts'
import { createConversation, fold, placements, prepend, shapeOf, step, type Op } from './conversation.js'
import { describeRow } from './rows.js'

/** A session log written the way the driver writes one, seq by seq. */
function log() {
  const events: EventEnvelope[] = []
  let time = 1_000
  const add = (type: string, data: unknown, surface?: 'append' | 'replace'): EventEnvelope => {
    // A replace names the range it shadows; this one, two early messages.
    const op: SurfaceOp | undefined = surface === 'append' ? { op: 'append' } : surface === 'replace' ? { op: 'replace', start: 8, end: 12 } : undefined
    const event: EventEnvelope = { type, seq: events.length, time: (time += 100), data, ...(op ? { surfaceOp: op } : {}) }
    events.push(event)
    return event
  }
  return { events, add }
}

const assistant = (content: ContentBlock[]) => createAssistantMessage(content, 'deepseek', 'deepseek-v4-flash')
const call = (id: string, name: string, args: unknown): ContentBlock => ({ type: 'tool-call', id: asCallId(id), name, arguments: JSON.stringify(args) })
const chunk = (text: string, type = 'text-delta') => ({ type, index: 0, text })

/**
 * Three turns and the gaps between them: an opening, thoughts, a reply with
 * two calls (one asked, decided, recorded), a delegation, a job that ends
 * after its turn, a compaction between turns whose summary replaces history,
 * an authority switch, a model switch and a failed turn — the trace streamed
 * before each assistant message, as a live host sends it.
 */
function richSession(): EventEnvelope[] {
  const { events, add } = log()
  add('session/lifecycle', { origin: 'new', dispatch: true, durability: 'synced' })
  add('agent/options', { options: { provider: 'deepseek', model: 'deepseek-v4-flash' }, reason: 'initial' })
  add('approval/policy', { policy: 'ask', reason: 'initial' })
  add('sandbox/mode', { mode: 'workspace-write', enforcement: 'none', reason: 'initial' })
  // Turn 1.
  add('turn/start', { turn: 1 })
  add('request/context', { provider: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 1_000_000 })
  add('step/start', { turn: 1, step: 1 })
  add('user/message', { message: createPluginMessage('workspace-instructions', 'AGENTS.md: use pnpm', 'instructions') }, 'append')
  add('user/message', { message: createUserMessage('fix the failing test') }, 'append')
  add('assistant/chunk', { turn: 1, step: 1, attempt: 1, chunk: chunk('let me look', 'reasoning-delta') })
  add('assistant/chunk', { turn: 1, step: 1, attempt: 1, chunk: chunk('Running') })
  add('assistant/chunk', { turn: 1, step: 1, attempt: 2, chunk: chunk('Running the tests') })
  add('assistant/message', {
    turn: 1,
    step: 1,
    message: assistant([{ type: 'reasoning', text: 'let me look' }, { type: 'text', text: 'Running the tests.' }, call('c1', 'pwsh', { command: 'pnpm test' }), call('c2', 'str_replace_editor', { command: 'str_replace', path: 'src/a.ts', old_str: 'a', new_str: 'b' })]),
  }, 'append')
  add('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"pnpm test"}' })
  add('approval/asked', { id: 'approval-1', toolName: 'pwsh', callId: 'c1', subject: { effect: 'shell-command', command: 'pnpm test', mode: 'danger-full-access', enforcement: 'none' } })
  add('approval/decided', { id: 'approval-1', outcome: 'allowed-once', decidedBy: 'user' })
  add('tool/dispatch', { turn: 1, step: 1, callId: 'c1' })
  add('effect/recorded', { callId: 'c1', effect: 'shell-command', exitCode: 1, durationMs: 900, mode: 'danger-full-access', enforcement: 'none' })
  add('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'str_replace_editor', arguments: '{"command":"str_replace","path":"src/a.ts","old_str":"a","new_str":"b"}' })
  add('tool/dispatch', { turn: 1, step: 1, callId: 'c2' })
  add('effect/recorded', { callId: 'c2', effect: 'fs-write', path: '/ws/src/a.ts', bytes: 1, sha256: 'ffeeddccbbaa99' })
  add('tool/result', { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: '1 failing\n[exit code: 1]' }], true) }, 'append')
  add('tool/result', { turn: 1, step: 1, callId: 'c2', message: createToolResultMessage(asCallId('c2'), [{ type: 'text', text: 'edited' }], false) }, 'append')
  add('step/end', { turn: 1, step: 1 })
  add('step/start', { turn: 1, step: 2 })
  add('request/context', { provider: 'anthropic', model: 'claude-sonnet-5', contextWindow: 200_000 })
  add('assistant/chunk', { turn: 1, step: 2, attempt: 1, chunk: chunk('Fixed.') })
  add('assistant/message', { turn: 1, step: 2, message: assistant([{ type: 'text', text: 'Fixed.' }]) }, 'append')
  add('step/end', { turn: 1, step: 2 })
  add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Between turns: a person's switch, a grant, a compaction.
  add('sandbox/mode', { mode: 'read-only', enforcement: 'none', reason: 'change' })
  add('compaction/start', { trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, plannedStart: 2, plannedEnd: 20, plannedNodes: 6 })
  const start = events.at(-1)!.seq
  add('compaction/applied', { trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, surfaceTokensBefore: 800, surfaceTokensAfter: 200, shadowedSeqs: [8, 12], retainedNodes: 2, auxCallSeq: 30, startSeq: start })
  add('user/message', { message: createPluginMessage('compaction-basic', 'Summary: the test was fixed.', 'summary') }, 'replace')
  add('compaction/end', { startSeq: start, outcome: { kind: 'applied' } })
  // Turn 2: a delegation and a job.
  add('turn/start', { turn: 2 })
  add('step/start', { turn: 2, step: 1 })
  add('user/message', { message: createUserMessage('review it and start the dev server') }, 'append')
  add('assistant/message', { turn: 2, step: 1, message: assistant([call('c3', 'subagent', { description: 'Review the fix', prompt: 'Review src/a.ts' }), call('c4', 'job_start', { command: 'pnpm dev' })]) }, 'append')
  add('tool/call', { turn: 2, step: 1, callId: 'c3', name: 'subagent', arguments: '{"description":"Review the fix","prompt":"Review src/a.ts"}' })
  add('tool/dispatch', { turn: 2, step: 1, callId: 'c3' })
  add('subagent/start', { callId: 'c3', childId: 'session-child', depth: 1, provider: 'deepseek', model: 'deepseek-v4-flash', sandbox: 'read-only', approval: 'never' })
  add('tool/call', { turn: 2, step: 1, callId: 'c4', name: 'job_start', arguments: '{"command":"pnpm dev"}' })
  add('tool/dispatch', { turn: 2, step: 1, callId: 'c4' })
  add('job/start', { jobId: 'job-1', callId: 'c4', kind: 'shell', label: 'pnpm dev', pid: 7, mode: 'read-only', enforcement: 'none' })
  add('subagent/end', { callId: 'c3', childId: 'session-child', reason: { kind: 'completed' } })
  add('tool/result', { turn: 2, step: 1, callId: 'c3', message: createToolResultMessage(asCallId('c3'), [{ type: 'text', text: 'Looks right.' }], false) }, 'append')
  add('tool/result', { turn: 2, step: 1, callId: 'c4', message: createToolResultMessage(asCallId('c4'), [{ type: 'text', text: 'started job-1' }], false) }, 'append')
  add('step/end', { turn: 2, step: 1 })
  add('step/start', { turn: 2, step: 2 })
  add('assistant/message', { turn: 2, step: 2, message: assistant([{ type: 'text', text: 'Reviewed; the server runs.' }]) }, 'append')
  add('step/end', { turn: 2, step: 2 })
  add('turn/end', { turn: 2, reason: { kind: 'completed' } })
  // The job ends while the session is idle; a person changes the model.
  add('job/end', { jobId: 'job-1', cause: 'exited', exitCode: 0, durationMs: 4000 })
  add('agent/options', { options: { provider: 'anthropic', model: 'claude-sonnet-5' }, reason: 'change' })
  // Turn 3 fails.
  add('turn/start', { turn: 3 })
  add('step/start', { turn: 3, step: 1 })
  add('user/message', { message: createPluginMessage('tool-jobs', 'job-1 exited with code 0', 'job-notice') }, 'append')
  add('user/message', { message: createUserMessage('and now?') }, 'append')
  add('turn/end', { turn: 3, reason: { kind: 'error', code: 'MISSING_CREDENTIAL', message: 'set ANTHROPIC_API_KEY' } })
  return events
}

const facts = (events: readonly EventEnvelope[]) => events.filter((event) => event.type !== 'assistant/chunk')
/** Where `session/page` may start a page: a surface message (`core/session/page.ts`). */
const messageBoundary = (event: EventEnvelope) => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'

describe('the conversation model', () => {
  it('folds a rich session into the blocks a reader expects', () => {
    const model = fold(facts(richSession()))
    expect(model.blocks.map((block) => block.kind)).toEqual([
      'opening',
      'note', // the route the first step ran on
      'context', // AGENTS.md
      'bubble',
      'process', // the thought
      'reply', // "Running the tests."
      'process', // c1 + c2
      'system', // the decision stays in sight
      'note', // the route changed for step 2
      'reply',
      'tail',
      'system', // sandbox switch
      'compaction',
      'context', // the summary that replaced history
      'bubble',
      'process', // c3 + c4
      'reply',
      'tail',
      'system', // model switch (the job's end joined its card)
      'context', // job notice
      'bubble',
      'tail', // the failure
    ])
    const c1 = model.items.get('c1')!
    expect(c1.asked).toEqual(['approval-1'])
    expect(c1.effects.map((effect) => effect.effect)).toEqual(['shell-command'])
    expect(c1.result?.isError).toBe(true)
    expect(model.decided.get('approval-1')?.decidedBy).toBe('user')
    expect(model.items.get('c3')?.subagent?.end?.reason).toEqual({ kind: 'completed' })
    expect(model.items.get('c4')?.job?.end?.exitCode).toBe(0)
    const opening = model.blocks[0]
    expect(opening?.kind === 'opening' && opening.rows.map((entry) => entry.type)).toEqual(['approval/policy', 'sandbox/mode'])
  })

  it('places every visible event exactly once, and authority and failure never inside a group', () => {
    const events = facts(richSession())
    const where = placements(fold(events))
    for (const event of events) {
      expect({ seq: event.seq, type: event.type, placed: where.has(event.seq) }).toEqual({ seq: event.seq, type: event.type, placed: describeRow(event) !== undefined })
    }
    for (const event of events) {
      const placed = where.get(event.seq)
      if (placed && ['approval/decided', 'sandbox/mode', 'agent/options', 'turn/end', 'user/message', 'assistant/message'].includes(event.type)) expect(placed.inGroup, event.type).toBe(false)
    }
  })

  it('lands the live path (facts and trace, step by step) where the cold fold lands', () => {
    const events = richSession()
    const live = createConversation()
    const seen: Op[] = []
    for (const event of events) seen.push(...step(live, event))
    expect(shapeOf(live)).toEqual(shapeOf(fold(facts(events))))
    expect(live.live).toBeUndefined()
    // The retried attempt replaced the abandoned one's text instead of appending to it.
    const previews = seen.filter((op): op is Extract<Op, { op: 'live' }> => op.op === 'live').map((op) => op.live.text)
    expect(previews).toContain('Running the tests')
    expect(previews).not.toContain('RunningRunning the tests')
  })

  it('only ever appends, adds or updates on the live path', () => {
    const live = createConversation()
    for (const event of richSession()) {
      for (const op of step(live, event)) expect(['append', 'update', 'live', 'live-clear']).toContain(op.op)
    }
  })

  it('a late fact updates the card it names, wherever that card is', () => {
    const events = facts(richSession())
    const end = events.findIndex((event) => event.type === 'job/end')
    const model = fold(events.slice(0, end))
    const group = model.items.get('c4')!.groupKey
    const ops = step(model, events[end]!)
    expect(ops).toEqual([{ op: 'update', key: group, item: 'call:c4' }])
    // And it went to the card, not to a line of its own.
    expect(model.blocks.at(-1)?.kind).toBe('tail')
  })

  it('a prepended older page at ANY message boundary lands where one fold of the whole window does', () => {
    const events = facts(richSession())
    const whole = shapeOf(fold(events))
    let boundaries = 0
    for (let split = 1; split < events.length; split++) {
      if (!messageBoundary(events[split]!)) continue
      boundaries++
      const model = fold(events.slice(split))
      prepend(model, events.slice(0, split))
      expect(shapeOf(model), `split at seq ${events[split]!.seq} (${events[split]!.type})`).toEqual(whole)
    }
    expect(boundaries).toBeGreaterThan(10)
  })

  it('pages back more than once and still agrees with one fold', () => {
    const events = facts(richSession())
    const cuts = events.map((event, index) => (messageBoundary(event) ? index : -1)).filter((index) => index > 0)
    const model = fold(events.slice(cuts.at(-1)!))
    let upper = cuts.at(-1)!
    for (const cut of cuts.slice(0, -1).toReversed()) {
      prepend(model, events.slice(cut, upper))
      upper = cut
    }
    prepend(model, events.slice(0, upper))
    expect(shapeOf(model)).toEqual(shapeOf(fold(events)))
  })

  it('a result whose call is on an older page shows at once, and its card moves to the call when that page loads', () => {
    const events = facts(richSession())
    const result = events.findIndex((event) => event.type === 'tool/result' && (event.data as { callId: string }).callId === 'c1')
    const model = fold(events.slice(result))
    const early = model.items.get('c1')!
    expect(early.name).toBeUndefined()
    expect(early.result?.isError).toBe(true)
    const ops = prepend(model, events.slice(0, result))
    expect(model.items.get('c1')).toBe(early)
    expect(early.name).toBe('pwsh')
    expect(ops[0]?.op).toBe('prepend')
    // Every op after the prepend names a block the model still holds, or one it removed.
    for (const op of ops.slice(1)) if (op.op === 'update') expect(model.blocksByKey.has(op.key), op.key).toBe(true)
  })

  it('marks where a fork began, between what it inherited and its own first event', () => {
    const events = facts(richSession())
    const turnTwo = events.findIndex((event) => event.type === 'turn/start' && (event.data as { turn: number }).turn === 2)
    const seedLength = events[turnTwo]!.seq
    const model = fold(events, { seedLength })
    const fork = model.blocks.findIndex((block) => block.kind === 'fork')
    expect(fork).toBeGreaterThan(0)
    expect(model.blocks[fork + 1]?.kind).toBe('bubble')
    // Paged: the marker appears once, when the inherited half loads.
    const paged = fold(events.slice(turnTwo + 2), { seedLength })
    expect(paged.blocks.some((block) => block.kind === 'fork')).toBe(false)
    prepend(paged, events.slice(0, turnTwo + 2))
    expect(paged.blocks.filter((block) => block.kind === 'fork')).toHaveLength(1)
    expect(shapeOf(paged)).toEqual(shapeOf(model))
    // And the window's own live path after that prepend draws no second
    // marker (S22 review: the head's marker was not carried over).
    const live = fold(events.slice(turnTwo + 2, -3), { seedLength })
    prepend(live, events.slice(0, turnTwo + 2))
    for (const event of events.slice(-3)) step(live, event)
    expect(live.blocks.filter((block) => block.kind === 'fork')).toHaveLength(1)
    expect(shapeOf(live)).toEqual(shapeOf(model))
  })

  it('a resumed lifecycle opens again', () => {
    const events = facts(richSession())
    const { add } = log()
    void add
    const more: EventEnvelope[] = [
      { type: 'session/lifecycle', seq: events.length, time: 9_000, data: { origin: 'resumed' } },
      { type: 'sandbox/mode', seq: events.length + 1, time: 9_001, data: { mode: 'read-only', enforcement: 'full', reason: 'resume' } },
    ]
    const model = fold([...events, ...more])
    const last = model.blocks.at(-1)
    expect(last?.kind).toBe('opening')
    expect(last?.kind === 'opening' && last.resumed).toBe(true)
  })

  it('folds every real log MiniDSH has written, placing each visible event once', () => {
    // Read from the directory, so a release's recorded logs cannot be left out
    // of this list (the two the published 1.2.0 wrote were, and those are the
    // sessions a 2.0.0 browser opens); named below, so one going missing fails.
    const names = readdirSync(fileURLToPath(new URL('../../test-support/fixtures/sessions/', import.meta.url))).filter((name) => name.endsWith('.jsonl'))
    expect(names.toSorted()).toEqual(expect.arrayContaining(['minidsh-1.0.0.jsonl', 'minidsh-1.2.0-child.jsonl', 'minidsh-1.2.0.jsonl', 'minidsh-s16.jsonl', 'minidsh-s22-web.jsonl']))
    for (const name of names) {
      const lines = readFileSync(fileURLToPath(new URL(`../../test-support/fixtures/sessions/${name}`, import.meta.url)), 'utf8').trimEnd().split('\n')
      const events = lines.slice(1).map((line) => JSON.parse(line) as EventEnvelope)
      const live = createConversation()
      for (const event of events) step(live, event)
      const cold = fold(facts(events))
      expect(shapeOf(live), name).toEqual(shapeOf(cold))
      const where = placements(cold)
      for (const event of facts(events)) expect({ name, seq: event.seq, placed: where.has(event.seq) }).toEqual({ name, seq: event.seq, placed: describeRow(event) !== undefined })
      expect(cold.items.size, name).toBeGreaterThan(0)
    }
  })

  it('joins what S22\'s live browser session did, each to the call that did it', () => {
    // Recorded through `minidsh web` in real Chrome against DeepSeek (2026-11-19): the paths
    // rewritten to neutral ones and the trace tier (`assistant/chunk`) dropped, so seqs have gaps.
    const lines = readFileSync(fileURLToPath(new URL('../../test-support/fixtures/sessions/minidsh-s22-web.jsonl', import.meta.url)), 'utf8').trimEnd().split('\n')
    const model = fold(lines.slice(1).map((line) => JSON.parse(line) as EventEnvelope))
    const items = [...model.items.values()]
    // The approval a person answered in the page: asked on its call, decided by the user, top-level.
    const decided = model.blocks.filter((block) => block.kind === 'system' && block.type === 'approval/decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]?.kind === 'system' && decided[0].data.decidedBy).toBe('user')
    // The delegation: started and ended on the one call, the child named.
    const delegated = items.filter((item) => item.subagent?.start !== undefined)
    expect(delegated).toHaveLength(1)
    expect(delegated[0]?.subagent?.end).toBeDefined()
    // The job a person stopped from the panel: its end joined to the call that started it.
    const job = items.find((item) => item.job?.start !== undefined)
    expect(job?.job?.end).toMatchObject({ cause: 'cancelled', by: 'user' })
    // The effort and acceptance switches made from the chips: top-level, never inside a turn's work.
    const switches = model.blocks.filter((block) => block.kind === 'system').map((block) => (block.kind === 'system' ? block.type : ''))
    expect(switches).toEqual(expect.arrayContaining(['agent/options', 'sandbox/acceptance']))
  })
})
