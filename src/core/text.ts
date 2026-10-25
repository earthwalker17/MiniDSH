/**
 * One rule about text this runtime did not author.
 *
 * A terminal executes what it is written: an ESC in a model-supplied path or
 * justification erases the line and repaints a different one, above the
 * `[y/N]` a person is about to answer. `\s` covers none of the C0/C1 controls,
 * so they are neutralized wherever such text crosses into a line a human or a
 * model reads. Three consumers share this: the approval seam clamping a
 * requester's `reason` (§7), the effect vocabulary rendering a recorded path
 * (§4), and the plain-text surface projection (§8). It lived in two of them
 * as identical private copies before the third arrived.
 *
 * The same holds for a character that renders as NOTHING (`isInvisible`): a
 * bidi override reorders the line a person reads, and a TAG or a variation
 * selector carries text nobody sees. The S18 review hid a secret that way
 * behind a visible query, and S20.5 found the same set unneutralized in an
 * approval's reason, a joined call and a search snippet.
 *
 * It replaces, never drops: the result has as many code points as the input,
 * so nothing silently changes size on the way to a clamp.
 */
export function printableText(text: string): string {
  let flat = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    flat += code < 0x20 || (code >= 0x7f && code <= 0x9f) || isInvisible(ch) ? ' ' : ch
  }
  return flat
}

/**
 * Characters that render as nothing a person can read, in a terminal or a
 * browser: every default-ignorable code point (zero-width and joiner
 * characters, bidi controls, the TAG block, variation selectors, the Hangul
 * fillers, Mongolian free variation selectors), every other format character,
 * private-use and unassigned code points, and the line and paragraph
 * separators. Not one general category: S18's set was `Cf` plus two ranges,
 * and the S20.5 audit hid bits behind a visible query with `Mn` and `Lo`
 * code points that `Default_Ignorable_Code_Point` names and `Cf` does not.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u

/** True for one code point `printableText` blanks and a consent subject escapes. */
export function isInvisible(ch: string): boolean {
  return INVISIBLE.test(ch)
}

/**
 * The same rule for text that keeps its LINES: `\n` and `\t` survive, every
 * other control character becomes a space. For a streamed answer, whose
 * paragraphs and code blocks are the model's own structure; `printableText`
 * would fold them onto one line (the S16.5 review caught exactly that after
 * the streamed delta was first neutralized). Still length-preserving.
 */
export function printableLines(text: string): string {
  let flat = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    flat += code === 0x0a || code === 0x09 || !(code < 0x20 || (code >= 0x7f && code <= 0x9f)) ? ch : ' '
  }
  return flat
}
