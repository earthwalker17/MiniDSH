/**
 * The effect VOCABULARY: what a call did, recorded by the code that did it.
 *
 * One log-only fact, `effect/recorded`, keyed through `data` by the `callId`
 * of the tool call that caused it (a log-only record may not carry
 * `sourceEventSeqs`; §4). It is written at the EFFECT BOUNDARY by the
 * provider that owns the effect — `fs-local` after a write lands,
 * `shell-stdio` after a command returns — from values that provider itself
 * computed: the canonical path the fence approved, a hash of the bytes
 * actually written, the exit code the process reported, the enforcement that
 * command really got. Never model prose, never a tool's summary of itself.
 *
 * **Presence is proof; absence proves nothing.** The record is appended AFTER
 * the effect, so a crash in between leaves the effect done and unrecorded, and
 * an append that fails is swallowed rather than failing a write that already
 * landed. Nothing may read a missing record as "nothing happened": crash
 * repair reads it as "unknown" (§4), which is the only safe direction. Nor is
 * it an inventory — a shell command's own file writes are not enumerated here,
 * and the spill and attachment stores write outside `ctx.fs` — so the
 * model-facing rendering says so in as many words.
 *
 * Two families, closed. A third producer is a vocabulary change, not a
 * registry: there is no service key here and no provider seam, because a
 * record is data the log already knows how to carry.
 *
 * This file sits below any future service exactly as `approval/events.ts`
 * does, so that crash repair can name an effect without importing a seam that
 * would import the session back.
 */
import type { SandboxEnforcement, SandboxMode } from '../sandbox/events.ts'
import { eventKind } from '../session/types.ts'
import { printableText } from '../text.ts'

/** What happened, per family. Closed: a third family is a deliberate vocabulary change. */
export type EffectRecord =
  | {
      readonly effect: 'fs-write'
      /** The CANONICAL path the fence approved and the write landed on — never the model's spelling of it, which stays in the `tool/call` arguments. */
      readonly path: string
      readonly bytes: number
      /** sha256 of the bytes written, so a resumed session can tell a landed write from a lost one by reading the file. */
      readonly sha256: string
    }
  | {
      readonly effect: 'shell-command'
      /** Absent when the process reported none: it was killed, or the shell died under it. */
      readonly exitCode?: number
      /** Wall clock from the command reaching the child to its result, without the per-owner queue wait before it. */
      readonly durationMs: number
      readonly mode: SandboxMode
      readonly enforcement: SandboxEnforcement
      readonly timedOut?: true
    }

/** The payload: a family plus the call it belongs to. */
export type EffectRecorded = { readonly callId: string } & EffectRecord

export const EFFECT_RECORDED = eventKind<EffectRecorded>('effect/recorded')

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** One recorded effect as one clause. Pure, and safe to put in a line a terminal renders. */
export function describeEffect(record: EffectRecorded): string {
  if (record.effect === 'fs-write') {
    return `wrote ${printableText(record.path)} (${record.bytes} bytes, sha256 ${record.sha256.slice(0, 12)})`
  }
  const outcome =
    record.timedOut === true
      ? 'timed out'
      : record.exitCode === undefined
        ? 'no exit code'
        : `exit ${record.exitCode}`
  return `ran a shell command under ${record.mode}/${record.enforcement} (${outcome}, ${duration(record.durationMs)})`
}

/** How many clauses one line may carry before it stops being readable. */
const MAX_DESCRIBED = 5

/**
 * The evidence sentence for one call, or nothing when the log recorded none.
 *
 * It states its own incompleteness, because a model reading a list is reading
 * an inventory unless told otherwise, and this is not one: only the two
 * families above are recorded at all, and even those can be lost to the crash
 * that made anyone ask.
 */
export function describeEffects(records: readonly EffectRecorded[]): string | undefined {
  if (records.length === 0) return undefined
  const shown = records.slice(0, MAX_DESCRIBED).map(describeEffect)
  const rest = records.length - shown.length
  const more = rest > 0 ? `, and ${rest} more` : ''
  return `Effects recorded for this call, which is what is known and not a complete list of what may have happened: ${shown.join('; ')}${more}.`
}
