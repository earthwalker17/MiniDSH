/**
 * Text the desktop shows but did not write — the runtime's stderr tail in the
 * stopped view — made safe to display: terminal escapes and control
 * characters removed (the shell overlay renders text only, but an escape is
 * still noise and a bidi override still reorders what a person reads), the
 * launch token and the session cookie redacted, and only the end kept, which
 * is where a crash says why.
 *
 * Owns: that one transformation. Must not own: where the text came from or
 * how it is drawn. The runtime's surfaces have their own neutralizers
 * (`app/present.ts`, `app/terminal/width.ts`); this package does not import
 * them (ARCHITECTURE §1: the desktop reaches the runtime only over the wire).
 */

/**
 * CSI, OSC (BEL or ST), the other string sequences (DCS, SOS, PM, APC), the
 * two-byte and nF escapes, and their 8-bit C1 forms. Bounded, so a hostile
 * unterminated sequence costs linear time and leaves its introducer to the
 * control-character pass below.
 */
// oxlint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\[[\x30-\x3f]{0,64}[\x20-\x2f]{0,8}[\x40-\x7e]|\][^\x07\x1b\x9c]{0,4096}(?:\x07|\x1b\\|\x9c)|[PX^_][^\x1b\x9c]{0,4096}(?:\x1b\\|\x9c)|[\x20-\x2f]{0,8}[\x30-\x7e])|\x9b[\x30-\x3f]{0,64}[\x20-\x2f]{0,8}[\x40-\x7e]|[\x90\x98\x9d\x9e\x9f][^\x07\x1b\x9c]{0,4096}(?:\x07|\x1b\\|\x9c)/g

/** C0 except tab and newline, DEL, C1. */
// oxlint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/** Bidi embeddings, overrides, isolates and marks: they reorder what is read without being seen. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g

const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/token=[A-Za-z0-9_-]+/g, 'token=[redacted]'],
  [/minidsh_session=[^\s;,]+/g, 'minidsh_session=[redacted]'],
  [/"token"\s*:\s*"[^"]*"/g, '"token":"[redacted]"'],
]

/**
 * The last `maxChars` characters (code points, so no pair is split) of `text`,
 * cleaned and redacted. Redaction runs BEFORE the cut, so a cut can never
 * leave the tail of a secret whose prefix it removed.
 */
export function displayTail(text: string, maxChars: number): string {
  let clean = text.replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(CONTROLS, '').replace(BIDI, '')
  for (const [pattern, replacement] of REDACTIONS) clean = clean.replace(pattern, replacement)
  const chars = Array.from(clean)
  return chars.length <= maxChars ? clean : chars.slice(chars.length - Math.max(0, maxChars)).join('')
}
