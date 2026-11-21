/**
 * The job tools over a REAL shell child: only the model is scripted. The
 * model learns a job's id the way a real one does — from `job_start`'s result
 * or from the notice that arrives in its inbox — and every claim is checked
 * against the workspace and the session log.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText, assistantToolCall } from '../../test-support/scripted-adapter.ts'
import { AGENTS, INBOX_SPLICED, type Agent } from '../../core/agent/index.ts'
import { JOB_END, JOB_START } from '../../core/jobs/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import type { LlmRequest } from '../../core/llm/types.ts'
import { matches, TOOL_RESULT, TURN_START, type EventEnvelope } from '../../core/session/index.ts'
import { SPILL } from '../../core/spill/index.ts'
import { TOOLS } from '../../core/tools/index.ts'
import { shellStdioPlugin, type ShellDialect } from '../shell-stdio/index.ts'
import { spillLocalPlugin } from '../spill-local/index.ts'
import { toolJobsPlugin } from './index.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const available = spawnSync(dialect, ['--version'], { stdio: 'ignore' }).status === 0
const TIMEOUT_MS = 120_000
const ps = dialect === 'pwsh'
const WRITE_MARKER = ps ? 'Start-Sleep -Milliseconds 300; Set-Content -Path marker.txt -Value done; Write-Output done' : 'sleep 0.3; echo done > marker.txt; echo done'
const SLOW = ps ? 'Start-Sleep -Milliseconds 1000; Write-Output slow-done' : 'sleep 1; echo slow-done'
const LONG = ps ? 'Start-Sleep -Seconds 60' : 'sleep 60'

let harness: CoreHarness | undefined
const dirs: string[] = []
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  for (const dir of dirs.splice(0)) {
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
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function setup(accepts: 'full' | 'none' = 'none'): Promise<{ h: CoreHarness; agent: Agent; workspace: string; spill: string }> {
  // A host with no confinement backend, accepting that — the Windows shape,
  // and the only one every CI leg can run without a backend.
  const h = await coreHarness({ sandbox: { accepts }, jobs: { stopWaitMs: 2_000 } })
  harness = h
  h.root.plugin(shellStdioPlugin, { dialect, confinement: 'none' })
  const spill = temp('minidsh-jobs-spill-')
  h.root.plugin(spillLocalPlugin, { root: spill })
  h.root.plugin(toolJobsPlugin, {})
  await h.root.settle()
  const workspace = temp('minidsh-jobs-ws-')
  const handle = await h.create({ cwd: workspace })
  return { h, agent: handle.agent, workspace, spill }
}

/** Idle, once the log shows what the case is waiting for — idleness alone returns before a job ends. */
async function settled(agent: Agent, done: (events: readonly EventEnvelope[]) => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (done(agent.session.events) && agent.status === 'idle') {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (agent.status === 'idle') return
    }
    if (Date.now() > deadline) throw new Error(`timed out with the agent ${agent.status}: ${agent.session.events.map((event) => event.type).join(' ')}`)
  }
}
const ended = (events: readonly EventEnvelope[]): boolean => events.some((event) => matches(event, JOB_END))
const turns = (n: number) => (events: readonly EventEnvelope[]): boolean => events.filter((event) => event.type === 'turn/end').length >= n
/** The notices a job sent: inserts carrying a job's derived message id, never the prompts. */
const notices = (agent: Agent): EventEnvelope[] =>
  agent.session.events.filter((event) => matches(event, INBOX_SPLICED) && event.data.op === 'insert' && event.data.message.id.startsWith('msg-job-'))

/** The id the model would read: from `job_start`'s result, or from the notice that woke it. */
function jobIdIn(request: LlmRequest): string {
  const text = JSON.stringify(request.messages.at(-1))
  const match = /job-[0-9a-f]{16}/.exec(text)
  if (!match) throw new Error(`no job id in the last message: ${text.slice(0, 300)}`)
  return match[0]
}

const results = (agent: Agent): EventEnvelope[] => agent.session.events.filter((event) => matches(event, TOOL_RESULT))
const text = (event: EventEnvelope): string => JSON.stringify(event.data)
const resultOf = (agent: Agent, callId: string): EventEnvelope => results(agent).find((event) => (event.data as { callId: string }).callId === callId)!

describe.runIf(available)('the job tools', () => {
  it("start a job, and its own end wakes the agent, which reads what it wrote", { timeout: TIMEOUT_MS }, async () => {
    const { h, agent, workspace } = await setup()
    h.adapter.script(
      assistantToolCall('c1', 'job_start', { command: WRITE_MARKER }),
      assistantText('started; I will wait to be told'),
      (request) => assistantToolCall('c2', 'job_output', { job_id: jobIdIn(request) }),
      assistantText('the job wrote done'),
    )
    agent.followup(createUserMessage('run it in the background'))
    await settled(agent, turns(2))

    expect(existsSync(join(workspace, 'marker.txt')), 'the job ran in the workspace').toBe(true)
    const start = agent.session.events.find((event) => matches(event, JOB_START))!
    expect(start.data).toMatchObject({ callId: 'c1', kind: 'shell', mode: 'workspace-write', enforcement: 'none' })
    expect(agent.session.events.find((event) => matches(event, JOB_END))!.data).toMatchObject({ cause: 'exited', exitCode: 0 })
    expect(agent.session.events.filter((event) => matches(event, TURN_START)), 'the end woke a second turn').toHaveLength(2)
    const read = resultOf(agent, 'c2')
    expect(text(read)).toContain('done')
    expect(text(read)).toContain('[status: exited with code 0')
  })

  it('a wait the end releases reports it, and no notice follows', { timeout: TIMEOUT_MS }, async () => {
    const { h, agent } = await setup()
    h.adapter.script(
      assistantToolCall('c1', 'job_start', { command: SLOW }),
      (request) => assistantToolCall('c2', 'job_output', { job_id: jobIdIn(request), wait_ms: 30_000 }),
      assistantText('it finished'),
    )
    agent.followup(createUserMessage('run and wait'))
    await settled(agent, ended)
    expect(agent.session.events.find((event) => matches(event, JOB_END))!.data).toMatchObject({ cause: 'exited', exitCode: 0, reportedBy: 'c2' })
    const read = resultOf(agent, 'c2')
    expect(text(read)).toContain('slow-done')
    expect(notices(agent)).toHaveLength(0)
    expect(agent.session.events.filter((event) => matches(event, TURN_START))).toHaveLength(1)
  })

  /**
   * A job's output is held in memory only as a tail (`core/jobs`, 64 KiB); the
   * rest is in its file. A read that reaches past the tail must say how much
   * it no longer has and where the whole is, or the model takes the last part
   * of a long log for all of it. No test printed more than a line (S22.5 audit).
   */
  it('a read past the in-memory tail says how many characters it no longer holds, and names the file that has them all', { timeout: TIMEOUT_MS }, async () => {
    const { h, agent } = await setup()
    // `head-of-output`, 200,000 characters, `end-of-output`: more than three tails.
    const flood = ps
      ? "Write-Output ('head-of-output' + ('x' * 200000) + 'end-of-output')"
      : "printf head-of-output; head -c 200000 /dev/zero | tr '\\0' x; echo end-of-output"
    h.adapter.script(
      assistantToolCall('c1', 'job_start', { command: flood }),
      (request) => assistantToolCall('c2', 'job_output', { job_id: jobIdIn(request), wait_ms: 60_000 }),
      assistantText('read it'),
    )
    agent.followup(createUserMessage('run and read'))
    await settled(agent, ended)
    const start = agent.session.events.find((event) => matches(event, JOB_START))!.data as { output?: string }
    expect(start.output, 'the job has no output file to point at').toBeDefined()
    const whole = readFileSync(start.output!, 'utf8')
    expect(whole).toContain('head-of-output')
    const read = (resultOf(agent, 'c2').data as { message: { content: { content: { text: string }[] }[] } }).message.content[0]!.content[0]!.text
    const lost = /^\[([\d,]+) earlier characters are no longer held in memory; the whole output is in (.+)\]$/m.exec(read)
    expect(lost, `the read does not say what it left out: ${read.slice(0, 300)}`).not.toBeNull()
    // Everything but the tail, counted in the characters the job wrote.
    expect(Number(lost![1]!.replaceAll(',', '')), `of ${whole.length} characters written`).toBe(whole.length - 64 * 1024)
    expect(lost![2]).toBe(start.output)
    // What it does show is the END of the output, never its head.
    expect(read).toContain('end-of-output')
    expect(read).not.toContain('head-of-output')
  })

  /**
   * A file that stopped short is never called the whole output. `core/jobs`
   * marks it (`outputPartial`) when the store could not write, or past its
   * own size cap; the store here is staged to stop after its first write,
   * which is the first of those, and the read must not point at the file as
   * if everything were in it.
   */
  it('a read whose output file stopped short says the file holds only part, and never calls it complete', { timeout: TIMEOUT_MS }, async () => {
    const h = await coreHarness({ sandbox: { accepts: 'none' }, jobs: { stopWaitMs: 2_000 } })
    harness = h
    const dir = temp('minidsh-jobs-short-')
    const path = join(dir, 'job-output.txt')
    let writes = 0
    h.root.plugin({
      name: 'spill-that-stops-short',
      apply(ctx) {
        ctx.provide(SPILL, {
          save: () => {
            throw new Error('not used by a job')
          },
          open: () => ({
            path,
            get failed() {
              return writes > 1
            },
            write(chunk: string) {
              // The first write lands; the disk is "full" from the second on.
              if (writes++ === 0) writeFileSync(path, chunk)
            },
            close() {},
          }),
        })
      },
    })
    h.root.plugin(shellStdioPlugin, { dialect, confinement: 'none' })
    h.root.plugin(toolJobsPlugin, {})
    await h.root.settle()
    const { agent } = await h.create({ cwd: temp('minidsh-jobs-ws-') })
    // Two writes at least, and more than the in-memory tail in all.
    const flood = ps
      ? "Write-Output first; Start-Sleep -Milliseconds 300; Write-Output ('x' * 200000)"
      : "echo first; sleep 0.3; head -c 200000 /dev/zero | tr '\\0' x; echo"
    h.adapter.script(
      assistantToolCall('c1', 'job_start', { command: flood }),
      (request) => assistantToolCall('c2', 'job_output', { job_id: jobIdIn(request), wait_ms: 60_000 }),
      assistantText('read it'),
    )
    agent.followup(createUserMessage('run and read'))
    await settled(agent, ended)
    expect(writes, 'the staged store was never asked to write twice, so it never stopped short').toBeGreaterThan(1)
    const read = (resultOf(agent, 'c2').data as { message: { content: { content: { text: string }[] }[] } }).message.content[0]!.content[0]!.text
    expect(read).toContain(`earlier characters are no longer held in memory; ${path} holds only part of it]`)
    expect(read, 'a partial file was called the complete output').not.toContain('complete output is saved')
    expect(read).not.toContain('the whole output is in')
  })

  it('cancel stops a running job and is the report of its end', { timeout: TIMEOUT_MS }, async () => {
    const { h, agent } = await setup()
    h.adapter.script(
      assistantToolCall('c1', 'job_start', { command: LONG }),
      (request) => assistantToolCall('c3', 'job_cancel', { job_id: jobIdIn(request) }),
      assistantText('stopped it'),
    )
    agent.followup(createUserMessage('start then stop'))
    await settled(agent, ended)
    expect(agent.session.events.find((event) => matches(event, JOB_END))!.data).toMatchObject({ cause: 'cancelled', by: 'model', reportedBy: 'c3' })
    expect(text(resultOf(agent, 'c3'))).toContain('stopped')
    expect(notices(agent)).toHaveLength(0)
  })

  it('refuses a job this host cannot run under what the session accepts, and never offers an escalation', { timeout: TIMEOUT_MS }, async () => {
    const { h, agent, spill } = await setup('full')
    h.adapter.script(assistantToolCall('c1', 'job_start', { command: SLOW }), assistantText('refused'))
    agent.followup(createUserMessage('try'))
    await settled(agent, turns(1))
    const result = text(results(agent)[0]!)
    expect(result).toContain('SANDBOX_UNAVAILABLE')
    expect(result).toContain('cannot be escalated')
    expect(agent.session.events.filter((event) => matches(event, JOB_START))).toHaveLength(0)
    expect(readdirSync(spill), 'a refusal leaves no output file behind').toEqual([])
  })

  it("answers for a job of an earlier run from the log, which outlives the registry", { timeout: TIMEOUT_MS }, async () => {
    const { h, agent } = await setup()
    h.adapter.script(assistantToolCall('c1', 'job_start', { command: SLOW }), assistantText('started'), assistantText('noted the end'))
    agent.followup(createUserMessage('go'))
    await settled(agent, turns(2))
    const jobId = (agent.session.events.find((event) => matches(event, JOB_START))!.data as { jobId: string }).jobId
    const fork = await h.root.get(AGENTS).fork(h.root, agent.session)
    h.adapter.script(assistantToolCall('c9', 'job_output', { job_id: jobId }), assistantText('ok'))
    fork.agent.followup(createUserMessage('what about that job?'))
    await settled(fork.agent, (events) => events.filter((event) => event.type === 'turn/end').length >= 3)
    const read = text(fork.agent.session.events.filter((event) => matches(event, TOOL_RESULT)).at(-1)!)
    expect(read).toContain('earlier run of this session')
    expect(read).toContain('exited with code 0')
    await fork.dispose()
  })
})

/**
 * What `job_start` tells the model must be what a job's end does. Until S21.1
 * a Windows job left a program it had started running, and the description
 * said so; since the kill-on-close Job it ends with the job on every platform
 * (`shell-stdio/job.test.ts` pins that), and a model still told the old rule
 * started a server from a job's command and found it dead.
 */
describe('what job_start says about a job and what it starts', () => {
  it('states the one rule every platform has: what a job started ends with it', async () => {
    const { h } = await setup()
    const description = h.root.get(TOOLS).schemas().find((schema) => schema.name === 'job_start')!.description
    expect(description).toContain('what it started is stopped with it')
    expect(description).toContain("run a server AS the job's command")
    expect(description, 'the pre-S21.1 Windows exception is still told to the model').not.toMatch(/on Windows[^.]*not stopped/)
  })
})
