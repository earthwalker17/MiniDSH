/**
 * Supervision of the one runtime child, Electron-free: the argv it is started
 * with, the `web --json` records it prints, the launch-token handoff, and its
 * stop. The desktop reaches the runtime ONLY like this — by spawning the
 * bundled CLI and speaking its process contract and the wire (ARCHITECTURE
 * §8) — never by importing it.
 *
 * The argv is built from launcher settings alone, and from nothing a page,
 * a second instance or the runtime could supply: no authority flag
 * (`--approve`, `--sandbox`, `--accept`, `--ask`), no `--host`, no `--patch`,
 * no `--agent-preset`, ever. An authority switch is the person's, made in the
 * Web UI as a durable event (§7), not a launcher default.
 *
 * The launch token and the session cookie are credentials for an authority
 * surface. This module never logs either, and no error it raises quotes them.
 *
 * Owns: argv, record parsing, the handoff, the child's lifecycle and exit
 * classification. Must not own: what the window shows about it (main), the
 * port's persistence (`settings.ts`), or any retry policy (main decides).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer } from 'node:net'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { PORT_MAX, PORT_MIN } from './settings.ts'

// ---- argv ---------------------------------------------------------------------

export interface RuntimeArgvOptions {
  readonly bin: string
  readonly port: number
  readonly cwd: string
  readonly folders: readonly string[]
}

/**
 * Exactly `bin web --json --port P --cwd <cwd>` and one `--workspace` per
 * folder. Every path must be absolute, so no value can ever read as a flag.
 */
export function runtimeArgv({ bin, port, cwd, folders }: RuntimeArgvOptions): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError('the runtime port must be an integer in 1..65535')
  for (const path of [cwd, ...folders]) if (!isAbsolute(path)) throw new TypeError('runtime folders must be absolute paths')
  return [bin, 'web', '--json', '--port', String(port), '--cwd', cwd, ...folders.flatMap((folder) => ['--workspace', folder])]
}

// ---- records ------------------------------------------------------------------

export interface WorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly root: string
}

export interface ReadyRecord {
  readonly type: 'ready'
  readonly host: string
  readonly port: number
  readonly token: string
  readonly version: string
  readonly home: string
  readonly workspaces: readonly WorkspaceRecord[]
}

export interface ErrorRecord {
  readonly type: 'error'
  readonly code: string
  readonly message: string
}

/** A record of a known type that does not match the contract. Never carries the line: it may hold the token. */
export interface FaultRecord {
  readonly type: 'fault'
  readonly detail: string
}

export type RuntimeRecord = ReadyRecord | ErrorRecord | FaultRecord

/** No record is anywhere near this; a line past it is dropped, never buffered without bound. */
export const MAX_RECORD_LINE = 1024 * 1024

const TOKEN = /^[A-Za-z0-9_-]{1,512}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'

function workspacesOf(value: unknown): WorkspaceRecord[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: WorkspaceRecord[] = []
  for (const each of value) {
    if (!isRecord(each) || !isString(each.id) || !isString(each.name) || !isString(each.root)) return undefined
    out.push({ id: each.id, name: each.name, root: each.root })
  }
  return out
}

/** One stdout line to a record, or `undefined` for anything that is not one of ours (non-JSON, an unknown type). */
export function parseRecord(line: string): RuntimeRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.type === 'ready') {
    const { host, port, token, version, home } = value
    const workspaces = workspacesOf(value.workspaces)
    const portOk = typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535
    const tokenOk = isString(token) && TOKEN.test(token)
    if (isString(host) && portOk && tokenOk && isString(version) && isString(home) && workspaces !== undefined) {
      return { type: 'ready', host, port, token, version, home, workspaces }
    }
    // Field NAMES only: a value, the token above all, never reaches a log.
    const invalid = [!isString(host) && 'host', !portOk && 'port', !tokenOk && 'token', !isString(version) && 'version', !isString(home) && 'home', workspaces === undefined && 'workspaces']
    return { type: 'fault', detail: `a ready record with an invalid ${invalid.filter(isString).join(', ')}` }
  }
  if (value.type === 'error') {
    const { code, message } = value
    if (!isString(code) || !isString(message)) return { type: 'fault', detail: 'an error record without a string code and message' }
    return { type: 'error', code, message }
  }
  return undefined
}

/**
 * The runtime's stdout as records: line-buffered, decoded as UTF-8 by a
 * `StringDecoder` (a character split across two pipe reads survives), CRLF
 * tolerated, every non-record line ignored. A line longer than `maxLine` is
 * dropped through its newline.
 */
export class RecordReader {
  private readonly decoder = new StringDecoder('utf8')
  private readonly maxLine: number
  private buffer = ''
  private discarding = false

  constructor(maxLine = MAX_RECORD_LINE) {
    this.maxLine = maxLine
  }

  feed(chunk: Buffer): RuntimeRecord[] {
    return this.take(this.decoder.write(chunk))
  }

  /** The stream ended: the decoder's remainder and a last unterminated line. */
  end(): RuntimeRecord[] {
    const records = this.take(this.decoder.end())
    const last = this.discarding ? '' : this.buffer
    this.buffer = ''
    this.discarding = false
    const record = last.length > 0 ? parseRecord(last.replace(/\r$/, '')) : undefined
    return record === undefined ? records : [...records, record]
  }

  private take(text: string): RuntimeRecord[] {
    const records: RuntimeRecord[] = []
    let start = 0
    for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', start)) {
      const piece = text.slice(start, newline)
      start = newline + 1
      if (this.discarding) {
        this.discarding = false
        continue
      }
      const line = this.buffer + piece
      this.buffer = ''
      if (line.length > this.maxLine) continue
      const record = parseRecord(line.replace(/\r$/, ''))
      if (record !== undefined) records.push(record)
    }
    if (!this.discarding) {
      this.buffer += text.slice(start)
      if (this.buffer.length > this.maxLine) {
        this.buffer = ''
        this.discarding = true
      }
    }
    return records
  }
}

// ---- the handoff --------------------------------------------------------------

/** The launch token could not be exchanged: spent elsewhere, or the port is not this runtime's. Never retried. */
export class HandoffError extends Error {
  override readonly name = 'HandoffError'
  /**
   * The HTTP status the listener answered with, or `undefined` when nothing
   * answered (a refused connection, a timeout). Main treats both alike; the
   * packaged smoke needs the difference, because "the token is refused a
   * second time" is an ANSWER, and silence would otherwise pass for it.
   */
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export const SESSION_COOKIE = 'minidsh_session'

/** RFC 6265 cookie-octets: the value is later written into request headers verbatim. */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Exchanges the one-shot launch token for the session cookie, exactly as
 * opening the printed URL would — through Node's own `fetch`, which has no
 * cookie jar and no proxy, so the value exists only in what this returns. The
 * host answers a good token with one 303 setting one `minidsh_session` cookie
 * (`app/web.ts`); anything else means the token was spent by someone else or
 * the listener is not our child, and the caller must kill, not retry.
 *
 * Returns the `name=value` pair for a `cookie` header.
 */
export async function signIn(port: number, token: string, fetchImpl: FetchLike = fetch, timeoutMs = 10_000): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    // The URL carries the token, and a fetch error may quote its request.
    throw new HandoffError('the runtime did not answer the sign-in')
  }
  try {
    const { status } = response
    if (status !== 303) throw new HandoffError(`the sign-in was answered ${status}, not 303`, status)
    const cookies = response.headers.getSetCookie()
    if (cookies.length !== 1) throw new HandoffError(`the sign-in set ${cookies.length} cookies, not exactly one`, status)
    const pair = cookies[0]!.split(';', 1)[0]!
    const at = pair.indexOf('=')
    if (at < 0 || pair.slice(0, at).trim() !== SESSION_COOKIE) throw new HandoffError(`the sign-in set a cookie other than ${SESSION_COOKIE}`, status)
    const value = pair.slice(at + 1).trim()
    if (!COOKIE_VALUE.test(value)) throw new HandoffError('the sign-in cookie is malformed', status)
    return `${SESSION_COOKIE}=${value}`
  } finally {
    await response.body?.cancel().catch(() => undefined)
  }
}

// ---- the child ----------------------------------------------------------------

export interface RuntimeReady {
  readonly port: number
  readonly token: string
  readonly version: string
  readonly home: string
  readonly workspaces: readonly WorkspaceRecord[]
}

export type StartFailure =
  | { readonly kind: 'error-record'; readonly code: string; readonly message: string }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stderrTail: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'protocol'; readonly detail: string }
  /** The bundled node itself could not be executed: a broken install, not a runtime failure. */
  | { readonly kind: 'spawn'; readonly message: string }

function describeStartFailure(failure: StartFailure): string {
  switch (failure.kind) {
    case 'error-record':
      return `the runtime refused to start (${failure.code}): ${failure.message}`
    case 'exited':
      return `the runtime exited before it was ready (${failure.signal ?? `code ${failure.code}`})`
    case 'timeout':
      return 'the runtime was not ready in time'
    case 'protocol':
      return `the runtime broke its launch contract: ${failure.detail}`
    case 'spawn':
      return `the runtime could not be started: ${failure.message}`
  }
}

export class RuntimeStartError extends Error {
  override readonly name = 'RuntimeStartError'
  readonly failure: StartFailure
  constructor(failure: StartFailure) {
    super(describeStartFailure(failure))
    this.failure = failure
  }
}

export interface RuntimeExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** `stop()` was called first: a person asked for this exit. */
  readonly requested: boolean
}

export interface StopResult {
  /** Exit code 0 and no kill: the runtime closed every turn and flushed its logs. */
  readonly graceful: boolean
  readonly killed: boolean
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface RuntimeStartOptions extends RuntimeArgvOptions {
  /** The bundled node executable. */
  readonly node: string
  readonly env: NodeJS.ProcessEnv
  readonly startTimeoutMs?: number
  readonly spawnImpl?: SpawnLike
  /** Every stderr chunk, as it arrives (main appends it to `runtime.log`). */
  readonly onStderr?: (chunk: Buffer) => void
  /** A contract breach after `ready` (the child is killed): main shows the stopped view. */
  readonly onFault?: (detail: string) => void
  /**
   * The PROCESS's working directory, apart from `--cwd`: a folder the person
   * deleted would fail the spawn itself (ENOENT, read as a broken install),
   * so main runs the runtime from a directory of its own. Default: `cwd`.
   */
  readonly spawnCwd?: string
}

export const STDERR_TAIL_BYTES = 64 * 1024
/** An error record precedes the runtime's own exit; past this, it is killed. */
const ERROR_EXIT_GRACE_MS = 5_000
/** After `exit`, how long the stdio may take to close before the exit is classified without them. */
const STDIO_CLOSE_GRACE_MS = 2_000
/** After a kill, how long `stop()` waits for the exit before resolving anyway. */
const KILL_WAIT_MS = 5_000

const delay = (ms: number): Promise<'deadline'> => new Promise((resolve) => setTimeout(resolve, ms, 'deadline'))

/**
 * One runtime child: `start()` once, then `exited` and `stop()`.
 *
 * `start` resolves on the FIRST valid `ready` and only if it names the port
 * that was asked for on loopback; anything else is killed and rejected with a
 * typed `RuntimeStartError`. After `ready`, any further record is a breach
 * of the contract (the runtime prints one `ready` and nothing else), so the
 * child is killed and `onFault` told.
 */
export class RuntimeProcess {
  readonly exited: Promise<RuntimeExit>
  private readonly resolveExited: (exit: RuntimeExit) => void
  private started = false
  private child: ChildProcess | undefined
  private exit: RuntimeExit | undefined
  private stopping: Promise<StopResult> | undefined
  private requested = false
  private killed = false
  private readonly stderrChunks: Buffer[] = []
  private stderrBytes = 0

  constructor() {
    const { promise, resolve } = Promise.withResolvers<RuntimeExit>()
    this.exited = promise
    this.resolveExited = resolve
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  /** The last 64 KiB of stderr, decoded. */
  stderrTail(): string {
    return Buffer.concat(this.stderrChunks).subarray(-STDERR_TAIL_BYTES).toString('utf8')
  }

  start(options: RuntimeStartOptions): Promise<RuntimeReady> {
    if (this.started || this.stopping !== undefined) return Promise.reject(new Error('a RuntimeProcess starts once, and never after stop()'))
    this.started = true
    let argv: string[]
    try {
      argv = runtimeArgv(options)
    } catch (error) {
      // A programming error, not a runtime failure: nothing ran.
      this.settleExit(null, null)
      return Promise.reject(error)
    }
    let child: ChildProcess
    try {
      child = (options.spawnImpl ?? spawn)(options.node, argv, { cwd: options.spawnCwd ?? options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.settleExit(null, null)
      return Promise.reject(new RuntimeStartError({ kind: 'spawn', message: (error as NodeJS.ErrnoException).code ?? String(error) }))
    }
    this.child = child
    const { stdin, stdout, stderr } = child
    let spawnFailure: string | undefined
    let exitSeen: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let stdioTimer: ReturnType<typeof setTimeout> | undefined
    const finalize = (): void => {
      clearTimeout(stdioTimer)
      this.settleExit(exitSeen?.code ?? null, exitSeen?.signal ?? null)
    }
    // `close` follows the last stdout read, so a final error record is seen
    // before the exit is classified. A grandchild that inherited the pipe can
    // hold it open, so `exit` starts a bounded wait for it.
    child.on('exit', (code, signal) => {
      exitSeen = { code, signal }
      stdioTimer = setTimeout(finalize, STDIO_CLOSE_GRACE_MS)
    })
    child.on('close', (code, signal) => {
      exitSeen ??= { code, signal }
      finalize()
    })
    child.on('error', (error) => {
      // Also emitted for a failed kill; only a child that never got a pid failed to spawn.
      if (child.pid !== undefined) return
      spawnFailure = (error as NodeJS.ErrnoException).code ?? error.message
      finalize()
    })
    if (stdin === null || stdout === null || stderr === null) {
      this.kill()
      return Promise.reject(new RuntimeStartError({ kind: 'spawn', message: 'the child has no stdio pipes' }))
    }
    // EPIPE: the runtime may be gone before stdin is ended.
    stdin.on('error', () => undefined)
    stdout.on('error', () => undefined)
    stderr.on('error', () => undefined)
    stderr.on('data', (chunk: Buffer) => {
      this.keepStderr(chunk)
      options.onStderr?.(chunk)
    })

    return new Promise<RuntimeReady>((resolve, reject) => {
      let settled = false
      let ready = false
      let faulted = false
      const timer = setTimeout(() => fail({ kind: 'timeout' }, true), options.startTimeoutMs ?? 120_000)
      const fail = (failure: StartFailure, kill: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (kill) this.kill()
        reject(new RuntimeStartError(failure))
      }
      const onRecord = (record: RuntimeRecord): void => {
        if (ready) {
          // Exactly one ready, then silence: a second record is not our child speaking as agreed.
          if (faulted) return
          faulted = true
          this.kill()
          options.onFault?.(record.type === 'fault' ? record.detail : `an unexpected ${record.type} record after ready`)
          return
        }
        if (settled) return
        if (record.type === 'fault') return fail({ kind: 'protocol', detail: record.detail }, true)
        if (record.type === 'error') {
          fail({ kind: 'error-record', code: record.code, message: record.message }, false)
          const grace = setTimeout(() => this.kill(), ERROR_EXIT_GRACE_MS)
          void this.exited.then(() => clearTimeout(grace))
          return
        }
        if (record.port !== options.port) return fail({ kind: 'protocol', detail: `the runtime reported port ${record.port}, not the requested ${options.port}` }, true)
        if (record.host !== '127.0.0.1') return fail({ kind: 'protocol', detail: 'the runtime reported a host other than 127.0.0.1' }, true)
        ready = true
        settled = true
        clearTimeout(timer)
        resolve({ port: record.port, token: record.token, version: record.version, home: record.home, workspaces: record.workspaces })
      }
      const reader = new RecordReader()
      stdout.on('data', (chunk: Buffer) => {
        for (const record of reader.feed(chunk)) onRecord(record)
      })
      stdout.on('end', () => {
        for (const record of reader.end()) onRecord(record)
      })
      void this.exited.then((exit) => {
        if (spawnFailure !== undefined) fail({ kind: 'spawn', message: spawnFailure }, false)
        else fail({ kind: 'exited', code: exit.code, signal: exit.signal, stderrTail: this.stderrTail() }, false)
      })
    })
  }

  /**
   * Ends stdin — SYNCHRONOUSLY, before the first await, so a `session-end`
   * handler that cannot wait still starts the graceful stop — then waits for
   * the exit and kills at the deadline. The runtime's own stop is bounded
   * (cancel 5 s, dispose 20 s), so the default leaves it a margin. Idempotent.
   */
  stop({ deadlineMs = 35_000 }: { readonly deadlineMs?: number } = {}): Promise<StopResult> {
    return (this.stopping ??= (async () => {
      this.requested = true
      const child = this.child
      if (child === undefined) {
        // Never started (or never spawned): there is nothing to stop, and nothing may start now.
        this.settleExit(null, null)
        return { graceful: false, killed: false }
      }
      if (this.exit === undefined) {
        child.stdin?.end()
        if ((await Promise.race([this.exited, delay(deadlineMs)])) === 'deadline') {
          this.kill()
          await Promise.race([this.exited, delay(KILL_WAIT_MS)])
        }
      }
      return { graceful: this.exit?.code === 0 && !this.killed, killed: this.killed }
    })())
  }

  /** Immediate; the exit still arrives through `exited`. */
  kill(): void {
    if (this.child === undefined || this.exit !== undefined || this.child.pid === undefined) return
    this.killed = true
    this.child.kill('SIGKILL')
  }

  /** The exit, once: `requested` is read at that moment. */
  private settleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exit !== undefined) return
    this.exit = { code, signal, requested: this.requested }
    this.resolveExited(this.exit)
  }

  private keepStderr(chunk: Buffer): void {
    const kept = chunk.length > STDERR_TAIL_BYTES ? Buffer.from(chunk.subarray(-STDERR_TAIL_BYTES)) : chunk
    this.stderrChunks.push(kept)
    this.stderrBytes += kept.length
    while (this.stderrChunks.length > 1 && this.stderrBytes - this.stderrChunks[0]!.length >= STDERR_TAIL_BYTES) {
      this.stderrBytes -= this.stderrChunks.shift()!.length
    }
  }
}

// ---- the port -----------------------------------------------------------------

/** A port in the launcher's range, uniformly. */
export function choosePort(random: () => number = Math.random): number {
  const span = PORT_MAX - PORT_MIN
  return PORT_MIN + Math.min(span - 1, Math.max(0, Math.floor(random() * span)))
}

/**
 * Whether a loopback listen on `port` succeeds right now. A hint, not a
 * reservation — the runtime's own `EADDRINUSE`/`EACCES` record is the answer
 * — but it spares a spawn for a port some other program holds, and `EACCES`
 * covers a Windows excluded range (`netsh int ipv4 show excludedportrange`).
 */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
  })
}
