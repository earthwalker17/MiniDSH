/**
 * The S8 verification live end-to-end: a delegated child sees an image its
 * parent cannot, and the parent acts on what it reported.
 *
 * One arc, over real stdio JSON-RPC to `minidsh serve` against the real
 * DeepSeek API, with NO `--approve`, and with every S8 row mounted from a disk
 * `composition.json` — so the arc also re-proves that the composition layers
 * reproduce a world.
 *
 *   admission    the parent is on `deepseek-v4-flash`, which cannot see images,
 *                so its own `view_image` call is refused BEFORE any file is
 *                read, and the refusal names delegation
 *   the plane    the verifier child, routed to the vision model by one
 *                `model-roles` entry, reads the PNG, and the bytes are
 *                committed durably and content-addressed while the log carries
 *                only a reference
 *   the world    the parent writes what the child reported, and the four
 *                colours are the ones the TEST drew
 *   the surface  a client attaches to the child by name and its transcript
 *                carries the image descriptor
 *   replay       both logs replay keylessly, and the replayed child really
 *                re-reads the image rather than passing on arithmetic
 *
 * **The test writes the fixture, not the model.** A live arc whose premise is
 * an assumption about the model decays silently — the S5 arc asked for a marker
 * token that one `Select-String` could answer, and measured nothing for three
 * runs. Here the expected answer is a fact the test knows because it drew it.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { QUADRANT_COLOURS, quadPng } from '../test-support/images.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { loadCompositionFile, toPatches } from './config.ts'
import { runTask } from './headless.ts'
import { transcriptLines } from './present.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }

/**
 * The route that can see. Named here rather than in `compose()` so no shipped
 * session inherits an `-exp` id, and so the arc's own composition is what
 * chooses it — which is where a deployment would choose it too.
 */
const VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/**
 * 96×96 is the size two live probes read correctly on this route. A smaller
 * fixture would make a wrong answer a plausible outcome, and an arc failure
 * ambiguous between the runtime and the model.
 */
const FIXTURE_PX = 96

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

/**
 * What actually happened, written where a passing run can be read.
 *
 * vitest does not print `console.error` from a PASSING test when its output is
 * piped, so a probe added to a green arc is silently invisible — and this
 * project has already concluded twice that a green arc measured nothing. Set
 * `MINIDSH_E2E_PROBE` to a file path to collect the numbers behind the
 * assertions rather than trusting that they were reached.
 */
function probe(lines: readonly string[]): void {
  const target = process.env.MINIDSH_E2E_PROBE
  if (!target) return
  appendFileSync(target, `${lines.join('\n')}\n`, 'utf8')
}

function storedEvents(home: string, id: string): EventEnvelope[] {
  return readFileSync(join(home, 'sessions', `${encodeURIComponent(id)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

/** The S8 rows, as a deployment would declare them: two inserts and one patch. */
function compositionFile(): string {
  return JSON.stringify({
    patches: [
      { insert: [{ id: 'tool-view-image', plugin: 'tool-view-image' }] },
      {
        insert: [
          {
            id: 'tool-verifier',
            plugin: 'tool-subagent',
            config: {
              toolName: 'verify',
              purpose: 'verifier',
              sandbox: 'read-only',
              description:
                'Ask a read-only subagent to look at an image and report what it sees. Give it the file path and exactly what to report back; it answers once, in text.',
              toolFilter: { allow: ['view_image'] },
              persona: 'You verify one claim about an image. Call view_image on the path you are given, look at it, and reply with exactly what was asked for and nothing else.',
              maxSteps: 6,
            },
          },
        ],
      },
      { id: 'model-roles', config: { roles: { verifier: { provider: 'deepseek', model: VISION_MODEL } } } },
    ],
  })
}

/**
 * Three numbered steps in one turn, each naming the tool to use, because an arc
 * that leaves the route open is measuring the provider's mood. Paths are
 * RELATIVE: a recorded absolute path inside the recording's own workspace
 * cannot land in a replay's fresh root, and the fence is right to refuse it.
 */
const TASK =
  'Do these three things in order, one tool call at a time.\n' +
  '1. Call the `view_image` tool with path `quad.png`. It will fail. Read the error, do not retry it, and go on to step 2.\n' +
  '2. Call the `verify` tool. Its prompt must ask for the four quadrant colours of the image at the relative path `quad.png`, in order top-left, top-right, bottom-left, bottom-right, reported as one comma-separated line of four lowercase colour words and nothing else.\n' +
  '3. Use the editor to create `verdict.txt` in the working directory containing exactly the line the verify tool reported.\n' +
  'Then reply with that line and nothing else.'

describe.skipIf(!KEY)('S8 live E2E: a vision verifier sees what its parent cannot', () => {
  it('refuses the parent, delegates the look, and acts on what the child reported', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-e2e8-ws-')
    const home = tempDir('minidsh-e2e8-home-')
    const png = quadPng(FIXTURE_PX)
    const pngDigest = createHash('sha256').update(png).digest('hex')
    writeFileSync(join(workspace, 'quad.png'), png)
    writeFileSync(join(home, 'composition.json'), compositionFile())

    // No --approve: a consent would have to be a real decision, and the child is
    // pinned `never` so it can never ask for one.
    const serve = new ServeProcess(workspace, home, {})
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: TASK })
    await serve.waitForCompletedTurn(sessionId, 1)

    const parentLog = (await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })).events
    const results = parentLog.filter((event) => event.type === 'tool/result').map((event) => event.data as { callId: string; error?: { code: string } })
    const calls = parentLog.filter((event) => event.type === 'tool/call').map((event) => event.data as { callId: string; name: string })
    const named = (name: string) => {
      const call = calls.find((candidate) => candidate.name === name)
      return { call, result: call ? results.find((entry) => entry.callId === call.callId) : undefined }
    }

    // ---- admission: the parent's own look is refused, before any read -------
    const look = named('view_image')
    expect(look.call, `the model never called view_image; it called: ${calls.map((c) => c.name).join(', ') || 'nothing'}`).toBeDefined()
    expect(look.result?.error?.code, 'a text-only route must refuse an image before reading one').toBe('UNSUPPORTED_CONTENT')

    // ---- the binding, asserted BEFORE any answer ---------------------------
    // Every answer-shaped assertion below is satisfiable by a child that never
    // saw the image: `model-roles` passes an unknown purpose through silently,
    // so a mis-wired row would put the child on the parent's own model, where it
    // would guess from the filename. These four assertions are what make the
    // rest mean something.
    const start = parentLog.find((event) => event.type === 'subagent/start')
    expect(start, `the model never delegated; it called: ${calls.map((c) => c.name).join(', ')}`).toBeDefined()
    const startData = start!.data as { childId: string; model: string; sandbox: string; approval: string }
    expect(startData, 'the verifier row and its model-roles entry must be patched together').toMatchObject({ model: VISION_MODEL, sandbox: 'read-only', approval: 'never' })

    const childId = startData.childId
    const childEvents = storedEvents(home, childId)
    const childRoute = childEvents.filter((event) => event.type === 'request/context').map((event) => event.data as { model: string; inputModalities?: string[] })
    expect(childRoute[0], 'the child recorded no route').toBeDefined()
    expect(childRoute[0]!.model).toBe(VISION_MODEL)
    expect(childRoute[0]!.inputModalities, 'the log must say what the route could take, or a replay cannot').toContain('image')

    const childResults = childEvents.filter((event) => event.type === 'tool/result').map((event) => event.data as { message: { content: { type: string; content?: { type: string }[] }[] }; error?: { code: string } })
    const sawImage = childResults.find((result) => result.message.content[0]?.content?.some((block) => block.type === 'image'))
    expect(sawImage, `the child never got an image back; its results were: ${childResults.map((r) => r.error?.code ?? 'ok').join(', ')}`).toBeDefined()
    expect(sawImage!.error, 'the child’s view_image must have succeeded').toBeUndefined()

    // ---- the plane: the id addresses the SOURCE file ------------------------
    const block = sawImage!.message.content[0]!.content!.find((candidate) => candidate.type === 'image') as unknown as { attachment: { id: string; width: number; height: number }; text: string }
    expect(block.attachment.id, 'the stored object must be the file the test drew').toBe(`sha256:${pngDigest}`)
    expect(block.attachment).toMatchObject({ width: FIXTURE_PX, height: FIXTURE_PX })
    const objects = join(home, 'attachments', 'v1', 'objects', pngDigest.slice(0, 2))
    expect(readdirSync(objects)).toContain(pngDigest)
    expect(readFileSync(join(objects, pngDigest)).equals(png), 'the stored bytes must be the source bytes').toBe(true)

    // Bytes never enter a log — either of them.
    const base64Head = png.toString('base64').slice(0, 40)
    expect(JSON.stringify(parentLog)).not.toContain(base64Head)
    expect(JSON.stringify(childEvents)).not.toContain(base64Head)

    // ---- the ceiling still holds -------------------------------------------
    const stamps = childEvents.filter((event) => event.type === 'sandbox/mode').map((event) => event.data as { mode: string; reason: string })
    expect(stamps[0], 'the child must open under a delegation stamp').toMatchObject({ mode: 'read-only', reason: 'delegation' })
    const decided = childEvents.filter((event) => event.type === 'approval/decided').map((event) => (event.data as { outcome: string }).outcome)
    expect(decided.every((outcome) => outcome === 'rejected'), `an approval reached a client: ${decided.join(', ')}`).toBe(true)

    // ---- the surface: a client attaches to the child by name ----------------
    // The only image in this run lives in the CHILD's log, so without this leg
    // the rendering ships on unit tests alone.
    const attached = await serve.request<{ page: { events: EventEnvelope[] } }>('session/attach', { sessionId: childId })
    const rendered = transcriptLines(attached.page.events)
    expect(rendered.some((line) => line.includes('[image') && line.includes(`${FIXTURE_PX}×${FIXTURE_PX}`)), `no image row in the child transcript:\n${rendered.join('\n')}`).toBe(true)

    // What the child actually said, so a wrong colour list is distinguishable
    // from a runtime defect in the failure message.
    const childAnswer = childEvents
      .filter((event) => event.type === 'assistant/message')
      .map((event) => (event.data as { message: { content: { type: string; text?: string }[] } }).message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''))
      .filter((text) => text.length > 0)
      .at(-1)

    await serve.shutdown()

    // ---- the world ----------------------------------------------------------
    const verdict = readFileSync(join(workspace, 'verdict.txt'), 'utf8').toLowerCase()
    for (const colour of QUADRANT_COLOURS) {
      expect(verdict, `verdict.txt was "${verdict.trim()}" and the child answered "${childAnswer ?? '(nothing)'}"; the test drew ${QUADRANT_COLOURS.join(', ')} on ${VISION_MODEL}`).toContain(colour)
    }
    // In order, and the file the child read is untouched.
    expect(verdict.indexOf('red')).toBeLessThan(verdict.indexOf('green'))
    expect(verdict.indexOf('green')).toBeLessThan(verdict.indexOf('blue'))
    expect(readFileSync(join(workspace, 'quad.png')).equals(png)).toBe(true)

    probe([
      '--- S8 verification arc ---',
      `parent tool calls: ${calls.map((call) => call.name).join(', ')}`,
      `parent assistant messages: ${parentLog.filter((event) => event.type === 'assistant/message').length}`,
      `parent steps: ${parentLog.filter((event) => event.type === 'step/start').length}`,
      `child model: ${startData.model} · modalities: ${JSON.stringify(childRoute[0]?.inputModalities)}`,
      `child tool calls: ${childEvents.filter((event) => event.type === 'tool/call').map((event) => (event.data as { name: string }).name).join(', ')}`,
      `child assistant messages: ${childEvents.filter((event) => event.type === 'assistant/message').length}`,
      `child final answer: ${JSON.stringify(childAnswer)}`,
      `image block descriptor: ${JSON.stringify(block.text)}`,
      `attachment id matches source digest: ${block.attachment.id === `sha256:${pngDigest}`}`,
      `verdict.txt: ${JSON.stringify(verdict.trim())}`,
      `child transcript image rows: ${rendered.filter((line) => line.includes('[image')).length}`,
    ])

    // ---- replay: both logs, and the image path really runs ------------------
    // Tools execute for real under replay, so the fixture is pre-seeded: without
    // it `view_image` errors, no attachment is ever written, the recorded answer
    // replays anyway, and `assertConsumed()` passes on arithmetic while nothing
    // under test has run. That is the S7.5 defect class, and these two
    // assertions are what close it.
    const replayWorkspace = tempDir('minidsh-e2e8-replay-ws-')
    const replayHome = tempDir('minidsh-e2e8-replay-home-')
    writeFileSync(join(replayWorkspace, 'quad.png'), png)
    writeFileSync(join(replayHome, 'composition.json'), compositionFile())
    const file = loadCompositionFile(join(replayHome, 'composition.json'))!
    const parentTurnOne = parentLog.slice(0, parentLog.findIndex((event) => event.type === 'turn/end') + 1)
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replaySessions = tempDir('minidsh-e2e8-replay-sessions-')
    const replayAttachments = join(replayHome, 'attachments')
    const replayed = await runTask(
      {
        task: TASK,
        cwd: replayWorkspace,
        model: 'deepseek-v4-flash',
        approve: true,
        sessionsRoot: replaySessions,
        attachmentsRoot: replayAttachments,
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        configLayers: [{ name: 'home', patches: await toPatches(file, replayHome) }],
        prepare: (context) => {
          replayHandle = installLlmReplay(context, { events: parentTurnOne, children: [childEvents] })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
    // The replayed child re-read the image for real: the object is on disk in a
    // home that started empty, under the same content address.
    expect(existsSync(join(replayAttachments, 'v1', 'objects', pngDigest.slice(0, 2), pngDigest)), 'the replay never wrote an attachment, so its image path never ran').toBe(true)
  })
})
