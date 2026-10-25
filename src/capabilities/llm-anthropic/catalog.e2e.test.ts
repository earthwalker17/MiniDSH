/**
 * The catalog's drift probe: the source snapshot held to what Anthropic says
 * about its own models today (ARCHITECTURE §5), as the DeepSeek and OpenAI
 * probes hold theirs. `GET /v1/models` is free and, per model, states the
 * window (`max_input_tokens`), the output cap (`max_tokens`), the effort
 * levels, the accepted `thinking.type`s and image input — every fact a row
 * carries but one. Whether a model thinks with no `thinking` field is not in
 * the listing; it was measured with paid calls (`adapter.ts`), and this probe
 * cannot see it drift.
 *
 * Two directions of drift fail: a catalogued row the listing no longer has
 * (retire it), and a listed id no row answers to (it would get the unlisted
 * fallback: a 200K window and no cap of ours — safe, and still drift).
 *
 * Requires ANTHROPIC_API_KEY; skipped otherwise. live.yml carries that secret,
 * so it runs on every live dispatch. Costs nothing: the listing is free.
 */
import { describe, expect, it } from 'vitest'
import { AnthropicAdapter, anthropicCatalog, catalogRowFor, type ThinkingType } from './adapter.ts'

const KEY = process.env.ANTHROPIC_API_KEY
const BASE = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/u, '')

type Supported = { readonly supported?: boolean } | undefined

interface ListedModel {
  readonly id: string
  readonly max_input_tokens?: number
  readonly max_tokens?: number
  readonly capabilities?: {
    readonly image_input?: Supported
    readonly thinking?: { readonly types?: Readonly<Record<string, Supported>> }
    readonly effort?: Readonly<Record<string, unknown>>
  }
}

/** Every page of the listing: it paginates (`has_more`, `last_id`), and a model past the first page is still a model. */
async function listing(): Promise<ListedModel[]> {
  const models: ListedModel[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const response = await fetch(`${BASE}/v1/models?limit=1000${after === undefined ? '' : `&after_id=${encodeURIComponent(after)}`}`, {
      headers: { 'x-api-key': KEY!, 'anthropic-version': '2023-06-01' },
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { data: ListedModel[]; has_more?: boolean; last_id?: string }
    models.push(...body.data)
    if (body.has_more !== true || body.last_id === undefined) return models
    after = body.last_id
  }
  throw new Error('the model listing did not end within 20 pages')
}

/** The leaf names under a capability whose `supported` is true, sorted; `supported` itself is the node's own flag, not a leaf. */
function supportedLeaves(node: Readonly<Record<string, unknown>> | undefined): string[] | undefined {
  if (node === undefined) return undefined
  return Object.entries(node)
    .filter(([name, leaf]) => name !== 'supported' && typeof leaf === 'object' && leaf !== null && (leaf as { supported?: unknown }).supported === true)
    .map(([name]) => name)
    .toSorted()
}

describe.skipIf(!KEY)('Anthropic catalog drift', () => {
  it('lists every catalogued row with the facts the snapshot carries, and every listed id resolves to a row', { timeout: 60_000 }, async () => {
    const listed = await listing()
    const adapter = new AnthropicAdapter({ apiKeyRef: 'ANTHROPIC_API_KEY', resolveKey: () => KEY, baseURL: BASE, defaultMaxTokens: 8192 })
    const drift: string[] = []
    for (const row of anthropicCatalog()) {
      const live = listed.find((model) => model.id === row.id)
      if (live === undefined) {
        drift.push(`${row.id}: no longer listed — retire the row`)
        continue
      }
      const facts = {
        contextWindow: live.max_input_tokens,
        maxOutputTokens: live.max_tokens,
        effortLevels: supportedLeaves(live.capabilities?.effort),
        thinkingTypes: supportedLeaves(live.capabilities?.thinking?.types),
        image: live.capabilities?.image_input?.supported,
      }
      process.stderr.write(`[anthropic catalog] ${row.id}: ${JSON.stringify(facts)}\n`)
      const expected = {
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
        effortLevels: [...row.effortLevels].toSorted(),
        thinkingTypes: [...row.thinkingTypes].toSorted(),
        image: row.modalities.includes('image'),
      }
      if (JSON.stringify(facts) !== JSON.stringify(expected)) drift.push(`${row.id}: listed ${JSON.stringify(facts)} vs catalogued ${JSON.stringify(expected)}`)
      // The vocabulary the ADAPTER offers, derived from the row: `off`
      // exactly where the listing accepts `disabled`. An edit that offers it
      // by hand must meet the provider here.
      const offersOff = adapter.resolveModel(row.id).reasoning.efforts.includes('off')
      const disables = (facts.thinkingTypes ?? []).includes('disabled' satisfies ThinkingType)
      if (offersOff !== disables) drift.push(`${row.id}: the adapter ${offersOff ? 'offers' : 'withholds'} "off" but the listing says disabled is ${disables ? '' : 'not '}accepted`)
    }
    for (const model of listed) {
      if (catalogRowFor(model.id) === undefined) drift.push(`${model.id}: listed, but no row answers to it — it gets the unlisted fallback`)
    }
    expect(drift, drift.join('\n')).toEqual([])
  })
})
