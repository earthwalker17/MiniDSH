/**
 * What a real-browser test needs: the browser this host has (or why a suite
 * skips), and a loopback server to point it at.
 *
 * A suite that drives a real browser self-skips where none is installed, so a
 * host without one would report it green having run nothing. Under
 * `MINIDSH_EXPECT_BROWSER=1` (CI on every runner, and the WSL leg) that skip is
 * a failure instead — `expectBrowserSuite` says so in the suite that skips.
 */
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { locateBrowser, type LocatedBrowser } from '../capabilities/tool-browser/locate.ts'

/** The browser real-browser suites drive, honouring an explicit `MINIDSH_TEST_BROWSER` path. */
export const testBrowser: LocatedBrowser | undefined = locateBrowser(process.env.MINIDSH_TEST_BROWSER || undefined)

/** Every browser this host has, for the checks that must hold for each (the fence). */
export function everyTestBrowser(): LocatedBrowser[] {
  if (process.env.MINIDSH_TEST_BROWSER) return testBrowser === undefined ? [] : [testBrowser]
  const found: LocatedBrowser[] = []
  for (const kind of ['chrome', 'edge', 'chromium'] as const) {
    const located = locateBrowserOfKind(kind)
    if (located !== undefined) found.push(located)
  }
  return found
}

function locateBrowserOfKind(kind: LocatedBrowser['kind']): LocatedBrowser | undefined {
  // `locateBrowser` stops at the first hit; asking with a filter over the same
  // candidates finds one of each kind.
  return locateBrowser(undefined, { exists: (path) => kindOfPath(path) === kind && existsSync(path) })
}

function kindOfPath(path: string): LocatedBrowser['kind'] {
  const lower = path.toLowerCase()
  if (lower.includes('edge')) return 'edge'
  if (lower.includes('chromium')) return 'chromium'
  return 'chrome'
}

/** Fails the run when a browser is required and absent; call once per real-browser test file. */
export function expectBrowserSuite(name: string): void {
  describe.runIf(process.env.MINIDSH_EXPECT_BROWSER === '1')(`${name}: a host that is REQUIRED to have a browser`, () => {
    it('has Chrome, Edge or Chromium installed where MiniDSH looks', () => {
      expect(testBrowser, `MINIDSH_EXPECT_BROWSER=1 but no Chrome, Edge or Chromium was found on ${process.platform}`).toBeDefined()
    })
  })
}

export type Route = string | { readonly status?: number; readonly type?: string; readonly body: string | Buffer; readonly headers?: Record<string, string> }

export interface FixtureServer {
  readonly origin: string
  readonly port: number
  /** Request paths, in arrival order. */
  readonly requests: string[]
  /** Replace or add a route while serving. */
  route(path: string, route: Route): void
  close(): Promise<void>
}

/**
 * A loopback HTTP server over a route table: a string is HTML. `/favicon.ico`
 * answers 204 unless routed, so a page's "errors only" check is not tripped by
 * the browser's own favicon request.
 */
export async function fixtureServer(routes: Record<string, Route>, options: { host?: string; port?: number } = {}): Promise<FixtureServer> {
  const table = new Map(Object.entries(routes))
  const requests: string[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '/').split('?')[0]!
    requests.push(path)
    const route = table.get(path)
    if (route === undefined) {
      if (path === '/favicon.ico') {
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    if (typeof route === 'string') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(route)
      return
    }
    response.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'text/html; charset=utf-8', ...route.headers })
    response.end(route.body)
  })
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  const shown = host.includes(':') ? `[${host}]` : host
  return {
    origin: `http://${shown}:${address.port}`,
    port: address.port,
    requests,
    route: (path, route) => void table.set(path, route),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
