/**
 * `minidsh web --json` as a supervisor meets it: a spawned binary, records on
 * stdout, and a stop that is nothing but the end of stdin. Keyless — a
 * running turn comes from a from-disk scripted model that calls the `hold`
 * tool (`fixtures/hold-model-plugin.ts`), so the stop lands inside a
 * dispatched call with the session's lease held, as a real one would.
 *
 * What is asserted is what a supervisor can observe: the exit code, the
 * records, the log on disk and the lock files beside it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalPath } from '../core/sandbox/paths.ts'
import { endOf } from '../test-support/serve-process.ts'
import { killSpawnedWebHosts, WebClient, WebHostProcess } from '../test-support/web-process.ts'

const HOLD_TOOL = fileURLToPath(new URL('../test-support/fixtures/hold-plugin.ts', import.meta.url))
const HOLD_MODEL = fileURLToPath(new URL('../test-support/fixtures/hold-model-plugin.ts', import.meta.url))
/** A stop is bounded by the runtime at 5 s + 20 s; a test that waits longer is waiting on a hang. */
const STOP_MS = 30_000

let dirs: string[] = []
afterAll(() => {
  killSpawnedWebHosts()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function locks(home: string): string[] {
  const sessions = join(home, 'sessions')
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
}

/** A home whose composition keeps a prompted turn running inside a `hold` call until stopped. */
function holdingHome(): string {
  const home = tempDir('minidsh-webjson-home-')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ agent: { provider: 'scripted', model: 'scripted-model' } }))
  writeFileSync(
    join(home, 'composition.json'),
    JSON.stringify({
      patches: [
        {
          insert: [
            // Released only by a file nobody writes: the stop is what ends the call.
            { id: 'tool-hold', plugin: HOLD_TOOL, config: { releaseFile: join(home, 'never-released') } },
            { id: 'llm-scripted-hold', plugin: HOLD_MODEL },
          ],
        },
      ],
    }),
  )
  return home
}

/** Prompts, and resolves once the `hold` call is dispatched — the turn is then provably running inside it. */
async function runningTurn(host: WebHostProcess, home: string): Promise<{ sessionId: string; log: string }> {
  const client = await host.connect()
  const { sessionId } = await client.request<{ sessionId: string }>('session/prompt', { text: 'call hold' })
  await client.waitFor(
    () => {
      const call = client.events('tool/call', sessionId).find((event) => (event.data as { name: string }).name === 'hold')
      const callId = (call?.data as { callId?: string } | undefined)?.callId
      return callId !== undefined && client.events('tool/dispatch', sessionId).some((event) => (event.data as { callId: string }).callId === callId) ? true : undefined
    },
    'the hold call to be dispatched',
    30_000,
  )
  const log = join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`)
  expect(existsSync(`${log}.lock`), 'the running session holds its lease').toBe(true)
  return { sessionId, log }
}

function turnEnds(log: string): string[] {
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as { type: string; data: { reason?: { kind: string } } })
    .filter((event) => event.type === 'turn/end')
    .map((event) => event.data.reason?.kind ?? '?')
}

describe('minidsh web --json: the ready record and the stdin stop', () => {
  it('reports ready once, its token signs in once, and the end of stdin stops it cleanly', { timeout: 90_000 }, async () => {
    const home = tempDir('minidsh-webjson-home-')
    const first = tempDir('minidsh-webjson-ws-')
    const second = tempDir('minidsh-webjson-ws-')
    // No --cwd: with --workspace it defaults to the first root.
    const host = new WebHostProcess(first, home, { json: true, noCwd: true, args: ['--workspace', first, '--workspace', second] })
    const ready = await host.ready()
    expect(ready).toMatchObject({ type: 'ready', host: '127.0.0.1', home, version: expect.stringMatching(/^\d+\.\d+\.\d+/) as unknown })
    expect(Number.isInteger(ready.port) && ready.port > 0, `port ${ready.port}`).toBe(true)
    expect(ready.token.length, 'a token').toBeGreaterThan(16)
    expect(ready.workspaces.map((workspace) => workspace.root)).toEqual([canonicalPath(first), canonicalPath(second)])
    expect(new Set(ready.workspaces.map((workspace) => workspace.id)).size).toBe(2)

    // The exchange a supervisor makes with the record's token: one 303, one cookie.
    const response = await fetch(`http://127.0.0.1:${ready.port}/?token=${ready.token}`, { redirect: 'manual' })
    expect(response.status).toBe(303)
    const cookies = response.headers.getSetCookie()
    expect(cookies.map((cookie) => cookie.split('=', 1)[0])).toEqual(['minidsh_session'])
    // The token is spent now: the socket rides the cookie, as a browser's does.
    const client = await WebClient.open(`ws://127.0.0.1:${ready.port}/ws`, cookies[0]!.split(';', 1)[0]!)
    const init = await client.request<{ workspaces: unknown[] }>('initialize')
    expect(init.workspaces, 'the record names what the wire serves').toEqual(ready.workspaces)

    const exit = await host.stop(STOP_MS)
    expect(exit, `stderr: ${host.stderr}`).toEqual({ code: 0, signal: null })
    expect(host.records.map((record) => record.type), 'stdout carried only these records').toEqual(['ready'])
    expect(host.stderr, 'the token is in the ready record and nowhere else').not.toContain(ready.token)
    expect(locks(home)).toEqual([])
  })

  it('ends a RUNNING turn cancelled and releases its lease when stdin ends', { timeout: 90_000 }, async () => {
    const home = holdingHome()
    const host = new WebHostProcess(tempDir('minidsh-webjson-ws-'), home, { json: true, approve: true })
    const { log } = await runningTurn(host, home)
    const exit = await host.stop(STOP_MS)
    expect(exit, `stderr: ${host.stderr}`).toEqual({ code: 0, signal: null })
    expect(turnEnds(log), 'the turn ends the log recorded').toEqual(['cancelled'])
    expect(locks(home)).toEqual([])
  })

  // The supervisor that died: its ends of stdout and stderr close first, so
  // every write the stop makes fails EPIPE — and the bin's EPIPE handler
  // exits 0 on the first one, which mid-disposal strands the lease.
  it('still stops cleanly when stdout and stderr were closed before stdin ended', { timeout: 90_000 }, async () => {
    const home = holdingHome()
    const host = new WebHostProcess(tempDir('minidsh-webjson-ws-'), home, { json: true, approve: true })
    const { log } = await runningTurn(host, home)
    host.child.stdout!.destroy()
    host.child.stderr!.destroy()
    const exit = await host.stop(STOP_MS)
    expect(exit).toEqual({ code: 0, signal: null })
    expect(turnEnds(log), 'the turn ends the log recorded').toEqual(['cancelled'])
    expect(locks(home), 'locks left behind').toEqual([])
  })

  it('is not stopped by a stdin that is the null device, as a service manager gives', { timeout: 60_000 }, async () => {
    const home = tempDir('minidsh-webjson-home-')
    const host = new WebHostProcess(tempDir('minidsh-webjson-ws-'), home, { json: true, stdin: 'ignore' })
    await host.ready()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(endOf(host.child), `stderr: ${host.stderr}`).toBeUndefined()
    host.kill()
    await host.waitForExit(10_000)
  })

  it.skipIf(process.platform === 'win32')('stops gracefully on SIGTERM (POSIX only: Windows has no SIGTERM to send, a kill there is TerminateProcess)', { timeout: 90_000 }, async () => {
    const home = holdingHome()
    const host = new WebHostProcess(tempDir('minidsh-webjson-ws-'), home, { json: true, approve: true })
    const { log } = await runningTurn(host, home)
    host.child.kill('SIGTERM')
    const exit = await host.waitForExit(STOP_MS)
    expect(exit, `stderr: ${host.stderr}`).toEqual({ code: 0, signal: null })
    expect(turnEnds(log)).toEqual(['cancelled'])
    expect(locks(home)).toEqual([])
  })
})

describe('minidsh web --json: one error record for every exit before ready', () => {
  async function refused(host: WebHostProcess): Promise<{ code: number | null; record: Record<string, unknown> }> {
    const exit = await host.waitForExit(60_000)
    // Every line on stdout was a record, and exactly one was written.
    expect(host.stdout.trim().split('\n').length, `stdout: ${host.stdout}`).toBe(1)
    expect(host.records, `stdout: ${host.stdout}`).toHaveLength(1)
    expect(host.records[0]!.type).toBe('error')
    expect(typeof host.records[0]!.message).toBe('string')
    return { code: exit.code, record: host.records[0]! }
  }

  it('USAGE for a malformed flag, exit 2', { timeout: 60_000 }, async () => {
    const host = new WebHostProcess(tempDir('minidsh-webjson-ws-'), tempDir('minidsh-webjson-home-'), { json: true, args: ['--port', 'abc'] })
    expect(await refused(host)).toMatchObject({ code: 2, record: { code: 'USAGE' } })
  })

  it('CONFIG for a malformed settings.json, exit 2', { timeout: 60_000 }, async () => {
    const home = tempDir('minidsh-webjson-home-')
    writeFileSync(join(home, 'settings.json'), '{ "agent": ')
    const host = new WebHostProcess(tempDir('minidsh-webjson-ws-'), home, { json: true })
    expect(await refused(host)).toMatchObject({ code: 2, record: { code: 'CONFIG' } })
  })

  it('WORKSPACE for a workspace that contains the home, exit 2', { timeout: 60_000 }, async () => {
    const parent = tempDir('minidsh-webjson-parent-')
    const home = join(parent, 'home')
    mkdirSync(home)
    const host = new WebHostProcess(parent, home, { json: true, noCwd: true, args: ['--workspace', parent] })
    const { code, record } = await refused(host)
    expect({ code, record: record.code }).toEqual({ code: 2, record: 'WORKSPACE' })
    expect(record.message).toMatch(/may not contain MiniDSH's home/)
  })

  it('EADDRINUSE for a port that is taken, exit 1', { timeout: 60_000 }, async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    try {
      const port = (blocker.address() as AddressInfo).port
      // Last wins: this overrides the helper's own `--port 0`.
      const host = new WebHostProcess(tempDir('minidsh-webjson-ws-'), tempDir('minidsh-webjson-home-'), { json: true, args: ['--port', String(port)] })
      expect(await refused(host)).toMatchObject({ code: 1, record: { code: 'EADDRINUSE' } })
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  })
})
