/**
 * The browser's coded refusals. A tool result carries `{name, code}`, and a
 * model routes on the code: each says what the caller can do next, which is
 * why a stale ref and a dead browser are different codes even though both mean
 * "that did not happen".
 */
export type BrowserErrorCode =
  /** No usable browser on this host, or it would not start; memoized for the process. */
  | 'BROWSER_UNAVAILABLE'
  /** The launch-time fence proof failed (a policy proxy, or traffic going direct); memoized. */
  | 'BROWSER_FENCE_UNAVAILABLE'
  /** The browser or its page went away under a call (a crash, or someone else's kill). */
  | 'BROWSER_CLOSED'
  /** The call's own deadline passed. */
  | 'BROWSER_TIMEOUT'
  /** The URL is outside what this browser may reach (§7: loopback, the workspace's files, `allowHosts`). */
  | 'BROWSER_URL_REFUSED'
  /** A ref from an older snapshot, document or browser: snapshot again. */
  | 'BROWSER_STALE_REF'
  /** The element cannot take the action: hidden, disabled, covered, or not the right kind. */
  | 'BROWSER_NOT_ACTIONABLE'
  /** The protocol answered with an error the caller cannot fix. */
  | 'BROWSER_PROTOCOL'

export class BrowserError extends Error {
  readonly code: BrowserErrorCode
  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}
