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
 * It replaces, never drops: the length of the result is the length of the
 * input, so nothing silently changes size on the way to a clamp.
 */
export function printableText(text: string): string {
  let flat = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    flat += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : ch
  }
  return flat
}
