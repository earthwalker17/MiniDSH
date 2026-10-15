/**
 * The jobs seam: owner-scoped background work (ARCHITECTURE §3, §6).
 *
 * A Definition that ships its driver, like `approval` and `sandbox`: the
 * registry here owns a job's IDENTITY, its ADMISSION, its LIFECYCLE (one
 * terminal fact, first-wins) and its DELIVERY (the owner's durable inbox,
 * nothing else). A PRODUCER owns the resources — the process and how it is
 * killed — and is called through `JobSpec.launch`; `shell-stdio` is the first.
 * The registry owns no process, no wire state and no model-facing tool.
 *
 * **Owned by an agent scope.** The first start of an owner attaches one effect
 * to its scope; disposing the agent stops its jobs, records each end and syncs
 * the log, all before the session detaches. Nothing an agent started outlives
 * it under this registry's supervision, and a job whose process would not die
 * in time is left for the closer to call `lost` rather than recorded as
 * stopped.
 *
 * **Under recorded authority.** A job runs under the stamp its start resolved,
 * never an escalation. A durable switch of the session's mode or acceptance
 * ends every job its owner runs (`by: 'authority'`), including one still
 * starting — the same rule that restarts the persistent shell and ends a
 * grant: no process keeps an authority the session no longer grants.
 *
 * **Bounded.** Refused at start past a per-owner cap; a completion wakes an
 * idle owner only while `foldJobWakes` is under the budget, and only a job's
 * OWN end may wake: an end a person or the runtime caused is delivered quiet.
 */
import { z } from 'zod'
import { serviceKey, type Context, type Logger, type Plugin } from '../../kernel/index.ts'
import { AGENTS, type Agent, type Agents } from '../agent/index.ts'
import { SANDBOX_ACCEPTANCE, SANDBOX_MODE, type SandboxEnforcement, type SandboxMode } from '../sandbox/events.ts'
import { matches, SESSION_EVENT, type EventEnvelope, type Session } from '../session/index.ts'
import { SPILL, type SpillStream } from '../spill/index.ts'
import { printableText } from '../text.ts'
import { foldJobWakes, JOB_END, JOB_START, jobNotice, type JobCanceller, type JobEnd, type JobKind, type JobStart } from './events.ts'

export * from './events.ts'

/** What a producer hands back once its process has spawned. */
export interface JobProcess {
  readonly pid?: number
  /** The authority it actually runs under, fixed at spawn. */
  readonly mode: SandboxMode
  readonly enforcement: SandboxEnforcement
  /** Settles once the process is gone and its output drained; never rejects. */
  readonly exited: Promise<JobExit>
  /** Ask it to stop. Idempotent; `exited` settles when it has. */
  kill(): void
}

export interface JobExit {
  readonly exitCode?: number
  readonly signal?: string
  /** The producer could not run it as asked (a confinement runner that died at start). */
  readonly failure?: string
  /** The producer killed it at its OWN disposal, whoever unwound first. */
  readonly disposed?: true
  /**
   * It ended before anyone asked it to stop. Its own end, then, even when a
   * stop was requested in the moment between its exit and this report (the
   * producer drains its pipes first): a job that finished is not recorded as
   * stopped.
   */
  readonly selfEnded?: true
}

export interface JobSpec {
  readonly agent: Agent
  readonly callId?: string
  readonly kind: JobKind
  /** The command, as validated; clamped for the record. */
  readonly label: string
  /**
   * Spawns the process, AFTER admission. It resolves the authority itself, so
   * a switch that lands while it starts is one the registry already watches.
   * A throw is a refusal: nothing is recorded and nothing is left running.
   */
  launch(output: (chunk: string) => void): Promise<JobProcess>
}

export type JobErrorCode = 'JOB_LIMIT' | 'JOB_OWNER_GONE' | 'JOB_UNKNOWN' | 'JOB_REFUSED'

export class JobError extends Error {
  readonly code: JobErrorCode
  constructor(code: JobErrorCode, message: string) {
    super(message)
    this.name = 'JobError'
    this.code = code
  }
}

/** One job as this registry runs it: live, or ended in this lifecycle. */
export interface JobView {
  readonly jobId: string
  readonly kind: JobKind
  readonly label: string
  readonly state: 'running' | 'ended'
  readonly pid?: number
  readonly output?: string
  /** The output file stops short of what the job wrote: the size cap, or a store that could not write. */
  readonly outputPartial?: true
  readonly end?: JobEnd
}

/** A read of a job's output: what arrived since the model's last read, and how it stands. */
export interface JobRead {
  readonly view: JobView
  /** New output since the previous read (the tail of it, when more arrived than is kept). */
  readonly text: string
  /** Characters that arrived since the previous read and are no longer held in memory. */
  readonly omitted: number
}

export interface Jobs {
  /** Admits, launches and records a job; refused with a `JobError` or the producer's own error. */
  start(spec: JobSpec): Promise<JobView>
  /** The owner's jobs this lifecycle ran, in start order. */
  list(agent: Agent): JobView[]
  /**
   * Consumes the owner's new output. With `waitMs`, first waits up to that long
   * for the job to end — and an end released to a waiting `callId` is that
   * call's to report (`job/end.reportedBy`), so no notice is sent for it.
   */
  read(agent: Agent, jobId: string, options?: { readonly waitMs?: number; readonly signal?: AbortSignal; readonly callId?: string }): Promise<JobRead>
  /** Stops a job and waits (bounded) for its end; `model` names the call that reports it. */
  cancel(agent: Agent, jobId: string, by: 'model' | 'user', callId?: string): Promise<JobView>
  /**
   * Stops every job of an owner whose run is over, recorded as ended by
   * disposal and delivered quiet: the headless rule at idle, and a delegated
   * child's end. Called before any await after `whenIdle`, so no job's own end
   * can wake the agent between its idle and its disposal.
   */
  stopAll(agent: Agent): Promise<void>
}

export const JOBS = serviceKey<Jobs>('jobs')

export interface JobsConfig {
  /** Running jobs one owner may hold; a start past it is refused (default 10). */
  readonly maxPerOwner?: number | undefined
  /** Consecutive job-woken turns with no human input before notices stop waking (default 8). */
  readonly maxWakes?: number | undefined
  /** How long a stop waits for a killed process before leaving it to the closer (default 5000 ms). */
  readonly stopWaitMs?: number | undefined
}

const configSchema = z
  .strictObject({
    maxPerOwner: z.number().int().positive().optional(),
    maxWakes: z.number().int().nonnegative().optional(),
    stopWaitMs: z.number().int().positive().optional(),
  })
  .optional()

/** Characters of a job's output kept in memory for its reads; the spill file keeps the rest. */
const TAIL_CHARS = 64 * 1024
/** Bytes written to a job's spill file before the rest is dropped (and the file says so). */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024

interface Entry {
  readonly jobId: string
  readonly owner: Owner
  readonly kind: JobKind
  readonly label: string
  readonly callId: string | undefined
  process?: JobProcess
  start?: JobStart
  startedAt: number
  /** The first stop asked for wins: it decides the recorded cause, unless the process had already ended on its own. */
  cancel?: { readonly by: JobCanceller }
  end?: JobEnd
  /** True once the end is decided, recorded or abandoned: no later exit appends. */
  done: boolean
  stream?: SpillStream
  bytes: number
  capped: boolean
  tail: string
  total: number
  cursor: number
  /**
   * Calls waiting on this job's end: a `job_output` wait, or a cancel. The
   * first that names a call REPORTS the end (`job/end.reportedBy`), so no
   * notice is sent — and a waiter leaves synchronously when its own bound
   * expires, so an end that lands after that is nobody's report and gets one.
   */
  waiters: Waiter[]
  readonly settled: Promise<void>
  markSettled: () => void
}

interface Waiter {
  readonly callId?: string
  /** Called inside `settle`, after the end is recorded: what the waiter returns is built here. */
  readonly settle: () => void
}

interface Owner {
  readonly agent: Agent
  readonly entries: Map<string, Entry>
  ending: boolean
}

function view(entry: Entry): JobView {
  return {
    jobId: entry.jobId,
    kind: entry.kind,
    label: entry.label,
    state: entry.end === undefined ? 'running' : 'ended',
    ...(entry.process?.pid === undefined ? {} : { pid: entry.process.pid }),
    ...(entry.stream === undefined ? {} : { output: entry.stream.path }),
    ...(entry.capped || entry.stream?.failed === true ? { outputPartial: true as const } : {}),
    ...(entry.end === undefined ? {} : { end: entry.end }),
  }
}

function newJobId(): string {
  return `job-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** Waits for `promise` at most `ms`, and never leaves its timer behind: a pending one holds a CLI's process open. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))])
  } finally {
    clearTimeout(timer)
  }
}

class JobsService implements Jobs {
  private readonly agents: Agents
  private readonly ctx: Context
  private readonly logger: Logger
  private readonly maxPerOwner: number
  private readonly maxWakes: number
  private readonly stopWaitMs: number
  private readonly owners = new Map<string, Owner>()

  constructor(ctx: Context, config: JobsConfig) {
    this.ctx = ctx
    this.agents = ctx.get(AGENTS)
    this.logger = ctx.logger
    this.maxPerOwner = config.maxPerOwner ?? 10
    this.maxWakes = config.maxWakes ?? 8
    this.stopWaitMs = config.stopWaitMs ?? 5_000
  }

  async start(spec: JobSpec): Promise<JobView> {
    const agent = spec.agent
    if (this.agents.get(agent.id) !== agent || agent.session.isClosed) {
      throw new JobError('JOB_OWNER_GONE', 'background jobs need a live session to deliver their results to; this one is ending')
    }
    const owner = this.ownerFor(agent)
    if (owner.ending) throw new JobError('JOB_OWNER_GONE', 'this session is ending, so a background job could not be collected')
    const live = [...owner.entries.values()].filter((entry) => !entry.done).length
    if (live >= this.maxPerOwner) {
      throw new JobError('JOB_LIMIT', `background job limit reached for this session (${this.maxPerOwner}); stop one with job_cancel or wait for one to end, then retry`)
    }
    // Registered BEFORE anything is spawned or resolved: a switch of authority
    // or a disposal that lands while the producer starts finds this entry and
    // dooms it, instead of finding nothing and letting the job run under an
    // authority the session no longer has.
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => (markSettled = resolve))
    const entry: Entry = {
      jobId: this.mintId(owner),
      owner,
      kind: spec.kind,
      label: printableText(spec.label).trim().slice(0, 2000),
      callId: spec.callId,
      startedAt: Date.now(),
      done: false,
      bytes: 0,
      capped: false,
      tail: '',
      total: 0,
      cursor: 0,
      waiters: [],
      settled,
      markSettled,
    }
    owner.entries.set(entry.jobId, entry)
    let process: JobProcess
    try {
      process = await spec.launch((chunk) => this.onOutput(entry, chunk))
    } catch (error) {
      this.forget(entry)
      throw error
    }
    entry.process = process
    if (entry.cancel !== undefined || owner.ending) {
      // Doomed while it started: stop it and refuse, recording nothing — the
      // job never existed in this session's record.
      process.kill()
      await within(process.exited, this.stopWaitMs)
      this.forget(entry)
      const why = entry.cancel?.by === 'authority' ? "this session's sandbox mode or acceptance changed while it was starting" : 'this session is ending'
      throw new JobError('JOB_REFUSED', `the background job was stopped before it began: ${why}`)
    }
    // The file opens only for a job that exists, so a refusal leaves none;
    // what the process wrote before this moment is in the tail.
    const stream = this.openOutput(agent, entry.jobId)
    if (stream !== undefined) {
      entry.stream = stream
      if (entry.tail.length > 0) stream.write(entry.tail)
    }
    const start: JobStart = {
      jobId: entry.jobId,
      ...(spec.callId === undefined ? {} : { callId: spec.callId }),
      kind: spec.kind,
      label: entry.label.slice(0, 200),
      ...(process.pid === undefined ? {} : { pid: process.pid }),
      mode: process.mode,
      enforcement: process.enforcement,
      ...(entry.stream === undefined ? {} : { output: entry.stream.path }),
    }
    try {
      agent.session.append(JOB_START, start)
    } catch (error) {
      process.kill()
      this.forget(entry)
      throw error
    }
    entry.start = start
    entry.startedAt = Date.now()
    void process.exited.then(
      (exit) => this.settle(entry, exit),
      (error: unknown) => this.settle(entry, { failure: error instanceof Error ? error.message : String(error) }),
    )
    return view(entry)
  }

  list(agent: Agent): JobView[] {
    const owner = this.owners.get(agent.id)
    return owner && owner.agent === agent ? [...owner.entries.values()].filter((entry) => entry.start !== undefined).map(view) : []
  }

  async read(agent: Agent, jobId: string, options: { readonly waitMs?: number; readonly signal?: AbortSignal; readonly callId?: string } = {}): Promise<JobRead> {
    const entry = this.entryOf(agent, jobId)
    const waitMs = options.waitMs ?? 0
    if (entry.end !== undefined || waitMs <= 0 || options.signal?.aborted) return this.consume(entry)
    return new Promise<JobRead>((resolve) => {
      const waiter: Waiter = {
        ...(options.callId === undefined ? {} : { callId: options.callId }),
        // Settle hands the waiter a read built in the same synchronous step
        // that recorded the end as this call's to report: no I/O sits between.
        settle: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', leave)
          resolve(this.consume(entry))
        },
      }
      const leave = (): void => {
        // Unregistered synchronously: an end that lands after this is not this
        // call's to report, so it gets its notice.
        const index = entry.waiters.indexOf(waiter)
        if (index < 0) return
        entry.waiters.splice(index, 1)
        waiter.settle()
      }
      const timer = setTimeout(leave, waitMs)
      options.signal?.addEventListener('abort', leave, { once: true })
      entry.waiters.push(waiter)
    })
  }

  async cancel(agent: Agent, jobId: string, by: 'model' | 'user', callId?: string): Promise<JobView> {
    const entry = this.entryOf(agent, jobId)
    if (entry.end !== undefined) return view(entry)
    entry.cancel ??= { by }
    // The cancelling call reports the end only if it is still WAITING when the
    // end lands: past its bound it has told the model "not ended yet", so the
    // end that follows is nobody's report and gets its notice.
    let waiter: Waiter | undefined
    const ended = new Promise<void>((resolve) => {
      waiter = { ...(callId === undefined ? {} : { callId }), settle: resolve }
      entry.waiters.push(waiter)
    })
    entry.process?.kill()
    await within(ended, this.stopWaitMs)
    const index = entry.waiters.indexOf(waiter!)
    if (index >= 0) entry.waiters.splice(index, 1)
    return view(entry)
  }

  async stopAll(agent: Agent): Promise<void> {
    const owner = this.owners.get(agent.id)
    if (!owner || owner.agent !== agent) return
    await this.stopEvery(owner, 'disposal')
  }

  /** The authority listener: a durable switch ends the owner's jobs. Kills only — the ends are appended at exit, never inside this dispatch. */
  onSessionEvent(session: Session, event: EventEnvelope): void {
    if (!matches(event, SANDBOX_MODE) && !matches(event, SANDBOX_ACCEPTANCE)) return
    if (event.data.reason !== 'change') return
    const owner = this.owners.get(session.id)
    if (!owner || owner.agent.session !== session) return
    for (const entry of owner.entries.values()) {
      if (entry.done) continue
      entry.cancel ??= { by: 'authority' }
      entry.process?.kill()
    }
  }

  // ---- internals -------------------------------------------------------------

  private ownerFor(agent: Agent): Owner {
    const known = this.owners.get(agent.id)
    if (known && known.agent === agent) return known
    const owner: Owner = { agent, entries: new Map(), ending: false }
    try {
      agent.ctx.effect(() => () => this.disposeOwner(owner), 'jobs.owner')
    } catch {
      throw new JobError('JOB_OWNER_GONE', 'this session is ending, so a background job could not be collected')
    }
    this.owners.set(agent.id, owner)
    return owner
  }

  /**
   * The owner's scope is unwinding: stop every job, record each end, sync.
   * It reads only what it captured — never a service this plugin injected
   * (`kernel/context.ts`). A job whose process would not die in time records
   * nothing: the closer calls it `lost`, which is what it is.
   */
  private async disposeOwner(owner: Owner): Promise<void> {
    owner.ending = true
    await this.stopEvery(owner, 'disposal')
    // What would not die in time is abandoned: nothing more is appended or
    // written for it, and the closer of the next lifecycle calls it `lost`.
    for (const entry of owner.entries.values()) {
      entry.done = true
      if (entry.end === undefined) entry.stream?.close()
    }
    if (this.owners.get(owner.agent.id) === owner) this.owners.delete(owner.agent.id)
    try {
      await owner.agent.session.flush()
    } catch {
      // A lost write is reported by the store at its own checkpoints.
    }
  }

  private async stopEvery(owner: Owner, by: JobCanceller): Promise<void> {
    const pending: Promise<void>[] = []
    for (const entry of owner.entries.values()) {
      if (entry.done) continue
      entry.cancel ??= { by }
      entry.process?.kill()
      pending.push(entry.settled)
    }
    if (pending.length > 0) await within(Promise.all(pending), this.stopWaitMs)
  }

  /**
   * The one terminal fact, first-wins. The end is appended, THEN its notice
   * is sent, then any waiter is handed its read — one synchronous step, so no
   * log holds a notice before its cause and no waiter misses the end it
   * reports.
   */
  private settle(entry: Entry, exit: JobExit): void {
    if (entry.done || entry.start === undefined) return
    entry.done = true
    const reporter = entry.waiters.find((waiter) => waiter.callId !== undefined)
    const durationMs = Date.now() - entry.startedAt
    const exited = {
      ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    }
    const cancel = exit.selfEnded ? undefined : (entry.cancel ?? (exit.disposed ? { by: 'disposal' as const } : undefined))
    const reportedBy = reporter?.callId
    const end: JobEnd = {
      jobId: entry.jobId,
      ...(cancel !== undefined
        ? { cause: 'cancelled' as const, ...exited, by: cancel.by }
        : exit.failure !== undefined
          ? { cause: 'failed' as const, ...exited, detail: printableText(exit.failure).slice(0, 400) }
          : { cause: 'exited' as const, ...exited }),
      ...(reportedBy === undefined ? {} : { reportedBy }),
      durationMs,
      outputBytes: entry.bytes,
    }
    entry.end = end
    entry.stream?.close()
    const session = entry.owner.agent.session
    let recorded = false
    try {
      session.append(JOB_END, end)
      recorded = true
    } catch (error) {
      // A late exit after the session detached: the closer of its next
      // lifecycle says what this could not.
      this.logger.warn(`jobs: could not record the end of ${entry.jobId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (recorded && reportedBy === undefined) this.deliver(entry, end)
    for (const waiting of entry.waiters.splice(0)) waiting.settle()
    entry.markSettled()
    if (recorded) void session.flush().catch(() => undefined)
  }

  /** Through the owner's inbox and nothing else (§4). Only a job's own end may wake, and only under the budget. */
  private deliver(entry: Entry, end: JobEnd): void {
    const agent = entry.owner.agent
    const own = end.cause === 'exited' || end.cause === 'failed'
    // A stop was asked for: the end is recorded as what it was, but it does not
    // wake — the latch `stopAll` sets exists so that nothing does.
    const waking = own && entry.cancel === undefined && !entry.owner.ending && foldJobWakes(agent.session.facts) < this.maxWakes
    try {
      agent.send(jobNotice(entry.start, end), 'next-step', waking)
    } catch (error) {
      this.logger.warn(`jobs: could not deliver the end of ${entry.jobId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private onOutput(entry: Entry, chunk: string): void {
    if (entry.done || chunk.length === 0) return
    entry.total += chunk.length
    entry.tail = (entry.tail + chunk).slice(-TAIL_CHARS)
    const size = Buffer.byteLength(chunk, 'utf8')
    entry.bytes += size
    if (entry.stream && !entry.capped) {
      if (entry.bytes > OUTPUT_CAP_BYTES) {
        entry.capped = true
        entry.stream.write(`\n[output stopped here: the job wrote more than ${OUTPUT_CAP_BYTES} bytes; the rest was not kept]\n`)
      } else entry.stream.write(chunk)
    }
  }

  private consume(entry: Entry): JobRead {
    const delta = entry.total - entry.cursor
    const kept = Math.min(delta, entry.tail.length)
    entry.cursor = entry.total
    return { view: view(entry), text: entry.tail.slice(entry.tail.length - kept), omitted: delta - kept }
  }

  private entryOf(agent: Agent, jobId: string): Entry {
    const owner = this.owners.get(agent.id)
    const entry = owner && owner.agent === agent ? owner.entries.get(jobId) : undefined
    if (!entry || entry.start === undefined) throw new JobError('JOB_UNKNOWN', `no background job "${jobId}" is running or ran in this session since it was opened`)
    return entry
  }

  private openOutput(agent: Agent, jobId: string): SpillStream | undefined {
    const spill = this.ctx.tryGet(SPILL)
    if (!spill?.open) return undefined
    try {
      return spill.open({ sessionId: agent.session.id, callId: jobId, label: 'output' })
    } catch (error) {
      this.logger.warn(`jobs: no output file for ${jobId}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private forget(entry: Entry): void {
    entry.done = true
    entry.stream?.close()
    entry.owner.entries.delete(entry.jobId)
    entry.markSettled()
  }

  private mintId(owner: Owner): string {
    let id = newJobId()
    while (owner.entries.has(id)) id = newJobId()
    return id
  }
}

/** Provides `ctx.jobs`. Like `core/approval`, the Definition ships its own driver. */
export const jobsPlugin: Plugin<JobsConfig | undefined> = {
  name: 'core-jobs',
  inject: [AGENTS],
  config: configSchema,
  apply(ctx, config) {
    const service = new JobsService(ctx, config ?? {})
    ctx.provide(JOBS, service)
    ctx.on(SESSION_EVENT, (session, event) => service.onSessionEvent(session, event))
  },
}
