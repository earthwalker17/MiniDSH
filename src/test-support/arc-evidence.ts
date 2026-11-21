/**
 * What the live arcs read off a log, in one place: the few readings several
 * arcs got wrong in the same way, each fixed once here and tested without a
 * model (`arc-evidence.test.ts`).
 *
 *   - a session's stored log, as events (a replayed run leaves nothing else);
 *   - whether a `tool/result` FAILED (the flag is on the message's block and
 *     the code beside it, not a field of the record);
 *   - whether a call's JSON arguments name a path (JSON doubles a Windows
 *     path's backslashes);
 *   - the walk a session took over its surface and its compactions, so a
 *     replay can be held to the recording's walk instead of to a count;
 *   - and the evidence of a replay that left its recording, written where the
 *     arc's own cleanup will not delete it.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPACTION_APPLIED, COMPACTION_END, COMPACTION_START } from '../core/compaction/events.ts'
import { matches, STEP_START, TOOL_RESULT, type EventEnvelope } from '../core/session/index.ts'
import type { ReplayHandle } from './llm-replay.ts'

// ---- a stored log --------------------------------------------------------------

/**
 * The events of a session's stored log under `sessionsRoot`, read from the
 * file as another process would read it: the header line dropped, every other
 * line an event. For the replay legs, whose replayed session leaves nothing
 * else behind — what its tools really answered is only here.
 */
export function storedLog(sessionsRoot: string, sessionId: string): EventEnvelope[] {
  return readFileSync(join(sessionsRoot, `${encodeURIComponent(sessionId)}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

// ---- tool results ------------------------------------------------------------

/**
 * Whether a `tool/result` is an error. The record is `{turn, step, callId,
 * message, error?}`: the model-facing flag lives on the message's tool-result
 * block and the code in `error`. There is no `isError` on the record itself,
 * and an arc that read one saw every failed call as a success.
 */
export function resultFailed(event: EventEnvelope): boolean {
  if (!matches(event, TOOL_RESULT)) throw new Error(`resultFailed: ${event.type} at seq ${event.seq} is not a tool/result`)
  const block = event.data.message.content[0]
  return event.data.error !== undefined || (block?.type === 'tool-result' && block.isError === true)
}

/** The text a `tool/result` showed the model. */
export function resultText(event: EventEnvelope): string {
  if (!matches(event, TOOL_RESULT)) throw new Error(`resultText: ${event.type} at seq ${event.seq} is not a tool/result`)
  const block = event.data.message.content[0]
  const content = block?.type === 'tool-result' ? block.content : []
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

// ---- paths in arguments ------------------------------------------------------

/**
 * Whether a call's JSON `arguments` name `path`. A `tool/call` holds its
 * arguments as JSON TEXT, where a Windows path's backslashes are doubled, so a
 * search for the path as the file system spells it never matched one — and a
 * model on Windows writes forward slashes as readily. Every spelling, compared
 * in lower case on Windows, as that file system compares.
 */
export function namesPath(argumentsJson: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (text: string): string => (platform === 'win32' ? text.toLowerCase() : text)
  const spellings = new Set([path, JSON.stringify(path).slice(1, -1), path.replaceAll('\\', '/')])
  const text = fold(argumentsJson)
  return [...spellings].some((spelling) => text.includes(fold(spelling)))
}

// ---- the walk ----------------------------------------------------------------

/**
 * The path a session took over its SURFACE: every surface event in order, by
 * its position among surface events rather than its seq, and every compaction
 * attempt with the span it planned (in those positions), the step it came at
 * and how it ended.
 *
 * Positions, not seqs, because the recording and its replay are opened by
 * different callers and need not write the same log-only facts; what a replay
 * owes its recording is the same model-visible history, compacted at the same
 * points. Sizes and projections are deliberately not part of it: they are the
 * estimator's, and they are what a dump shows beside a walk that differs.
 */
export function surfaceWalk(events: readonly EventEnvelope[]): string[] {
  const position = new Map<number, number>()
  const walk: string[] = []
  const planned = new Map<number, string>()
  let at = 'before any step'
  const where = (seq: number): string => (position.has(seq) ? `#${position.get(seq)}` : `seq ${seq} (not on the surface)`)
  for (const event of events) {
    if (matches(event, STEP_START)) at = `step ${event.data.turn}:${event.data.step}`
    if (matches(event, COMPACTION_START)) {
      planned.set(event.seq, `compaction (${event.data.trigger}) after ${at}, planned ${where(event.data.plannedStart)}..${where(event.data.plannedEnd)} (${event.data.plannedNodes} nodes)`)
    } else if (matches(event, COMPACTION_END)) {
      const outcome = event.data.outcome.kind === 'applied' ? 'applied' : `declined (${event.data.outcome.reason})`
      walk.push(`${planned.get(event.data.startSeq) ?? `compaction started at seq ${event.data.startSeq}`}: ${outcome}`)
      planned.delete(event.data.startSeq)
    }
    if (event.surfaceOp === undefined) continue
    position.set(event.seq, position.size)
    const source = (event.data as { message?: { source?: { kind?: string; form?: string } } }).message?.source
    const kind = source === undefined ? '' : ` (${source.form ?? source.kind ?? '?'})`
    walk.push(
      event.surfaceOp.op === 'append'
        ? `#${position.get(event.seq)} append ${event.type}${kind}`
        : `#${position.get(event.seq)} replace ${where(event.surfaceOp.start)}..${where(event.surfaceOp.end)} by ${event.type}${kind}`,
    )
  }
  for (const open of planned.values()) walk.push(`${open}: never closed`)
  return walk
}

/** Every compaction attempt as the log recorded it, numbers included: what a differing walk is read against. */
export function compactionRecords(events: readonly EventEnvelope[]): string[] {
  return events.flatMap((event) => {
    if (matches(event, COMPACTION_START)) {
      return [`${event.seq} start   ${event.data.trigger}: projected ${event.data.projectedTokens} of ${event.data.budgetTokens}, planned seqs ${event.data.plannedStart}..${event.data.plannedEnd} (${event.data.plannedNodes} nodes)`]
    }
    if (matches(event, COMPACTION_APPLIED)) {
      return [`${event.seq} applied surface ${event.data.surfaceTokensBefore} -> ${event.data.surfaceTokensAfter}, shadowed ${event.data.shadowedSeqs.join(',')}, kept ${event.data.retainedNodes}, summary at ${event.data.auxCallSeq}`]
    }
    if (matches(event, COMPACTION_END)) {
      return [`${event.seq} end     of ${event.data.startSeq}: ${event.data.outcome.kind === 'applied' ? 'applied' : `declined (${event.data.outcome.reason})`}`]
    }
    return []
  })
}

// ---- a replay that left its recording ----------------------------------------

export interface ReplayEvidence {
  /** The arc, for the file's name. */
  readonly arc: string
  readonly handle: ReplayHandle
  /** The recording the replay was installed from. */
  readonly recorded: readonly EventEnvelope[]
  /** The replayed session's own log. */
  readonly replayed: readonly EventEnvelope[]
  /**
   * Hold the replay to the recording's WALK as well as to its counts: the same
   * surface events in the same order, compacted at the same points. For a
   * replay that drives the recording's own prompts in the recording's own
   * composition; a count can agree while the points do not.
   */
  readonly sameWalk?: boolean
  /** Where to keep the evidence of a failure. Default: a directory of this process's own under the temp directory, which no arc's cleanup knows. */
  readonly keepIn?: string
}

/** Where evidence goes by default: one directory per process, never registered with any arc's cleanup. */
let evidenceRoot: string | undefined

/**
 * The oracle's verdict for a finished replay, with the evidence kept when it
 * is "no". The recording lives only in the arc's memory and the replayed log
 * in a directory its `afterAll` deletes, so a failure used to leave one line
 * ("replayed 7 of 8 recorded out-of-loop calls") and nothing to read it
 * against. On any mismatch both logs, both walks and every cursor are written
 * to a file the failure names, and the compaction records of both are in the
 * failure itself, for a run whose disk nobody will see.
 */
export function assertReplayed(evidence: ReplayEvidence): void {
  const failures: string[] = []
  try {
    evidence.handle.assertConsumed()
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  const recordedWalk = surfaceWalk(evidence.recorded)
  const replayedWalk = surfaceWalk(evidence.replayed)
  if (evidence.sameWalk === true) {
    const first = recordedWalk.findIndex((step, index) => step !== replayedWalk[index])
    const diverged = first !== -1 ? first : replayedWalk.length > recordedWalk.length ? recordedWalk.length : -1
    if (diverged !== -1) {
      failures.push(
        `the replay left the recording's walk at entry ${diverged} of ${recordedWalk.length} (the replay made ${replayedWalk.length}):\n` +
          `  recorded: ${recordedWalk[diverged] ?? '(nothing more)'}\n  replayed: ${replayedWalk[diverged] ?? '(nothing more)'}`,
      )
    }
  }
  if (failures.length === 0) return
  let kept: string
  try {
    const root = evidence.keepIn ?? (evidenceRoot ??= mkdtempSync(join(tmpdir(), 'minidsh-replay-evidence-')))
    mkdirSync(root, { recursive: true })
    kept = join(root, `${evidence.arc.replace(/[^a-z0-9-]+/gi, '-')}-${Date.now()}.json`)
    writeFileSync(
      kept,
      `${JSON.stringify({ arc: evidence.arc, failures, cursors: evidence.handle.cursors(), walk: { recorded: recordedWalk, replayed: replayedWalk }, recorded: evidence.recorded, replayed: evidence.replayed }, null, 1)}\n`,
    )
  } catch (error) {
    kept = `(not written: ${error instanceof Error ? error.message : String(error)})`
  }
  const cursors = evidence.handle
    .cursors()
    .logs.map((log) => `${log.log}: steps ${log.steps.replayed}/${log.steps.recorded}${log.steps.next === undefined ? '' : ` (next recorded at ${log.steps.next})`}, out-of-loop ${log.outOfLoop.replayed}/${log.outOfLoop.recorded}, asked past the end ${log.overAsked.length}`)
  throw new Error(
    [
      ...failures,
      `cursors: ${cursors.join('; ')}`,
      `compactions recorded:\n  ${compactionRecords(evidence.recorded).join('\n  ') || 'none'}`,
      `compactions replayed:\n  ${compactionRecords(evidence.replayed).join('\n  ') || 'none'}`,
      `both logs, both walks and the cursors are kept at ${kept}`,
    ].join('\n'),
  )
}
