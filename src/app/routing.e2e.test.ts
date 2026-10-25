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
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { AGENT_OPTIONS } from '../core/agent/index.ts'
import { COMPACTION_APPLIED, COMPACTION_END, COMPACTION_START } from '../core/compaction/index.ts'
import { LLM_AUX_CALL, type AuxCallRecord } from '../core/llm/index.ts'
import { deriveEventMessage, foldRequestContext, foldSurfaceSeqs, type EventEnvelope } from '../core/session/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { createUserMessage, restoreMessage } from '../core/llm/message.ts'
import type { Message } from '../core/llm/types.ts'
import type { ResolvedImage } from '../core/llm/content.ts'
import { serializeMessages as serializeAnthropic } from '../capabilities/llm-anthropic/index.ts'
import { serializeMessages as serializeDeepSeek } from '../capabilities/llm-deepseek/index.ts'
import { serializeInput as serializeOpenAI } from '../capabilities/llm-openai/index.ts'
import { QUADRANT_COLOURS, quadPng } from '../test-support/images.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { loadCompositionFile, toPatches } from './config.ts'
import { bootComposition } from './headless.ts'
import { skillRootsFor } from './home.ts'

const DEEPSEEK = process.env.DEEPSEEK_API_KEY
const ANTHROPIC = process.env.ANTHROPIC_API_KEY
const OPENAI = process.env.OPENAI_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
/**
 * Crossed by the reads together, first after the switch, and never by the
 * fixed prefix.
 *
 * Recalibrated at S20.5 against the measured prefix. The estimator puts the
 * header — system, eleven tool schemas with the browser row's five, the skill
 * list — at 3,347 tokens, and the S11 budget of 6,400 put the threshold at
 * 3,200: the prefix ALONE was over it, so the first compaction landed in turn
 * 1 or 2, on DeepSeek, before the switch, and the role assertion could not
 * fail. A first recalibration (threshold 5,500) made EVERY read cross: four
 * compactions a run, so turn 1's marker reached turn 4 only through a chain of
 * re-summaries, and the first live run lost it (2 of 7 summary nodes had
 * carried it, the live one had not). The threshold is now 11,000 (22,000 ×
 * 0.5), placed by the reads' sum:
 *
 *   - step 1 (prefix + one prompt, ~3.5–3.7K priced) sits near a third of it,
 *     and the arc asserts it is below, so the premise fails by name;
 *   - a note read (161 lines, ~2,800 tokens as the editor numbers them) adds
 *     ~2.9K: after turn 2's read ~9.6K, under it by ~1.4K;
 *   - turn 3's read, on Anthropic, takes its second step to ~13K: the one
 *     crossing, after the switch, on the role's route — the compaction the
 *     role assertion reads — and turn 1's marker is summarized once;
 *   - a second read of one note before the switch would cross early, and the
 *     after-the-switch assertion then fails by name.
 *
 * Compaction is this arc's vehicle, not its subject: what it exists to prove
 * is that a route switch is one durable fact, that a role can send the summary
 * somewhere else, and that the mixed log replays.
 */
const BUDGET = 22_000
const THRESHOLD = 0.5
/**
 * The compaction role's route: one the LOOP never takes. It was
 * `deepseek-flash`, the loop's own starting route, so a model-roles that
 * ignored the role sent the summary down the identical route and the arc
 * stayed green. `deepseek-v4-pro` is catalogued text-only, which a summary
 * request never minds; effort `off`, because a summary needs no reasoning and
 * DeepSeek thinks by default, inside the same 1,024-token cap as the answer.
 */
const ROLE = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'off' } as const
/** The Anthropic leg THINKS: Haiku 4.5 on a 2,048-token budget, so a signed thinking block exists to round-trip. */
const ANTHROPIC_ROUTE = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low' } as const

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

    // The deployment's own budget, and a compaction role pointing at a route
    // the loop never takes — plain composition config, no code, no flags.
    writeFileSync(
      join(home, 'composition.json'),
      JSON.stringify({
        patches: [
          { id: 'compaction', config: { budgetTokens: BUDGET, thresholdRatio: THRESHOLD, retainRatio: 0.25, maxTokens: 1024 } },
          { id: 'model-roles', config: { roles: { compaction: ROLE } } },
        ],
      }),
      'utf8',
    )

    // Every prompt of the arc, in order — the replay walks the same path.
    // Each prompt NAMES the editor tool and forbids the shell, for the reason
    // the context arc already carries: "read alpha.txt" is answerable by one
    // `cat`, and until S11 the only thing stopping the model reaching for it
    // was that no host could confine a shell. A confined host runs it happily,
    // which quietly turned this into an arc about tool choice — the exact
    // premise decay ARCHITECTURE §10 warns about, arriving the moment the
    // system got better. What this arc measures is that a route switch is one
    // durable fact, and it may not depend on which tool the model picks.
    const PROMPTS = [
      'Using the file editor tool (not the shell), read alpha.txt and reply with only the marker token it contains.',
      'Using the file editor tool (not the shell), read bravo.txt and reply with only the marker token it contains.',
      'Using the file editor tool (not the shell), read charlie.txt and reply with only the marker token it contains.',
      'List every marker token you have found so far, one per line, and nothing else.',
    ] as const

    const serve = new ServeProcess(workspace, home, { approve: true })
    const init = await serve.request<{ providers: { id: string; models: { id: string; contextWindow: number }[] }[] }>('initialize')
    // Both adapters are mounted, and each advertises its own real windows.
    const deepseek = init.providers.find((provider) => provider.id === 'deepseek')!
    const anthropic = init.providers.find((provider) => provider.id === 'anthropic')!
    expect(deepseek.models.find((model) => model.id === 'deepseek-flash')?.contextWindow).toBe(1_048_576)
    expect(anthropic.models.find((model) => model.id === 'claude-haiku-4-5-20251001')?.contextWindow).toBe(200_000)

    // ---- turn 1 and 2: DeepSeek, with a real tool call --------------------
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', {
      text: PROMPTS[0],
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    await serve.waitForCompletedTurn(sessionId, 1)
    await serve.request('session/prompt', { sessionId, text: PROMPTS[1] })
    await serve.waitForCompletedTurn(sessionId, 2)

    // ---- the switch: same session, same loop, another provider ------------
    const route = await serve.request<{ provider: string; model: string }>('session/model', { sessionId, ...ANTHROPIC_ROUTE })
    expect(route).toMatchObject(ANTHROPIC_ROUTE)

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
      { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 1_048_576, inputModalities: ['text', 'image'] },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', contextWindow: 200_000, inputModalities: ['text', 'image'] },
    ])
    expect(foldRequestContext(events)!.provider).toBe('anthropic')

    // ---- the premise: the prefix alone does not cross the threshold -------
    const firstMessage = events.find((event) => event.type === 'assistant/message' && (event.data as { usage?: unknown }).usage !== undefined)!
    const firstUsage = (firstMessage.data as { usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }).usage
    const stepOnePrompt = firstUsage.inputTokens + (firstUsage.cacheReadTokens ?? 0) + (firstUsage.cacheWriteTokens ?? 0)
    expect(
      stepOnePrompt,
      `step 1 was priced at ${stepOnePrompt} prompt tokens against a ${BUDGET * THRESHOLD} threshold; the fixed prefix has grown — recalibrate BUDGET`,
    ).toBeLessThan(BUDGET * THRESHOLD)

    // ---- mixed history, correctly attributed -------------------------------
    const sources = events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => (event.data as { message: { source: { provider: string; model: string; replayState?: unknown } } }).message.source)
    expect(sources.some((source) => source.provider === 'deepseek')).toBe(true)
    expect(sources.some((source) => source.provider === 'anthropic')).toBe(true)
    // Anthropic's signed thinking rides on its own messages and nowhere else —
    // and there IS some: the leg runs at effort `low`, a budget, so the claim
    // is not an `every` over nothing.
    expect(sources.filter((source) => source.replayState !== undefined).every((source) => source.provider === 'anthropic')).toBe(true)
    const signatureOf = (event: EventEnvelope): string | undefined => {
      const state = (event.data as { message: { source: { replayState?: { blocks?: unknown[] } } } }).message.source.replayState
      const block = state?.blocks?.find((entry) => typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'thinking')
      return block === undefined ? undefined : (block as { signature: string }).signature
    }
    const anthropicMessages = events.filter(
      (event) => event.type === 'assistant/message' && (event.data as { message: { source: { provider?: string } } }).message.source.provider === 'anthropic',
    )
    const signed = anthropicMessages.find((event) => (signatureOf(event) ?? '').length > 0)
    expect(signed, `none of ${anthropicMessages.length} Anthropic message(s) carried a signed thinking block`).toBeDefined()
    // ...and the history the NEXT Anthropic request was built from still
    // serializes it, through the adapter's own serializer. A reconstruction,
    // not the bytes sent: the runtime's own stripping (core/llm/runtime.ts) is
    // not in it, so what holds it to the wire is Anthropic itself, which
    // answers 400 to a tool-use continuation that drops the block.
    const next = anthropicMessages.find((event) => event.seq > signed!.seq)
    expect(next, 'no Anthropic request followed the signed message').toBeDefined()
    const history = foldSurfaceSeqs(events.filter((event) => event.seq < next!.seq))
      .map((seq) => deriveEventMessage(events[seq]!))
      .filter((message): message is Message => message !== null)
    expect(JSON.stringify(serializeAnthropic(history)), 'the stored history no longer serializes the signed thinking block').toContain(signatureOf(signed!)!)
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
    // What the LAST answer could see: the newest applied compaction's replacing
    // message, not every summary the session ever wrote — a token an earlier
    // summary held and a later one dropped is a marker drop, not the model's.
    const lastApplied = events.findLast((event) => event.type === COMPACTION_APPLIED.type)
    const liveSummary = lastApplied === undefined ? undefined : events.find((event) => event.seq > lastApplied.seq && event.type === 'user/message')
    const liveCarried = liveSummary === undefined || JSON.stringify(liveSummary.data).includes('ALPHA-11')
    const offered = events.some(
      (event) => event.type === 'request/header' && ((event.data as { header: { tools?: { name: string }[] } }).header.tools ?? []).some((tool) => tool.name === 'history_read'),
    )
    const recalls = events.filter((event) => event.type === 'tool/call' && (event.data as { name: string }).name === 'history_read').length
    // The two failure shapes this arc has produced are named, because they need
    // different fixes: `marker-drop` (no summary carried the token and recall
    // was never called) is about compaction; `off-instruction` (the token was
    // reachable — carried, or recalled — and the answer still lacks it) is about
    // the model. A passing run says which way it passed.
    const reachable = liveCarried || recalls > 0
    const shape = last.includes('ALPHA-11') ? (recalls > 0 ? 'recalled' : 'carried') : reachable ? 'off-instruction' : 'marker-drop'
    const why =
      `shape: ${shape}; after ${compactionTrace.length} applied compaction(s) shadowing [${compactionTrace.join(', ')}] node(s); ` +
      `${carried} of ${summaries.length} summary node(s) carried ALPHA-11, the live one ${liveCarried ? 'did' : 'did NOT'}; history_read ${offered ? 'offered' : 'NOT offered'}, called ${recalls}x`
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
    // The base route at a given moment: the last request/context before it,
    // which the driver writes before the step's pre-step listeners run.
    const baseAt = (seq: number): string => {
      const context = events.findLast((event) => event.type === 'request/context' && event.seq < seq)!.data as { provider: string; model: string }
      return `${context.provider}/${context.model}`
    }
    const switchSeq = events.find((event) => event.type === AGENT_OPTIONS.type && (event.data as { reason: string }).reason === 'change')!.seq
    // Every summary went down the ROLE's route, never the base route of the
    // moment, and the log names it.
    for (const event of applied) {
      const record = event.data as { budgetTokens: number; auxCallSeq: number }
      expect(record.budgetTokens).toBe(BUDGET)
      expect(events[record.auxCallSeq]!.type).toBe(LLM_AUX_CALL.type)
      const aux = events[record.auxCallSeq]!.data as AuxCallRecord
      expect(aux.purpose).toBe('compaction')
      expect(`${aux.provider}/${aux.model}`, `compaction at seq ${event.seq}`).toBe(`${ROLE.provider}/${ROLE.model}`)
      expect(baseAt(event.seq), `compaction at seq ${event.seq} ran on the loop's own route`).not.toBe(`${ROLE.provider}/${ROLE.model}`)
      expect(aux.usage!.inputTokens + (aux.usage!.cacheReadTokens ?? 0)).toBeGreaterThan(0)
    }
    // And at least one ran AFTER the switch, while the loop was on Anthropic:
    // the summary went to a different PROVIDER from the loop's own at that moment.
    const afterSwitch = applied.filter((event) => event.seq > switchSeq)
    expect(
      afterSwitch.map((event) => baseAt(event.seq)),
      `no compaction applied after the switch at seq ${switchSeq}; attempts [${attempts.join(', ')}] at seqs ${applied.map((event) => event.seq).join(', ')}`,
    ).toContain(`${ANTHROPIC_ROUTE.provider}/${ANTHROPIC_ROUTE.model}`)

    // ---- the mixed log is still its own oracle ------------------------------
    const replayWorkspace = tempDir('minidsh-e2e6-replay-ws-')
    seedWorkspace(replayWorkspace)
    const file = loadCompositionFile(join(home, 'composition.json'))!
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    let replayedEvents: EventEnvelope[] = []
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-e2e6-replay-'),
      // What `serve` mounted: the recorded requests carry its skill list.
      skillRoots: skillRootsFor(home),
      browserProfileRoot: join(home, 'browser-replay'),
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
      const handle = await root.get(AGENTS).create(root, { cwd: replayWorkspace, agentOptions: { provider: 'deepseek', model: 'deepseek-flash' } })
      // The same prompts, in order, with the SAME switch at the same point:
      // the replayed session walks the path the recording walked.
      for (const [index, text] of PROMPTS.entries()) {
        if (index === 2) handle.agent.configure(ANTHROPIC_ROUTE)
        handle.agent.followup(createUserMessage(text))
        await handle.agent.whenIdle()
      }
      // Both routes were recorded, and both were replayed from one script.
      replayedEvents = handle.agent.session.events.slice()
      const replayedContexts = replayedEvents.filter((event) => event.type === 'request/context').map((event) => (event.data as { provider: string }).provider)
      expect(replayedContexts).toEqual(['deepseek', 'anthropic'])
      await handle.dispose()
    } finally {
      await root.dispose()
    }
    expect(replayHandle!.providers.toSorted()).toEqual(['anthropic', 'deepseek'])
    expect(replayHandle!.auxCalls).toBeGreaterThanOrEqual(1)
    replayHandle!.assertConsumed()
    // A pristine workspace was read the same way it was read live — the read
    // itself, not the seed. (`seedWorkspace` above wrote ALPHA-11 into this
    // very file, so asserting the file's contents could not fail.)
    const replayedResults = replayedEvents.filter((event) => event.type === 'tool/result')
    expect(replayedResults.some((event) => JSON.stringify(event.data).includes('ALPHA-11')), 'the replayed session never read alpha.txt back').toBe(true)
  })
})

/**
 * The S18 OpenAI leg: a third provider through the same unchanged loop, on the
 * Responses API, with the two things that make that wire different from the
 * other two proved where they matter.
 *
 *   route as a fact      DeepSeek → OpenAI → DeepSeek over the wire, one
 *                        `agent/options{change}` per switch, a `request/context`
 *                        per route carrying each provider's real input window
 *   encrypted reasoning  an OpenAI step that calls a tool carries its reasoning
 *                        item's `encrypted_content` in the envelope, and the
 *                        follow-up request of the SAME step is built with it.
 *                        The API returns 200 whether or not it is sent
 *                        (measured 2026-10-16), so this is asserted on the real
 *                        serializer, offline, over the recorded history
 *   an image in a tool result  `view_image` on OpenAI: the PNG the test drew
 *                        inside `function_call_output`, read back in drawn order
 *   foreign history      OpenAI over DeepSeek's turn (its reasoning dropped),
 *                        DeepSeek over OpenAI's (the image still in the tool
 *                        message)
 *   replay               the three-route log replays keylessly and the image
 *                        path really runs again
 *
 * The model is the cheapest that exercises BOTH premises, measured 2026-10-16
 * with this leg's own fixture and prompts, four trials each: gpt-5.4-mini read
 * the drawn quadrants inside a tool output 4/4 and reasoned before its call
 * 4/4. gpt-6-luna (cheaper) misread the quadrants in every trial, gpt-5.6-luna
 * read them 1 time in 4, and gpt-5-nano passed both but its only snapshot shuts
 * down 2026-12-11 — a gate built on it would rot by itself. Effort `high`, and
 * a turn-2 prompt that makes the model decide, because a bare "read bravo.txt"
 * went straight to the tool with no reasoning item to carry.
 *
 * Requires DEEPSEEK_API_KEY and OPENAI_API_KEY; skipped otherwise. A LOCAL
 * gate: live.yml carries no OpenAI secret (ARCHITECTURE §10).
 */
const OPENAI_MODEL = 'gpt-5.4-mini'
const QUAD_PX = 96

describe.skipIf(!DEEPSEEK || !OPENAI)('S18 live E2E: an OpenAI leg through the same loop', () => {
  it('routes DeepSeek → OpenAI → DeepSeek, carries encrypted reasoning through a tool step, reads an image in a tool result, and replays', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-e2e18-ws-')
    const home = tempDir('minidsh-e2e18-home-')
    seedWorkspace(workspace)
    const png = quadPng(QUAD_PX)
    writeFileSync(join(workspace, 'quad.png'), png)
    // No compaction budget: a summary between the tokens and the last answer
    // would confound what this leg measures (asserted absent below).
    writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ insert: [{ id: 'tool-view-image', plugin: 'tool-view-image' }] }] }), 'utf8')

    // Turn 2 makes the model DECIDE before it calls: measured 2026-10-16, a
    // bare "read bravo.txt" went straight to the tool with no reasoning item
    // (gpt-6-luna, 0 of 3 at `high` and `xhigh`), so the step this leg exists
    // for had nothing to carry; this wording reasoned first every time. The
    // premise is the model's, and it is pinned in the words.
    const PROMPTS = [
      'Using the file editor tool (not the shell), read alpha.txt and reply with only the marker token it contains.',
      'The workspace holds alpha.txt, bravo.txt and charlie.txt; each contains one marker token whose first letter matches the first letter of its file name. Work out which single file holds the marker that starts with B, read ONLY that file with the file editor tool (not the shell), and reply with only the marker token.',
      'Call the view_image tool on quad.png, then reply with its four quadrant colours in the order top-left, top-right, bottom-left, bottom-right, as one comma-separated line of four lowercase colour words and nothing else.',
      'List every marker token you have found so far in this conversation, one per line, and nothing else.',
    ] as const
    const OPENAI_ROUTE = { provider: 'openai', model: OPENAI_MODEL, reasoningEffort: 'high' } as const
    const DEEPSEEK_ROUTE = { provider: 'deepseek', model: 'deepseek-flash' } as const

    const serve = new ServeProcess(workspace, home, { approve: true })
    const init = await serve.request<{ providers: { id: string; models: { id: string; contextWindow: number; inputModalities?: string[] }[] }[] }>('initialize')
    const advertised = init.providers.find((provider) => provider.id === 'openai')?.models.find((model) => model.id === OPENAI_MODEL)
    expect(advertised, 'the OpenAI adapter is mounted by default and lists the validation model').toMatchObject({ contextWindow: 272_000, inputModalities: ['text', 'image'] })

    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: PROMPTS[0], agentOptions: DEEPSEEK_ROUTE })
    await serve.waitForCompletedTurn(sessionId, 1)
    await serve.request('session/model', { sessionId, ...OPENAI_ROUTE })
    await serve.request('session/prompt', { sessionId, text: PROMPTS[1] })
    await serve.waitForCompletedTurn(sessionId, 2)
    await serve.request('session/prompt', { sessionId, text: PROMPTS[2] })
    await serve.waitForCompletedTurn(sessionId, 3)
    await serve.request('session/model', { sessionId, ...DEEPSEEK_ROUTE })
    await serve.request('session/prompt', { sessionId, text: PROMPTS[3] })
    await serve.waitForCompletedTurn(sessionId, 4)
    const events = (await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })).events
    await serve.shutdown()

    const turnOf = (seq: number): number => {
      let turn = 0
      for (const event of events) {
        if (event.seq > seq) break
        if (event.type === 'turn/start') turn = (event.data as { turn: number }).turn
      }
      return turn
    }
    const ended = events.filter((event) => event.type === 'turn/end').map((event) => (event.data as { reason: { kind: string } }).reason.kind)
    expect(ended, 'every turn completed').toEqual(['completed', 'completed', 'completed', 'completed'])

    // ---- the route is one durable fact per switch ---------------------------
    const options = events.filter((event) => event.type === AGENT_OPTIONS.type).map((event) => event.data as { options: { provider: string }; reason: string })
    expect(options.map((record) => [record.reason, record.options.provider])).toEqual([
      ['initial', 'deepseek'],
      ['change', 'openai'],
      ['change', 'deepseek'],
    ])
    const contexts = events.filter((event) => event.type === 'request/context').map((event) => event.data as { provider: string; model: string; contextWindow?: number; inputModalities?: string[] })
    expect(contexts).toEqual([
      { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 1_048_576, inputModalities: ['text', 'image'] },
      { provider: 'openai', model: OPENAI_MODEL, contextWindow: 272_000, inputModalities: ['text', 'image'] },
      { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 1_048_576, inputModalities: ['text', 'image'] },
    ])
    expect(events.filter((event) => event.type === COMPACTION_START.type), 'no summary stands between the tokens and the answers').toHaveLength(0)

    // ---- envelopes ride their own provider's messages only ------------------
    type Envelope = { response: { kind?: string }; blocks?: ({ type: string; encrypted_content?: string } | null)[] }
    type Source = { provider: string; model: string; replayState?: Envelope }
    const assistants = events
      .filter((event) => event.type === 'assistant/message')
      .map((event) => {
        const message = (event.data as { message: Message }).message
        return { seq: event.seq, message, source: message.source as unknown as Source, usage: (event.data as { usage?: Record<string, number> }).usage }
      })
    const openaiMessages = assistants.filter((entry) => entry.source.provider === 'openai')
    expect(openaiMessages.length, 'OpenAI answered turns 2 and 3').toBeGreaterThanOrEqual(2)
    const enveloped = assistants.filter((entry) => entry.source.replayState?.response.kind === 'openai')
    expect(enveloped.length, 'no OpenAI envelope was recorded at all').toBeGreaterThan(0)
    expect(enveloped.every((entry) => entry.source.provider === 'openai')).toBe(true)
    const hasEncrypted = (entry: (typeof assistants)[number]): boolean =>
      entry.source.replayState?.blocks?.some((block) => block?.type === 'reasoning' && typeof block.encrypted_content === 'string') === true
    const callStep = openaiMessages.find((entry) => turnOf(entry.seq) === 2 && entry.message.content.some((block) => block.type === 'tool-call'))
    const why =
      `OpenAI messages ${openaiMessages.length}, with encrypted reasoning ${openaiMessages.filter(hasEncrypted).length}; ` +
      `turn-2 tool step ${callStep === undefined ? 'MISSING' : `at seq ${callStep.seq}`}; usage ${JSON.stringify(openaiMessages.map((entry) => entry.usage))}`
    console.log(`[routing openai] ${why}`)
    expect(callStep, `OpenAI's turn 2 made no tool call — ${why}`).toBeDefined()
    expect(callStep!.source.replayState?.response.kind, 'the tool step carries no OpenAI envelope').toBe('openai')
    expect(hasEncrypted(callStep!), `the tool step carried no encrypted reasoning — ${why}`).toBe(true)

    // ---- the follow-up request of that step, built offline by the real serializer
    const surfaceUpTo = (seq: number): Message[] =>
      events
        .filter((event) => event.seq < seq && (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'))
        .map((event) => restoreMessage((event.data as { message: Message }).message))
    const followUp = events.find((event) => event.type === 'assistant/message' && event.seq > callStep!.seq && turnOf(event.seq) === 2)
    expect(followUp, 'the tool step had no follow-up answer').toBeDefined()
    const items = serializeOpenAI(surfaceUpTo(followUp!.seq), new Map(), OPENAI_MODEL) as unknown as { type?: string; encrypted_content?: string; call_id?: string; id?: string }[]
    const envelope = callStep!.source.replayState!.blocks!.find((block) => block?.type === 'reasoning')!
    const call = callStep!.message.content.find((block) => block.type === 'tool-call') as { id: string }
    expect(items.some((item) => item.type === 'reasoning' && item.encrypted_content === envelope.encrypted_content), 'the step\'s own encrypted reasoning went back with its call').toBe(true)
    expect(items.some((item) => item.type === 'function_call' && item.call_id === call.id && item.id?.startsWith('fc_') === true), 'the call went back with its item id').toBe(true)
    expect(items.some((item) => item.type === 'function_call_output' && item.call_id === call.id)).toBe(true)
    // The family rule on the recorded history: the SAME messages serialized for
    // another catalogued model carry no reasoning item and no item id — the
    // sealed reasoning goes back only to the model that wrote it.
    const elsewhere = serializeOpenAI(surfaceUpTo(followUp!.seq), new Map(), 'gpt-6-sol') as unknown as { type?: string; id?: string }[]
    expect(elsewhere.filter((item) => item.type === 'reasoning'), 'reasoning crossed to another model').toHaveLength(0)
    expect(elsewhere.filter((item) => item.id !== undefined), 'an item id crossed to another model').toHaveLength(0)

    // ---- the world: what OpenAI read, and what DeepSeek read back ------------
    const texts = assistantTexts(events)
    const finalOf = (turn: number): string => {
      const index = assistants.map((entry, position) => ({ entry, position })).filter(({ entry }) => turnOf(entry.seq) === turn).at(-1)!.position
      return texts[index]!.toLowerCase()
    }
    expect(finalOf(2)).toContain('bravo-22')
    const colours = finalOf(3)
    const positions = QUADRANT_COLOURS.map((colour) => colours.indexOf(colour))
    const inOrder = positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]!)
    expect(inOrder, `OpenAI answered "${colours}"; the test drew ${QUADRANT_COLOURS.join(', ')}`).toBe(true)
    expect(finalOf(4)).toContain('alpha-11')
    expect(finalOf(4)).toContain('bravo-22')

    // DeepSeek's turn-4 request still shows OpenAI's tool result as the image itself.
    const digest = createHash('sha256').update(png).digest('hex')
    const object = join(home, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
    expect(existsSync(object), 'view_image committed the drawn PNG').toBe(true)
    const turn4 = events.find((event) => event.type === 'turn/start' && (event.data as { turn: number }).turn === 4)!
    const history = surfaceUpTo(turn4.seq)
    const imageRef = history
      .flatMap((message) => message.content)
      .flatMap((block) => (block.type === 'tool-result' ? block.content : []))
      .find((block): block is Extract<Message['content'][number], { type: 'image' }> => block.type === 'image')
    expect(imageRef, 'an image reached history through OpenAI\'s tool result').toBeDefined()
    const images = new Map<string, ResolvedImage>([[imageRef!.attachment.id, { ref: imageRef!.attachment, data: readFileSync(object) }]])
    const deepseekWire = serializeDeepSeek(undefined, history, images)
    expect(deepseekWire.some((message) => message.role === 'tool' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))).toBe(true)

    // ---- the three-route log is its own oracle, image path included ---------
    const replayWorkspace = tempDir('minidsh-e2e18-replay-ws-')
    seedWorkspace(replayWorkspace)
    writeFileSync(join(replayWorkspace, 'quad.png'), png)
    const replayAttachments = tempDir('minidsh-e2e18-replay-attachments-')
    const file = loadCompositionFile(join(home, 'composition.json'))!
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-e2e18-replay-'),
      // What `serve` mounted: the recorded requests carry its skill list.
      skillRoots: skillRootsFor(home),
      browserProfileRoot: join(home, 'browser-replay'),
      attachmentsRoot: replayAttachments,
      approve: true,
      logger: silent,
      patches: [
        { id: 'llm-deepseek', disabled: true },
        { id: 'llm-anthropic', disabled: true },
        { id: 'llm-openai', disabled: true },
      ],
      configLayers: [{ name: 'home', patches: await toPatches(file, home) }],
      prepare: (context) => {
        replayHandle = installLlmReplay(context, { events })
      },
    })
    try {
      const handle = await root.get(AGENTS).create(root, { cwd: replayWorkspace, agentOptions: DEEPSEEK_ROUTE })
      for (const [index, text] of PROMPTS.entries()) {
        if (index === 1) handle.agent.configure(OPENAI_ROUTE)
        if (index === 3) handle.agent.configure(DEEPSEEK_ROUTE)
        handle.agent.followup(createUserMessage(text))
        await handle.agent.whenIdle()
      }
      const replayed = handle.agent.session.events.filter((event) => event.type === 'request/context').map((event) => (event.data as { provider: string }).provider)
      expect(replayed).toEqual(['deepseek', 'openai', 'deepseek'])
      await handle.dispose()
    } finally {
      await root.dispose()
    }
    expect(replayHandle!.providers.toSorted()).toEqual(['deepseek', 'openai'])
    replayHandle!.assertConsumed()
    expect(existsSync(join(replayAttachments, 'v1', 'objects', digest.slice(0, 2), digest)), 'the replay never re-read the image, so its image path never ran').toBe(true)
  })
})
