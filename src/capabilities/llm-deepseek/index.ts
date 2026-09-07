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
    baseURL: z.string().url().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
  })
  .optional()

export const deepseekPlugin: Plugin<DeepSeekConfig | undefined> = {
  name: 'llm-deepseek',
  inject: [LLM, CREDENTIALS],
  config: configSchema,
  apply(ctx, config) {
    // Validated at apply, so a bad reference fails the row loudly at settle
    // instead of surfacing as a missing key on the first paid request.
    const ref = credentialRef(config?.apiKeyEnv ?? 'DEEPSEEK_API_KEY')
    const credentials = ctx.get(CREDENTIALS)
    const adapter = new DeepSeekAdapter({
      apiKeyRef: ref,
      resolveKey: () => credentials.resolve(ref),
      describeKey: () => credentials.describe(ref),
      // `tryGet`, not `inject`: an adapter must not REQUIRE an attachment store.
      // Without one it refuses image content instead of failing to mount.
      resolveAttachments: () => ctx.tryGet(ATTACHMENTS),
      baseURL: config?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
      defaultMaxTokens: config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    })
    ctx.get(LLM).registerAdapter(ctx, adapter)
  },
}

export { DEEPSEEK_PROVIDER, DeepSeekAdapter } from './adapter.ts'
export { DeepSeekTranslator, parseWireChunk } from './translate.ts'
export { serializeMessages, serializeTools } from './serialize.ts'
