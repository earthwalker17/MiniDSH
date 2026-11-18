/**
 * The palette held to WCAG 2.2 contrast, in both themes, from the stylesheet
 * itself — so a token edited for taste cannot quietly make text unreadable.
 *
 * Text pairs need 4.5:1 (AA, normal text); the accent's arrow on the send
 * button and the focus ring are non-text marks and need 3:1. DSH's own
 * tertiary ink (#81858C, ~3.9:1 on white) is the reason this exists: MiniDSH
 * darkens it, and this keeps it dark.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(import.meta.dirname, 'style.css'), 'utf8')

/** The custom properties declared in the first block whose selector is exactly `selector`. */
function tokensOf(selector: string): Map<string, string> {
  const at = css.indexOf(`${selector} {`)
  if (at === -1) throw new Error(`no ${selector} block in style.css`)
  const body = css.slice(at, css.indexOf('\n}', at))
  return new Map([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1]!, match[2]!.toLowerCase()]))
}

const light = tokensOf(':root')
const dark = new Map([...light, ...tokensOf("[data-theme='dark']")])

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** [foreground, background, minimum, where it is used]. */
const PAIRS: readonly [string, string, number, string][] = [
  ['ink', 'bg', 4.5, 'body text'],
  ['ink-2', 'bg', 4.5, 'secondary text'],
  ['ink-3', 'bg', 4.5, 'process rows, meta'],
  ['ink-3', 'bg-sidebar', 4.5, 'sidebar times, list head'],
  ['ink', 'bg-sidebar', 4.5, 'session titles'],
  ['ink-3', 'bg-code', 4.5, 'card labels'],
  ['ink-2', 'bg-code', 4.5, 'card output'],
  ['ink', 'accent-soft', 4.5, "the person's bubble"],
  ['accent', 'bg', 4.5, 'links'],
  ['ink-on-primary', 'primary', 4.5, 'primary buttons'],
  ['ink-on-accent', 'accent', 3, 'the send arrow'],
  ['focus', 'bg', 3, 'the focus ring'],
  ['warn-ink', 'warn-soft', 4.5, 'approval strip, held notices'],
  ['warn-ink', 'bg', 4.5, '"Approval" in the list'],
  ['bad-ink', 'bad-soft', 4.5, 'turn errors'],
  ['bad-ink', 'bg', 4.5, 'failed rows'],
  ['ok-ink', 'ok-soft', 4.5, 'the connected pill'],
  ['accent', 'accent-soft', 4.5, 'the version pill'],
]

describe('the palette', () => {
  for (const [theme, tokens] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it.each(PAIRS)(`${theme}: %s on %s reaches %s:1 (%s)`, (foreground, background, minimum) => {
      const fg = tokens.get(foreground)
      const bg = tokens.get(background)
      expect(fg, `--${foreground}`).toBeDefined()
      expect(bg, `--${background}`).toBeDefined()
      expect(Math.round(contrast(fg!, bg!) * 100) / 100).toBeGreaterThanOrEqual(minimum)
    })
  }

  it("does not use DeepSeek's brand blue for MiniDSH's accent", () => {
    for (const tokens of [light, dark]) expect(['#4176e6', '#7aaaff', '#4d6bfe']).not.toContain(tokens.get('accent'))
  })
})
