/**
 * The network fence: what this browser may reach, enforced INSIDE Chrome.
 *
 * A page loaded from loopback can still fetch the internet, so refusing a typed
 * URL bounds nothing by itself. The fence is set at launch, in the browser's
 * own network stack, where every request — a navigation, a subresource, a
 * redirect, a WebSocket, page JavaScript — passes:
 *
 *   - `--proxy-server` names a LISTENER THIS PROCESS OWNS (`127.0.0.1:0`),
 *     which answers every request and every `CONNECT` with a marked 403. Not a
 *     dead port: any process can bind a port nobody holds, the model's own dev
 *     server included, and it would then BE the proxy. Owning the port closes
 *     that, and makes every blocked host countable.
 *   - `--proxy-bypass-list` starts with `<-loopback>`, which removes Chrome's
 *     IMPLICIT bypass rules — they cover link-local (`169.254/16`, `fe80::/10`,
 *     a cloud's metadata endpoint) as well as loopback — and then names
 *     loopback explicitly, then the operator's `allowHosts`. Measured on
 *     Chrome 155 and Edge 155 (Windows) and Chrome 155 (Linux), 2026-10-18:
 *     public, link-local and private addresses reach this listener; `127/8`,
 *     `*.localhost` and `[::1]` reach their servers.
 *   - WebRTC's UDP does not use the proxy, so the profile is seeded with
 *     `webrtc.ip_handling_policy = disable_non_proxied_udp` (`launch.ts`).
 *     Measured: no ICE candidate with it, host and srflx candidates without it;
 *     the `--force-webrtc-ip-handling-policy` switch alone changed nothing.
 *
 * A proxy POLICY (an enterprise `ProxySettings`) replaces `--proxy-server`, so
 * the fence is PROVED per launch: a canary request must arrive here
 * (`launch.ts`), or the browser is refused. The same host rule decides what a
 * navigation may name (`reachable`), so the URL check and the fence cannot
 * disagree.
 *
 * Not covered, and said so in ARCHITECTURE §13: whether Chrome resolves a
 * fenced host name through the OS before proxying it (a DNS lookup carries the
 * name; unmeasured — the probe could not observe one either way).
 */
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { canonicalPath, isInside } from '../../core/sandbox/index.ts'

/** The marker header the fence's 403 carries, so a page's failed request can be told apart from a server's own 403. */
export const FENCE_HEADER = 'x-minidsh-fence'

/** The host a launch sends through the fence to prove it holds. `.invalid` never resolves, so a direct attempt fails rather than leaks. */
export const CANARY_HOST = 'minidsh-fence-canary.invalid'

/**
 * An operator `allowHosts` entry: a host name or IPv4 literal, optionally
 * `*.`-prefixed for its subdomains. Nothing that could split or extend the
 * bypass list (`;`, `,`, whitespace, a scheme or a port) passes.
 */
export const ALLOW_HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/

/** The `--proxy-bypass-list` value: implicit rules removed, loopback restated, then the operator's hosts. */
export function bypassList(allowHosts: readonly string[]): string {
  return ['<-loopback>', 'localhost', '*.localhost', '127.0.0.1/8', '[::1]', ...allowHosts].join(';')
}

/** True for a loopback host as a URL spells it (`URL.hostname`, lower-cased, IPv6 in brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** True for a host an `allowHosts` entry names. */
export function isAllowedHost(hostname: string, allowHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  return allowHosts.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry))
}

/** Whether an http(s) URL's host is inside the fence. The navigation check and the bypass list read the same rule. */
export function reachable(url: URL, allowHosts: readonly string[]): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.hostname) || isAllowedHost(url.hostname, allowHosts)
}

/**
 * Whether a `file:` URL names a file inside the session's workspace, after
 * links are followed (`canonicalPath`). The browser's other half of the fence:
 * a `file:` page can frame ANY local file it names — measured, the frame's text
 * lands in the accessibility tree, a UNC path (`file://host/share/…`)
 * included — and nothing about a proxy sees a file load. So the page layer
 * intercepts every `file:` request (`Fetch.enable`, measured to pause frame,
 * image and document loads alike) and lets through only what this admits. A
 * URL with a host is a network share, never the workspace.
 */
export function fileInsideWorkspace(url: URL, workspaceRoot: string): boolean {
  if (url.protocol !== 'file:') return false
  if (url.hostname !== '' && url.hostname !== 'localhost') return false
  let path: string
  try {
    path = fileURLToPath(url)
  } catch {
    return false
  }
  return isInside(canonicalPath(workspaceRoot), canonicalPath(path))
}

/**
 * The listener the browser's proxy setting points at. It reads one request
 * line, records the host, answers a marked 403 and closes; anything malformed
 * is closed unanswered.
 */
export class Fence {
  readonly port: number
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  /** Hosts seen, in arrival order, bounded: a diagnostic, never an authority. */
  private readonly hosts: string[] = []
  private readonly waiters = new Set<{ host: string; resolve: () => void }>()

  private constructor(server: Server, port: number) {
    this.server = server
    this.port = port
  }

  static async start(): Promise<Fence> {
    // The handler needs the instance, which needs the port the listen returns.
    const holder: { fence?: Fence } = {}
    const server = createServer((socket) => holder.fence?.accept(socket))
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') reject(new Error('the fence listener has no port'))
        else resolve(address.port)
      })
    })
    server.on('error', () => {})
    holder.fence = new Fence(server, port)
    return holder.fence
  }

  /** True once a request for `host` reached the fence. */
  saw(host: string): boolean {
    return this.hosts.includes(host)
  }

  /** Resolves true when `host` reaches the fence, false after `timeoutMs`. */
  waitFor(host: string, timeoutMs: number): Promise<boolean> {
    if (this.saw(host)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = {
        host,
        resolve: () => {
          clearTimeout(timer)
          this.waiters.delete(waiter)
          resolve(true)
        },
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(false)
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(10_000, () => socket.destroy())
    let head = ''
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n')
      if (end < 0) {
        if (head.length > 8192) socket.destroy()
        return
      }
      this.record(hostOf(head.slice(0, end)))
      const body = 'blocked by the MiniDSH browser fence: this browser reaches loopback and the hosts its operator allowed\n'
      socket.end(`HTTP/1.1 403 Forbidden\r\n${FENCE_HEADER}: denied\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
      socket.removeAllListeners('data')
    })
  }

  private record(host: string | undefined): void {
    if (host === undefined) return
    if (this.hosts.length >= 512) this.hosts.shift()
    this.hosts.push(host)
    for (const waiter of Array.from(this.waiters)) if (waiter.host === host) waiter.resolve()
  }
}

/** The host a proxy request line names: `CONNECT host:port …` or `GET http://host[:port]/… …`. */
function hostOf(line: string): string | undefined {
  const [method, target] = line.split(' ')
  if (method === undefined || target === undefined) return undefined
  try {
    if (method === 'CONNECT') return new URL(`http://${target}`).hostname
    return new URL(target).hostname
  } catch {
    return undefined
  }
}
