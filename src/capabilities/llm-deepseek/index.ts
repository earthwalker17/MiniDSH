/**
 * The DeepSeek provider capability. Registers an adapter on `ctx.llm` for the
 * OpenAI-compatible chat API. The API key is a reference (an env-var name)
 * resolved per request — never stored in configuration.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { CREDENTIALS, credentialRef } from '../../core/credentials/index.ts'
import { ATTACHMENTS } from '../../core/attachments/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { baseURLFromEnv, isPlainHttpBase, PLAIN_HTTP_BASE_RULE } from '../../core/llm/wire.ts'
import { DeepSeekAdapter, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS } from './adapter.ts'

export interface DeepSeekConfig {
  /** Credential reference (env-var name) for the API key (default `DEEPSEEK_API_KEY`). */
  readonly apiKeyEnv?: string | undefined
  /** Endpoint base; falls back to `$DEEPSEEK_BASE_URL`, then the public API. */
  readonly baseURL?: string | undefined
  /** Per-request output cap when the request does not set one (default 8192). */
  readonly defaultMaxTokens?: number | undefined
}

const configSchema = z
  .strictObject({
    apiKeyEnv: z.string().min(1).optional(),
    // User info would reach every TRANSPORT error: Node's fetch refuses such a
    // URL with a message that quotes it, password included.
    baseURL: z.string().url().refine(isPlainHttpBase, PLAIN_HTTP_BASE_RULE).optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
  })
  .optional()

export const deepseekPlugin: Plugin<DeepSeekConfig | undefined> = {
  name: 'llm-deepseek',
  inject: [LLM, CREDENTIALS],
  config: configSchema,
  apply(ctx, config) {
    // Validated at apply, so a bad reference fails the row loudly at settle
    // instead of surfacing as a missing key on the first paid request. The
    // environment's base too, which the schema never sees.
    const ref = credentialRef(config?.apiKeyEnv ?? 'DEEPSEEK_API_KEY')
    const baseURL = config?.baseURL ?? baseURLFromEnv('DEEPSEEK_BASE_URL') ?? DEFAULT_BASE_URL
    // Declared, so anything that hands a child process an environment can
    // withhold it — this row's own config may have renamed it, and nothing
    // outside this row would otherwise know what it is called.
    ctx.get(CREDENTIALS).declare(ref)
    const credentials = ctx.get(CREDENTIALS)
    const adapter = new DeepSeekAdapter({
      apiKeyRef: ref,
      resolveKey: () => credentials.resolve(ref),
      describeKey: () => credentials.describe(ref),
      // `tryGet`, not `inject`: an adapter must not REQUIRE an attachment store.
      // Without one it refuses image content instead of failing to mount.
      resolveAttachments: () => ctx.tryGet(ATTACHMENTS),
      // Set-but-empty reads as unset (`baseURLFromEnv`).
      baseURL,
      defaultMaxTokens: config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    })
    ctx.get(LLM).registerAdapter(ctx, adapter)
  },
}

export { classifyHttp, DEEPSEEK_PROVIDER, DeepSeekAdapter, deepseekCatalog } from './adapter.ts'
export { DeepSeekTranslator, parseWireChunk } from './translate.ts'
export { serializeMessages, serializeTools } from './serialize.ts'
