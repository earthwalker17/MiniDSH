/**
 * Bounded recall over a real composition, with the invariants on.
 *
 * History is built by driving REAL turns, for the reason `compaction-basic`'s
 * loop test gives: a hand-appended log desynchronises the driver, and a recall
 * that only ever read fabricated history would prove nothing about the seqs a
 * compaction actually names.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { AGENTS, agentPlugin, type Agent, type AgentHandle } from '../../core/agent/index.ts'
import { agentInvariantPlugin } from '../../core/agent/invariant.ts'
import { approvalPlugin } from '../../core/approval/index.ts'
import { COMPACTION, COMPACTION_APPLIED } from '../../core/compaction/index.ts'
import { invariantsPlugin } from '../../core/invariants/index.ts'
import { LLM, llmPlugin } from '../../core/llm/index.ts'
import { createUserMessage, messageText } from '../../core/llm/message.ts'
import { loopInvariantPlugin, loopPlugin } from '../../core/loop/index.ts'
import { PROMPT, promptPlugin } from '../../core/prompt/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../../core/sandbox/invariant.ts'
import { matches, sessionInvariantPlugin, sessionPlugin, TOOL_RESULT, type EventEnvelope } from '../../core/session/index.ts'
import { defineTool, TOOLS, toolsPlugin } from '../../core/tools/index.ts'
import { z } from 'zod'
import { assistantText, assistantToolCall, ScriptedAdapter, type ScriptedResponse } from '../../test-support/scripted-adapter.ts'
import type { StreamChunk } from '../../core/llm/types.ts'
import { compactionBasicPlugin, type CompactionBasicConfig } from '../compaction-basic/index.ts'
import { foldRecall, toolHistoryPlugin, type ToolHistoryConfig } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

interface Harness {
  root: Context
  adapter: ScriptedAdapter
  /** The next loop answers, ahead of the bulk responder (which is armed for the whole test). */
  next(...responses: StreamChunk[][]): void
  create(): Promise<AgentHandle>
  fork(source: Agent): Promise<AgentHandle>
  dispose(): Promise<void>
}

const open: Harness[] = []
afterEach(async () => {
  for (const mounted of open.splice(0)) await mounted.dispose()
})

/** A tool whose output is distinctive text, so a shadowed span holds a real tool result. */
const echo = defineTool({
  name: 'echo',
  description: 'Echo text back.',
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  render: (_args, value) => [{ type: 'text', text: value.text }],
  execute: (args: { text: string }) => ({ text: args.text }),
})

async function harness(compaction: CompactionBasicConfig, history?: ToolHistoryConfig): Promise<Harness> {
  const root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin, {})
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(sandboxPlugin, {})
  root.plugin(authorityInvariantPlugin)
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(loopPlugin)
  root.plugin(loopInvariantPlugin)
  root.plugin(compactionBasicPlugin, compaction)
  root.plugin(toolHistoryPlugin, history)
  await root.settle()
  const adapter = new ScriptedAdapter()
  root.get(LLM).registerAdapter(root, adapter)
  root.get(PROMPT).section(root, { name: 'persona', order: 0, text: 'You are a test agent.' })
  root.get(TOOLS).register(root, echo)
  // One shared responder answers every call for the life of the harness, so a
  // scripted turn can be queued at any point instead of racing a pre-filled
  // queue: `next()` is drained first, everything else gets bulk.
  const forced: StreamChunk[][] = []
  const shared = bulkResponder(forced)
  adapter.script(...Array.from({ length: 80 }, () => shared))
  const handles: AgentHandle[] = []
  const created: Harness = {
    root,
    adapter,
    next(...responses) {
      forced.push(...responses)
    },
    async create() {
      const handle = await root.get(AGENTS).create(root, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      handles.push(handle)
      return handle
    },
    async fork(source) {
      const handle = await root.get(AGENTS).fork(root, source.session)
      handles.push(handle)
      return handle
    },
    async dispose() {
      for (const handle of handles.toReversed()) await handle.dispose()
      await root.dispose()
    },
  }
  open.push(created)
  return created
}

/** Answers a summary request with a summary, a forced turn with its script, and everything else with bulk. */
function bulkResponder(forced: StreamChunk[][]): ScriptedResponse {
  let steps = 0
  return (request) => {
    if (request.purpose === 'compaction') return assistantText('## Primary Request\n- keep going\n## Next Step\n- finish')
    const next = forced.shift()
    if (next) return next
    steps += 1
    return assistantText(`reply ${steps} ${'y'.repeat(320)}`, { inputTokens: steps * 130, outputTokens: 6 })
  }
}

async function grow(agent: Agent, turns: number): Promise<void> {
  for (let turn = 1; turn <= turns; turn++) {
    agent.followup(createUserMessage(`prompt ${turn} ${'x'.repeat(320)}`))
    await agent.whenIdle()
  }
}

/** One turn whose assistant calls `name`, then answers. */
async function callTool(test: Harness, agent: Agent, callId: string, name: string, args: object): Promise<EventEnvelope> {
  const before = agent.session.events.length
  test.next(assistantToolCall(callId, name, args), assistantText('done'))
  agent.followup(createUserMessage('use the tool'))
  await agent.whenIdle()
  const result = agent.session.events.slice(before).find((event) => matches(event, TOOL_RESULT))
  expect(result, `no tool/result for ${name}`).toBeDefined()
  return result!
}

function resultText(event: EventEnvelope): string {
  if (!matches(event, TOOL_RESULT)) throw new Error('not a tool/result')
  return messageText({ ...event.data.message, content: event.data.message.content })
}

/** A tool result's own text, unwrapped from its envelope the way the model receives it. */
function resultContent(event: EventEnvelope): string {
  if (!matches(event, TOOL_RESULT)) throw new Error('not a tool/result')
  let out = ''
  for (const block of event.data.message.content) {
    if (block.type === 'tool-result') for (const inner of block.content) if (inner.type === 'text') out += inner.text
  }
  return out
}

function appliedRecords(agent: Agent): EventEnvelope[] {
  return agent.session.events.filter((event) => event.type === COMPACTION_APPLIED.type)
}

function shadowedRange(agent: Agent): { fromSeq: number; toSeq: number } {
  const seqs = appliedRecords(agent).flatMap((event) => (matches(event, COMPACTION_APPLIED) ? [...event.data.shadowedSeqs] : []))
  expect(seqs.length).toBeGreaterThan(0)
  return { fromSeq: Math.min(...seqs), toSeq: Math.max(...seqs) }
}

const MARKER = 'PERSIMMON-77'
const COMPACT: CompactionBasicConfig = { budgetTokens: 4_000, retainRatio: 0.2, auto: false }

describe('bounded recall of shadowed history', () => {
  it('costs an agent nothing until its first applied compaction, then offers the tool', async () => {
    const test = await harness(COMPACT)
    const { agent } = await test.create()
    // Registered in the deployment globals from boot, so a summary can name it…
    expect(test.root.get(TOOLS).schemas().map((schema) => schema.name)).toContain('history_read')
    // …and hidden from this agent, which has nothing to read back.
    expect(test.root.get(TOOLS).schemas(agent).map((schema) => schema.name)).not.toContain('history_read')

    await grow(agent, 6)
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')
    expect(test.root.get(TOOLS).schemas(agent).map((schema) => schema.name)).toContain('history_read')
  })

  it('reads back a shadowed tool result, which is the content a summary most often drops', async () => {
    const test = await harness(COMPACT)
    const { agent } = await test.create()
    await callTool(test, agent, 'echo-1', 'echo', { text: `the answer is ${MARKER}` })
    await grow(agent, 6)
    expect((await test.root.get(COMPACTION).compactNow(agent)).kind).toBe('compacted')

    // Gone from what the model can see, still in the log.
    const surface = agent.session.deriveMessages().map((message) => messageText(message)).join('\n')
    expect(surface).not.toContain(MARKER)

    const range = shadowedRange(agent)
    const result = await callTool(test, agent, 'recall-1', 'history_read', range)
    expect(matches(result, TOOL_RESULT) ? result.data.error : undefined, resultContent(result)).toBeUndefined()
    // The whole point: a tool-result envelope projects to nothing through
    // `blockText`, so a recall that used it would answer with blanks.
    expect(resultContent(result)).toContain(MARKER)
    expect(resultContent(result)).toContain('history')
  })

  it('refuses a range that names nothing replaced, and says where the replaced messages are', async () => {
    const test = await harness(COMPACT)
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    const range = shadowedRange(agent)

    const result = await callTool(test, agent, 'recall-miss', 'history_read', { fromSeq: range.toSeq + 1, toSeq: range.toSeq + 5 })
    expect(matches(result, TOOL_RESULT) ? result.data.error?.code : undefined).toBe('HISTORY_NOT_SHADOWED')
    expect(resultContent(result)).toContain(`${range.fromSeq}`)
  })

  it('refuses a call over its per-call budget rather than truncating it', async () => {
    const test = await harness(COMPACT, { maxCallTokens: 5 })
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)

    const result = await callTool(test, agent, 'recall-big', 'history_read', shadowedRange(agent))
    expect(matches(result, TOOL_RESULT) ? result.data.error?.code : undefined).toBe('HISTORY_TOO_LARGE')
    expect(resultContent(result)).toContain('narrower range')
  })

  it('spends a session budget the log itself records, so a fork inherits what was already read', async () => {
    // This span's BODY renders at 855 estimated tokens, measured; the budget
    // sits just above it, so the first call lands and nothing after it can.
    const BUDGET = 870
    const test = await harness(COMPACT, { maxSessionTokens: BUDGET })
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    const range = shadowedRange(agent)

    const first = await callTool(test, agent, 'recall-a', 'history_read', range)
    expect(matches(first, TOOL_RESULT) ? first.data.error : undefined, resultContent(first)).toBeUndefined()
    // The spend is folded from the RESULT, which carries this tool's own framing
    // on top of the span — so it is always at least what the call was charged.
    const spent = foldRecall(agent.session).spent
    expect(spent).toBeGreaterThan(BUDGET)

    // A fork carries the spend because it carries the events it was folded from,
    // and its log already holds a compaction, so the tool is never hidden there.
    const forked = await test.fork(agent)
    expect(foldRecall(forked.agent.session).spent).toBe(spent)
    expect(test.root.get(TOOLS).schemas(forked.agent).map((schema) => schema.name)).toContain('history_read')

    const second = await callTool(test, forked.agent, 'recall-b', 'history_read', range)
    expect(matches(second, TOOL_RESULT) ? second.data.error?.code : undefined).toBe('HISTORY_BUDGET')
  })

  it('never offers its own results back: a recall a later compaction shadowed is not recallable', async () => {
    const test = await harness(COMPACT)
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    const recall = await callTool(test, agent, 'recall-once', 'history_read', shadowedRange(agent))
    expect(matches(recall, TOOL_RESULT) ? recall.data.error : undefined, resultContent(recall)).toBeUndefined()

    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    // The second compaction shadowed the recall result along with everything
    // else; the admissible set drops it, so the model cannot pay twice for one span.
    const shadowed = appliedRecords(agent).flatMap((event) => (matches(event, COMPACTION_APPLIED) ? [...event.data.shadowedSeqs] : []))
    expect(shadowed).toContain(recall.seq)
    expect(foldRecall(agent.session).admissible.has(recall.seq)).toBe(false)
  })
})

describe('what the budget measures, and what it may read', () => {
  it('charges only what came back: a refusal returned nothing and costs nothing', async () => {
    // Measured before the fix: two refusals moved the spend from 0 to 74 while
    // nothing was read — and the refusal text is itself what tells the model to
    // retry narrower, so the advice this tool gives drained the budget it
    // advises about, until every further call answered HISTORY_BUDGET.
    const test = await harness(COMPACT, { maxCallTokens: 5 })
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    expect(foldRecall(agent.session).spent).toBe(0)

    const first = await callTool(test, agent, 'refuse-1', 'history_read', shadowedRange(agent))
    expect(matches(first, TOOL_RESULT) ? first.data.error?.code : undefined).toBe('HISTORY_TOO_LARGE')
    expect(foldRecall(agent.session).spent).toBe(0)
    const second = await callTool(test, agent, 'refuse-2', 'history_read', shadowedRange(agent))
    expect(matches(second, TOOL_RESULT) ? second.data.error?.code : undefined).toBe('HISTORY_TOO_LARGE')
    expect(foldRecall(agent.session).spent).toBe(0)
  })

  it('never offers back a message the model can still see', async () => {
    // A fork boundary may fall between `compaction/applied` and the replace that
    // realized it. That child holds the record naming the span while every node
    // of it is still live; recall used to hand back a verbatim second copy.
    const test = await harness(COMPACT)
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    const appliedSeq = appliedRecords(agent)[0]!.seq

    const forked = await test.root.get(AGENTS).fork(test.root, agent.session, appliedSeq)
    const live = new Set(forked.agent.session.surfaceSeqs())
    const shadowed = appliedRecords(agent).flatMap((event) => (matches(event, COMPACTION_APPLIED) ? [...event.data.shadowedSeqs] : []))
    // The premise: the record survived the cut and every node it names is live.
    expect(shadowed.every((seq) => live.has(seq))).toBe(true)
    expect(foldRecall(forked.agent.session).admissible.size).toBe(0)
    // And with nothing to read back, the tool is never offered.
    expect(test.root.get(TOOLS).schemas(forked.agent).map((schema) => schema.name)).not.toContain('history_read')
    await forked.dispose()
  })

  it('bounds what it actually emits, not the span it read it from', async () => {
    // The header reports the count, so it cannot be inside it; everything else
    // the call returns is. Measured before the fix: a call reporting ~1720
    // tokens emitted ~1814.
    const test = await harness(COMPACT)
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    const result = await callTool(test, agent, 'measure', 'history_read', shadowedRange(agent))
    const text = resultContent(result)
    const reported = Number(/~(\d+) tokens/.exec(text)![1])
    const body = text.slice(text.indexOf(']\n\n') + 3)
    expect(Math.ceil(body.length / 4)).toBe(reported)
  })
})

describe('the projection', () => {
  it('renders a recalled span as text a model can read', async () => {
    const test = await harness(COMPACT)
    const { agent } = await test.create()
    await grow(agent, 6)
    await test.root.get(COMPACTION).compactNow(agent)
    const result = await callTool(test, agent, 'recall-render', 'history_read', shadowedRange(agent))
    const text = resultContent(result)
    expect(text).toMatch(/^\[history \d+–\d+ · \d+ message\(s\)/)
    expect(text).toContain('user')
    expect(text).toContain('assistant')
    // The envelope the model sees carries the text, not an empty result.
    expect(resultText(result).length + text.length).toBeGreaterThan(0)
  })
})
