/**
 * Context metering: a pure fold, so these tests build real sessions through
 * the real store and assert numbers, never shapes.
 */
import { describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { asCallId } from '../ids.ts'
import { invariantsPlugin } from '../invariants/index.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../llm/message.ts'
import type { TokenUsage } from '../llm/types.ts'
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
  type Sessions,
  type Session,
} from '../session/index.ts'
import { LLM_AUX_CALL } from '../llm/aux-call.ts'
import { estimateMessage, estimateTokens, formatTokens, meterSession } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const header: RequestHeader = { provider: 'p', model: 'm', system: 'a system prompt', tools: [] }

async function newSession(): Promise<{ root: Context; sessions: Sessions; session: Session }> {
  const root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  await root.settle()
  const sessions = root.get(SESSIONS)
  const session = sessions.create({ cwd: '/w' })
  return { root, sessions, session }
}

/** One text turn whose assistant message carries provider usage. */
function textTurn(session: Session, turn: number, prompt: string, reply: string, usage?: TokenUsage): void {
  session.append(TURN_START, { turn })
  session.append(STEP_START, { turn, step: 1 })
  session.append(USER_MESSAGE, { message: createUserMessage(prompt) }, { surfaceOp: { op: 'append' } })
  if (turn === 1) session.append(REQUEST_HEADER, { turn, step: 1, header, reason: 'initial' })
  session.append(
    ASSISTANT_MESSAGE,
    { turn, step: 1, message: createAssistantMessage([{ type: 'text', text: reply }], 'p', 'm'), ...(usage ? { usage } : {}) },
    { surfaceOp: { op: 'append' } },
  )
  session.append(STEP_END, { turn, step: 1 })
  session.append(TURN_END, { turn, reason: { kind: 'completed' } })
}

describe('the token estimator', () => {
  it('counts roughly four characters to a token and never returns a fraction', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('counts reasoning and tool-call blocks, because the provider is sent both back', () => {
    const plain = createAssistantMessage([{ type: 'text', text: 'x'.repeat(40) }], 'p', 'm')
    const withReasoning = createAssistantMessage(
      [
        { type: 'reasoning', text: 'y'.repeat(40) },
        { type: 'text', text: 'x'.repeat(40) },
      ],
      'p',
      'm',
    )
    expect(estimateMessage(withReasoning)).toBe(estimateMessage(plain) + 10)

    const withCall = createAssistantMessage([{ type: 'tool-call', id: asCallId('c1'), name: 'edit', arguments: '{"path":"a.txt"}' }], 'p', 'm')
    expect(estimateMessage(withCall)).toBeGreaterThan(estimateTokens('{"path":"a.txt"}'))
  })
})

describe('metering a session', () => {
  it('reports nothing measurable for a session that has not called the model', async () => {
    const { root, session } = await newSession()
    const metrics = meterSession(session.events, 1000)
    expect(metrics.reportedPrompt).toBe(0)
    expect(metrics.priced).toBe(false)
    expect(metrics.projectedTokens).toBe(0)
    expect(metrics.ratio).toBe(0)
    await root.dispose()
  })

  it('prices the next request from the last reported usage, counting cache reads as prompt', async () => {
    const { root, session } = await newSession()
    // 100 uncached + 900 cached = a 1000-token prompt the provider actually read.
    textTurn(session, 1, 'hello', 'hi', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 })

    const metrics = meterSession(session.events, 10_000)
    expect(metrics.priced).toBe(true)
    expect(metrics.reportedPrompt).toBe(1000)
    expect(metrics.reportedOutput).toBe(20)
    // Nothing was appended after the priced assistant message.
    expect(metrics.projectedTokens).toBe(1020)
    expect(metrics.ratio).toBeCloseTo(0.102)
    await root.dispose()
  })

  it('adds an estimate for every surface node appended since the priced request', async () => {
    const { root, session } = await newSession()
    textTurn(session, 1, 'hello', 'hi', { inputTokens: 1000, outputTokens: 20 })
    const priced = meterSession(session.events, 10_000).projectedTokens

    // A second turn whose assistant message carries NO usage (an interrupted
    // step drops it), so the delta must be estimated rather than read.
    session.append(TURN_START, { turn: 2 })
    session.append(STEP_START, { turn: 2, step: 1 })
    const followup = createUserMessage('x'.repeat(400))
    session.append(USER_MESSAGE, { message: followup }, { surfaceOp: { op: 'append' } })

    const metrics = meterSession(session.events, 10_000)
    expect(metrics.priced).toBe(true)
    expect(metrics.projectedTokens).toBe(priced + estimateMessage(followup))
    await root.dispose()
  })

  it('sums usage across the whole log, keeping cache reads separate from uncached input', async () => {
    const { root, session } = await newSession()
    textTurn(session, 1, 'one', 'a', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 })
    textTurn(session, 2, 'two', 'b', { inputTokens: 20, outputTokens: 7, cacheReadTokens: 200 })

    const metrics = meterSession(session.events, 10_000)
    expect(metrics.sessionInput).toBe(30)
    expect(metrics.sessionOutput).toBe(12)
    expect(metrics.sessionCacheRead).toBe(300)
    // The projection is about the LAST request, not the sum of every one.
    expect(metrics.reportedPrompt).toBe(220)
    await root.dispose()
  })

  /**
   * A compaction summary replays a whole shadowed span — usually the single
   * largest request a session makes. Leaving it out of the cost line would
   * under-report exactly the spending S5 introduced.
   */
  it('counts an out-of-loop call towards the session cost but never towards the next request', async () => {
    const { session } = await newSession()
    textTurn(session, 1, 'hello', 'hi', { inputTokens: 100, outputTokens: 20 })
    const before = meterSession(session.events, 10_000)

    session.append(LLM_AUX_CALL, {
      purpose: 'compaction',
      provider: 'p',
      model: 'm',
      usage: { inputTokens: 4000, outputTokens: 300, cacheReadTokens: 500 },
      outcome: { kind: 'text', text: 'a summary' },
    })

    const after = meterSession(session.events, 10_000)
    expect(after.sessionInput).toBe(before.sessionInput + 4000)
    expect(after.sessionOutput).toBe(before.sessionOutput + 300)
    expect(after.sessionCacheRead).toBe(before.sessionCacheRead + 500)
    // It is not the loop's prompt: the projection must not move.
    expect(after.projectedTokens).toBe(before.projectedTokens)
    expect(after.reportedPrompt).toBe(before.reportedPrompt)
  })

  it('stops trusting the priced prefix once a replace shadows part of it, and re-estimates smaller', async () => {
    const { root, session } = await newSession()
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    const first = session.append(USER_MESSAGE, { message: createUserMessage('q'.repeat(4000)) }, { surfaceOp: { op: 'append' } })
    session.append(REQUEST_HEADER, { turn: 1, step: 1, header, reason: 'initial' })
    const reply = session.append(
      ASSISTANT_MESSAGE,
      { turn: 1, step: 1, message: createAssistantMessage([{ type: 'text', text: 'r'.repeat(4000) }], 'p', 'm'), usage: { inputTokens: 5000, outputTokens: 1000 } },
      { surfaceOp: { op: 'append' } },
    )

    const before = meterSession(session.events, 10_000)
    expect(before.priced).toBe(true)
    expect(before.projectedTokens).toBe(6000)

    // Compaction: one short summary replaces both nodes.
    session.append(
      USER_MESSAGE,
      { message: createUserMessage('summary') },
      { surfaceOp: { op: 'replace', start: first.seq, end: reply.seq }, sourceEventSeqs: [first.seq, reply.seq] },
    )

    const after = meterSession(session.events, 10_000)
    expect(after.priced).toBe(false)
    // The provider's 5000-token bill describes history that is no longer sent.
    expect(after.projectedTokens).toBeLessThan(before.projectedTokens / 10)
    // The system prompt is still part of every request, so it is still counted.
    expect(after.projectedTokens).toBeGreaterThanOrEqual(estimateTokens(header.system))
    // The log kept everything; only the surface shrank.
    expect(session.events.length).toBeGreaterThan(session.surfaceSeqs().length)
    await root.dispose()
  })

  it('meters a tool result the same way the model sees it', async () => {
    const { root, session } = await newSession()
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    session.append(USER_MESSAGE, { message: createUserMessage('go') }, { surfaceOp: { op: 'append' } })
    session.append(REQUEST_HEADER, { turn: 1, step: 1, header, reason: 'initial' })
    session.append(
      ASSISTANT_MESSAGE,
      { turn: 1, step: 1, message: createAssistantMessage([{ type: 'tool-call', id: asCallId('c1'), name: 'shell', arguments: '{}' }], 'p', 'm'), usage: { inputTokens: 100, outputTokens: 10 } },
      { surfaceOp: { op: 'append' } },
    )
    const call = session.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'shell', arguments: '{}' })
    const result = createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'o'.repeat(2000) }], false)
    session.append(TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: result }, { surfaceOp: { op: 'append' }, sourceEventSeqs: [call.seq] })

    const metrics = meterSession(session.events, 10_000)
    expect(metrics.projectedTokens).toBe(110 + estimateMessage(result))
    expect(metrics.projectedTokens).toBeGreaterThan(500)
    await root.dispose()
  })
})

describe('formatTokens', () => {
  it('reads at a glance', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(10_000)).toBe('10k')
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(1_000_000)).toBe('1000k')
  })
})
