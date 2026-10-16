/**
 * The catalog's drift probe: the source snapshot held to what DeepSeek says
 * about its own models today (ARCHITECTURE §5). The catalog is never fetched at
 * runtime — admission and metering read it synchronously, and every step's
 * facts are already recorded in `request/context` — so the only way it can go
 * stale silently is between sessions, and this is what notices.
 *
 * `GET /models` is free. Its rich fields are documented as optional and
 * unversioned (api-docs.deepseek.com/api/list-models), so a field the provider
 * stops sending is reported as unverifiable rather than as agreement.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { describe, expect, it } from 'vitest'
import { DeepSeekAdapter, deepseekCatalog } from './adapter.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

interface ListedModel {
  readonly id: string
  readonly context_window?: number
  readonly max_output_tokens?: number
  readonly input_modalities?: readonly string[]
  readonly effort?: { readonly supported_levels?: readonly string[]; readonly default_level?: string }
}

describe.skipIf(!KEY)('DeepSeek catalog drift', () => {
  it('lists exactly the catalogued models, each with the facts the snapshot carries', async () => {
    const response = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` } })
    expect(response.status).toBe(200)
    const listed = ((await response.json()) as { data: ListedModel[] }).data
    const catalog = deepseekCatalog()
    const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => KEY, baseURL: BASE, defaultMaxTokens: 8192 })
    // A model DeepSeek lists that the snapshot lacks gets the conservative
    // unlisted facts: text-only and a small window. That is safe, and it is
    // still drift worth a session's attention.
    expect(listed.map((model) => model.id).toSorted(), 'the listed ids moved').toEqual(catalog.map((row) => row.id).toSorted())
    for (const row of catalog) {
      const live = listed.find((model) => model.id === row.id)!
      const facts = {
        contextWindow: live.context_window,
        maxOutputTokens: live.max_output_tokens,
        modalities: live.input_modalities === undefined ? undefined : [...live.input_modalities].toSorted(),
        // `off` is thinking disabled, a separate switch the listing never names.
        efforts: live.effort?.supported_levels === undefined ? undefined : [...live.effort.supported_levels],
        defaultEffort: live.effort?.default_level,
      }
      process.stderr.write(`[deepseek catalog] ${row.id}: ${JSON.stringify(facts)}\n`)
      // The expectation is the ADAPTER's answer, not a copy of it: an edit to
      // the effort vocabulary or its default must meet the provider here.
      const reasoning = adapter.resolveModel(row.id).reasoning
      expect(facts, `${row.id} drifted from the snapshot`).toEqual({
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
        modalities: [...row.modalities].toSorted(),
        efforts: reasoning.efforts.filter((effort) => effort !== 'off'),
        defaultEffort: reasoning.defaultEffort,
      })
    }
  })

  // The retired names take deepseek-flash's facts, images included, because
  // DeepSeek serves them AS that model — "temporarily", with no end date. One
  // token each says whether that is still so; a re-route to a text-only model
  // would otherwise have its images ignored without a word.
  it('still serves each retired alias as the model whose facts it takes', { timeout: 60_000 }, async () => {
    const adapter = new DeepSeekAdapter({ apiKeyRef: 'DEEPSEEK_API_KEY', resolveKey: () => KEY, baseURL: BASE, defaultMaxTokens: 8192 })
    for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: alias, max_tokens: 1, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'ok' }] }),
      })
      const served = ((await response.json()) as { model?: string }).model
      process.stderr.write(`[deepseek catalog] ${alias}: ${response.status}, served as ${served}\n`)
      expect(response.status, `${alias} is no longer served: drop the alias`).toBe(200)
      expect(served, `${alias} is served as another model now: its facts must move`).toBe('deepseek-flash')
      expect(adapter.resolveModel(alias)).toEqual(adapter.resolveModel('deepseek-flash'))
    }
  })
})
