/**
 * The S5 live end-to-end: a long session stays inside a context budget without
 * the log losing anything.
 *
 * One arc, four claims, all against the real DeepSeek API through `minidsh
 * serve` over real stdio:
 *
 *   instructions  an AGENTS.md in the workspace changes what the model does —
 *                 asserted from its own final answer, not from the log
 *   metering      the session's projected request is measured from durable
 *                 usage and stays under the budget it was given
 *   compaction    the budget is really crossed, a summary really replaces a
 *                 range, and every shadowed event is still in the log
 *   spill         a command's output too large to show inline is saved, and the
 *                 model retrieves a value only present in the omitted middle
 *
 * Then the fresh log replays keylessly under the SAME disk composition, with
 * both replay cursors drained — so the recorded compaction happened again, at
 * the same point, with the same summary.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { COMPACTION_APPLIED } from '../core/compaction/index.ts'
import { LLM_AUX_CALL, type AuxCallRecord } from '../core/llm/index.ts'
import { meterSession } from '../core/metering/index.ts'
import { foldSurfaceSeqs, REQUEST_HEADER, type EventEnvelope } from '../core/session/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { installLlmReplay, recordedRoute } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { loadCompositionFile, toPatches } from './config.ts'
import { applyAuthority, bootComposition, type BootOptions } from './headless.ts'
import { skillRootsFor } from './home.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
const pwsh = process.platform === 'win32'

/**
 * The budget the whole arc is measured against. Low enough that reading a
 * single bulky file already crosses the threshold.
 *
 * That is only true if the file is actually READ, which is why the prompts
 * below name the editor tool and forbid both `view_range` and a shell search.
 * They used to say "read notes-b.txt and reply with the marker token", and a
 * marker token is exactly what a `Select-String` finds in one cheap line: one
 * live run answered all three prompts that way, finished the whole arc in 16
 * seconds instead of 45, wrote a correct summary.txt — and never crossed the
 * threshold at all, so nothing compacted and the arc failed with `0 summary
 * call(s)`. The claim this file makes is about context management, not about
 * how a model chooses to search, so the search is spelled out and the claim
 * is left to stand on its own.
 *
 * The numbers, from what the first request really costs (S20.5): deepseek-flash
 * priced the first request of this composition — browser row included — at
 * about 3,650 prompt tokens, of which the estimator's header is 2,802 (tools
 * 2,579, the five browser tools 1,386 of them). At the S11 budget of 8,000 that
 * prefix alone filled 88% of the 4,000 threshold, so the "crossing" was schema
 * weight, not history. Now:
 *
 *   - threshold 8,000 (16,000 × 0.5): step 1 sits near 46% of it, asserted
 *     below 60% so this premise fails BY NAME the next time the prefix grows;
 *   - one note read is ~5,600 estimator tokens (300 lines, 22,443 characters as
 *     the editor numbers them, shown whole by an editor allowed 32,000), so a
 *     single bulky read takes the next step to ~9,250 — a clear ~115–125%;
 *   - the post-compaction floor is header + re-entered rules + summary (≤ 2,048)
 *     + tail: the planner does not subtract the header (A5-9), so it is ~4–5.5K,
 *     well under the threshold, and pressure does not re-fire at every step;
 *   - `retainRatio` 0.25 caps the kept tail at a quarter of the live surface,
 *     below one note. A crossing found at a turn boundary shadows the read it
 *     follows; one found at the pre-step right after the read keeps that open
 *     turn and shadows only earlier ones, so the read goes at the NEXT
 *     compaction (the second Windows run of S20.5 compacted turn 1 alone first);
 *   - the peak a compaction cannot avoid (the floor plus one note) is ~10–12K,
 *     under the 16,000 budget the arc's last assertion holds it to.
 */
const BUDGET = 16_000
const THRESHOLD = 0.5
/** One note: shown whole by the editor (its default cap of 16,000 characters would cut it near line 210). */
const NOTE_LINES = 300
const EDITOR_MAX_CHARS = 32_000
const MARKER_PHRASE = 'THE MARKER FOR THIS FILE IS'
const MARKER = '# BLUEBERRY-7'
/** Row 450 of the generated output: only reachable from the spilled middle. */
const NEEDLE = `row-450:${450 * 7}`
const GENERATE = pwsh ? '1..900 | ForEach-Object { "row-$($_):$($_*7)" }' : 'for i in $(seq 1 900); do echo "row-$i:$((i*7))"; done'

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

/** A file big enough that reading it is a real context cost, with one findable marker. */
function bulkNote(marker: string): string {
  const filler = Array.from({ length: NOTE_LINES }, (_unused, index) => `note line ${index}: routine project background, nothing important here.`)
  filler.splice(NOTE_LINES / 2, 0, `${MARKER_PHRASE} ${marker}`)
  return `${filler.join('\n')}\n`
}

/** The world both the recorded run and the replay start from. */
function seedWorkspace(dir: string): void {
  writeFileSync(
    join(dir, 'AGENTS.md'),
    `# Project conventions

Every file you create in this repository MUST begin with this exact header line:

${MARKER}

Write that line first, then the file's real content.
`,
    'utf8',
  )
  writeFileSync(join(dir, 'notes-a.txt'), bulkNote('ALPHA-11'), 'utf8')
  writeFileSync(join(dir, 'notes-b.txt'), bulkNote('BRAVO-22'), 'utf8')
  writeFileSync(join(dir, 'notes-c.txt'), bulkNote('CHARLIE-33'), 'utf8')
  writeFileSync(join(dir, 'decoy.txt'), 'must never change\n', 'utf8')
}

/** Every note prompt: the whole file, through the editor, and no cheaper route. */
function readWholeFile(file: string): string {
  return (
    `Using the file editor tool, view the entire contents of ${file} in one call — do not pass view_range, ` +
    `and do not search the file from the shell. Then reply with only the marker token it contains.`
  )
}

const FIRST_PROMPT = readWholeFile('notes-a.txt')

describe.skipIf(!KEY)('S5 live E2E: a long session stays in budget without the log losing anything', () => {
  it('crosses a real context budget, compacts, spills, obeys AGENTS.md, and replays', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-e2e5-ws-')
    const home = tempDir('minidsh-e2e5-home-')

    // A repository telling the model how it likes its answers — context only.
    seedWorkspace(workspace)
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const decoy = join(workspace, 'decoy.txt')
    const decoyBytes = readFileSync(decoy)

    // The deployment's own context budget, and a shell tool that shows little
    // inline — both plain composition config, no code and no flags.
    //
    // `maxSummaryFailures` is raised because this arc deliberately runs at a
    // budget where a compaction can be worth nothing: the pressure trigger
    // fires whenever the surface crosses the threshold, but where the planner's
    // cut lands is the model's tool shape, and a small shadowed head is
    // legitimately refused (a summary at least as large as the span it would
    // replace is not a compaction). Measured over six live runs, 14 of 34
    // attempts produced nothing while every run still landed at least three.
    // At the shipped default of 2, two such refusals in a row would switch
    // automatic compaction off for the remaining turns and this arc would then
    // assert against a runtime that had correctly given up. The give-up counter
    // itself is pinned in `compaction-basic/loop.test.ts`; what this arc is for
    // is that a crossing really compacts and the log keeps everything.
    writeFileSync(
      join(home, 'composition.json'),
      JSON.stringify({
        patches: [
          { id: 'compaction', config: { budgetTokens: BUDGET, thresholdRatio: THRESHOLD, retainRatio: 0.25, maxTokens: 2048, maxSummaryFailures: 6 } },
          { id: 'tool-shell', config: { maxOutputChars: 700, tailChars: 150 } },
          { id: 'tool-editor', config: { maxOutputChars: EDITOR_MAX_CHARS } },
        ],
      }),
      'utf8',
    )

    const serve = new ServeProcess(workspace, home, { approve: true })
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: FIRST_PROMPT })
    // This run needs a shell that works on EVERY platform, and only one mode
    // does: a Linux or macOS host confines and would run the command under
    // `workspace-write`, while a Windows host has no backend and would refuse
    // it, spending a round trip on consent per command. The arc is about
    // context pressure, not about authority — the authority arc is where the
    // difference between those hosts is the subject.
    await serve.request('session/authority', { sessionId, sandbox: 'danger-full-access' })
    await serve.waitForCompletedTurn(sessionId, 1)

    const prompts = [
      readWholeFile('notes-b.txt'),
      readWholeFile('notes-c.txt'),
      `Run this exact command in the shell: ${GENERATE}\nThen tell me the full text of the line that starts with "row-450:". If the output was too long to show inline, read the saved file to find it.`,
      `Finally, write a file named summary.txt in the workspace that lists the three marker tokens you found, one per line, following this project's own file conventions. Then confirm what you wrote.`,
    ]
    for (const [index, text] of prompts.entries()) {
      await serve.request('session/prompt', { sessionId, text })
      await serve.waitForCompletedTurn(sessionId, index + 2)
    }

    const log = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    await serve.shutdown()
    const events = log.events

    // ---- the WORLD -------------------------------------------------------
    const summary = readFileSync(join(workspace, 'summary.txt'), 'utf8')
    expect(summary).toContain('ALPHA-11')
    expect(summary).toContain('BRAVO-22')
    expect(summary).toContain('CHARLIE-33')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)

    // ---- workspace instructions -------------------------------------------
    const injected = events.filter(
      (event) =>
        event.type === 'user/message' && (event.data as { message: { source: { form?: string } } }).message.source.form === 'workspace-instructions',
    )
    expect(injected.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(injected[0]!.data)).toContain(MARKER)
    // It reached the model and changed what it DID: the file it wrote carries a
    // header no prompt in this arc ever asked for. Behaviour, not self-report.
    // Two independent proofs, because one of them depends on the model's own
    // judgement. The model must have READ the rule to name its token at all —
    // no prompt in this arc ever mentions it — and it must have ACTED on it for
    // the file to carry a header nobody asked for.
    // The model NAMED the token in its own words — which it could only do
    // having read the injected rule, since no prompt in this arc mentions it.
    // (Serializing `events` proved nothing: the injected message is IN events,
    // so the assertion above already implied it.)
    expect(assistantTexts(events).some((text) => text.includes(MARKER)), 'no answer ever named the workspace rule token').toBe(true)
    expect(summary.trimStart().startsWith(MARKER), `summary.txt was:
${summary}
--- last answer:
${assistantTexts(events).at(-1)}`).toBe(true)

    // ---- the premise: HISTORY crossed the budget, not the fixed prefix -------
    // Step 1 is the prefix plus one prompt; if it is already near the
    // threshold, a crossing proves nothing about reading (see BUDGET above).
    const firstMessage = events.find((event) => event.type === 'assistant/message' && (event.data as { usage?: unknown }).usage !== undefined)!
    const firstUsage = (firstMessage.data as { usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }).usage
    const stepOnePrompt = firstUsage.inputTokens + (firstUsage.cacheReadTokens ?? 0) + (firstUsage.cacheWriteTokens ?? 0)
    expect(
      stepOnePrompt,
      `step 1 was priced at ${stepOnePrompt} prompt tokens against a ${BUDGET * THRESHOLD} threshold (premise: below ${0.6 * BUDGET * THRESHOLD}); the fixed prefix has grown — recalibrate BUDGET`,
    ).toBeLessThan(0.6 * BUDGET * THRESHOLD)

    // ---- compaction --------------------------------------------------------
    const applied = events.filter((event) => event.type === COMPACTION_APPLIED.type)
    // The two ways this can be zero are different failures and the message has
    // to tell them apart: no summary call at all means the threshold was never
    // crossed (the model read less than the arc assumes), while summary calls
    // with nothing applied means every one of them was declined or raced.
    const summaryCalls = events.filter((event) => event.type === LLM_AUX_CALL.type).length
    expect(
      applied.length,
      `projected ${meterSession(events, BUDGET).projectedTokens} against a ${BUDGET} budget, after ${summaryCalls} summary call(s)`,
    ).toBeGreaterThanOrEqual(1)
    const record = applied[0]!.data as {
      trigger: string
      budgetTokens: number
      projectedTokens: number
      surfaceTokensBefore: number
      surfaceTokensAfter: number
      shadowedSeqs: number[]
      auxCallSeq: number
    }
    expect(record.trigger).toBe('pressure')
    expect(record.budgetTokens).toBe(BUDGET)
    expect(record.projectedTokens).toBeGreaterThan(BUDGET * THRESHOLD)
    // The two surface numbers share a unit and include the summary that replaced
    // the range, so the pair is a real before/after rather than a subtraction
    // across two scales.
    expect(record.surfaceTokensAfter).toBeLessThan(record.surfaceTokensBefore)
    expect(record.surfaceTokensAfter).toBeGreaterThan(0)
    expect(record.shadowedSeqs.length).toBeGreaterThan(1)
    // What it compacted was a READ: it lands after the first note read, and
    // the range it shadows holds a note's result — the bulk that crossed.
    const noteReads = events.filter((event) => event.type === 'tool/result' && JSON.stringify(event.data).includes(MARKER_PHRASE))
    expect(noteReads.length, 'no tool result ever carried a note: the model never read one').toBeGreaterThan(0)
    expect(applied[0]!.seq, 'the first compaction came before any note was read').toBeGreaterThan(noteReads[0]!.seq)
    // A note's bulk is what compaction relieved — by the first compaction at a
    // turn boundary, or by the next one when the first came mid-turn.
    const shadowed = applied.flatMap((event) => (event.data as { shadowedSeqs: number[] }).shadowedSeqs)
    expect(
      noteReads.some((read) => shadowed.includes(read.seq)),
      `${applied.length} compaction(s) shadowed ${shadowed.join(', ')} and no note read (${noteReads.map((read) => read.seq).join(', ')})`,
    ).toBe(true)

    // The replace cites every node it shadowed, and the log still holds them all.
    const replace = events.find((event) => event.seq > applied[0]!.seq && event.surfaceOp?.op === 'replace')!
    expect([...(replace.sourceEventSeqs ?? [])].toSorted((a, b) => a - b)).toEqual([...record.shadowedSeqs].toSorted((a, b) => a - b))
    const live = new Set(foldSurfaceSeqs(events))
    for (const seq of record.shadowedSeqs) {
      expect(events[seq]).toBeDefined()
      expect(live.has(seq)).toBe(false)
    }
    // Nothing was rewritten or renumbered.
    expect(events.every((event, index) => event.seq === index)).toBe(true)

    // ---- the shadowed range is addressable ---------------------------------
    //
    // The summary the model reads names the seqs it replaced and the tool that
    // reads them back, so a fact the summary dropped is recoverable instead of
    // being a turn the model answers with "I have no context from earlier".
    const summaryText = JSON.stringify((replace.data as { message: { content: { type: string; text?: string }[] } }).message.content)
    expect(summaryText).toContain('Log seqs')
    expect(summaryText).toContain('history_read')
    // And it cost nothing before it could do anything: the tool is absent from
    // every request built before the first applied compaction and present after.
    const headerTools = (event: EventEnvelope): string[] =>
      ((event.data as { header: { tools: { name: string }[] } }).header.tools ?? []).map((tool) => tool.name)
    const headers = events.filter((event) => event.type === REQUEST_HEADER.type)
    const firstHeader = headers[0]!
    expect(firstHeader.seq).toBeLessThan(applied[0]!.seq)
    expect(headerTools(firstHeader)).not.toContain('history_read')
    const afterCompaction = headers.filter((event) => event.seq > applied[0]!.seq)
    expect(afterCompaction.length, 'no request was built after the compaction').toBeGreaterThan(0)
    expect(headerTools(afterCompaction[0]!)).toContain('history_read')
    // The rules are never DUPLICATED in what the model sees. Re-entry happens
    // at the next step boundary, so a compaction in the final step of the final
    // turn legitimately leaves them shadowed — there is no later request for
    // them to be missing from. That the written file carries the header is the
    // proof they were live when it mattered.
    expect(injected.filter((event) => live.has(event.seq)).length).toBeLessThanOrEqual(1)
    // The model's history really is smaller than the history that happened.
    const surfaceEvents = events.filter((event) => event.surfaceOp !== undefined)
    expect(live.size).toBeLessThan(surfaceEvents.length)

    // The summary came from a real out-of-loop model call, joined by seq.
    const auxCall = events[record.auxCallSeq]!
    expect(auxCall.type).toBe(LLM_AUX_CALL.type)
    const aux = auxCall.data as AuxCallRecord
    expect(aux.purpose).toBe('compaction')
    expect(aux.usage?.inputTokens).toBeGreaterThan(0)
    expect(aux.outcome.kind).toBe('text')
    // It logged no chunks under any turn/step, which is what keeps replay honest.
    expect(events.filter((event) => event.type === 'assistant/chunk' && (event.data as { turn?: number }).turn === undefined)).toHaveLength(0)

    // ---- metering ----------------------------------------------------------
    const metrics = meterSession(events, BUDGET)
    expect(metrics.sessionInput + metrics.sessionCacheRead).toBeGreaterThan(0)
    // Whatever happened, the session did not end up asking for more than it may.
    expect(metrics.projectedTokens).toBeLessThan(BUDGET)

    // ---- spill -------------------------------------------------------------
    const spillSessions = readdirSync(join(home, 'spill'))
    expect(spillSessions.length).toBeGreaterThanOrEqual(1)
    const spillFiles = spillSessions.flatMap((dir) => readdirSync(join(home, 'spill', dir)).map((file) => join(home, 'spill', dir, file)))
    expect(spillFiles.length).toBeGreaterThanOrEqual(1)
    const saved = spillFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(saved).toContain(NEEDLE)
    // The transcript kept only the excerpt: the needle was NOT shown inline.
    const shellResults = events.filter((event) => event.type === 'tool/result').map((event) => JSON.stringify(event.data))
    const excerpts = shellResults.filter((text) => text.includes('characters omitted'))
    expect(excerpts.length).toBeGreaterThanOrEqual(1)
    expect(excerpts.some((text) => text.includes(NEEDLE))).toBe(false)
    // …and the model reported it anyway.
    expect(assistantTexts(events).some((text) => text.includes(NEEDLE))).toBe(true)
    // That alone is not evidence it READ the file: the prompt hands over the
    // generating expression ($((i*7))), so `row-450:3150` is one multiplication
    // away from what the model already has. The read itself is the claim, so
    // the read is what is asserted — a call naming the saved file by name.
    const spillNames = new Set(spillFiles.map((file) => basename(file)))
    const reads = events
      .filter((event) => event.type === 'tool/call')
      .map((event) => (event.data as { arguments?: string }).arguments ?? '')
      .filter((args) => [...spillNames].some((name) => args.includes(name)))
    expect(reads.length, `no tool call named any of ${[...spillNames].join(', ')}: the needle could have come from the prompt's own formula`).toBeGreaterThan(0)

    // ---- the log is still its own oracle ------------------------------------
    // A pristine copy of the workspace, so the replayed run meets the world the
    // recording met rather than the one the recording left behind.
    const replayWorkspace = tempDir('minidsh-e2e5-replay-ws-')
    seedWorkspace(replayWorkspace)
    const file = loadCompositionFile(join(home, 'composition.json'))!
    const boot: BootOptions = {
      sandbox: 'danger-full-access',
      approve: true,
      sessionsRoot: tempDir('minidsh-e2e5-replay-'),
      // What `serve` mounted: the recorded requests carry its skill list.
      skillRoots: skillRootsFor(home),
      browserProfileRoot: join(home, 'browser-replay'),
      spillRoot: tempDir('minidsh-e2e5-replay-spill-'),
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      configLayers: [{ name: 'home', patches: await toPatches(file, home) }],
      prepare: (context) => {
        replayHandle = installLlmReplay(context, { events, contextWindow: BUDGET })
      },
    }
    const root = await bootComposition(boot)
    try {
      const handle = await root.get(AGENTS).create(root, {
        cwd: replayWorkspace,
        // The route the recording ran on, never a literal (A8-11).
        agentOptions: recordedRoute(events),
      })
      applyAuthority(root, handle, boot)
      // Every recorded prompt in order, so the replayed session walks the same path.
      for (const text of [FIRST_PROMPT, ...prompts]) {
        handle.agent.followup(createUserMessage(text))
        await handle.agent.whenIdle()
      }
      await handle.dispose()
    } finally {
      await root.dispose()
    }
    expect(replayHandle!.auxCalls).toBeGreaterThanOrEqual(1)
    replayHandle!.assertConsumed()
  })
})

function assistantTexts(events: readonly EventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => {
      const message = event.data as { message: { content: { type: string; text?: string }[] } }
      return message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
    })
}
