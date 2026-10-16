/**
 * The OpenAI models this adapter knows: a DATED SNAPSHOT in source, never
 * fetched. `resolveModel` is synchronous and feeds admission and metering, and
 * OpenAI's `GET /models` carries no facts to fetch — no window, no effort set,
 * no modality — so a fetched catalog would be a list of names with every fact
 * still hand-written beside it.
 *
 * Verified 2026-10-16. The effort SETS and DEFAULTS are measured: each id's
 * supported-values 400 for a level it lacks, and a 16-token call for the level
 * it reports when none is named. `catalog.e2e.test.ts` re-measures those two
 * live, so a drift fails a probe instead of a session. The windows and output
 * caps are read from OpenAI's model pages and hand-verified; the probe does
 * NOT guard them. A 404 on a row's announced shutdown date means "retire the
 * row", not drift.
 */
import type { ModelInfo, ModelModality } from '../../core/llm/index.ts'

export interface OpenAICatalogModel extends ModelInfo {
  /**
   * The max INPUT tokens, not the advertised window. It is what
   * `compaction-basic` budgets against and what the meter reads, and OpenAI's
   * window counts the output cap inside it: a 1.05M model takes at most 922K
   * of prompt. `llm-anthropic`'s catalog makes the same choice with
   * `max_input_tokens`.
   */
  readonly contextWindow: number
  /** Input plus output, as the model page states the window. Informational. */
  readonly totalWindow: number
  /** Measured: the API silently accepts `max_output_tokens: 10_000_000`, so this cap is ours to enforce. */
  readonly maxOutputTokens: number
  readonly efforts: readonly string[]
  /** The level the API applies when the request names none. */
  readonly defaultEffort?: string
  /**
   * When `temperature` is honoured. `never`: the API answers "Unsupported
   * parameter: 'temperature' is not supported with this model." at every
   * level. `effort-none`: the same 400 at every level except `none`
   * (measured 2026-10-16).
   */
  readonly sampling: 'never' | 'effort-none'
  readonly modalities: readonly ModelModality[]
}

const TEXT_AND_IMAGE: readonly ModelModality[] = ['text', 'image']
const LOW_TO_MAX: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NONE_TO_MAX: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
const NONE_TO_XHIGH: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh']
const MINIMAL_TO_HIGH: readonly string[] = ['minimal', 'low', 'medium', 'high']
/** The 1.05M-window rows: 922K of input plus a 128K output cap. */
const WIDE = { contextWindow: 922_000, totalWindow: 1_050_000, maxOutputTokens: 128_000 } as const
/** The 400K-window rows: 272K of input plus the same cap. */
const NARROW = { contextWindow: 272_000, totalWindow: 400_000, maxOutputTokens: 128_000 } as const

/**
 * Exact rows, each id its own: the families split exactly where a prefix
 * would lie. Astra and 6.1-sol have no `none` and take no temperature at all,
 * while 6-sol and 6-luna have both; 5.4 is a 922K model and 5.4-mini and
 * 5.4-nano are 272K ones.
 */
export const OPENAI_CATALOG: readonly OpenAICatalogModel[] = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', ...WIDE, efforts: LOW_TO_MAX, defaultEffort: 'medium', sampling: 'never', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', ...WIDE, efforts: LOW_TO_MAX, defaultEffort: 'medium', sampling: 'never', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', ...WIDE, efforts: NONE_TO_MAX, defaultEffort: 'medium', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', ...WIDE, efforts: NONE_TO_MAX, defaultEffort: 'medium', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', ...WIDE, efforts: NONE_TO_MAX, defaultEffort: 'medium', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', ...WIDE, efforts: NONE_TO_MAX, defaultEffort: 'medium', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', ...WIDE, efforts: NONE_TO_MAX, defaultEffort: 'medium', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5.5', name: 'GPT-5.5', ...WIDE, efforts: NONE_TO_XHIGH, defaultEffort: 'medium', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  // From 5.4 down the default is `none`: a request that names no effort runs
  // without reasoning, so it sends no `reasoning` field and asks for no
  // encrypted item, and a temperature is honoured.
  { id: 'gpt-5.4', name: 'GPT-5.4', ...WIDE, efforts: NONE_TO_XHIGH, defaultEffort: 'none', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', ...NARROW, efforts: NONE_TO_XHIGH, defaultEffort: 'none', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano', ...NARROW, efforts: NONE_TO_XHIGH, defaultEffort: 'none', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5.2', name: 'GPT-5.2', ...NARROW, efforts: NONE_TO_XHIGH, defaultEffort: 'none', sampling: 'effort-none', modalities: TEXT_AND_IMAGE },
  // The GPT-5 generation predates `none`: its floor is `minimal`, so no level
  // ever turns sampling on.
  { id: 'gpt-5-mini', name: 'GPT-5 mini', ...NARROW, efforts: MINIMAL_TO_HIGH, defaultEffort: 'medium', sampling: 'never', modalities: TEXT_AND_IMAGE },
  { id: 'gpt-5-nano', name: 'GPT-5 nano', ...NARROW, efforts: MINIMAL_TO_HIGH, defaultEffort: 'medium', sampling: 'never', modalities: TEXT_AND_IMAGE },
]

/** Undated ids OpenAI serves as a row (measured: `gpt-5.6` answers as `gpt-5.6-sol`). Unlisted, so a picker shows the row once. */
const ALIASES: ReadonlyMap<string, string> = new Map([['gpt-5.6', 'gpt-5.6-sol']])

/** OpenAI's dated-snapshot suffix: `gpt-5.4-2026-03-05` is a pinned `gpt-5.4`. */
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/

/**
 * The row an id resolves to: an exact id, an alias, or a row's id plus a dated
 * snapshot suffix — never a loose prefix, because `gpt-5.4` must not claim
 * `gpt-5.4-mini` (a third of its window) and a prefix match cannot tell them
 * apart.
 */
export function catalogEntry(model: string): OpenAICatalogModel | undefined {
  const id = ALIASES.get(model) ?? model
  const exact = OPENAI_CATALOG.find((row) => row.id === id)
  if (exact !== undefined || !SNAPSHOT.test(model)) return exact
  // The alias is folded under a snapshot too: `gpt-5.6-<date>` is the sol row.
  const base = model.replace(SNAPSHOT, '')
  return OPENAI_CATALOG.find((row) => row.id === (ALIASES.get(base) ?? base))
}

/**
 * The replay FAMILY: the canonical id, with the alias and any dated snapshot
 * folded in. An id the catalog does not know is its own family. Only history
 * written for the same family is replayed with its reasoning and item ids
 * (`serialize.ts`): the one cross-model pair ever measured — gpt-6-luna's
 * reasoning sent to gpt-5-nano — was silently omitted, so grouping more widely
 * is unproven.
 */
export function canonicalModel(model: string): string {
  return catalogEntry(model)?.id ?? model
}

/**
 * Facts for an id this catalog lacks: conservative on every axis, and on
 * purpose. The rows above disagree about the effort vocabulary (astra has no
 * `none`, the GPT-5 generation has `minimal`), so any level named for an
 * unmeasured id is a guess, and a refusal names the fix; a reasoning field is
 * not sent at all, since an id this table has never seen may be a model that
 * takes none. Text only, because a provider that silently drops an image is a
 * measured fact of this seam (`deepseek-v4-pro`, §13): an image route has to be
 * known before images are admitted to it. A model this table lacks is one
 * row, measured by the drift probe.
 */
export function factsFor(model: string): OpenAICatalogModel {
  // No output cap of ours: an unknown id's would be a guess, and a guessed cap
  // would refuse what the provider serves; the deployment default applies.
  return catalogEntry(model) ?? { id: model, name: model, contextWindow: 128_000, totalWindow: 128_000, maxOutputTokens: Number.POSITIVE_INFINITY, efforts: [], sampling: 'never', modalities: ['text'] }
}
