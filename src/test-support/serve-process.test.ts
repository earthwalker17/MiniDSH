/**
 * The live arcs' client, held to what it is for: a host that goes wrong must
 * fail the test that met it, with what was seen.
 *
 * It gives up the moment its host is gone — by an exit code OR by a signal. On
 * Linux and macOS, where live.yml runs, a host killed by the OOM killer or
 * crashed by SIGSEGV has `exitCode` null and `signalCode` set; a wait that
 * read only the exit code then sat out its whole deadline and reported "timed
 * out" instead of "serve exited".
 *
 * And it swallows nothing a spawned `serve` does. `serve` is the one host with
 * no exit of its own, so the second half spawns the real binary, keyless (the
 * from-disk scripted model the `web --json` tests use), and makes it do each
 * thing in turn: leave cleanly, never leave, leave with a code, write a line
 * that is no frame, refuse an approval answer.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MisbehaveConfig } from './fixtures/misbehave-plugin.ts'
import { endOf, killSpawnedServes, ServeProcess } from './serve-process.ts'

const HOLD_TOOL = fileURLToPath(new URL('./fixtures/hold-plugin.ts', import.meta.url))
const HOLD_MODEL = fileURLToPath(new URL('./fixtures/hold-model-plugin.ts', import.meta.url))
const MISBEHAVE = fileURLToPath(new URL('./fixtures/misbehave-plugin.ts', import.meta.url))

let dirs: string[] = []
afterAll(() => {
  killSpawnedServes()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A ServeProcess over a child that is already dead the way POSIX reports a signal death; nothing is spawned. */
function deadBySignal(): ServeProcess {
  const client = Object.create(ServeProcess.prototype) as ServeProcess
  const child = { exitCode: null, signalCode: 'SIGSEGV' } as unknown as ChildProcess
  Object.assign(client, { child, frames: [], statuses: [], garbage: [], refusedAnswers: [], stderr: 'Segmentation fault' })
  return client
}

describe('ServeProcess.waitFor', () => {
  it('fails at once, naming the signal, when the host died by one', async () => {
    const started = Date.now()
    await expect(deadBySignal().waitFor(() => undefined, 'turn 1 to end', 2_000)).rejects.toThrowError(/serve exited \(signal SIGSEGV\) while waiting for turn 1 to end/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('fails a request sent to a host that is gone, instead of waiting out its deadline', async () => {
    await expect(deadBySignal().request('session/prompt', { text: 'hello' }, 60_000)).rejects.toThrowError(/session\/prompt was sent to a serve that had exited \(signal SIGSEGV\)/)
  })
})

/**
 * A home whose composition runs one whole turn with no key: the scripted model
 * calls `hold`, which returns at once (its release file exists), and answers.
 * `misbehave` adds the fixture row that makes the host go wrong one way.
 */
function scriptedHome(misbehave?: MisbehaveConfig): string {
  const home = tempDir('minidsh-serveproc-home-')
  const released = join(home, 'released')
  writeFileSync(released, '')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ agent: { provider: 'scripted', model: 'scripted-model' } }))
  writeFileSync(
    join(home, 'composition.json'),
    JSON.stringify({
      patches: [
        {
          insert: [
            { id: 'tool-hold', plugin: HOLD_TOOL, config: { releaseFile: released } },
            { id: 'llm-scripted-hold', plugin: HOLD_MODEL },
            ...(misbehave === undefined ? [] : [{ id: 'test-misbehave', plugin: MISBEHAVE, config: misbehave }]),
          ],
        },
      ],
    }),
  )
  return home
}

function locks(home: string): string[] {
  const sessions = join(home, 'sessions')
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
}

/** One scripted turn over the wire: prompt, a `hold` call answered, the turn's end. */
async function oneTurn(serve: ServeProcess): Promise<string> {
  const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: 'call hold' })
  const end = await serve.waitForCompletedTurn(sessionId, 1)
  expect((end.data as { reason: { kind: string } }).reason.kind, `stderr: ${serve.stderr}`).toBe('completed')
  return sessionId
}

describe('a spawned `minidsh serve`, as its test client sees it', () => {
  it('runs a turn, and after shutdown and the end of stdin exits by itself with code 0: no lease left, nothing on stdout but frames', { timeout: 120_000 }, async () => {
    const home = scriptedHome()
    const serve = new ServeProcess(tempDir('minidsh-serveproc-ws-'), home, { approve: true })
    const sessionId = await oneTurn(serve)
    expect(serve.events('tool/result', sessionId).map((event) => JSON.stringify(event.data)).join('\n'), 'the held call was answered').toContain('released')
    expect(locks(home), 'the running host holds its session').toHaveLength(1)

    expect(await serve.shutdown()).toEqual({ code: 0, signal: null })
    expect(endOf(serve.child)).toBe('code 0')
    expect(serve.garbage, 'stdout lines that were not frames').toEqual([])
    expect(serve.refusedAnswers).toEqual([])
    expect(locks(home), 'locks left behind').toEqual([])
  })

  it('fails shutdown on a host that never exits, saying so, rather than killing it in silence', { timeout: 120_000 }, async () => {
    const serve = new ServeProcess(tempDir('minidsh-serveproc-ws-'), scriptedHome({ strayHandle: true }), { approve: true })
    await oneTurn(serve)
    await expect(serve.shutdown(3_000)).rejects.toThrowError(/serve did not exit within 3000 ms of answering shutdown and the end of its stdin/)
    expect(endOf(serve.child), 'and it does not outlive the test').toBeDefined()
  })

  it('fails shutdown on an exit that is not code 0, naming the code', { timeout: 120_000 }, async () => {
    const serve = new ServeProcess(tempDir('minidsh-serveproc-ws-'), scriptedHome({ exitCode: 7 }), { approve: true })
    await oneTurn(serve)
    await expect(serve.shutdown()).rejects.toThrowError(/serve exited with code 7 after shutdown, not code 0/)
  })

  it('fails the next wait, and shutdown, on a stdout line that is not a frame, quoting the line', { timeout: 120_000 }, async () => {
    const serve = new ServeProcess(tempDir('minidsh-serveproc-ws-'), scriptedHome({ stdoutLine: 'a plugin printed this' }), { approve: true })
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: 'call hold' })
    await expect(serve.waitForCompletedTurn(sessionId, 1)).rejects.toThrowError(/serve wrote 1 stdout line\(s\) that are not JSON frames: "a plugin printed this"\nwhile waiting for turn 1 to end/)
    await expect(serve.shutdown()).rejects.toThrowError(/serve wrote 1 stdout line\(s\) that are not JSON frames: "a plugin printed this"/)
  })

  it('fails the wait on an approval answer the host refused, with the refusal, instead of timing out on an ask left open', { timeout: 120_000 }, async () => {
    // No --approve: the fixture's ask reaches this client. It offers no scope
    // (it has no subject), so an answer that takes one is refused by the host.
    const serve = new ServeProcess(tempDir('minidsh-serveproc-ws-'), scriptedHome({ askBeforeTools: true }), {})
    const stop = serve.answerApprovals('allowed-once', 'grant-session')
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: 'call hold' })
    await expect(serve.waitForCompletedTurn(sessionId, 1)).rejects.toThrowError(/serve refused 1 approval answer\(s\): \S+ \(allowed-once \+ grant-session\): approval\/answer failed: .*"grant-session" is not offered/)
    stop()
    expect(serve.events('approval/decided', sessionId), 'the ask is still open: that is what the turn was parked on').toEqual([])
    await serve.kill()
  })

  it('answers the same ask without the scope, and the turn completes: the refusal above was the answer, not the ask', { timeout: 120_000 }, async () => {
    const serve = new ServeProcess(tempDir('minidsh-serveproc-ws-'), scriptedHome({ askBeforeTools: true }), {})
    const stop = serve.answerApprovals('allowed-once')
    const sessionId = await oneTurn(serve)
    stop()
    expect(serve.events('approval/decided', sessionId)).toHaveLength(1)
    expect(await serve.shutdown()).toEqual({ code: 0, signal: null })
  })
})
