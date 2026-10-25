/**
 * The live arcs' client gives up the moment its host is gone — by an exit
 * code OR by a signal. On Linux and macOS, where live.yml runs, a host killed
 * by the OOM killer or crashed by SIGSEGV has `exitCode` null and `signalCode`
 * set; a wait that read only the exit code then sat out its whole deadline and
 * reported "timed out" instead of "serve exited".
 */
import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { ServeProcess } from './serve-process.ts'

/** A ServeProcess over a child that is already dead the way POSIX reports a signal death; nothing is spawned. */
function deadBySignal(): ServeProcess {
  const client = Object.create(ServeProcess.prototype) as ServeProcess
  const child = { exitCode: null, signalCode: 'SIGSEGV' } as unknown as ChildProcess
  Object.assign(client, { child, frames: [], statuses: [], stderr: 'Segmentation fault' })
  return client
}

describe('ServeProcess.waitFor', () => {
  it('fails at once, naming the signal, when the host died by one', async () => {
    const started = Date.now()
    await expect(deadBySignal().waitFor(() => undefined, 'turn 1 to end', 2_000)).rejects.toThrowError(/serve exited \(signal SIGSEGV\) while waiting for turn 1 to end/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
