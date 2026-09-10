/**
 * Large-output spill: where a tool's output goes when it is too big to be
 * conversation.
 *
 * The rule the design turns on: spill is for output that has NO OTHER HOME. A
 * file the model asked to view is already on disk, so the honest answer there
 * is a line range, not a copy. A shell command's stdout exists nowhere once the
 * process exits — so it is saved, and the model is handed a bounded excerpt
 * plus the path it can read the rest from with the tools it already has.
 *
 * The bytes never enter the log, exactly as `docs/ARCHITECTURE.md` §11 rules for the
 * attachment plane. The durable `tool/result` carries the excerpt, which IS
 * the truth of what the model saw; the full text sits beside the session log
 * under the same home, as durable as the log itself.
 *
 * The store is a Definition because the threshold is not its business: each
 * tool owns how much of its own output is worth showing, and passes the rest
 * here. There is no policy in this file.
 */
import { serviceKey } from '../../kernel/index.ts'

export interface SpillRef {
  /** Absolute path the model is told to read. */
  readonly path: string
  readonly bytes: number
}

export interface SpillRequest {
  readonly sessionId: string
  /** The tool call this output belongs to; the store's natural unique name. */
  readonly callId: string
  /** A short human tag for the file name (`bash`, `view`). */
  readonly label: string
  readonly text: string
}

export interface Spill {
  save(request: SpillRequest): SpillRef
}

export const SPILL = serviceKey<Spill>('spill')

export interface ExcerptOptions {
  readonly headChars: number
  readonly tailChars: number
}

/**
 * Head, tail, and an honest gap. Both ends matter: a command's first lines say
 * what it did and its last lines say how it ended, and a head-only truncation
 * hides exactly the error a model is usually looking for.
 */
export function excerptWithSpill(text: string, ref: SpillRef, options: ExcerptOptions): string {
  // Spread ONCE. A shell capture runs to half a megabyte, and each spread is a
  // fresh array of that many one-character strings.
  const chars = [...text]
  const head = chars.slice(0, options.headChars).join('')
  const tail = options.tailChars > 0 ? chars.slice(-options.tailChars).join('') : ''
  const total = chars.length
  const omitted = Math.max(0, total - options.headChars - options.tailChars)
  const notice =
    `\n[${omitted.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters omitted. ` +
    `The complete output is saved at ${ref.path} — read it with the file viewer (a line range at a time) or search it from the shell.]\n`
  return omitted <= 0 ? text : `${head}${notice}${tail}`
}

/** The same shape when no store is mounted: bounded, and honest that the rest is gone. */
export function excerptWithoutSpill(text: string, options: ExcerptOptions): string {
  const chars = [...text]
  const total = chars.length
  const omitted = Math.max(0, total - options.headChars - options.tailChars)
  if (omitted <= 0) return text
  const head = chars.slice(0, options.headChars).join('')
  const tail = options.tailChars > 0 ? chars.slice(-options.tailChars).join('') : ''
  return `${head}\n[${omitted.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters omitted and not retained. Re-run with a narrower command to see them.]\n${tail}`
}
