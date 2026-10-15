/**
 * The terminal's background-job commands over the real wire: the job is a
 * real shell child, only the model is scripted, and what is asserted is what
 * a person reads — and that a person's stop never woke the agent.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { runTerminal } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const dialect = process.platform === 'win32' ? 'pwsh' : 'bash'
/** The host dialect's binary; `shell.test.ts` turns a missing one into a failure under MINIDSH_EXPECT_SHELL, so a skip here hides nothing. */
const shellAvailable = spawnSync(dialect, ['--version'], { stdio: 'ignore' }).status === 0
const LONG = dialect === 'pwsh' ? 'Start-Sleep -Seconds 60' : 'sleep 60'

let dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs) {
    // A killed job's process tree can hold its working directory for a moment on Windows.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 40) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.runIf(shellAvailable)('terminal: background jobs', () => {
  it('lists a running job, stops it over the wire, and says its notice is held without waking the agent', { timeout: 120_000 }, async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk: Buffer) => void (text += String(chunk)))
    const type = (line: string): void => void input.write(`${line}\n`)
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'job_start', { command: LONG }), assistantText('the server is starting'))
    const exitCode = runTerminal({
      cwd: tempDir('minidsh-term-jobs-cwd-'),
      sessionsRoot: tempDir('minidsh-term-jobs-sessions-'),
      // A host with no confinement backend, accepting that: every CI leg can run it.
      confinement: 'none',
      accepts: 'none',
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true as const }],
      prepare: (root: Context) => void root.get(LLM).registerAdapter(root, adapter),
      provider: 'scripted',
      model: 'scripted-model',
      io: { input, output },
    })
    await waitFor(() => text.includes('you> '), 'the first prompt')
    type('start the dev server')
    await waitFor(() => text.includes('the server is starting'), 'the answer')

    // The listing reads the last published view, so ask until one names the job.
    let line: string | undefined
    for (let attempt = 0; attempt < 50 && line === undefined; attempt++) {
      const mark = text.length
      type('/jobs')
      await waitFor(() => /no background jobs|job-[0-9a-f]{16}/.test(text.slice(mark)), 'an answer to /jobs')
      line = text
        .slice(mark)
        .split('\n')
        .find((entry) => /^running \(pid \d+\)/.test(entry))
      if (line === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(line).toContain(LONG)
    const jobId = /job-[0-9a-f]{16}/.exec(line!)![0]

    type(`/jobs cancel ${jobId}`)
    await waitFor(() => text.includes(`job ${jobId}: stopped by the user`), 'the stop being reported')
    // The person's stop is delivered quiet: the agent stays idle, and the terminal says why nothing happened.
    await waitFor(() => text.includes('a job notice is held; your next message delivers it'), 'the held-notice hint')
    expect(text.split('a job notice is held').length - 1).toBe(1)
    type('/jobs')
    await waitFor(() => text.includes('(notice held)'), 'the held mark in /jobs')
    expect(adapter.calls).toHaveLength(2)

    type('/jobs cancel')
    await waitFor(() => text.includes('usage: /jobs cancel <job-id>'), 'the usage line')
    type('/exit')
    expect(await exitCode).toBe(0)
  })
})
