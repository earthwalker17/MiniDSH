/**
 * The effect VOCABULARY, in two halves: what a call DID, recorded by the code
 * that did it, and what a call is ABOUT TO do, written by the code that is
 * about to ask permission for it (`EffectIntent`, below).
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
 * repair reads it as "unknown" (§4), which is the only safe direction. And a
 * record is not a fence: the fs fence and the confinement backend never
 * consult it, so losing one loses evidence, never containment (§7). Nor is
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
import { isInvisible, printableText } from '../text.ts'

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

// ---- the "about to do" half ------------------------------------------------

/**
 * What a call is ABOUT TO do, written by trusted code from VALIDATED arguments
 * — the other half of the vocabulary above, and the thing a person consents to.
 *
 * It exists because a consent line assembled from model prose asks someone to
 * approve a description rather than an action: the shell tool's `reason` is
 * `run under "X": <the model's justification>`, and nothing in it is checked
 * against the command that will run. An intent is a PROJECTION of the
 * arguments, never a second source of truth — the body executes the arguments,
 * and a divergence between the two is a bug in whoever built the intent, not a
 * thing the runtime reconciles.
 *
 * **Every intent names the authority its effect would run under.** That is what
 * makes it usable as a grant key: consent to `rm -rf /tmp/x` under
 * `workspace-write` is not consent to the same command under
 * `danger-full-access`. A family that cannot state its authority is not
 * grantable, and the next family must carry its own before it is. For a
 * NETWORK effect the authority is where the data goes and as whom: consent to
 * send a query to one endpoint under one credential is not consent to send it
 * anywhere else, or as anyone else.
 *
 * Two families, closed, exactly as `EffectRecord` is: the second arrived beside
 * its first producer (S18's web search), and a third is a vocabulary change
 * beside its own, not a registry.
 */
export type EffectIntent = ShellIntent | NetworkIntent

/** A shell command about to run, and the sandbox authority it would run under. */
export type ShellIntent = {
  readonly effect: 'shell-command'
  /** The command as validated, never the model's prose about it. */
  readonly command: string
  readonly mode: SandboxMode
  readonly enforcement: SandboxEnforcement
  /**
   * Set when the command carried control characters and `clampIntent` escaped
   * them. It is part of the identity, not a note: within an escaped command a
   * backslash is doubled, so the two classes cannot meet in the middle.
   */
  readonly escaped?: true
  /** Set when `clampIntent` had to cut a field. A truncated intent is never grantable (`intentKey`). */
  readonly truncated?: true
}

/**
 * Data about to leave the machine: what is sent, where to, and as whom.
 *
 * `destination` is treated as UNTRUSTED inside the family even though S18's
 * only producer fills it from row config: a browser tool (S20's question)
 * will fill it from model arguments, so the clamp, the key and the invariant
 * hold it to the rules any model-written field meets, today.
 */
export type NetworkIntent = {
  readonly effect: 'network-request'
  /** The full URL the request goes to — scheme, host, port and path — never a host alone, which would let one consent cover every path. */
  readonly destination: string
  /** The `CredentialRef` NAME the request authenticates as. A name, never a value: this field is durable and rendered. */
  readonly credential: string
  /** What leaves the machine: the validated argument the body sends, never the model's prose about it. */
  readonly payload: string
  /** As for a shell intent, and set when ANY of the three fields carried a control character: all three are then escaped. */
  readonly escaped?: true
  /** Set when `clampIntent` cut the payload or the destination. Never grantable. */
  readonly truncated?: true
}

/**
 * How long a field may be before the clamp cuts it.
 *
 * Generous on purpose: this is a consent line, and a person asked to approve
 * a command must be shown the command (hiding its tail asks for consent to
 * text they cannot read — upstream rejected a cap on its own approval panel
 * for that reason). The bound exists so one durable record cannot be
 * unbounded, not to summarize.
 */
export const MAX_INTENT_CHARS = 4000

/**
 * A control character has no printable form, and a subject needs one that is
 * both safe in a terminal and FAITHFUL: escaping gives both, where replacing
 * gives only the first.
 *
 * `printableText` (the rule everywhere else this runtime renders text it did
 * not author) maps every C0/C1 control to a space — many-to-one. Applied to a
 * consent subject that is fatal in two ways at once: a person answering
 * `[y/N]` for `echo rm -rf ~/work` would be consenting to a rendering of
 * `echo\nrm -rf ~/work`, two commands where they read one; and the two share a
 * grant key, so one consent covers both forever. Escaping is injective, so
 * neither happens. Backslash is escaped too, or `echo \n` typed literally
 * would meet a real newline in the middle.
 */
function escapeControls(text: string): string {
  const named: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\' }
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (named[ch] !== undefined) out += named[ch]
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\x${code.toString(16).padStart(2, '0')}`
    else if (INVISIBLE.test(ch) || BLANK.test(ch)) out += `\\u{${code.toString(16)}}`
    else out += ch
  }
  return out
}

/**
 * A character that renders as NOTHING (`isInvisible`, core/text.ts) is worse
 * on a consent line than a control, which at least moves the cursor: the S18
 * review encoded a secret in TAG characters after a visible query, the line
 * read as the query alone, and the hidden text was in the POST body. Escaped
 * like a control, so what a person approves is every character sent.
 */
const INVISIBLE = { test: isInvisible }

/**
 * A character that renders as an ordinary SPACE and is not one: every other
 * `White_Space` character (no-break, en, em, ideographic …) and the Braille
 * blank. The S20.5 review sent 32 hidden bits as EN and EM spaces after a
 * visible query, and the consent line showed a run of blanks a monospace
 * terminal renders exactly like spaces. Escaped too, so U+0020 is the only
 * blank a person approves.
 */
const BLANK = /(?! )[\p{White_Space}\u2800]/u

/** True iff `escapeControls` would change anything but a backslash. */
function hasControls(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || INVISIBLE.test(ch) || BLANK.test(ch)) return true
  }
  return false
}

/**
 * Made printable and bounded, at the seam, before it reaches the log.
 *
 * A command with no control characters is left VERBATIM — the common case, and
 * the one where doubling every backslash would make a Windows path harder to
 * read for nothing. One with control characters is escaped whole, backslashes
 * included, and marked `escaped`; since the mark is part of the key, a verbatim
 * command can never collide with an escaped one that renders the same way.
 *
 * Truncation is recorded rather than silent for the same reason the escape is
 * injective: the field is an IDENTITY, not only a rendering, and two commands
 * sharing a 4000-character prefix would otherwise share one grant. A cut intent
 * keeps its (partial) rendering and loses its key — the fail-closed direction.
 *
 * A network intent has three free strings and ONE `escaped` mark, so the mark
 * covers all three: if any field carries a control character, every field is
 * escaped. Escaping only the offending one would leave the key unable to say
 * which field the mark belongs to, and a verbatim `\n` typed in one field
 * could then meet an escaped newline in another.
 */
export function clampIntent(intent: ShellIntent): ShellIntent
export function clampIntent(intent: NetworkIntent): NetworkIntent
export function clampIntent(intent: EffectIntent): EffectIntent
export function clampIntent(intent: EffectIntent): EffectIntent {
  if (intent.effect === 'network-request') return clampNetwork(intent)
  const escaped = hasControls(intent.command)
  const base = escaped ? { ...intent, command: escapeControls(intent.command), escaped: true as const } : intent
  if (base.command.length <= MAX_INTENT_CHARS) return base
  return { ...base, command: base.command.slice(0, MAX_INTENT_CHARS), truncated: true }
}

function clampNetwork(intent: NetworkIntent): NetworkIntent {
  const escaped = hasControls(intent.destination) || hasControls(intent.credential) || hasControls(intent.payload)
  const base: NetworkIntent = escaped
    ? {
        ...intent,
        destination: escapeControls(intent.destination),
        credential: escapeControls(intent.credential),
        payload: escapeControls(intent.payload),
        escaped: true,
      }
    : intent
  if (base.payload.length <= MAX_INTENT_CHARS && base.destination.length <= MAX_INTENT_CHARS) return base
  return { ...base, destination: base.destination.slice(0, MAX_INTENT_CHARS), payload: base.payload.slice(0, MAX_INTENT_CHARS), truncated: true }
}

/**
 * The identity of `toolName` acting on `intent`, or `undefined` when there is
 * none to be had.
 *
 * Explicit and length-prefixed rather than canonical JSON: the union is closed,
 * so the key can be built field by field, and building it that way removes key
 * order, an optional field's presence, a separator appearing inside a command,
 * and a later field rename in one stroke. A generic canonicalizer would have to
 * be audited against all four.
 *
 * `undefined` for a truncated intent, so a caller that forgets the rule gets a
 * type error rather than a collision.
 */
export function intentKey(toolName: string, intent: EffectIntent): string | undefined {
  if (intent.truncated === true) return undefined
  if (intent.effect === 'network-request') {
    // The family name sits where a shell key has its own, after the
    // length-prefixed tool, so no key of one family can spell one of the other.
    return [
      'v1',
      String(toolName.length),
      toolName,
      intent.effect,
      String(intent.destination.length),
      intent.destination,
      String(intent.credential.length),
      intent.credential,
      intent.escaped === true ? 'esc' : 'raw',
      String(intent.payload.length),
      intent.payload,
    ].join('\0')
  }
  // Byte-identical to the key every shipped grant was minted under: a shell
  // key that moved would silently end every standing consent in a stored log.
  const parts = [
    'v1',
    String(toolName.length),
    toolName,
    intent.effect,
    intent.mode,
    intent.enforcement,
    intent.escaped === true ? 'esc' : 'raw',
    String(intent.command.length),
    intent.command,
  ]
  return parts.join('\0')
}

/** One intent as one clause, for the line a person answers. Pure, and safe in a terminal. */
export function describeIntent(intent: EffectIntent): string {
  const notes = [
    ...(intent.escaped === true ? ['control or invisible characters shown escaped'] : []),
    ...(intent.truncated === true ? [`cut at ${MAX_INTENT_CHARS} characters`] : []),
  ]
  const said = notes.length === 0 ? '' : ` […${notes.join('; ')}]`
  // The notes close the whole clause: a network intent may cut its destination
  // as well as its payload, and one escape mark covers all three fields.
  if (intent.effect === 'network-request') return `send \`${intent.payload}\` to ${intent.destination} as ${intent.credential}${said}`
  return `run \`${intent.command}\`${said} under ${intent.mode}/${intent.enforcement}`
}

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
