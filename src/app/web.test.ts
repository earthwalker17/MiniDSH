/**
 * The web surface end to end over real HTTP and a real socket: the trust fence,
 * the static client, and a full attach/prompt/stream cycle driven the way the
 * browser client drives it.
 *
 * The fence is the point. This surface can write files and run commands, so the
 * cases that matter are the ones where someone reaches it WITHOUT the token, or
 * from another page.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
import { assistantText, gate, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { WebClient } from '../test-support/web-process.ts'
import { startWebHost, type WebHostHandle } from './web.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

let dirs: string[] = []
let hosts: WebHostHandle[] = []
let sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close()
  sockets = []
  for (const host of hosts.toReversed()) await host.dispose()
  hosts = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function web(options: { host?: string } = {}): Promise<{ host: WebHostHandle; origin: string; token: string }> {
  const adapter = new ScriptedAdapter().script(assistantText('hello from a browser'))
  const host = await startWebHost({
    cwd: tempDir('minidsh-web-cwd-'),
    sessionsRoot: tempDir('minidsh-web-sessions-'),
    logger: silent,
    patches: [{ id: 'llm-deepseek', disabled: true }],
    ...(options.host === undefined ? {} : { host: options.host }),
    prepare: (root) => {
      root.get(LLM).registerAdapter(root, adapter)
    },
  })
  hosts.push(host)
  return { host, origin: `http://127.0.0.1:${host.port}`, token: new URL(host.url).searchParams.get('token')! }
}

// The S20.5 review: a port already in use left the booted composition, every
// agent row with it, running in a process whose web host never started.
describe('a web host that cannot listen', () => {
  it('disposes what it booted, and says why', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = (blocker.address() as AddressInfo).port
    let disposed = false
    try {
      await expect(
        startWebHost({
          cwd: tempDir('minidsh-web-cwd-'),
          sessionsRoot: tempDir('minidsh-web-sessions-'),
          logger: silent,
          port,
          patches: [{ id: 'llm-deepseek', disabled: true }],
          prepare: (root) => {
            root.effect(() => () => {
              disposed = true
            }, 'listen-probe')
          },
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(disposed).toBe(true)
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })
})

/**
 * A raw request, so headers `fetch` refuses to forge (Host, Origin) can be set
 * — and so a request-TARGET can be sent verbatim: `fetch` normalizes `/../x`
 * away before it leaves the client, which would make a traversal case a test
 * of the client rather than of the server.
 */
function status(port: number, headers: Record<string, string>, path = '/'): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

/** The token-for-cookie exchange every browser does on the printed URL. */
async function signIn(origin: string, token: string): Promise<string> {
  const response = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
  expect(response.status).toBe(303)
  const cookie = response.headers.getSetCookie()[0]!
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  return cookie.split(';', 1)[0]!
}

describe('the web surface trust fence', () => {
  it('serves nothing without the cookie, and mints one only for the printed token — once', async () => {
    const { origin, token } = await web()
    expect((await fetch(`${origin}/`)).status).toBe(401)
    expect((await fetch(`${origin}/?token=wrong`, { redirect: 'manual' })).status).toBe(401)

    const cookie = await signIn(origin, token)
    // Spent. A URL in a shell history must not stay a full-authority
    // credential for the life of the process.
    const replayed = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
    expect(replayed.status).toBe(401)
    expect(await replayed.text()).toContain('already been used')
    // The cookie it minted still works.
    const page = await fetch(`${origin}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('MiniDSH')
    expect((await fetch(`${origin}/app.js`, { headers: { cookie } })).status).toBe(200)
  })

  it('refuses a forged Host or a foreign Origin, before it looks at any credential', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    // `fetch` will not forge Host or Origin, so this speaks HTTP directly —
    // which is exactly what an attacker would do.
    expect(await status(host.port, { cookie, host: 'evil.example' })).toBe(403)
    expect(await status(host.port, { cookie, origin: 'http://evil.example' })).toBe(403)
    // The same request with this host's own authority still works.
    expect(await status(host.port, { cookie, origin: `http://127.0.0.1:${host.port}` })).toBe(200)
  })

  // The S20.5 audit: a same-site page (any port on 127.0.0.1, where agents
  // serve their dev servers) could load the signed-in UI — consent buttons
  // and all — in a frame: a top-level frame navigation sends no Origin, and a
  // SameSite=Strict cookie still rides a same-site embed.
  it('renders only as a top-level document: no frame may hold it', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    const page = await fetch(`${origin}/`, { headers: { cookie } })
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    for (const dest of ['iframe', 'frame', 'embed', 'object']) {
      expect(await status(host.port, { cookie, 'sec-fetch-dest': dest }), dest).toBe(403)
    }
    expect(await status(host.port, { cookie, 'sec-fetch-dest': 'document' })).toBe(200)
  })

  /**
   * The page renders model- and tool-written text on an authority surface, so
   * its policy admits only this host's own script, style and sockets, and no
   * HTML-string sink at all (`trusted-types 'none'`). Parsed directive by
   * directive, from what the server SENDS — on the page, on an asset, and on a
   * refusal — so a dropped or widened directive fails by name.
   */
  it('sends a strict content security policy on every response', async () => {
    const { origin, token } = await web()
    const expected: Record<string, string> = {
      'default-src': "'self'",
      'script-src': "'self'",
      'style-src': "'self'",
      'img-src': "'self' blob: data:",
      'connect-src': "'self'",
      'font-src': "'self'",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-ancestors': "'none'",
      'require-trusted-types-for': "'script'",
      'trusted-types': "'none'",
    }
    const unauthenticated = await fetch(`${origin}/`)
    const cookie = await signIn(origin, token)
    for (const response of [unauthenticated, await fetch(`${origin}/`, { headers: { cookie } }), await fetch(`${origin}/app.js`, { headers: { cookie } })]) {
      const header = response.headers.get('content-security-policy')
      expect(header, `no policy on ${response.url} (${response.status})`).not.toBeNull()
      const directives = new Map(
        header!
          .split(';')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map((part) => {
            const [name, ...values] = part.split(/\s+/)
            return [name!, values.join(' ')] as const
          }),
      )
      for (const [name, value] of Object.entries(expected)) expect(directives.get(name), `${name} on ${response.url}`).toBe(value)
      // Nothing beyond the list: an added source is a widening, and widening is a decision.
      expect([...directives.keys()].toSorted()).toEqual(Object.keys(expected).toSorted())
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('serves no path but its own flat assets', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    for (const path of ['/nested/app.js', '/app.ts']) {
      expect((await fetch(`${origin}${path}`, { headers: { cookie } })).status).toBe(404)
    }
    // The traversal spellings go through the RAW helper: `fetch` normalizes
    // `/../x` to `/x` before it leaves the client, so sending them that way
    // proved "unknown asset", not "traversal refused" — the server has to be
    // the thing that says no.
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
      expect(await status(host.port, { cookie }, path), `${path} was not refused`).toBe(404)
    }
  })

  it('answers a request-target it cannot parse, instead of dying on it', async () => {
    // Node's parser hands an absolute-form target over verbatim, and `new URL`
    // throws on `http://a:b:c/`. Thrown inside the server callback that was an
    // UNCAUGHT exception: one unauthenticated line of TCP ended the process and
    // every agent it hosted. The refusal has to be an answer, and the host has
    // to still be there afterwards — which is what the second request proves.
    const { host, origin, token } = await web()
    expect(await status(host.port, {}, 'http://a:b:c/')).toBe(400)
    const cookie = await signIn(origin, token)
    expect(await status(host.port, { cookie })).toBe(200)
  })

  it('closes an upgrade to a path nobody serves, instead of holding the socket open', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    // Registering an `upgrade` listener stops Node from destroying unclaimed
    // sockets itself, so an unhandled path would otherwise stay open forever
    // with no credential ever checked.
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/nothing-here`, { headers: { cookie } } as never)
    sockets.push(socket)
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => resolve('opened'), { once: true })
      socket.addEventListener('error', () => resolve('closed'), { once: true })
      socket.addEventListener('close', () => resolve('closed'), { once: true })
      setTimeout(() => resolve('left hanging'), 3000)
    })
    expect(outcome).toBe('closed')
  })

  it('prints an IPv6 bind as a URL, since an unbracketed one is not a URL at all', async (ctx) => {
    // `--host ::1` printed `http://::1:PORT/?token=…`, which `new URL` refuses:
    // the flag was offered and the link it handed back could not be opened.
    let opened: Awaited<ReturnType<typeof web>>
    try {
      opened = await web({ host: '::1' })
    } catch {
      ctx.skip('this host has no IPv6 loopback to bind')
      return
    }
    expect(new URL(opened.host.url).host).toBe(`[::1]:${opened.host.port}`)
    // And the fence accepts that spelling: `authoritiesFor` lists `[::1]:port`
    // for a loopback bind, so the printed URL is one a browser can actually use.
    const cookie = await signIn(`http://[::1]:${opened.host.port}`, opened.token)
    expect(cookie).toContain('minidsh')
  })

  it('answers a wildcard bind, where an allow-list built from the bind address never could', async () => {
    // `--host 0.0.0.0` is offered by the CLI. `0.0.0.0` is never a Host header
    // any client sends, so a list built from it would 403 every request and the
    // flag would be broken; the fence falls back to "an Origin must match the
    // Host it was sent to", which is the strongest check still meaningful when
    // the host does not know its own names.
    const { host, origin, token } = await web({ host: '0.0.0.0' })
    // The one URL this process prints has to OPEN. A wildcard is a bind, not
    // an address: `http://0.0.0.0:PORT/` reaches nothing on Windows, so the
    // printed authority is the loopback the wildcard rule already accepts.
    expect(new URL(host.url).host).toBe(`127.0.0.1:${host.port}`)
    const cookie = await signIn(origin, token)
    expect(await status(host.port, { cookie })).toBe(200)
    // A foreign Origin is still refused before any credential is looked at.
    expect(await status(host.port, { cookie, origin: 'http://evil.example' })).toBe(403)
    // And a different Host is refused by the cookie, which is bound to the
    // authority it was minted for — so the fallback loosens the Host CHECK
    // without loosening what the credential is good for.
    expect(await status(host.port, { cookie, host: 'anything.example' })).toBe(401)
    expect(await status(host.port, {})).toBe(401)
  })

  it('refuses the upgrade to a client that never signed in', async () => {
    const { host } = await web()
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/ws`)
    sockets.push(socket)
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => resolve('opened'), { once: true })
      socket.addEventListener('error', () => resolve('refused'), { once: true })
      socket.addEventListener('close', () => resolve('closed'), { once: true })
    })
    expect(outcome).not.toBe('opened')
  })
})

/** The stored events of one session, header line skipped. */
function storedEvents(sessionsRoot: string, sessionId: string): { type: string; data: unknown }[] {
  return readFileSync(join(sessionsRoot, `${encodeURIComponent(sessionId)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as { type: string; data: unknown })
}

describe('the graceful stop (WebHostHandle.stop)', () => {
  it('ends a running turn cancelled and flushed, then disposes and releases its lease', async () => {
    const sessionsRoot = tempDir('minidsh-web-sessions-')
    let streaming!: () => void
    const started = new Promise<void>((resolve) => (streaming = resolve))
    // A stream held open until the turn is cancelled: the stop, not a model, ends it.
    const adapter = new ScriptedAdapter().script((request) => {
      streaming()
      return [gate(new Promise((resolve) => request.signal?.addEventListener('abort', resolve, { once: true }))), ...assistantText('never reached')]
    })
    const host = await startWebHost({
      cwd: tempDir('minidsh-web-cwd-'),
      sessionsRoot,
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root) => {
        root.get(LLM).registerAdapter(root, adapter)
      },
    })
    hosts.push(host)
    const cookie = await signIn(`http://127.0.0.1:${host.port}`, new URL(host.url).searchParams.get('token')!)
    const client = await WebClient.open(`ws://127.0.0.1:${host.port}/ws`, cookie)
    sockets.push(client.socket)
    const init = await client.request<{ workspaces: unknown[] }>('initialize')
    // What a supervisor's `ready` record reports is what the wire answers.
    expect(init.workspaces).toEqual(host.workspaces)
    const { sessionId } = await client.request<{ sessionId: string }>('session/prompt', { text: 'hold on', agentOptions: SCRIPTED })
    await started
    const lock = join(sessionsRoot, `${encodeURIComponent(sessionId)}.jsonl.lock`)
    expect(existsSync(lock), 'the running session holds its lease').toBe(true)

    const stopping = host.stop({ cancelBoundMs: 5_000, disposeBoundMs: 10_000 })
    expect(host.stop(), 'the stop is one stop').toBe(stopping)
    expect(await stopping).toBe('stopped')

    const ends = storedEvents(sessionsRoot, sessionId).filter((event) => event.type === 'turn/end')
    expect(ends.map((event) => (event.data as { reason: { kind: string } }).reason.kind), 'the turn ends recorded').toEqual(['cancelled'])
    expect(readdirSync(sessionsRoot).filter((name) => name.endsWith('.lock')), 'locks left behind').toEqual([])
    await host.closed
  })

  // Why the cancel is a phase of its own: disposal runs agent by agent, so an
  // agent whose unwind hangs held every later agent's turn open behind it, and
  // a supervisor's deadline kill then lost those turns' endings.
  it('answers "deadline" within its bound when a disposal hangs — with every turn already ended', async () => {
    const sessionsRoot = tempDir('minidsh-web-sessions-')
    let release!: () => void
    const hung = new Promise<void>((resolve) => (release = resolve))
    let streams = 0
    const held = (request: { signal?: AbortSignal }) => {
      streams += 1
      return [gate(new Promise((resolve) => request.signal?.addEventListener('abort', resolve, { once: true }))), ...assistantText('never reached')]
    }
    const adapter = new ScriptedAdapter().script(held, held)
    const host = await startWebHost({
      cwd: tempDir('minidsh-web-cwd-'),
      sessionsRoot,
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root) => {
        root.get(LLM).registerAdapter(root, adapter)
      },
      // Every agent's scope gets a disposer that never finishes.
      agentWorld: (agentCtx) => {
        agentCtx.effect(() => () => hung, 'a disposer that never finishes')
      },
    })
    hosts.push(host)
    const cookie = await signIn(`http://127.0.0.1:${host.port}`, new URL(host.url).searchParams.get('token')!)
    const client = await WebClient.open(`ws://127.0.0.1:${host.port}/ws`, cookie)
    sockets.push(client.socket)
    const first = await client.request<{ sessionId: string }>('session/prompt', { text: 'hold one', agentOptions: SCRIPTED })
    const second = await client.request<{ sessionId: string }>('session/prompt', { text: 'hold two', agentOptions: SCRIPTED })
    await client.waitFor(() => (streams === 2 ? true : undefined), 'both turns to be streaming', 10_000)

    const began = Date.now()
    const outcome = await host.stop({ cancelBoundMs: 2_000, disposeBoundMs: 500 })
    const took = Date.now() - began
    expect(outcome).toBe('deadline')
    expect(took, `the stop took ${took} ms against a 500 ms disposal bound`).toBeGreaterThanOrEqual(450)
    expect(took, `the stop took ${took} ms against a 500 ms disposal bound`).toBeLessThan(5_000)
    for (const { sessionId } of [first, second]) {
      const ends = storedEvents(sessionsRoot, sessionId).filter((event) => event.type === 'turn/end')
      expect(ends.map((event) => (event.data as { reason: { kind: string } }).reason.kind), `the turn ends ${sessionId} recorded`).toEqual(['cancelled'])
    }
    // Released, the disposal the deadline gave up on still finishes.
    release()
    await host.dispose()
    await host.closed
  })
})

describe('the web surface, driven as a browser drives it', () => {
  it('attaches, prompts, streams, and reads its own durable log back', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/ws`, { headers: { cookie } } as never)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('the upgrade was refused')), { once: true })
    })

    const notifications: { method: string; params: Record<string, unknown> }[] = []
    const pending = new Map<number, (frame: Record<string, unknown>) => void>()
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      if (typeof frame.method === 'string') notifications.push(frame as never)
      else {
        pending.get(frame.id as number)?.(frame)
        pending.delete(frame.id as number)
      }
    })
    const call = async <T>(method: string, params?: unknown): Promise<T> => {
      const id = nextId++
      const reply = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
      const frame = await reply
      if (frame.error) throw new Error((frame.error as { message: string }).message)
      return frame.result as T
    }

    const init = await call<{ serverInfo: { name: string }; workspaces: { id: string }[] }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')
    expect(init.workspaces).toHaveLength(1)

    const { sessionId } = await call<{ sessionId: string }>('session/prompt', {
      text: 'check the socket end to end',
      agentOptions: SCRIPTED,
      workspaceId: init.workspaces[0]!.id,
    })
    const deadline = Date.now() + 5000
    while (!notifications.some((one) => one.method === 'session.event' && (one.params.event as { type: string }).type === 'turn/end')) {
      if (Date.now() > deadline) throw new Error('the turn never ended')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // The text streamed as chunks AND landed durably.
    expect(notifications.some((one) => (one.params.event as { type: string } | undefined)?.type === 'assistant/chunk')).toBe(true)
    // `turn/end` is appended before the turn's last checkpoint, which is a real
    // sync since S16 (milliseconds under WSL), so idle follows it, not with it.
    let attached = await call<{ page: { events: { type: string }[] }; view: { status: string } }>('session/attach', { sessionId })
    while (attached.view.status !== 'idle' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      attached = await call('session/attach', { sessionId })
    }
    expect(attached.page.events.some((event) => event.type === 'assistant/message')).toBe(true)
    expect(attached.view.status).toBe('idle')

    const listed = await call<{ sessions: { id: string; live: boolean }[] }>('sessions/list')
    expect(listed.sessions.map((one) => one.id)).toContain(sessionId)
  })
})
