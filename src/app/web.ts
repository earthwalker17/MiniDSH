/**
 * The web host assembly: the default composition, one protocol row carried by
 * a WebSocket, and a tiny static server for the browser client. The app owns
 * the HTTP server, its routes and process exit — the capability owns only the
 * upgrade and the frames.
 *
 * THIS IS AN AUTHORITY SURFACE. A client here can write files and run shell
 * commands under the session's sandbox, so reaching it must not be an accident:
 *
 * - It binds loopback unless `--host` says otherwise, explicitly.
 * - `GET /?token=…` exchanges the one-shot launch token printed in the URL for
 *   a signed, HttpOnly, SameSite=Strict cookie, then redirects to a clean `/`
 *   so the token does not sit in history or a referrer.
 * - Every later request and the WebSocket upgrade check that cookie, plus a
 *   Host/Origin fence, so another page in the same browser cannot drive it.
 *
 * There is no per-user identity here, and none is implied: many windows, one
 * principal — whoever launched the process.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { Context } from '../kernel/index.ts'
import { protocolPlugin, upgradeWasHandled, type ProtocolConfig } from '../capabilities/protocol/index.ts'
import { defineRow, defaultAgentOptions } from './compose.ts'
import { bootComposition, type BootOptions } from './headless.ts'

export interface WebOptions extends BootOptions {
  readonly cwd: string
  readonly workspaceRoots?: readonly string[]
  readonly workspaces?: readonly { readonly id?: string; readonly name?: string; readonly root: string }[]
  /** Interface to bind (default `127.0.0.1`). Anything else is an explicit choice to be reachable. */
  readonly host?: string
  /** Port to bind; 0 asks the OS for a free one. */
  readonly port?: number
  /** The launch token; generated when absent. */
  readonly token?: string
  readonly agentWorld?: (agentCtx: Context) => void | Promise<void>
  readonly agentPreset?: string
}

export interface WebHostHandle {
  readonly root: Context
  /** The URL to open, launch token included. */
  readonly url: string
  readonly port: number
  /** Resolves when the surface is done (an authorized shutdown, or `dispose()`). */
  readonly closed: Promise<void>
  dispose(): Promise<void>
}

/** Header terminator, spelled out so no editor or tool can eat the escape. */
const CRLF = String.fromCharCode(13, 10)
const CLIENT_ROOT = join(import.meta.dirname, 'web')
const COOKIE = 'minidsh_session'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/** A signed bearer for this process alone: the secret dies with it, so no cookie outlives a restart. */
function sign(secret: Buffer, authority: string): string {
  const payload = Buffer.from(JSON.stringify({ authority, issuedAt: Date.now() })).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
}

function verify(secret: Buffer, authority: string, cookie: string | undefined): boolean {
  if (!cookie) return false
  const [payload, signature] = cookie.split('.', 2)
  if (!payload || !signature) return false
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const given = Buffer.from(signature)
  const want = Buffer.from(expected)
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false
  try {
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { authority?: string }).authority === authority
  } catch {
    return false
  }
}

function cookieOf(request: IncomingMessage): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) return rest.join('=')
  }
  return undefined
}

/**
 * The authorities this host answers to. A `Host` header is attacker-controlled,
 * so it is checked against a list built from what was actually bound — never
 * against itself, which is how a DNS-rebinding check quietly becomes a no-op.
 */
function authoritiesFor(bind: string, port: number): ReadonlySet<string> | undefined {
  // A WILDCARD bind has no authority of its own: `0.0.0.0` is never a Host
  // header any client sends, so an allow-list built from it would refuse every
  // request — the `--host` flag would be offered and broken. Undefined means
  // "any Host, but an Origin must match it", which is the strongest check that
  // is still meaningful when the host does not know its own names.
  if (bind === '0.0.0.0' || bind === '::' || bind === '') return undefined
  const loopback = bind === '127.0.0.1' || bind === '::1' || bind === 'localhost'
  const hosts = loopback ? ['127.0.0.1', 'localhost', '[::1]'] : [bind]
  return new Set(hosts.map((host) => `${host}:${port}`))
}

/**
 * The Host/Origin half of the fence. A browser sends `Origin` on an upgrade and
 * on a cross-site request; anything that is not one of this host's own
 * authorities is another page trying to drive this one, which is the whole
 * reason the check exists.
 */
function sameAuthority(request: IncomingMessage, authorities: ReadonlySet<string> | undefined): boolean {
  const host = request.headers.host
  if (host === undefined) return false
  if (authorities !== undefined && !authorities.has(host)) return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  const originAuthority = origin.replace(/^https?:\/\//, '')
  return authorities === undefined ? originAuthority === host : authorities.has(originAuthority)
}

export async function startWebHost(options: WebOptions): Promise<WebHostHandle> {
  const token = options.token ?? randomBytes(24).toString('base64url')
  const secret = randomBytes(32)
  const tokenDigest = createHash('sha256').update(token).digest()
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  // Filled once the port is known; every handler reads it, so nothing is
  // answered before the host knows what it is.
  // `new Set()` (not undefined) until the port is known: an empty allow-list
  // refuses everything, and undefined would mean the wildcard rule.
  let authorities: ReadonlySet<string> | undefined = new Set()
  const authorized = (request: IncomingMessage): boolean =>
    sameAuthority(request, authorities) && verify(secret, request.headers.host ?? '', cookieOf(request))

  // A launch token is spent by the first exchange that succeeds. The URL is
  // printed once and swapped for a cookie once; leaving it live would make a
  // shell history entry a standing full-authority credential.
  let tokenSpent = false
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const authority = request.headers.host ?? ''
    const url = new URL(request.url ?? '/', `http://${authority.length > 0 ? authority : 'localhost'}`)
    if (!sameAuthority(request, authorities)) {
      response.writeHead(403).end('forbidden')
      return
    }
    const given = url.searchParams.get('token')
    if (given !== null) {
      // One-shot exchange, then a clean URL: the token must not linger in
      // history, a referrer, or a screenshot.
      const digest = createHash('sha256').update(given).digest()
      if (tokenSpent || digest.length !== tokenDigest.length || !timingSafeEqual(digest, tokenDigest)) {
        response.writeHead(401).end(tokenSpent ? 'that link has already been used' : 'bad token')
        return
      }
      tokenSpent = true
      response.writeHead(303, {
        location: '/',
        'set-cookie': `${COOKIE}=${sign(secret, authority)}; HttpOnly; SameSite=Strict; Path=/`,
      })
      response.end()
      return
    }
    if (!verify(secret, authority, cookieOf(request))) {
      response.writeHead(401).end('open the URL this process printed')
      return
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    // No path traversal: one flat directory of assets, named exactly.
    if (!/^[\w.-]+$/.test(name) || !(extname(name) in TYPES)) {
      response.writeHead(404).end('not found')
      return
    }
    try {
      const body = readFileSync(join(CLIENT_ROOT, name))
      response.writeHead(200, { 'content-type': TYPES[extname(name)]!, 'cache-control': 'no-store' }).end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })

  const protocolConfig: ProtocolConfig = {
    cwd: options.cwd,
    workspaceRoots: options.workspaceRoots ?? [options.cwd],
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    defaultAgentOptions: options.agentDefaults ?? defaultAgentOptions(),
    ...(options.agentOverrides === undefined ? {} : { agentOverrides: options.agentOverrides }),
    onClose: () => resolveClosed(),
    carriers: [
      {
        kind: 'websocket',
        server,
        path: '/ws',
        authorize: (request) => (!sameAuthority(request, authorities) ? 403 : authorized(request) ? true : 401),
      },
    ],
    ...(options.agentWorld === undefined ? {} : { world: options.agentWorld }),
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  }
  // Same two refusals `serve` makes: this row carries live streams and a live
  // server, so a disk layer may neither replace its config nor disable it.
  for (const patch of [...(options.patches ?? []), ...(options.configLayers ?? []).flatMap((layer) => layer.patches)]) {
    if ('insert' in patch || patch.id !== 'protocol') continue
    if (patch.config !== undefined) throw new Error('the composition may not replace the config of row "protocol": it carries this surface\'s live server')
    if (patch.disabled === true) throw new Error('the composition disables row "protocol"; a web host cannot run without its surface')
  }

  const root = await bootComposition({ ...options, extraBaseRows: [...(options.extraBaseRows ?? []), defineRow('protocol', protocolPlugin, protocolConfig)] })
  // Registered LAST, after every carrier: an `upgrade` listener stops Node from
  // destroying the socket itself, so an upgrade to a path nobody serves would
  // otherwise be held open forever with no credential ever checked.
  server.on('upgrade', (_request, socket) => {
    if (upgradeWasHandled(socket)) return
    socket.end('HTTP/1.1 404 Not Found' + CRLF + 'Connection: close' + CRLF + CRLF)
  })
  const bind = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, bind, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  authorities = authoritiesFor(bind, port)
  let disposed: Promise<void> | undefined
  return {
    root,
    port,
    url: `http://${bind}:${port}/?token=${token}`,
    closed,
    dispose: () =>
      (disposed ??= (async () => {
        await root.dispose()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        resolveClosed()
      })()),
  }
}
