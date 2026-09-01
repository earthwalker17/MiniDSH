/**
 * A minimal external JSON-RPC client speaking to a spawned `minidsh serve` —
 * the same thing any out-of-process client is: a pipe, ndjson frames, and no
 * shared objects with the host. Used by the live end-to-end tests.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { EventEnvelope } from '../core/session/index.ts'

export const SERVE_BIN = join(import.meta.dirname, '..', '..', 'bin', 'minidsh.js')

const spawned: ChildProcess[] = []

/** Kills any serve child still running (call from `afterAll`). */
export function killSpawnedServes(): void {
  for (const child of spawned) if (child.exitCode === null) child.kill('SIGKILL')
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
}

export class ServeProcess {
  readonly child: ChildProcess
  readonly frames: { sessionId: string; event: EventEnvelope }[] = []
  readonly statuses: { sessionId: string; status: string }[] = []
  stderr = ''
  private nextId = 1
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private readonly exited: Promise<number | null>

  constructor(cwd: string, home: string, options: ServeOptions = {}) {
    const argv = [SERVE_BIN, 'serve', '--cwd', cwd]
    if (options.approve) argv.push('--approve')
    if (options.sandbox) argv.push('--sandbox', options.sandbox)
    if (options.args) argv.push(...options.args)
    this.child = spawn(process.execPath, argv, { env: { ...process.env, MINIDSH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    spawned.push(this.child)
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)))
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr += String(chunk)
    })
    const reader = createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    reader.on('line', (line) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (frame.method === 'session.event') this.frames.push(frame.params as { sessionId: string; event: EventEnvelope })
      else if (frame.method === 'session.status') this.statuses.push(frame.params as { sessionId: string; status: string })
      else if (typeof frame.id === 'number') {
        this.pending.get(frame.id)?.(frame as Reply)
        this.pending.delete(frame.id)
      }
    })
  }

  /**
   * One request, and it is bounded. A reply that never came used to hang the
   * arc until vitest's own 600 s timeout, which names the whole test and
   * nothing inside it: `waitFor` had a deadline and this did not, so the one
   * shape that CAN wait forever was the one shape that said nothing about
   * where. The deadline is generous (a `session/prompt` that creates a session
   * boots a whole composition, and `shutdown` disposes every live agent) and
   * its only job is to turn a silent hang into a named method plus the host's
   * own stderr.
   */
  async request<T>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.nextId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Reply>((resolve) => this.pending.set(id, resolve))
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

  async waitFor<T>(pick: () => T | undefined, what: string, timeoutMs = 180_000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const value = pick()
      if (value !== undefined) return value
      if (this.child.exitCode !== null) throw new Error(`serve exited while waiting for ${what}\nstderr: ${this.stderr}`)
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}\nstderr: ${this.stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  waitForCompletedTurn(sessionId: string, turn: number): Promise<EventEnvelope> {
    return this.waitFor(
      () => this.events('turn/end', sessionId).find((event) => (event.data as { turn: number }).turn === turn),
      `turn ${turn} to end`,
    )
  }

  /** Answers every approval frame as it arrives, the way a person at a terminal would. Returns a stop function. */
  answerApprovals(outcome: 'allowed-once' | 'rejected'): () => void {
    const answered = new Set<string>()
    const timer = setInterval(() => {
      for (const frame of this.frames) {
        if (frame.event.type !== 'approval/asked') continue
        const id = (frame.event.data as { id: string }).id
        const key = `${frame.sessionId}:${id}`
        if (answered.has(key)) continue
        answered.add(key)
        void this.request('approval/answer', { sessionId: frame.sessionId, id, outcome }).catch(() => undefined)
      }
    }, 50)
    return () => clearInterval(timer)
  }

  kill(): Promise<number | null> {
    this.child.kill('SIGKILL')
    return this.exited
  }

  async shutdown(): Promise<void> {
    await this.request('shutdown')
    this.child.stdin!.end()
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000))
    await Promise.race([this.exited, timeout])
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
  }
}

/** The bytes of the valid line prefix (through the last newline). */
export function validPrefix(file: string): Buffer {
  const bytes = readFileSync(file)
  const lastNewline = bytes.lastIndexOf(0x0a)
  return bytes.subarray(0, lastNewline + 1)
}
