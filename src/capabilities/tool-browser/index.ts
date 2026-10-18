/**
 * `tool-browser`: a real browser the agent drives to check what a change looks
 * like and does — the build → launch → inspect → interact → verify → iterate
 * loop on a frontend, where code-level success is not evidence.
 *
 * Provider and consumer in one capability (ARCHITECTURE §11: no `core/browser`
 * Definition before a second provider). It owns:
 *
 *   - **one browser per AGENT**, launched on the first browser call and owned
 *     by the agent's scope (the `shell-stdio` precedent): a resume, a fork and
 *     a delegated child each get their own, and nothing is restored from the
 *     log. Calls are serialized per agent and each carries its own deadline
 *     (the tools opt out of the pipeline's), so no abandoned body can drive the
 *     page under the next call;
 *   - **what the model is told**: every result opens with what happened on the
 *     page since the previous one (console errors, failed and fenced requests,
 *     dialogs, refused downloads and files), because a verifier that only sees
 *     the DOM misses the error that explains it;
 *   - **image admission** through `core/llm/admission.ts`, like any producer.
 *
 * What it reaches is decided by the fence (`fence.ts`, ARCHITECTURE §7):
 * loopback, the workspace's own `file:` pages and the operator's `allowHosts`,
 * enforced inside the browser and proved at each launch. It asks no consent
 * and is deliberately NOT a `NETWORK_TOOL`: the browser itself opens no
 * connection and resolves no name off the machine unless the operator named
 * the host, so a delegated verifier child may use it. What it does reach is
 * every loopback service on the host — any of which may act, or relay to the
 * network, on its own authority — which ARCHITECTURE §13 says.
 *
 * Registered only where a browser was found (`locate.ts`); whether it can
 * start is learnt at the first launch and a host failure is remembered for the
 * process (`BROWSER_UNAVAILABLE`).
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { asAttachmentId, ATTACHMENTS, isImageAdmissionError, type ImageMediaType } from '../../core/attachments/index.ts'
import { CREDENTIALS } from '../../core/credentials/index.ts'
import type { JsonValue } from '../../core/json.ts'
import { assertImageFits, assertImageRoom, assertRouteTakesImages } from '../../core/llm/admission.ts'
import { imageDescriptor } from '../../core/llm/content.ts'
import { LLM, type Llm } from '../../core/llm/index.ts'
import { canonicalPath } from '../../core/sandbox/index.ts'
import { matches, TOOL_RESULT } from '../../core/session/index.ts'
import { excerptWithoutSpill, excerptWithSpill, SPILL } from '../../core/spill/index.ts'
import { printableText } from '../../core/text.ts'
import { defineTool, TOOLS, type ToolContext } from '../../core/tools/index.ts'
import { BrowserError } from './errors.ts'
import { ALLOW_HOST_PATTERN, fileInsideWorkspace, reachable } from './fence.ts'
import { launchBrowser, type LaunchedBrowser } from './launch.ts'
import { locateBrowser, type LocatedBrowser } from './locate.ts'
import { openPage } from './page.ts'
import type { Action, BrowserPage, CallBudget, PageReport, RefCounter, Viewport } from './types.ts'

export interface ToolBrowserConfig {
  /** Where per-launch profiles live; filled by the app (`app/home.ts`). */
  readonly profileRoot: string
  /** A specific Chrome, Edge or Chromium; otherwise the first found at a known place. */
  readonly executablePath?: string | undefined
  /** Default true. `false` opens a window a person can watch. */
  readonly headless?: boolean | undefined
  /** Default 1280×800 at DPR 1. */
  readonly viewport?: Viewport | undefined
  /** Hosts beyond loopback the browser may reach (`example.com`, `*.example.com`). Authority-sensitive. */
  readonly allowHosts?: readonly string[] | undefined
  /** The longest snapshot returned inline (default 16,000 characters); the rest spills. */
  readonly maxSnapshotChars?: number | undefined
}

const viewportSchema = z.strictObject({ width: z.number().int().min(200).max(4096), height: z.number().int().min(200).max(4096) })

const configSchema = z.strictObject({
  profileRoot: z.string().min(1),
  executablePath: z.string().min(1).optional(),
  headless: z.boolean().optional(),
  viewport: viewportSchema.optional(),
  allowHosts: z.array(z.string().regex(ALLOW_HOST_PATTERN, 'a host name, IPv4 address or *.host, lower-case, nothing else')).max(64).optional(),
  maxSnapshotChars: z.number().int().min(2_000).max(200_000).optional(),
})

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 }
const DEFAULT_MAX_SNAPSHOT_CHARS = 16_000
/** What an action's change report may take inline before it spills. */
const MAX_CHANGE_CHARS = 6_000
const MAX_EVALUATE_CHARS = 8_000
/** A cold launch, including the fence's proof. Measured 0.7–1.7 s idle; generous for a loaded host. */
const LAUNCH_MS = 45_000
/** How long a page that left a command unanswered gets to answer a trivial one before it is replaced. */
const PROBE_MS = 3_000

interface Deps {
  readonly ctx: Context
  readonly llm: Llm
  readonly config: ToolBrowserConfig
  readonly browser: LocatedBrowser
  readonly viewport: Viewport
  readonly allowHosts: readonly string[]
  readonly maxSnapshotChars: number
  /** A host failure remembered for this process: the browser will not start here, so do not pay for learning it again. */
  unavailable: BrowserError | undefined
}

/**
 * One agent's browser. Owns its launch, its page, its ref counter and its call
 * queue; the agent's scope owns IT (the disposer is registered before the
 * first spawn, and reads nothing but these fields).
 */
class AgentBrowser {
  private readonly agent: Agent
  private readonly deps: Deps
  private launched: LaunchedBrowser | undefined
  private page: BrowserPage | undefined
  private starting: Promise<BrowserPage> | undefined
  private generation = 0
  /** Survives relaunches, so a ref minted before a crash can never name a node after it. */
  readonly refs: RefCounter = { next: 1 }
  /** The text of the last snapshot the model was shown, for an action's change report. */
  lastSnapshot: string | undefined
  /** Set when the browser had to be relaunched; told once, in the next result. */
  private relaunched: string | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** Set when the page left a command unanswered; the next call checks it before trusting it. */
  private suspect = false

  constructor(agent: Agent, deps: Deps) {
    this.agent = agent
    this.deps = deps
    // A resume or a fork is a new agent over an old history, and that history
    // holds refs its browser minted. Numbering past the highest one it shows
    // keeps "a ref never aliases" true across the lifecycle boundary too (the
    // review reproduced an old e3 clicking a fork's new e3); and the model is
    // told, once, that the browser behind those refs is gone.
    const seen = highestRef(agent)
    if (seen > 0) {
      this.refs.next = seen + 1
      this.relaunched = "This session's earlier browser was not carried over (a resume or a fork starts a new one); refs from before are no longer valid."
    }
  }

  /** Serialized per agent: an operation starts only once the previous one has ended. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The live page, launching or relaunching the browser when there is none. */
  async ensurePage(budget: CallBudget): Promise<BrowserPage> {
    if (this.disposed) throw new BrowserError('BROWSER_CLOSED', 'this agent is shutting down; its browser is gone')
    if (this.page !== undefined && !this.page.gone && this.launched !== undefined && this.launched.cdp.closed === undefined) {
      if (!this.suspect) return this.page
      this.suspect = false
      // The last call found the page not answering. A pending promise or a
      // slow tree also look like that, so ask once more, briefly; a page that
      // still does not answer is stuck (a script in a loop, a renderer its
      // host is slow to reap — seen on CI) and would wedge every later call.
      // The browser lives on: only the page is replaced.
      if (await this.page.responsive(PROBE_MS)) return this.page
      const stuck = this.page
      this.page = undefined
      await stuck.close()
      this.generation++
      this.page = await openPage({ cdp: this.launched.cdp, generation: this.generation, workspaceRoot: canonicalPath(this.agent.session.header.cwd), viewport: this.deps.viewport, refs: this.refs })
      this.relaunched = 'The page stopped answering (a script in it may be stuck in a loop) and was replaced by a fresh one; navigate again. Refs from before are no longer valid.'
      return this.page
    }
    if (this.launched !== undefined) {
      // The browser or its page went away under us (a crash, a person closing
      // its window): clean up what is left, and say so in the next result.
      const old = this.launched
      this.launched = undefined
      this.page = undefined
      this.relaunched = 'The browser had exited and was started again; refs from before are no longer valid.'
      await old.close()
    }
    const known = this.deps.unavailable
    if (known !== undefined) {
      throw new BrowserError(known.code, `${known.message} (remembered from an earlier attempt in this process: fix the host, then restart MiniDSH)`, { hostFault: true })
    }
    if (this.starting === undefined) {
      this.starting = this.start(budget).finally(() => (this.starting = undefined))
      // A start the caller stopped waiting for still ends somewhere; its
      // failure is the next caller's to see, never an unhandled rejection.
      this.starting.catch(() => undefined)
    }
    // A cancelled call does not wait out a launch (seconds, or a wedged
    // browser's timeouts): it returns at once, and the launch lands for the
    // next call — or, if the agent is gone by then, closes itself.
    return untilAborted(this.starting, budget.signal)
  }

  private async start(budget: CallBudget): Promise<BrowserPage> {
    let launched: LaunchedBrowser
    try {
      launched = await launchBrowser({
        executablePath: this.deps.browser.path,
        profileRoot: this.deps.config.profileRoot,
        headless: this.deps.config.headless ?? true,
        allowHosts: this.deps.allowHosts,
        // Asked at every spawn, as the shell does: a row that declared since is withheld too.
        declared: this.deps.ctx.tryGet(CREDENTIALS)?.declaredRefs() ?? [],
        window: this.deps.viewport,
        startTimeoutMs: Math.max(1_000, Math.min(LAUNCH_MS, budget.deadline - Date.now())),
      })
    } catch (error) {
      // Only a fact about the host is remembered; a moment's failure (a browser
      // that died while starting, a timeout) is tried again next call.
      if (error instanceof BrowserError && error.hostFault) this.deps.unavailable = error
      throw error
    }
    if (this.disposed) {
      // Disposed while launching: the disposer already ran and found nothing to close.
      await launched.close()
      throw new BrowserError('BROWSER_CLOSED', 'this agent shut down while its browser was starting')
    }
    this.launched = launched
    this.generation++
    try {
      this.page = await openPage({ cdp: launched.cdp, generation: this.generation, workspaceRoot: canonicalPath(this.agent.session.header.cwd), viewport: this.deps.viewport, refs: this.refs })
    } catch (error) {
      this.launched = undefined
      await launched.close()
      throw error
    }
    return this.page
  }

  /** A command this call sent went unanswered: check the page before the next call trusts it. */
  markSuspect(): void {
    this.suspect = true
  }

  /** The note a relaunch left, once. */
  takeRelaunchNote(): string | undefined {
    const note = this.relaunched
    this.relaunched = undefined
    return note
  }

  /** The disposer: idempotent, touches only this object's own process handle. */
  async dispose(): Promise<void> {
    this.disposed = true
    const launched = this.launched
    this.launched = undefined
    this.page = undefined
    // A launch in flight sees `disposed` when it lands and closes itself.
    if (launched !== undefined) await launched.close()
  }
}

/** The highest `[ref=eN]` any tool result in this agent's history shows, 0 for none. */
function highestRef(agent: Agent): number {
  let highest = 0
  for (const event of agent.session.facts) {
    if (!matches(event, TOOL_RESULT)) continue
    for (const block of event.data.message.content) {
      if (block.type !== 'tool-result') continue
      for (const part of block.content) {
        if (part.type !== 'text') continue
        for (const found of part.text.matchAll(/\[ref=e(\d+)\]/g)) highest = Math.max(highest, Number(found[1]))
      }
    }
  }
  return highest
}

/** `work`, or the signal's reason as soon as the signal aborts, whichever is first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export const toolBrowserPlugin: Plugin<ToolBrowserConfig> = {
  name: 'tool-browser',
  inject: [TOOLS, LLM],
  config: configSchema,
  apply(ctx, config) {
    const browser = locateBrowser(config.executablePath)
    if (browser === undefined) {
      // A configured browser that is missing is the operator's to fix; no
      // browser at all is an ordinary host, and the model is offered nothing.
      if (config.executablePath !== undefined) ctx.logger.warn(`tool-browser: ${config.executablePath} does not exist; no browser tools are offered`)
      return
    }
    const deps: Deps = {
      ctx,
      llm: ctx.get(LLM),
      config,
      browser,
      viewport: config.viewport ?? DEFAULT_VIEWPORT,
      allowHosts: config.allowHosts ?? [],
      maxSnapshotChars: config.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS,
      unavailable: undefined,
    }
    const browsers = new WeakMap<Agent, AgentBrowser>()
    const browserFor = (agent: Agent | undefined): AgentBrowser => {
      if (agent === undefined) throw new BrowserError('BROWSER_CLOSED', 'the browser belongs to an agent, and this call has none')
      const existing = browsers.get(agent)
      if (existing !== undefined) return existing
      const created = new AgentBrowser(agent, deps)
      // Registered BEFORE anything is spawned: an agent scope that is already
      // unwinding refuses the effect here, and nothing starts.
      try {
        agent.ctx.effect(() => () => created.dispose(), 'browser.session')
      } catch {
        throw new BrowserError('BROWSER_CLOSED', 'this agent is shutting down; no browser starts for it')
      }
      browsers.set(agent, created)
      return created
    }
    const tools = ctx.get(TOOLS)
    const { navigate, snapshot, act, screenshot, evaluate } = buildTools(deps, browserFor)
    tools.register(ctx, navigate)
    tools.register(ctx, snapshot)
    tools.register(ctx, act)
    tools.register(ctx, screenshot)
    tools.register(ctx, evaluate)
  },
}

// ---- the tools --------------------------------------------------------------

const REACH = (allowHosts: readonly string[]): string =>
  `It reaches loopback (localhost, 127.x.x.x, [::1]) and file: pages inside the workspace${allowHosts.length === 0 ? '' : `, plus ${allowHosts.join(', ')}`}; every other request is refused inside the browser.`

const HEADER_NOTE = 'Every result opens with what happened on the page since the previous browser result: console errors and warnings, uncaught exceptions, failed requests, dialogs.'

function buildTools(deps: Deps, browserFor: (agent: Agent | undefined) => AgentBrowser) {
  const textOutput = z.object({ text: z.string() })
  // Generic in the arguments, so each tool's own input type is still what `defineTool` infers.
  const renderText = <Args>(_args: Args, value: { text: string }) => [{ type: 'text' as const, text: value.text }]

  /** One browser operation: queued per agent, bounded by its own deadline, reported with the page header. */
  const operate = <T>(exec: ToolContext, budgetMs: number, work: (session: AgentBrowser, page: BrowserPage, budget: CallBudget) => Promise<T>): Promise<T> => {
    const session = browserFor(exec.agent)
    return session.run(async () => {
      // The deadline starts when this call's turn in the queue does.
      const budget: CallBudget = { signal: exec.signal, deadline: Date.now() + budgetMs }
      try {
        const page = await session.ensurePage(budget)
        return await work(session, page, budget)
      } catch (error) {
        // A wait cancelled with the turn rejects with the turn's own cancel
        // cause, which is not an error a result can name; this one says what
        // the model needs to know.
        if (error instanceof BrowserError && error.unanswered) session.markSuspect()
        if (exec.signal.aborted) throw Object.assign(new Error('the turn was cancelled while the browser was working; the page may be part-way through what was asked'), { code: 'ABORTED' })
        throw error
      }
    })
  }

  const navigate = defineTool({
    name: 'browser_navigate',
    description: `Open a URL in this session's browser — a real Chrome or Edge, started on first use — and wait for it to load.
* Returns what happened on the page (title, HTTP status, console errors, failed requests) and an accessibility snapshot whose [ref=eN] marks name elements for browser_act.
* ${REACH(deps.allowHosts)}
* To check an app you are building, start its dev server as a background job first and open its local URL here: a loopback URL that refuses connections is retried for wait_ms while the server starts.`,
    input: z.object({
      url: z.string().min(1).describe('The URL: http(s) on loopback, a file: URL inside the workspace, or an allowed host.'),
      wait_ms: z.number().int().min(0).max(60_000).optional().describe('How long to keep retrying a loopback URL that refuses connections (default 15000).'),
      viewport: viewportSchema.optional().describe('Resize the page first, e.g. {"width": 390, "height": 844} for a phone.'),
    }),
    output: textOutput,
    timeoutMs: null,
    render: renderText,
    execute: async (args, exec) => {
      const url = admitUrl(args.url, deps, exec.agent)
      const waitMs = args.wait_ms ?? 15_000
      return operate(exec, LAUNCH_MS + waitMs + 40_000, async (session, page, budget) => {
        if (args.viewport !== undefined) await page.setViewport(args.viewport)
        const { loaded } = await page.navigate(url.href, { ...budget, waitMs })
        // The page loaded; a snapshot it cannot give (a tree past the message
        // cap, the deadline) must not turn that into a failed navigation.
        let body: string
        try {
          const snapshot = await page.snapshot(budget)
          session.lastSnapshot = snapshot
          body = bound(deps, exec, snapshot, deps.maxSnapshotChars, 'snapshot')
        } catch (error) {
          if (!(error instanceof BrowserError) || error.code === 'BROWSER_CLOSED') throw error
          body = `(The page loaded, but its accessibility tree could not be read: ${clamp(error.message, 300)}. Read part of it with browser_snapshot and a ref, or ask about it with browser_evaluate.)`
        }
        const report = await page.report()
        const note = loaded ? '' : '\n(The page had not finished loading when the wait ran out; what it shows may still change.)'
        return { text: `${header(report, session.takeRelaunchNote())}${note}\n\n${body}` }
      })
    },
  })

  const snapshot = defineTool({
    name: 'browser_snapshot',
    description: `Read the current page as an accessibility tree: one line per element, its role, name and state, and a [ref=eN] that browser_act takes.
* ${HEADER_NOTE}
* ref reads one element's subtree; wait_for_text first waits for that text to appear (for content that loads after an action).
* A completed action does not prove its outcome: read the page again to check it.`,
    input: z.object({
      ref: z.string().min(1).optional().describe('Read only this element and what it contains.'),
      wait_for_text: z.string().min(1).optional().describe('Wait until the page text contains this before reading.'),
      timeout_ms: z.number().int().min(0).max(60_000).optional().describe('How long wait_for_text may wait (default 10000).'),
    }),
    output: textOutput,
    timeoutMs: null,
    render: renderText,
    execute: (args, exec) =>
      operate(exec, 30_000 + (args.timeout_ms ?? 10_000), async (session, page, budget) => {
        // timeout_ms bounds the WAIT only; the snapshot after it has the whole budget.
        const text = await page.snapshot({
          ...budget,
          ...(args.ref === undefined ? {} : { ref: args.ref }),
          ...(args.wait_for_text === undefined ? {} : { waitForText: args.wait_for_text, waitUntil: Date.now() + (args.timeout_ms ?? 10_000) }),
        })
        if (args.ref === undefined) session.lastSnapshot = text
        const report = await page.report()
        return { text: `${header(report, session.takeRelaunchNote())}\n\n${bound(deps, exec, text, deps.maxSnapshotChars, 'snapshot')}` }
      }),
  })

  const act = defineTool({
    name: 'browser_act',
    description: `Act on the page the way a person would, then report what changed.
* click / hover: an element by ref. type: replace a field's text with text (submit: true presses Enter after). press: a key such as Enter, Tab, Escape, ArrowDown or Control+A, on ref or on the focused element. select: choose option (a value or visible label) in a <select>.
* ref comes from the latest snapshot; a ref from a page that has changed since fails with "take a new snapshot".
* click and hover refuse an element that is hidden or covered by another (naming what covers it), and click one that is disabled; type and select refuse one that is hidden, disabled or read-only.
* A dialog the action raises (alert, confirm, prompt) is dismissed unless dialog is "accept".
* ${HEADER_NOTE}`,
    input: z
      .object({
        action: z.enum(['click', 'hover', 'type', 'press', 'select']),
        ref: z.string().min(1).optional().describe('The element, from the latest snapshot. Required except for press.'),
        text: z.string().optional().describe('type: the text to put in the field ("" clears it).'),
        submit: z.boolean().optional().describe('type: press Enter after typing.'),
        key: z.string().min(1).optional().describe('press: the key, e.g. Enter, Tab, Escape, ArrowDown, Control+A.'),
        option: z.string().optional().describe('select: the option value or visible label.'),
        dialog: z.enum(['accept', 'dismiss']).optional().describe('How to answer a dialog this action raises (default dismiss).'),
      })
      .superRefine((args, issues) => {
        const need = (field: 'ref' | 'text' | 'key' | 'option'): void => {
          if (args[field] === undefined) issues.addIssue({ code: 'custom', path: [field], message: `${args.action} needs ${field}` })
        }
        if (args.action !== 'press') need('ref')
        if (args.action === 'type') need('text')
        if (args.action === 'press') need('key')
        if (args.action === 'select') need('option')
      }),
    output: textOutput,
    timeoutMs: null,
    render: renderText,
    execute: (args, exec) =>
      operate(exec, 45_000, async (session, page, budget) => {
        const done = await page.act(toAction(args), { ...budget, dialog: args.dialog ?? 'dismiss' })
        const now = await page.snapshot(budget)
        const changes = changesSince(session.lastSnapshot, now)
        session.lastSnapshot = now
        const report = await page.report()
        return { text: `${header(report, session.takeRelaunchNote())}\n\n${done}.\n\n${bound(deps, exec, changes, MAX_CHANGE_CHARS, 'changes')}` }
      }),
  })

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description: `See what the page looks like: the viewport (1280x800 by default), the whole page with full_page, or one element by ref.
* Only a vision-capable route can receive an image. On a text-only route this is refused before anything is captured — delegate the look to a subagent whose route can see images, and ask it to report.
* ${HEADER_NOTE}`,
    input: z.object({
      full_page: z.boolean().optional().describe('Capture the whole scrollable page, cut at the deployment’s largest image side.'),
      ref: z.string().min(1).optional().describe('Capture only this element.'),
    }),
    output: z.object({
      attachment: z.object({ id: z.string(), mediaType: z.string(), bytes: z.number(), width: z.number(), height: z.number(), name: z.string().nullable() }),
      descriptor: z.string(),
      text: z.string(),
    }),
    timeoutMs: null,
    render: (_args, value) => [
      { type: 'text', text: value.text },
      {
        type: 'image',
        attachment: {
          id: asAttachmentId(value.attachment.id),
          mediaType: value.attachment.mediaType as ImageMediaType,
          bytes: value.attachment.bytes,
          width: value.attachment.width,
          height: value.attachment.height,
          ...(value.attachment.name === null ? {} : { name: value.attachment.name }),
        },
        text: value.descriptor,
      },
    ],
    execute: async (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new BrowserError('BROWSER_CLOSED', 'the browser belongs to an agent, and this call has none')
      // Steps 1 and 2 of image admission, before the browser is even started.
      assertRouteTakesImages(deps.llm, agent)
      const attachments = deps.ctx.tryGet(ATTACHMENTS)
      if (attachments === undefined) throw Object.assign(new Error('this deployment stores no attachments, so a screenshot cannot be returned'), { code: 'UNSUPPORTED_CONTENT' })
      const limits = attachments.imageLimits
      assertImageRoom(agent.session, limits)
      return operate(exec, 45_000, async (session, page, budget) => {
        const shot = await page.screenshot({ ...budget, fullPage: args.full_page === true, ...(args.ref === undefined ? {} : { ref: args.ref }), maxDimension: limits.maxImageDimension, maxBytes: limits.maxImageBytes })
        // Step 3, once the size is known; then committed before this returns.
        assertImageFits(agent.session, limits, shot.data.length, 'this screenshot')
        let ref
        try {
          ref = await attachments.saveImage({ data: shot.data, declaredMediaType: shot.mediaType, name: 'screenshot' })
        } catch (error) {
          const code = isImageAdmissionError(error) ? (error as { code: string }).code : 'ATTACHMENT_WRITE_FAILED'
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code })
        }
        const report = await page.report()
        const cut = shot.clipped === undefined ? '' : `\n(${shot.clipped})`
        return {
          attachment: { id: ref.id, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name ?? null },
          descriptor: imageDescriptor(ref),
          text: `${header(report, session.takeRelaunchNote())}${cut}`,
        }
      })
    },
  })

  const evaluate = defineTool({
    name: 'browser_evaluate',
    description: `Evaluate a JavaScript expression in the page and return its value as JSON (a promise is awaited).
* For what a snapshot cannot show: computed styles, element sizes and positions, scroll sizes, storage, application state.
* ${HEADER_NOTE}`,
    input: z.object({
      expression: z.string().min(1).describe('An expression, e.g. getComputedStyle(document.querySelector("h1")).color'),
      timeout_ms: z.number().int().min(100).max(60_000).optional().describe('How long it may run (default 10000).'),
    }),
    output: textOutput,
    timeoutMs: null,
    render: renderText,
    execute: (args, exec) =>
      operate(exec, 5_000 + (args.timeout_ms ?? 10_000), async (session, page, budget) => {
        const result = await page.evaluate(args.expression, { ...budget, deadline: Math.min(budget.deadline, Date.now() + (args.timeout_ms ?? 10_000)) })
        const report = await page.report()
        const body =
          result.exception !== undefined
            ? `It threw: ${clamp(result.exception, 2_000)}`
            : result.unreturnable !== undefined
              ? `It returned nothing that can come back as JSON (${clamp(result.unreturnable, 400)}). Return a property instead: a textContent, a getBoundingClientRect(), a computed style.`
              : result.value === undefined
                ? 'It returned undefined.'
                : stringify(result.value)
        return { text: `${header(report, session.takeRelaunchNote())}\n\n${bound(deps, exec, body, MAX_EVALUATE_CHARS, 'evaluate')}` }
      }),
  })

  return { navigate, snapshot, act, screenshot, evaluate }
}

// ---- helpers ----------------------------------------------------------------

/** The navigation check: the same rule the fence enforces, refused before anything starts. */
function admitUrl(raw: string, deps: Deps, agent: Agent | undefined): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BrowserError('BROWSER_URL_REFUSED', `"${clamp(raw, 200)}" is not a URL; give a full one such as http://localhost:5173/`)
  }
  if (url.href === 'about:blank') return url
  if (url.protocol === 'file:') {
    if (agent !== undefined && fileInsideWorkspace(url, agent.session.header.cwd)) return url
    throw new BrowserError('BROWSER_URL_REFUSED', `${clamp(url.href, 300)} is outside this session's workspace; the browser opens only the workspace's own files`)
  }
  if (reachable(url, deps.allowHosts)) return url
  const hint = url.hostname === '0.0.0.0' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(url.hostname) ? ' A dev server listening on all interfaces is reachable as http://localhost:<port>/.' : ''
  throw new BrowserError('BROWSER_URL_REFUSED', `${clamp(url.href, 300)} is outside what this browser may reach. ${REACH(deps.allowHosts)}${hint}`)
}

function toAction(args: { action: 'click' | 'hover' | 'type' | 'press' | 'select'; ref?: string | undefined; text?: string | undefined; submit?: boolean | undefined; key?: string | undefined; option?: string | undefined }): Action {
  switch (args.action) {
    case 'click':
      return { kind: 'click', ref: args.ref! }
    case 'hover':
      return { kind: 'hover', ref: args.ref! }
    case 'type':
      return { kind: 'type', ref: args.ref!, text: args.text!, submit: args.submit === true }
    case 'press':
      return { kind: 'press', key: args.key!, ...(args.ref === undefined ? {} : { ref: args.ref }) }
    case 'select':
      return { kind: 'select', ref: args.ref!, values: [args.option!] }
  }
}

/**
 * How much of a result the header's event list may take. The page decides how
 * much it logs, so without a bound one noisy page would cost every result tens
 * of thousands of characters (the review measured a 49 KB header) and crowd out
 * the snapshot the call was for.
 */
const MAX_EVENT_CHARS = 4_000

/**
 * The page header: one line for where the page is, then only what happened.
 * Every string from the page is made printable and clamped: it is the page's
 * text, not ours, and it lands in the log.
 */
export function header(report: PageReport, relaunch: string | undefined): string {
  const lines: string[] = []
  if (relaunch !== undefined) lines.push(relaunch)
  if (report.crashed) lines.push('The page crashed. Navigate to load it again.')
  const status = report.status === undefined ? '' : ` (HTTP ${report.status})`
  // Chrome titles a page with no <title> by its address (scheme dropped): that is not a title.
  const untitled = report.title === '' || report.title === report.url || report.title === report.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  lines.push(`Page: ${untitled ? '(untitled)' : `"${clamp(report.title, 120)}"`} at ${clamp(report.url, 300)}${status}${report.navigated ? ' — navigated' : ''}`)
  const errors = report.console.filter((entry) => entry.level === 'error').length
  const warnings = report.console.length - errors
  const events: string[] = []
  for (const entry of report.console) events.push(`console ${entry.level}: ${clamp(entry.text, 300)}${entry.where === undefined ? '' : ` (${clamp(entry.where, 160)})`}`)
  for (const exception of report.exceptions) events.push(`uncaught: ${clamp(exception, 400)}`)
  for (const failed of report.failedRequests) events.push(`${failed.fenced ? 'blocked by the browser fence' : 'request failed'}: ${clamp(failed.url, 200)} (${clamp(failed.reason, 80)})`)
  for (const dialog of report.dialogs) events.push(`${dialog.type} dialog "${clamp(dialog.message, 200)}" was ${dialog.answer}`)
  for (const download of report.downloads) {
    const name = clamp(download.name, 120)
    events.push(download.outcome === 'refused' ? `download refused: ${name}` : download.outcome === 'started' ? `download started, not yet settled: ${name}` : `download SAVED despite this browser's deny policy: ${name}`)
  }
  for (const url of report.blockedFiles) events.push(`file outside the workspace refused: ${clamp(url, 200)}`)
  for (const url of report.popups) events.push(`new window closed unopened: ${clamp(url, 200)}`)
  if (events.length === 0 && report.omitted === 0) {
    lines.push('Since the last browser result: no console errors or warnings, exceptions, failed requests or dialogs.')
  } else {
    lines.push(`Since the last browser result (${errors} console error(s), ${warnings} warning(s), ${report.exceptions.length} exception(s), ${report.failedRequests.length} failed request(s)):`)
    // In order, so the FIRST error — usually the cause — always shows.
    let used = 0
    let shown = 0
    for (const event of events) {
      if (used + event.length > MAX_EVENT_CHARS && shown > 0) break
      lines.push(`  - ${event}`)
      used += event.length
      shown++
    }
    const unshown = events.length - shown + report.omitted
    if (unshown > 0) lines.push(`  - …and ${unshown} more event(s) not shown`)
  }
  return lines.join('\n')
}

/**
 * What changed between two snapshots, as lines removed and added. A multiset
 * difference, not a diff: refs make most lines unique and the indentation
 * keeps their place readable, which is all a model needs to see that a count
 * went from 0 to 1 — at a fraction of a full snapshot's tokens.
 */
export function changesSince(before: string | undefined, after: string): string {
  if (before === undefined) return `The page now reads:\n${after}`
  const count = new Map<string, number>()
  for (const line of before.split('\n')) count.set(line, (count.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after.split('\n')) {
    const seen = count.get(line) ?? 0
    if (seen > 0) count.set(line, seen - 1)
    else added.push(line)
  }
  const removed = Array.from(count.entries()).flatMap(([line, left]) => Array.from({ length: left }, () => line))
  if (added.length === 0 && removed.length === 0) return 'The page snapshot did not change.'
  const diff = [...removed.map((line) => `- ${line.trimStart()}`), ...added.map((line) => `+ ${line.trimStart()}`)].join('\n')
  // A change bigger than the page itself is no help: show the page.
  return diff.length < after.length ? `Snapshot changes (- gone, + new):\n${diff}` : `The page now reads:\n${after}`
}

function bound(deps: Deps, exec: ToolContext, text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const tailChars = Math.floor(maxChars / 8)
  const options = { headChars: maxChars - tailChars, tailChars }
  const spill = deps.ctx.tryGet(SPILL)
  const sessionId = exec.agent?.session.id
  if (spill === undefined || sessionId === undefined) return excerptWithoutSpill(text, options)
  try {
    return excerptWithSpill(text, spill.save({ sessionId, callId: exec.callId, label, text }), options)
  } catch {
    return excerptWithoutSpill(text, options)
  }
}

function stringify(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 1)
}

/** Printable, and cut by code point (never through a surrogate pair), marked when cut. */
function clamp(text: string, max: number): string {
  const chars = Array.from(printableText(text))
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}
