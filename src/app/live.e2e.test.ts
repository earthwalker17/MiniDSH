/**
 * The S2 live end-to-end: the real MiniDSH runtime, the real DeepSeek API, a
 * real workspace outside the repo, over the real wire — `minidsh serve` runs
 * as a child process and everything below speaks newline-delimited JSON-RPC to
 * its stdio, exactly as an external client would.
 *
 * Arc: task A completes → task B is killed mid-turn (SIGKILL) → a second serve
 * process resumes the stored session over the wire (crash repair + append-only
 * attach, byte-prefix asserted) and finishes the work → a fresh session's log
 * replays keylessly (the log is its own oracle). Assertions are about the
 * WORLD (file bytes, decoy untouched), never the agent's self-report.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { runTask } from './headless.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
const BIN = join(import.meta.dirname, '..', '..', 'bin', 'minidsh.js')

let dirs: string[] = []
let children: ChildProcess[] = []
afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  children = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Reply {
  result?: unknown
  error?: { code: number; message: string }
}

/** A minimal external JSON-RPC client speaking to a spawned `minidsh serve`. */
class ServeProcess {
  readonly child: ChildProcess
  readonly frames: { sessionId: string; event: EventEnvelope }[] = []
  readonly statuses: { sessionId: string; status: string }[] = []
  stderr = ''
  private nextId = 1
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private readonly exited: Promise<number | null>

  constructor(cwd: string, home: string) {
    this.child = spawn(process.execPath, [BIN, 'serve', '--cwd', cwd, '--approve'], {
      env: { ...process.env, MINIDSH_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(this.child)
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

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    const reply = new Promise<Reply>((resolve) => this.pending.set(id, resolve))
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    const settled = await reply
    if (settled.error) throw new Error(`${method} failed: ${settled.error.message}`)
    return settled.result as T
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
      () => this.events('turn/end', sessionId).find((event) => (event.data as { turn: number; reason: { kind: string } }).turn === turn),
      `turn ${turn} to end`,
    )
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
function validPrefix(file: string): Buffer {
  const bytes = readFileSync(file)
  const lastNewline = bytes.lastIndexOf(0x0a)
  return bytes.subarray(0, lastNewline + 1)
}

describe.skipIf(!KEY)('S2 live E2E: kill, resume, and replay over the real wire', () => {
  it('a session survives a hard kill and finishes its work in a second process', { timeout: 480_000 }, async () => {
    const workspace = tempDir('minidsh-e2e-ws-')
    const home = tempDir('minidsh-e2e-home-')
    const decoy = join(workspace, 'decoy.txt')
    writeFileSync(decoy, 'must never change\n', 'utf8')
    const decoyBytes = readFileSync(decoy)

    // ---- lifecycle 1: complete task A, then die mid-task-B ----------------
    const first = new ServeProcess(workspace, home)
    const init = await first.request<{ serverInfo: { name: string }; providers: { id: string }[] }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')
    expect(init.providers.some((provider) => provider.id === 'deepseek')).toBe(true)

    const { sessionId } = await first.request<{ sessionId: string }>('session/prompt', {
      text: 'Create a file named greeting.txt in the workspace containing exactly this single line: hello from minidsh',
    })
    await first.waitForCompletedTurn(sessionId, 1)
    expect(readFileSync(join(workspace, 'greeting.txt'), 'utf8').trim()).toBe('hello from minidsh')

    await first.request('session/prompt', {
      sessionId,
      text: 'Now append a second line to greeting.txt reading exactly: resumed and finished',
    })
    // Die mid-turn: as soon as turn 2 issues its first tool call.
    await first.waitFor(
      () => first.events('tool/call', sessionId).find((event) => (event.data as { turn: number }).turn === 2),
      'the first tool call of turn 2',
    )
    await first.kill()

    const sessionFile = join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`)
    const beforeResume = validPrefix(sessionFile)
    expect(beforeResume.length).toBeGreaterThan(0)

    // ---- lifecycle 2: resume over the wire, repair, finish ----------------
    const second = new ServeProcess(workspace, home)
    const resumed = await second.request<{ sessionId: string }>('session/prompt', {
      sessionId,
      text: 'The previous attempt was interrupted. Ensure greeting.txt ends with the exact second line: resumed and finished',
    })
    expect(resumed.sessionId).toBe(sessionId)
    await second.waitFor(
      () =>
        second
          .events('turn/end', sessionId)
          .find((event) => (event.data as { turn: number; reason: { kind: string } }).turn >= 3 && (event.data as { reason: { kind: string } }).reason.kind === 'completed'),
      'the resumed turn to complete',
    )

    // The WORLD: the file is finished, the decoy is untouched.
    const lines = readFileSync(join(workspace, 'greeting.txt'), 'utf8').trim().split(/\r?\n/)
    expect(lines[0]).toBe('hello from minidsh')
    expect(lines.at(-1)).toBe('resumed and finished')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)

    // The LOG: append-only attach (byte prefix), crash repair recorded.
    const afterResume = readFileSync(sessionFile)
    expect(afterResume.subarray(0, beforeResume.length).equals(beforeResume)).toBe(true)
    const storedEvents = readFileSync(sessionFile, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line) as EventEnvelope)
    const interrupted = storedEvents.filter(
      (event) => event.type === 'turn/end' && (event.data as { reason: { kind: string } }).reason.kind === 'interrupted',
    )
    expect(interrupted).toHaveLength(1)
    expect((interrupted[0]!.data as { turn: number }).turn).toBe(2)
    expect(storedEvents.some((event) => event.type === 'session/end-seed')).toBe(true)

    // The WIRE: history reads back over the protocol, seqs contiguous.
    const history = await second.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    expect(history.events.every((event, index) => event.seq === index)).toBe(true)

    // ---- lifecycle 2 continued: a fresh session for the replay oracle -----
    const fresh = await second.request<{ sessionId: string }>('session/prompt', {
      text: 'Read greeting.txt and reply with its second line, exactly, and nothing else.',
    })
    await second.waitForCompletedTurn(fresh.sessionId, 1)
    const freshLog = await second.request<{ events: EventEnvelope[] }>('session/events', { sessionId: fresh.sessionId })
    await second.shutdown()

    // ---- keyless replay: the fresh log is its own oracle ------------------
    const recordedText = lastAssistantText(freshLog.events)
    expect(recordedText).toContain('resumed and finished')
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayed = await runTask(
      {
        task: 'Read greeting.txt and reply with its second line, exactly, and nothing else.',
        cwd: workspace,
        model: 'deepseek-v4-flash',
        sessionsRoot: tempDir('minidsh-e2e-replay-'),
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events: freshLog.events })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    expect(replayed.text).toBe(recordedText)
    replayHandle!.assertConsumed()
  })
})

function lastAssistantText(events: readonly EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'assistant/message') continue
    const message = event.data as { message: { content: { type: string; text?: string }[] } }
    const text = message.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    if (text.length > 0) return text
  }
  return ''
}
