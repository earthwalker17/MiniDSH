/**
 * The S20 live end-to-end: the agent checks a frontend in a real browser.
 *
 * Two legs, over real stdio JSON-RPC to `minidsh serve` against the real
 * DeepSeek API, each replayed keylessly afterwards.
 *
 *   A  build → launch → inspect → interact → verify → iterate. The default
 *      vision route starts the app's server as a background job, opens it,
 *      clicks, SEES a runtime error no static check shows (the click handler
 *      reads an element id that does not exist), fixes the source, and
 *      verifies the fix in the browser; then takes one screenshot.
 *   B  a text-only parent cannot look (its screenshot is refused at
 *      admission), delegates the look to a vision verifier child that has the
 *      browser, and acts on what the child reported about a picture the TEST
 *      drew.
 *
 * **The premises are the test's, not the model's.** Leg A's bug throws only at
 * runtime, and a separating assertion requires that the model SAW the thrown
 * error in a browser result before its first edit — a model that only read the
 * code fails here, by name. The world is checked by the test's own CDP session
 * on the final workspace, independent of the page model under test. Leg B's
 * answer is in pixels only: the page names no colour, and the child's tools are
 * exactly navigate and screenshot.
 *
 * Requires DEEPSEEK_API_KEY and an installed Chrome, Edge or Chromium; skipped
 * otherwise. Run via `pnpm test:e2e src/app/browser.e2e.test.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { launchBrowser } from '../capabilities/tool-browser/launch.ts'
import { fixtureServer, testBrowser, type FixtureServer } from '../test-support/browser-fixture.ts'
import { QUADRANT_COLOURS, quadPng } from '../test-support/images.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { loadCompositionFile, toPatches } from './config.ts'
import { runTask } from './headless.ts'
import { skillRootsFor } from './home.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
const VISION_MODEL = 'deepseek-flash'
const TEXT_ONLY_MODEL = 'deepseek-v4-pro'
const FIXTURE_PX = 96

let dirs: string[] = []
const children: ChildProcess[] = []
const servers: FixtureServer[] = []
afterAll(async () => {
  killSpawnedServes()
  for (const child of children) child.kill()
  for (const server of servers) await server.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function probe(lines: readonly string[]): void {
  const target = process.env.MINIDSH_E2E_PROBE
  if (target) appendFileSync(target, `${lines.join('\n')}\n`, 'utf8')
}

const data = <T>(event: EventEnvelope | undefined): T => (event?.data ?? {}) as T

function stored(home: string, sessionId: string): EventEnvelope[] {
  return readFileSync(join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

/** A port nothing holds right now: the fixture server's own, written into its source so a replay names the same one. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** The text of every tool result for `name`, in order, with the call's arguments. */
function toolTexts(events: readonly EventEnvelope[], name: string): { seq: number; args: string; text: string; error?: string; images: number }[] {
  const calls = events.filter((event) => event.type === 'tool/call' && data<{ name: string }>(event).name === name)
  return calls.map((call) => {
    const { callId, arguments: args } = data<{ callId: string; arguments: string }>(call)
    const result = events.find((event) => event.type === 'tool/result' && data<{ callId: string }>(event).callId === callId)
    const content = data<{ message?: { content: { content?: { type: string; text?: string }[] }[] } }>(result).message?.content[0]?.content ?? []
    return {
      seq: result?.seq ?? -1,
      args,
      text: content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'),
      ...(data<{ error?: { code: string } }>(result).error === undefined ? {} : { error: data<{ error: { code: string } }>(result).error.code }),
      images: content.filter((block) => block.type === 'image').length,
    }
  })
}

// ---- leg A's fixture: a counter whose click handler reads a missing id ----

const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Clicker</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <h1>Clicker</h1>
  <p>Count: <span id="counter">0</span></p>
  <button id="add">Add one</button>
  <script src="app.js"></script>
</body></html>
`
// Parses and runs; throws only when the button is clicked.
const APP_JS = `let count = 0
document.getElementById('add').addEventListener('click', () => {
  count += 1
  document.getElementById('count').textContent = String(count)
})
`
const STYLES_CSS = `body { font-family: sans-serif; margin: 2rem; }\nbutton { font-size: 1.2rem; }\n`
const serverJs = (port: number): string => `// A zero-dependency static server for this app.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
const port = Number(process.env.PORT ?? ${port})
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }
createServer((request, response) => {
  const path = request.url === '/' ? '/index.html' : (request.url ?? '/').split('?')[0]
  if (path === '/favicon.ico') { response.writeHead(204); return response.end() }
  try {
    const body = readFileSync(new URL('.' + path, import.meta.url))
    response.writeHead(200, { 'content-type': types[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
}).listen(port, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + port + '/'))
`

/**
 * The world, read by the TEST's own CDP session, not by the page model under
 * test: serve the final workspace on a fresh port, hook `onerror` before any
 * script runs, click the button through the DOM, read the count.
 */
async function checkWorld(workspace: string): Promise<{ count: string; errors: string[] }> {
  const port = await freePort()
  const server = spawn(process.execPath, ['server.mjs'], { cwd: workspace, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(server)
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on('data', (chunk) => (String(chunk).includes('listening') ? resolve() : undefined))
    server.once('exit', (code) => reject(new Error(`the fixed app's server exited (${code})`)))
  })
  const browser = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: tempDir('minidsh-browser-world-'), headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 } })
  try {
    const { targetId } = await browser.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const on = { sessionId }
    await browser.cdp.send('Page.enable', {}, on)
    await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__errors = []; addEventListener("error", (e) => window.__errors.push(String(e.message)))' }, on)
    const loaded = new Promise<void>((resolve) => browser.cdp.onEvent((event) => (event.sessionId === sessionId && event.method === 'Page.loadEventFired' ? resolve() : undefined)))
    await browser.cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, on)
    await Promise.race([loaded, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('the fixed app never finished loading')), 30_000))])
    // The count as a PERSON reads it — the page's text — so either fix (the
    // handler's id, or the span's) counts: the arc tests that it works, not how.
    const read = await browser.cdp.send<{ result: { value: { count: string; errors: string[] } } }>(
      'Runtime.evaluate',
      {
        expression: "document.getElementById('add').click(); ({ count: (/Count:\\s*(\\d+)/.exec(document.body.innerText) || [])[1] ?? '', errors: window.__errors })",
        returnByValue: true,
      },
      on,
    )
    return read.result.value
  } finally {
    await browser.close()
    server.kill()
  }
}

const SERVE_A = { approve: true, args: ['--accept', 'none'] } as const

const taskA = (port: number): string =>
  'People say the "Add one" button in this little web app does nothing. Work through it like this, one tool call at a time:\n' +
  `1. Start the app's server with the background job tool: node server.mjs (it serves http://127.0.0.1:${port}/).\n` +
  '2. Open that URL with browser_navigate, click the "Add one" button with browser_act, and look at what the browser reports. Do not read or change any file before you have done this.\n' +
  '3. Fix the cause in the source with the editor.\n' +
  '4. Open the page again in the browser, click "Add one", and confirm the count now goes up with no console errors.\n' +
  '5. Take one browser_screenshot of the working page.\n' +
  'Then reply with one sentence saying what was wrong.'

describe.runIf(Boolean(KEY) && process.env.MINIDSH_EXPECT_BROWSER === '1')('S20 live E2E: a host that is REQUIRED to have a browser', () => {
  it('has one where MiniDSH looks', () => {
    expect(testBrowser, 'MINIDSH_EXPECT_BROWSER=1 but no Chrome, Edge or Chromium was found').toBeDefined()
  })
})

describe.skipIf(!KEY || testBrowser === undefined)('S20 live E2E: a frontend checked in a real browser', () => {
  it('A: finds a runtime-only bug in the browser, fixes it, and verifies the fix there', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-browser-a-ws-')
    const home = tempDir('minidsh-browser-a-home-')
    const port = await freePort()
    writeFileSync(join(workspace, 'index.html'), INDEX_HTML)
    writeFileSync(join(workspace, 'app.js'), APP_JS)
    writeFileSync(join(workspace, 'styles.css'), STYLES_CSS)
    writeFileSync(join(workspace, 'server.mjs'), serverJs(port))

    const serve = new ServeProcess(workspace, home, SERVE_A)
    await serve.request('initialize')
    const task = taskA(port)
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: task, agentOptions: { provider: 'deepseek', model: VISION_MODEL, maxSteps: 40 } })
    // Below the test's own 900 s, so this wait — and its stall diagnosis — fires
    // before vitest's nameless timeout can.
    await serve.waitFor(() => serve.events('turn/end', sessionId)[0], 'turn 1 to end', 840_000)
    const events = (await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })).events
    await serve.shutdown()

    const calls = events.filter((event) => event.type === 'tool/call').map((event) => data<{ name: string }>(event).name)
    const shape = `tool calls: ${calls.join(', ')}`
    const turnEnd = data<{ reason: { kind: string } }>(events.find((event) => event.type === 'turn/end'))
    expect(turnEnd.reason.kind, `turn 1 did not complete — ${shape}`).toBe('completed')

    // ---- the premise: the model SAW the runtime error before it edited -------
    const edits = events.filter((event) => event.type === 'tool/call' && data<{ name: string }>(event).name === 'str_replace_editor' && /"command"\s*:\s*"(str_replace|create|insert)"/.test(data<{ arguments: string }>(event).arguments))
    expect(edits.length, `the model never edited the source — ${shape}`).toBeGreaterThan(0)
    const firstEdit = edits[0]!.seq
    const acts = toolTexts(events, 'browser_act')
    const navigations = toolTexts(events, 'browser_navigate')
    const sawError = [...acts, ...navigations].find((result) => result.seq < firstEdit && /TypeError|Cannot set properties of null/.test(result.text))
    expect(sawError, `no browser result before the first edit (seq ${firstEdit}) named the TypeError; the model fixed it without looking — ${shape}`).toBeDefined()
    // And it verified AFTER the last edit, in the browser, with a clean header.
    const lastEdit = edits.at(-1)!.seq
    const verified = acts.find((result) => result.seq > lastEdit && result.error === undefined && /no console errors/.test(result.text))
    expect(verified, `no clean browser_act after the last edit (seq ${lastEdit}) — ${shape}`).toBeDefined()
    const shots = toolTexts(events, 'browser_screenshot')
    expect(shots.some((shot) => shot.images === 1 && shot.error === undefined), `no screenshot carried an image — ${shape}`).toBe(true)
    // The job ran the server, under this session's authority.
    expect(events.some((event) => event.type === 'job/start'), `the server never ran as a job — ${shape}`).toBe(true)

    // ---- the world, by the test's own browser -------------------------------
    const world = await checkWorld(workspace)
    expect(world, 'the fixed app, clicked once by the test').toEqual({ count: '1', errors: [] })

    probe([
      '--- S20 browser arc A ---',
      `steps: ${events.filter((event) => event.type === 'step/start').length}`,
      shape,
      `first edit seq ${firstEdit}; error seen at seq ${sawError?.seq}; verified at seq ${verified?.seq}`,
      `snapshot chars (navigate): ${navigations.map((n) => n.text.length).join(', ')}`,
    ])

    // ---- keyless replay: recorded effects (a job ran) ------------------------
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayHome = tempDir('minidsh-browser-a-replay-home-')
    const replayed = await runTask(
      {
        task,
        cwd: tempDir('minidsh-browser-a-replay-ws-'),
        model: VISION_MODEL,
        maxSteps: 40,
        sessionsRoot: tempDir('minidsh-browser-a-replay-'),
        skillRoots: skillRootsFor(home),
        browserProfileRoot: join(replayHome, 'browser'),
        logger: silent,
        accepts: 'none',
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events, effects: 'recorded' })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
  })

  it('B: a text-only parent delegates the look to a vision verifier with the browser', { timeout: 900_000 }, async () => {
    const workspace = tempDir('minidsh-browser-b-ws-')
    const home = tempDir('minidsh-browser-b-home-')
    const png = quadPng(FIXTURE_PX)
    // The answer is in the pixels alone: no colour word, no alt text.
    const page = await fixtureServer({ '/': '<!doctype html><title>Picture</title><img src="/p.png" width="384" height="384" style="image-rendering: pixelated">', '/p.png': { type: 'image/png', body: png } })
    servers.push(page)
    writeFileSync(join(home, 'composition.json'), compositionB())
    const task = taskB(page.origin)

    const serve = new ServeProcess(workspace, home, {})
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: task, agentOptions: { provider: 'deepseek', model: TEXT_ONLY_MODEL } })
    await serve.waitForCompletedTurn(sessionId, 1)
    const parentLog = (await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })).events
    const calls = parentLog.filter((event) => event.type === 'tool/call').map((event) => data<{ name: string }>(event).name)
    const shape = `parent tool calls: ${calls.join(', ')}`

    // The parent's own look is refused at admission, before any capture.
    const parentShots = toolTexts(parentLog, 'browser_screenshot')
    expect(parentShots[0]?.error, `the parent's screenshot was not refused — ${shape}`).toBe('UNSUPPORTED_CONTENT')
    expect(calls, `the parent read pixels some other way — ${shape}`).not.toContain('browser_evaluate')

    // The binding before any answer: the child ran on the vision route and its screenshot carried an image.
    const start = parentLog.find((event) => event.type === 'subagent/start')
    expect(start, `the parent never delegated — ${shape}`).toBeDefined()
    const { childId, model } = data<{ childId: string; model: string }>(start)
    expect(model).toBe(VISION_MODEL)
    const childEvents = stored(home, childId)
    const childShots = toolTexts(childEvents, 'browser_screenshot')
    expect(childShots.some((shot) => shot.images === 1 && shot.error === undefined), `the child never got a screenshot back: ${JSON.stringify(childShots.map((s) => s.error ?? 'ok'))}`).toBe(true)
    await serve.shutdown()

    const verdict = readFileSync(join(workspace, 'verdict.txt'), 'utf8').toLowerCase()
    const positions = QUADRANT_COLOURS.map((colour) => verdict.indexOf(colour))
    expect(positions.every((at) => at >= 0), `verdict.txt was "${verdict.trim()}"; the test drew ${QUADRANT_COLOURS.join(', ')}`).toBe(true)
    expect(positions, `verdict.txt was "${verdict.trim()}"; the drawn order is ${QUADRANT_COLOURS.join(', ')}`).toEqual([...positions].toSorted((a, b) => a - b))
    // And the parent wrote what the CHILD said — the verification arc's join.
    // Without it a parent could decode the loopback PNG itself (a fetch through
    // the shell or a job), delegate as a formality, and pass.
    const childAnswer = childEvents
      .filter((event) => event.type === 'assistant/message')
      .map((event) => data<{ message: { content: { type: string; text?: string }[] } }>(event).message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''))
      .filter((text) => text.length > 0)
      .at(-1)
    expect((childAnswer ?? '').toLowerCase(), `the child said "${childAnswer ?? '(nothing)'}" but verdict.txt holds "${verdict.trim()}" — ${shape}`).toContain(verdict.trim())

    probe(['--- S20 browser arc B ---', shape, `child tool calls: ${childEvents.filter((e) => e.type === 'tool/call').map((e) => data<{ name: string }>(e).name).join(', ')}`, `verdict: ${verdict.trim()}`])

    // ---- keyless replay: the child's browser really runs again ---------------
    const replayHome = tempDir('minidsh-browser-b-replay-home-')
    writeFileSync(join(replayHome, 'composition.json'), compositionB())
    const file = loadCompositionFile(join(replayHome, 'composition.json'))!
    const replayAttachments = join(replayHome, 'attachments')
    const parentTurnOne = parentLog.slice(0, parentLog.findIndex((event) => event.type === 'turn/end') + 1)
    const replaySessions = tempDir('minidsh-browser-b-replay-sessions-')
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayed = await runTask(
      {
        task,
        cwd: tempDir('minidsh-browser-b-replay-ws-'),
        model: TEXT_ONLY_MODEL,
        approve: true,
        sessionsRoot: replaySessions,
        skillRoots: skillRootsFor(home),
        attachmentsRoot: replayAttachments,
        browserProfileRoot: join(replayHome, 'browser'),
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
    // The replayed child's browser really ran: its own log shows the page it
    // opened (the test's picture page, by its title) and a screenshot that
    // carried an image — not an error page's capture.
    const replayedChild = readdirSync(replaySessions)
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => readFileSync(join(replaySessions, entry), 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line) as EventEnvelope))
      .find((log) => log.some((event) => event.type === 'tool/call' && data<{ name: string }>(event).name === 'browser_screenshot' && !log.some((other) => other.type === 'subagent/start')))
    expect(replayedChild, 'no replayed child log took a screenshot').toBeDefined()
    const replayedOpen = toolTexts(replayedChild!, 'browser_navigate')
    expect(replayedOpen.some((result) => result.error === undefined && result.text.includes('"Picture"')), `the replayed child did not open the picture page: ${JSON.stringify(replayedOpen.map((r) => r.error ?? r.text.slice(0, 80)))}`).toBe(true)
    const replayedShots = toolTexts(replayedChild!, 'browser_screenshot')
    expect(replayedShots.some((shot) => shot.images === 1 && shot.error === undefined), "the replayed child's screenshot carried no image").toBe(true)
    const objects = existsSync(join(replayAttachments, 'v1', 'objects')) ? readdirSync(join(replayAttachments, 'v1', 'objects')).length : 0
    expect(objects, 'the replayed child never captured a screenshot, so its browser never ran').toBeGreaterThan(0)
    // Reported, not asserted: two headless captures of one page may differ in bytes.
    const digest = (log: readonly EventEnvelope[]): string | undefined =>
      JSON.stringify(log.filter((event) => event.type === 'tool/result')).match(/"id":"(sha256:[0-9a-f]{12})/)?.[1]
    probe([`screenshot digest live ${digest(childEvents) ?? '?'} · replay ${digest(replayedChild!) ?? '?'}`])
  })
})

function compositionB(): string {
  return JSON.stringify({
    patches: [
      {
        insert: [
          {
            id: 'tool-verifier',
            plugin: 'tool-subagent',
            config: {
              toolName: 'verify',
              purpose: 'verifier',
              sandbox: 'read-only',
              description: 'Ask a read-only subagent with a browser to look at a page and report what it sees. Give it the URL and exactly what to report; it answers once, in text.',
              toolFilter: { allow: ['browser_navigate', 'browser_screenshot'] },
              persona: 'You verify one claim about a web page. Open the URL with browser_navigate, take a browser_screenshot, look at it, and reply with exactly what was asked for and nothing else.',
              maxSteps: 6,
            },
          },
        ],
      },
      { id: 'model-roles', config: { roles: { verifier: { provider: 'deepseek', model: VISION_MODEL } } } },
    ],
  })
}

const taskB = (origin: string): string =>
  'Do these three things in order, one tool call at a time.\n' +
  `1. Call browser_screenshot after opening ${origin}/ with browser_navigate. The screenshot will fail. Read the error, do not retry it, and go on to step 2.\n` +
  `2. Call the verify tool. Its prompt must give the URL ${origin}/ and ask for the four quadrant colours of the picture on that page, in order top-left, top-right, bottom-left, bottom-right, reported as one comma-separated line of four lowercase colour words and nothing else.\n` +
  '3. Use the editor to create verdict.txt in the working directory containing exactly the line the verify tool reported.\n' +
  'Then reply with that line and nothing else.'
