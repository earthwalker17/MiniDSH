/**
 * Owning the terminal, and always giving it back.
 *
 * Entering sets a fixed table of modes (raw input, the alternate screen,
 * bracketed paste, autowrap off, the cursor hidden until a frame places it);
 * leaving undoes exactly that table in reverse, plus whatever a frame might
 * have left set (synchronized output, an SGR), on EVERY path out: `/exit`,
 * the host ending, SIGTERM/SIGHUP, an uncaught exception (the terminal first,
 * then the report) and, as a backstop, `process.on('exit')`. The restore is
 * written with `fs.writeSync`: on Windows Node writes to a TTY
 * asynchronously, and bytes queued behind an exiting process are lost.
 *
 * While the screen is ours, anything else writing to stderr — the kernel's
 * `console.warn` logger, the CLI's, a Node warning — would land on the
 * alternate screen and tear the frame the writer thinks is there. Those
 * writes are captured and handed to the view (a notice), and printed after
 * the terminal is restored. A child process writing straight to the terminal
 * (an unconfined POSIX shell's `sudo` reading /dev/tty) is not ours to stop:
 * Ctrl+L repaints (ARCHITECTURE §13).
 *
 * The mouse is not captured (the S22.1 user decision): native selection keeps
 * working, and the terminal's own alternate-scroll mode turns the wheel into
 * arrow keys on this screen (measured on Windows Terminal), which the view
 * treats as scrolling when the draft is empty.
 */
import { writeSync } from 'node:fs'
import { cleanKeepingLines } from './width.ts'

/** Each mode the full-screen view sets, with the sequence that undoes it. */
const MODES: readonly (readonly [set: string, reset: string])[] = [
  ['\x1b[?1049h', '\x1b[?1049l'], // the alternate screen
  ['\x1b[?2004h', '\x1b[?2004l'], // bracketed paste
  ['\x1b[?7l', '\x1b[?7h'], // autowrap off: a full last column never scrolls
  ['\x1b[?25l', '\x1b[?25h'], // the cursor, until a frame places it
]
// Alternate scroll (?1007) is deliberately not in the table: its reset would
// switch OFF what Windows Terminal has on by default, so `less` in that tab
// would lose its wheel after exit (S22.1 pre-push review); a terminal with it
// off keeps the wheel for its own scrollback.
/** The signals that end the process with the terminal restored first. */
const SIGNALS: readonly NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
/** What a frame may leave behind, undone first whatever happened. */
const AFTER_FRAME = '\x1b[?2026l\x1b[0m'

export interface TtyStreams {
  readonly input: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean }
  readonly output: NodeJS.WritableStream & { columns?: number; rows?: number; fd?: number }
}

export class Tty {
  private readonly streams: TtyStreams
  private entered = false
  private readonly writeNow: (text: string) => void
  private captured: string[] = []
  private originalStderr: typeof process.stderr.write | undefined
  private warningListeners: ((...args: unknown[]) => void)[] = []
  private readonly ownProcess: boolean
  private readonly onExit = (): void => this.leave()
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.leave()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  private readonly onCrash = (error: unknown): void => {
    this.leave()
    process.stderr.write(`minidsh: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  }

  /** `ownProcess`: this is the real process's terminal, so signals and crashes are ours to handle. */
  constructor(streams: TtyStreams, ownProcess: boolean) {
    this.streams = streams
    this.ownProcess = ownProcess
    const fd = streams.output.fd
    // The real stdout gets synchronous writes for the restore; a test's stream
    // records the same bytes through its own write.
    this.writeNow =
      ownProcess && typeof fd === 'number'
        ? (text) => {
            try {
              writeSync(fd, text)
            } catch {
              // The terminal is gone; there is nothing left to restore.
            }
          }
        : (text) => void streams.output.write(text)
  }

  get size(): { columns: number; rows: number } {
    return { columns: this.streams.output.columns ?? 80, rows: this.streams.output.rows ?? 24 }
  }

  enter(): void {
    if (this.entered) return
    this.entered = true
    this.streams.input.setRawMode?.(true)
    this.streams.input.resume()
    this.write(MODES.map(([set]) => set).join(''))
    if (this.ownProcess) {
      process.on('exit', this.onExit)
      // SIGINT too: raw mode makes Ctrl+C a key, but an external `kill -INT`
      // (or Ctrl+Break on Windows) would otherwise end the process raw.
      for (const signal of SIGNALS) process.on(signal, this.onSignal)
      process.on('uncaughtException', this.onCrash)
      process.on('unhandledRejection', this.onCrash)
      this.captureStderr()
    }
  }

  /** Idempotent: safe from any exit path, any number of times. */
  leave(): void {
    if (!this.entered) return
    this.entered = false
    this.writeNow(`${AFTER_FRAME}${MODES.map(([, reset]) => reset)
      .toReversed()
      .join('')}`)
    try {
      this.streams.input.setRawMode?.(false)
    } catch {
      // Not a TTY any more.
    }
    this.streams.input.pause()
    if (this.ownProcess) {
      process.removeListener('exit', this.onExit)
      for (const signal of SIGNALS) process.removeListener(signal, this.onSignal)
      process.removeListener('uncaughtException', this.onCrash)
      process.removeListener('unhandledRejection', this.onCrash)
      this.releaseStderr()
    }
  }

  get active(): boolean {
    return this.entered
  }

  write(text: string): void {
    if (text.length > 0) this.streams.output.write(text)
  }

  /** What other code wrote to stderr while the screen was ours, taken once. */
  drainCaptured(): string[] {
    const out = this.captured
    this.captured = []
    return out
  }

  /** Called when a capture arrives, so the view can show it. */
  onCaptured: ((text: string) => void) | undefined

  private captureStderr(): void {
    if (this.originalStderr !== undefined) return
    this.originalStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      this.captured.push(text)
      this.onCaptured?.(text)
      const callback = rest.find((arg) => typeof arg === 'function') as ((error?: Error | null) => void) | undefined
      callback?.()
      return true
    }) as typeof process.stderr.write
    // Node prints a warning through its own listener; it is set aside, not lost.
    this.warningListeners = process.listeners('warning') as ((...args: unknown[]) => void)[]
    process.removeAllListeners('warning')
    process.on('warning', this.onWarning)
  }

  private readonly onWarning = (warning: Error): void => {
    const text = `${warning.name}: ${warning.message}\n`
    this.captured.push(text)
    this.onCaptured?.(text)
  }

  private releaseStderr(): void {
    if (this.originalStderr === undefined) return
    process.stderr.write = this.originalStderr
    this.originalStderr = undefined
    process.removeListener('warning', this.onWarning)
    for (const listener of this.warningListeners) process.on('warning', listener)
    this.warningListeners = []
    // What was said while the screen was ours is said now, on the real screen,
    // cleaned: a log line can quote a name a model chose.
    const held = this.drainCaptured()
    for (const text of held) process.stderr.write(cleanKeepingLines(text))
  }
}
