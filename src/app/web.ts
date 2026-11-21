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
 * What that fence stops is a PAGE, not a process. The cookie is host-only
 * (`Path=/`, no `Domain`), and a browser scopes a cookie by name, never by
 * port: it also sends this one to any other server on the same loopback name,
 * and that server, presenting it with a matching `Host` and no `Origin`, opens
 * the upgrade. Documented, not closed (ARCHITECTURE §13, SECURITY.md); the
 * desktop is not affected, because its cookie never enters a jar.
 *
 * There is no per-user identity here, and none is implied: many windows, one
 * principal — whoever launched the process.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, extname, join } from 'node:path'
import type { Context } from '../kernel/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import type { Agent } from '../core/agent/index.ts'
import { canonicalPath } from '../core/sandbox/paths.ts'
import { protocolPlugin, refuseUpgrade, upgradeWasHandled, type ProtocolConfig } from '../capabilities/protocol/index.ts'
import { defineRow, defaultAgentOptions } from './compose.ts'
import { VERSION } from './version.ts'
import { applyAuthority, bootComposition, type BootOptions } from './headless.ts'

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
  /** The workspaces this host serves, exactly as `initialize` names them: a supervisor's `ready` record reports these. */
  readonly workspaces: readonly WorkspaceRecord[]
  /** Resolves when the surface is done (an authorized shutdown, or `dispose()`). */
  readonly closed: Promise<void>
  dispose(): Promise<void>
  /**
   * The graceful stop: every turn running when it begins (or started while
   * it cancels: the agents are re-listed until no new one appears) ends
   * `cancelled` and is flushed FIRST, all at once, and only then does the
   * sequential disposal run — so a stop that a supervisor bounds loses no
   * turn's ending to the order the agents happen to unwind in. Each phase is bounded (`cancelBoundMs`, default
   * 5 s; `disposeBoundMs`, default 20 s); `'deadline'` says one ran out, and
   * the caller then owns what is left (the CLI exits 1). Idempotent. From the
   * call on, a client's prompt, resume or fork is refused ("the host is
   * shutting down") rather than accepted and lost.
   */
  stop(options?: { readonly cancelBoundMs?: number; readonly disposeBoundMs?: number }): Promise<'stopped' | 'deadline'>
}

export interface WorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly root: string
}

const CANCEL_BOUND_MS = 5_000
const DISPOSE_BOUND_MS = 20_000

const CLIENT_ROOT = join(import.meta.dirname, 'web')
const COOKIE = 'minidsh_session'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/**
 * The asset a request path names, or `undefined`. No path traversal: one flat
 * directory of assets, named exactly. The request target is never
 * percent-decoded and the URL parser has already folded every dot segment, so
 * nothing that reaches here can climb out of the directory today; the name
 * rule is what keeps that true should either ever change, and it refuses a
 * nested path, or a name with a trailing separator, outright. A function of
 * its own, and exported, so that rule has a test: against a flat directory
 * hardly any request can tell it from the type rule.
 */
export function assetName(pathname: string): string | undefined {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1)
  return /^[\w.-]+$/.test(name) && extname(name) in TYPES ? name : undefined
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
 * What a client sends as `Host` (and, after the scheme, as `Origin`) for one
 * bound name. A browser sends the authority as the URL standard serializes it:
 * a name in lower case, an IPv6 literal bracketed and compressed, and no port
 * at all when it is the scheme's default. A list of `${bind}:${port}` matched
 * none of those, so `--host MyBox`, `--host 2001:db8::5` and `--port 80` each
 * answered 403 to every request, the token exchange included. The standard's
 * own serializer is asked, so the list cannot drift from what a browser does;
 * a bind it cannot parse keeps its literal spelling.
 */
function hostSpellings(name: string, port: number): string[] {
  // A zone (`fe80::1%eth0`) names an interface of THIS machine, and is no part of what a client sends.
  const literal = name.includes(':') && !name.startsWith('[') ? `[${name.split('%', 1)[0]}]` : name
  const host = (URL.parse(`http://${literal}:${port}/`)?.hostname ?? literal).toLowerCase()
  // On the default port a browser leaves it out, and a client that writes it is not wrong.
  return port === 80 ? [host, `${host}:80`] : [`${host}:${port}`]
}

/**
 * The authorities this host answers to. A `Host` header is attacker-controlled,
 * so it is checked against a list built from what was actually bound — never
 * against itself, which is how a DNS-rebinding check quietly becomes a no-op.
 * Exported for its test: no test can bind port 80 or an address the machine
 * does not have.
 */
export function authoritiesFor(bind: string, port: number): ReadonlySet<string> | undefined {
  // A WILDCARD bind has no authority of its own: `0.0.0.0` is never a Host
  // header any client sends, so an allow-list built from it would refuse every
  // request — the `--host` flag would be offered and broken. Undefined means
  // "any Host, but an Origin must match it", which is the strongest check that
  // is still meaningful when the host does not know its own names.
  if (bind === '0.0.0.0' || bind === '::' || bind === '') return undefined
  const name = bind.toLowerCase()
  const loopback = name === '127.0.0.1' || name === '::1' || name === 'localhost'
  const hosts = loopback ? ['127.0.0.1', 'localhost', '::1'] : [bind]
  return new Set(hosts.flatMap((host) => hostSpellings(host, port)))
}

/**
 * The one URL this process prints, and it has to OPEN. Two binds the `--host`
 * flag accepts are not authorities a browser can use: an IPv6 literal is not a
 * URL host until it is bracketed (`http://::1:7000/` is not parseable at all),
 * and a wildcard is a bind, not an address — `http://0.0.0.0:7000/` reaches
 * nothing on Windows. A wildcard therefore prints the loopback of its own
 * family, which the wildcard rule in `authoritiesFor` already accepts.
 */
export function printableAuthority(bind: string, port: number): string {
  if (bind === '0.0.0.0' || bind === '') return `127.0.0.1:${port}`
  if (bind === '::') return `[::1]:${port}`
  return `${bind.includes(':') ? `[${bind}]` : bind}:${port}`
}

/**
 * The authority a request names, in lower case: a host name is not case
 * sensitive, every entry of the allow-list is its lower-case spelling, and the
 * cookie is bound to this same string.
 */
function hostOf(request: IncomingMessage): string | undefined {
  return request.headers.host?.toLowerCase()
}

/**
 * The Host/Origin half of the fence. A browser sends `Origin` on an upgrade and
 * on a cross-site request; anything that is not one of this host's own
 * authorities is another page trying to drive this one, which is the whole
 * reason the check exists. Exported for its test: no test can bind port 80,
 * where the allow-list holds a bare name.
 */
export function sameAuthority(request: IncomingMessage, authorities: ReadonlySet<string> | undefined): boolean {
  const host = hostOf(request)
  if (host === undefined) return false
  if (authorities !== undefined && !authorities.has(host)) return false
  const origin = request.headers.origin?.toLowerCase()
  if (origin === undefined) return true
  // A wildcard bind knows none of its names, so the Origin is held to the Host
  // it came with, whatever scheme a proxy in front terminated.
  if (authorities === undefined) return origin.replace(/^https?:\/\//, '') === host
  // A named bind speaks plain HTTP, so its own pages have an `http://` origin
  // and nothing else does. With the scheme merely stripped, on port 80 (where
  // the allow-list holds the bare name) `https://localhost` read as this host:
  // a page from whatever serves 443 on the same name.
  return origin.startsWith('http://') && authorities.has(origin.slice('http://'.length))
}

/**
 * The page may run, style and fetch only what this host serves itself, and
 * nothing it renders can become script. This surface draws text a MODEL wrote
 * and tool output an agent read off the workspace or the web — every byte of
 * it attacker-influenced — on a page that can answer approvals and run
 * commands; so script is `'self'` only (no inline, no eval), and Trusted Types
 * with no policy at all make every HTML-string sink (`innerHTML`,
 * `insertAdjacentHTML`, `document.write`) throw, so the client can build DOM
 * only from nodes and text. `img-src` admits `blob:`/`data:` for the image
 * bytes `attachment/read` returns; `frame-ancestors` is the embedding refusal
 * `x-frame-options` states for older browsers. Pinned directive by directive
 * in web.test.ts.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ')

/** `Sec-Fetch-Dest` values a browser sends when this page is being put inside another one. */
const EMBEDDING_DESTINATIONS: ReadonlySet<string> = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe'])

/**
 * The workspaces this host serves, named ONCE here and handed to the protocol
 * as declared, so what a `ready` record reports is what `initialize` answers by
 * construction rather than by a second derivation that could drift. Ids and
 * names are the protocol's own defaults (a digest of the canonical root, its
 * basename), so a host that declares nothing serves the same ids it always did.
 */
function workspaceRecords(options: WebOptions): WorkspaceRecord[] {
  const declared: NonNullable<WebOptions['workspaces']> = options.workspaces ?? (options.workspaceRoots ?? [options.cwd]).map((root) => ({ root }))
  return declared.map((workspace) => {
    const root = canonicalPath(workspace.root)
    return { id: workspace.id ?? createHash('sha256').update(root).digest('hex').slice(0, 12), name: workspace.name ?? (basename(root) || root), root }
  })
}

/** `promise`, or `'deadline'` once `ms` pass first; the timer never outlives the race. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'deadline'>((resolve) => (timer = setTimeout(() => resolve('deadline'), ms)))])
  } finally {
    clearTimeout(timer)
  }
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
  const authorized = (request: IncomingMessage): boolean => sameAuthority(request, authorities) && verify(secret, hostOf(request) ?? '', cookieOf(request))

  // A launch token is spent by the first exchange that succeeds. The URL is
  // printed once and swapped for a cookie once; leaving it live would make a
  // shell history entry a standing full-authority credential.
  let tokenSpent = false
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const authority = hostOf(request) ?? ''
    // Top-level only. The cookie and the Host/Origin fence stop another page
    // DRIVING this one, not HOLDING it: a frame navigation sends no Origin,
    // and a SameSite=Strict cookie still rides a same-site embed — and every
    // port on 127.0.0.1 is the same site, where agents serve their dev
    // servers. Consent buttons a frame can overlay are not consent (S20.5).
    response.setHeader('x-frame-options', 'DENY')
    // On EVERY response, refusals included: a 401 page is a document too.
    response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY)
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    if (!sameAuthority(request, authorities) || EMBEDDING_DESTINATIONS.has(String(request.headers['sec-fetch-dest'] ?? ''))) {
      response.writeHead(403).end('forbidden')
      return
    }
    // The request-target is attacker-controlled and Node's parser hands it over
    // verbatim: `GET http://a:b:c/ HTTP/1.1` reaches this listener, and `new
    // URL` on it throws. Thrown here it is an UNCAUGHT exception inside a
    // server callback, which ends the process and every agent it is hosting —
    // so the fence runs first and the parse is answered, never trusted.
    const url = URL.parse(request.url ?? '/', `http://${authority.length > 0 ? authority : 'localhost'}`)
    if (url === null) {
      response.writeHead(400).end('bad request')
      return
    }
    const given = url.searchParams.get('token')
    if (given !== null) {
      // One-shot exchange, then a clean URL: the token must not linger in
      // history, a referrer, or a screenshot.
      const digest = createHash('sha256').update(given).digest()
      if (tokenSpent || digest.length !== tokenDigest.length || !timingSafeEqual(digest, tokenDigest)) {
        // A browser that is ALREADY signed in and opens the printed link again
        // (a closed tab, the one URL the person was given) is where it meant
        // to be: it holds the cookie this link once bought, so it is sent to
        // the page. The spent token buys nothing here, and anyone without the
        // cookie still gets the refusal below.
        if (verify(secret, authority, cookieOf(request))) {
          response.writeHead(303, { location: '/' }).end()
          return
        }
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
    const name = assetName(url.pathname)
    if (name === undefined) {
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

  const workspaces = workspaceRecords(options)
  // Set the moment this host begins to stop, by `stop()` or by `dispose()`.
  // The sockets stay open until the protocol row unloads, which can be many
  // seconds later, and the wire must not accept in that window what the
  // disposal is about to drop (`ProtocolConfig.stopping`).
  let stopping = false
  const protocolConfig: ProtocolConfig = {
    serverVersion: VERSION,
    stopping: () => stopping,
    // An explicit authority flag is a durable switch on every session this
    // process continues, a wire resume included (ARCHITECTURE §9).
    onContinued: (agent, ctx) => applyAuthority(ctx, agent, options),
    cwd: options.cwd,
    workspaceRoots: options.workspaceRoots ?? [options.cwd],
    workspaces,
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
    // Answered before any credential is looked at, so this is the refusal
    // anyone at all can reach: it has to survive its peer (`refuseUpgrade`).
    refuseUpgrade(socket, 404, 'Not Found')
  })
  const bind = options.host ?? '127.0.0.1'
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, bind, resolve)
    })
  } catch (error) {
    // A port in use leaked the booted composition, every agent row with it (S20.5 review).
    await root.dispose()
    throw error
  }
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  authorities = authoritiesFor(bind, port)
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> =>
    (disposed ??= (async () => {
      stopping = true
      await root.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      resolveClosed()
    })())
  let stopped: Promise<'stopped' | 'deadline'> | undefined
  const stop = (bounds: { readonly cancelBoundMs?: number; readonly disposeBoundMs?: number } = {}): Promise<'stopped' | 'deadline'> =>
    (stopped ??= (async () => {
      // First, and synchronously with the call: from here the wire refuses a
      // prompt, a resume and a fork. A steer to an agent phase 1 has cancelled
      // would be recorded quiet and answered as accepted, and a session
      // created now would have its first turn ended before it said anything.
      stopping = true
      // Phase 1 is exactly the first step of every agent's own disposal
      // (`core/loop/factory.ts`), taken for all of them at once: disposal runs
      // agent by agent, so without it the last agent's turn could still be
      // running when a supervisor's deadline kills the process, and its
      // `turn/end` would be lost to a repair on the next open. Top-level only:
      // a delegated child is cancelled by its parent's call ending, which is
      // the one order its parent's log can explain.
      //
      // Re-listed until the set holds still: the wire's door is closed, but an
      // agent can still appear while phase 1 waits (a creation the wire
      // admitted just before the stop, or one anything else in the composition
      // makes), and its turn is owed the same first closer. Bounded together.
      const cancelled = new Set<Agent>()
      const topLevel = (): Agent[] =>
        (disposed === undefined ? (root.tryGet(AGENTS)?.list() ?? []) : []).filter((agent) => agent.session.header.delegatedBy === undefined && agent.session.header.delegatedByCallId === undefined)
      const cancelAll = async (): Promise<void> => {
        for (;;) {
          const fresh = topLevel().filter((agent) => !cancelled.has(agent))
          if (fresh.length === 0) return
          for (const agent of fresh) {
            cancelled.add(agent)
            agent.cancel({ kind: 'disposed' })
          }
          await Promise.allSettled(fresh.map((agent) => agent.whenIdle()))
        }
      }
      const idle = await within(
        cancelAll().then(() => 'idle' as const),
        bounds.cancelBoundMs ?? CANCEL_BOUND_MS,
      )
      const done = await within(dispose(), bounds.disposeBoundMs ?? DISPOSE_BOUND_MS)
      return idle === 'deadline' || done === 'deadline' ? 'deadline' : 'stopped'
    })())
  return {
    root,
    port,
    url: `http://${printableAuthority(bind, port)}/?token=${token}`,
    workspaces,
    closed,
    dispose,
    stop,
  }
}
