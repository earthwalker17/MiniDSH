/**
 * A recording with background jobs replays by the LOG, not the clock: the
 * recording's notices re-enter exactly the steps that took them — one a busy
 * turn claimed at its next step, one that woke a turn of its own — while no
 * process runs at all.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shellStdioPlugin, type ShellDialect } from '../capabilities/shell-stdio/index.ts'
import { toolJobsPlugin } from '../capabilities/tool-jobs/index.ts'
import { AGENTS, type Agent } from '../core/agent/index.ts'
import { asMessageId } from '../core/ids.ts'
import { JOB_END, JOB_START, noticeJobId } from '../core/jobs/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { matches, TURN_END, USER_MESSAGE, type EventEnvelope } from '../core/session/index.ts'
import { coreHarness, type CoreHarness } from './harness.ts'
import { installLlmReplay, recordedNotices } from './llm-replay.ts'
import { assistantText, assistantToolCall } from './scripted-adapter.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const available = spawnSync(dialect, ['--version'], { stdio: 'ignore' }).status === 0
const QUICK = dialect === 'pwsh' ? 'Start-Sleep -Milliseconds 300; Write-Output a' : 'sleep 0.3; echo a'
// Ends only after the file the recording's last turn-1 step writes, plus a
// margin for that turn to close: so its notice wakes turn 2 on any host load.
const SLOW =
  dialect === 'pwsh'
    ? 'while (-not (Test-Path go)) { Start-Sleep -Milliseconds 100 }; Start-Sleep -Milliseconds 1500; Write-Output b'
    : 'while [ ! -f go ]; do sleep 0.1; done; sleep 1.5; echo b'

const harnesses: CoreHarness[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** `provider`: the replay answers under its own name, beside the harness's scripted adapter. */
async function world(provider = 'scripted'): Promise<{ h: CoreHarness; agent: Agent }> {
  const h = await coreHarness({ sandbox: { accepts: 'none' } })
  harnesses.push(h)
  h.root.plugin(shellStdioPlugin, { dialect, confinement: 'none' })
  h.root.plugin(toolJobsPlugin, {})
  await h.root.settle()
  const cwd = mkdtempSync(join(tmpdir(), 'minidsh-replay-jobs-'))
  dirs.push(cwd)
  const handle = await h.root.get(AGENTS).create(h.root, { cwd, agentOptions: { provider, model: 'scripted-model' } })
  return { h, agent: handle.agent }
}

async function turnsEnded(agent: Agent, n: number): Promise<void> {
  const deadline = Date.now() + 60_000
  while (agent.session.events.filter((event) => matches(event, TURN_END)).length < n || agent.status !== 'idle') {
    if (Date.now() > deadline) throw new Error(`timed out: ${agent.session.events.map((event) => event.type).join(' ')}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const entered = (events: readonly EventEnvelope[]): string[] =>
  events.filter((event) => matches(event, USER_MESSAGE)).map((event) => (event.data as { message: { id: string } }).message.id)

describe.runIf(available)('replaying a log with background jobs', () => {
  it('re-delivers each recorded notice where the recording claimed it, with no process run', { timeout: 120_000 }, async () => {
    const recording = await world()
    recording.h.adapter.script(
      assistantToolCall('c1', 'job_start', { command: QUICK }),
      assistantToolCall('c2', 'job_start', { command: SLOW }),
      // A model call that returns only once the quick job HAS ended: its notice
      // lands while this turn is busy, so it is taken at the NEXT step of the
      // same turn. Waiting on the log, not a clock — a loaded host starts a
      // shell in seconds.
      async () => {
        const deadline = Date.now() + 60_000
        while (!recording.agent.session.events.some((event) => matches(event, JOB_END))) {
          if (Date.now() > deadline) throw new Error('the quick job never ended')
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        return assistantText('waiting')
      },
      () => {
        writeFileSync(join(recording.agent.session.header.cwd, 'go'), '')
        return assistantText('saw a')
      },
      // The slow job ends with the agent idle: its notice wakes turn 2.
      assistantText('saw b'),
    )
    recording.agent.followup(createUserMessage('start two jobs'))
    await turnsEnded(recording.agent, 2)
    const recorded = recording.agent.session.events
    const notices = recordedNotices(recorded)
    expect(notices.map(({ turn, step, waking }) => ({ turn, step, waking }))).toEqual([
      { turn: 1, step: 4, waking: true },
      { turn: 2, step: 1, waking: true },
    ])

    const replay = await world('replay')
    const handle = installLlmReplay(replay.h.root, { events: recorded, provider: 'replay', effects: 'recorded' })
    replay.agent.followup(createUserMessage('start two jobs'))
    await turnsEnded(replay.agent, 2)
    handle.assertConsumed()
    expect(entered(replay.agent.session.events).map((id) => noticeJobId({ id: asMessageId(id) }) ?? 'prompt')).toEqual(
      entered(recorded).map((id) => noticeJobId({ id: asMessageId(id) }) ?? 'prompt'),
    )
    expect(replay.agent.session.events.some((event) => matches(event, JOB_START)), 'nothing ran').toBe(false)
  })

  it("refuses to replay a jobs log with its bodies running: a real job's timing is the clock's", async () => {
    const { h } = await world()
    const events: EventEnvelope[] = [{ type: JOB_START.type, seq: 0, time: 0, data: { jobId: 'job-x', kind: 'shell', label: 'x', mode: 'read-only', enforcement: 'full' } }]
    expect(() => installLlmReplay(h.root, { events, provider: 'replay' })).toThrow(/effects: 'recorded'/)
  })
})
