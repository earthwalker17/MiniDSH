/**
 * A session's human-readable name.
 *
 * The title is a log-only fact, `session/title`, last-wins — never a field on
 * the header, which is immutable storage metadata written once. That placement
 * is what makes a title survive resume, fork and replay for free: a fork's seed
 * carries the event, so a branch inherits its parent's name without anybody
 * copying anything.
 *
 * The kind and the fold live in core because both readers are capabilities
 * (`persistence-jsonl` listing a store, `protocol` answering `sessions/list`)
 * and capabilities may not import each other. The WRITER is a capability, so a
 * deployment can replace or disable how titles are chosen without the log
 * format moving.
 *
 * `source` is durable and discriminated from the first version, because the
 * rule that will need it already exists in the reference implementation: an
 * explicit rename PINS a title, and automatic generation must be able to see
 * that it did. A record with no provenance could not express that later without
 * a format edge, so the vocabulary is complete even though only `fallback` is
 * produced today.
 */
import { messageText } from '../llm/message.ts'
import { eventKind, matches, USER_MESSAGE, type EventEnvelope } from './types.ts'

export type SessionTitleSource =
  | { readonly kind: 'fallback' }
  /** A model wrote it. `model` is provenance, not a route: what produced THIS string. */
  | { readonly kind: 'provider'; readonly provider: string; readonly model?: string }
  /** A person wrote it. Pins the title. */
  | { readonly kind: 'user' }

export interface SessionTitleRecord {
  readonly title: string
  /** The `user/message` seqs this title was derived from; empty for a rename. */
  readonly messageSeqs: readonly number[]
  readonly source: SessionTitleSource
}

/** Log-only: a session's name. Last-wins; it never enters model history. */
export const SESSION_TITLE = eventKind<SessionTitleRecord>('session/title')

/** Words kept from the first prompt. Enough to tell two sessions apart, short enough for a sidebar. */
export const TITLE_MAX_WORDS = 10
/** Code points, not bytes: the bound exists so a pasted file cannot become a title, and so a row fits. */
export const TITLE_MAX_CHARS = 80

const DEL = 0x7f
const C1_END = 0x9f
const SPACE = 0x20

/**
 * A code point this title may not carry.
 *
 * Two families, for two reasons. C0, DEL and C1 go because a title is printed
 * into a terminal by two surfaces, and an ESC in it is a cursor movement rather
 * than a character; removing the introducer is what disarms the sequence, and
 * the printable remainder ("[31m") is left as the harmless text it now is
 * rather than pattern-matched — the danger was the escape, not the digits. Bidi
 * overrides and isolates go because their whole purpose is to make a run of
 * text render as something other than what it says, which in a list of names a
 * person picks from is exactly the wrong property.
 */
function stripped(code: number): 'drop' | 'space' | 'keep' {
  if (code < SPACE || (code >= DEL && code <= C1_END)) return 'space'
  if (code >= 0x200e && code <= 0x200f) return 'drop'
  if (code >= 0x202a && code <= 0x202e) return 'drop'
  if (code >= 0x2066 && code <= 0x2069) return 'drop'
  return 'keep'
}

/** One line of plain text: nothing that moves a cursor or reorders a glyph, whitespace collapsed. */
function clean(text: string): string {
  let out = ''
  for (const character of text) {
    const verdict = stripped(character.codePointAt(0)!)
    if (verdict === 'keep') out += character
    else if (verdict === 'space') out += ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** The first words, cut on a code-point boundary so a title never ends in half a character. */
function shorten(text: string): string {
  const words = text.split(' ').slice(0, TITLE_MAX_WORDS).join(' ')
  const points = [...words]
  return points.length <= TITLE_MAX_CHARS ? words : `${points.slice(0, TITLE_MAX_CHARS - 1).join('')}…`
}

/**
 * What one event contributes, or nothing.
 *
 * Only a message a PERSON sent is eligible: a compaction summary and an
 * injected note are `user/message`s too, with a `source.kind` of `plugin`, and
 * a tool result is one with `kind: 'tool'`. Titling a session after its own
 * summary is the failure this guard exists to prevent. A message that cleans to
 * nothing is skipped rather than becoming a blank name.
 */
function titleOf(event: EventEnvelope): string | undefined {
  if (!matches(event, USER_MESSAGE)) return undefined
  if (event.data.message?.source?.kind !== 'user') return undefined
  const text = clean(messageText(event.data.message))
  return text.length === 0 ? undefined : shorten(text)
}

export interface SessionTitleState {
  /** The last `session/title` in the log, if one was ever written. */
  readonly recorded?: SessionTitleRecord
  /** What a fallback would be, from the first eligible prompt. Present even when `recorded` is. */
  readonly fallback?: { readonly title: string; readonly messageSeqs: readonly number[] }
}

/**
 * One forward pass for both halves: the LAST recorded title and the FIRST
 * eligible prompt. Two passes would be two answers looked for in opposite
 * directions over the same array, and the writer needs both at once.
 */
export function scanSessionTitle(events: Iterable<EventEnvelope>): SessionTitleState {
  let recorded: SessionTitleRecord | undefined
  let fallback: { title: string; messageSeqs: readonly number[] } | undefined
  for (const event of events) {
    if (matches(event, SESSION_TITLE)) {
      recorded = event.data
      continue
    }
    if (fallback !== undefined) continue
    const title = titleOf(event)
    if (title !== undefined) fallback = { title, messageSeqs: [event.seq] }
  }
  return { ...(recorded === undefined ? {} : { recorded }), ...(fallback === undefined ? {} : { fallback }) }
}

/**
 * The name to show: what the log records, else what the first prompt says.
 *
 * The derivation is not dead weight beside the record. It is what gives a log
 * written before titles existed — or one whose writer row a deployment
 * disabled — a name anyway, and it is the same function the writer uses, so
 * there is one definition of what a title is rather than two.
 */
export function foldSessionTitle(events: Iterable<EventEnvelope>): string | undefined {
  const state = scanSessionTitle(events)
  return state.recorded?.title ?? state.fallback?.title
}
