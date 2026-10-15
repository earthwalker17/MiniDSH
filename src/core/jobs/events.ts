/**
 * The jobs VOCABULARY: the bracket, the completion notice, the folds over
 * them and the closer crash repair runs.
 *
 * Split from the service (`index.ts`) exactly as `compaction/events.ts` and
 * `agent/events.ts` are, and for the same reason: crash repair and a fork
 * close an unpaired job without importing the registry that runs one.
 *
 * **The bracket.** `job/start` is written once a producer reports a process
 * spawned; `job/end` is the ONE terminal fact (first-wins in the registry,
 * held to one per job by `core-jobs`). Both are log-only facts outside every
 * step — a job outlives the call and the turn that started it, which S13
 * settled needs no relaxation of the session invariant.
 *
 * **Delivery.** A completion reaches the model ONLY through the durable
 * inbox, as one notice message whose id is DERIVED from the job id. That id is
 * what lets a reader pair an end with its delivery, and what keeps the closer
 * pure: a resume and a cold `verify` emit the same bytes. The end is appended
 * first and its notice after it, in one JS turn, so no log holds a notice
 * before its cause (DSH converged on the same order, `2be73291`).
 *
 * **What upstream does not do.** DSH persists the same bracket but never
 * closes it: a job whose settlement was lost "remains incomplete", and a
 * resumed session learns nothing. MiniDSH closes it `lost` and tells the model,
 * because a model whose history says "started job X" and then nothing will
 * wait on X, or start a second copy of a server that may still be running.
 */
import { asMessageId } from '../ids.ts'
import { deepFreeze, snapshotJson } from '../json.ts'
import { restoreMessage } from '../llm/message.ts'
import type { Message } from '../llm/types.ts'
import { INBOX_SPLICED, type InboxSplice } from '../agent/events.ts'
import type { SandboxEnforcement, SandboxMode } from '../sandbox/events.ts'
import { eventKind, matches, TOOL_RESULT, TURN_END, TURN_START, USER_MESSAGE, type EventEnvelope } from '../session/types.ts'
import { printableText } from '../text.ts'

/** What produced the job. Closed: a second producer (S21's background child) is a vocabulary change. */
export type JobKind = 'shell'

/** Who asked for a job to stop. `model` is the owner's own `job_cancel`, which its result reports. */
export type JobCanceller = 'model' | 'user' | 'authority' | 'disposal'

export interface JobStart {
  readonly jobId: string
  /** The tool call that started it, when one did. */
  readonly callId?: string
  readonly kind: JobKind
  /** The command as validated and clamped — never the model's prose about it. */
  readonly label: string
  /** An observed spawn fact, so a reader of a lost job has something to check by. */
  readonly pid?: number
  /** The authority it runs under, fixed at spawn: what the process actually got. */
  readonly mode: SandboxMode
  readonly enforcement: SandboxEnforcement
  /** Where its output is written, when a spill store was mounted. */
  readonly output?: string
}

/**
 * How a job ended. `lost` is written only by crash repair and a fork: the
 * record ended with the job running, so nothing about its process is known.
 */
export type JobEndCause = 'exited' | 'failed' | 'cancelled' | 'lost'

export interface JobEnd {
  readonly jobId: string
  readonly cause: JobEndCause
  readonly exitCode?: number
  readonly signal?: string
  /** For `cancelled`: who asked. */
  readonly by?: JobCanceller
  /** For `failed`: what the producer reported, clamped. */
  readonly detail?: string
  /**
   * The tool call whose result reports this end — a `job_output` that waited
   * on it, or the owner's own `job_cancel`. Set, no notice is owed; the closer
   * delivers one anyway when that call never logged a real result.
   */
  readonly reportedBy?: string
  readonly durationMs?: number
  readonly outputBytes?: number
}

export const JOB_START = eventKind<JobStart>('job/start')
export const JOB_END = eventKind<JobEnd>('job/end')

// ---- the notice --------------------------------------------------------------

export const JOB_NOTICE_PLUGIN = 'core-jobs'
export const JOB_NOTICE_FORM = 'job-notice'
const NOTICE_PREFIX = 'msg-job-'

/** The one id a job's notice may carry. */
export function jobNoticeId(jobId: string): string {
  return `${NOTICE_PREFIX}${jobId}`
}

/** The job a notice message is about, or undefined for any other message. */
export function noticeJobId(message: Pick<Message, 'id'>): string | undefined {
  return typeof message.id === 'string' && message.id.startsWith(NOTICE_PREFIX) ? message.id.slice(NOTICE_PREFIX.length) : undefined
}

export function isJobNotice(message: Message): boolean {
  return message.source?.kind === 'plugin' && message.source.plugin === JOB_NOTICE_PLUGIN && noticeJobId(message) !== undefined
}

/** A label as a reader sees it: one line, neutralized, bounded. */
export function jobLabel(command: string): string {
  const flat = printableText(command).trim()
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '' : ` after ${(ms / 1000).toFixed(1)}s`
}

const STOPPED_BY: Record<JobCanceller, string> = {
  model: 'at your request',
  user: 'by the user',
  authority: "because this session's sandbox mode or acceptance changed",
  disposal: 'when its session ended',
}

/**
 * What the model is told. A pure function of the bracket, so a notice the
 * registry delivered and one a closer re-delivers for the same end are the
 * same text.
 */
export function jobNoticeText(start: JobStart | undefined, end: JobEnd): string {
  const what = start === undefined ? `Background job ${end.jobId}` : `Background job ${end.jobId} (\`${start.label}\`)`
  const output = start?.output === undefined ? '' : ` Its output is in ${start.output}.`
  switch (end.cause) {
    case 'exited': {
      const how =
        end.exitCode !== undefined ? `exited with code ${end.exitCode}` : end.signal !== undefined ? `was terminated by signal ${end.signal}` : 'exited'
      return `${what} ${how}${seconds(end.durationMs)}. Read its output with job_output.`
    }
    case 'failed':
      return `${what} failed${end.detail === undefined ? '' : `: ${end.detail}`}. Read its output with job_output.`
    case 'cancelled':
      return `${what} was stopped ${STOPPED_BY[end.by ?? 'user']}${seconds(end.durationMs)}.${output}`
    case 'lost': {
      const origin = [start?.callId === undefined ? undefined : `started by call ${start.callId}`, start?.pid === undefined ? undefined : `pid ${start.pid}`]
        .filter((part) => part !== undefined)
        .join(', ')
      return (
        `${what}${origin.length > 0 ? ` (${origin})` : ''} is no longer supervised by this session: its record ended while the job was running — ` +
        'the process that supervised it stopped, or this session was forked from the one that runs it. ' +
        `Its process may still be running, but nothing more from it will arrive here. Check before starting it again.${output}`
      )
    }
  }
}

/** The notice message itself: a plugin-sourced user message whose id is derived, never minted. */
export function jobNotice(start: JobStart | undefined, end: JobEnd): Message {
  return restoreMessage({
    id: asMessageId(jobNoticeId(end.jobId)),
    role: 'user',
    content: [{ type: 'text', text: jobNoticeText(start, end) }],
    source: { kind: 'plugin', plugin: JOB_NOTICE_PLUGIN, form: JOB_NOTICE_FORM },
  })
}

// ---- folds -------------------------------------------------------------------

export type JobNoticeState = 'queued' | 'claimed' | 'cleared'

export interface JobRecord {
  readonly start: JobStart
  readonly startSeq: number
  readonly end?: JobEnd
  readonly endSeq?: number
  /** Its notice's delivery, read from the inbox — never from the end record. */
  readonly notice?: { readonly seq: number; readonly waking: boolean; readonly state: JobNoticeState }
}

interface MutableRecord {
  start: JobStart
  startSeq: number
  end?: JobEnd
  endSeq?: number
  notice?: { seq: number; waking: boolean; state: JobNoticeState }
}

/**
 * Every job the log names, in start order. A notice's state mirrors the inbox
 * queues exactly as `foldInbox` does — a claim drains counts from the front —
 * so `queued` means "in the inbox right now", whatever the turn structure.
 */
export function foldJobs(events: readonly EventEnvelope[]): JobRecord[] {
  const records = new Map<string, MutableRecord>()
  const stepQueue: (string | undefined)[] = []
  const turnQueue: (string | undefined)[] = []
  const leave = (jobId: string | undefined, state: JobNoticeState): void => {
    const notice = jobId === undefined ? undefined : records.get(jobId)?.notice
    if (notice && notice.state === 'queued') notice.state = state
  }
  for (const event of events) {
    if (matches(event, JOB_START)) {
      if (!records.has(event.data.jobId)) records.set(event.data.jobId, { start: event.data, startSeq: event.seq })
    } else if (matches(event, JOB_END)) {
      const record = records.get(event.data.jobId)
      if (record && record.end === undefined) {
        record.end = event.data
        record.endSeq = event.seq
      }
    } else if (matches(event, INBOX_SPLICED)) {
      const splice: InboxSplice = event.data
      if (splice.op === 'insert') {
        const jobId = noticeJobId(splice.message)
        const record = jobId === undefined ? undefined : records.get(jobId)
        if (record && record.notice === undefined) record.notice = { seq: event.seq, waking: splice.waking === true, state: 'queued' }
        ;(splice.queue === 'next-turn' ? turnQueue : stepQueue).push(record ? jobId : undefined)
      } else if (splice.op === 'claim') {
        for (const jobId of stepQueue.splice(0, splice.steps)) leave(jobId, 'claimed')
        for (const jobId of turnQueue.splice(0, splice.turns)) leave(jobId, 'claimed')
      } else {
        for (const jobId of [...stepQueue, ...turnQueue]) leave(jobId, 'cleared')
        stepQueue.length = 0
        turnQueue.length = 0
      }
    }
  }
  return [...records.values()]
}

/**
 * Consecutive turns a job's notice woke with no human in them: the wake
 * budget's fold. A turn that entered a `user`-sourced message — every prompt
 * and steer a surface sends — resets it; a turn that entered a job notice and
 * nothing a person wrote adds one; any other turn leaves it alone. An open
 * turn counts as it stands. A fold, so it survives a resume and needs no
 * counter: only user input refills it.
 */
export function foldJobWakes(events: readonly EventEnvelope[]): number {
  let count = 0
  let turn: { human: boolean; job: boolean } | undefined
  const close = (): void => {
    if (!turn) return
    if (turn.human) count = 0
    else if (turn.job) count++
    turn = undefined
  }
  for (const event of events) {
    if (matches(event, TURN_START)) {
      close()
      turn = { human: false, job: false }
    } else if (matches(event, TURN_END)) close()
    else if (turn && matches(event, USER_MESSAGE)) {
      const message = event.data.message
      if (message.source?.kind === 'user') turn.human = true
      else if (isJobNotice(message)) turn.job = true
    }
  }
  close()
  return count
}

// ---- the closer ----------------------------------------------------------------

/** Error names only crash repair gives a result: such a result reported nothing to the model. */
const REPAIR_RESULT_NAMES: ReadonlySet<string> = new Set(['InterruptedError', 'SalvagedError', 'InFluxError'])

/**
 * What a log owes about its jobs when the writer that ran them is gone — the
 * fourth and LAST closer of `repairTail` (`core/agent/repair.ts`), after the
 * turn: a job is the outermost bracket, opened in some turn and outliving it.
 * `agents.fork` runs it again on the sliced seed, so a fork never shows its
 * source's job as running.
 *
 *   - An unpaired `job/start`: `job/end{lost}`, then its notice.
 *   - An end that owes a notice the log never delivered: the notice. That is
 *     a kill between the end's line and the notice's, or an end a tool call
 *     was to report (`reportedBy`) whose real result never landed.
 *
 * Every notice it emits is QUIET (`waking: false`), so a resume never starts
 * a paid turn because of it: it enters with the next prompt. Pure — the caller
 * supplies the seq and the shared time — so a cold `verify` predicts exactly
 * what a resume appends, and a second crash before they reach disk recomputes
 * the same bytes.
 */
export function closeUnpairedJobs(events: readonly EventEnvelope[], nextSeq: number, time: number): EventEnvelope[] {
  const reported = new Set<string>()
  for (const event of events) {
    if (matches(event, TOOL_RESULT) && !REPAIR_RESULT_NAMES.has(event.data.error?.name ?? '')) reported.add(event.data.callId)
  }
  const closers: EventEnvelope[] = []
  let seq = nextSeq
  const append = (type: string, data: unknown): void => {
    closers.push(deepFreeze({ type, seq: seq++, time, data: snapshotJson(data as never) }) as EventEnvelope)
  }
  const deliver = (record: JobRecord, end: JobEnd): void => {
    const splice: InboxSplice = { op: 'insert', queue: 'next-step', message: jobNotice(record.start, end), waking: false }
    append(INBOX_SPLICED.type, splice)
  }
  for (const record of foldJobs(events)) {
    if (record.end === undefined) {
      const end: JobEnd = { jobId: record.start.jobId, cause: 'lost' }
      append(JOB_END.type, end)
      deliver(record, end)
      continue
    }
    if (record.notice !== undefined) continue
    if (record.end.reportedBy !== undefined && reported.has(record.end.reportedBy)) continue
    deliver(record, record.end)
  }
  return closers
}
