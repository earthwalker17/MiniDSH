/**
 * The page model's contract: what the tools (`index.ts`) ask of one page, and
 * what it reports back. The page owns the CDP session to its target, its
 * buffers and its refs; the tools own the model-facing words, the deadlines and
 * the lifetime.
 */
import type { JsonValue } from '../../core/json.ts'
import type { CdpConnection } from './cdp.ts'

/**
 * The budget of one tool call. Every wait inside a page operation races both:
 * the caller's cancellation, and a wall-clock deadline the tool computed from
 * its own arguments (the tools opt out of the pipeline's deadline, so this is
 * the only one, and an operation must never outlive it).
 */
export interface CallBudget {
  readonly signal: AbortSignal
  /** Epoch milliseconds. */
  readonly deadline: number
}

export interface Viewport {
  readonly width: number
  readonly height: number
}

export interface ConsoleEntry {
  readonly level: 'error' | 'warning'
  readonly text: string
  /** `url:line` when the page said where. */
  readonly where?: string
}

export interface FailedRequest {
  readonly url: string
  /** An HTTP status (>= 400) or Chrome's `net::ERR_*` text. */
  readonly reason: string
  /** True when the browser's fence refused it (`fence.ts`), as opposed to the server or the network. */
  readonly fenced: boolean
}

export interface DialogEntry {
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  readonly message: string
  readonly answer: 'accepted' | 'dismissed'
}

/**
 * What happened on the page since the previous report: the header every tool
 * result opens with. Each list is bounded (newest kept) and `omitted` counts
 * what the bound dropped, so a quiet list is never mistaken for a quiet page.
 */
export interface PageReport {
  readonly url: string
  readonly title: string
  /** The current main document's HTTP status, when it came over http(s). */
  readonly status?: number
  readonly console: readonly ConsoleEntry[]
  /** Uncaught exceptions and unhandled rejections, as the page reported them. */
  readonly exceptions: readonly string[]
  readonly failedRequests: readonly FailedRequest[]
  readonly dialogs: readonly DialogEntry[]
  /** Downloads the browser refused (it denies them all). */
  readonly downloads: readonly string[]
  /** `file:` loads refused because they name a file outside the workspace. */
  readonly blockedFiles: readonly string[]
  /** New windows the page tried to open, closed unseen. */
  readonly popups: readonly string[]
  readonly omitted: number
  /** True when the main frame navigated since the previous report. */
  readonly navigated: boolean
  /** True when the page's renderer crashed; the next navigation starts it again. */
  readonly crashed: boolean
}

export type Action =
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'hover'; readonly ref: string }
  /** Replaces the element's text with `text`; `submit` presses Enter after. */
  | { readonly kind: 'type'; readonly ref: string; readonly text: string; readonly submit: boolean }
  /** A key name (`Enter`, `Tab`, `Escape`, `ArrowDown`, `a`, `Control+A`), on `ref` if given, else on whatever has focus. */
  | { readonly kind: 'press'; readonly key: string; readonly ref?: string }
  /** Options matched by value, then by visible label. */
  | { readonly kind: 'select'; readonly ref: string; readonly values: readonly string[] }

export interface Screenshot {
  readonly data: Uint8Array
  readonly mediaType: 'image/png' | 'image/jpeg'
  readonly width: number
  readonly height: number
  /** Set when a full page was taller than the deployment admits and was cut. */
  readonly clipped?: string
}

export interface BrowserPage {
  /**
   * Navigate the main frame and wait for it to load, then settle. A loopback
   * URL answering connection-refused is retried until `waitMs` has passed — a
   * dev server still starting. Resolves with whether `load` fired in time; a
   * navigation error (`net::ERR_*`) rejects with it.
   */
  navigate(url: string, options: CallBudget & { readonly waitMs: number }): Promise<{ readonly loaded: boolean }>
  /**
   * The accessibility tree as text, Playwright AI-snapshot style, every
   * non-ignored node carrying a ref: `- button "Add" [ref=e4]`. `ref` roots it
   * at that element; `waitForText` first waits (until the deadline) for the
   * page's text to contain it. Unbounded here: the tool bounds and spills.
   */
  snapshot(options: CallBudget & { readonly ref?: string; readonly waitForText?: string }): Promise<string>
  /** One action with Playwright's actionability, then the settle. Resolves with a one-line account of what it did. */
  act(action: Action, options: CallBudget & { readonly dialog: 'accept' | 'dismiss' }): Promise<string>
  /** Viewport (default), the whole page cut to `maxDimension`, or one element. JPEG when PNG would exceed `maxBytes`. */
  screenshot(options: CallBudget & { readonly fullPage: boolean; readonly ref?: string; readonly maxDimension: number; readonly maxBytes: number }): Promise<Screenshot>
  /** `Runtime.evaluate` by value, awaiting a promise. An exception is a value here, not a rejection. */
  evaluate(expression: string, options: CallBudget): Promise<{ readonly value?: JsonValue; readonly exception?: string }>
  setViewport(viewport: Viewport): Promise<void>
  /** Drains what happened since the previous report. */
  report(): Promise<PageReport>
  /** Closes the page's target; idempotent. */
  close(): Promise<void>
}

/**
 * Ref numbers are per AGENT, never per browser: the counter survives a
 * relaunch, so a ref minted before a crash can never name a node after it.
 */
export interface RefCounter {
  next: number
}

export interface PageOptions {
  readonly cdp: CdpConnection
  /** Which launch of this agent's browser this page belongs to; a ref from another generation is stale. */
  readonly generation: number
  /** The session's workspace root; `file:` loads outside it are refused (`fileInsideWorkspace`). */
  readonly workspaceRoot: string
  readonly viewport: Viewport
  readonly refs: RefCounter
}
