/**
 * What a real-browser test needs: the browser this host has (or why a suite
 * skips), and a loopback server to point it at.
 *
 * A suite that drives a real browser self-skips where none is installed, so a
 * host without one would report it green having run nothing. Under
 * `MINIDSH_EXPECT_BROWSER=1` (CI on every runner, and the WSL leg) that skip is
 * a failure instead — `expectBrowserSuite` says so in the suite that skips.
 */
import { execFileSync } from 'node:child_process'
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

/**
 * The pids of every process whose command line names `dir` — a launch's
 * profile is on every one of its browser's (`--user-data-dir=`) — for the
 * checks that a closed or refused browser really left nothing running.
 *
 * `[]` is what those checks read as success, so it is returned for exactly
 * one thing: the query ran and matched nothing. A query that could not run (no
 * pwsh, no pgrep, a failing CIM call, a hang) throws, because answering `[]`
 * for it made "nothing is running" true on any host where the helper was
 * broken. Its positive control is `browser-fixture.test.ts`.
 *
 * The query is asked up to three times before that error. A query tool that
 * dies by itself has answered nothing either way, and one does: pwsh 7.6 was
 * seen ending this very CIM query with "Internal CLR error (0x80131506)" on a
 * loaded Windows host, which the old catch reported as an empty process list.
 */
export function browsersUsing(dir: string): number[] {
  const failures: string[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return queryProcesses(dir)
    } catch (error) {
      failures.push(`attempt ${attempt}: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }
  throw new Error(`browsersUsing: the process query for ${JSON.stringify(dir)} could not answer, so nothing is known about what is running\n${failures.join('\n')}`)
}

function queryProcesses(dir: string): number[] {
  const pids = (out: string): number[] => out.split(/\s+/).filter((pid) => pid !== '').map(Number)
  if (process.platform === 'win32') {
    const needle = dir.replaceAll("'", "''")
    // Not this query's own process, whose command line names the directory too.
    // `Stop`, so a failing CIM call is a non-zero exit and not an empty answer.
    const query = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId }`
    return pids(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }))
  }
  try {
    return pids(execFileSync('pgrep', ['-f', dir], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })).filter((pid) => pid !== process.pid)
  } catch (error) {
    // pgrep's own "nothing matched", and the one failure that is an answer.
    if ((error as { status?: number | null }).status === 1) return []
    throw error
  }
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
