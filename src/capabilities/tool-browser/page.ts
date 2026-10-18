/**
 * One page: the CDP session to its target, what happened on it since the last
 * report, and the waits that let an operation end when the page has.
 *
 * ONE PAGE PER BROWSER. Opening closes every other page target, and from then
 * on every page anything opens (a popup from `window.open`, a `target=_blank`
 * link) is closed unseen and named in `popups`, so the agent never acts on a
 * window it cannot see. A browser therefore carries one `openPage` at a time.
 *
 * ANSWERED AT ONCE, because an unanswered one stalls the page: a paused
 * `file:` request (the fence below), a JavaScript dialog (alert and
 * beforeunload accepted, confirm and prompt per the action's `dialog`,
 * dismissed outside an action), and a file chooser (intercepted, so it never
 * opens; nothing is ever chosen, and the report says so).
 *
 * THE FILE FENCE (§7). A `file:` page can frame or load any local file it
 * names, and no proxy sees a file load, so every `file:` request is paused in
 * the browser (`Fetch.enable`, request stage) and continued only when it
 * names a file inside the workspace (`fileInsideWorkspace`); anything else,
 * an unparseable URL included, is failed `AccessDenied` and named in
 * `blockedFiles`. Measured on Chrome 155: this pauses document, frame and
 * image loads alike, and a refused frame commits `chrome-error://chromewebdata/`
 * with none of the file's content.
 *
 * EVERY WAIT RACES THE CALL'S BUDGET: the signal rejects with its reason, the
 * deadline ends a wait (`BROWSER_TIMEOUT` where the wait was the point, an
 * early return where it was only settling), and every command carries the
 * time left as its timeout. Nothing here waits unbounded.
 */
import { snapshotJson, type JsonValue } from '../../core/json.ts'
import { DESCRIBE, performAction, quadsOf, bounds } from './act.ts'
import type { CdpConnection, CdpEvent } from './cdp.ts'
import { BrowserError } from './errors.ts'
import { FENCE_HEADER, fileInsideWorkspace, isLoopbackHost } from './fence.ts'
import {
  callFunction,
  describeRef,
  exceptionText,
  list,
  numberOf,
  OBJECT_GROUP,
  record,
  RefTable,
  renderSnapshot,
  resolveRef,
  text,
  waitForText,
  type PageSession,
} from './snapshot.ts'
import type { Action, BrowserPage, CallBudget, ConsoleEntry, DialogEntry, DownloadEntry, FailedRequest, PageOptions, PageReport, Screenshot, Viewport } from './types.ts'

/** Each report list keeps the newest this many; the rest are counted in `omitted`. */
const BUFFER_LIMIT = 50
/** One console line or exception, cut: the report is a header, and the page can print megabytes. */
const TEXT_LIMIT = 2_000
const REQUEST_MEMORY = 1_000
/** The settle rule: no request in flight for this long, waiting at most `SETTLE_CAP_MS`. */
const QUIET_MS = 500
const SETTLE_CAP_MS = 5_000
const LOAD_CAP_MS = 30_000
/** After an action: how long a navigation it caused may take to load, and how soon it must have started. */
const ACTION_LOAD_CAP_MS = 10_000
const ACTION_GRACE_MS = 150
/** How many navigations in a row (a redirect by script, then another) one action waits through. */
const ACTION_NAVIGATION_ROUNDS = 3
/** Downloads remembered by id until their outcome is reported. */
const DOWNLOAD_MEMORY = 64
/** How long a navigation that turned out to be a download waits for the browser to name the file. */
const DOWNLOAD_ANNOUNCE_MS = 2_000
/** A loopback server still starting is asked again this often. */
const RETRY_MS = 250
/** Commands outside any call's budget: opening, reporting, closing, answering the page. */
const PLAIN_TIMEOUT_MS = 10_000
/** What a dev server that is not listening yet looks like from the browser. */
const NOT_LISTENING = new Set(['net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_CONNECTION_CLOSED'])

export async function openPage(options: PageOptions): Promise<BrowserPage> {
  const created = await options.cdp.send<{ targetId?: unknown }>('Target.createTarget', { url: 'about:blank' }, { timeoutMs: PLAIN_TIMEOUT_MS })
  const targetId = text(created.targetId)
  if (targetId === undefined) throw new BrowserError('BROWSER_PROTOCOL', 'Target.createTarget answered without a target id')
  let sessionId: string | undefined
  try {
    sessionId = text((await options.cdp.send<{ sessionId?: unknown }>('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: PLAIN_TIMEOUT_MS })).sessionId)
    if (sessionId === undefined) throw new BrowserError('BROWSER_PROTOCOL', 'Target.attachToTarget answered without a session id')
  } catch (error) {
    await options.cdp.send('Target.closeTarget', { targetId }, { timeoutMs: PLAIN_TIMEOUT_MS }).catch(() => undefined)
    throw error
  }
  const page = new Page(options, targetId, sessionId)
  try {
    await page.open()
  } catch (error) {
    await page.close()
    throw error
  }
  return page
}

interface FrameState {
  loaderId: string | undefined
  parentId: string | undefined
}

interface RequestState {
  readonly url: string
  readonly type: string
  readonly loaderId: string
}

interface DownloadState {
  readonly name: string
  outcome: DownloadEntry['outcome']
}

class Page implements BrowserPage, PageSession {
  readonly refs: RefTable
  private readonly cdp: CdpConnection
  private readonly workspaceRoot: string
  private readonly targetId: string
  private readonly sessionId: string
  private size: Viewport
  private ready = false
  private closedReason: string | undefined
  private closing: Promise<void> | undefined
  private crashed = false
  private crashes = 0
  private readonly offEvent: () => void
  private readonly offClose: () => void
  /** Woken after every event, so a wait re-checks its condition when the page changes. */
  private readonly waiters = new Set<() => void>()

  // Documents.
  private mainFrameId = ''
  private mainLoaderId = ''
  private mainUrl = ''
  private readonly frames = new Map<string, FrameState>()
  /** Main-frame documents whose `load` fired. */
  private readonly loaded = new Set<string>()
  /** Main-frame document requests that finished or failed: a navigation that will not commit (a 204, a download) ends its wait. */
  private readonly endedDocuments = new Set<string>()
  private readonly statusByDocument = new Map<string, number>()
  private navigations = 0
  private navigatedSinceReport = false
  /** Bumped by every main-frame document request, so an action can tell whether it started a navigation. */
  private documentRequests = 0
  private latestDocument: string | undefined

  // The network, for the settle rule and the report.
  private readonly requests = new Map<string, RequestState>()
  private readonly inflight = new Set<string>()
  /** The last time a request started or ended, or an action dispatched its input: what the settle's quiet is measured from. */
  private activityAt = 0
  /** Requests whose failure is reported elsewhere: refused by the file fence, or a navigation attempt `navigate` itself reports. */
  private readonly quietFailures = new Set<string>()

  // The report.
  private console: ConsoleEntry[] = []
  private exceptions: string[] = []
  private failedRequests: (FailedRequest & { readonly requestId: string })[] = []
  private dialogs: DialogEntry[] = []
  /** Ids of the downloads the next report names; each one's outcome is in `downloadStates`. */
  private downloads: string[] = []
  /** Every download not yet reported with its final outcome, by the browser's id (its `guid`). */
  private readonly downloadStates = new Map<string, DownloadState>()
  private blockedFiles: string[] = []
  private popups: string[] = []
  private omitted = 0
  private downloadsSeen = 0
  private lastDownload: string | undefined
  /** `Page.windowOpen` events not yet matched by the target they create, so one popup is named once. */
  private windowOpens = 0
  private readonly closedAtOpen = new Set<string>()
  private dialogPolicy: 'accept' | 'dismiss' = 'dismiss'

  constructor(options: PageOptions, targetId: string, sessionId: string) {
    this.cdp = options.cdp
    this.workspaceRoot = options.workspaceRoot
    this.size = options.viewport
    this.targetId = targetId
    this.sessionId = sessionId
    this.refs = new RefTable(options.refs, options.generation)
    this.offEvent = this.cdp.onEvent((event) => this.onEvent(event))
    this.offClose = this.cdp.onClose((reason) => this.lost(`the browser went away: ${reason}`))
  }

  get viewport(): Viewport {
    return this.size
  }

  get gone(): boolean {
    return this.closedReason !== undefined
  }

  async open(): Promise<void> {
    const browser = { timeoutMs: PLAIN_TIMEOUT_MS }
    const session = { timeoutMs: PLAIN_TIMEOUT_MS, sessionId: this.sessionId }
    // The launch leaves its own about:blank; this page is the one the agent sees.
    const targets = await this.cdp.send<{ targetInfos?: unknown }>('Target.getTargets', {}, browser)
    for (const info of list(targets.targetInfos)) {
      const target = record(info)
      const id = text(target?.targetId)
      if (target?.type !== 'page' || id === undefined || id === this.targetId) continue
      this.closedAtOpen.add(id)
      await this.cdp.send('Target.closeTarget', { targetId: id }, browser).catch(() => undefined)
    }
    await this.cdp.send('Target.setDiscoverTargets', { discover: true }, browser)
    // The fence before anything can load.
    await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'file://*', requestStage: 'Request' }] }, session)
    await this.cdp.send('Page.enable', {}, session)
    await this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, session)
    await this.cdp.send('Runtime.enable', {}, session)
    await this.cdp.send('Network.enable', {}, session)
    await this.cdp.send('Log.enable', {}, session)
    // Where it exists it reports a renderer crash on the session; `Target.targetCrashed` covers the rest.
    await this.cdp.send('Inspector.enable', {}, session).catch(() => undefined)
    await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, session)
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: this.size.width, height: this.size.height, deviceScaleFactor: 1, mobile: false }, session)
    const tree = await this.cdp.send<{ frameTree?: unknown }>('Page.getFrameTree', {}, session)
    const frame = record(record(tree.frameTree)?.frame)
    this.mainFrameId = text(frame?.id) ?? ''
    this.mainLoaderId = text(frame?.loaderId) ?? ''
    this.mainUrl = text(frame?.url) ?? 'about:blank'
    this.frames.set(this.mainFrameId, { loaderId: this.mainLoaderId, parentId: undefined })
    this.ready = true
  }

  // -------------------------------------------------------------------------
  // BrowserPage

  async navigate(url: string, options: CallBudget & { readonly waitMs: number }): Promise<{ readonly loaded: boolean }> {
    // The one operation a crashed page takes: it starts the renderer again.
    if (this.closedReason !== undefined) throw this.closedError()
    const started = Date.now()
    const retryUntil = Math.min(started + options.waitMs, options.deadline)
    let host: string | undefined
    try {
      host = new URL(url).hostname
    } catch {
      host = undefined
    }
    let loaderId: string | undefined
    for (let attempt = 1; ; attempt++) {
      const downloadsBefore = this.downloadsSeen
      const answer = await this.send<{ loaderId?: unknown; errorText?: unknown; isDownload?: unknown }>('Page.navigate', { url }, options)
      loaderId = text(answer.loaderId)
      const errorText = text(answer.errorText)
      if (errorText === undefined || errorText === '') break
      if (answer.isDownload === true) {
        // Measured: a download answers net::ERR_ABORTED BEFORE the browser
        // announces the download, and its `canceled` follows the announcement
        // by milliseconds, so the wait lets the report (and this refusal) name
        // the file and say how it ended.
        const latest = (): DownloadState | undefined => (this.downloadsSeen === downloadsBefore || this.lastDownload === undefined ? undefined : this.downloadStates.get(this.lastDownload))
        await this.waitUntil(() => (latest()?.outcome ?? 'started') !== 'started', Math.min(Date.now() + DOWNLOAD_ANNOUNCE_MS, options.deadline), options)
        const download = latest()
        if (download?.outcome === 'saved') throw new BrowserError('BROWSER_NAVIGATION_FAILED', `${url} is a download (${download.name}), which the browser saved although it should have refused it`)
        throw new BrowserError('BROWSER_NAVIGATION_FAILED', `${url} is a download${download === undefined ? '' : ` (${download.name})`}, and this browser refuses downloads`)
      }
      // The failure is this call's answer; the report need not say it again.
      if (loaderId !== undefined) this.quiet(loaderId)
      if (NOT_LISTENING.has(errorText) && host !== undefined && isLoopbackHost(host) && Date.now() + RETRY_MS < retryUntil) {
        await this.sleep(RETRY_MS, options)
        continue
      }
      const waited = attempt > 1 ? `, still after ${Date.now() - started} ms of retrying` : ''
      throw new BrowserError('BROWSER_NAVIGATION_FAILED', `${url} did not load: ${errorText}${waited}`)
    }
    let loaded = true
    if (loaderId !== undefined) {
      const document = loaderId
      const crashes = this.crashes
      loaded = await this.waitUntil(() => this.documentDone(document, crashes), Math.min(Date.now() + LOAD_CAP_MS, options.deadline), options)
      loaded &&= this.loaded.has(document)
    }
    await this.settle(options)
    return { loaded }
  }

  async snapshot(options: CallBudget & { readonly ref?: string; readonly waitForText?: string; readonly waitUntil?: number }): Promise<string> {
    this.usable()
    try {
      // The wait ends at `waitUntil`; the read it found the text in is rendered under the whole budget.
      const until = Math.min(options.waitUntil ?? options.deadline, options.deadline)
      const read = options.waitForText === undefined ? undefined : await waitForText(this, options.waitForText, until, options)
      return await renderSnapshot(this, options, options.ref, read)
    } finally {
      this.release()
    }
  }

  async act(action: Action, options: CallBudget & { readonly dialog: 'accept' | 'dismiss' }): Promise<string> {
    this.usable()
    const navigations = this.navigations
    const documentRequests = this.documentRequests
    this.dialogPolicy = options.dialog
    try {
      const done = await performAction(this, action, options)
      await this.afterAction(documentRequests, options)
      return this.navigations === navigations ? done : `${done} — the page navigated to ${this.mainUrl}`
    } finally {
      this.dialogPolicy = 'dismiss'
      this.release()
    }
  }

  async screenshot(options: CallBudget & { readonly fullPage: boolean; readonly ref?: string; readonly maxDimension: number; readonly maxBytes: number }): Promise<Screenshot> {
    this.usable()
    try {
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
      let clipped: string | undefined
      if (options.ref !== undefined) {
        const { entry } = await resolveRef(this, options.ref, options)
        const hidden = new BrowserError('BROWSER_NOT_ACTIONABLE', `${describeRef(entry)} is not visible, so there is nothing to capture`)
        try {
          await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, options)
        } catch (error) {
          if (error instanceof BrowserError && error.code === 'BROWSER_PROTOCOL') throw hidden
          throw error
        }
        const quads = await quadsOf(this, entry.backendNodeId, options)
        if (quads.length === 0) throw hidden
        const boxes = quads.map(bounds)
        const left = Math.min(...boxes.map((box) => box.left))
        const top = Math.min(...boxes.map((box) => box.top))
        const width = Math.max(...boxes.map((box) => box.right)) - left
        const height = Math.max(...boxes.map((box) => box.bottom)) - top
        // Quads are viewport coordinates; a clip beyond the viewport is page
        // coordinates — measured: without the scroll offset added, the clip
        // captures whatever sits that far down the page instead.
        const { pageX, pageY } = await this.scrollOffset(options)
        clip = { x: left + pageX, y: top + pageY, width: Math.min(width, options.maxDimension), height: Math.min(height, options.maxDimension), scale: 1 }
        if (width > options.maxDimension || height > options.maxDimension) {
          clipped = `the element is ${Math.ceil(width)}×${Math.ceil(height)} CSS pixels; the image shows its top-left ${Math.ceil(clip.width)}×${Math.ceil(clip.height)}`
        }
      } else if (options.fullPage) {
        const metrics = await this.send<{ cssContentSize?: unknown }>('Page.getLayoutMetrics', {}, options)
        const content = record(metrics.cssContentSize)
        const width = Math.ceil(numberOf(content?.width) ?? this.size.width)
        const height = Math.ceil(numberOf(content?.height) ?? this.size.height)
        clip = { x: 0, y: 0, width: Math.min(width, options.maxDimension), height: Math.min(height, options.maxDimension), scale: 1 }
        if (width > options.maxDimension || height > options.maxDimension) {
          clipped = `the page is ${width}×${height} CSS pixels; the image shows its top-left ${clip.width}×${clip.height}`
        }
      }
      const area = clip === undefined ? {} : { clip, captureBeyondViewport: true }
      let mediaType: Screenshot['mediaType'] = 'image/png'
      let data = await this.capture({ format: 'png', ...area }, options)
      if (data.byteLength > options.maxBytes) {
        mediaType = 'image/jpeg'
        data = await this.capture({ format: 'jpeg', quality: 80, ...area }, options)
      }
      return { data, mediaType, ...(clipped === undefined ? {} : { clipped }) }
    } finally {
      this.release()
    }
  }

  /**
   * In two steps, because a by-value answer cannot say what it was: measured,
   * `returnByValue` answers a DOM node, a Map, a Date and a function all as
   * `{type: 'object' | 'function', value: {}}` with no subtype — the same as
   * an empty object — and a Symbol as a protocol error. So the expression's
   * result comes back as a remote object first, whose type, subtype and class
   * say whether JSON can carry it; only a plain object or an array is then
   * fetched by value.
   */
  async evaluate(expression: string, options: CallBudget): Promise<{ readonly value?: JsonValue; readonly exception?: string; readonly unreturnable?: string }> {
    this.usable()
    try {
      // V8 terminates a script still running at `timeout`: measured, a
      // `while (true) {}` ends with a protocol error at that moment and the page
      // answers again — without it a runaway expression would wedge the
      // renderer for every later call. It fires just before the deadline, so the
      // termination, not the transport's timer, is what ends a busy expression.
      const terminateAfter = Math.max(1, options.deadline - Date.now() - 100)
      const terminatesAt = Date.now() + terminateAfter
      let answer: { result?: unknown; exceptionDetails?: unknown }
      try {
        answer = await this.send('Runtime.evaluate', { expression, objectGroup: OBJECT_GROUP, awaitPromise: true, userGesture: true, timeout: terminateAfter }, options)
      } catch (error) {
        if (!(error instanceof BrowserError)) throw error
        // A promise still pending and a page that never ran the expression look
        // alike from here; the mark lets the next call tell them apart.
        if (error.code === 'BROWSER_TIMEOUT') throw new BrowserError('BROWSER_TIMEOUT', "the expression had not settled by the call's deadline", { unanswered: error.unanswered })
        if (error.code !== 'BROWSER_PROTOCOL') throw error
        if (Date.now() >= terminatesAt) throw new BrowserError('BROWSER_TIMEOUT', "the expression was still running at the call's deadline and was stopped")
        // "Cannot find context" (the page was between documents), an answer past the size cap: it ran, or not, but no value came back.
        return { unreturnable: `no value came back: ${protocolReason(error)}` }
      }
      const details = record(answer.exceptionDetails)
      if (details !== undefined) return { exception: clamp(exceptionText(details)) }
      const result = record(answer.result)
      if (result === undefined || result.type === 'undefined') return {}
      const unserializable = text(result.unserializableValue)
      if (unserializable !== undefined) return { value: unserializable }
      const objectId = text(result.objectId)
      // Primitives and null arrive inline, with no object behind them.
      if (objectId === undefined) return isJson(result.value) ? { value: snapshotJson(result.value) } : {}
      const what = await this.unreturnable(result, objectId, options)
      if (what !== undefined) return { unreturnable: what }
      let byValue: { result?: unknown }
      try {
        byValue = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return this }', returnByValue: true }, options)
      } catch (error) {
        if (!(error instanceof BrowserError) || error.code !== 'BROWSER_PROTOCOL') throw error
        // "Object reference chain is too long" (`window`), an answer past the size cap.
        return { unreturnable: `${described(result)}, which the browser could not return as JSON: ${protocolReason(error)}` }
      }
      // A by-value result arrived as JSON, so this holds by construction; the check keeps the type honest.
      const value = record(byValue.result)?.value
      return isJson(value) ? { value: snapshotJson(value) } : { unreturnable: described(result) }
    } finally {
      this.release()
    }
  }

  async setViewport(viewport: Viewport): Promise<void> {
    this.usable()
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false },
      { sessionId: this.sessionId, timeoutMs: PLAIN_TIMEOUT_MS },
    )
    this.size = viewport
  }

  async report(): Promise<PageReport> {
    // A crashed page still reports: `crashed` is how the caller learns of it.
    if (this.closedReason !== undefined) throw this.closedError()
    const answer = await this.cdp.send<{ targetInfo?: unknown }>('Target.getTargetInfo', { targetId: this.targetId }, { timeoutMs: PLAIN_TIMEOUT_MS })
    const info = record(answer.targetInfo)
    const status = this.statusByDocument.get(this.mainLoaderId)
    const report: PageReport = {
      url: text(info?.url) ?? this.mainUrl,
      title: text(info?.title) ?? '',
      ...(status === undefined ? {} : { status }),
      console: this.console,
      exceptions: this.exceptions,
      failedRequests: this.failedRequests.map(({ url, reason, fenced }) => ({ url, reason, fenced })),
      dialogs: this.dialogs,
      downloads: this.drainDownloads(),
      blockedFiles: this.blockedFiles,
      popups: this.popups,
      omitted: this.omitted,
      navigated: this.navigatedSinceReport,
      crashed: this.crashed,
    }
    this.console = []
    this.exceptions = []
    this.failedRequests = []
    this.dialogs = []
    this.blockedFiles = []
    this.popups = []
    this.omitted = 0
    this.windowOpens = 0
    this.navigatedSinceReport = false
    return report
  }

  async responsive(timeoutMs: number): Promise<boolean> {
    if (this.closedReason !== undefined) return false
    try {
      // The renderer's main thread answers this only when it is free: a page
      // script stuck in a loop, or a renderer its host is still tearing down,
      // leaves it unanswered.
      await this.cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, { sessionId: this.sessionId, timeoutMs })
      return true
    } catch {
      return false
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closedReason ??= 'the page was closed'
      this.offEvent()
      this.offClose()
      this.wake()
      await this.cdp.send('Target.closeTarget', { targetId: this.targetId }, { timeoutMs: PLAIN_TIMEOUT_MS }).catch(() => undefined)
    })()
    return this.closing
  }

  // -------------------------------------------------------------------------
  // PageSession

  async send<T>(method: string, params: Record<string, unknown>, budget: CallBudget): Promise<T> {
    if (this.closedReason !== undefined) throw this.closedError()
    if (budget.signal.aborted) throw budget.signal.reason
    const remaining = budget.deadline - Date.now()
    if (remaining <= 0) throw new BrowserError('BROWSER_TIMEOUT', `the call's deadline passed before ${method} could be sent`)
    try {
      return await this.cdp.send<T>(method, params, { sessionId: this.sessionId, timeoutMs: remaining, signal: budget.signal })
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'BROWSER_TIMEOUT') {
        throw new BrowserError('BROWSER_TIMEOUT', `the call's deadline passed while the page was answering ${method}`, { unanswered: true })
      }
      throw error
    }
  }

  async sleep(ms: number, budget: CallBudget): Promise<void> {
    await this.waitUntil(() => false, Math.min(Date.now() + ms, budget.deadline), budget)
  }

  documentOf(frameId: string): string | undefined {
    return this.frames.get(frameId)?.loaderId
  }

  parentOf(frameId: string): string | undefined {
    return this.frames.get(frameId)?.parentId
  }

  frameSeen(frameId: string, loaderId: string, parentId: string | undefined): void {
    const known = this.frames.get(frameId)
    if (known?.loaderId === loaderId && known.parentId === parentId) return
    this.frames.set(frameId, { loaderId, parentId })
    this.refs.documentChanged(frameId, loaderId)
  }

  // -------------------------------------------------------------------------
  // Waiting

  /**
   * Resolves true once `test` holds, false at `until`; rejects with the
   * signal's reason on cancel and `BROWSER_CLOSED` if the page goes. `test` is
   * re-read after every event, so nothing here polls.
   */
  private waitUntil(test: () => boolean, until: number, budget: CallBudget): Promise<boolean> {
    if (this.closedReason !== undefined) return Promise.reject(this.closedError())
    if (budget.signal.aborted) return Promise.reject(budget.signal.reason)
    if (test()) return Promise.resolve(true)
    return new Promise<boolean>((resolve, reject) => {
      const finish = (settle: () => void): void => {
        clearTimeout(timer)
        budget.signal.removeEventListener('abort', onAbort)
        this.waiters.delete(check)
        settle()
      }
      const check = (): void => {
        if (this.closedReason !== undefined) finish(() => reject(this.closedError()))
        else if (test()) finish(() => resolve(true))
      }
      const onAbort = (): void => finish(() => reject(budget.signal.reason))
      const timer = setTimeout(() => finish(() => resolve(false)), Math.max(0, until - Date.now()))
      budget.signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.add(check)
    })
  }

  private wake(): void {
    for (const check of Array.from(this.waiters)) check()
  }

  /** No request in flight and nothing started or ended (`activityAt`) for `QUIET_MS`, waiting at most `SETTLE_CAP_MS` and never past the deadline. Ending early is not an error. */
  private async settle(budget: CallBudget): Promise<void> {
    const until = Math.min(Date.now() + SETTLE_CAP_MS, budget.deadline)
    for (;;) {
      const now = Date.now()
      if (now >= until) return
      const quietFor = now - this.activityAt
      if (this.inflight.size === 0 && quietFor >= QUIET_MS) return
      await this.sleep(Math.min(this.inflight.size === 0 ? QUIET_MS - quietFor : 100, until - now), budget)
    }
  }

  /**
   * After an action: a moment for what it started, then — if it started a
   * main-frame navigation — that navigation's load, then the settle. A
   * navigation that ends without a document (a 204, a download) ends the wait.
   *
   * The quiet is counted from the action's input, not from the page's last
   * request: a handler that renders after a 300 ms timer, or fetches after a
   * 250 ms debounce, has acted by the time 500 ms of quiet have passed, while
   * a page whose last request ended long ago would let the settle end at once,
   * before any of it. A navigation the page starts during the settle (a
   * `location.href` set on a timer) is waited for and settled after in turn,
   * up to `ACTION_NAVIGATION_ROUNDS` of them, so the account can say where the
   * page went.
   */
  private async afterAction(documentRequestsBefore: number, budget: CallBudget): Promise<void> {
    this.activityAt = Date.now()
    await this.sleep(ACTION_GRACE_MS, budget)
    let seen = documentRequestsBefore
    for (let round = 1; ; round++) {
      const document = this.latestDocument
      if (this.documentRequests !== seen && document !== undefined) {
        seen = this.documentRequests
        const crashes = this.crashes
        await this.waitUntil(() => this.documentDone(document, crashes), Math.min(Date.now() + ACTION_LOAD_CAP_MS, budget.deadline), budget)
      }
      await this.settle(budget)
      if (this.documentRequests === seen || round === ACTION_NAVIGATION_ROUNDS || Date.now() >= budget.deadline) return
    }
  }

  /**
   * A main-frame navigation is over: its document loaded, the renderer
   * crashed since the wait began (a crash before it is what a navigate
   * recovers from), or its request ended without committing (a 204, a download).
   */
  private documentDone(loaderId: string, crashesBefore: number): boolean {
    return this.loaded.has(loaderId) || this.crashes !== crashesBefore || (this.endedDocuments.has(loaderId) && this.mainLoaderId !== loaderId)
  }

  // -------------------------------------------------------------------------
  // Events

  private onEvent(event: CdpEvent): void {
    if (event.sessionId === undefined) this.onBrowserEvent(event)
    else if (event.sessionId === this.sessionId) this.onPageEvent(event.method, event.params)
    else return
    this.wake()
  }

  private onBrowserEvent(event: CdpEvent): void {
    const params = event.params
    switch (event.method) {
      case 'Target.targetCreated': {
        const info = record(params.targetInfo)
        const id = text(info?.targetId)
        if (info?.type !== 'page' || id === undefined || id === this.targetId) return
        void this.cdp.send('Target.closeTarget', { targetId: id }, { timeoutMs: PLAIN_TIMEOUT_MS }).catch(() => undefined)
        if (!this.ready || this.closedAtOpen.has(id)) return
        // `Page.windowOpen` named it already, with the URL it was opened at
        // (measured: the new target's own URL is still empty here).
        if (this.windowOpens > 0) this.windowOpens--
        else this.push(this.popups, text(info.url) || 'a new window (no address yet)')
        return
      }
      case 'Target.targetCrashed':
        if (params.targetId === this.targetId) this.onCrash()
        return
      case 'Target.targetDestroyed':
        if (params.targetId === this.targetId) this.lost('the page was closed')
        return
      case 'Target.detachedFromTarget':
        if (params.sessionId === this.sessionId) this.lost('the page was detached from its browser')
        return
      case 'Browser.downloadWillBegin': {
        // Browser-wide (no session): ours when it starts in one of our frames.
        const frameId = text(params.frameId)
        const guid = text(params.guid)
        if (frameId === undefined || guid === undefined || !this.frames.has(frameId)) return
        this.downloadsSeen++
        this.lastDownload = guid
        this.downloadStates.set(guid, { name: text(params.suggestedFilename) || text(params.url) || 'a download', outcome: 'started' })
        if (this.downloadStates.size > DOWNLOAD_MEMORY) this.downloadStates.delete(this.downloadStates.keys().next().value!)
        this.push(this.downloads, guid)
        return
      }
      case 'Browser.downloadProgress': {
        // The outcome is the browser's word, not this page's assumption: measured,
        // the launch's deny answers `inProgress` then `canceled` within
        // milliseconds of `downloadWillBegin`; `completed` would mean the deny did not hold.
        const state = params.state === 'canceled' ? 'refused' : params.state === 'completed' ? 'saved' : undefined
        const guid = text(params.guid)
        const download = guid === undefined ? undefined : this.downloadStates.get(guid)
        if (state === undefined || guid === undefined || download === undefined) return
        download.outcome = state
        // Already reported as `started`: the next report says how it ended.
        if (!this.downloads.includes(guid)) this.push(this.downloads, guid)
        return
      }
    }
  }

  private onPageEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Fetch.requestPaused':
        return this.onFileRequest(params)
      case 'Page.javascriptDialogOpening':
        return this.onDialog(params)
      case 'Page.fileChooserOpened':
        return this.push(this.console, { level: 'warning', text: 'a file chooser opened and was left unanswered: this browser cannot choose files to upload' })
      case 'Page.windowOpen':
        this.windowOpens++
        return this.push(this.popups, text(params.url) || 'a new window')
      case 'Page.frameAttached': {
        const frameId = text(params.frameId)
        if (frameId !== undefined && !this.frames.has(frameId)) this.frames.set(frameId, { loaderId: undefined, parentId: text(params.parentFrameId) })
        return
      }
      case 'Page.frameNavigated':
        return this.onFrameNavigated(record(params.frame))
      case 'Page.navigatedWithinDocument':
        if (params.frameId === this.mainFrameId) {
          this.mainUrl = text(params.url) ?? this.mainUrl
          this.navigations++
          this.navigatedSinceReport = true
        }
        return
      case 'Page.frameDetached': {
        const frameId = text(params.frameId)
        if (frameId === undefined) return
        this.frames.delete(frameId)
        this.refs.frameGone(frameId)
        return
      }
      case 'Page.lifecycleEvent':
        if (params.name === 'load' && params.frameId === this.mainFrameId) remember(this.loaded, text(params.loaderId), 32)
        return
      case 'Page.frameStartedNavigating': {
        const kind = text(params.navigationType)
        if (params.frameId === this.mainFrameId && kind !== 'sameDocument' && kind !== 'historySameDocument') this.documentStarted(text(params.loaderId))
        return
      }
      case 'Network.requestWillBeSent':
        return this.onRequest(params)
      case 'Network.responseReceived':
        return this.onResponse(params)
      case 'Network.loadingFinished':
        return this.onRequestEnd(text(params.requestId), undefined)
      case 'Network.loadingFailed':
        return this.onRequestEnd(text(params.requestId), text(params.errorText) ?? 'failed')
      case 'Runtime.consoleAPICalled':
        return this.onConsole(params)
      case 'Runtime.exceptionThrown': {
        const details = record(params.exceptionDetails)
        if (details === undefined) return
        const where = whereOf(record(details.stackTrace), text(details.url), numberOf(details.lineNumber))
        return this.push(this.exceptions, clamp(where === undefined ? exceptionText(details) : `${exceptionText(details)} (at ${where})`))
      }
      case 'Log.entryAdded': {
        // The browser's own messages (CSP, interventions, deprecations); the
        // network's and the console's arrive through their own events.
        const entry = record(params.entry)
        const level = entry?.level
        if ((level !== 'error' && level !== 'warning') || entry?.source === 'network' || entry?.source === 'console-api') return
        const where = whereOf(record(entry?.stackTrace), text(entry?.url), numberOf(entry?.lineNumber))
        return this.push(this.console, { level, text: clamp(text(entry?.text) ?? ''), ...(where === undefined ? {} : { where }) })
      }
      case 'Inspector.targetCrashed':
        return this.onCrash()
    }
  }

  /** The file fence. Answered exactly once, whatever the URL: an unanswered pause hangs the load. */
  private onFileRequest(params: Record<string, unknown>): void {
    const requestId = text(params.requestId)
    if (requestId === undefined) return
    const url = text(record(params.request)?.url) ?? ''
    let inside = false
    try {
      inside = fileInsideWorkspace(new URL(url), this.workspaceRoot)
    } catch {
      inside = false
    }
    const session = { sessionId: this.sessionId, timeoutMs: PLAIN_TIMEOUT_MS }
    if (inside) {
      void this.cdp.send('Fetch.continueRequest', { requestId }, session).catch(() => undefined)
      return
    }
    void this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }, session).catch(() => undefined)
    this.push(this.blockedFiles, url)
    // Its `loadingFailed` (ERR_ACCESS_DENIED) would only repeat `blockedFiles`.
    const networkId = text(params.networkId)
    if (networkId !== undefined) this.quiet(networkId)
  }

  private onDialog(params: Record<string, unknown>): void {
    const kind = params.type
    const type: DialogEntry['type'] = kind === 'confirm' || kind === 'prompt' || kind === 'beforeunload' ? kind : 'alert'
    // An alert has only OK, and a beforeunload refused would trap every later navigation.
    const accept = type === 'alert' || type === 'beforeunload' || this.dialogPolicy === 'accept'
    void this.cdp
      .send('Page.handleJavaScriptDialog', { accept, ...(accept && type === 'prompt' ? { promptText: text(params.defaultPrompt) ?? '' } : {}) }, { sessionId: this.sessionId, timeoutMs: PLAIN_TIMEOUT_MS })
      .catch(() => undefined)
    this.push(this.dialogs, { type, message: clamp(text(params.message) ?? ''), answer: accept ? 'accepted' : 'dismissed' })
  }

  private onFrameNavigated(frame: Record<string, unknown> | undefined): void {
    const frameId = text(frame?.id)
    const loaderId = text(frame?.loaderId)
    if (frameId === undefined || loaderId === undefined) return
    const parentId = text(frame?.parentId)
    this.frames.set(frameId, { loaderId, parentId })
    this.refs.documentChanged(frameId, loaderId)
    if (parentId !== undefined) return
    this.mainFrameId = frameId
    this.mainLoaderId = loaderId
    // An error page commits as chrome-error://; the address it could not reach is the one to name.
    this.mainUrl = text(frame?.unreachableUrl) ?? `${text(frame?.url) ?? ''}${text(frame?.urlFragment) ?? ''}`
    this.crashed = false
    this.navigations++
    this.navigatedSinceReport = true
    // The replaced document's requests will never be waited for.
    for (const requestId of Array.from(this.inflight)) if (this.requests.get(requestId)?.loaderId !== loaderId) this.inflight.delete(requestId)
  }

  private documentStarted(loaderId: string | undefined): void {
    if (loaderId === undefined) return
    this.documentRequests++
    this.latestDocument = loaderId
  }

  private onRequest(params: Record<string, unknown>): void {
    const requestId = text(params.requestId)
    if (requestId === undefined) return
    const url = text(record(params.request)?.url) ?? ''
    const type = text(params.type) ?? 'Other'
    const loaderId = text(params.loaderId) ?? ''
    this.requests.set(requestId, { url, type, loaderId })
    if (this.requests.size > REQUEST_MEMORY) {
      const oldest = this.requests.keys().next().value
      if (oldest !== undefined) this.requests.delete(oldest)
    }
    if (type === 'Document' && params.frameId === this.mainFrameId) this.documentStarted(loaderId)
    // Long-lived by design, so they never end a settle; a data: URL never touches the network.
    if (type === 'WebSocket' || type === 'EventSource' || url.startsWith('data:')) return
    this.inflight.add(requestId)
    this.activityAt = Date.now()
  }

  private onResponse(params: Record<string, unknown>): void {
    // A frame's document is as far as this page waits for it: measured, a
    // cross-site iframe's request and response reach this session but its
    // `loadingFinished` goes to the frame's own process, which this page never
    // attaches to — so it would hold every settle to the cap (5 s per call).
    const requestId = text(params.requestId)
    if (params.type === 'Document' && params.frameId !== this.mainFrameId && requestId !== undefined && this.inflight.delete(requestId)) this.activityAt = Date.now()
    const response = record(params.response)
    const status = numberOf(response?.status)
    const url = text(response?.url) ?? ''
    if (status === undefined) return
    const loaderId = text(params.loaderId)
    if (params.type === 'Document' && params.frameId === this.mainFrameId && loaderId !== undefined && /^https?:/.test(url)) {
      this.statusByDocument.set(loaderId, status)
      if (this.statusByDocument.size > 32) this.statusByDocument.delete(this.statusByDocument.keys().next().value!)
    }
    if (status < 400) return
    this.push(this.failedRequests, { requestId: requestId ?? '', url, reason: String(status), fenced: header(record(response?.headers), FENCE_HEADER) === 'denied' })
  }

  private onRequestEnd(requestId: string | undefined, errorText: string | undefined): void {
    if (requestId === undefined) return
    this.inflight.delete(requestId)
    this.activityAt = Date.now()
    const request = this.requests.get(requestId)
    if (request?.type === 'Document') remember(this.endedDocuments, requestId, 64)
    // A request the page itself abandoned (a navigation away, an aborted fetch) did not fail.
    if (errorText === undefined || errorText === 'net::ERR_ABORTED' || this.quietFailures.has(requestId)) return
    this.push(this.failedRequests, { requestId, url: request?.url ?? '', reason: errorText, fenced: errorText === 'net::ERR_TUNNEL_CONNECTION_FAILED' })
  }

  private onConsole(params: Record<string, unknown>): void {
    const type = params.type
    const level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : undefined
    if (level === undefined) return
    const words = list(params.args).map(argumentText)
    const line = type === 'assert' ? ['Assertion failed:', ...words].join(' ') : words.join(' ')
    const where = whereOf(record(params.stackTrace), undefined, undefined)
    this.push(this.console, { level, text: clamp(line), ...(where === undefined ? {} : { where }) })
  }

  private onCrash(): void {
    this.crashed = true
    this.crashes++
    this.refs.clear()
    this.inflight.clear()
  }

  /** The page is gone for good: every wait ends and every later call is refused. */
  private lost(reason: string): void {
    this.closedReason ??= reason
    this.wake()
  }

  // -------------------------------------------------------------------------
  // Helpers

  private usable(): void {
    if (this.closedReason !== undefined) throw this.closedError()
    if (this.crashed) throw new BrowserError('BROWSER_CLOSED', 'the page crashed; navigate to load it again')
  }

  private closedError(): BrowserError {
    return new BrowserError('BROWSER_CLOSED', `the page is gone (${this.closedReason ?? 'closed'})`)
  }

  /** Remote objects the snapshot and the actions created live until released; each operation releases its own. */
  private release(): void {
    if (this.closedReason !== undefined) return
    void this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }, { sessionId: this.sessionId, timeoutMs: PLAIN_TIMEOUT_MS }).catch(() => undefined)
  }

  /** Remove a navigation attempt's or a fenced request's failure from the report, whether it arrived yet or not. */
  private quiet(requestId: string): void {
    remember(this.quietFailures, requestId, 256)
    this.failedRequests = this.failedRequests.filter((failure) => failure.requestId !== requestId)
  }

  private push<T>(buffer: T[], item: T): void {
    buffer.push(item)
    if (buffer.length > BUFFER_LIMIT) {
      buffer.shift()
      this.omitted++
    }
  }

  private async capture(params: Record<string, unknown>, budget: CallBudget): Promise<Uint8Array> {
    const answer = await this.send<{ data?: unknown }>('Page.captureScreenshot', params, budget)
    const data = text(answer.data)
    if (data === undefined) throw new BrowserError('BROWSER_PROTOCOL', 'Page.captureScreenshot answered without an image')
    // A copy: `Buffer.from` may hand back a slice of a shared pool.
    return new Uint8Array(Buffer.from(data, 'base64'))
  }

  /** What an evaluated object that JSON cannot carry was; `undefined` for a plain object or an array, which it can. */
  private async unreturnable(result: Record<string, unknown>, objectId: string, budget: CallBudget): Promise<string | undefined> {
    const subtype = text(result.subtype)
    if (result.type === 'object' && (subtype === undefined || subtype === 'array')) return undefined
    const description = text(result.description) ?? ''
    // An element as the cover refusal names one; any other node by its name (#text, #document).
    if (subtype !== 'node' || description.startsWith('#')) return described(result)
    try {
      const element = await callFunction(this, objectId, DESCRIBE, [], budget)
      return typeof element === 'string' ? `a DOM node: ${element}` : described(result)
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'BROWSER_PROTOCOL') return described(result)
      throw error
    }
  }

  /** The report's downloads, each with its outcome now; one still running is kept, and named again once it ends. */
  private drainDownloads(): DownloadEntry[] {
    const entries: DownloadEntry[] = []
    for (const guid of this.downloads) {
      const state = this.downloadStates.get(guid)
      if (state === undefined) continue
      entries.push({ name: state.name, outcome: state.outcome })
      if (state.outcome !== 'started') this.downloadStates.delete(guid)
    }
    this.downloads = []
    return entries
  }

  private async scrollOffset(budget: CallBudget): Promise<{ readonly pageX: number; readonly pageY: number }> {
    const metrics = await this.send<{ cssVisualViewport?: unknown }>('Page.getLayoutMetrics', {}, budget)
    const visual = record(metrics.cssVisualViewport)
    return { pageX: numberOf(visual?.pageX) ?? 0, pageY: numberOf(visual?.pageY) ?? 0 }
  }
}

function remember(set: Set<string>, value: string | undefined, limit: number): void {
  if (value === undefined) return
  set.add(value)
  if (set.size > limit) set.delete(set.values().next().value!)
}

function clamp(value: string): string {
  return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value
}

/** A remote object as an article, its kind and its first line: `a function: () => 1`, `a Map: Map(1)`, `a Symbol: Symbol(s)`, `an Error: Error: no`. */
function described(result: Record<string, unknown>): string {
  const kind = result.type === 'function' ? 'function' : result.type === 'symbol' ? 'Symbol' : result.subtype === 'node' ? 'DOM node' : (text(result.className) ?? text(result.subtype) ?? String(result.type))
  const line = (text(result.description) ?? '').split('\n')[0]!.trim()
  const shown = line.length > 120 ? `${line.slice(0, 120)}…` : line
  return `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind}${shown === '' || shown === kind ? '' : `: ${shown}`}`
}

/** A protocol error's reason without the method it answered (`Runtime.evaluate: …`). */
function protocolReason(error: BrowserError): string {
  return error.message.replace(/^[A-Za-z]+\.[A-Za-z]+: /, '')
}

/** `url:line` (1-based) from the first stack frame, else from the fallback location; nothing for code with no URL (an `evaluate`). */
function whereOf(stackTrace: Record<string, unknown> | undefined, url: string | undefined, lineNumber: number | undefined): string | undefined {
  const frame = record(list(stackTrace?.callFrames)[0])
  const at = text(frame?.url) || url
  const line = numberOf(frame?.lineNumber) ?? lineNumber
  if (at === undefined || at === '') return undefined
  return line === undefined ? at : `${at}:${line + 1}`
}

/** One console argument as the console would print it. */
function argumentText(raw: unknown): string {
  const argument = record(raw)
  if (argument === undefined) return ''
  if ('value' in argument) return typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value)
  return text(argument.unserializableValue) ?? text(argument.description) ?? text(argument.type) ?? ''
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return text(value)
  return undefined
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  const object = record(value)
  return object !== undefined && Object.values(object).every(isJson)
}
