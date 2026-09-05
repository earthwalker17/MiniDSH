/**
 * The S6 routing live end-to-end: two providers through one unchanged loop.
 *
 * One arc, four claims, all against the real DeepSeek and Anthropic APIs
 * through `minidsh serve` over real stdio:
 *
 *   route as a fact   the session starts on DeepSeek, switches to Anthropic
 *                     mid-session over the wire, and the log says so — one
 *                     `agent/options{change}`, a `request/context` per route
 *                     with each provider's real window
 *   mixed history     the Anthropic turn works over history a DeepSeek turn
 *                     produced (tool call included), and every assistant
 *                     message is attributed to the model that wrote it
 *   roles             a `compaction` role sends the summary down a route the
 *                     log names — a different provider from the loop's own
 *   replay            the mixed log replays keylessly, both cursors drained
 *
 * Requires DEEPSEEK_API_KEY and ANTHROPIC_API_KEY; skipped otherwise.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { AGENT_OPTIONS } from '../core/agent/index.ts'
import { COMPACTION_APPLIED, COMPACTION_END, COMPACTION_START } from '../core/compaction/index.ts'
import { LLM_AUX_CALL, type AuxCallRecord } from '../core/llm/index.ts'
import { foldRequestContext, type EventEnvelope } from '../core/session/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { loadCompositionFile, toPatches } from './config.ts'
import { bootComposition } from './headless.ts'

const DEEPSEEK = process.env.DEEPSEEK_API_KEY
const ANTHROPIC = process.env.ANTHROPIC_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
/** Low enough that three file reads cross it for real. */
const BUDGET = 6_000

let dirs: string[] = []
afterAll(() => {
  killSpawnedServes()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function note(marker: string): string {
  const filler = Array.from({ length: 160 }, (_unused, index) => `note line ${index}: routine background, nothing important here.`)
  filler.splice(80, 0, `THE MARKER FOR THIS FILE IS ${marker}`)
  return `${filler.join('\n')}\n`
}

function seedWorkspace(dir: string): void {
  writeFileSync(join(dir, 'alpha.txt'), note('ALPHA-11'), 'utf8')
  writeFileSync(join(dir, 'bravo.txt'), note('BRAVO-22'), 'utf8')
  writeFileSync(join(dir, 'charlie.txt'), note('CHARLIE-33'), 'utf8')
}

function assistantTexts(events: readonly EventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => {
      const message = (event.data as { message: { content: { type: string; text?: string }[] } }).message
      return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
    })
}

describe.skipIf(!DEEPSEEK || !ANTHROPIC)('S6 live E2E: two models through one loop, and a role that routes the summary', () => {
  it('switches route mid-session, keeps mixed history working, summarises down a role, and replays', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-e2e6-ws-')
    const home = tempDir('minidsh-e2e6-home-')
    seedWorkspace(workspace)

    // The deployment's own budget, and a compaction role pointing at the
    // CHEAP DeepSeek model — plain composition config, no code, no flags.
    writeFileSync(
      join(home, 'composition.json'),
      JSON.stringify({
        patches: [
          { id: 'compaction', config: { budgetTokens: BUDGET, thresholdRatio: 0.5, retainRatio: 0.25, maxTokens: 1024 } },
          { id: 'model-roles', config: { roles: { compaction: { provider: 'deepseek', model: 'deepseek-v4-flash' } } } },
        ],
      }),
      'utf8',
    )

    // Every prompt of the arc, in order — the replay walks the same path.
    const PROMPTS = [
      'Read alpha.txt and reply with only the marker token it contains.',
      'Now read bravo.txt and reply with only the marker token it contains.',
      'Now read charlie.txt and reply with only the marker token it contains.',
      'List every marker token you have found so far, one per line, and nothing else.',
    ] as const

    const serve = new ServeProcess(workspace, home, { approve: true })
    const init = await serve.request<{ providers: { id: string; models: { id: string; contextWindow: number }[] }[] }>('initialize')
    // Both adapters are mounted, and each advertises its own real windows.
    const deepseek = init.providers.find((provider) => provider.id === 'deepseek')!
    const anthropic = init.providers.find((provider) => provider.id === 'anthropic')!
    expect(deepseek.models.some((model) => model.contextWindow === 1_000_000)).toBe(true)
    expect(anthropic.models.find((model) => model.id === 'claude-haiku-4-5-20251001')?.contextWindow).toBe(200_000)

    // ---- turn 1 and 2: DeepSeek, with a real tool call --------------------
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', {
      text: PROMPTS[0],
      agentOptions: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    })
    await serve.waitForCompletedTurn(sessionId, 1)
    await serve.request('session/prompt', { sessionId, text: PROMPTS[1] })
    await serve.waitForCompletedTurn(sessionId, 2)

    // ---- the switch: same session, same loop, another provider ------------
    const route = await serve.request<{ provider: string; model: string }>('session/model', { sessionId, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })
    expect(route).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })

    // ---- turn 3: Anthropic, over history DeepSeek produced ----------------
    await serve.request('session/prompt', { sessionId, text: PROMPTS[2] })
    await serve.waitForCompletedTurn(sessionId, 3)
    // ---- turn 4: enough history that the budget is crossed for real -------
    await serve.request('session/prompt', { sessionId, text: PROMPTS[3] })
    await serve.waitForCompletedTurn(sessionId, 4)

    const log = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    await serve.shutdown()
    const events = log.events

    // ---- the route is one durable fact ------------------------------------
    const options = events.filter((event) => event.type === AGENT_OPTIONS.type).map((event) => event.data as { options: { provider: string; model: string }; reason: string })
    expect(options.map((record) => [record.reason, record.options.provider])).toEqual([
      ['initial', 'deepseek'],
      ['change', 'anthropic'],
    ])
    const contexts = events
      .filter((event) => event.type === 'request/context')
      .map((event) => event.data as { provider: string; model: string; contextWindow?: number; inputModalities?: string[] })
    // One record per route, each carrying the window AND the modalities that
    // adapter advertises — two genuinely different answers from two providers,
    // which is what a replay reads back instead of asking a live adapter.
    expect(contexts).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 1_000_000, inputModalities: ['text'] },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', contextWindow: 200_000, inputModalities: ['text', 'image'] },
    ])
    expect(foldRequestContext(events)!.provider).toBe('anthropic')

    // ---- mixed history, correctly attributed -------------------------------
    const sources = events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => (event.data as { message: { source: { provider: string; model: string; replayState?: unknown } } }).message.source)
    expect(sources.some((source) => source.provider === 'deepseek')).toBe(true)
    expect(sources.some((source) => source.provider === 'anthropic')).toBe(true)
    // Anthropic's signed thinking rides on its own messages and nowhere else.
    expect(sources.filter((source) => source.replayState !== undefined).every((source) => source.provider === 'anthropic')).toBe(true)
    // The Anthropic turns worked over history a DeepSeek turn produced, tool call and all.
    expect(events.some((event) => event.type === 'tool/call')).toBe(true)
    const answers = assistantTexts(events).join('\n')
    expect(answers).toContain('CHARLIE-33')
    const last = assistantTexts(events).at(-1)!
    // A compaction stands between the tokens and this answer, and whether its
    // summary carried them is the model's call. Name what happened, so a
    // failure here is a diagnosis rather than a re-run.
    const compactionTrace = events
      .filter((event) => event.type === COMPACTION_APPLIED.type)
      .map((event) => (event.data as { shadowedSeqs: number[] }).shadowedSeqs.length)
    // Three facts decide which failure this is, and none of them was visible
    // before: whether a summary carried the token forward, whether the model was
    // offered the tool that reads the span back, and whether it used it. Without
    // them a failure here is "the model lost a marker" and nothing more.
    const summaries = events
      .filter((event) => event.type === 'user/message' && JSON.stringify(event.data).includes('system-reminder'))
      .map((event) => JSON.stringify(event.data))
    const carried = summaries.filter((text) => text.includes('ALPHA-11')).length
    const offered = events.some(
      (event) => event.type === 'request/header' && ((event.data as { header: { tools?: { name: string }[] } }).header.tools ?? []).some((tool) => tool.name === 'history_read'),
    )
    const recalls = events.filter((event) => event.type === 'tool/call' && (event.data as { name: string }).name === 'history_read').length
    const why =
      `after ${compactionTrace.length} applied compaction(s) shadowing [${compactionTrace.join(', ')}] node(s); ` +
      `${carried} of ${summaries.length} summary node(s) carried ALPHA-11; history_read ${offered ? 'offered' : 'NOT offered'}, called ${recalls}x`
    // Printed on every run, not only on a failing one. This arc's flake rate is
    // a number the route to V1 reports rather than hides, and a passing run is
    // where you learn whether it passed because the summary carried the token or
    // because the model went back for it — which a green tick cannot say.
    console.log(`[routing] ${why}`)
    expect(last, why).toContain('ALPHA-11')
    expect(last).toContain('BRAVO-22')
    expect(last).toContain('CHARLIE-33')

    // ---- the role routed the summary ---------------------------------------
    //
    // What every compaction ATTEMPT did, which is what this assertion used to
    // be unable to say. Both failure shapes this arc produces — no compaction
    // at all, and a summary that dropped the tokens — are the same family:
    // whether a summary is worth anything is decided by where the planner's cut
    // lands, and that is the model's tool shape rather than anything the runtime
    // chooses. Before S8 a failure here named a count and nothing else, and cost
    // a run to reproduce. Now the log says which of the reasons it was.
    const attempts = events
      .filter((event) => event.type === COMPACTION_END.type)
      .map((event) => {
        const outcome = (event.data as { outcome: { kind: string; reason?: string } }).outcome
        return outcome.kind === 'applied' ? 'applied' : `declined:${outcome.reason}`
      })
    const applied = events.filter((event) => event.type === COMPACTION_APPLIED.type)
    expect(applied.length, `no compaction under a ${BUDGET} budget after ${attempts.length} attempt(s): [${attempts.join(', ')}]`).toBeGreaterThanOrEqual(1)
    // Every attempt closed: an unpaired start would mean one did not, which is a
    // crash, a disposal or a fork boundary — none of which happen here.
    expect(events.filter((event) => event.type === COMPACTION_START.type)).toHaveLength(attempts.length)
    const record = applied[0]!.data as { budgetTokens: number; auxCallSeq: number }
    expect(record.budgetTokens).toBe(BUDGET)
    const aux = events[record.auxCallSeq]!.data as AuxCallRecord
    expect(events[record.auxCallSeq]!.type).toBe(LLM_AUX_CALL.type)
    expect(aux.purpose).toBe('compaction')
    // The summary went down the ROLE's route — a different provider from the
    // loop's own at that moment, and the log names it.
    expect([aux.provider, aux.model]).toEqual(['deepseek', 'deepseek-v4-flash'])
    expect(aux.usage!.inputTokens + (aux.usage!.cacheReadTokens ?? 0)).toBeGreaterThan(0)

    // ---- the mixed log is still its own oracle ------------------------------
    const replayWorkspace = tempDir('minidsh-e2e6-replay-ws-')
    seedWorkspace(replayWorkspace)
    const file = loadCompositionFile(join(home, 'composition.json'))!
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-e2e6-replay-'),
      approve: true,
      logger: silent,
      // No key for either provider: the log answers for both.
      patches: [
        { id: 'llm-deepseek', disabled: true },
        { id: 'llm-anthropic', disabled: true },
      ],
      configLayers: [{ name: 'home', patches: await toPatches(file, home) }],
      prepare: (context) => {
        replayHandle = installLlmReplay(context, { events })
      },
    })
    try {
      const handle = await root.get(AGENTS).create(root, { cwd: replayWorkspace, agentOptions: { provider: 'deepseek', model: 'deepseek-v4-flash' } })
      // The same prompts, in order, with the SAME switch at the same point:
      // the replayed session walks the path the recording walked.
      for (const [index, text] of PROMPTS.entries()) {
        if (index === 2) handle.agent.configure({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })
        handle.agent.followup(createUserMessage(text))
        await handle.agent.whenIdle()
      }
      // Both routes were recorded, and both were replayed from one script.
      const replayedContexts = handle.agent.session.events.filter((event) => event.type === 'request/context').map((event) => (event.data as { provider: string }).provider)
      expect(replayedContexts).toEqual(['deepseek', 'anthropic'])
      await handle.dispose()
    } finally {
      await root.dispose()
    }
    expect(replayHandle!.providers.toSorted()).toEqual(['anthropic', 'deepseek'])
    expect(replayHandle!.auxCalls).toBeGreaterThanOrEqual(1)
    replayHandle!.assertConsumed()
    // A pristine workspace was read the same way it was read live.
    expect(readFileSync(join(replayWorkspace, 'alpha.txt'), 'utf8')).toContain('ALPHA-11')
  })
})
