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
  '/fold': `<body style="margin:0"><div style="height:1500px">top</div><button onclick="out.textContent = 'below clicked'">Below</button><p id="out">idle</p><div style="height:1500px"></div></body>`,
  // The react-hot-toast pattern: an always-mounted, full-screen, click-through container.
  '/toaster': `<button onclick="out.textContent = 'clicked'">Save</button><p id="out">idle</p>
    <div id="toaster" style="position:fixed;inset:0;z-index:9999;pointer-events:none"></div>`,
  '/sticky': `<body style="margin:0"><header style="position:fixed;top:0;left:0;right:0;height:60px;background:#eee;z-index:5">Header</header>
    <div style="height:2000px;padding-top:80px"><button onclick="out.textContent = 'clicked'" style="height:80px">Target</button><p id="out">idle</p></div></body>`,
  '/dates': `<label>When <input type="date" id="d" value="2024-01-15"></label><label>At <input type="time" id="t"></label><p id="out"></p>
    <script>for (const field of [d, t]) field.addEventListener('change', () => out.textContent += field.id + '=' + field.value + ';')</script>`,
  '/hideable': `<label>Name <input id="n"></label><label>Size <select id="s"><option>S</option><option>M</option></select></label>`,
  '/multi': `<label>Tags <select id="m" multiple><option>a</option><option selected>b</option><option>c</option></select></label>`,
  '/debounce': `<button onclick="setTimeout(() => out.textContent = 'updated', 300)">Go</button><p id="out">idle</p>`,
  '/debounce-fetch': `<button onclick="setTimeout(() => fetch('/api').then((r) => r.text()).then((t) => out.textContent = t), 250)">Search</button><p id="out">idle</p>`,
  '/api': { type: 'text/plain', body: 'results arrived' },
  '/late-nav': `<button onclick="setTimeout(() => location.href = '/next', 250)">Later</button>`,
  '/next': '<p>next page</p>',
  '/shadow-late': `<open-el></open-el><closed-el></closed-el><script>
    const open = document.querySelector('open-el').attachShadow({ mode: 'open' })
    const closed = document.querySelector('closed-el').attachShadow({ mode: 'closed' })
    setTimeout(() => { open.innerHTML = '<p>Open shadow text</p>'; closed.innerHTML = '<p>Saved in shadow</p>' }, 300)
  </script>`,
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

    it('waits for text inside open and closed shadow roots, and honours waitUntil for the wait alone', LONG, async () => {
      await go('/shadow-late')
      for (const wanted of ['Saved in shadow', 'Open shadow text']) {
        expect(await page.snapshot({ ...budget(), waitForText: wanted, waitUntil: Date.now() + 5_000 })).toContain(wanted)
      }
      // Already there: a wait that is over at once still answers with the snapshot.
      expect(await page.snapshot({ ...budget(), waitForText: 'Saved in shadow', waitUntil: Date.now() + 1 })).toContain('Saved in shadow')
      // Not there: the wait ends at waitUntil, not at the call's deadline.
      const started = Date.now()
      await expect(page.snapshot({ ...budget(), waitForText: 'never here', waitUntil: Date.now() + 500 })).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT', message: expect.stringContaining('never here') })
      expect(Date.now() - started).toBeLessThan(2_500)
    })

    it('renders date and time inputs as textboxes showing their value, without their internal fields', LONG, async () => {
      const snapshot = await go('/dates')
      expect(snapshot).toMatch(/^ *- textbox "When" \[ref=e\d+\]: 2024-01-15$/m)
      expect(snapshot).toMatch(/^ *- textbox "At" \[ref=e\d+\]$/m)
      expect(snapshot).not.toContain('spinbutton')
      expect(snapshot).not.toContain('picker')
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

    it('clicks a button below the fold, which the hit test finds in document coordinates', LONG, async () => {
      await page.act({ kind: 'click', ref: refOf(await go('/fold'), 'button "Below"') }, acting())
      expect(await evaluate('out.textContent')).toBe('below clicked')
      expect(await evaluate('scrollY')).toBeGreaterThan(0)
    })

    it('clicks through a pointer-events:none overlay, as a person’s click goes through it', LONG, async () => {
      await page.act({ kind: 'click', ref: refOf(await go('/toaster'), 'button "Save"') }, acting())
      expect(await evaluate('out.textContent')).toBe('clicked')
    })

    it('clicks a button whose centre is under a fixed header by scrolling it to the middle first', LONG, async () => {
      await go('/sticky')
      // The button now spans 10..90 and the header 0..60: its centre is covered, its lower part is not.
      await evaluate('window.scrollTo(0, 70)')
      await page.act({ kind: 'click', ref: refOf(await page.snapshot(budget()), 'button "Target"') }, acting())
      expect(await evaluate('out.textContent')).toBe('clicked')
    })

    it('types into date and time fields by value, and refuses a value in the wrong format, naming the right one', LONG, async () => {
      const snapshot = await go('/dates')
      const field = (name: string): string => new RegExp(`- \\w+ "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot)![1]!
      await page.act({ kind: 'type', ref: field('When'), text: '2025-03-04', submit: false }, acting())
      await page.act({ kind: 'type', ref: field('At'), text: '13:45', submit: false }, acting())
      expect(await evaluate('[d.value, t.value, out.textContent]')).toEqual(['2025-03-04', '13:45', 'd=2025-03-04;t=13:45;'])
      await expect(page.act({ kind: 'type', ref: field('When'), text: 'March 4th', submit: false }, acting())).rejects.toMatchObject({
        code: 'BROWSER_NOT_ACTIONABLE',
        message: expect.stringContaining('YYYY-MM-DD'),
      })
      expect(await evaluate('d.value')).toBe('2025-03-04')
    })

    it('refuses to type into or select in an element that is not visible', LONG, async () => {
      const snapshot = await go('/hideable')
      const name = refOf(snapshot, 'textbox "Name"')
      const size = refOf(snapshot, 'combobox "Size"')
      await evaluate('n.style.display = "none"; s.style.display = "none"')
      await expect(page.act({ kind: 'type', ref: name, text: 'x', submit: false }, acting())).rejects.toMatchObject({ code: 'BROWSER_NOT_ACTIONABLE', message: expect.stringContaining('not visible') })
      await expect(page.act({ kind: 'select', ref: size, values: ['M'] }, acting())).rejects.toMatchObject({ code: 'BROWSER_NOT_ACTIONABLE', message: expect.stringContaining('not visible') })
      expect(await evaluate('[n.value, s.value]')).toEqual(['', 'S'])
    })

    it('adds to a multiple select’s selection and names the whole of it; a single select replaces', LONG, async () => {
      const tags = refOf(await go('/multi'), 'listbox "Tags"')
      expect(await page.act({ kind: 'select', ref: tags, values: ['c'] }, acting())).toBe(`selected "c" in listbox "Tags" [ref=${tags}]; its selection is now "b", "c"`)
      expect(await evaluate('Array.from(m.selectedOptions, (option) => option.value)')).toEqual(['b', 'c'])
      const colour = refOf(await go('/select'), 'combobox "Colour"')
      await page.act({ kind: 'select', ref: colour, values: ['b'] }, acting())
      expect(await page.act({ kind: 'select', ref: colour, values: ['g'] }, acting())).toBe(`selected "Green" in combobox "Colour" [ref=${colour}]`)
      expect(await evaluate('Array.from(s.selectedOptions, (option) => option.value)')).toEqual(['g'])
    })

    it('settles after the action: an update 300 ms later and a fetch 250 ms later are both in the next snapshot', LONG, async () => {
      await page.act({ kind: 'click', ref: refOf(await go('/debounce'), 'button "Go"') }, acting())
      expect(await page.snapshot(budget())).toMatch(/^- paragraph \[ref=e\d+\]: updated$/m)
      await page.act({ kind: 'click', ref: refOf(await go('/debounce-fetch'), 'button "Search"') }, acting())
      expect(await page.snapshot(budget())).toMatch(/^- paragraph \[ref=e\d+\]: results arrived$/m)
    })

    it('reports a navigation the action started 250 ms after its input', LONG, async () => {
      // The settle's claim (page.ts `afterAction`): what a handler starts within
      // the 500 ms quiet is caught. 400 ms left 100 ms for a late timer and the
      // event's delivery, which a loaded macos-latest overran once (2026-10-19).
      const done = await page.act({ kind: 'click', ref: refOf(await go('/late-nav'), 'button "Later"') }, acting())
      expect(done).toContain(`the page navigated to ${fixture.origin}/next`)
      expect(await page.snapshot(budget())).toContain('next page')
    })

    it('does not wait on an out-of-process frame’s document, whose end never reaches this page', LONG, async () => {
      // 127.0.0.1 framing localhost: another site, so another renderer.
      fixture.route('/oopif', `<p>host</p><iframe src="http://localhost:${fixture.port}/frame-inner"></iframe><button onclick="out.textContent = 'x'">Btn</button><p id="out">idle</p>`)
      let started = Date.now()
      await page.navigate(`${fixture.origin}/oopif`, { ...budget(), waitMs: 0 })
      expect(Date.now() - started).toBeLessThan(3_000)
      const button = refOf(await page.snapshot(budget()), 'button "Btn"')
      started = Date.now()
      await page.act({ kind: 'click', ref: button }, acting())
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(await evaluate('out.textContent')).toBe('x')
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
      // `refused` is the browser's own word (its progress ended `canceled`):
      // were downloads allowed, this entry would say `saved` and the file would land.
      expect((await page.report()).downloads).toEqual([{ name: DOWNLOAD_NAME, outcome: 'refused' }])
      const landed = (): boolean => [DOWNLOAD_NAME, `${DOWNLOAD_NAME}.crdownload`].some((name) => existsSync(join(homedir(), 'Downloads', name)))
      expect(await until(landed, 5_000)).toBe(false)
      // Navigating to it is refused the same way, and says why.
      await expect(page.navigate(`${fixture.origin}/file.bin`, { ...budget(), waitMs: 0 })).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_FAILED', message: expect.stringContaining(`is a download (${DOWNLOAD_NAME})`) })
      expect((await page.report()).downloads).toEqual([{ name: DOWNLOAD_NAME, outcome: 'refused' }])
      const profileFiles = readdirSync(browser.profileDir, { recursive: true }).map(String)
      expect(profileFiles.filter((file) => file.includes(DOWNLOAD_NAME))).toEqual([])
    })

    it('closes a popup unseen and names it', LONG, async () => {
      await page.act({ kind: 'click', ref: refOf(await go('/popup'), 'button "Open"') }, acting())
      expect((await page.report()).popups).toEqual([`${fixture.origin}/popup-target`])
      const pages = async (): Promise<number> => (await browser.cdp.send<{ targetInfos: { type: string }[] }>('Target.getTargets')).targetInfos.filter((target) => target.type === 'page').length
      // At the close's own bound (page.ts sends `Target.closeTarget` with a
      // 10 s budget), plus a margin: 5 s was shorter than the product allows,
      // and a loaded CI runner took longer (S20.5, check.yml on ubuntu).
      expect(await until(async () => (await pages()) === 1, 12_000)).toBe(true)
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
      // Its own browser: on ubuntu-latest a crashed renderer's host was slow to
      // reap it, and the shared page this file uses stopped answering with it.
      const own = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [], declared: [], window: { width: 1280, height: 800 } })
      const crashing = await openPage({ cdp: own.cdp, generation: 1, workspaceRoot: workspace, viewport: VIEWPORT, refs: { next: 1 } })
      try {
        await crashing.navigate(`${fixture.origin}/counter`, { ...budget(), waitMs: 0 })
        // The way an out-of-memory kill crashes a renderer: SIGKILL, which
        // leaves no core dump for a host's crash handler to hold it on
        // (`Page.crash` does, and CI's handler held the renderer past the wait).
        const { processInfo } = await own.cdp.send<{ processInfo: { type: string; id: number }[] }>('SystemInfo.getProcessInfo')
        const renderers = processInfo.filter((process) => process.type === 'renderer')
        expect(renderers.length, 'the browser reported no renderer to crash').toBeGreaterThan(0)
        for (const renderer of renderers) process.kill(renderer.id, 'SIGKILL')
        expect(await until(async () => (await crashing.report()).crashed, 15_000)).toBe(true)
        await expect(crashing.snapshot(budget())).rejects.toMatchObject({ code: 'BROWSER_CLOSED', message: expect.stringContaining('crashed') })
        expect(await crashing.navigate(`${fixture.origin}/counter`, { ...budget(), waitMs: 0 })).toEqual({ loaded: true })
        expect((await crashing.report()).crashed).toBe(false)
        expect(await crashing.snapshot(budget())).toContain('button "Add one"')
      } finally {
        await crashing.close()
        await own.close()
      }
    })

    it('answers whether it is responsive: yes while idle, no while a script holds its main thread', LONG, async () => {
      fixture.route('/freeze', `<title>Freeze</title><button onclick="for (;;) {}">Freeze</button>`)
      await go('/freeze')
      expect(await page.responsive(3_000)).toBe(true)
      // A page in this state answers nothing, so this file's shared page is not used for it.
      const own = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [], declared: [], window: { width: 1280, height: 800 } })
      const frozen = await openPage({ cdp: own.cdp, generation: 1, workspaceRoot: workspace, viewport: VIEWPORT, refs: { next: 1 } })
      try {
        await frozen.navigate(`${fixture.origin}/freeze`, { ...budget(), waitMs: 0 })
        await frozen.evaluate("setTimeout(() => { for (;;) {} }, 50); 'armed'", budget())
        await new Promise((resolve) => setTimeout(resolve, 300))
        const started = Date.now()
        expect(await frozen.responsive(1_000)).toBe(false)
        expect(Date.now() - started, 'the probe outlived its own bound').toBeLessThan(2_500)
      } finally {
        await frozen.close()
        await own.close()
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

    it('says what a value that cannot come back as JSON was, rather than answering {}', LONG, async () => {
      await go('/format')
      expect(await page.evaluate('({})', budget())).toEqual({ value: {} })
      expect(await page.evaluate('Object.assign(document.createElement("p"), { id: "x", className: "y" })', budget())).toEqual({ unreturnable: 'a DOM node: <p id="x" class="y">' })
      expect(await page.evaluate('Symbol("s")', budget())).toEqual({ unreturnable: expect.stringMatching(/^a Symbol/) })
      expect(await page.evaluate('() => 1', budget())).toEqual({ unreturnable: expect.stringMatching(/^a function/) })
      expect(await page.evaluate('new Map([[1, 2]])', budget())).toEqual({ unreturnable: expect.stringMatching(/^a Map/) })
      // `window` refers to itself: the browser cannot serialise it, and that is said, not thrown.
      expect(await page.evaluate('window', budget())).toEqual({ unreturnable: expect.any(String) })
      expect(await page.evaluate('Promise.reject(new Error("still thrown"))', budget())).toEqual({ exception: expect.stringContaining('Error: still thrown') })
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
