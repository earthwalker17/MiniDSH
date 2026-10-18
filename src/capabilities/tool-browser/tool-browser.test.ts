/**
 * The five tools through a real composition: a scripted model, the real
 * registry and pipeline, a real attachment store, and a real browser. What a
 * MODEL gets is what is asserted — the tool results in the log — plus the
 * world the tools may not touch (profiles, the store, the network).
 *
 * Self-skips where no Chrome, Edge or Chromium is installed; under
 * `MINIDSH_EXPECT_BROWSER=1` that is a failure (`expectBrowserSuite`).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentHandle } from '../../core/agent/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import type { LlmRequest } from '../../core/llm/types.ts'
import { matches, TOOL_RESULT } from '../../core/session/index.ts'
import { defineTool, TOOLS } from '../../core/tools/index.ts'
import { expectBrowserSuite, fixtureServer, testBrowser, type FixtureServer } from '../../test-support/browser-fixture.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText, assistantToolCall } from '../../test-support/scripted-adapter.ts'
import { attachmentsLocalPlugin } from '../attachments-local/index.ts'
import { fsLocalPlugin } from '../fs-local/index.ts'
import { changesSince, header, toolBrowserPlugin } from './index.ts'

expectBrowserSuite('tool-browser tools')

const LONG = { timeout: 120_000 }
let harnesses: CoreHarness[] = []
let dirs: string[] = []
let served: FixtureServer | undefined

afterEach(async () => {
  for (const harness of harnesses.toReversed()) await harness.dispose()
  harnesses = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
}, 120_000)
afterAll(async () => {
  await served?.close()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function pages(): Promise<FixtureServer> {
  served ??= await fixtureServer({
    '/counter': `<title>Counter</title><h1>Counter</h1><button onclick="count.textContent = String(Number(count.textContent) + 1)">Add one</button><p id="count">0</p>`,
    '/noisy': `<title>Noisy</title><script>console.error('boom from the page')</script><img src="/missing.png">`,
  })
  return served
}

interface World {
  readonly harness: CoreHarness
  readonly cwd: string
  readonly profileRoot: string
  readonly store: string
  create(): Promise<AgentHandle>
}

async function world(options: { vision: boolean; maxImagesPerRequest?: number }): Promise<World> {
  const harness = await coreHarness()
  harnesses.push(harness)
  if (options.vision) {
    const resolve = harness.adapter.resolveModel.bind(harness.adapter)
    harness.adapter.resolveModel = (model: string) => ({ ...resolve(model), inputModalities: ['text', 'image'] as const })
  }
  const cwd = tempDir('minidsh-tb-cwd-')
  const profileRoot = tempDir('minidsh-tb-profiles-')
  const store = tempDir('minidsh-tb-store-')
  harness.root.plugin(fsLocalPlugin)
  harness.root.plugin(attachmentsLocalPlugin, { root: store, ...(options.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: options.maxImagesPerRequest }) })
  harness.root.plugin(toolBrowserPlugin, { profileRoot, executablePath: testBrowser!.path })
  expect((await harness.root.settle()).failed).toEqual([])
  return { harness, cwd, profileRoot, store, create: () => harness.create({ cwd }) }
}

interface Result {
  readonly text: string
  readonly code?: string
  readonly images: number
}

function results(handle: AgentHandle): Result[] {
  return handle.agent.session.facts
    .filter((event) => matches(event, TOOL_RESULT))
    .map((event) => {
      if (!matches(event, TOOL_RESULT)) throw new Error('unreachable')
      const block = event.data.message.content[0]
      const content = block !== undefined && block.type === 'tool-result' ? block.content : []
      return {
        text: content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
        ...(event.data.error === undefined ? {} : { code: event.data.error.code }),
        images: content.filter((part) => part.type === 'image').length,
      }
    })
}

/** The latest tool result's text in a request: what a model reads before its next call. */
function lastResult(request: LlmRequest): string {
  for (const message of request.messages.toReversed()) {
    for (const block of message.content) {
      if (block.type === 'tool-result') return block.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
    }
  }
  return ''
}

/** A call whose arguments are read off the previous result, as a model reads a ref off a snapshot. */
const callFrom = (callId: string, name: string, args: (previous: string) => object) => (request: LlmRequest) => assistantToolCall(callId, name, args(lastResult(request)))

function refIn(text: string, line: string): string {
  const match = new RegExp(`- ${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*?\\[ref=(e\\d+)\\]`).exec(text)
  if (!match) throw new Error(`no ${line} in:\n${text}`)
  return match[1]!
}

async function turn(w: World, handle: AgentHandle, ...steps: Parameters<CoreHarness['adapter']['script']>): Promise<Result[]> {
  w.harness.adapter.script(...steps, assistantText('done'))
  handle.agent.followup(createUserMessage('check the page'))
  await handle.agent.whenIdle()
  return results(handle)
}

const profiles = (root: string): string[] => readdirSync(root).filter((entry) => entry.startsWith('p-'))

describe('the header and the change report', () => {
  it('says only what happened, printable and bounded, and says when nothing did', () => {
    const quiet = header({ url: 'http://localhost:1/', title: 'A', status: 200, console: [], exceptions: [], failedRequests: [], dialogs: [], downloads: [], blockedFiles: [], popups: [], omitted: 0, navigated: false, crashed: false }, undefined)
    expect(quiet).toContain('no console errors or warnings, exceptions, failed requests or dialogs')
    const busy = header(
      {
        url: 'http://localhost:1/',
        title: 'A\u001b[31m',
        console: [{ level: 'error', text: 'bad\nthing', where: 'http://localhost:1/a.js:3' }],
        exceptions: ['TypeError: x'],
        failedRequests: [{ url: 'http://denied.invalid/p.png', reason: '403', fenced: true }],
        dialogs: [{ type: 'confirm', message: 'sure?', answer: 'dismissed' }],
        downloads: [],
        blockedFiles: [],
        popups: [],
        omitted: 2,
        navigated: true,
        crashed: false,
      },
      'relaunched',
    )
    expect(busy).not.toContain('\u001b')
    expect(busy).toContain('blocked by the browser fence: http://denied.invalid/p.png')
    expect(busy).toContain('confirm dialog "sure?" was dismissed')
    expect(busy).toContain('2 more event(s) not shown')
    expect(busy.split('\n')[0]).toBe('relaunched')
  })

  it('names a page without a title as untitled, and every download by what became of it', () => {
    const base = { url: 'http://127.0.0.1:5/missing', status: 404, console: [], exceptions: [], failedRequests: [], dialogs: [], blockedFiles: [], popups: [], omitted: 0, navigated: false, crashed: false }
    // Chrome titles a page with no <title> by its address, scheme dropped.
    const untitled = header({ ...base, title: '127.0.0.1:5/missing', downloads: [] }, undefined)
    expect(untitled.split('\n')[0]).toBe('Page: (untitled) at http://127.0.0.1:5/missing (HTTP 404)')
    const downloads = header(
      {
        ...base,
        title: 'T',
        downloads: [
          { name: 'a.bin', outcome: 'refused' },
          { name: 'b.bin', outcome: 'started' },
          { name: 'c.bin', outcome: 'saved' },
        ],
      },
      undefined,
    )
    expect(downloads).toContain('download refused: a.bin')
    expect(downloads).toContain('download started, not yet settled: b.bin')
    expect(downloads).toContain("download SAVED despite this browser's deny policy: c.bin")
  })

  it('bounds the events a noisy page reports, keeping the first one', () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({ level: 'error' as const, text: `${index === 0 ? 'THE FIRST' : 'noise'} ${'x'.repeat(280)}` }))
    const text = header({ url: 'http://localhost:1/', title: 'Noisy', console: entries, exceptions: [], failedRequests: [], dialogs: [], downloads: [], blockedFiles: [], popups: [], omitted: 30, navigated: false, crashed: false }, undefined)
    expect(text.length, 'the header grew past its bound').toBeLessThan(5_000)
    expect(text).toContain('THE FIRST')
    expect(text).toMatch(/…and \d+ more event\(s\) not shown/)
  })

  it('reports an action as the lines that changed, or the page when that is shorter', () => {
    const before = '- heading "Counter" [ref=e1]\n- button "Add one" [ref=e2]\n- paragraph [ref=e3]: 0'
    const after = '- heading "Counter" [ref=e1]\n- button "Add one" [ref=e2]\n- paragraph [ref=e3]: 1'
    expect(changesSince(before, after)).toBe('Snapshot changes (- gone, + new):\n- - paragraph [ref=e3]: 0\n+ - paragraph [ref=e3]: 1')
    expect(changesSince(before, before)).toBe('The page snapshot did not change.')
    expect(changesSince(undefined, after)).toContain('The page now reads:')
  })
})

describe.runIf(testBrowser !== undefined)('the browser tools in a real composition', () => {
  it('registers nothing where no browser is found, and five tools where one is', LONG, async () => {
    const harness = await coreHarness()
    harnesses.push(harness)
    harness.root.plugin(toolBrowserPlugin, { profileRoot: tempDir('minidsh-tb-none-'), executablePath: join(tempDir('minidsh-tb-nobrowser-'), 'chrome.exe') })
    expect((await harness.root.settle()).failed).toEqual([])
    expect(harness.root.get(TOOLS).schemas().filter((schema) => schema.name.startsWith('browser_'))).toEqual([])
    const found = await world({ vision: false })
    expect(found.harness.root.get(TOOLS).schemas().map((schema) => schema.name).filter((name) => name.startsWith('browser_')).toSorted()).toEqual(
      ['browser_act', 'browser_evaluate', 'browser_navigate', 'browser_screenshot', 'browser_snapshot'],
    )
  })

  it('opens a loopback page, clicks by the ref it read, and reports the change and the page’s errors', LONG, async () => {
    const site = await pages()
    const w = await world({ vision: false })
    const handle = await w.create()
    const out = await turn(
      w,
      handle,
      assistantToolCall('c1', 'browser_navigate', { url: `${site.origin}/counter` }),
      callFrom('c2', 'browser_act', (previous) => ({ action: 'click', ref: refIn(previous, 'button "Add one"') })),
      assistantToolCall('c3', 'browser_navigate', { url: `${site.origin}/noisy` }),
      assistantToolCall('c4', 'browser_evaluate', { expression: 'document.title + " " + (1 + 1)' }),
    )
    expect(out.map((result) => result.code)).toEqual([undefined, undefined, undefined, undefined])
    expect(out[0]!.text).toMatch(/^Page: "Counter" at http:\/\/127\.0\.0\.1:\d+\/counter \(HTTP 200\)/)
    expect(out[0]!.text).toContain('button "Add one" [ref=')
    expect(out[1]!.text).toContain('clicked button "Add one"')
    // A page this small is shorter than its own diff, so the page itself is shown.
    expect(out[1]!.text).toMatch(/paragraph \[ref=e\d+\]: 1/)
    expect(out[2]!.text).toContain('console error: boom from the page')
    expect(out[2]!.text).toMatch(/request failed: http:\/\/127\.0\.0\.1:\d+\/missing\.png \(404\)/)
    expect(out[3]!.text).toContain('Noisy 2')
  })

  it('refuses what the fence refuses before anything starts: a public URL, a file outside the workspace, a share', LONG, async () => {
    const w = await world({ vision: false })
    const handle = await w.create()
    const outside = join(tempDir('minidsh-tb-outside-'), 'secret.html')
    writeFileSync(outside, '<p>secret</p>')
    const out = await turn(
      w,
      handle,
      assistantToolCall('c1', 'browser_navigate', { url: 'https://example.com/' }),
      assistantToolCall('c2', 'browser_navigate', { url: pathToFileURL(outside).href }),
      assistantToolCall('c3', 'browser_navigate', { url: 'file://fileserver/share/page.html' }),
      assistantToolCall('c4', 'browser_navigate', { url: 'http://0.0.0.0:5173/' }),
    )
    expect(out.map((result) => result.code)).toEqual(['BROWSER_URL_REFUSED', 'BROWSER_URL_REFUSED', 'BROWSER_URL_REFUSED', 'BROWSER_URL_REFUSED'])
    expect(out[3]!.text).toContain('http://localhost:<port>/')
    // Refused before a launch: no profile was ever made.
    expect(profiles(w.profileRoot)).toEqual([])
  })

  it('opens the workspace’s own file: pages', LONG, async () => {
    const w = await world({ vision: false })
    writeFileSync(join(w.cwd, 'index.html'), '<title>Local</title><h1>Built here</h1>')
    const handle = await w.create()
    const out = await turn(w, handle, assistantToolCall('c1', 'browser_navigate', { url: pathToFileURL(join(w.cwd, 'index.html')).href }))
    expect(out[0]!.code).toBeUndefined()
    expect(out[0]!.text).toContain('heading "Built here"')
  })

  it('refuses a screenshot on a text-only route before capturing, while the text tools work', LONG, async () => {
    const site = await pages()
    const w = await world({ vision: false })
    const handle = await w.create()
    const out = await turn(w, handle, assistantToolCall('c1', 'browser_navigate', { url: `${site.origin}/counter` }), assistantToolCall('c2', 'browser_screenshot', {}))
    expect(out[0]!.code).toBeUndefined()
    expect(out[1]!.code).toBe('UNSUPPORTED_CONTENT')
    expect(out[1]!.text).toContain('Delegate the look to a subagent')
    expect(readdirSync(w.store)).toEqual([])
  })

  it('returns a screenshot as a stored attachment, never as bytes in the log, and bounds how many', LONG, async () => {
    const site = await pages()
    const w = await world({ vision: true, maxImagesPerRequest: 1 })
    const handle = await w.create()
    const out = await turn(
      w,
      handle,
      assistantToolCall('c1', 'browser_navigate', { url: `${site.origin}/counter` }),
      assistantToolCall('c2', 'browser_screenshot', {}),
      assistantToolCall('c3', 'browser_screenshot', { full_page: true }),
    )
    expect(out[1]!.code).toBeUndefined()
    expect(out[1]!.images).toBe(1)
    expect(out[1]!.text).toContain('Page: "Counter"')
    expect(readdirSync(join(w.store, 'v1', 'objects')).length).toBeGreaterThan(0)
    expect(out[2]!.code).toBe('TOO_MANY_IMAGES')
    expect(out[2]!.text).toContain('A subagent starts with a conversation of its own')
    // The PNG signature, base64-encoded, never appears in any event.
    expect(JSON.stringify(handle.agent.session.events)).not.toContain('iVBORw0KGgo')
  })

  it('gives each agent its own browser, and an agent’s disposal closes it and removes its profile', LONG, async () => {
    const site = await pages()
    const w = await world({ vision: false })
    const first = await w.create()
    const second = await w.create()
    await turn(w, first, assistantToolCall('c1', 'browser_navigate', { url: `${site.origin}/counter` }))
    const [mine] = await turn(w, first, callFrom('c2', 'browser_act', (previous) => ({ action: 'click', ref: refIn(previous, 'button "Add one"') })))
    expect(mine?.code).toBeUndefined()
    expect(profiles(w.profileRoot)).toHaveLength(1)
    // Another agent: its own browser, with its own refs (numbered from e1 again,
    // per agent), so a ref only the first agent's later snapshots reached means
    // nothing here.
    const theirs = await turn(w, second, assistantToolCall('c3', 'browser_navigate', { url: `${site.origin}/counter` }), assistantToolCall('c4', 'browser_act', { action: 'click', ref: 'e999' }))
    expect(profiles(w.profileRoot)).toHaveLength(2)
    expect(theirs[1]!.code, 'a ref this agent’s browser never minted').toBe('BROWSER_STALE_REF')
    await first.dispose()
    expect(profiles(w.profileRoot)).toHaveLength(1)
    await second.dispose()
    expect(profiles(w.profileRoot)).toEqual([])
  })

  it('ends a long call promptly when the turn is cancelled, and the next call runs', LONG, async () => {
    const site = await pages()
    const w = await world({ vision: false })
    const handle = await w.create()
    await turn(w, handle, assistantToolCall('c1', 'browser_navigate', { url: `${site.origin}/counter` }))
    // Only the call: the cancelled turn never reaches a next step to answer.
    w.harness.adapter.script(assistantToolCall('c2', 'browser_evaluate', { expression: 'new Promise(() => {})', timeout_ms: 60_000 }))
    handle.agent.followup(createUserMessage('wait forever'))
    // Cancel once the call is dispatched, then measure how long the turn takes to stop.
    const deadline = Date.now() + 30_000
    while (!handle.agent.session.facts.some((event) => event.type === 'tool/dispatch') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const cancelledAt = Date.now()
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
    expect(Date.now() - cancelledAt, 'the cancelled call held the turn').toBeLessThan(5_000)
    const after = await turn(w, handle, assistantToolCall('c3', 'browser_evaluate', { expression: '6 * 7' }))
    expect(after.at(-2)?.code, 'the cancelled call names its cancellation').toBe('ABORTED')
    expect(after.at(-1)?.text).toContain('42')
  })

  it('starts the browser again after it died, says so once, and old refs fail', LONG, async () => {
    const site = await pages()
    const w = await world({ vision: false })
    const handle = await w.create()
    const [opened] = await turn(w, handle, assistantToolCall('c1', 'browser_navigate', { url: `${site.origin}/counter` }))
    const ref = refIn(opened!.text, 'button "Add one"')
    // Kill the browser out of band: every process whose profile is the agent's.
    const [profile] = profiles(w.profileRoot)
    const owner = JSON.parse(String(await import('node:fs').then((fs) => fs.readFileSync(join(w.profileRoot, profile!, 'owner.json'))))) as { pid: number }
    expect(owner.pid).toBe(process.pid)
    await killBrowserOf(join(w.profileRoot, profile!))
    // Navigate first, so the NEW browser mints refs before the old one is
    // tried: a ref counter that restarted at e1 would hand the old ref to the
    // new page's button, and the click would land. (On a loaded host the first
    // navigate can race the dying pipe and be told the browser went away; the
    // second then starts it again.)
    const out = await turn(
      w,
      handle,
      assistantToolCall('c2', 'browser_navigate', { url: `${site.origin}/counter` }),
      assistantToolCall('c3', 'browser_navigate', { url: `${site.origin}/counter` }),
      assistantToolCall('c4', 'browser_act', { action: 'click', ref }),
      assistantToolCall('c5', 'browser_snapshot', {}),
    )
    const [first, second, act, after] = out.slice(-4)
    expect([first, second].filter((result) => result?.text.includes('The browser had exited and was started again')), 'the relaunch is said exactly once').toHaveLength(1)
    expect(second?.code).toBeUndefined()
    expect(act?.code, 'an old ref must not name a node in the new browser').toBe('BROWSER_STALE_REF')
    expect(after?.text, 'the old ref clicked something after all').toMatch(/paragraph \[ref=e\d+\]: 0/)
    expect(after?.text).not.toContain('started again')
    expect(existsSync(join(w.profileRoot, profile!)), 'the dead browser’s profile was left behind').toBe(false)
  })

  it('remembers a fact about the host, not a moment: a fence it cannot prove is refused fast and said so, a start that died is tried again', LONG, async () => {
    const harness = await coreHarness()
    harnesses.push(harness)
    const profileRoot = tempDir('minidsh-tb-memo-')
    // The canary host on the allow list goes direct, so the fence cannot be proved: a host fact.
    harness.root.plugin(toolBrowserPlugin, { profileRoot, executablePath: testBrowser!.path, allowHosts: ['minidsh-fence-canary.invalid'] })
    expect((await harness.root.settle()).failed).toEqual([])
    const w: World = { harness, cwd: tempDir('minidsh-tb-memo-cwd-'), profileRoot, store: '', create: () => harness.create({ cwd: tempDir('minidsh-tb-memo-cwd-') }) }
    const handle = await w.create()
    const out = await turn(w, handle, assistantToolCall('c1', 'browser_evaluate', { expression: '1' }), assistantToolCall('c2', 'browser_evaluate', { expression: '1' }))
    expect(out.map((result) => result.code)).toEqual(['BROWSER_FENCE_UNAVAILABLE', 'BROWSER_FENCE_UNAVAILABLE'])
    expect(out[0]!.text).not.toContain('remembered')
    expect(out[1]!.text).toContain('remembered from an earlier attempt')

    // A start that dies (here: an executable that is not a browser) is a moment.
    const other = await coreHarness()
    harnesses.push(other)
    other.root.plugin(toolBrowserPlugin, { profileRoot: tempDir('minidsh-tb-memo2-'), executablePath: process.execPath })
    expect((await other.root.settle()).failed).toEqual([])
    const w2: World = { harness: other, cwd: '', profileRoot: '', store: '', create: () => other.create({ cwd: tempDir('minidsh-tb-memo2-cwd-') }) }
    const tried = await turn(w2, await w2.create(), assistantToolCall('c1', 'browser_evaluate', { expression: '1' }), assistantToolCall('c2', 'browser_evaluate', { expression: '1' }))
    expect(tried.map((result) => result.code)).toEqual(['BROWSER_UNAVAILABLE', 'BROWSER_UNAVAILABLE'])
    expect(tried[1]!.text, 'a moment was remembered as a host fact').not.toContain('remembered')
  })

  it('numbers refs past every ref the history holds, and says the earlier browser is gone', LONG, async () => {
    const site = await pages()
    const w = await world({ vision: false })
    // A history that already shows a ref (as a resumed or forked session's
    // would): a tool result carrying one, before this agent's first browser call.
    w.harness.root.get(TOOLS).register(
      w.harness.root,
      defineTool({ name: 'old_snapshot', description: 'test', input: z.object({}), output: z.object({ text: z.string() }), render: (_args, value) => [{ type: 'text', text: value.text }], execute: () => ({ text: '- button "Old" [ref=e41]' }) }),
    )
    const handle = await w.create()
    const out = await turn(w, handle, assistantToolCall('c1', 'old_snapshot', {}), assistantToolCall('c2', 'browser_navigate', { url: `${site.origin}/counter` }))
    const navigated = out.at(-1)!
    expect(navigated.text).toContain("earlier browser was not carried over")
    const refs = Array.from(navigated.text.matchAll(/\[ref=e(\d+)\]/g), (match) => Number(match[1]))
    expect(refs.length).toBeGreaterThan(0)
    expect(Math.min(...refs), 'a new ref reused a number the history already shows').toBeGreaterThan(41)
  })
})

/** Kill the browser whose profile is `dir`, found by its command line: the test's stand-in for a crash. */
async function killBrowserOf(dir: string): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  if (process.platform === 'win32') {
    const needle = dir.replaceAll("'", "''")
    execFileSync('pwsh', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })
  } else {
    execFileSync('pkill', ['-KILL', '-f', `user-data-dir=${dir}`], { stdio: 'ignore' })
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}
