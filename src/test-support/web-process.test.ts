/**
 * The `minidsh web` test client, held to what it is for: a host that goes
 * wrong must fail the test that met it, with what was seen. `web --json`
 * promises a supervisor that stdout carries records and nothing else; the
 * client used to drop a line that was not one once `ready` had resolved, so
 * "stdout carried only these records" compared a list the line never entered.
 *
 * Keyless: the real binary is spawned with the from-disk scripted model the
 * `web --json` tests use, and `fixtures/misbehave-plugin.ts` makes it go wrong.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MisbehaveConfig } from './fixtures/misbehave-plugin.ts'
import { killSpawnedWebHosts, WebHostProcess } from './web-process.ts'

const HOLD_TOOL = fileURLToPath(new URL('./fixtures/hold-plugin.ts', import.meta.url))
const HOLD_MODEL = fileURLToPath(new URL('./fixtures/hold-model-plugin.ts', import.meta.url))
const MISBEHAVE = fileURLToPath(new URL('./fixtures/misbehave-plugin.ts', import.meta.url))
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

/** A home that runs one whole scripted turn (`hold` returns at once), with the fixture row that misbehaves one way. */
function scriptedHome(misbehave: MisbehaveConfig): string {
  const home = tempDir('minidsh-webproc-home-')
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
            { id: 'test-misbehave', plugin: MISBEHAVE, config: misbehave },
          ],
        },
      ],
    }),
  )
  return home
}

describe('a spawned `minidsh web --json`, as its test client sees it', () => {
  it('fails the wait for the exit on a stdout line that is not a record, written AFTER ready, quoting the line', { timeout: 90_000 }, async () => {
    const host = new WebHostProcess(tempDir('minidsh-webproc-ws-'), scriptedHome({ stdoutLineOnStop: 'a plugin printed this while stopping' }), { json: true })
    await host.ready()
    expect(host.garbage, 'nothing but the ready record so far').toEqual([])
    await expect(host.stop(STOP_MS)).rejects.toThrowError(/web --json wrote 1 stdout line\(s\) that are not JSON records: "a plugin printed this while stopping"/)
    // The records list alone, which is what the tests compared, never saw it.
    expect(host.records.map((record) => record.type)).toEqual(['ready'])
    expect(await host.exited, 'the host itself stopped cleanly').toEqual({ code: 0, signal: null })
  })

  it('still fails ready() on such a line written before the ready record', { timeout: 90_000 }, async () => {
    const host = new WebHostProcess(tempDir('minidsh-webproc-ws-'), scriptedHome({ stdoutLine: 'a plugin printed this at boot' }), { json: true })
    await expect(host.ready()).rejects.toThrowError(/web --json wrote a line that is not JSON: "a plugin printed this at boot"/)
    expect(host.garbage).toEqual(['a plugin printed this at boot'])
    host.kill()
    await host.exited
  })

  it('fails the wait on an approval answer the host refused, with the refusal', { timeout: 90_000 }, async () => {
    // No --approve: the fixture's ask reaches the client. It offers no scope, so an answer that takes one is refused.
    const host = new WebHostProcess(tempDir('minidsh-webproc-ws-'), scriptedHome({ askBeforeTools: true }), { json: true })
    const client = await host.connect()
    const stop = client.answerApprovals('allowed-once', 'grant-session')
    const { sessionId } = await client.request<{ sessionId: string }>('session/prompt', { text: 'call hold' })
    await expect(client.waitForCompletedTurn(sessionId, 1)).rejects.toThrowError(/the host refused 1 approval answer\(s\): \S+ \(allowed-once \+ grant-session\): approval\/answer failed: .*"grant-session" is not offered/)
    stop()
    expect(client.events('approval/decided', sessionId), 'the ask is still open').toEqual([])
    client.close()
    host.kill()
    await host.exited
  })

  it('answers the same ask without the scope, the turn completes and the host stops with nothing but records on stdout', { timeout: 90_000 }, async () => {
    const host = new WebHostProcess(tempDir('minidsh-webproc-ws-'), scriptedHome({ askBeforeTools: true }), { json: true })
    const client = await host.connect()
    const stop = client.answerApprovals('allowed-once')
    const { sessionId } = await client.request<{ sessionId: string }>('session/prompt', { text: 'call hold' })
    const end = await client.waitForCompletedTurn(sessionId, 1)
    stop()
    expect((end.data as { reason: { kind: string } }).reason.kind, `stderr: ${host.stderr}`).toBe('completed')
    expect(client.refusedAnswers).toEqual([])
    client.close()
    expect(await host.stop(STOP_MS), `stderr: ${host.stderr}`).toEqual({ code: 0, signal: null })
    expect(host.garbage).toEqual([])
  })
})
