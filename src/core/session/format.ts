/**
 * What a reader may assume about a stored log's SHAPE, and the one refusal
 * that is not damage (ARCHITECTURE §4).
 *
 * **The format is the header's `version`, fixed when the log was created.** A
 * writer continues (resumes, attaches to) only a log of its own format; it
 * reads an older one and forks it, and it refuses a newer one with
 * `SessionFormatError`. A per-lifecycle format mark raised mid-log was
 * considered and refused: `minidsh@1.0.0`, the only released reader, refuses by
 * header alone, so it would continue a log a newer writer had marked — the one
 * misread a format number exists to prevent. The header is the only mark every
 * shipped reader already honours.
 *
 * **When a change needs a new format.** A change is additive only if an OLDER
 * reader that ignores it becomes more conservative: narrower authority,
 * `TOOL_OUTCOME_UNKNOWN` rather than `TOOL_NOT_STARTED`, a refusal rather than
 * a run. A new fact kind usually is (an older reader skips it as an opaque
 * fact); a new surface kind, a new envelope field, a changed meaning, or a fact
 * that NARROWS authority or that repair must honour is not, and bumps
 * `SESSION_FORMAT_VERSION` with an in-memory migration for reading.
 *
 * **Inside a declared format, a malformed line is damage, not format.** A
 * writer that follows the rule above never writes an envelope key or a surface
 * kind its format lacks, so meeting one means the bytes are not what the
 * writer wrote: `envelopeFault` names it, and the store stops its readable
 * prefix there (`damaged`), which keeps the log showable and salvageable.
 */
import { SESSION_FORMAT_VERSION, SURFACE_TYPES } from './types.ts'

/** A stored log this reader cannot faithfully read. Nothing is damaged: a newer MiniDSH can read it. */
export class SessionFormatError extends Error {
  readonly code = 'SESSION_FORMAT_UNSUPPORTED' as const
  readonly found: number
  readonly supported = SESSION_FORMAT_VERSION
  constructor(id: string, found: number, where?: string) {
    super(
      `session ${id}: the stored log is format ${found}, and this MiniDSH reads format ${SESSION_FORMAT_VERSION}` +
        `${found > SESSION_FORMAT_VERSION ? ' — it was written by a newer MiniDSH; upgrade to read it' : ' — fork it to continue it here'}` +
        `${where === undefined ? '' : ` (${where})`}`,
    )
    this.name = 'SessionFormatError'
    this.found = found
  }
}

/** The six envelope keys; a stored line carrying any other is not an event this format writes. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'])

/**
 * What is wrong with a parsed line as an event envelope, or `undefined` when
 * nothing is. Read as `unknown` because it came off a disk: the checks are the
 * envelope's own (a closed key set, the field types, a surface field only on a
 * surface kind), never a payload's — payloads are their owners' to judge.
 */
export function envelopeFault(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not an event envelope'
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) if (!ENVELOPE_KEYS.has(key)) return `an envelope field this format does not have ("${key}")`
  if (typeof record.type !== 'string' || record.type.length === 0) return 'no event type'
  if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 0) return 'no integer seq'
  if (typeof record.time !== 'number' || !Number.isFinite(record.time)) return 'no timestamp'
  if (!('data' in record)) return 'no payload'
  const surface = SURFACE_TYPES.has(record.type)
  if (!surface && (record.surfaceOp !== undefined || record.sourceEventSeqs !== undefined)) {
    return `a surface operation on "${record.type}", which is not a surface kind`
  }
  if (surface && record.surfaceOp === undefined) return `a "${record.type}" with no surface operation`
  return undefined
}
