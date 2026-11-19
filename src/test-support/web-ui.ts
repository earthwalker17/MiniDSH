/**
 * The browser client in a REAL browser, against the real web host, in this
 * process: `startWebHost` booted over a scripted model and temp stores, and a
 * Chrome or Edge launched through tool-browser's own `launchBrowser` (its fence
 * admits loopback, which is all this needs), driven over raw CDP.
 *
 * Why not unit tests of the client's modules alone: the defects a page has
 * live where the modules meet the browser — a content security policy that
 * refuses a script, a Trusted Types sink, a socket that never opens, a
 * keystroke the handler never sees. So every page carries a TRIPWIRE: console
 * errors and warnings (`Runtime.consoleAPICalled`), uncaught exceptions
 * (`Runtime.exceptionThrown`) and browser log entries (`Log.entryAdded`, where
 * CSP violations and failed loads arrive) are recorded from before the first
 * navigation, and a test asserts there were none.
 *
 * Shape: one host and one browser per test FILE (`startWebUi` in `beforeAll`,
 * `close` in `afterAll`), a fresh page target per test (`page`, closed by
 * `closePages` in `afterEach`). The launch token is one-shot, so the first
 * page signs in through the printed URL and the rest ride the cookie it
 * minted, which every target in the browser's default context shares. Tests
 * share the scripted model too: each scripts what it is about to ask for.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
import type { CdpConnection, CdpEvent } from '../capabilities/tool-browser/cdp.ts'
import { launchBrowser, type LaunchedBrowser } from '../capabilities/tool-browser/launch.ts'
import { startWebHost, type WebHostHandle } from '../app/web.ts'
import { testBrowser } from './browser-fixture.ts'
import { ScriptedAdapter } from './scripted-adapter.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

/** The model every page talks to: the scripted adapter, under these names. */
export const UI_ROUTE = { provider: 'scripted', model: 'scripted-model' } as const

/**
 * An approval card that can be answered: shown, and its buttons armed (a new
 * card's are disabled for a beat, `approval.js`). Clicking before this is a
 * click on a disabled button, which answers nothing.
 */
export const APPROVAL_ARMED = "!document.querySelector('#approval').hidden && document.querySelector('#approval .btn.primary') !== null && ![...document.querySelectorAll('#approval .btn')].some((button) => button.disabled)"

/** One thing the page said went wrong. */
export interface UiProblem {
  readonly source: 'console' | 'exception' | 'log'
  readonly level: string
  readonly text: string
  readonly url?: string
}

export interface UiPage {
  /** Everything the tripwire recorded, in arrival order. */
  readonly problems: readonly UiProblem[]
  /** The value of `expression` in the page (a promise is awaited); a throw in the page rejects here and is no problem. */
  evaluate<T = unknown>(expression: string): Promise<T>
  /** Polls `predicate` (an expression) until it is truthy. */
  waitFor(predicate: string, timeoutMs?: number): Promise<void>
  /** A real left click, at the centre of the first element `selector` matches, scrolled into view. */
  click(selector: string): Promise<void>
  /** Focuses the element and inserts `text` the way an IME would: input events, no key events. */
  type(selector: string, text: string): Promise<void>
  /** A key on the focused element: `Enter`, `Tab`, `Escape`, an arrow, a character, with `Shift+`/`Control+`/`Alt+`/`Meta+` prefixes. */
  press(key: string): Promise<void>
  setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void>
  /** A PNG of the viewport, written to `path`. */
  screenshot(path: string): Promise<void>
  /**
   * The problems a test must not have: all of them, except a `/favicon.ico`
   * 404 on a page that links no icon — the browser asks for one on its own.
   */
  unexpectedProblems(): Promise<UiProblem[]>
  close(): Promise<void>
}

export interface WebUi {
  readonly host: WebHostHandle
  /** Shared by every page of the file: script what a test is about to ask for. */
  readonly adapter: ScriptedAdapter
  readonly origin: string
  /** The host's workspace root, an empty temp directory. */
  readonly workspace: string
  readonly browser: LaunchedBrowser
  /** A fresh page target, signed in, loaded, its tripwire armed from before the first byte. */
  page(): Promise<UiPage>
  /** Closes every page `page` opened; for `afterEach`. */
  closePages(): Promise<void>
  /** The pages, the browser, the host and every temp directory. Idempotent. */
  close(): Promise<void>
}

/** CDP's key descriptions for the named keys a test presses. */
const KEYS: Readonly<Record<string, { readonly code: string; readonly keyCode: number; readonly text?: string }>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
}

/** CDP's modifier bits. */
const MODIFIERS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A console call's arguments as one line, the way DevTools prints them. */
function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return ''
  return args
    .map((arg: { value?: unknown; description?: string; type?: string }) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type ?? '')))
    .join(' ')
}

/** What one CDP event says went wrong on a page, if anything. */
export function problemOf(event: CdpEvent): UiProblem | undefined {
  const params = event.params as Record<string, never>
  if (event.method === 'Runtime.consoleAPICalled') {
    const level = String(params.type)
    if (level !== 'error' && level !== 'warning' && level !== 'assert') return undefined
    return { source: 'console', level, text: consoleText(params.args) }
  }
  if (event.method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails as { text?: string; url?: string; exception?: { description?: string } } | undefined
    return { source: 'exception', level: 'error', text: details?.exception?.description ?? details?.text ?? 'an uncaught exception', ...(details?.url ? { url: details.url } : {}) }
  }
  if (event.method === 'Log.entryAdded') {
    const entry = params.entry as { level?: string; text?: string; url?: string; source?: string } | undefined
    if (entry?.level !== 'error' && entry?.level !== 'warning') return undefined
    return { source: 'log', level: entry.level, text: `[${entry.source ?? 'log'}] ${entry.text ?? ''}`, ...(entry.url ? { url: entry.url } : {}) }
  }
  return undefined
}

/**
 * The page object over ONE attached CDP session: evaluate, wait, click, type,
 * press, viewport, screenshot and the tripwire's record. Shared with the
 * desktop driver (`desktop-app.ts`), which attaches to the targets the app
 * opened itself rather than creating and navigating its own.
 */
export function pageFor(cdp: CdpConnection, sessionId: string, problems: UiProblem[], close: () => Promise<void>): UiPage {
  const on = { sessionId }
  const evaluate = async <T>(expression: string): Promise<T> => {
    const reply = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      on,
    )
    if (reply.exceptionDetails !== undefined) throw new Error(`the page threw evaluating ${expression}: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`)
    return reply.result.value as T
  }
  return {
    problems,
    evaluate,
    async waitFor(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (await evaluate<boolean>(`Boolean(${predicate})`)) return
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${predicate}`)
        await pause(50)
      }
    },
    async click(selector) {
      const point = await evaluate<{ x: number; y: number } | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const box = el.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })()`,
      )
      if (point === null) throw new Error(`no element matches ${selector}`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, on)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, on)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, on)
    },
    async type(selector, text) {
      const found = await evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.focus(); return true })()`)
      if (!found) throw new Error(`no element matches ${selector}`)
      await cdp.send('Input.insertText', { text }, on)
    },
    async press(chord) {
      const parts = chord.split('+')
      // `+` itself is a key: "Shift++" ends with an empty part.
      const key = chord.endsWith('++') ? '+' : parts.at(-1)!
      let modifiers = 0
      for (const name of parts.slice(0, chord.endsWith('++') ? -2 : -1)) {
        const bit = MODIFIERS[name]
        if (bit === undefined) throw new Error(`unknown modifier ${name} in ${chord}`)
        modifiers |= bit
      }
      const named = KEYS[key]
      if (named === undefined && [...key].length !== 1) throw new Error(`press: no key named ${key}`)
      const code = named?.code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : '')
      const keyCode = named?.keyCode ?? key.toUpperCase().charCodeAt(0)
      // Text only when no command modifier is held: Control+A selects, it types nothing.
      const text = modifiers & (MODIFIERS.Control! | MODIFIERS.Meta! | MODIFIERS.Alt!) ? undefined : (named === undefined ? key : named.text)
      const base = { key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
      await cdp.send('Input.dispatchKeyEvent', { ...base, type: text === undefined ? 'rawKeyDown' : 'keyDown', ...(text === undefined ? {} : { text, unmodifiedText: text }) }, on)
      await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, on)
    },
    async setViewport(width, height, deviceScaleFactor = 1) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false }, on)
    },
    async screenshot(path) {
      const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, on)
      writeFileSync(path, Buffer.from(data, 'base64'))
    },
    async unexpectedProblems() {
      const linksIcon = await evaluate<boolean>(`document.querySelector('link[rel~="icon"]') !== null`)
      return problems.filter((problem) => linksIcon || !`${problem.url ?? ''} ${problem.text}`.includes('/favicon.ico'))
    },
    close,
  }
}

/**
 * Signed-in pages over one launched browser, against the host the sign-in URL
 * names: the first page trades the one-shot token, every later one rides the
 * cookie it minted. Every page carries the tripwire.
 */
function pageOpener(launched: LaunchedBrowser, signInUrl: string): { openPage: () => Promise<UiPage>; closePages: () => Promise<void> } {
  const origin = new URL(signInUrl).origin
  /** Tripwires by CDP session id: one listener for the whole browser, routed per page. */
  const tripwires = new Map<string, UiProblem[]>()
  launched.cdp.onEvent((event) => {
    if (event.sessionId === undefined) return
    const problem = problemOf(event)
    if (problem !== undefined) tripwires.get(event.sessionId)?.push(problem)
  })
  const pages = new Set<UiPage>()
  let signedIn = false

  const openPage = async (): Promise<UiPage> => {
    const cdp = launched.cdp
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const on = { sessionId }
    const problems: UiProblem[] = []
    tripwires.set(sessionId, problems)
    // Armed BEFORE the first navigation: a CSP refusal or a failed load
    // happens while the document is still parsing.
    await cdp.send('Runtime.enable', {}, on)
    await cdp.send('Log.enable', {}, on)
    await cdp.send('Page.enable', {}, on)

    const evaluate = async <T>(expression: string): Promise<T> => {
      const reply = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        on,
      )
      if (reply.exceptionDetails !== undefined) throw new Error(`the page threw evaluating ${expression}: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`)
      return reply.result.value as T
    }

    const navigate = async (url: string): Promise<void> => {
      let stop = (): void => {}
      const loaded = new Promise<void>((resolve) => {
        stop = cdp.onEvent((event) => (event.sessionId === sessionId && event.method === 'Page.loadEventFired' ? resolve() : undefined))
      })
      try {
        const answer = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, on)
        if (answer.errorText) throw new Error(`navigating to ${new URL(url).pathname} failed: ${answer.errorText}`)
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([loaded, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`${new URL(url).pathname} never finished loading`)), 30_000)))])
        clearTimeout(timer)
      } finally {
        stop()
      }
    }

    // The token is spent by the first exchange; every later page rides the
    // cookie it minted. The token URL redirects to a clean `/`.
    await navigate(signedIn ? `${origin}/` : signInUrl)
    signedIn = true
    const at = await evaluate<string>('location.href')
    if (at !== `${origin}/`) throw new Error(`signing in landed on ${at}, not ${origin}/`)

    const page: UiPage = pageFor(cdp, sessionId, problems, async () => {
      if (!pages.delete(page)) return
      tripwires.delete(sessionId)
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
    })
    pages.add(page)
    return page
  }

  const closePages = async (): Promise<void> => {
    // A Set iterates on past an entry deleted under it, which `close` does.
    for (const page of pages) await page.close()
  }

  return { openPage, closePages }
}

/**
 * Boots the host and launches the browser. Call it only where `testBrowser`
 * is defined (`describe.runIf(testBrowser)`); a launch takes seconds, so give
 * the hook a long timeout.
 */
export async function startWebUi(options: { readonly window?: { readonly width: number; readonly height: number } } = {}): Promise<WebUi> {
  if (testBrowser === undefined) throw new Error('startWebUi needs a Chrome, Edge or Chromium (guard the suite with describe.runIf(testBrowser))')
  const root = mkdtempSync(join(tmpdir(), 'minidsh-web-ui-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const adapter = new ScriptedAdapter()
  let host: WebHostHandle | undefined
  let browser: LaunchedBrowser | undefined
  try {
    host = await startWebHost({
      cwd: workspace,
      sessionsRoot: join(root, 'sessions'),
      attachmentsRoot: join(root, 'attachments'),
      logger: silent,
      // A stamp's recorded shape must not depend on whether this machine can confine a shell.
      confinement: 'none',
      agentDefaults: UI_ROUTE,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (composed) => void composed.get(LLM).registerAdapter(composed, adapter),
    })
    browser = await launchBrowser({
      executablePath: testBrowser.path,
      profileRoot: join(root, 'profiles'),
      headless: true,
      allowHosts: [],
      declared: [],
      window: options.window ?? { width: 1280, height: 800 },
    })
  } catch (error) {
    await browser?.close()
    await host?.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    throw error
  }
  const launched = browser
  const served = host
  const origin = new URL(served.url).origin
  const { openPage, closePages } = pageOpener(launched, served.url)
  let closed: Promise<void> | undefined

  return {
    host: served,
    adapter,
    origin,
    workspace,
    browser: launched,
    page: openPage,
    closePages,
    close: () =>
      (closed ??= (async () => {
        await closePages()
        await launched.close()
        await served.dispose()
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      })()),
  }
}

/**
 * A real browser on a web host this process did NOT boot — a `minidsh web`
 * child, a real model behind it — for a live run: the same signed-in pages
 * and tripwire as `startWebUi`, nothing scripted.
 */
export async function browseWebUi(signInUrl: string, options: { readonly window?: { readonly width: number; readonly height: number }; readonly headless?: boolean } = {}): Promise<{ readonly browser: LaunchedBrowser; page(): Promise<UiPage>; close(): Promise<void> }> {
  if (testBrowser === undefined) throw new Error('browseWebUi needs a Chrome, Edge or Chromium')
  const root = mkdtempSync(join(tmpdir(), 'minidsh-web-live-'))
  const browser = await launchBrowser({
    executablePath: testBrowser.path,
    profileRoot: join(root, 'profiles'),
    headless: options.headless ?? true,
    allowHosts: [],
    declared: [],
    window: options.window ?? { width: 1440, height: 900 },
  })
  const { openPage, closePages } = pageOpener(browser, signInUrl)
  return {
    browser,
    page: openPage,
    close: async () => {
      await closePages()
      await browser.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}
