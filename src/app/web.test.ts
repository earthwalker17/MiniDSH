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
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { connect as tcpConnect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { LLM } from '../core/llm/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { assistantText, gate, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { WebClient } from '../test-support/web-process.ts'
import { assetName, authoritiesFor, printableAuthority, sameAuthority, startWebHost, type WebHostHandle } from './web.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

let dirs: string[] = []
let hosts: WebHostHandle[] = []
let sockets: WebSocket[] = []
let rawSockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close()
  sockets = []
  for (const socket of rawSockets) socket.destroy()
  rawSockets = []
  for (const host of hosts.toReversed()) await host.dispose()
  hosts = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

/**
 * Runs `body` with this process's uncaught exceptions collected instead of
 * handed to the test runner, so "nothing was thrown at the process" fails as
 * an assertion that prints what was thrown.
 */
async function collectingUncaught(body: () => Promise<void>): Promise<string[]> {
  const uncaught: string[] = []
  const collect = (error: unknown): void => void uncaught.push(String(error))
  const others = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  process.on('uncaughtException', collect)
  try {
    await body()
  } finally {
    process.off('uncaughtException', collect)
    for (const listener of others) process.on('uncaughtException', listener)
  }
  return uncaught
}

/** Whether this machine has an IPv6 loopback to bind at all: asked of a bare server, so the answer says nothing about the web host. */
async function hasIpv6Loopback(): Promise<boolean> {
  const probe = createTcpServer()
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '::1', resolve)
    })
    return true
  } catch {
    return false
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  }
}

/** One request on a socket, answered with the WHOLE reply: `WebClient.request` keeps an error's message and drops its code. */
function rawCall(socket: WebSocket, id: number, method: string, params: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      const frame = JSON.parse(String(event.data)) as { id?: unknown; result?: unknown; error?: { code: number; message: string } }
      if (frame.id !== id) return
      socket.removeEventListener('message', onMessage)
      resolve(frame)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

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

/** The Host/Origin rule asked directly, for a bind no test can make (port 80): each Origin beside the Host `localhost`. */
const sameOrigins = (bind: string, port: number, origins: readonly string[]): boolean[] =>
  origins.map((origin) => sameAuthority({ headers: { host: 'localhost', origin } } as IncomingMessage, authoritiesFor(bind, port)))

/**
 * A raw request, so headers `fetch` refuses to forge (Host, Origin) can be set
 * — and so a request-TARGET can be sent verbatim: `fetch` normalizes `/../x`
 * away before it leaves the client, which would make a traversal case a test
 * of the client rather than of the server.
 */
function status(port: number, headers: Record<string, string>, path = '/', connectTo = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: connectTo, port, path, method: 'GET', headers }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * The status an upgrade is answered with: 101 when the socket opens. Raw for
 * the reason `status` is: a WebSocket client chooses its own `Origin`, and the
 * Origin is the header under test.
 */
function upgradeStatus(port: number, headers: Record<string, string>, path = '/ws'): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers },
    })
    request.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    request.on('response', (response) => {
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

  // The one URL a person was given. Closing the tab and clicking it again
  // used to answer "that link has already been used" to the very browser that
  // had used it, with nothing to say the plain address still worked.
  it('sends a browser that is already signed in to the page when it opens the printed link again', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    for (const link of [`${origin}/?token=${token}`, `${origin}/?token=mistyped`]) {
      const again = await fetch(link, { headers: { cookie }, redirect: 'manual' })
      expect(again.status, link).toBe(303)
      expect(again.headers.get('location'), link).toBe('/')
      // It is a way back in, not a second exchange: nothing new is minted.
      expect(again.headers.getSetCookie(), link).toEqual([])
    }
    // The spent link buys nothing for anyone who does not already hold the cookie.
    expect((await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })).status).toBe(401)
    const forged = `${cookie.slice(0, -4)}AAAA`
    expect((await fetch(`${origin}/?token=${token}`, { headers: { cookie: forged }, redirect: 'manual' })).status).toBe(401)
    // Nor does it get round the fence, which runs first.
    expect(await status(host.port, { cookie, origin: 'http://evil.example' }, `/?token=${token}`)).toBe(403)
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
    // Its own authority under ANOTHER scheme is another origin: this host
    // speaks plain HTTP. With the scheme merely stripped, on port 80 (where
    // the list holds the bare name) `https://localhost` read as this host.
    expect(await status(host.port, { cookie, origin: `https://127.0.0.1:${host.port}` })).toBe(403)
    expect(sameOrigins('127.0.0.1', 80, ['http://localhost', 'https://localhost', 'https://localhost:80', 'http://localhost:80'])).toEqual([true, false, false, true])
  })

  // A SameSite=Strict cookie rides a WebSocket handshake from any other port
  // of this machine (one site), where an agent's dev server may be serving a
  // page. On the upgrade the Origin is therefore the whole defence against
  // such a page, and no test sent one: a cookie-only check passed them all.
  it('refuses a signed-in upgrade from another origin, and takes the same upgrade from its own', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    const own = `http://127.0.0.1:${host.port}`
    const answers = {
      'another port of this machine': await upgradeStatus(host.port, { cookie, origin: 'http://127.0.0.1:1' }),
      'another name for this machine': await upgradeStatus(host.port, { cookie, origin: `http://attacker.example:${host.port}` }),
      'a forged Host': await upgradeStatus(host.port, { cookie, origin: own, host: 'evil.example' }),
      'its own origin, signed in': await upgradeStatus(host.port, { cookie, origin: own }),
      'its own origin, not signed in': await upgradeStatus(host.port, { origin: own }),
    }
    expect(answers).toEqual({
      'another port of this machine': 403,
      'another name for this machine': 403,
      'a forged Host': 403,
      'its own origin, signed in': 101,
      'its own origin, not signed in': 401,
    })
  })

  // A host name is not case sensitive, and a client that is not a browser may
  // send it as the person typed it.
  it('reads the Host it is sent without regard to case', async () => {
    const { host, token } = await web()
    // The exchange itself, under a name spelled the way a person might type it.
    const minted = await new Promise<string>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: host.port, path: `/?token=${token}`, headers: { host: `LocalHost:${host.port}` } }, (response) => {
        response.resume()
        resolve(`${response.statusCode} ${String(response.headers['set-cookie']?.[0]).split(';', 1)[0]}`)
      })
      request.on('error', reject)
      request.end()
    })
    expect(minted).toMatch(/^303 minidsh_session=/)
    const cookie = minted.slice('303 '.length)
    expect(await status(host.port, { cookie, host: `LOCALHOST:${host.port}` })).toBe(200)
    expect(await status(host.port, { cookie, host: `localhost:${host.port}` })).toBe(200)
    // The cookie is still bound to the one name it was minted under: another
    // of this host's names passes the fence (not 403) and is not signed in.
    expect(await status(host.port, { cookie, host: `127.0.0.1:${host.port}` })).toBe(401)
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
    // The same spellings aimed at a type this host DOES serve, where the type
    // rule cannot be what answers. An encoded separator is never decoded, so
    // it names no file; a real dot segment is folded by the URL parser before
    // any name is read, so it can only ever name the flat asset itself.
    for (const path of ['/..%2fweb%2fapp.js', '/%2e%2e%2fapp.js', '/..%5capp.js', '/web/app.js', '/app.js/']) {
      expect(await status(host.port, { cookie }, path), `${path} was served`).toBe(404)
    }
    for (const path of ['/x/../app.js', '/../app.js', '/%2e%2e/app.js']) {
      expect(await status(host.port, { cookie }, path), `${path} did not fold to the flat asset`).toBe(200)
    }
  })

  // The name rule by itself. Against the shipped flat directory hardly any
  // request can tell it from the type rule, since nothing nested exists to be
  // served: of the cases above only the trailing separator does, and only
  // where the filesystem forgives one (Windows). Here it has to answer alone.
  it('names an asset only by a flat name of a served type', () => {
    expect(['/', '/app.js', '/style.css', '/index.html', '/markdown.js'].map(assetName)).toEqual(['index.html', 'app.js', 'style.css', 'index.html', 'markdown.js'])
    const refused = ['/nested/app.js', '/a/../app.js', '/../app.js', '/..%2fapp.js', '/app.js/', '/C:/app.js', '/conver~1.js', '/a b.js', '/app.js?x', '/app.ts', '/package.json', '/.js', '/app']
    expect(
      refused.filter((pathname) => assetName(pathname) !== undefined),
      'paths that were given a name to read',
    ).toEqual([])
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

  // Anyone at all can reach this refusal: it is answered before a Host, an
  // Origin or a cookie is looked at. Node hands an upgraded socket over with
  // no `error` listener, so a peer that reset the connection there threw an
  // uncaught exception: one unauthenticated packet ended the process and
  // every turn it was running.
  it('survives a peer that resets an upgrade to a path nobody serves', async () => {
    const { host } = await web()
    const uncaught = await collectingUncaught(async () => {
      const socket = tcpConnect({ port: host.port, host: '127.0.0.1' })
      rawSockets.push(socket)
      socket.on('error', () => {})
      const answer = new Promise<string>((resolve) =>
        socket.once('data', (chunk: Buffer) => {
          socket.resetAndDestroy()
          resolve(chunk.toString('latin1'))
        }),
      )
      socket.write(['GET /nothing-here HTTP/1.1', 'Host: anything.example', 'Connection: Upgrade', 'Upgrade: websocket', '', ''].join('\r\n'))
      expect(await answer).toMatch(/^HTTP\/1\.1 404 /)
      // Whole requests made after the reset: the host has met it by the time
      // it answers them, and it is still there to answer.
      for (let round = 0; round < 3; round++) expect(await status(host.port, {})).toBe(401)
    })
    expect(uncaught, 'errors nobody was listening for').toEqual([])
  })

  // `end()` closes only the host's half. A peer that kept its own open held
  // the refused socket for as long as it liked, and the server's close() waits
  // for every socket it holds: a stop sat out its whole bound on a stranger.
  it('lets go of a refused upgrade whose peer keeps its half open, so a stop is not kept waiting on it', async () => {
    const { host } = await web()
    const socket = tcpConnect({ port: host.port, host: '127.0.0.1', allowHalfOpen: true })
    rawSockets.push(socket)
    socket.on('error', () => {})
    const answer = new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1'))))
    socket.write(['GET /nothing-here HTTP/1.1', 'Host: anything.example', 'Connection: Upgrade', 'Upgrade: websocket', '', ''].join('\r\n'))
    expect(await answer).toMatch(/^HTTP\/1\.1 404 /)
    let bound: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        host.dispose().then(() => 'disposed'),
        new Promise<string>((resolve) => (bound = setTimeout(() => resolve('still waiting on the socket it refused'), 5_000))),
      ])
      expect(outcome).toBe('disposed')
      expect(socket.destroyed, 'this peer must still be holding its half for the test to mean anything').toBe(false)
    } finally {
      clearTimeout(bound)
      // Whatever happened, the hook's own dispose must not inherit the wait.
      socket.destroy()
    }
  })

  it('prints an IPv6 bind as a URL, since an unbracketed one is not a URL at all', async (ctx) => {
    // `--host ::1` printed `http://::1:PORT/?token=…`, which `new URL` refuses:
    // the flag was offered and the link it handed back could not be opened.
    // Whether this machine HAS an IPv6 loopback is asked first and by itself:
    // a skip decided by catching the call under test also caught the very
    // failure this test is named for, and reported it as "no IPv6 here".
    if (!(await hasIpv6Loopback())) {
      ctx.skip('this host has no IPv6 loopback to bind')
      return
    }
    const opened = await web({ host: '::1' })
    expect(new URL(opened.host.url).host).toBe(`[::1]:${opened.host.port}`)
    // And the fence accepts that spelling: `authoritiesFor` lists `[::1]:port`
    // for a loopback bind, so the printed URL is one a browser can actually use.
    const cookie = await signIn(`http://[::1]:${opened.host.port}`, opened.token)
    expect(cookie).toContain('minidsh')
  })

  // `--host` takes a name as the person typed it; a browser sends it in lower
  // case. The allow-list held the typed spelling, so the printed link, and
  // every request after it, answered 403.
  it('answers the link it prints for a host name given with capitals', async () => {
    const { host } = await web({ host: 'LOCALHOST' })
    const printed = new URL(host.url)
    expect(printed.host).toBe(`localhost:${host.port}`)
    // What a browser does with that link: the Host it sends is the URL's own.
    expect(await status(host.port, { host: printed.host }, `${printed.pathname}${printed.search}`, 'localhost'), 'the token exchange on the printed link').toBe(303)
    expect(await status(host.port, { host: printed.host }, '/', 'localhost'), 'a later request with no cookie').toBe(401)
    // Still a fence: a name that is not this host's is refused as ever.
    expect(await status(host.port, { host: `elsewhere.example:${host.port}` }, '/', 'localhost')).toBe(403)
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

/**
 * The binds no test can make: port 80, and an address this machine does not
 * have. What a browser sends as `Host` for a URL is that URL's own host as the
 * URL standard serializes it, so the oracle is the standard's parser applied
 * to the link this process prints, never this host's own idea of a spelling.
 */
describe('the authorities a bind answers to', () => {
  it.each([
    ['127.0.0.1', 7000],
    ['127.0.0.1', 80],
    ['::1', 7000],
    ['localhost', 80],
    ['LOCALHOST', 7000],
    ['MyBox', 7000],
    ['MyBox.Example', 80],
    ['192.168.1.20', 80],
    ['2001:db8::5', 7000],
    ['2001:DB8:0:0:0:0:0:5', 7000],
    ['2001:db8::5', 80],
  ])('--host %s --port %i answers the link it prints', (bind, port) => {
    const printed = new URL(`http://${printableAuthority(bind, port)}/?token=t`)
    const authorities = [...(authoritiesFor(bind, port) ?? [])]
    expect(authorities, `the Host a browser sends for ${printed.href}`).toContain(printed.host)
    // And the Origin it sends from that page, on the upgrade and on any request that carries one.
    expect(authorities, `the Origin a browser sends from ${printed.href}`).toContain(printed.origin.replace(/^http:\/\//, ''))
  })

  it('lists its own names and nothing else, in the spelling a client sends', () => {
    const listed = (bind: string, port: number): string[] => [...(authoritiesFor(bind, port) ?? ['(any Host)'])].toSorted()
    expect(listed('MyBox', 7000)).toEqual(['mybox:7000'])
    expect(listed('2001:DB8:0:0:0:0:0:5', 7000)).toEqual(['[2001:db8::5]:7000'])
    // A zone names an interface of this machine; no client sends one.
    expect(listed('fe80::1%eth0', 7000)).toEqual(['[fe80::1]:7000'])
    // The default port, with and without: a browser leaves it out, and a client that writes it is not wrong.
    expect(listed('mybox', 80)).toEqual(['mybox', 'mybox:80'])
    // A loopback bind, however it was spelled, answers to all three loopback names.
    for (const loopback of ['127.0.0.1', '::1', 'localhost', 'LocalHost']) expect(listed(loopback, 7000), loopback).toEqual(['127.0.0.1:7000', '[::1]:7000', 'localhost:7000'])
    // A wildcard has no name of its own: the Origin rule stands in (the wildcard test above).
    for (const wildcard of ['0.0.0.0', '::', '']) expect(authoritiesFor(wildcard, 7000), wildcard).toBeUndefined()
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

  // Disposal is newest first (`kernel/context.ts`), so the newest agent's hung
  // disposer holds every older one's ending: sessions born WHILE phase 1 waits
  // are only ended if phase 1 lists the agents again. The wire refuses to make
  // one once the stop has begun (the next test), so these two are made the way
  // anything else in the composition would make them: through the registry.
  it('re-lists while it cancels: sessions born during phase 1 end cancelled, even behind a hung disposal', async () => {
    const sessionsRoot = tempDir('minidsh-web-sessions-')
    let release!: () => void
    const hung = new Promise<void>((resolve) => (release = resolve))
    // Filled once started; the first turn reads it later, from the abort.
    const running: { host?: WebHostHandle } = {}
    let firstStreaming!: () => void
    const firstStarted = new Promise<void>((resolve) => (firstStreaming = resolve))
    const streaming: (() => void)[] = []
    const started = [0, 1].map(() => new Promise<void>((resolve) => streaming.push(resolve)))
    const midStop: Promise<{ sessionId: string }>[] = []
    /** A top-level session with a turn of its own, born now; `last` gives it a disposer that never finishes. */
    const bear = async (text: string, last: boolean): Promise<{ sessionId: string }> => {
      const root = running.host!.root
      const handle = await root.get(AGENTS).create(root, {
        cwd: tempDir('minidsh-web-born-'),
        agentOptions: SCRIPTED,
        // Only the newest agent's disposer hangs: disposed first, it holds the rest.
        ...(last ? { world: (agentCtx) => void agentCtx.effect(() => () => hung, 'a disposer that never finishes') } : {}),
      })
      handle.agent.followup(createUserMessage(text))
      return { sessionId: handle.agent.id }
    }
    const holdUntilAbort = (request: { signal?: AbortSignal }) => [gate(new Promise((resolve) => request.signal?.addEventListener('abort', resolve, { once: true }))), ...assistantText('never reached')]
    const adapter = new ScriptedAdapter().script(
      // The first turn, once the stop cancels it, goes idle only after two
      // more sessions are streaming: both are born inside phase 1.
      (request) => {
        firstStreaming()
        return [
          gate(
            new Promise<void>((resolve) =>
              request.signal?.addEventListener(
                'abort',
                () => {
                  void (async () => {
                    for (const [index, text] of ['born mid-stop', 'born mid-stop, last'].entries()) {
                      midStop.push(bear(text, index === 1))
                      await started[index]
                    }
                    resolve()
                  })()
                },
                { once: true },
              ),
            ),
          ),
          ...assistantText('never reached'),
        ]
      },
      (request) => {
        streaming[0]!()
        return holdUntilAbort(request)
      },
      (request) => {
        streaming[1]!()
        return holdUntilAbort(request)
      },
    )
    const host = await startWebHost({
      cwd: tempDir('minidsh-web-cwd-'),
      sessionsRoot,
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root) => {
        root.get(LLM).registerAdapter(root, adapter)
      },
    })
    running.host = host
    hosts.push(host)
    const cookie = await signIn(`http://127.0.0.1:${host.port}`, new URL(host.url).searchParams.get('token')!)
    const client = await WebClient.open(`ws://127.0.0.1:${host.port}/ws`, cookie)
    sockets.push(client.socket)
    const first = await client.request<{ sessionId: string }>('session/prompt', { text: 'hold on', agentOptions: SCRIPTED })
    await firstStarted

    try {
      expect(await host.stop({ cancelBoundMs: 10_000, disposeBoundMs: 500 })).toBe('deadline')
      const sessions = [first, ...(await Promise.all(midStop))]
      expect(sessions).toHaveLength(3)
      for (const { sessionId } of sessions) {
        const ends = storedEvents(sessionsRoot, sessionId).filter((event) => event.type === 'turn/end')
        expect(ends.map((event) => (event.data as { reason: { kind: string } }).reason.kind), `the turn ends ${sessionId} recorded`).toEqual(['cancelled'])
      }
    } finally {
      // Also when an assertion failed: the hook's dispose would otherwise wait on the disposer this test hung.
      release()
    }
    await host.dispose()
    await host.closed
  })

  // The sockets stay open until the surface unloads, seconds after the stop
  // began. A message sent in that window used to be answered as accepted: a
  // steer to an agent the stop had cancelled is recorded quiet and wakes
  // nothing, and a new session's first turn was ended before it said a word.
  it('refuses a prompt once the stop has begun, so nothing is accepted that the stop then drops', async () => {
    const sessionsRoot = tempDir('minidsh-web-sessions-')
    const wire: { client?: WebClient; sessionId?: string } = {}
    let streaming!: () => void
    const started = new Promise<void>((resolve) => (streaming = resolve))
    const during: Record<string, { result?: unknown; error?: { code: number; message: string } }> = {}
    // The turn the stop cancels does not unwind until the wire has answered
    // everything sent during the stop: its agent is disposing and still
    // `running`, which is exactly when `auto` used to resolve to a steer.
    const adapter = new ScriptedAdapter().script((request) => {
      streaming()
      return [
        gate(
          new Promise<void>((resolve) =>
            request.signal?.addEventListener(
              'abort',
              () => {
                void (async () => {
                  const socket = wire.client!.socket
                  const sessionId = wire.sessionId!
                  const sent = {
                    'a message to the running session (auto)': rawCall(socket, 900_001, 'session/prompt', { sessionId, text: 'sent during the stop, auto', mode: 'auto' }),
                    'a steer to the running session': rawCall(socket, 900_002, 'session/prompt', { sessionId, text: 'sent during the stop, steer', mode: 'steer' }),
                    'a follow-up to the running session': rawCall(socket, 900_003, 'session/prompt', { sessionId, text: 'sent during the stop, followup' }),
                    'a new session': rawCall(socket, 900_004, 'session/prompt', { text: 'born during the stop', agentOptions: SCRIPTED }),
                    'a resume': rawCall(socket, 900_005, 'session/resume', { sessionId }),
                    'a fork': rawCall(socket, 900_006, 'session/fork', { sessionId }),
                  }
                  for (const [what, reply] of Object.entries(sent)) during[what] = await reply
                  resolve()
                })()
              },
              { once: true },
            ),
          ),
        ),
        ...assistantText('never reached'),
      ]
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
    wire.client = client
    sockets.push(client.socket)
    const { sessionId } = await client.request<{ sessionId: string }>('session/prompt', { text: 'hold on', agentOptions: SCRIPTED })
    wire.sessionId = sessionId
    await started

    expect(await host.stop({ cancelBoundMs: 10_000, disposeBoundMs: 10_000 })).toBe('stopped')

    // Each was answered, and each as a refusal a client can act on.
    const answered = Object.fromEntries(Object.entries(during).map(([what, reply]) => [what, reply.error === undefined ? `accepted: ${JSON.stringify(reply.result)}` : `${reply.error.code} ${reply.error.message}`]))
    const refusal = '-32603 the host is shutting down'
    expect(answered).toEqual({
      'a message to the running session (auto)': refusal,
      'a steer to the running session': refusal,
      'a follow-up to the running session': refusal,
      'a new session': refusal,
      'a resume': refusal,
      'a fork': refusal,
    })
    // And nothing of them reached the store: no second session, and in the
    // one there is, no message recorded for a later lifecycle to find.
    expect(readdirSync(sessionsRoot).filter((name) => name.endsWith('.jsonl'))).toEqual([`${encodeURIComponent(sessionId)}.jsonl`])
    const stored = storedEvents(sessionsRoot, sessionId)
    expect(
      stored.filter((event) => JSON.stringify(event.data).includes('sent during the stop')).map((event) => event.type),
      'events that recorded a message sent during the stop',
    ).toEqual([])
    expect(stored.filter((event) => event.type === 'turn/end').map((event) => (event.data as { reason: { kind: string } }).reason.kind)).toEqual(['cancelled'])
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
