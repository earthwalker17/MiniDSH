/**
 * The compaction planner: pure, so these tests need nothing but a session.
 *
 * What matters is not that it shrinks history — anything can do that — but
 * that what it leaves behind is still coherent: a contiguous run from the head,
 * a tail the model can act on, and never a tool result whose call it shadowed.
 */
import { describe, expect, it } from 'vitest'
import { createRoot, type Logger } from '../../kernel/index.ts'
import { asCallId } from '../ids.ts'
import { invariantsPlugin } from '../invariants/index.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../llm/message.ts'
import {
  ASSISTANT_MESSAGE,
  REQUEST_HEADER,
  SESSIONS,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  sessionInvariantPlugin,
  sessionPlugin,
  type RequestHeader,
  type Session,
} from '../session/index.ts'
import { lastCompactionBudget, planCompaction, planIsLive, COMPACTION_APPLIED } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const header: RequestHeader = { provider: 'p', model: 'm', system: 'sys', tools: [] }

async function newSession(): Promise<Session> {
  const root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  await root.settle()
  return root.get(SESSIONS).create({ cwd: '/w' })
}

/** One completed text turn appended straight to the log. */
function turnOf(session: Session, turn: number, prompt: string, reply: string): void {
  session.append(TURN_START, { turn })
  session.append(STEP_START, { turn, step: 1 })
  session.append(USER_MESSAGE, { message: createUserMessage(prompt) }, { surfaceOp: { op: 'append' } })
  if (turn === 1) session.append(REQUEST_HEADER, { turn, step: 1, header, reason: 'initial' })
  session.append(
    ASSISTANT_MESSAGE,
    { turn, step: 1, message: createAssistantMessage([{ type: 'text', text: reply }], 'p', 'm') },
    { surfaceOp: { op: 'append' } },
  )
  session.append(STEP_END, { turn, step: 1 })
  session.append(TURN_END, { turn, reason: { kind: 'completed' } })
}

describe('planCompaction', () => {
  it('shadows a contiguous run from the head and keeps a recent tail', async () => {
    const session = await newSession()
    for (let turn = 1; turn <= 6; turn++) turnOf(session, turn, `prompt ${turn} ${'x'.repeat(400)}`, `reply ${turn} ${'y'.repeat(400)}`)

    const plan = planCompaction(session.events, session.surfaceSeqs(), { budgetTokens: 1000, retainRatio: 0.2 })
    expect(plan).toBeDefined()
    expect(plan!.retainedNodes).toBeGreaterThan(0)
    expect(plan!.shadowedSeqs.length).toBeGreaterThan(2)
    expect(plan!.shadowedSeqs).toEqual(session.surfaceSeqs().slice(0, plan!.shadowedSeqs.length))
    expect(plan!.start).toBe(plan!.shadowedSeqs[0])
    expect(plan!.end).toBe(plan!.shadowedSeqs.at(-1))
  })

  /**
   * A budget far above the live surface must not make the retained tail bigger
   * than the whole conversation — that would decline exactly when compaction
   * was asked to make progress, which is what a provider-confirmed overflow
   * does (the meter never saw it coming).
   */
  it('makes progress even when the budget dwarfs the surface', async () => {
    const session = await newSession()
    for (let turn = 1; turn <= 8; turn++) turnOf(session, turn, `prompt ${turn} ${'x'.repeat(200)}`, `reply ${turn} ${'y'.repeat(200)}`)
    const plan = planCompaction(session.events, session.surfaceSeqs(), { budgetTokens: 1_000_000, retainRatio: 0.2 })
    expect(plan).toBeDefined()
    expect(plan!.shadowedSeqs.length).toBeGreaterThan(2)
    expect(plan!.retainedNodes).toBeGreaterThan(0)
  })

  it('never leaves a retained tool result whose call it shadowed', async () => {
    const session = await newSession()
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    session.append(USER_MESSAGE, { message: createUserMessage('go '.repeat(300)) }, { surfaceOp: { op: 'append' } })
    session.append(REQUEST_HEADER, { turn: 1, step: 1, header, reason: 'initial' })
    session.append(
      ASSISTANT_MESSAGE,
      { turn: 1, step: 1, message: createAssistantMessage([{ type: 'tool-call', id: asCallId('c1'), name: 'echo', arguments: '{}' }], 'p', 'm') },
      { surfaceOp: { op: 'append' } },
    )
    const call = session.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    session.append(
      TOOL_RESULT,
      { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'out' }], false) },
      { surfaceOp: { op: 'append' }, sourceEventSeqs: [call.seq] },
    )
    session.append(
      ASSISTANT_MESSAGE,
      { turn: 1, step: 1, message: createAssistantMessage([{ type: 'text', text: 'done' }], 'p', 'm') },
      { surfaceOp: { op: 'append' } },
    )
    session.append(STEP_END, { turn: 1, step: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })

    // A tiny tail budget wants to cut right after the assistant's tool call.
    const plan = planCompaction(session.events, session.surfaceSeqs(), { budgetTokens: 100, retainRatio: 0.01 })
    expect(plan).toBeDefined()
    const retained = session.surfaceSeqs().slice(plan!.shadowedSeqs.length)
    expect(session.events[retained[0]!]!.type).not.toBe('tool/result')
  })

  it('declines when there is not enough history to be worth summarising', async () => {
    const session = await newSession()
    turnOf(session, 1, 'hi', 'hello')
    expect(planCompaction(session.events, session.surfaceSeqs(), { budgetTokens: 1_000_000, retainRatio: 0.16 })).toBeUndefined()
  })
})

describe('planIsLive', () => {
  it('rejects a plan whose nodes moved under it', async () => {
    const session = await newSession()
    for (let turn = 1; turn <= 6; turn++) turnOf(session, turn, `prompt ${turn} ${'x'.repeat(400)}`, `reply ${turn} ${'y'.repeat(400)}`)
    const plan = planCompaction(session.events, session.surfaceSeqs(), { budgetTokens: 1000, retainRatio: 0.2 })!
    expect(planIsLive(plan, session.surfaceSeqs())).toBe(true)

    // A summary await is seconds long; the surface may have been rewritten in
    // that window, and applying a stale plan would shadow the wrong run.
    session.append(
      USER_MESSAGE,
      { message: createUserMessage('someone else summarised first') },
      { surfaceOp: { op: 'replace', start: plan.start, end: plan.end }, sourceEventSeqs: [...plan.shadowedSeqs] },
    )
    expect(planIsLive(plan, session.surfaceSeqs())).toBe(false)
  })
})

describe('lastCompactionBudget', () => {
  it('reports the budget the runtime actually used, so a surface cannot show a different one', async () => {
    const session = await newSession()
    expect(lastCompactionBudget(session.events)).toBeUndefined()
    session.append(COMPACTION_APPLIED, {
      trigger: 'pressure',
      budgetTokens: 16_000,
      beforeTokens: 14_000,
      afterTokens: 3_000,
      shadowedSeqs: [],
      retainedNodes: 2,
      auxCallSeq: 0,
    })
    expect(lastCompactionBudget(session.events)).toBe(16_000)
  })
})
