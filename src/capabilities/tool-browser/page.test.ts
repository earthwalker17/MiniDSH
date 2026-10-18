/**
 * The page model against a real browser: what the model reads (the snapshot),
 * what it does (the actions and their refusals), what it is told (the report),
 * and the fences and deadlines that bound all three. One browser and one page
 * serve the file; each test navigates to its own fixture first.
 *
 * Self-skips where no Chrome, Edge or Chromium is installed; under
 * `MINIDSH_EXPECT_BROWSER=1` that is a failure (`expectBrowserSuite`).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectBrowserSuite, fixtureServer, testBrowser, type FixtureServer, type Route } from '../../test-support/browser-fixture.ts'
import { launchBrowser, type LaunchedBrowser } from './launch.ts'
import { openPage } from './page.ts'
import type { BrowserPage, CallBudget } from './types.ts'

expectBrowserSuite('tool-browser page')

const LONG = { timeout: 120_000 }
const VIEWPORT = { width: 1000, height: 700 }
const DOWNLOAD_NAME = `minidsh-download-${process.pid}-${Date.now()}.bin`

/** A PNG's pixel size, from its IHDR. */
const pngSize = (data: Uint8Array): [number, number] => {
  const bytes = Buffer.from(data)
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

const budget = (ms = 30_000): CallBudget => ({ signal: new AbortController().signal, deadline: Date.now() + ms })
const acting = (dialog: 'accept' | 'dismiss' = 'dismiss'): CallBudget & { dialog: 'accept' | 'dismiss' } => ({ ...budget(), dialog })

/** The ref on the first snapshot line naming `node` (`button "Add one"`), whatever flags sit between. */
function refOf(snapshot: string, node: string): string {
  const escaped = node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`- ${escaped}(?: \\[[^\\]]+\\])*? \\[ref=(e\\d+)\\]`).exec(snapshot)
  if (!match) throw new Error(`no ${node} in the snapshot:\n${snapshot}`)
  return match[1]!
}

const ROWS = Array.from({ length: 20 }, (_, i) => `<tr><td>Item ${i + 1}</td><td>${(i + 1) * 3}</td><td><a href="/item/${i + 1}">Edit</a></td></tr>`).join('')

const ROUTES: Record<string, Route> = {
  '/format': `<title>Format</title><h1>Title</h1><button>Add one</button><input type="checkbox" checked aria-label="Agree"><p>Hello <b>world</b></p><ul><li>One</li><li>Two</li></ul>`,
  '/counter': `<button onclick="count.textContent = String(Number(count.textContent) + 1)">Add one</button><p id="count">0</p>`,
  // React's value tracking, reduced: a value a SCRIPT assigns is recorded by
  // the setter, and an input event that finds the field holding exactly that
  // value is ignored. So `.value = …` plus a synthetic event changes nothing
  // here, and only real input reaches the state.
  '/controlled': `<label for="name">Name</label><input id="name"><p id="mirror"></p><script>
    const input = document.getElementById('name')
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    let tracked = ''
    Object.defineProperty(input, 'value', { configurable: true, get() { return native.get.call(this) }, set(v) { tracked = String(v); native.set.call(this, v) } })
    let state = 'old'
    const render = () => { input.value = state; mirror.textContent = state }
    input.addEventListener('input', () => { if (input.value === tracked) return; state = input.value; render() })
    render()
  </script>`,
  '/form': `<form id="f"><label>Query <input name="q"></label><button>Go</button></form><p id="out">waiting</p><script>
    f.addEventListener('submit', (event) => { event.preventDefault(); out.textContent = 'submitted ' + f.q.value })
  </script>`,
  '/select': `<label>Colour <select id="s"><option value="r">Red</option><option value="b">Blue</option><option value="g">Green</option></select></label><p id="out">none</p><script>
    s.addEventListener('change', () => { out.textContent = 'chose ' + s.value })
  </script>`,
  '/targets': `<div onclick="out.textContent = 'div clicked'">click me</div>
    <button onclick="out.textContent = 'span button'"><span style="display:inline-block;padding:20px">Inner</span></button>
    <button onmouseenter="out.textContent = 'hovered'">Hover me</button><p id="out">idle</p>`,
  '/frame-host': `<p>host</p><iframe src="/frame-inner" style="position:absolute;left:200px;top:150px;width:300px;height:200px;border:0"></iframe>`,
  '/frame-inner': `<body style="margin:0"><button style="margin:40px 0 0 60px" onclick="document.body.insertAdjacentHTML('beforeend', '<p>frame clicked</p>')">In frame</button></body>`,
  '/overlay': `<button onclick="window.hits = (window.hits || 0) + 1">Covered</button>
    <div id="overlay" class="modal shade" style="position:fixed;inset:0;background:rgba(0,0,0,.3)">Please wait</div>`,
  '/frame-covered': `<iframe src="/frame-inner" style="position:absolute;left:200px;top:150px;width:300px;height:200px;border:0"></iframe>
    <div id="veil" style="position:fixed;inset:0"></div>`,
  // The custom-checkbox pattern: the real input sits under its label's styled span.
  '/label-cover': `<label style="position:relative;display:inline-block"><input type="checkbox" id="c" aria-label="Accept terms" style="position:absolute;left:0;top:0;margin:0">
    <span style="position:relative;display:inline-block;width:80px;height:24px;background:#ccc">Accept</span></label>`,
  '/disabled': `<button disabled onclick="window.hit = 'button'">Off</button><div role="button" aria-disabled="true" onclick="window.hit = 'aria'">Aria off</div>`,
  '/noisy': `<title>Noisy</title><script>console.error('boom', 42)</script><script>setTimeout(() => { throw new Error('kaboom') }, 0)</script>
    <img src="/missing.png"><img src="http://denied.invalid/pixel.png">`,
  '/dialogs': `<button onclick="alert('hello'); out.textContent = 'after alert'">Alert</button>
    <button onclick="out.textContent = confirm('sure?') ? 'yes' : 'no'">Confirm</button><p id="out">idle</p>`,
  '/download': `<a href="/file.bin" download>Get file</a>`,
  '/file.bin': { type: 'application/octet-stream', body: 'not for disk', headers: { 'content-disposition': `attachment; filename="${DOWNLOAD_NAME}"` } },
  '/rerender': `<div id="root"></div><script>function render() { root.innerHTML = '<button onclick="render()">Rerender</button>' } render()</script>`,
  '/popup': `<button onclick="window.open('/popup-target')">Open</button>`,
  '/popup-target': '<p>popup</p>',
  '/tall': `<body style="margin:0"><div style="height:5000px;background:linear-gradient(red, blue)">tall</div></body>`,
  '/box': `<body style="margin:0;background:rgb(0,0,255)"><div style="height:1200px"></div>
    <div role="img" aria-label="red box" style="width:123px;height:45px;background:rgb(255,0,0)"></div><div style="height:1200px"></div></body>`,
  '/late': `<p>before</p><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>arrived late</p>'), 1500)</script>`,
  '/keys': `<input id="a" aria-label="First" value="abc"><input id="b" aria-label="Second"><p id="mirror"></p><script>
    a.addEventListener('input', () => { mirror.textContent = 'value:' + a.value })
  </script>`,
  '/chooser': `<input type="file" aria-label="Upload">`,
  '/medium': `<title>Medium</title><nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a> <a href="/about">About</a></nav>
    <main><h1>Orders</h1><form><label>Name <input name="n"></label><label>Email <input type="email" name="e"></label>
    <label>Plan <select name="p"><option>Free</option><option>Pro</option></select></label><label><input type="checkbox" name="t"> Terms</label>
    <button>Save</button></form><table><thead><tr><th>Item</th><th>Qty</th><th></th></tr></thead><tbody>${ROWS}</tbody></table></main>`,
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function until(test: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return test()
}

/** One pixel of an 8-bit RGB or RGBA PNG, decoded by hand (MiniDSH takes no image dependency). */
function pixel(png: Uint8Array, x: number, y: number): [number, number, number] {
  const bytes = Buffer.from(png)
  const width = bytes.readUInt32BE(16)
  const colourType = bytes[25]
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0
  if (bytes[24] !== 8 || channels === 0) throw new Error(`unexpected PNG: depth ${bytes[24]}, colour type ${colourType}`)
  const chunks: Buffer[] = []
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  let previous = new Uint8Array(stride)
  let line = new Uint8Array(stride)
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)]
    line = new Uint8Array(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels]! : 0
      const up = previous[i]!
      const upLeft = i >= channels ? previous[i - channels]! : 0
      if (filter === 1) line[i] = line[i]! + left
      else if (filter === 2) line[i] = line[i]! + up
      else if (filter === 3) line[i] = line[i]! + Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upLeft
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)]
        line[i] = line[i]! + (a <= b && a <= c ? left : b <= c ? up : upLeft)
      }
    }
    previous = line
  }
  return [line[x * channels]!, line[x * channels + 1]!, line[x * channels + 2]!]
}

describe.runIf(testBrowser !== undefined)('a page in a real browser', () => {
  let browser: LaunchedBrowser
  let page: BrowserPage
  let fixture: FixtureServer
  let workspace: string
  let outside: string
  const dirs: string[] = []
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  beforeAll(async () => {
    workspace = tempDir('minidsh-workspace-')
    outside = tempDir('minidsh-outside-')
    fixture = await fixtureServer(ROUTES)
    browser = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [], declared: [], window: { width: 1280, height: 800 } })
    page = await openPage({ cdp: browser.cdp, generation: 1, workspaceRoot: workspace, viewport: VIEWPORT, refs: { next: 1 } })
  }, 120_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await fixture?.close()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }, 120_000)

  /** Load a fixture and drain the report, so each test reads only what it caused. */
  async function go(path: string): Promise<string> {
    await page.navigate(`${fixture.origin}${path}`, { ...budget(), waitMs: 0 })
    await page.report()
    return page.snapshot(budget())
  }

  const evaluate = async (expression: string): Promise<unknown> => (await page.evaluate(expression, budget())).value

  describe('the snapshot', () => {
    it('renders the accessibility tree as Playwright’s AI snapshot does, and a quiet page keeps its refs', LONG, async () => {
      const first = await go('/format')
      expect(first.replace(/\[ref=e\d+\]/g, '[ref]')).toBe(
        [
          '- heading "Title" [level=1] [ref]',
          '- button "Add one" [ref]',
          '- checkbox "Agree" [checked] [ref]',
          '- paragraph [ref]: Hello world',
          '- list [ref]:',
          '  - listitem [ref]: One',
          '  - listitem [ref]: Two',
        ].join('\n'),
      )
      expect(await page.snapshot(budget())).toBe(first)
    })

    it('roots at a ref, waits for text, and refuses a ref it never gave', LONG, async () => {
      const whole = await go('/format')
      const list = refOf(whole, 'list')
      expect((await page.snapshot({ ...budget(), ref: list })).replace(/\[ref=e\d+\]/g, '[ref]')).toBe(['- list [ref]:', '  - listitem [ref]: One', '  - listitem [ref]: Two'].join('\n'))
      await expect(page.snapshot({ ...budget(), ref: 'e999999' })).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })

      const before = await go('/late')
      expect(before).not.toContain('arrived late')
      expect(await page.snapshot({ ...budget(), waitForText: 'arrived late' })).toContain('arrived late')
      const started = Date.now()
      await expect(page.snapshot({ ...budget(1_000), waitForText: 'never here' })).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT', message: expect.stringContaining('never here') })
      expect(Date.now() - started).toBeLessThan(2_500)
    })

    it('nests a same-origin frame under its iframe', LONG, async () => {
      const snapshot = await go('/frame-host')
      // Deeper than the iframe's own line: Chrome exposes this frame's body as a `generic` between them.
      expect(snapshot).toMatch(/^- iframe \[ref=e\d+\]:\n(?: {2,}- .*\n)* {2,}- button "In frame" \[ref=e\d+\]$/m)
    })

    it('measures a medium page: a nav, a form and a 20-row table', LONG, async () => {
      const snapshot = await go('/medium')
      process.stderr.write(`[page.test] medium fixture snapshot: ${snapshot.length} characters, ${snapshot.split('\n').length} lines\n`)
      expect(snapshot).toMatch(/- table \[ref=e\d+\]:/)
      expect(snapshot).toMatch(/- combobox "Plan" \[ref=e\d+\]:\n\s+- option "Free" \[selected\] \[ref=e\d+\]/)
      expect(snapshot.match(/- row /g)).toHaveLength(21)
    })
  })

  describe('actions', () => {
    it('clicks with real input, and the next snapshot shows what changed', LONG, async () => {
      const before = await go('/counter')
      expect(before).toMatch(/^- paragraph \[ref=e\d+\]: 0$/m)
      const button = refOf(before, 'button "Add one"')
      expect(await page.act({ kind: 'click', ref: button }, acting())).toBe(`clicked button "Add one" [ref=${button}]`)
      const after = await page.snapshot(budget())
      expect(after).toMatch(/^- paragraph \[ref=e\d+\]: 1$/m)
      expect(refOf(after, 'button "Add one"')).toBe(button)
    })

    it('types into a value-tracking input as real input, replacing what was there, and clears it', LONG, async () => {
      const before = await go('/controlled')
      expect(before).toMatch(/- textbox "Name" \[ref=e\d+\]: old$/m)
      const field = refOf(before, 'textbox "Name"')
      expect(await page.act({ kind: 'type', ref: field, text: 'hello world', submit: false }, acting())).toBe(`typed 11 characters into textbox "Name" [ref=${field}]`)
      expect(await evaluate('mirror.textContent')).toBe('hello world')
      expect(await page.snapshot(budget())).toMatch(/- textbox "Name" \[active\] \[ref=e\d+\]: hello world$/m)
      expect(await page.act({ kind: 'type', ref: field, text: '', submit: false }, acting())).toBe(`cleared textbox "Name" [ref=${field}]`)
      expect(await evaluate('mirror.textContent')).toBe('')
    })

    it('presses Enter after typing, and the form submits', LONG, async () => {
      const field = refOf(await go('/form'), 'textbox "Query"')
      expect(await page.act({ kind: 'type', ref: field, text: 'abc', submit: true }, acting())).toBe(`typed 3 characters into textbox "Query" [ref=${field}] and pressed Enter`)
      expect(await evaluate('out.textContent')).toBe('submitted abc')
    })

    it('selects by value, then by label, and lists the options when none matches', LONG, async () => {
      const colour = refOf(await go('/select'), 'combobox "Colour"')
      expect(await page.act({ kind: 'select', ref: colour, values: ['b'] }, acting())).toBe(`selected "Blue" in combobox "Colour" [ref=${colour}]`)
      expect(await evaluate('out.textContent')).toBe('chose b')
      await page.act({ kind: 'select', ref: colour, values: ['Green'] }, acting())
      expect(await evaluate('out.textContent')).toBe('chose g')
      expect(await page.snapshot(budget())).toMatch(/- option "Green" \[selected\]/)
      await expect(page.act({ kind: 'select', ref: colour, values: ['Purple'] }, acting())).rejects.toMatchObject({
        code: 'BROWSER_NOT_ACTIONABLE',
        message: expect.stringContaining('"Red" (value "r"), "Blue" (value "b"), "Green" (value "g")'),
      })
      const notSelect = refOf(await go('/counter'), 'button "Add one"')
      await expect(page.act({ kind: 'select', ref: notSelect, values: ['x'] }, acting())).rejects.toMatchObject({ code: 'BROWSER_NOT_ACTIONABLE' })
    })

    it('clicks a div that has only an onclick, a button through the span it wraps, and hovers', LONG, async () => {
      const snapshot = await go('/targets')
      const div = refOf(snapshot, 'generic')
      expect(snapshot).toContain(`- generic [ref=${div}]: click me`)
      await page.act({ kind: 'click', ref: div }, acting())
      expect(await evaluate('out.textContent')).toBe('div clicked')
      await page.act({ kind: 'click', ref: refOf(snapshot, 'button "Inner"') }, acting())
      expect(await evaluate('out.textContent')).toBe('span button')
      const hover = refOf(snapshot, 'button "Hover me"')
      expect(await page.act({ kind: 'hover', ref: hover }, acting())).toBe(`hovered button "Hover me" [ref=${hover}]`)
      expect(await evaluate('out.textContent')).toBe('hovered')
    })

    it('clicks a button inside a same-origin iframe by its ref, at the frame’s offset', LONG, async () => {
      const button = refOf(await go('/frame-host'), 'button "In frame"')
      await page.act({ kind: 'click', ref: button }, acting())
      expect(await page.snapshot(budget())).toContain('frame clicked')
    })

    it('refuses a covered button, naming the cover, and its handler never runs', LONG, async () => {
      const button = refOf(await go('/overlay'), 'button "Covered"')
      await expect(page.act({ kind: 'click', ref: button }, acting())).rejects.toMatchObject({
        code: 'BROWSER_NOT_ACTIONABLE',
        message: expect.stringContaining('<div id="overlay" class="modal shade"> "Please wait"'),
      })
      expect(await evaluate('window.hits ?? 0')).toBe(0)
    })

    it('refuses a button in a frame that the page above it covers', LONG, async () => {
      const button = refOf(await go('/frame-covered'), 'button "In frame"')
      await expect(page.act({ kind: 'click', ref: button }, acting())).rejects.toMatchObject({ code: 'BROWSER_NOT_ACTIONABLE', message: expect.stringContaining('<div id="veil">') })
      expect(await page.snapshot(budget())).not.toContain('frame clicked')
    })

    it('clicks a checkbox through the label that covers it, as a person clicking the label would', LONG, async () => {
      const box = refOf(await go('/label-cover'), 'checkbox "Accept terms"')
      await page.act({ kind: 'click', ref: box }, acting())
      expect(await evaluate('c.checked')).toBe(true)
      expect(await page.snapshot(budget())).toMatch(/- checkbox "Accept terms" \[checked\]/)
    })

    it('refuses a disabled button and an aria-disabled one', LONG, async () => {
      const snapshot = await go('/disabled')
      expect(snapshot).toMatch(/- button "Off" \[disabled\] \[ref=e\d+\]/)
      for (const name of ['Off', 'Aria off']) {
        await expect(page.act({ kind: 'click', ref: refOf(snapshot, `button "${name}"`) }, acting())).rejects.toMatchObject({
          code: 'BROWSER_NOT_ACTIONABLE',
          message: expect.stringContaining('is disabled'),
        })
      }
      expect(await evaluate('window.hit ?? null')).toBe(null)
    })

    it('presses keys and chords, on a ref or on whatever has focus, and refuses a name it does not know', LONG, async () => {
      const snapshot = await go('/keys')
      const first = refOf(snapshot, 'textbox "First"')
      // The select-all chord is the platform's.
      const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+A'
      expect(await page.act({ kind: 'press', key: selectAll, ref: first }, acting())).toBe(`pressed ${selectAll} in textbox "First" [ref=${first}]`)
      await page.act({ kind: 'press', key: 'Backspace' }, acting())
      expect(await evaluate('a.value')).toBe('')
      await page.act({ kind: 'press', key: 'x' }, acting())
      await page.act({ kind: 'press', key: 'Shift+y' }, acting())
      expect(await evaluate('mirror.textContent')).toBe('value:xY')
      await page.act({ kind: 'press', key: 'Tab' }, acting())
      expect(await page.snapshot(budget())).toMatch(/- textbox "Second" \[active\] \[ref=e\d+\]/)
      await expect(page.act({ kind: 'press', key: 'Hyper+Q' }, acting())).rejects.toMatchObject({ code: 'BROWSER_NOT_ACTIONABLE', message: expect.stringContaining('Enter, Tab') })
    })

    it('refuses a ref whose node a re-render replaced', LONG, async () => {
      const old = refOf(await go('/rerender'), 'button "Rerender"')
      await page.act({ kind: 'click', ref: old }, acting())
      await expect(page.act({ kind: 'click', ref: old }, acting())).rejects.toMatchObject({ code: 'BROWSER_STALE_REF', message: expect.stringContaining('take a new snapshot') })
      const fresh = refOf(await page.snapshot(budget()), 'button "Rerender"')
      expect(fresh).not.toBe(old)
      await page.act({ kind: 'click', ref: fresh }, acting())
    })

    it('refuses a ref from before a cross-origin navigation, though the new page looks the same', LONG, async () => {
      const old = refOf(await go('/counter'), 'button "Add one"')
      await page.navigate(`http://localhost:${fixture.port}/counter`, { ...budget(), waitMs: 0 })
      // Snapshot first: a renderer numbers backend nodes lazily, from the same
      // start, so only once the new document's nodes are numbered can the old
      // ref's id name a live node here — the case the ref's document must refuse.
      expect(refOf(await page.snapshot(budget()), 'button "Add one"')).not.toBe(old)
      await expect(page.act({ kind: 'click', ref: old }, acting())).rejects.toMatchObject({ code: 'BROWSER_STALE_REF' })
      expect(await evaluate('count.textContent')).toBe('0')
    })
  })

  describe('the report', () => {
    it('carries console errors, exceptions and failed requests with where they came from, once', LONG, async () => {
      await page.navigate(`${fixture.origin}/noisy`, { ...budget(), waitMs: 0 })
      const report = await page.report()
      expect(report).toMatchObject({ url: `${fixture.origin}/noisy`, title: 'Noisy', status: 200, navigated: true, crashed: false, omitted: 0 })
      expect(report.console).toEqual([{ level: 'error', text: 'boom 42', where: expect.stringMatching(/\/noisy:1$/) }])
      expect(report.exceptions).toEqual([expect.stringMatching(/^Error: kaboom \(at .*\/noisy:1\)$/)])
      expect(report.failedRequests).toEqual(
        expect.arrayContaining([
          { url: `${fixture.origin}/missing.png`, reason: '404', fenced: false },
          { url: 'http://denied.invalid/pixel.png', reason: '403', fenced: true },
        ]),
      )
      expect(report.failedRequests).toHaveLength(2)
      const next = await page.report()
      expect(next).toMatchObject({ console: [], exceptions: [], failedRequests: [], navigated: false })
    })

    it('answers dialogs at once: an alert accepted, a confirm as the action says, dismissed outside an action', LONG, async () => {
      const snapshot = await go('/dialogs')
      await page.act({ kind: 'click', ref: refOf(snapshot, 'button "Alert"') }, acting('dismiss'))
      expect(await evaluate('out.textContent')).toBe('after alert')
      const confirm = refOf(snapshot, 'button "Confirm"')
      await page.act({ kind: 'click', ref: confirm }, acting('accept'))
      expect(await evaluate('out.textContent')).toBe('yes')
      await page.act({ kind: 'click', ref: confirm }, acting('dismiss'))
      expect(await evaluate('out.textContent')).toBe('no')
      expect(await evaluate('confirm("outside")')).toBe(false)
      expect((await page.report()).dialogs).toEqual([
        { type: 'alert', message: 'hello', answer: 'accepted' },
        { type: 'confirm', message: 'sure?', answer: 'accepted' },
        { type: 'confirm', message: 'sure?', answer: 'dismissed' },
        { type: 'confirm', message: 'outside', answer: 'dismissed' },
      ])
    })

    it('reports a download the browser refused, and nothing lands in Downloads or the profile', LONG, async () => {
      await page.act({ kind: 'click', ref: refOf(await go('/download'), 'link "Get file"') }, acting())
      expect((await page.report()).downloads).toEqual([DOWNLOAD_NAME])
      for (const name of [DOWNLOAD_NAME, `${DOWNLOAD_NAME}.crdownload`]) expect(existsSync(join(homedir(), 'Downloads', name))).toBe(false)
      // Navigating to it is refused the same way, and says why.
      await expect(page.navigate(`${fixture.origin}/file.bin`, { ...budget(), waitMs: 0 })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_FAILED', message: expect.stringContaining(`is a download (${DOWNLOAD_NAME})`) })
      expect((await page.report()).downloads).toEqual([DOWNLOAD_NAME])
      const profileFiles = readdirSync(browser.profileDir, { recursive: true }).map(String)
      expect(profileFiles.filter((file) => file.includes(DOWNLOAD_NAME))).toEqual([])
    })

    it('closes a popup unseen and names it', LONG, async () => {
      await page.act({ kind: 'click', ref: refOf(await go('/popup'), 'button "Open"') }, acting())
      expect((await page.report()).popups).toEqual([`${fixture.origin}/popup-target`])
      const pages = async (): Promise<number> => (await browser.cdp.send<{ targetInfos: { type: string }[] }>('Target.getTargets')).targetInfos.filter((target) => target.type === 'page').length
      expect(await until(async () => (await pages()) === 1, 5_000)).toBe(true)
    })

    it('notes a file chooser, which never opens', LONG, async () => {
      const snapshot = await go('/chooser')
      const upload = /- (\w+) "Upload"[^\n]*\[ref=(e\d+)\]/.exec(snapshot)
      expect(upload, snapshot).not.toBeNull()
      await page.act({ kind: 'click', ref: upload![2]! }, acting())
      expect((await page.report()).console).toEqual([expect.objectContaining({ level: 'warning', text: expect.stringContaining('file chooser') })])
    })
  })

  describe('navigation', () => {
    it('waits for a loopback server that is still starting', LONG, async () => {
      const port = await freePort()
      const late = new Promise<FixtureServer>((resolve, reject) => {
        setTimeout(() => void fixtureServer({ '/': '<p>late server</p>' }, { port }).then(resolve, reject), 1_000)
      })
      try {
        const started = Date.now()
        expect(await page.navigate(`http://127.0.0.1:${port}/`, { ...budget(20_000), waitMs: 10_000 })).toEqual({ loaded: true })
        expect(Date.now() - started).toBeGreaterThanOrEqual(900)
        expect(await page.snapshot(budget())).toContain('late server')
        // The refused attempts were this call's business, not the page's.
        expect(await page.report()).toMatchObject({ status: 200, failedRequests: [] })
      } finally {
        await (await late).close()
      }
    })

    it('rejects a port nothing listens on once waitMs has passed, naming the error and the URL', LONG, async () => {
      const port = await freePort()
      const error = await page.navigate(`http://127.0.0.1:${port}/x`, { ...budget(), waitMs: 300 }).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: 'BROWSER_NAVIGATION_FAILED', message: expect.stringContaining('net::ERR_CONNECTION_REFUSED') })
      expect((error as Error).message).toContain(`http://127.0.0.1:${port}/x`)
    })

    it('fences file: loads to the workspace — a frame outside shows nothing and is named, a frame inside renders', LONG, async () => {
      const secret = join(outside, 'secret.html')
      writeFileSync(secret, '<p>TOP SECRET OUTSIDE</p>')
      writeFileSync(join(workspace, 'inside.html'), '<p>INSIDE FRAME TEXT</p>')
      const secretUrl = pathToFileURL(secret).href
      writeFileSync(join(workspace, 'host.html'), `<p>file host</p><iframe src="${secretUrl}"></iframe><iframe src="inside.html"></iframe>`)
      await page.navigate(pathToFileURL(join(workspace, 'host.html')).href, { ...budget(), waitMs: 0 })
      const snapshot = await page.snapshot(budget())
      expect(snapshot).toContain('INSIDE FRAME TEXT')
      expect(snapshot).not.toContain('TOP SECRET')
      expect(await page.report()).toMatchObject({ blockedFiles: [secretUrl], failedRequests: [] })

      await expect(page.navigate(secretUrl, { ...budget(), waitMs: 0 })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_FAILED' })
      expect((await page.report()).blockedFiles).toEqual([secretUrl])
    })

    it('survives a renderer crash: reported, other calls refused, a navigation loads it again', LONG, async () => {
      await go('/counter')
      const { targetInfos } = await browser.cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets')
      const ours = targetInfos.find((target) => target.type === 'page')!
      const { sessionId } = await browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: ours.targetId, flatten: true })
      try {
        // Page.crash never answers: the renderer it would answer from is gone.
        void browser.cdp.send('Page.crash', {}, { sessionId, timeoutMs: 2_000 }).catch(() => undefined)
        expect(await until(async () => (await page.report()).crashed, 10_000)).toBe(true)
        await expect(page.snapshot(budget())).rejects.toMatchObject({ code: 'BROWSER_CLOSED', message: expect.stringContaining('crashed') })
        expect(await page.navigate(`${fixture.origin}/counter`, { ...budget(), waitMs: 0 })).toEqual({ loaded: true })
        expect((await page.report()).crashed).toBe(false)
        expect(await page.snapshot(budget())).toContain('button "Add one"')
      } finally {
        await browser.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
      }
    })
  })

  describe('screenshots and evaluate', () => {
    it('captures the viewport as a PNG of the viewport’s size', LONG, async () => {
      await go('/format')
      const shot = await page.screenshot({ ...budget(), fullPage: false, maxDimension: 4_000, maxBytes: 5_000_000 })
      expect(shot.mediaType).toBe('image/png')
      expect(Buffer.from(shot.data.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a')
      expect(pngSize(shot.data)).toEqual([VIEWPORT.width, VIEWPORT.height])
      expect(shot.clipped).toBeUndefined()
    })

    it('cuts a tall full page at maxDimension and says so', LONG, async () => {
      await go('/tall')
      const shot = await page.screenshot({ ...budget(), fullPage: true, maxDimension: 2_000, maxBytes: 20_000_000 })
      expect(pngSize(shot.data)).toEqual([VIEWPORT.width, 2_000])
      expect(shot.clipped).toContain('5000')
    })

    it('captures one element at its own size and place, below the fold', LONG, async () => {
      const box = refOf(await go('/box'), 'img "red box"')
      const shot = await page.screenshot({ ...budget(), fullPage: false, ref: box, maxDimension: 4_000, maxBytes: 5_000_000 })
      expect(pngSize(shot.data)).toEqual([123, 45])
      // Every corner red: the clip is the box, not the blue page around it.
      for (const [x, y] of [[0, 0], [122, 0], [0, 44], [122, 44], [61, 22]] as const) expect(pixel(shot.data, x, y), `pixel ${x},${y}`).toEqual([255, 0, 0])
    })

    it('falls back to JPEG when the PNG is over maxBytes', LONG, async () => {
      await go('/format')
      const shot = await page.screenshot({ ...budget(), fullPage: false, maxDimension: 4_000, maxBytes: 100 })
      expect(shot.mediaType).toBe('image/jpeg')
      expect([shot.data[0], shot.data[1]]).toEqual([0xff, 0xd8])
    })

    it('evaluates to a JSON value, an exception as a value, NaN as a string, undefined as nothing', LONG, async () => {
      await go('/format')
      expect(await page.evaluate('({ list: [1, "two", null], ok: true })', budget())).toEqual({ value: { list: [1, 'two', null], ok: true } })
      expect(await page.evaluate('Promise.resolve(41 + 1)', budget())).toEqual({ value: 42 })
      expect(await page.evaluate('NaN', budget())).toEqual({ value: 'NaN' })
      expect(await page.evaluate('undefined', budget())).toEqual({})
      const thrown = await page.evaluate('throw new Error("nope")', budget())
      expect(thrown).toEqual({ exception: expect.stringContaining('Error: nope') })
    })

    it('ends a never-settling promise and a busy loop at the deadline, and the page answers after', LONG, async () => {
      await go('/format')
      for (const expression of ['new Promise(() => {})', 'while (true) {}']) {
        const started = Date.now()
        await expect(page.evaluate(expression, budget(1_000))).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT' })
        expect(Date.now() - started, expression).toBeLessThan(2_500)
        expect(await page.evaluate('1 + 1', budget(5_000))).toEqual({ value: 2 })
      }
    })
  })
})
