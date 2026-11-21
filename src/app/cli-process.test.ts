/**
 * The bin as a process whose reader goes away: `minidsh run … | head -2`, a
 * `serve` client that died. The bin exits 0 on the first EPIPE, which is right
 * for a command that only prints and was wrong for one in the middle of a
 * turn — so what is asserted here is what is left behind: the exit code, the
 * `turn/end` on disk and the lock files beside it.
 *
 * Keyless: the turn is kept running by a from-disk scripted model that calls
 * the `hold` tool (`fixtures/hold-model-plugin.ts`), so the streams close
 * while a call is provably dispatched and the session's lease is held.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { endOf, killSpawnedServes, SERVE_BIN, ServeProcess } from '../test-support/serve-process.ts'

const HOLD_TOOL = fileURLToPath(new URL('../test-support/fixtures/hold-plugin.ts', import.meta.url))
const HOLD_MODEL = fileURLToPath(new URL('../test-support/fixtures/hold-model-plugin.ts', import.meta.url))
const NL = String.fromCharCode(10)

let dirs: string[] = []
const children: ChildProcess[] = []
afterAll(() => {
  killSpawnedServes()
  for (const child of children) if (endOf(child) === undefined) child.kill('SIGKILL')
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A home whose composition keeps a prompted turn inside a `hold` call until `release` exists. */
function holdingHome(): { home: string; release: string } {
  const home = tempDir('minidsh-cliproc-home-')
  const release = join(home, 'release')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ agent: { provider: 'scripted', model: 'scripted-model' } }))
  writeFileSync(
    join(home, 'composition.json'),
    JSON.stringify({
      patches: [
        {
          insert: [
            { id: 'tool-hold', plugin: HOLD_TOOL, config: { releaseFile: release } },
            { id: 'llm-scripted-hold', plugin: HOLD_MODEL },
          ],
        },
      ],
    }),
  )
  return { home, release }
}

function childEnv(home: string): NodeJS.ProcessEnv {
  const { MINIDSH_MODEL: _ambient, ...rest } = process.env
  return { ...rest, MINIDSH_HOME: home }
}

function sessionLogs(home: string): string[] {
  const sessions = join(home, 'sessions')
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.jsonl')).map((name) => join(sessions, name)) : []
}

function locks(home: string): string[] {
  const sessions = join(home, 'sessions')
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
}

function turnEnds(log: string): string[] {
  return readFileSync(log, 'utf8')
    .trim()
    .split(NL)
    .slice(1)
    .map((line) => JSON.parse(line) as { type: string; data: { reason?: { kind: string } } })
    .filter((event) => event.type === 'turn/end')
    .map((event) => event.data.reason?.kind ?? '?')
}

/** Resolves when `stream` has carried `marker`; rejects if the child ends first. No timer: the data decides. */
function carried(child: ChildProcess, stream: NodeJS.ReadableStream, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = ''
    stream.on('data', (chunk: Buffer) => {
      seen += String(chunk)
      if (seen.includes(marker)) resolve(seen)
    })
    child.once('exit', (code, signal) => reject(new Error(`the child ended (code ${code}, signal ${signal}) before "${marker}" appeared in:${NL}${seen}`)))
  })
}

const exited = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))

/**
 * A headless command whose reader goes away while its turn is inside `hold`.
 * `--max-steps 1`: the model calls `hold`, and the turn then ends `max-steps`
 * — exit 1, which no EPIPE handler returns.
 */
async function losesItsReaderMidTurn(home: string, release: string, argv: readonly string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, [SERVE_BIN, ...argv, '--approve', '--max-steps', '1'], { env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const done = exited(child)
  // The progress line of the call: the turn is running, inside the tool.
  await carried(child, child.stderr!, '→ hold')
  // `… | head -2`: the reader is gone, and every later write fails.
  child.stdout!.destroy()
  child.stderr!.destroy()
  writeFileSync(release, '')
  return done
}

describe('a reader that goes away in the middle of a turn', () => {
  it('lets `run` finish its turn, dispose, and exit with the turn\'s own code', { timeout: 120_000 }, async () => {
    const { home, release } = holdingHome()
    expect(await losesItsReaderMidTurn(home, release, ['run', 'call hold', '--cwd', tempDir('minidsh-cliproc-ws-')])).toEqual({ code: 1, signal: null })
    const logs = sessionLogs(home)
    expect(logs).toHaveLength(1)
    expect(turnEnds(logs[0]!), 'the turn ends the log recorded').toEqual(['max-steps'])
    expect(locks(home), 'locks left behind').toEqual([])
  })

  it('lets `resume --headless` do the same', { timeout: 120_000 }, async () => {
    const { home, release } = holdingHome()
    // A first turn to resume: released before it starts, so it runs straight through.
    writeFileSync(release, '')
    const first = spawn(process.execPath, [SERVE_BIN, 'run', 'call hold', '--approve', '--cwd', tempDir('minidsh-cliproc-ws-')], { env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(first)
    let stderr = ''
    first.stderr!.on('data', (chunk: Buffer) => (stderr += String(chunk)))
    first.stdout!.resume()
    expect(await exited(first), stderr).toEqual({ code: 0, signal: null })
    const id = /^session: (.+)$/m.exec(stderr)?.[1]
    expect(id, stderr).toBeDefined()
    rmSync(release)

    expect(await losesItsReaderMidTurn(home, release, ['resume', id!, 'call hold', '--headless'])).toEqual({ code: 1, signal: null })
    expect(turnEnds(join(home, 'sessions', `${encodeURIComponent(id!)}.jsonl`)), 'the turn ends the log recorded').toEqual(['completed', 'max-steps'])
    expect(locks(home), 'locks left behind').toEqual([])
  })

  it('lets `chat --plain` finish the turn and stop cleanly at the end of its input', { timeout: 120_000 }, async () => {
    const { home, release } = holdingHome()
    const child = spawn(process.execPath, [SERVE_BIN, 'chat', '--plain', '--approve', '--cwd', tempDir('minidsh-cliproc-ws-')], { env: childEnv(home), stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    const done = exited(child)
    child.stdin!.write(`call hold${NL}`)
    // The line view prints on stdout: the call is on screen, so the turn is inside the tool.
    await carried(child, child.stdout!, 'hold')
    child.stdout!.destroy()
    child.stderr!.destroy()
    writeFileSync(release, '')
    // The end of input: the line view finishes the running turn before it exits.
    child.stdin!.end()
    expect(await done).toEqual({ code: 0, signal: null })
    const logs = sessionLogs(home)
    expect(logs).toHaveLength(1)
    expect(turnEnds(logs[0]!), 'the turn ends the log recorded').toEqual(['completed'])
    expect(locks(home), 'locks left behind').toEqual([])
  })

  it('lets `serve` finish a turn whose client stopped reading, and stop cleanly when stdin then ends', { timeout: 120_000 }, async () => {
    const { home, release } = holdingHome()
    const host = new ServeProcess(tempDir('minidsh-cliproc-ws-'), home, { approve: true })
    const done = exited(host.child)
    const { sessionId } = await host.request<{ sessionId: string }>('session/prompt', { text: 'call hold' })
    await host.waitFor(
      () => {
        const call = host.events('tool/call', sessionId).find((event) => (event.data as { name: string }).name === 'hold')
        const callId = (call?.data as { callId?: string } | undefined)?.callId
        return callId !== undefined && host.events('tool/dispatch', sessionId).some((event) => (event.data as { callId: string }).callId === callId) ? true : undefined
      },
      'the hold call to be dispatched',
      60_000,
    )
    const log = join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`)
    expect(existsSync(`${log}.lock`), 'the running session holds its lease').toBe(true)
    // The client stops reading while the turn is still running: stdout is the
    // frame carrier, so every frame the rest of the turn sends is a failed write.
    host.child.stdout!.destroy()
    host.child.stderr!.destroy()
    writeFileSync(release, '')
    // Nothing can be read from the host any more, so the log on disk says when
    // the turn is over — or `waitFor` says the host exited before it was.
    await host.waitFor(() => (turnEnds(log).length > 0 ? true : undefined), 'the turn to end in the stored log', 60_000)
    expect(turnEnds(log), 'the turn ends the log recorded').toEqual(['completed'])
    expect(endOf(host.child), 'the host outlived its reader: stdin decides when it stops').toBeUndefined()
    host.child.stdin!.end()
    expect(await done).toEqual({ code: 0, signal: null })
    expect(locks(home), 'locks left behind').toEqual([])
  })
})

describe('a piped `chat`', () => {
  // The full-screen view names its session when it leaves the screen; the line
  // view said nothing, so a piped conversation could be found again only by
  // listing every session. On stderr, as `run` says it: stdout stays the
  // conversation for whatever reads the pipe.
  it('names its session on stderr when it ends, and keeps the id out of the transcript', { timeout: 120_000 }, async () => {
    const { home, release } = holdingHome()
    // Released before it starts: the turn runs straight through.
    writeFileSync(release, '')
    const child = spawn(process.execPath, [SERVE_BIN, 'chat', '--plain', '--approve', '--cwd', tempDir('minidsh-cliproc-ws-')], { env: childEnv(home), stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => (stdout += String(chunk)))
    child.stderr!.on('data', (chunk: Buffer) => (stderr += String(chunk)))
    child.stdin!.end(`call hold${NL}`)
    expect(await exited(child), stderr).toEqual({ code: 0, signal: null })
    const logs = sessionLogs(home)
    expect(logs).toHaveLength(1)
    const stored = JSON.parse(readFileSync(logs[0]!, 'utf8').split(NL)[0]!) as { id: string }
    expect(stderr.split(NL).filter((line) => line.startsWith('session: ')), stderr).toEqual([`session: ${stored.id}`])
    expect(stdout, 'the transcript on stdout').not.toContain(stored.id)
  })
})

describe('a reader that goes away from a command that only prints', () => {
  // `minidsh --help | head -1`: the reader has what it came for. That is the
  // reader's business, so the command stops quietly with the status a
  // pipeline wants — the rule the bin keeps for every command that runs nothing.
  it('stops with status 0 and no stack trace', { timeout: 60_000 }, async () => {
    const home = tempDir('minidsh-cliproc-home-')
    for (const argv of [['--help'], ['config']]) {
      const child = spawn(process.execPath, [SERVE_BIN, ...argv], { env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      let stderr = ''
      child.stderr!.on('data', (chunk: Buffer) => (stderr += String(chunk)))
      // Closed before the child has booted, so everything it prints meets a closed pipe.
      child.stdout!.destroy()
      expect(await exited(child), `${argv.join(' ')}: ${stderr}`).toEqual({ code: 0, signal: null })
      expect(stderr, argv.join(' ')).toBe('')
    }
  })
})

describe('a host over an empty settings.json', () => {
  it('says once that it read the file as no settings, though the boot and the runtime store both read it', { timeout: 120_000 }, async () => {
    const home = tempDir('minidsh-cliproc-home-')
    writeFileSync(join(home, 'settings.json'), '')
    const host = new ServeProcess(tempDir('minidsh-cliproc-ws-'), home)
    // The handshake reads the store's agent defaults: the runtime's own read of the same file.
    const init = await host.request<{ defaultAgentOptions: { provider: string; model: string } }>('initialize')
    expect(init.defaultAgentOptions).toMatchObject({ provider: 'deepseek' })
    await host.shutdown()
    const said = host.stderr.split(NL).filter((line) => line.includes('is empty'))
    expect(said, host.stderr).toEqual([`warn: settings file ${join(home, 'settings.json')} is empty; it is read as no settings, and the next change saved replaces it`])
  })
})
