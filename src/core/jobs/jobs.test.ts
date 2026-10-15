/**
 * The jobs registry against the real core composition: only the model and the
 * process are fakes. Every claim is read back from the session LOG — the
 * bracket, the notice's delivery, what a resume or a fork is told — because
 * the log is what a resumed session, a replay and an audit will have.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { persistenceJsonlPlugin } from '../../capabilities/persistence-jsonl/index.ts'
import { verifyStored } from '../../app/inspect.ts'
import { assistantText, assistantToolCall } from '../../test-support/scripted-adapter.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { AGENTS, INBOX_SPLICED, repairTail, type Agent } from '../agent/index.ts'
import { createUserMessage } from '../llm/message.ts'
import { PERSISTENCE } from '../persistence/index.ts'
import { SANDBOX } from '../sandbox/index.ts'
import { matches, SESSION_FLUSH, TURN_END, TURN_START, USER_MESSAGE, type EventEnvelope } from '../session/index.ts'
import { defineTool, TOOLS } from '../tools/index.ts'
import {
  closeUnpairedJobs,
  foldJobs,
  foldJobWakes,
  JOB_END,
  JOB_START,
  jobNoticeId,
  JOBS,
  type JobExit,
  type JobProcess,
  type Jobs,
  type JobsConfig,
} from './index.ts'
import { checkJobsLog } from './invariant.ts'

/** A process that ends when the test says so — or, `dies: false`, never. */
class FakeProcess implements JobProcess {
  readonly pid = 4242
  readonly mode = 'workspace-write' as const
  readonly enforcement = 'full' as const
  readonly exited: Promise<JobExit>
  kills = 0
  readonly output: (chunk: string) => void
  private readonly dies: boolean
  private finish!: (exit: JobExit) => void
  constructor(output: (chunk: string) => void, dies = true) {
    this.output = output
    this.dies = dies
    this.exited = new Promise((resolve) => (this.finish = resolve))
  }
  kill(): void {
    this.kills++
    if (this.dies) queueMicrotask(() => this.finish({ signal: 'SIGKILL' }))
  }
  exit(exit: JobExit = { exitCode: 0 }): void {
    this.finish(exit)
  }
}

let harness: CoreHarness | undefined
const dirs: string[] = []
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(jobs: JobsConfig = {}, persist = false): Promise<{ h: CoreHarness; agent: Agent; jobs: Jobs; store?: string }> {
  const h = await coreHarness({ jobs: { stopWaitMs: 200, ...jobs } })
  harness = h
  let store: string | undefined
  if (persist) {
    store = mkdtempSync(join(tmpdir(), 'minidsh-jobs-'))
    dirs.push(store)
    h.root.plugin(persistenceJsonlPlugin, { root: store })
    await h.root.settle()
  }
  const handle = await h.create()
  return { h, agent: handle.agent, jobs: h.root.get(JOBS), ...(store === undefined ? {} : { store }) }
}

/** Starts a fake job; the process is handed back once launched. */
async function launch(jobs: Jobs, agent: Agent, options: { label?: string; callId?: string; dies?: boolean } = {}): Promise<{ jobId: string; process: FakeProcess }> {
  let process!: FakeProcess
  const view = await jobs.start({
    agent,
    kind: 'shell',
    label: options.label ?? 'npm test',
    ...(options.callId === undefined ? {} : { callId: options.callId }),
    launch: async (output) => (process = new FakeProcess(output, options.dies ?? true)),
  })
  return { jobId: view.jobId, process }
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function quiesce(agent: Agent): Promise<void> {
  await tick()
  await agent.whenIdle()
  await tick()
}
const ofType = (agent: Agent, type: string): EventEnvelope[] => agent.session.events.filter((event) => event.type === type)
const inserts = (agent: Agent): { op: string; waking?: boolean; message: { id: string } }[] =>
  ofType(agent, INBOX_SPLICED.type).map((event) => event.data as never).filter((splice: { op: string }) => splice.op === 'insert')

describe('the job bracket', () => {
  it('records the start once the process spawned, and the end exactly once, before its notice', async () => {
    const { agent, jobs, h } = await setup()
    h.adapter.script(assistantText('noted'))
    const { jobId, process } = await launch(jobs, agent, { callId: 'c-start' })
    expect(jobId).toMatch(/^job-[0-9a-f]{16}$/)
    const [start] = ofType(agent, JOB_START.type)
    expect(start!.data).toEqual({ jobId, callId: 'c-start', kind: 'shell', label: 'npm test', pid: 4242, mode: 'workspace-write', enforcement: 'full' })

    process.output('PASS 12 tests\n')
    process.exit({ exitCode: 0 })
    process.exit({ exitCode: 3 }) // a second report changes nothing: first-wins
    await quiesce(agent)

    const ends = ofType(agent, JOB_END.type)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).toMatchObject({ jobId, cause: 'exited', exitCode: 0, outputBytes: 14 })
    const notice = agent.session.events.find((event) => matches(event, INBOX_SPLICED) && event.data.op === 'insert')!
    expect(notice.seq, 'no log holds a notice before its cause').toBeGreaterThan(ends[0]!.seq)
    expect(checkJobsLog(agent.session.events)).toBeUndefined()
  })

  it('refuses a start past the per-owner cap, and leaves nothing behind for a launch that throws', async () => {
    const { agent, jobs } = await setup({ maxPerOwner: 1 })
    await expect(
      jobs.start({ agent, kind: 'shell', label: 'x', launch: async () => Promise.reject(new Error('SHELL_UNAVAILABLE: no pwsh')) }),
    ).rejects.toThrow('no pwsh')
    await launch(jobs, agent)
    await expect(launch(jobs, agent)).rejects.toMatchObject({ code: 'JOB_LIMIT' })
    expect(ofType(agent, JOB_START.type), 'a refused or failed start records nothing').toHaveLength(1)
  })
})

describe('delivery through the inbox', () => {
  it("wakes an idle owner with a job's own end, and the woken turn enters the notice", async () => {
    const { agent, jobs, h } = await setup()
    h.adapter.script(assistantText('the tests passed'))
    const { jobId, process } = await launch(jobs, agent)
    process.exit({ exitCode: 0 })
    await quiesce(agent)

    expect(inserts(agent)).toMatchObject([{ op: 'insert', waking: true, message: { id: jobNoticeId(jobId) } }])
    const entered = ofType(agent, USER_MESSAGE.type).map((event) => event.data as { message: { id: string; content: { text: string }[] } })
    expect(entered.map((data) => data.message.id)).toEqual([jobNoticeId(jobId)])
    expect(entered[0]!.message.content[0]!.text).toContain('exited with code 0')
    expect(h.adapter.calls).toHaveLength(1)
    expect(foldJobs(agent.session.events)[0]!.notice).toMatchObject({ waking: true, state: 'claimed' })
  })

  it("claims a busy owner's notice at the next step of the SAME turn", async () => {
    const { agent, jobs, h } = await setup()
    const { jobId, process } = await launch(jobs, agent)
    // A tool whose body ends the job mid-step: the notice lands while the turn is running.
    h.root.get(TOOLS).register(
      h.root,
      defineTool({
        name: 'finish_job',
        description: 'test',
        input: z.object({}),
        output: z.string(),
        render: () => [{ type: 'text', text: 'ok' }],
        execute: async () => {
          process.exit({ exitCode: 0 })
          await tick()
          return 'ok'
        },
      }),
    )
    h.adapter.script(assistantToolCall('c1', 'finish_job', {}), assistantText('done'))
    agent.followup(createUserMessage('go'))
    await quiesce(agent)
    expect(ofType(agent, TURN_START.type), 'no second turn').toHaveLength(1)
    const step2 = h.adapter.calls[1]!.messages.at(-1)!
    expect(step2.id).toBe(jobNoticeId(jobId))
  })

  it('cannot strand a notice in the retirement window: an end during the final flush still wakes', async () => {
    const { agent, jobs, h } = await setup()
    const { process } = await launch(jobs, agent)
    let fired = false
    h.root.on(SESSION_FLUSH, async (session) => {
      const last = session.events.at(-1)
      if (!fired && last !== undefined && matches(last, TURN_END)) {
        fired = true
        process.exit({ exitCode: 0 })
        await tick()
      }
    })
    h.adapter.script(assistantText('first'), assistantText('woken'))
    agent.followup(createUserMessage('go'))
    await quiesce(agent)
    await quiesce(agent)
    expect(fired).toBe(true)
    expect(ofType(agent, TURN_START.type)).toHaveLength(2)
  })

  it('stops waking past the budget, holds the notice visibly, and the next human message delivers it', async () => {
    const { agent, jobs, h } = await setup({ maxWakes: 1 })
    h.adapter.script(assistantText('first woken'))
    const one = await launch(jobs, agent)
    const two = await launch(jobs, agent)
    one.process.exit({ exitCode: 0 })
    await quiesce(agent)
    expect(foldJobWakes(agent.session.facts)).toBe(1)
    two.process.exit({ exitCode: 1 })
    await quiesce(agent)
    expect(ofType(agent, TURN_START.type), 'the budget is spent: no second paid turn').toHaveLength(1)
    const held = foldJobs(agent.session.events).find((job) => job.start.jobId === two.jobId)!.notice
    expect(held).toMatchObject({ waking: false, state: 'queued' })

    h.adapter.script(assistantText('saw both'))
    agent.followup(createUserMessage('what happened?'))
    await quiesce(agent)
    const lastRequest = h.adapter.calls.at(-1)!.messages.map((message) => message.id)
    expect(lastRequest).toContain(jobNoticeId(two.jobId))
    expect(foldJobWakes(agent.session.facts), 'a human turn refills the budget').toBe(0)
  })

  it('sends no notice for an end the model already reads: its own cancel, or a wait released by the end', async () => {
    const { agent, jobs } = await setup()
    const cancelled = await launch(jobs, agent)
    await jobs.cancel(agent, cancelled.jobId, 'model', 'c-cancel')
    const waited = await launch(jobs, agent)
    waited.process.output('done\n')
    const read = jobs.read(agent, waited.jobId, { waitMs: 5_000, callId: 'c-wait' })
    waited.process.exit({ exitCode: 0 })
    const result = await read
    expect(result.view.end).toMatchObject({ cause: 'exited', reportedBy: 'c-wait' })
    expect(result.text).toBe('done\n')
    await quiesce(agent)
    const ends = ofType(agent, JOB_END.type).map((event) => event.data)
    expect(ends).toMatchObject([
      { jobId: cancelled.jobId, cause: 'cancelled', by: 'model', reportedBy: 'c-cancel' },
      { jobId: waited.jobId, cause: 'exited', reportedBy: 'c-wait' },
    ])
    expect(inserts(agent)).toHaveLength(0)
  })

  it("delivers a person's or the authority's stop QUIET: it never starts a paid turn", async () => {
    const { agent, jobs, h } = await setup()
    const byUser = await launch(jobs, agent)
    await jobs.cancel(agent, byUser.jobId, 'user')
    const byAuthority = await launch(jobs, agent)
    h.root.get(SANDBOX).setMode(agent.session, 'read-only')
    await quiesce(agent)
    expect(ofType(agent, JOB_END.type).map((event) => event.data)).toMatchObject([
      { jobId: byUser.jobId, cause: 'cancelled', by: 'user' },
      { jobId: byAuthority.jobId, cause: 'cancelled', by: 'authority' },
    ])
    expect(inserts(agent).map((insert) => insert.waking)).toEqual([false, false])
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('refuses a start whose authority changed while it was spawning, and records nothing', async () => {
    const { agent, jobs, h } = await setup()
    let process: FakeProcess | undefined
    const start = jobs.start({
      agent,
      kind: 'shell',
      label: 'serve',
      launch: async (output) => {
        h.root.get(SANDBOX).setMode(agent.session, 'read-only')
        await tick()
        return (process = new FakeProcess(output))
      },
    })
    await expect(start).rejects.toMatchObject({ code: 'JOB_REFUSED' })
    expect(process!.kills).toBe(1)
    expect(ofType(agent, JOB_START.type)).toHaveLength(0)
  })
})

describe('the end of an owner', () => {
  it('stops its jobs at disposal, records each end and its quiet notice, and leaves a log repair has nothing to add to', async () => {
    const { agent, jobs, h } = await setup()
    const { jobId, process } = await launch(jobs, agent)
    const handle = { dispose: () => h.dispose() }
    harness = undefined
    await handle.dispose()
    expect(process.kills).toBe(1)
    expect(ofType(agent, JOB_END.type).map((event) => event.data)).toMatchObject([{ jobId, cause: 'cancelled', by: 'disposal' }])
    expect(inserts(agent), 'recorded through the disposing inbox, never run').toMatchObject([{ waking: false, message: { id: jobNoticeId(jobId) } }])
    expect(repairTail(agent.session.events)).toEqual([])
  })

  it('stopAll ends every job quietly at idle, so no end can wake the agent between its idle and its disposal', async () => {
    const { agent, jobs, h } = await setup()
    await launch(jobs, agent)
    await launch(jobs, agent)
    await jobs.stopAll(agent)
    await quiesce(agent)
    expect(ofType(agent, JOB_END.type).map((event) => (event.data as { by: string }).by)).toEqual(['disposal', 'disposal'])
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('records nothing for a process that would not die, and the resume closes it lost — quiet, predicted by verify', async () => {
    const { agent, jobs, h, store } = await setup({}, true)
    h.adapter.script(assistantText('ok'))
    agent.followup(createUserMessage('hello'))
    await quiesce(agent)
    const { jobId } = await launch(jobs, agent, { dies: false, callId: 'c-start' })
    const id = agent.id
    await h.dispose()
    harness = undefined
    expect(ofType(agent, JOB_END.type), 'an end the process never reached is not recorded').toHaveLength(0)

    const next = await coreHarness({ jobs: { stopWaitMs: 200 } })
    harness = next
    next.root.plugin(persistenceJsonlPlugin, { root: store! })
    await next.root.settle()
    const stored = next.root.get(PERSISTENCE).load(id)!
    const verification = verifyStored(stored)
    expect(verification.closers.map((event) => event.type)).toEqual([JOB_END.type, INBOX_SPLICED.type])
    const resumed = await next.root.get(AGENTS).resume(next.root, id, { agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    const appended = resumed.agent.session.events.slice(stored.events.length, stored.events.length + 2)
    expect(appended.map((event) => JSON.stringify(event))).toEqual(verification.closers.map((event) => JSON.stringify(event)))
    expect(appended[0]!.data).toEqual({ jobId, cause: 'lost' })
    const notice = (appended[1]!.data as { waking: boolean; message: { content: { text: string }[] } })
    expect(notice.waking).toBe(false)
    expect(notice.message.content[0]!.text).toContain('started by call c-start, pid 4242')
    await quiesce(resumed.agent)
    expect(next.adapter.calls, 'a resume never pays for a lost notice').toHaveLength(0)
  })

  it('closes a job running at a fork boundary in the fork, live or cold, and never shows it running there', async () => {
    const { agent, jobs, h } = await setup()
    const { jobId } = await launch(jobs, agent, { dies: false })
    const fork = await h.root.get(AGENTS).fork(h.root, agent.session)
    const job = foldJobs(fork.agent.session.events).find((record) => record.start.jobId === jobId)!
    expect(job.end).toEqual({ jobId, cause: 'lost' })
    expect(job.notice).toMatchObject({ waking: false, state: 'queued' })
    expect(job.endSeq!, 'closed inside the seed, before its end-seed').toBeLessThan(fork.agent.session.liveStart)
    await fork.dispose()
  })
})

describe('the closer and the folds, pure', () => {
  const at = (entries: { type: string; data: unknown }[]): EventEnvelope[] => entries.map((entry, seq) => ({ ...entry, seq, time: 1 }))
  const start = (jobId: string, callId?: string) => ({ type: JOB_START.type, data: { jobId, kind: 'shell', label: 'x', mode: 'read-only', enforcement: 'full', ...(callId ? { callId } : {}) } })

  it('is deterministic, closes only what is open, and owes a notice an end never got', () => {
    const events = at([
      start('job-a'),
      start('job-b'),
      { type: JOB_END.type, data: { jobId: 'job-b', cause: 'exited', exitCode: 0 } },
      start('job-c'),
      { type: JOB_END.type, data: { jobId: 'job-c', cause: 'cancelled', by: 'model', reportedBy: 'c-9' } },
    ])
    const once = closeUnpairedJobs(events, events.length, 1)
    expect(JSON.stringify(once)).toBe(JSON.stringify(closeUnpairedJobs(events, events.length, 1)))
    expect(once.map((event) => [event.type, (event.data as { jobId?: string; message?: { id: string } }).jobId ?? (event.data as { message: { id: string } }).message.id])).toEqual([
      ['job/end', 'job-a'],
      ['inbox/spliced', 'msg-job-job-a'],
      ['inbox/spliced', 'msg-job-job-b'],
      ['inbox/spliced', 'msg-job-job-c'],
    ])
    // c-9 reported it after all: nothing owed for job-c.
    const reported = at([...events, { type: 'tool/result', data: { turn: 1, step: 1, callId: 'c-9', message: {} } }])
    expect(closeUnpairedJobs(reported, reported.length, 1).some((event) => JSON.stringify(event).includes('msg-job-job-c'))).toBe(false)
  })

  it('counts consecutive job-woken turns and resets on a human one', () => {
    const turn = (n: number, source: object, id = 'm'): { type: string; data: unknown }[] => [
      { type: TURN_START.type, data: { turn: n } },
      { type: USER_MESSAGE.type, data: { message: { id, role: 'user', content: [], source } } },
      { type: TURN_END.type, data: { turn: n, reason: { kind: 'completed' } } },
    ]
    const job = { kind: 'plugin', plugin: 'core-jobs', form: 'job-notice' }
    expect(foldJobWakes(at([...turn(1, { kind: 'user' }), ...turn(2, job, 'msg-job-x'), ...turn(3, job, 'msg-job-y')]))).toBe(2)
    expect(foldJobWakes(at([...turn(1, job, 'msg-job-x'), ...turn(2, { kind: 'user' })]))).toBe(0)
  })

  it('holds the bracket to one end per start, cold, and lets a seeded lost through', () => {
    expect(checkJobsLog(at([{ type: JOB_END.type, data: { jobId: 'job-z', cause: 'exited' } }]))?.message).toContain('has no job/start')
    expect(
      checkJobsLog(at([start('job-a'), { type: JOB_END.type, data: { jobId: 'job-a', cause: 'exited' } }, { type: JOB_END.type, data: { jobId: 'job-a', cause: 'lost' } }]))?.message,
    ).toContain('second end')
    expect(checkJobsLog(at([start('job-a'), { type: JOB_END.type, data: { jobId: 'job-a', cause: 'lost' } }]))).toBeUndefined()
  })

  it('refuses a LIVE lost', async () => {
    const { agent } = await setup()
    agent.session.append(JOB_START, { jobId: 'job-live', kind: 'shell', label: 'x', mode: 'read-only', enforcement: 'full' })
    expect(() => agent.session.append(JOB_END, { jobId: 'job-live', cause: 'lost' })).toThrow(/only crash repair and a fork write that/)
  })
})
