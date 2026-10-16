/**
 * The OpenAI provider capability: the third adapter, on the Responses API —
 * typed output items instead of chat deltas, reasoning sealed into
 * `encrypted_content` instead of signed, a stateless (`store: false`) replay
 * that carries the history's own items back, and a per-model effort table.
 * Registers an adapter on `ctx.llm`; the API key is a reference (an env-var
 * name) resolved per request — never stored in configuration.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { CREDENTIALS, credentialRef } from '../../core/credentials/index.ts'
import { ATTACHMENTS } from '../../core/attachments/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { OpenAIAdapter, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS } from './adapter.ts'

export interface OpenAIConfig {
  /** Credential reference (env-var name) for the API key (default `OPENAI_API_KEY`). */
  readonly apiKeyEnv?: string | undefined
  /** Endpoint base, `/v1` included; falls back to `$OPENAI_BASE_URL`, then the public API. */
  readonly baseURL?: string | undefined
  /** Per-request output cap when the request does not set one (default 32768, capped by the model). */
  readonly defaultMaxTokens?: number | undefined
  /** Ask for reasoning summaries (default true); off for an organization the API refuses them to. */
  readonly reasoningSummaries?: boolean | undefined
}

const configSchema = z
  .strictObject({
    apiKeyEnv: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
    reasoningSummaries: z.boolean().optional(),
  })
  .optional()

export const openaiPlugin: Plugin<OpenAIConfig | undefined> = {
  name: 'llm-openai',
  inject: [LLM, CREDENTIALS],
  config: configSchema,
  apply(ctx, config) {
    // Validated at apply, so a bad reference fails the row loudly at settle.
    const ref = credentialRef(config?.apiKeyEnv ?? 'OPENAI_API_KEY')
    // Declared, so anything that hands a child process an environment can
    // withhold it — this row's own config may have renamed it, and nothing
    // outside this row would otherwise know what it is called.
    ctx.get(CREDENTIALS).declare(ref)
    const credentials = ctx.get(CREDENTIALS)
    const adapter = new OpenAIAdapter({
      apiKeyRef: ref,
      resolveKey: () => credentials.resolve(ref),
      describeKey: () => credentials.describe(ref),
      // See the sibling adapter: an attachment store is optional, never injected.
      resolveAttachments: () => ctx.tryGet(ATTACHMENTS),
      baseURL: config?.baseURL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
      defaultMaxTokens: config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      reasoningSummaries: config?.reasoningSummaries ?? true,
    })
    ctx.get(LLM).registerAdapter(ctx, adapter)
  },
}

export { OPENAI_PROVIDER, OpenAIAdapter, classifyHttp } from './adapter.ts'
export { OpenAITranslator, type OpenAIReplayBlock } from './translate.ts'
export { serializeInput, serializeTools, type InputItem } from './serialize.ts'
export { OPENAI_CATALOG, canonicalModel, catalogEntry, type OpenAICatalogModel } from './catalog.ts'
