import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { choosePort, HandoffError, parseRecord, probePort, RecordReader, RuntimeProcess, RuntimeStartError, runtimeArgv, signIn, STDERR_TAIL_BYTES, type FetchLike, type StartFailure } from './runtime.ts'
import { PORT_MAX, PORT_MIN } from './settings.ts'

const FAKE = join(import.meta.dirname, 'test-fixtures', 'fake-runtime.ts')

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const undo of cleanup.splice(0).toReversed()) await undo()
})

const scratch = (): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'minidsh-desktop-runtime-')))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---- argv -------------------------------------------------------------------

describe('the runtime argv', () => {
  const cwd = join(tmpdir(), 'proj')
  const other = join(tmpdir(), 'other')

  it('is exactly web --json --port --cwd and one --workspace per folder', () => {
    expect(runtimeArgv({ bin: '/app/bin/minidsh.js', port: 31_000, cwd, folders: [cwd, other] })).toEqual([
      '/app/bin/minidsh.js',
      'web',
      '--json',
      '--port',
      '31000',
      '--cwd',
      cwd,
      '--workspace',
      cwd,
      '--workspace',
      other,
    ])
  })

  it('can never carry an authority, host, patch or preset flag', () => {
    const forbidden = ['--approve', '--sandbox', '--accept', '--ask', '--host', '--patch', '--agent-preset']
    for (const folders of [[], [cwd], [cwd, other, join(cwd, '--approve')]]) {
      const argv = runtimeArgv({ bin: 'bin.js', port: 20_000, cwd, folders })
      expect(argv.filter((arg) => arg.startsWith('--'))).toEqual(['--json', '--port', '--cwd', ...folders.map(() => '--workspace')])
      for (const flag of forbidden) expect(argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false)
    }
    // A value that could read as a flag is refused, never passed.
    for (const sneaky of ['--approve', '-x', 'relative/dir', '--host=0.0.0.0']) {
      expect(() => runtimeArgv({ bin: 'bin.js', port: 20_000, cwd: sneaky, folders: [] })).toThrow(TypeError)
      expect(() => runtimeArgv({ bin: 'bin.js', port: 20_000, cwd, folders: [sneaky] })).toThrow(TypeError)
    }
    for (const port of [0, 65_536, 1.5, Number.NaN]) expect(() => runtimeArgv({ bin: 'bin.js', port, cwd, folders: [] })).toThrow(RangeError)
  })
})

// ---- records ----------------------------------------------------------------

const READY = { type: 'ready', host: '127.0.0.1', port: 31_000, token: 'tok_EN-123', version: '1.2.0', home: '/h', workspaces: [{ id: 'w', name: 'n', root: '/r' }] }
const line = (value: unknown): string => `${JSON.stringify(value)}\n`

describe('the record reader', () => {
  it('reads a ready record fed one byte at a time, a multibyte character split across reads', () => {
    const reader = new RecordReader()
    const bytes = Buffer.from(line({ ...READY, home: '/home/zoë/日本' }), 'utf8')
    const records = [...bytes].flatMap((byte) => reader.feed(Buffer.from([byte])))
    expect(records).toEqual([{ ...READY, home: '/home/zoë/日本' }])
  })

  it('tolerates CRLF and ignores non-JSON, arrays, non-objects and unknown types', () => {
    const reader = new RecordReader()
    const text = ['booting…', '[1,2]', '42', 'null', line({ type: 'progress' }).trim(), JSON.stringify({ type: 'error', code: 'EADDRINUSE', message: 'in use' })].join('\r\n') + '\r\n'
    expect(reader.feed(Buffer.from(text))).toEqual([{ type: 'error', code: 'EADDRINUSE', message: 'in use' }])
  })

  it('reports a known type that breaks the contract as a fault naming fields, never values', () => {
    const fault = parseRecord(JSON.stringify({ ...READY, token: 'secret value!', port: 0 }))
    expect(fault).toEqual({ type: 'fault', detail: 'a ready record with an invalid port, token' })
    expect(JSON.stringify(fault)).not.toContain('secret')
    expect(parseRecord(JSON.stringify({ ...READY, workspaces: [{ id: 1 }] }))).toEqual({ type: 'fault', detail: 'a ready record with an invalid workspaces' })
    expect(parseRecord(JSON.stringify({ ...READY, token: '' }))?.type).toBe('fault')
    expect(parseRecord(JSON.stringify({ type: 'error', code: 3 }))?.type).toBe('fault')
  })

  it('drops an over-long line through its newline without buffering it, then reads on', () => {
    const reader = new RecordReader(1024)
    expect(reader.feed(Buffer.from('x'.repeat(4096)))).toEqual([])
    expect(reader.feed(Buffer.from(`${'y'.repeat(4096)}{"type":"error","code":"A","message":"hidden"}`))).toEqual([])
    expect(reader.feed(Buffer.from(`\n${line(READY)}`))).toEqual([READY])
    // A record exactly at the cap still parses; one character more does not.
    const padded = (length: number): string => JSON.stringify({ ...READY, home: 'h'.repeat(length - JSON.stringify(READY).length + '/h'.length) })
    expect(padded(1024)).toHaveLength(1024)
    expect(new RecordReader(1024).feed(Buffer.from(`${padded(1024)}\n`))).toHaveLength(1)
    expect(new RecordReader(1024).feed(Buffer.from(`${padded(1025)}\n${line(READY)}`))).toEqual([READY])
  })

  it('reads a last line with no newline when the stream ends', () => {
    const reader = new RecordReader()
    expect(reader.feed(Buffer.from(JSON.stringify(READY)))).toEqual([])
    expect(reader.end()).toEqual([READY])
  })
})

// ---- sign-in ----------------------------------------------------------------

const TOKEN = 'tok+en/with=chars'
const COOKIE_VALUE = 'eyJhIjoxfQ.c2lnbmF0dXJl'

/** A fake fetch answering one prepared response, recording what it was asked. */
function answering(response: Response | Error): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (response instanceof Error) throw response
      return response
    },
  }
}

const redirect = (cookies: readonly string[], status = 303): Response => new Response(null, { status, headers: cookies.map((cookie) => ['set-cookie', cookie] as [string, string]) })

async function handoffError(promise: Promise<unknown>): Promise<HandoffError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(HandoffError)
  const message = String((error as Error).message)
  expect(message).not.toContain(TOKEN)
  expect(message).not.toContain(encodeURIComponent(TOKEN))
  expect(message).not.toContain(COOKIE_VALUE)
  return error as HandoffError
}

describe('the sign-in handoff', () => {
  it('exchanges the token once, on loopback, without following the redirect', async () => {
    const requests: string[] = []
    const server: Server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.host}`)
      response.writeHead(303, { location: '/', 'set-cookie': `minidsh_session=${COOKIE_VALUE}; HttpOnly; SameSite=Strict; Path=/` }).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const { port } = server.address() as AddressInfo
    expect(await signIn(port, TOKEN)).toBe(`minidsh_session=${COOKIE_VALUE}`)
    expect(requests).toEqual([`GET /?token=${encodeURIComponent(TOKEN)} 127.0.0.1:${port}`])
  })

  it('asks with redirect manual and a deadline', async () => {
    const stub = answering(redirect([`minidsh_session=${COOKIE_VALUE}`]))
    await signIn(31_000, TOKEN, stub.fetch)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]!.url).toBe(`http://127.0.0.1:31000/?token=${encodeURIComponent(TOKEN)}`)
    expect(stub.calls[0]!.init.redirect).toBe('manual')
    expect(stub.calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses anything but one 303 with exactly one well-formed minidsh_session cookie, quoting no secret', async () => {
    const cases: [Response | Error, RegExp][] = [
      [redirect([`minidsh_session=${COOKIE_VALUE}`], 200), /answered 200/],
      [new Response('that link has already been used', { status: 401 }), /answered 401/],
      [redirect([]), /0 cookies/],
      [redirect([`minidsh_session=${COOKIE_VALUE}`, `minidsh_session=${COOKIE_VALUE}`]), /2 cookies/],
      [redirect([`other=${COOKIE_VALUE}`]), /other than minidsh_session/],
      [redirect([COOKIE_VALUE]), /other than minidsh_session/],
      [redirect(['minidsh_session=']), /malformed/],
      [redirect(['minidsh_session="quoted value"']), /malformed/],
      [new Error(`connect ECONNREFUSED for http://127.0.0.1:1/?token=${TOKEN}`), /did not answer/],
    ]
    for (const [response, why] of cases) {
      const error = await handoffError(signIn(31_000, TOKEN, answering(response).fetch))
      expect(error.message).toMatch(why)
    }
  })
})

// ---- the child --------------------------------------------------------------

interface Fake {
  readonly runtime: RuntimeProcess
  readonly cwd: string
  readonly stderr: Buffer[]
  readonly faults: string[]
  readonly started: Promise<Awaited<ReturnType<RuntimeProcess['start']>>>
}

function fake(steps: string, options: { port?: number; startTimeoutMs?: number; node?: string } = {}): Fake {
  const cwd = scratch()
  const runtime = new RuntimeProcess()
  cleanup.push(async () => {
    runtime.kill()
    await runtime.exited
  })
  const stderr: Buffer[] = []
  const faults: string[] = []
  const started = runtime.start({
    node: options.node ?? process.execPath,
    bin: FAKE,
    port: options.port ?? 31_000,
    cwd,
    folders: [cwd],
    env: { ...process.env, FAKE_RUNTIME: steps },
    startTimeoutMs: options.startTimeoutMs ?? 20_000,
    onStderr: (chunk) => stderr.push(chunk),
    onFault: (detail) => faults.push(detail),
  })
  // Each test awaits it; a rejection is never left unobserved in between.
  started.catch(() => undefined)
  return { runtime, cwd, stderr, faults, started }
}

async function startFailure(promise: Promise<unknown>): Promise<StartFailure> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(RuntimeStartError)
  return (error as RuntimeStartError).failure
}

describe('the runtime child', () => {
  it('resolves on the first valid ready, spawned with exactly the pinned argv in the folder', async () => {
    const { started, cwd, stderr } = fake('argv,noise,ready,stdin-exit:0')
    expect(await started).toEqual({ port: 31_000, token: 'tok_EN-123', version: '1.2.0', home: '/home/zoë/.minidsh', workspaces: [{ id: 'w1', name: 'proj', root: cwd }] })
    const seen = JSON.parse(Buffer.concat(stderr).toString('utf8')) as { argv: string[]; cwd: string }
    expect(seen.argv).toEqual(runtimeArgv({ bin: FAKE, port: 31_000, cwd, folders: [cwd] }).slice(1))
    expect(realpathSync.native(seen.cwd)).toBe(cwd)
  })

  it('reads a ready record that arrives in pieces, a character cut in two, or ended by CRLF', async () => {
    expect((await fake('split,stdin-exit:0').started).home).toBe('/home/zoë/.minidsh')
    expect((await fake('crlf,stdin-exit:0').started).port).toBe(31_000)
    expect((await fake('long,ready,stdin-exit:0').started).port).toBe(31_000)
  })

  it('stops gracefully on stdin end: exit 0, requested, not killed', async () => {
    const { runtime, started } = fake('ready,stdin-exit:0')
    await started
    const stopping = runtime.stop()
    expect(runtime.stop()).toBe(stopping)
    expect(await stopping).toEqual({ graceful: true, killed: false })
    expect(await runtime.exited).toEqual({ code: 0, signal: null, requested: true })
  })

  it('calls a non-zero exit after a stop not graceful, and kills one that ignores stdin at the deadline', async () => {
    const failing = fake('ready,stdin-exit:3')
    await failing.started
    expect(await failing.runtime.stop()).toEqual({ graceful: false, killed: false })
    const stubborn = fake('ready,hang')
    await stubborn.started
    expect(await stubborn.runtime.stop({ deadlineMs: 300 })).toEqual({ graceful: false, killed: true })
    expect((await stubborn.runtime.exited).requested).toBe(true)
  })

  it('reports an unrequested exit after ready as not requested', async () => {
    const { runtime, started } = fake('ready,sleep:50,exit:7')
    await started
    expect(await runtime.exited).toEqual({ code: 7, signal: null, requested: false })
    expect(await runtime.stop()).toEqual({ graceful: false, killed: false })
  })

  it('rejects with the error record the runtime printed before exiting', async () => {
    const { runtime, started } = fake('error,exit:1')
    expect(await startFailure(started)).toEqual({ kind: 'error-record', code: 'EADDRINUSE', message: 'port 31000 is in use' })
    expect((await runtime.exited).code).toBe(1)
  })

  it('rejects an exit before ready with the code and the stderr tail', async () => {
    const { started, stderr } = fake('stderr:200000,exit:4')
    const failure = await startFailure(started)
    expect(failure).toMatchObject({ kind: 'exited', code: 4, signal: null })
    const tail = failure.kind === 'exited' ? failure.stderrTail : ''
    // The ring keeps the last 64 KiB; every chunk still reached the callback.
    expect(tail).toHaveLength(STDERR_TAIL_BYTES)
    expect(tail.endsWith('END')).toBe(true)
    expect(Buffer.concat(stderr).length).toBe(200_000)
  })

  it('kills and rejects a ready naming another port, a non-loopback host or a malformed token', async () => {
    for (const [steps, detail] of [
      ['ready-port,hang', /port 31001, not the requested 31000/],
      ['ready-host,hang', /host other than 127\.0\.0\.1/],
      ['ready-badtoken,hang', /invalid token/],
    ] as const) {
      const { runtime, started } = fake(steps)
      const failure = await startFailure(started)
      expect(failure.kind).toBe('protocol')
      expect(failure.kind === 'protocol' ? failure.detail : '').toMatch(detail)
      expect(failure.kind === 'protocol' ? failure.detail : '').not.toContain('has space')
      await runtime.exited
      expect(await runtime.stop()).toEqual({ graceful: false, killed: true })
    }
  })

  it('times out a runtime that never becomes ready, and kills it', async () => {
    const { runtime, started } = fake('hang', { startTimeoutMs: 300 })
    expect(await startFailure(started)).toEqual({ kind: 'timeout' })
    await runtime.exited
    expect((await runtime.stop()).killed).toBe(true)
  })

  it('treats a second ready as a protocol fault: killed, and reported once', async () => {
    const { runtime, started, faults } = fake('ready,ready,ready,hang')
    await started
    const exit = await runtime.exited
    expect(exit.requested).toBe(false)
    expect(faults).toEqual(['an unexpected ready record after ready'])
  })

  it('names a node that cannot be executed as a spawn failure', async () => {
    const { runtime, started } = fake('ready', { node: join(tmpdir(), 'no-such-node-binary') })
    expect((await startFailure(started)).kind).toBe('spawn')
    expect(await runtime.exited).toEqual({ code: null, signal: null, requested: false })
  })

  it('starts once, and never after a stop', async () => {
    const { runtime, started } = fake('ready,stdin-exit:0')
    await started
    await expect(runtime.start({ node: process.execPath, bin: FAKE, port: 31_000, cwd: scratch(), folders: [], env: {} })).rejects.toThrow(/starts once/)
    await runtime.stop()
    // A bad argv is refused before anything is spawned, and the exit is settled at once.
    const misused = new RuntimeProcess()
    await expect(misused.start({ node: process.execPath, bin: FAKE, port: 31_000, cwd: 'relative', folders: [], env: {} })).rejects.toThrow(TypeError)
    expect(await misused.exited).toEqual({ code: null, signal: null, requested: false })
    const unstarted = new RuntimeProcess()
    expect(await unstarted.stop()).toEqual({ graceful: false, killed: false })
    await expect(unstarted.start({ node: process.execPath, bin: FAKE, port: 31_000, cwd: scratch(), folders: [], env: {} })).rejects.toThrow(/never after stop/)
  })
})

// ---- the port ---------------------------------------------------------------

describe('the port', () => {
  it('chooses uniformly inside [20000, 45000), whatever the random source returns', () => {
    expect(choosePort(() => 0)).toBe(PORT_MIN)
    expect(choosePort(() => 0.999_999_999)).toBe(PORT_MAX - 1)
    expect(choosePort(() => 1)).toBe(PORT_MAX - 1)
    expect(choosePort(() => -1)).toBe(PORT_MIN)
    for (let i = 0; i < 1000; i++) {
      const port = choosePort()
      expect(port >= PORT_MIN && port < PORT_MAX && Number.isInteger(port)).toBe(true)
    }
  })

  it('probes a free port as free and a held one as not', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    expect(await probePort(port)).toBe(false)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await probePort(port)).toBe(true)
  })
})
