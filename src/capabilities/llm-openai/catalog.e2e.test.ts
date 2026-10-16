/**
 * The catalog's drift probe (ARCHITECTURE §5): the two facts per row this
 * snapshot MEASURED — the effort set and the default effort — measured again,
 * live. OpenAI's `GET /models` names models and nothing about them, so the
 * probe asks each model directly: a level it lacks answers 400 "Supported
 * values are: …" (free), and a 16-token call with no level named reports the
 * level it applied. Windows and output caps are not probed: the API accepts an
 * absurd cap silently, so they stay hand-verified (`catalog.ts`).
 *
 * A model past its announced shutdown date answering 404 means "retire the
 * row", not drift: the probe says so in its failure.
 *
 * Requires OPENAI_API_KEY; skipped otherwise. A LOCAL gate: live.yml carries no
 * OpenAI secret (ARCHITECTURE §10). Costs well under one US cent.
 */
import { describe, expect, it } from 'vitest'
import { OPENAI_CATALOG } from './catalog.ts'

const KEY = process.env.OPENAI_API_KEY
const BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/u, '')
/** The levels a probe may try, in the order that finds an unsupported one fastest across today's rows. */
const PROBES = ['none', 'minimal', 'max', 'xhigh'] as const

async function respond(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const response = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'x', store: false, max_output_tokens: 16, ...body }),
  })
  return { status: response.status, text: await response.text() }
}

/** The supported set the API names, `undefined` when every probed level was accepted, or `'gone'` for a 404. */
async function supported(model: string): Promise<string[] | undefined | 'gone'> {
  for (const effort of PROBES) {
    const { status, text } = await respond({ model, reasoning: { effort } })
    if (status === 200) continue
    // Checked before the list is read: a retired model answers 404, and the
    // probe must say "retire the row" and go on to the others, not stop.
    if (status === 404) return 'gone'
    const listed = /Supported values are: ([^.]+)\./u.exec(text)
    if (!listed) throw new Error(`${model}: ${status} without a supported-values list: ${text.slice(0, 200)}`)
    return [...listed[1]!.matchAll(/'([a-z]+)'/gu)].map((match) => match[1]!)
  }
  return undefined
}

describe.skipIf(!KEY)('OpenAI catalog drift', () => {
  it('each catalogued model still takes exactly its catalogued effort set, and applies its catalogued default', { timeout: 300_000 }, async () => {
    const drift: string[] = []
    for (const row of OPENAI_CATALOG) {
      const efforts = await supported(row.id)
      const plain = efforts === 'gone' ? { status: 404, text: '' } : await respond({ model: row.id })
      if (efforts === 'gone' || plain.status === 404) {
        drift.push(`${row.id}: 404 — past its shutdown date? retire the row`)
        continue
      }
      const applied = plain.status === 200 ? (JSON.parse(plain.text) as { reasoning?: { effort?: string } }).reasoning?.effort : `HTTP ${plain.status}`
      process.stderr.write(`[openai catalog] ${row.id}: efforts ${JSON.stringify(efforts)} default ${applied}\n`)
      // `undefined` means every probed level was accepted: then the set must contain all of them.
      const live = efforts ?? [...PROBES]
      const sameSet = live.length === row.efforts.length && live.every((effort) => row.efforts.includes(effort))
      if (!sameSet && !(efforts === undefined && PROBES.every((effort) => row.efforts.includes(effort)))) drift.push(`${row.id}: efforts ${JSON.stringify(live)} vs catalogued ${JSON.stringify(row.efforts)}`)
      if (applied !== row.defaultEffort) drift.push(`${row.id}: default ${applied} vs catalogued ${row.defaultEffort}`)
    }
    expect(drift, drift.join('\n')).toEqual([])
  })
})
