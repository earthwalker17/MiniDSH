/**
 * An external browser-shaped client for a spawned `minidsh web`: the launch
 * token exchanged for a cookie over real HTTP, then JSON-RPC over a real
 * WebSocket using the client Node ships — which is the same client a browser
 * is. No shared objects with the host, and nothing in this file the browser
 * client does not also do.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { EventEnvelope } from '../core/session/index.ts'

export const WEB_BIN = join(import.meta.dirname, '..', '..', 'bin', 'minidsh.js')

const spawned: ChildProcess[] = []

export function killSpawnedWebHosts(): void {
  for (const child of spawned) if (child.exitCode === null) child.kill('SIGKILL')
  spawned.length = 0
}

export interface WebHostOptions {
  readonly approve?: boolean
  readonly sandbox?: string
  readonly args?: readonly string[]
}

/**
 * The child's environment, minus what would let this machine's ambient settings
 * choose an arc's route. `MINIDSH_MODEL` outranks settings.json (settings.ts),
 * and the composition arc asserts the model its OWN settings.json named — so a
 * developer who exported one would fail that arc for a reason it does not test.
 * The unit tests isolate the same precedence by passing `env: {}` explicitly.
 */
function childEnv(home: string): NodeJS.ProcessEnv {
  const { MINIDSH_MODEL: _ambient, ...rest } = process.env
  return { ...rest, MINIDSH_HOME: home }
}

/** The spawned host: its URL, its cookie, and the sockets opened against it. */
export class WebHostProcess {
  readonly child: ChildProcess
  stdout = ''
  stderr = ''
  private urlPromise: Promise<string>
  private session: Promise<{ origin: string; cookie: string }> | undefined

  constructor(cwd: string, home: string, options: WebHostOptions = {}) {
    const argv = [WEB_BIN, 'web', '--cwd', cwd, '--port', '0']
    if (options.approve) argv.push('--approve')
    if (options.sandbox) argv.push('--sandbox', options.sandbox)
    if (options.args) argv.push(...options.args)
    this.child = spawn(process.execPath, argv, { env: childEnv(home), stdio: ['pipe', 'pipe', 'pipe'] })
    spawned.push(this.child)
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr += String(chunk)
    })
    this.urlPromise = new Promise((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        this.stdout += String(chunk)
        const match = /(http:\/\/\S+\?token=\S+)/.exec(this.stdout)
        if (match) resolve(match[1]!)
      }
      this.child.stdout!.on('data', onData)
      this.child.on('exit', () => reject(new Error(`the web host exited before printing a url\nstderr: ${this.stderr}`)))
    })
  }

  url(): Promise<string> {
    return this.urlPromise
  }

  /**
   * The token-for-cookie exchange, exactly as opening the printed URL does —
   * ONCE. The launch token is spent by the first exchange, so every later
   * connection reuses the cookie, which is what a browser does too.
   */
  signIn(): Promise<{ origin: string; cookie: string }> {
    return (this.session ??= (async () => {
      const url = new URL(await this.url())
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status !== 303) throw new Error(`the launch url answered ${response.status}`)
      const cookie = response.headers.getSetCookie()[0]!.split(';', 1)[0]!
      return { origin: url.origin, cookie }
    })())
  }

  async connect(): Promise<WebClient> {
    const { origin, cookie } = await this.signIn()
    return WebClient.open(`${origin.replace('http', 'ws')}/ws`, cookie)
  }

  kill(): void {
    this.child.kill('SIGKILL')
  }
}

/** One connected client, with the dedup and gap rules the browser client uses. */
export class WebClient {
  readonly socket: WebSocket
  readonly frames: { sessionId: string; event: EventEnvelope }[] = []
  readonly views: { sessionId: string; view: Record<string, unknown> }[] = []
  readonly statuses: { sessionId: string; status: string }[] = []
  private nextId = 1
  private readonly pending = new Map<number, (frame: Record<string, unknown>) => void>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      if (frame.method === 'session.event') this.frames.push(frame.params as never)
      else if (frame.method === 'session.view') this.views.push(frame.params as never)
      else if (frame.method === 'session.status') this.statuses.push(frame.params as never)
      else if (typeof frame.id === 'number') {
        this.pending.get(frame.id)?.(frame)
        this.pending.delete(frame.id)
      }
    })
  }

  static async open(url: string, cookie: string): Promise<WebClient> {
    const socket = new WebSocket(url, { headers: { cookie } } as never)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error(`the upgrade to ${url} was refused`)), { once: true })
    })
    return new WebClient(socket)
  }

  /**
   * One request, and it is bounded — the same deadline `ServeProcess.request`
   * carries and for the same reason. `waitFor` below has one and this did not,
   * so the one shape that CAN wait forever (a reply that never comes, or a
   * socket that closes with a request pending) was the one shape that said
   * nothing about where: the arc hung to vitest's own 600 s file timeout, which
   * names the whole test and nothing inside it.
   */
  async request<T>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.nextId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Record<string, unknown>>((resolve) => this.pending.set(id, resolve))
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} did not answer in ${timeoutMs} ms\n${this.describeStall()}`)), timeoutMs)
    })
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    try {
      const frame = await Promise.race([reply, deadline])
      if (frame.error) throw new Error(`${method} failed: ${(frame.error as { message: string }).message}`)
      return frame.result as T
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  events(type: string, sessionId?: string): EventEnvelope[] {
    return this.frames.filter((frame) => frame.event.type === type && (sessionId === undefined || frame.sessionId === sessionId)).map((frame) => frame.event)
  }

  /** What this client had seen when a wait ran out — an unanswered consent is the usual reason a turn never ends. */
  private describeStall(): string {
    const decided = new Set(this.events('approval/decided').map((event) => (event.data as { id: string }).id))
    const open = this.events('approval/asked')
      .map((event) => event.data as { id: string; toolName: string })
      .filter((ask) => !decided.has(ask.id))
      .map((ask) => ask.toolName)
    const calls = this.frames.filter((frame) => frame.event.type === 'tool/call').map((frame) => (frame.event.data as { name: string }).name)
    return [
      `open approvals: ${open.length === 0 ? 'none' : open.join(', ')}`,
      `tool calls: ${calls.length === 0 ? 'none' : calls.join(', ')}`,
      `last frames: ${this.frames.slice(-8).map((frame) => frame.event.type).join(' -> ')}`,
      `last status: ${this.statuses.at(-1)?.status ?? 'none'}`,
    ].join('\n')
  }

  async waitFor<T>(pick: () => T | undefined, what: string, timeoutMs = 240_000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const value = pick()
      if (value !== undefined) return value
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`the socket closed while waiting for ${what}\n${this.describeStall()}`)
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}\n${this.describeStall()}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  waitForCompletedTurn(sessionId: string, turn: number): Promise<EventEnvelope> {
    return this.waitFor(() => this.events('turn/end', sessionId).find((event) => (event.data as { turn: number }).turn === turn), `turn ${turn} to end`)
  }

  /** Answers every approval frame as it arrives, as a person at the page would. */
  answerApprovals(outcome: 'allowed-once' | 'rejected'): () => void {
    const answered = new Set<string>()
    const timer = setInterval(() => {
      for (const frame of this.frames) {
        if (frame.event.type !== 'approval/asked') continue
        const id = (frame.event.data as { id: string }).id
        if (answered.has(`${frame.sessionId}:${id}`)) continue
        answered.add(`${frame.sessionId}:${id}`)
        void this.request('approval/answer', { sessionId: frame.sessionId, id, outcome }).catch(() => undefined)
      }
    }, 50)
    return () => clearInterval(timer)
  }

  close(): void {
    this.socket.close()
  }
}
