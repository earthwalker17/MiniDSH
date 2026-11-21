/**
 * A minimal external JSON-RPC client speaking to a spawned `minidsh serve` —
 * the same thing any out-of-process client is: a pipe, ndjson frames, and no
 * shared objects with the host. Used by the live end-to-end tests.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { EventEnvelope } from '../core/session/index.ts'

export const SERVE_BIN = join(import.meta.dirname, '..', '..', 'bin', 'minidsh.js')

const spawned: ChildProcess[] = []

/**
 * How a child ended, or `undefined` while it runs. BOTH fields: on Linux and
 * macOS a child killed by a signal (the OOM killer, a SIGSEGV) has `exitCode`
 * null and `signalCode` set, and a check of the exit code alone read it as
 * alive — a wait then sat out its whole deadline and said "timed out".
 */
export function endOf(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): string | undefined {
  if (child.signalCode !== null) return `signal ${child.signalCode}`
  if (child.exitCode !== null) return `code ${child.exitCode}`
  return undefined
}

/** Kills any serve child still running (call from `afterAll`). */
export function killSpawnedServes(): void {
  for (const child of spawned) if (endOf(child) === undefined) child.kill('SIGKILL')
  spawned.length = 0
}

interface Reply {
  result?: unknown
  error?: { code: number; message: string }
}

export interface ServeOptions {
  /** Grant every approval without asking a client (the S2 arc); omit to answer over the wire. */
  readonly approve?: boolean
  readonly sandbox?: string
  /** Extra argv for the spawned host (e.g. `--patch`). */
  readonly args?: readonly string[]
  /**
   * Variables the host must NOT inherit: an arc that proves a key reaches its
   * row through the home's `credentials.json` (the search arc) removes it from
   * the environment, or the store path would never be exercised.
   */
  readonly withoutEnv?: readonly string[]
}

/**
 * The child's environment, minus what would let this machine's ambient settings
 * choose an arc's route. `MINIDSH_MODEL` outranks settings.json (settings.ts),
 * and the composition arc asserts the model its OWN settings.json named — so a
 * developer who exported one would fail that arc for a reason it does not test.
 * The unit tests isolate the same precedence by passing `env: {}` explicitly.
 */
function childEnv(home: string, without: readonly string[] = []): NodeJS.ProcessEnv {
  const { MINIDSH_MODEL: _ambient, ...rest } = process.env
  for (const name of without) delete rest[name]
  return { ...rest, MINIDSH_HOME: home }
}

/** How a spawned host ended. */
export interface ServeExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export class ServeProcess {
  readonly child: ChildProcess
  readonly frames: { sessionId: string; event: EventEnvelope }[] = []
  readonly statuses: { sessionId: string; status: string }[] = []
  stderr = ''
  /**
   * Every stdout line that was not a JSON frame. `serve` promises that stdout
   * carries only frames, and a client that dropped the rest could not know the
   * promise was broken: one line here fails the next wait and `shutdown()`.
   */
  readonly garbage: string[] = []
  /**
   * Every `approval/answer` the host refused. A refused answer leaves its ask
   * open: the turn parks on it until a wait runs out with nothing to say why,
   * or until the call's own deadline ends the ask and the arc goes on as if
   * somebody had answered (measured: the turn then ENDS, a minute later). The
   * refusal is the why; it fails the next wait, and `shutdown()` if none met it.
   */
  readonly refusedAnswers: string[] = []
  private nextId = 1
  private readonly pending = new Map<number, { readonly method: string; readonly settle: (reply: Reply) => void; readonly fail: (error: Error) => void }>()
  private readonly exited: Promise<ServeExit>

  constructor(cwd: string, home: string, options: ServeOptions = {}) {
    const argv = [SERVE_BIN, 'serve', '--cwd', cwd]
    if (options.approve) argv.push('--approve')
    if (options.sandbox) argv.push('--sandbox', options.sandbox)
    if (options.args) argv.push(...options.args)
    this.child = spawn(process.execPath, argv, { env: childEnv(home, options.withoutEnv), stdio: ['pipe', 'pipe', 'pipe'] })
    spawned.push(this.child)
    const reader = createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    const read = new Promise<void>((resolve) => reader.once('close', resolve))
    // Its exit, and then what it wrote before leaving: `exit` can fire with
    // the last stdout lines still unread. The wait for them is bounded because
    // a grandchild that inherited the pipe keeps it open after the host is gone.
    this.exited = new Promise((resolve) =>
      this.child.once('exit', (code, signal) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        void Promise.race([read, new Promise<void>((late) => (timer = setTimeout(late, 2_000)))]).then(() => {
          clearTimeout(timer)
          // A request the host will never answer fails now, naming how the
          // host ended, instead of sitting out its own deadline.
          for (const [id, waiting] of this.pending) {
            this.pending.delete(id)
            waiting.fail(new Error(`serve exited (${endOf(this.child) ?? `code ${code}`}) before it answered ${waiting.method}\nstderr: ${this.stderr}`))
          }
          resolve({ code, signal })
        })
      }),
    )
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr += String(chunk)
    })
    // A write to a host that has gone raises EPIPE on this stream, and with no
    // listener that is an uncaught exception in the test process. The request
    // that wrote it is failed above, by the exit, which says how the host ended.
    this.child.stdin!.on('error', () => undefined)
    reader.on('line', (line) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.garbage.push(line)
        return
      }
      if (frame.method === 'session.event') this.frames.push(frame.params as { sessionId: string; event: EventEnvelope })
      else if (frame.method === 'session.status') this.statuses.push(frame.params as { sessionId: string; status: string })
      else if (typeof frame.id === 'number') {
        this.pending.get(frame.id)?.settle(frame as Reply)
        this.pending.delete(frame.id)
      }
    })
  }

  /** What the host did that a client must not swallow, or `undefined` when there is nothing. */
  private misbehaviour(): string | undefined {
    const seen: string[] = []
    if (this.garbage.length > 0) {
      seen.push(`serve wrote ${this.garbage.length} stdout line(s) that are not JSON frames: ${this.garbage.slice(0, 5).map((line) => JSON.stringify(line.slice(0, 200))).join(', ')}`)
    }
    if (this.refusedAnswers.length > 0) seen.push(`serve refused ${this.refusedAnswers.length} approval answer(s): ${this.refusedAnswers.join('; ')}`)
    return seen.length === 0 ? undefined : seen.join('\n')
  }

  /**
   * One request, and it is bounded. A reply that never came used to hang the
   * arc until vitest's own 600 s timeout, which names the whole test and
   * nothing inside it: `waitFor` had a deadline and this did not, so the one
   * shape that CAN wait forever was the one shape that said nothing about
   * where. The deadline is generous (a `session/prompt` that creates a session
   * boots a whole composition, and `shutdown` disposes every live agent) and
   * its only job is to turn a silent hang into a named method plus the host's
   * own stderr. A host that is gone, or goes while the request waits, fails it
   * at once: nothing will answer, and the deadline would only say so later.
   */
  async request<T>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    const ended = endOf(this.child)
    if (ended !== undefined) throw new Error(`${method} was sent to a serve that had exited (${ended})\nstderr: ${this.stderr}`)
    const id = this.nextId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Reply>((resolve, reject) => this.pending.set(id, { method, settle: resolve, fail: reject }))
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} did not answer in ${timeoutMs} ms\nstderr: ${this.stderr}`)), timeoutMs)
    })
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    try {
      const settled = await Promise.race([reply, deadline])
      if (settled.error) throw new Error(`${method} failed: ${settled.error.message}`)
      return settled.result as T
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  events(type: string, sessionId?: string): EventEnvelope[] {
    return this.frames.filter((frame) => frame.event.type === type && (sessionId === undefined || frame.sessionId === sessionId)).map((frame) => frame.event)
  }

  /**
   * What the session was doing when a wait ran out. A turn that never ends is
   * almost always parked on a consent nothing is going to answer — an arc whose
   * `answerApprovals` starts later, or a model that reached for a tool the arc
   * did not expect it to need — and "timed out waiting for turn 1 to end" says
   * none of that. The open asks and the tail of the stream do.
   */
  private describeStall(): string {
    const decided = new Set(this.events('approval/decided').map((event) => (event.data as { id: string }).id))
    const open = this.events('approval/asked')
      .map((event) => event.data as { id: string; toolName: string; reason?: string })
      .filter((ask) => !decided.has(ask.id))
      .map((ask) => `${ask.toolName}${ask.reason === undefined ? '' : ` (${ask.reason})`}`)
    const calls = this.frames.filter((frame) => frame.event.type === 'tool/call').map((frame) => (frame.event.data as { name: string }).name)
    return [
      `open approvals: ${open.length === 0 ? 'none' : open.join(', ')}`,
      `tool calls: ${calls.length === 0 ? 'none' : calls.join(', ')}`,
      `last frames: ${this.frames.slice(-8).map((frame) => frame.event.type).join(' -> ')}`,
      `last status: ${this.statuses.at(-1)?.status ?? 'none'}`,
    ].join('\n')
  }

  async waitFor<T>(pick: () => T | undefined, what: string, timeoutMs = 180_000): Promise<T> {
    const start = Date.now()
    for (;;) {
      // Before the pick: a wait that would succeed is still a wait on a host
      // that broke its stream or left an ask open, and the test that met that
      // is the one that fails for it.
      const broke = this.misbehaviour()
      if (broke !== undefined) throw new Error(`${broke}\nwhile waiting for ${what}\n${this.describeStall()}\nstderr: ${this.stderr}`)
      const value = pick()
      if (value !== undefined) return value
      const ended = endOf(this.child)
      if (ended !== undefined) throw new Error(`serve exited (${ended}) while waiting for ${what}\n${this.describeStall()}\nstderr: ${this.stderr}`)
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}\n${this.describeStall()}\nstderr: ${this.stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  waitForCompletedTurn(sessionId: string, turn: number): Promise<EventEnvelope> {
    return this.waitFor(
      () => this.events('turn/end', sessionId).find((event) => (event.data as { turn: number }).turn === turn),
      `turn ${turn} to end`,
    )
  }

  /**
   * Answers every approval frame as it arrives, the way a person at a terminal
   * would. Returns a stop function.
   *
   * With `offer`, it also takes the scope the HOST offered on that approval —
   * the `a` key. The host refuses an offer it did not make, so passing one is
   * a request, not an assertion, and the arc checks the consequence.
   */
  answerApprovals(outcome: 'allowed-once' | 'rejected', offer?: 'grant-session'): () => void {
    const answered = new Set<string>()
    const timer = setInterval(() => {
      for (const frame of this.frames) {
        if (frame.event.type !== 'approval/asked') continue
        const id = (frame.event.data as { id: string }).id
        const key = `${frame.sessionId}:${id}`
        if (answered.has(key)) continue
        answered.add(key)
        const params = { sessionId: frame.sessionId, id, outcome, ...(offer === undefined ? {} : { offer }) }
        this.request('approval/answer', params).catch((error: unknown) => {
          // A host that is gone answers nothing, and the wait that meets its
          // exit says so; what is kept here is an answer the host REFUSED.
          if (endOf(this.child) === undefined) this.refusedAnswers.push(`${id} (${outcome}${offer === undefined ? '' : ` + ${offer}`}): ${error instanceof Error ? error.message.split('\n', 1)[0] : String(error)}`)
        })
      }
    }, 50)
    return () => clearInterval(timer)
  }

  async kill(): Promise<number | null> {
    this.child.kill('SIGKILL')
    return (await this.exited).code
  }

  /**
   * The graceful end, and the host's account of itself. `serve` has no exit of
   * its own: it leaves when nothing holds its event loop, so one stray handle
   * after disposal hangs it for ever. Each of these used to pass in silence
   * (the hang behind a SIGKILL after 15 s) and each is a failure here, with
   * what was seen: a host that does not exit, an exit that is not code 0, a
   * stdout line that is not a frame, an approval answer the host refused.
   */
  async shutdown(exitMs = 15_000): Promise<ServeExit> {
    await this.request('shutdown')
    this.child.stdin!.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), exitMs)))
    const exit = await Promise.race([this.exited, late])
    clearTimeout(timer)
    if (exit === undefined) {
      // Killed so that it does not outlive the test, and reported: the kill is not the exit.
      this.child.kill('SIGKILL')
      await this.exited
      throw new Error(`serve did not exit within ${exitMs} ms of answering shutdown and the end of its stdin (something still held its event loop; it was killed)\nstderr: ${this.stderr}`)
    }
    if (exit.code !== 0) throw new Error(`serve exited with ${endOf(this.child) ?? `code ${exit.code}`} after shutdown, not code 0\nstderr: ${this.stderr}`)
    const broke = this.misbehaviour()
    if (broke !== undefined) throw new Error(`${broke}\nstderr: ${this.stderr}`)
    return exit
  }
}

/**
 * `minidsh sessions <verify|inspect|show> <id> [...]` in a SEPARATE process
 * over `home`'s store: a reader that is not the runtime that wrote the log,
 * which is the whole claim of a cold read. `json` parses stdout when it is one
 * JSON document.
 */
export function coldRead(home: string, argv: readonly string[]): { code: number | null; out: string; err: string; json?: unknown } {
  const result = spawnSync(process.execPath, [SERVE_BIN, 'sessions', ...argv], { env: childEnv(home), encoding: 'utf8', timeout: 60_000 })
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    // Not a JSON document (a human report): the caller reads `out`.
  }
  return { code: result.status, out: result.stdout, err: result.stderr, ...(json === undefined ? {} : { json }) }
}

/** The bytes of the valid line prefix (through the last newline). */
export function validPrefix(file: string): Buffer {
  const bytes = readFileSync(file)
  const lastNewline = bytes.lastIndexOf(0x0a)
  return bytes.subarray(0, lastNewline + 1)
}
