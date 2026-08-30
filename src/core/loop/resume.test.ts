/** Resume and fork: agent-creation modes over a stored (or live) session. */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { persistenceJsonlPlugin } from '../../capabilities/persistence-jsonl/index.ts'
import { AGENTS } from '../agent/index.ts'
import { asSessionId } from '../ids.ts'
import { createUserMessage } from '../llm/message.ts'
import { SESSIONS, STEP_START, TOOL_CALL, TURN_START, USER_MESSAGE, type EventEnvelope } from '../session/index.ts'
import { assistantText } from '../../test-support/scripted-adapter.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'

let harness: CoreHarness | undefined
let dir: string | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

async function persistedHarness(): Promise<{ harness: CoreHarness; dir: string }> {
  harness = await coreHarness()
  dir = mkdtempSync(join(tmpdir(), 'minidsh-resume-'))
  harness.root.plugin(persistenceJsonlPlugin, { root: dir })
  await harness.root.settle()
  return { harness, dir }
}

function fileFor(base: string, id: string): string {
  return join(base, `${encodeURIComponent(id)}.jsonl`)
}

function fileEvents(base: string, id: string): EventEnvelope[] {
  return readFileSync(fileFor(base, id), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

/** A stored log interrupted mid-turn (open step, unanswered tool call). */
function storeCrashedLog(h: CoreHarness, id: string): void {
  const sessions = h.root.get(SESSIONS)
  const session = sessions.create({ cwd: process.cwd(), id: asSessionId(id) })
  session.append(TURN_START, { turn: 1 })
  session.append(STEP_START, { turn: 1, step: 1 })
  // The prompt the turn entered: the conversation fact that materializes the file.
  session.append(USER_MESSAGE, { message: createUserMessage('go') }, { surfaceOp: { op: 'append' } })
  session.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
  void sessions.detach(session)
}

describe('agents.resume', () => {
  it('continues a stored session append-only: same file, continued numbering, config folded from the log', async () => {
    const { harness: h, dir: base } = await persistedHarness()
    h.adapter.script(assistantText('first run'))
    const first = await h.create()
    const id = first.agent.id
    first.agent.followup(createUserMessage('hi'))
    await first.agent.whenIdle()
    await first.dispose()
    const before = readFileSync(fileFor(base, id))

    h.adapter.script(assistantText('resumed'))
    const resumed = await h.root.get(AGENTS).resume(h.root, id)
    expect(resumed.agent.session.origin).toBe('resumed')
    // The folded request/header supplied the model config; nothing was passed here.
    expect(resumed.agent.options).toMatchObject({ provider: 'scripted', model: 'scripted-model' })
    resumed.agent.followup(createUserMessage('continue'))
    await resumed.agent.whenIdle()

    const after = readFileSync(fileFor(base, id))
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    const turns = resumed.agent.session.events.filter((event) => event.type === 'turn/start').map((event) => (event.data as { turn: number }).turn)
    expect(turns).toEqual([1, 2])
    // Unchanged composition ⇒ unchanged header ⇒ the resumed lifecycle appended
    // no new request/header: the provider prefix stays byte-stable.
    expect(resumed.agent.session.events.filter((event) => event.type === 'request/header')).toHaveLength(1)
    await resumed.dispose()
  })

  it("stamps reason 'resume' on a header that changes at the first resumed step", async () => {
    const { harness: h } = await persistedHarness()
    h.adapter.script(assistantText('one'))
    const first = await h.create()
    const id = first.agent.id
    first.agent.followup(createUserMessage('hi'))
    await first.agent.whenIdle()
    await first.dispose()

    h.adapter.script(assistantText('two'), assistantText('three'))
    const resumed = await h.root.get(AGENTS).resume(h.root, id, { agentOptions: { temperature: 0.7 } })
    resumed.agent.followup(createUserMessage('continue'))
    await resumed.agent.whenIdle()
    const headers = resumed.agent.session.events.filter((event) => event.type === 'request/header')
    expect(headers).toHaveLength(2)
    expect((headers.at(-1)!.data as { reason: string; header: { temperature?: number } }).reason).toBe('resume')
    expect((headers.at(-1)!.data as { header: { temperature?: number } }).header.temperature).toBe(0.7)
    await resumed.dispose()
  })

  it('repairs an interrupted stored log, persists the closers, and runs on', async () => {
    const { harness: h, dir: base } = await persistedHarness()
    storeCrashedLog(h, 'crashed')

    // No base route and no request/header in the stored log: resume demands a model config.
    await expect(h.root.get(AGENTS).resume(h.root, asSessionId('crashed'))).rejects.toThrowError(/no stored agent\/options or request\/header/)

    h.adapter.script(assistantText('recovered'))
    const resumed = await h.root.get(AGENTS).resume(h.root, asSessionId('crashed'), {
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
    })
    resumed.agent.followup(createUserMessage('go on'))
    await resumed.agent.whenIdle()

    const stored = fileEvents(base, 'crashed').map((event) => event.type)
    // The crash closers and the lifecycle marker were appended to the same file.
    expect(stored).toContain('tool/result')
    expect(stored).toContain('session/end-seed')
    const turnEnds = resumed.agent.session.events.filter((event) => event.type === 'turn/end')
    expect(turnEnds.map((event) => (event.data as { reason: { kind: string } }).reason.kind)).toEqual(['interrupted', 'completed'])
    await resumed.dispose()
  })

  it('refuses a live id, an unknown id, and a damaged store', async () => {
    const { harness: h, dir: base } = await persistedHarness()
    const agents = h.root.get(AGENTS)
    h.adapter.script(assistantText('live'))
    const live = await h.create()
    live.agent.followup(createUserMessage('hi'))
    await live.agent.whenIdle()
    await expect(agents.resume(h.root, live.agent.id)).rejects.toThrowError(/already exists/)
    await live.dispose()

    await expect(agents.resume(h.root, asSessionId('nope'))).rejects.toThrowError(/no stored session/)

    appendFileSync(fileFor(base, live.agent.id), '{"not":"an event"}\n{"type":"x","seq":77,"time":1,"data":{}}\n')
    await expect(agents.resume(h.root, live.agent.id)).rejects.toThrowError(/damaged/)
  })
})

describe('durable inbox', () => {
  it('records inserts, claims, and user clears; the fold of a settled log is empty', async () => {
    const { harness: h } = await persistedHarness()
    const { foldInbox } = await import('../agent/index.ts')
    h.adapter.script(assistantText('done'))
    const { agent } = await h.create()
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    const splices = () => agent.session.events.filter((event) => event.type === 'inbox/spliced').map((event) => event.data as { op: string })
    expect(splices().map((splice) => splice.op)).toEqual(['insert', 'claim'])
    expect(splices().at(-1)).toMatchObject({ op: 'claim', steps: 0, turns: 1 })

    const { createPluginMessage } = await import('../llm/message.ts')
    agent.inject(createPluginMessage('test', 'quiet context'))
    agent.cancel({ kind: 'user' })
    expect(splices().map((splice) => splice.op)).toEqual(['insert', 'claim', 'insert', 'clear'])
    const folded = foldInbox(agent.session.events)
    expect(folded.turnQueue).toEqual([])
    expect(folded.stepQueue).toEqual([])
  })

  it('a queued prompt survives graceful teardown and self-runs on resume', async () => {
    const { harness: h } = await persistedHarness()
    h.adapter.script(assistantText('first answer'))
    const first = await h.create()
    const id = first.agent.id
    first.agent.followup(createUserMessage('hi'))
    await first.agent.whenIdle()
    // Queued without waking: still pending when the process "goes down".
    first.agent.send(createUserMessage('finish the report'), 'next-turn', false)
    await first.dispose() // a disposed-cancel must NOT durably clear the queue

    h.adapter.script(assistantText('report finished'))
    const resumed = await h.root.get(AGENTS).resume(h.root, id)
    // No new input: the restored inbox wakes the agent by itself.
    await resumed.agent.whenIdle()
    const turns = resumed.agent.session.events.filter((event) => event.type === 'turn/start')
    expect(turns).toHaveLength(2)
    const lastUser = resumed.agent.session
      .deriveMessages()
      .filter((message) => message.role === 'user')
      .at(-1)!
    expect((lastUser.content[0] as { text: string }).text).toBe('finish the report')
    await resumed.dispose()
  })

  it('a user cancel durably clears: resume restores nothing and stays idle', async () => {
    const { harness: h } = await persistedHarness()
    h.adapter.script(assistantText('one'))
    const first = await h.create()
    const id = first.agent.id
    first.agent.followup(createUserMessage('hi'))
    await first.agent.whenIdle()
    first.agent.send(createUserMessage('never mind'), 'next-turn', false)
    first.agent.cancel({ kind: 'user' })
    await first.dispose()

    const resumed = await h.root.get(AGENTS).resume(h.root, id)
    await resumed.agent.whenIdle()
    expect(resumed.agent.status).toBe('idle')
    expect(resumed.agent.session.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    await resumed.dispose()
  })

  it('a steer landing during the pre-step await folds correctly (op records, not positions)', async () => {
    const { harness: h } = await persistedHarness()
    const { foldInbox, AGENT_PRE_STEP } = await import('../agent/index.ts')
    h.adapter.script(assistantText('first'), assistantText('second'))
    const { agent } = await h.create()
    let steered = false
    agent.ctx.on(AGENT_PRE_STEP, async (context, next) => {
      if (!steered) {
        steered = true
        // Lands after the claim mutation but is LOGGED before the claim record.
        context.agent.steer(createUserMessage('also consider this'))
      }
      return next()
    })
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    const folded = foldInbox(agent.session.events)
    expect(folded.turnQueue).toEqual([])
    expect(folded.stepQueue).toEqual([])
    const texts = agent.session
      .deriveMessages()
      .filter((message) => message.role === 'user')
      .map((message) => (message.content[0] as { text: string }).text)
    expect(texts).toEqual(['hi', 'also consider this'])
  })
})

describe('agents.fork', () => {
  it('branches a live session into a new agent with lineage, leaving the source untouched', async () => {
    const { harness: h, dir: base } = await persistedHarness()
    h.adapter.script(assistantText('parent says'), assistantText('child says'))
    const parent = await h.create()
    parent.agent.followup(createUserMessage('hi'))
    await parent.agent.whenIdle()
    const parentBytes = readFileSync(fileFor(base, parent.agent.id))

    const child = await h.root.get(AGENTS).fork(h.root, parent.agent.session)
    expect(child.agent.id).not.toBe(parent.agent.id)
    expect(child.agent.session.header.parentId).toBe(parent.agent.id)
    expect(child.agent.session.header.seedLength).toBeGreaterThan(0)
    expect(child.agent.options).toMatchObject({ provider: 'scripted', model: 'scripted-model' })
    child.agent.followup(createUserMessage('diverge'))
    await child.agent.whenIdle()
    const childTurns = child.agent.session.events.filter((event) => event.type === 'turn/start')
    expect((childTurns.at(-1)!.data as { turn: number }).turn).toBe(2)
    expect(readFileSync(fileFor(base, parent.agent.id)).equals(parentBytes)).toBe(true)
    await child.dispose()
    await parent.dispose()
  })

  it('is born idle even when the branch carries pending waking input (fork is a passive branch)', async () => {
    const { harness: h } = await persistedHarness()
    h.adapter.script(assistantText('first'))
    const first = await h.create()
    const id = first.agent.id
    first.agent.followup(createUserMessage('hi'))
    await first.agent.whenIdle()
    first.agent.send(createUserMessage('queued for later'), 'next-turn', false)
    await first.dispose()

    const child = await h.root.get(AGENTS).fork(h.root, id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    // Creating a branch must not start a paid turn — unlike resume.
    expect(child.agent.status).toBe('idle')
    expect(child.agent.session.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)

    // The restored queue still enters the fork's next real turns, FIFO.
    h.adapter.script(assistantText('branch one'), assistantText('branch two'))
    child.agent.followup(createUserMessage('go'))
    await child.agent.whenIdle()
    const texts = child.agent.session
      .deriveMessages()
      .filter((message) => message.role === 'user')
      .map((message) => (message.content[0] as { text: string }).text)
    expect(texts).toContain('queued for later')
    expect(texts).toContain('go')
    await child.dispose()
  })

  it('forks a stored crashed session cold, repairing it first', async () => {
    const { harness: h } = await persistedHarness()
    storeCrashedLog(h, 'cold')
    h.adapter.script(assistantText('branched'))
    const child = await h.root.get(AGENTS).fork(h.root, asSessionId('cold'), undefined, {
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
    })
    expect(child.agent.session.header.parentId).toBe('cold')
    // The repair closers are part of the child's seed: its log begins balanced.
    const seedTypes = child.agent.session.events.map((event) => event.type)
    expect(seedTypes).toContain('tool/result')
    expect(seedTypes).toContain('session/end-seed')
    child.agent.followup(createUserMessage('go'))
    await child.agent.whenIdle()
    expect((child.agent.session.events.at(-1)!.data as { reason: { kind: string } }).reason.kind).toBe('completed')
    await child.dispose()
  })
})

describe('crash repair closes the committed surface, not just the logged calls', () => {
  /**
   * The driver commits the assistant message with ALL its tool-call blocks and
   * then logs each tool/call only when that call's turn comes. A crash during
   * call 1 of 3 therefore leaves calls 2 and 3 with no call event at all, and a
   * repair that answered only logged calls resumed a history in which an
   * assistant message carried three tool calls and one result — a shape every
   * OpenAI-compatible wire refuses on every later request.
   */
  it('answers every tool-call block of the interrupted step and cancels an undecided approval', async () => {
    const { harness: h } = await persistedHarness()
    const { ASSISTANT_MESSAGE } = await import('../session/index.ts')
    const { APPROVAL_ASKED } = await import('../approval/events.ts')
    const { createAssistantMessage } = await import('../llm/message.ts')
    const { serializeMessages } = await import('../../capabilities/llm-deepseek/serialize.ts')
    const { asCallId } = await import('../ids.ts')
    const sessions = h.root.get(SESSIONS)
    const session = sessions.create({ cwd: process.cwd(), id: asSessionId('multi') })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    session.append(USER_MESSAGE, { message: createUserMessage('do three things') }, { surfaceOp: { op: 'append' } })
    const calls = ['c1', 'c2', 'c3'].map((id) => ({ type: 'tool-call' as const, id: asCallId(id), name: 'bash', arguments: '{}' }))
    session.append(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage(calls, 'scripted', 'scripted-model') }, { surfaceOp: { op: 'append' } })
    session.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    // The person was still deciding on c1's escalation when the process died.
    session.append(APPROVAL_ASKED, { id: 'approval-5', toolName: 'bash', callId: 'c1' })
    void sessions.detach(session)

    h.adapter.script(assistantText('recovered'))
    const resumed = await h.root.get(AGENTS).resume(h.root, asSessionId('multi'), { agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    const describeCloser = (event: EventEnvelope): string => {
      const data = event.data as { callId?: string; id?: string; outcome?: string; error?: { code: string } }
      return [event.type, data.callId ?? data.id ?? '', data.error?.code ?? data.outcome ?? ''].filter((part) => part !== '').join(' ')
    }
    expect(resumed.agent.session.events.slice(6).map(describeCloser)).toEqual([
      'approval/decided approval-5 cancelled',
      'tool/result c1 TOOL_OUTCOME_UNKNOWN',
      'tool/result c2 TOOL_NOT_STARTED',
      'tool/result c3 TOOL_NOT_STARTED',
      'step/end',
      'turn/end',
      'session/end-seed',
      // A log from before opening records existed gets them at pickup: the
      // base route first (the factory's act), then the two authority knobs.
      'agent/options',
      'approval/policy',
      'sandbox/mode',
    ])

    // What the wire would see: every tool_call has its tool message, in order.
    const wire = serializeMessages(undefined, resumed.agent.session.deriveMessages())
    const assistant = wire.find((message) => message.role === 'assistant')!
    expect(assistant.tool_calls!.map((call) => call.id)).toEqual(['c1', 'c2', 'c3'])
    expect(wire.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual(['c1', 'c2', 'c3'])

    // And the session runs on from a balanced log.
    resumed.agent.followup(createUserMessage('go on'))
    await resumed.agent.whenIdle()
    expect((resumed.agent.session.events.at(-1)!.data as { reason: { kind: string } }).reason.kind).toBe('completed')
    await resumed.dispose()
  })
})

describe('the base route survives its process', () => {
  it('resumes from the base route, not from a header a listener rewrote, and records an override as a resume', async () => {
    const { harness: h, dir: base } = await persistedHarness()
    const { AGENT_OPTIONS, AGENT_REQUEST } = await import('../agent/index.ts')
    h.adapter.script(assistantText('one'), assistantText('two'), assistantText('three'))
    const rewrite = h.root.on(AGENT_REQUEST, async (_context, next) => ({ ...(await next()), model: 'cheap-model' }), { global: true })
    const first = await h.create()
    const id = first.agent.id
    first.agent.followup(createUserMessage('go'))
    await first.agent.whenIdle()
    // The last header names the rewrite; a resume that folded the header would adopt it as the base.
    expect(first.agent.session.foldRequestHeader()!.model).toBe('cheap-model')
    await first.dispose()
    await rewrite()

    const resumed = await h.root.get(AGENTS).resume(h.root, id)
    expect(resumed.agent.options).toEqual({ provider: 'scripted', model: 'scripted-model' })
    resumed.agent.followup(createUserMessage('again'))
    await resumed.agent.whenIdle()
    expect(h.adapter.calls.at(-1)!.model).toBe('scripted-model')
    expect(resumed.agent.session.events.filter((event) => event.type === AGENT_OPTIONS.type)).toHaveLength(1)
    await resumed.dispose()

    const overridden = await h.root.get(AGENTS).resume(h.root, id, { agentOptions: { reasoningEffort: 'low' } })
    const records = overridden.agent.session.events.filter((event) => event.type === AGENT_OPTIONS.type).map((event) => event.data)
    expect(records.at(-1)).toEqual({ options: { provider: 'scripted', model: 'scripted-model', reasoningEffort: 'low' }, reason: 'resume' })
    await overridden.dispose()
    expect(fileEvents(base, id).filter((event) => event.type === AGENT_OPTIONS.type)).toHaveLength(2)
  })

  it('a log from before the base was recorded derives it from the header and records it at pickup', async () => {
    const { harness: h, dir: base } = await persistedHarness()
    const { AGENT_OPTIONS } = await import('../agent/index.ts')
    const { REQUEST_HEADER, STEP_END, TURN_END } = await import('../session/index.ts')
    const sessions = h.root.get(SESSIONS)
    const id = asSessionId('old-log')
    const session = sessions.create({ cwd: process.cwd(), id })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    session.append(USER_MESSAGE, { message: createUserMessage('go') }, { surfaceOp: { op: 'append' } })
    session.append(REQUEST_HEADER, {
      turn: 1,
      step: 1,
      header: { provider: 'scripted', model: 'legacy-model', reasoningEffort: 'low', system: '', tools: [] },
      reason: 'initial',
    })
    session.append(STEP_END, { turn: 1, step: 1 })
    session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })
    await sessions.detach(session)

    const resumed = await h.root.get(AGENTS).resume(h.root, id, { defaults: { provider: 'scripted', model: 'default-model', maxSteps: 3 } })
    // The header is the authority for the model-visible fields; `maxSteps` alone survives from the defaults.
    expect(resumed.agent.options).toEqual({ provider: 'scripted', model: 'legacy-model', reasoningEffort: 'low', maxSteps: 3 })
    expect(resumed.agent.session.events.filter((event) => event.type === AGENT_OPTIONS.type).map((event) => event.data)).toEqual([
      { options: { provider: 'scripted', model: 'legacy-model', reasoningEffort: 'low', maxSteps: 3 }, reason: 'initial' },
    ])
    await resumed.dispose()
    expect(fileEvents(base, id).some((event) => event.type === AGENT_OPTIONS.type)).toBe(true)
  })
})

describe('lineage survives the process', () => {
  it('a resumed or forked child keeps delegatedBy, delegationDepth and agentPreset', async () => {
    const { harness: h } = await persistedHarness()
    h.adapter.script(assistantText('one'))
    const agents = h.root.get(AGENTS)
    const child = await agents.create(h.root, {
      cwd: process.cwd(),
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      delegatedBy: asSessionId('session-parent'),
      delegationDepth: 2,
      agentPreset: 'reviewer',
    })
    child.agent.followup(createUserMessage('go'))
    await child.agent.whenIdle()
    const id = child.agent.id
    await child.dispose()

    const resumed = await agents.resume(h.root, id)
    expect(resumed.agent.session.header).toMatchObject({ delegatedBy: 'session-parent', delegationDepth: 2, agentPreset: 'reviewer' })
    const forked = await agents.fork(h.root, id)
    expect(forked.agent.session.header).toMatchObject({ parentId: id, delegatedBy: 'session-parent', delegationDepth: 2, agentPreset: 'reviewer' })
    await forked.dispose()
    await resumed.dispose()
  })
})
