/**
 * Raw stdin to keys: the full-screen terminal's one reader of what a person
 * typed, and the one place that knows what a terminal sends.
 *
 * Pure and stateful. Bytes arrive in chunks the OS chose, so everything that
 * can straddle a chunk is held until it completes: a UTF-8 code point (the
 * string decoder), an escape sequence, an open bracketed paste. The caller
 * owns time: when `pending` stays true past its escape timeout it calls
 * `flush()`, and a held lone ESC becomes the Escape key. Splitting a stream at
 * any byte gives the same keys as feeding it whole (the suite checks every
 * split) — apart from how typed text coalesces, and apart from the burst rule
 * below, which is a judgement about one chunk by design.
 *
 * What was measured (Windows Terminal and ConPTY, Node 24 raw mode) and why the
 * rules look as they do:
 * - libuv drops Shift and Alt from Enter (both `\r`), and Alt from a letter;
 *   Ctrl+Enter is `\n`. So `linefeed` is the one distinct "newline" key there,
 *   and POSIX terminals add CSI u, modifyOtherKeys and `ESC \r` for the rest.
 * - The terminal ANSWERS queries on the same stream (DA1, DECRPM, OSC colour
 *   replies). Any CSI that is not a key, and every OSC/DCS/APC/PM, is
 *   swallowed, so a reply can never become text in the composer.
 * - A paste without bracketing markers (conhost, some terminals) arrives as
 *   1024-byte chunks with `\r` line separators, which would otherwise SUBMIT at
 *   the first line. A chunk holding at least three printable characters and a
 *   line break is therefore one paste, and a line-break chunk that follows a
 *   paste chunk within `pasteGraceMs` (the paste's tail, split off by the OS)
 *   continues it. Typed input is one character per chunk, so a person's Enter
 *   is never a burst; the cost is that a slow event loop can coalesce
 *   type-ahead into one, which then lands as a newline, not a send.
 * - Bounds: a CSI past 256 code units or a string sequence past 4096 is still
 *   consumed to its end but no longer held (its body is never interpreted), so
 *   garbage cannot grow the buffer; a bracketed paste keeps its first 4 MiB.
 */
import { StringDecoder } from 'node:string_decoder'

export type Key =
  | { readonly kind: 'text'; readonly text: string; readonly paste?: true }
  | { readonly kind: 'key'; readonly name: KeyName; readonly ctrl?: true; readonly alt?: true; readonly shift?: true }

/** A named key, `f1`..`f12`, or for a ctrl/alt combo the lowercase letter or symbol (`' '` for Ctrl+Space). */
export type KeyName =
  | 'enter'
  | 'linefeed'
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'insert'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | `f${number}`
  | string

export interface KeyDecoderOptions {
  readonly now?: () => number
  readonly pasteGraceMs?: number
}

const ESC = '\x1b'
const PASTE_START = '200'
const PASTE_END = '\x1b[201~'
const CSI_MAX = 256
const STRING_MAX = 4096
const PASTE_MAX = 4 * 1024 * 1024

/** xterm's modifier bits: the CSI parameter is 1 + their sum. */
const SHIFT = 1
const ALT = 2
const CTRL = 4

const FINAL: Readonly<Record<string, string>> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }
const SS3: Readonly<Record<string, string>> = { ...FINAL, P: 'f1', Q: 'f2', R: 'f3', S: 'f4', M: 'enter' }
const TILDE: Readonly<Record<number, string>> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
}
const CTRL_SYMBOLS = ['\\', ']', '^', '_'] as const

function named(name: string, mods: number): Key {
  const key: { kind: 'key'; name: string; ctrl?: true; alt?: true; shift?: true } = { kind: 'key', name }
  if (mods & CTRL) key.ctrl = true
  if (mods & ALT) key.alt = true
  if (mods & SHIFT) key.shift = true
  return key
}

/** A C0 control byte (not ESC) or DEL as a key. */
function controlKey(code: number, mods: number): Key {
  switch (code) {
    case 0x0d:
      return named('enter', mods)
    case 0x0a:
      return named('linefeed', mods)
    case 0x09:
      return named('tab', mods)
    case 0x7f:
      return named('backspace', mods)
    case 0x08:
      return named('backspace', mods | CTRL)
    case 0x00:
      return named(' ', mods | CTRL)
  }
  if (code <= 0x1a) return named(String.fromCharCode(0x60 + code), mods | CTRL)
  return named(CTRL_SYMBOLS[code - 0x1c] ?? '?', mods | CTRL)
}

/** A character with modifiers: an uppercase letter is its lowercase name plus shift. */
function charKey(ch: string, mods: number): Key {
  const lower = ch.toLowerCase()
  return named(lower, lower === ch ? mods : mods | SHIFT)
}

/** A CSI u / modifyOtherKeys code point. Unmodified (or shift-only) printable characters are text, as typed. */
function codeKey(code: number, mods: number): Key | undefined {
  if (code === 13) return named('enter', mods)
  if (code === 9) return named('tab', mods)
  if (code === 27) return named('escape', mods)
  if (code === 127 || code === 8) return named('backspace', mods)
  if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code >= 0x7f && code <= 0x9f)) return undefined
  const ch = String.fromCodePoint(code)
  if ((mods & (CTRL | ALT)) === 0) return { kind: 'text', text: mods & SHIFT ? ch.toUpperCase() : ch }
  return charKey(ch, mods)
}

function modifiers(param: number | undefined): number {
  return param === undefined || param < 1 ? 0 : (param - 1) & (SHIFT | ALT | CTRL)
}

/** A complete CSI's body (parameters and intermediates) and final byte to a key, or undefined to swallow it. */
function csiKey(body: string, final: string): Key | undefined {
  // A private marker or an intermediate byte is a terminal reply or report (DA1, DECRPM, mouse), never a key.
  if (/^[<=>?]/.test(body) || /[\x20-\x2f]/.test(body)) return undefined
  const params = body.split(';').map((p) => {
    const n = Number.parseInt(p.split(':')[0] ?? '', 10)
    return Number.isNaN(n) ? undefined : n
  })
  const name = FINAL[final]
  if (name !== undefined) return named(name, modifiers(params[1]))
  if (final === 'Z') return named('tab', modifiers(params[1]) | SHIFT)
  if (final === 'u') return params[0] === undefined ? undefined : codeKey(params[0], modifiers(params[1]))
  if (final === '~') {
    if (params[0] === 27) return params[2] === undefined ? undefined : codeKey(params[2], modifiers(params[1]))
    const tilde = params[0] === undefined ? undefined : TILDE[params[0]]
    return tilde === undefined ? undefined : named(tilde, modifiers(params[1]))
  }
  return undefined
}

/** One decoded escape: where it ends, and its key or the start of a paste. Undefined: incomplete, hold it. */
interface Step {
  readonly end: number
  readonly key?: Key | undefined
  readonly paste?: boolean
}

function csi(data: string, i: number): Step | undefined {
  let k = i + 2
  while (k < data.length && data.charCodeAt(k) >= 0x20 && data.charCodeAt(k) <= 0x3f) k++
  if (k >= data.length) return undefined
  const final = data.charCodeAt(k)
  // Not a final byte: a broken prefix. Drop it and read on from the interrupting character.
  if (final < 0x40 || final > 0x7e) return { end: k }
  const body = data.slice(i + 2, k)
  if (k - i > CSI_MAX) return { end: k + 1 }
  if (body === PASTE_START && data[k] === '~') return { end: k + 1, paste: true }
  return { end: k + 1, key: csiKey(body, data[k]!) }
}

function ss3(data: string, i: number): Step | undefined {
  let k = i + 2
  while (k < data.length && k - i < 6 && data.charCodeAt(k) >= 0x30 && data.charCodeAt(k) <= 0x39) k++
  if (k >= data.length) return undefined
  const final = data.charCodeAt(k)
  if (final < 0x40 || final > 0x7e) return { end: k }
  const name = SS3[data[k]!]
  const mods = k > i + 2 ? modifiers(Number.parseInt(data.slice(i + 2, k), 10)) : 0
  return { end: k + 1, key: name === undefined ? undefined : named(name, mods) }
}

/** OSC (BEL or ST) and DCS/PM/APC (ST): consumed whole, never a key. An ESC that is not ST cancels the string. */
function stringSequence(data: string, i: number, bell: boolean): Step | undefined {
  for (let k = i + 2; k < data.length; k++) {
    const ch = data[k]
    if ((bell && ch === '\x07') || ch === '\x9c') return { end: k + 1 }
    if (ch === ESC) {
      if (k + 1 >= data.length) return undefined
      return data[k + 1] === '\\' ? { end: k + 2 } : { end: k }
    }
  }
  return undefined
}

function escape(data: string, i: number): Step | undefined {
  if (i + 1 >= data.length) return undefined
  const next = data[i + 1]!
  if (next === '[') return csi(data, i)
  if (next === 'O') return ss3(data, i)
  if (next === ']') return stringSequence(data, i, true)
  // SOS (`ESC X`) is left out: nothing sends it, and it would swallow Alt+Shift+X.
  if (next === 'P' || next === '_' || next === '^') return stringSequence(data, i, false)
  // ESC ESC: the first is Escape; the second starts whatever follows.
  if (next === ESC) return { end: i + 1, key: named('escape', 0) }
  const code = data.codePointAt(i + 1)!
  if (code < 0x20 || code === 0x7f) return { end: i + 2, key: controlKey(code, ALT) }
  if (code >= 0x80 && code <= 0x9f) return { end: i + 2 }
  const ch = String.fromCodePoint(code)
  return { end: i + 1 + ch.length, key: charKey(ch, ALT) }
}

/** What an incomplete sequence may keep across chunks: an over-long one is cut to a form that still swallows its rest. */
function holdable(sequence: string): string {
  const intro = sequence[1]
  // `ESC [ ?` marks it private, so whatever final byte ends it, it decodes to nothing.
  if (intro === '[') return sequence.length > CSI_MAX ? '\x1b[?' : sequence
  if (intro === ']' || intro === 'P' || intro === '_' || intro === '^') {
    return sequence.length > STRING_MAX ? sequence.slice(0, 2) + (sequence.endsWith(ESC) ? ESC : '') : sequence
  }
  return sequence
}

function isPrintable(code: number): boolean {
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)
}

/** The longest tail of `data` (from `from`) that could be the start of the paste end marker. */
function markerTail(data: string, from: number): number {
  for (let n = Math.min(PASTE_END.length - 1, data.length - from); n > 0; n--) {
    if (data.endsWith(PASTE_END.slice(0, n))) return n
  }
  return 0
}

const newlines = (text: string): string => text.replace(/\r\n?/g, '\n')

/** A line break or tab still undecided: a key normally, paste text inside a burst. */
type Item = Key | { readonly kind: 'break'; readonly ch: string }

export class KeyDecoder {
  private readonly now: () => number
  private readonly graceMs: number
  private readonly decoder = new StringDecoder('utf8')
  /** An incomplete escape sequence, or inside a paste a tail that may be the start of its end marker. */
  private held = ''
  private paste: string | undefined
  private lastBurst: number | undefined

  constructor(options: KeyDecoderOptions = {}) {
    this.now = options.now ?? Date.now
    this.graceMs = options.pasteGraceMs ?? 120
  }

  /** A partial sequence or an open bracketed paste is held: call `flush()` after the escape timeout. */
  get pending(): boolean {
    return this.held !== '' || this.paste !== undefined
  }

  /** Inside a bracketed paste: a caller may wait longer than its escape timeout before flushing. */
  get pasting(): boolean {
    return this.paste !== undefined
  }

  feed(chunk: string | Uint8Array): Key[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const data = this.held + text
    this.held = ''
    return this.decode(data)
  }

  flush(): Key[] {
    const held = this.held
    this.held = ''
    if (this.paste !== undefined) {
      this.append(held)
      const key = this.closePaste()
      return key === undefined ? [] : [key]
    }
    return held === ESC ? [named('escape', 0)] : []
  }

  private decode(data: string): Key[] {
    const items: Item[] = []
    let printable = 0
    let breaks = false
    let i = 0
    while (i < data.length) {
      if (this.paste !== undefined) {
        const end = data.indexOf(PASTE_END, i)
        if (end < 0) {
          const keep = markerTail(data, i)
          this.append(data.slice(i, data.length - keep))
          this.held = data.slice(data.length - keep)
          break
        }
        this.append(data.slice(i, end))
        const key = this.closePaste()
        if (key !== undefined) items.push(key)
        i = end + PASTE_END.length
        continue
      }
      const code = data.charCodeAt(i)
      if (code === 0x1b) {
        const step = escape(data, i)
        if (step === undefined) {
          this.held = holdable(data.slice(i))
          break
        }
        if (step.paste === true) this.paste = ''
        else if (step.key !== undefined) items.push(step.key)
        i = step.end
      } else if (code === 0x0d || code === 0x0a || code === 0x09) {
        if (code !== 0x09) breaks = true
        items.push({ kind: 'break', ch: data[i]! })
        i++
      } else if (code < 0x20 || code === 0x7f) {
        items.push(controlKey(code, 0))
        i++
      } else if (!isPrintable(code)) {
        i++ // C1: a UTF-8 terminal never types one
      } else {
        let j = i + 1
        while (j < data.length && isPrintable(data.charCodeAt(j))) j++
        const run = data.slice(i, j)
        if (printable < 3) for (const _ of run) printable++
        items.push({ kind: 'text', text: run })
        i = j
      }
    }
    let burst = false
    if (breaks) {
      const now = this.now()
      burst = printable >= 3 || (this.lastBurst !== undefined && now - this.lastBurst <= this.graceMs)
      if (burst) this.lastBurst = now
    }
    return assemble(items, burst)
  }

  private append(text: string): void {
    const paste = this.paste ?? ''
    const room = PASTE_MAX - paste.length
    if (room <= 0 || text === '') return
    let part = text.length > room ? text.slice(0, room) : text
    const last = part.charCodeAt(part.length - 1)
    if (part.length < text.length && last >= 0xd800 && last <= 0xdbff) part = part.slice(0, -1)
    this.paste = paste + part
  }

  private closePaste(): Key | undefined {
    const text = this.paste ?? ''
    this.paste = undefined
    return text === '' ? undefined : { kind: 'text', text: newlines(text), paste: true }
  }
}

/** Coalesces adjacent plain text; inside a burst, text and line breaks become one paste text per run. */
function assemble(items: readonly Item[], burst: boolean): Key[] {
  const out: Key[] = []
  let text = ''
  const close = (): void => {
    if (text === '') return
    out.push(burst ? { kind: 'text', text: newlines(text), paste: true } : { kind: 'text', text })
    text = ''
  }
  for (const item of items) {
    if (item.kind === 'text' && item.paste === undefined) text += item.text
    else if (item.kind === 'break' && burst) text += item.ch
    else {
      close()
      out.push(item.kind === 'break' ? controlKey(item.ch.charCodeAt(0), 0) : item)
    }
  }
  close()
  return out
}
