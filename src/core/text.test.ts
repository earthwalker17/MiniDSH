/**
 * The one rule about text this runtime did not author: nothing a person reads
 * on a line may contain a character that moves the cursor, reorders the line
 * or renders as nothing.
 */
import { describe, expect, it } from 'vitest'
import { isInvisible, printableLines, printableText } from './text.ts'

describe('printableText', () => {
  it('blanks controls and every character that renders as nothing, and keeps ordinary text', () => {
    // A bidi override, a TAG letter, a Mongolian variation selector, a Hangul
    // filler, a zero-width space and a line separator: each passed before S20.5
    // except the controls, and each hides or reorders text a person approves.
    const sneaky = 'a\u{1B}[2Kb\u{202E}c\u{E0041}d\u{180B}e\u{3164}f\u{200B}g\u{2028}h'
    expect(printableText(sneaky)).toBe('a [2Kb c d e f g h')
    expect(printableText('echo café 中文 ✓')).toBe('echo café 中文 ✓')
  })

  it('replaces one for one, so a clamp downstream measures what was written', () => {
    const text = 'x\u{E0041}\u{202E}y'
    expect(Array.from(printableText(text))).toHaveLength(Array.from(text).length)
  })

  it('names the invisible set once, for the consent escape and the surfaces alike', () => {
    for (const ch of ['\u{200B}', '\u{202E}', '\u{2066}', '\u{E0041}', '\u{FE0F}', '\u{180B}', '\u{3164}', '\u{FFA0}', '\u{034F}', '\u{115F}', '\u{17B4}', '\u{E000}', '\u{2028}']) {
      expect(isInvisible(ch), ch.codePointAt(0)!.toString(16)).toBe(true)
    }
    for (const ch of ['a', 'é', '中', '✓', ' ']) expect(isInvisible(ch), ch).toBe(false)
  })
})

describe('printableLines', () => {
  // The streamed answer is the model's own structure: a joiner inside an
  // emoji sequence is part of it, and only cursor movers are neutralized.
  it('keeps lines and tabs, blanks the C0/C1 controls, and leaves joiners to the text', () => {
    expect(printableLines('a\nb\tc\u{1B}d')).toBe('a\nb\tc d')
    expect(printableLines('\u{1F468}\u{200D}\u{1F469}')).toBe('\u{1F468}\u{200D}\u{1F469}')
  })
})
