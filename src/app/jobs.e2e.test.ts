/**
 * The S17 live arc: background jobs on the real runtime, the real DeepSeek
 * API, a real workspace outside the repo, over `minidsh serve`'s stdio.
 *
 * (A) A job's OWN end wakes an idle agent through its inbox: the model starts
 *     a job, ends its turn, and is woken by the notice to finish the work. The
 *     WORLD is asserted (a file only the woken turn can write), then the log
 *     replays keylessly with every notice re-entering the step that took it.
 * (B) The host is SIGKILLed with the agent IDLE and a job running. A cold
 *     `verify` predicts exactly what the resume appends — the job closed
 *     `lost` and a quiet notice — and the resumed model, told so, runs a short
 *     job and waits for it. What became of the orphan is printed per platform.
 *
 * Every prompt names the tools: a live arc that leaves the route open
 * measures the provider's mood, not the runtime (ARCHITECTURE §10).
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { coldRead, killSpawnedServes, ServeProcess, validPrefix } from '../test-support/serve-process.ts'
import { runTask } from './headless.ts'
import { skillRootsFor } from './home.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
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

/** Every host accepts an unconfined shell for these arcs: inert where a backend confines, and the only way a job runs on Windows. */
const SERVE = { approve: true, args: ['--accept', 'none'] } as const

const data = <T>(event: EventEnvelope | undefined): T => (event?.data ?? {}) as T

function stored(home: string, sessionId: string): EventEnvelope[] {
  return readFileSync(join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kills a process tree by pid where it can: what the arc does with an orphan after reporting on it. */
function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
}

describe.skipIf(!KEY)('S17 live E2E: background jobs', () => {
  it('a job\'s own end wakes the idle agent, which finishes the work; the log replays by its own order', { timeout: 480_000 }, async () => {
    const workspace = tempDir('minidsh-jobs-ws-')
    const home = tempDir('minidsh-jobs-home-')
    const marker = `DONE-${Math.random().toString(36).slice(2, 10)}`
    writeFileSync(join(workspace, 'slow.cjs'), `setTimeout(() => console.log(${JSON.stringify(marker)}), 6000)\n`, 'utf8')

    const serve = new ServeProcess(workspace, home, SERVE)
    await serve.request('initialize')
    const prompt =
      'Use the job_start tool to run this command in the background: node slow.cjs\n' +
      'It prints one line after about six seconds. Do not wait for it and do not poll it: reply with the single word started and end your turn.\n' +
      'Later, when you are notified that the job has ended, read its output with job_output, then use str_replace_editor with the create command ' +
      'to write result.txt in the workspace containing exactly the line the job printed, and nothing else.'
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: prompt })
    await serve.waitForCompletedTurn(sessionId, 1)
    // What turn 1 actually did, named when a wait below fails: the premise is
    // the model's to keep, and a timeout alone says nothing about which half broke.
    const shape = (): string =>
      `tool calls ${JSON.stringify(serve.events('tool/call', sessionId).map((event) => [data<{ name: string }>(event).name, data<{ arguments: string }>(event).arguments.slice(0, 120)]))}; ` +
      `job facts ${JSON.stringify(serve.frames.filter((frame) => frame.sessionId === sessionId && frame.event.type.startsWith('job/')).map((frame) => frame.event.data))}`
    expect(serve.events('job/start', sessionId), `turn 1 started no job: ${shape()}`).toHaveLength(1)
    try {
      await serve.waitFor(() => serve.events('job/end', sessionId)[0], 'the job to end', 120_000)
      await serve.waitForCompletedTurn(sessionId, 2)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} — ${shape()}`, { cause: error })
    }
    const log = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    await serve.shutdown()

    // The WORLD: only a turn the job's end woke could have written this.
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8').trim()).toBe(marker)

    // The LOG: one bracket, its end before its notice, the notice waking turn 2.
    const events = log.events
    const start = events.find((event) => event.type === 'job/start')!
    const end = events.find((event) => event.type === 'job/end')!
    expect(data<{ kind: string }>(start).kind).toBe('shell')
    expect(data<{ cause: string; exitCode: number }>(end)).toMatchObject({ cause: 'exited', exitCode: 0 })
    const notice = events.find((event) => event.type === 'inbox/spliced' && data<{ message?: { id: string } }>(event).message?.id.startsWith('msg-job-'))!
    expect(notice.seq).toBeGreaterThan(end.seq)
    expect(data<{ waking: boolean }>(notice).waking, 'a job\'s own end wakes').toBe(true)
    const turn2 = events.findIndex((event) => event.type === 'turn/start' && data<{ turn: number }>(event).turn === 2)
    const firstEntered = events.slice(turn2).find((event) => event.type === 'user/message')!
    expect(data<{ message: { id: string; source: { kind: string } } }>(firstEntered).message.id, 'turn 2 opened on the notice, not on a person').toMatch(/^msg-job-/)
    expect(events.filter((event) => event.type === 'user/message' && data<{ message: { source: { kind: string } } }>(event).message.source.kind === 'user')).toHaveLength(1)
    console.log(`[jobs arc A] ${events.length} events; job ${data<{ jobId: string }>(start).jobId} ${data<{ durationMs: number }>(end).durationMs} ms; woke turn 2 at seq ${events[turn2]!.seq}`)

    // ---- keyless replay: the log is its own oracle, by its own order --------
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayed = await runTask(
      {
        task: prompt,
        cwd: tempDir('minidsh-jobs-replay-ws-'),
        model: 'deepseek-v4-flash',
        sessionsRoot: tempDir('minidsh-jobs-replay-'),
        // What `serve` mounted: the recorded requests carry its skill list.
        skillRoots: skillRootsFor(home),
        logger: silent,
        accepts: 'none',
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events, effects: 'recorded' })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
  })

  it('a host killed with a job running: verify predicts the lost close, and the resumed model is told', { timeout: 600_000 }, async () => {
    const workspace = tempDir('minidsh-jobs-lost-ws-')
    const home = tempDir('minidsh-jobs-lost-home-')
    const marker = `SHORT-${Math.random().toString(36).slice(2, 10)}`
    // The worker records its OWN pid: on Windows its shell root can die with the
    // host while it lives on, and a dead root's descendants are unreachable.
    writeFileSync(
      join(workspace, 'long.cjs'),
      "const fs = require('fs'); fs.writeFileSync('long.pid', String(process.pid)); setInterval(() => fs.appendFileSync('heartbeat.txt', Date.now() + '\\n'), 500)\n",
      'utf8',
    )
    writeFileSync(join(workspace, 'short.cjs'), `setTimeout(() => console.log(${JSON.stringify(marker)}), 2000)\n`, 'utf8')

    const first = new ServeProcess(workspace, home, SERVE)
    await first.request('initialize')
    const { sessionId } = await first.request<{ sessionId: string }>('session/prompt', {
      text: 'Use the job_start tool to run this command in the background: node long.cjs\nIt runs for a long time. Do not wait for it: reply with the single word started and end your turn.',
    })
    await first.waitForCompletedTurn(sessionId, 1)
    const start = await first.waitFor(() => first.events('job/start', sessionId)[0], 'the job to start')
    await first.waitFor(() => (existsSync(join(workspace, 'heartbeat.txt')) ? true : undefined), 'the job to beat')
    // IDLE, a job running: the shape whose log a recorded replay may still read.
    await first.kill()
    const pid = data<{ pid?: number }>(start).pid
    const sizeAtKill = statSync(join(workspace, 'heartbeat.txt')).size
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const survived = statSync(join(workspace, 'heartbeat.txt')).size > sizeAtKill
    const worker = Number(readFileSync(join(workspace, 'long.pid'), 'utf8'))
    const root = pid !== undefined && alive(pid) ? 'alive' : 'gone'
    console.log(`[jobs arc B] ${process.platform}: the job's worker ${survived ? 'SURVIVED' : 'died with'} its host; its root (pid ${pid ?? '?'}) is ${root}`)
    if (pid !== undefined) killTree(pid)
    killTree(worker)

    // ---- a cold read predicts the closers -----------------------------------
    const sessionFile = join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`)
    const beforeResume = validPrefix(sessionFile)
    const cold = coldRead(home, ['verify', sessionId, '--json'])
    expect(cold.code, `cold verify: ${cold.out}${cold.err}`).toBe(0)
    const verdict = cold.json as { verdict: string; closers: EventEnvelope[] }
    expect(verdict.closers.map((event) => event.type), 'idle at the kill: only the job is open').toEqual(['job/end', 'inbox/spliced'])
    expect(data<{ cause: string }>(verdict.closers[0])).toMatchObject({ cause: 'lost' })
    expect(data<{ waking: boolean }>(verdict.closers[1]).waking, 'a resume never pays for a lost notice').toBe(false)

    // ---- the resume: the model is told, and recovers --------------------------
    const second = new ServeProcess(workspace, home, SERVE)
    await second.request('session/prompt', {
      sessionId,
      text:
        'What happened to the background job you started? If it is no longer supervised by this session, use job_start to run node short.cjs instead, ' +
        'wait for it with job_output (wait_ms 30000), then use str_replace_editor with the create command to write short.txt containing exactly the line it printed.',
    })
    await second.waitFor(
      () => second.events('turn/end', sessionId).find((event) => data<{ turn: number; reason: { kind: string } }>(event).turn >= 2 && data<{ reason: { kind: string } }>(event).reason.kind === 'completed'),
      'the resumed turn to complete',
    )
    await second.shutdown()

    expect(readFileSync(join(workspace, 'short.txt'), 'utf8').trim()).toBe(marker)
    const events = stored(home, sessionId)
    expect(readFileSync(sessionFile).subarray(0, beforeResume.length).equals(beforeResume)).toBe(true)
    const appended = events.slice(verdict.closers[0]!.seq, verdict.closers[0]!.seq + verdict.closers.length)
    expect(appended.map((event) => JSON.stringify(event)), 'the resume appended exactly what verify predicted').toEqual(verdict.closers.map((event) => JSON.stringify(event)))
    const resumedTurn = events.findIndex((event) => event.type === 'turn/start' && data<{ turn: number }>(event).turn === 2)
    const entered = events.slice(resumedTurn).filter((event) => event.type === 'user/message').map((event) => data<{ message: { id: string } }>(event).message.id)
    expect(entered.some((id) => id.startsWith('msg-job-')), 'the resumed model was shown the lost notice').toBe(true)
    const ends = events.filter((event) => event.type === 'job/end').map((event) => data<{ cause: string }>(event).cause)
    expect(ends[0]).toBe('lost')
    expect(ends.slice(1)).toContain('exited')
    console.log(`[jobs arc B] closers ${verdict.closers.length}; ${events.filter((event) => event.type === 'job/start').length} job(s); ends ${ends.join(', ')}`)
  })
})
