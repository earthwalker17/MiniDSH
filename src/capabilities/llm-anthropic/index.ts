/**
 * The Anthropic provider capability: the second adapter, and the proof of
 * the LLM seam — a genuinely different wire (named SSE events, content-block
 * turns, signed thinking, cache writes, real per-model windows) behind the
 * same `stream`/`resolveModel` contract. Registers an adapter on `ctx.llm`;
 * the API key is a reference (an env-var name) resolved per request — never
 * stored in configuration.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { CREDENTIALS, credentialRef } from '../../core/credentials/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { AnthropicAdapter, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS } from './adapter.ts'

export interface AnthropicConfig {
  /** Credential reference (env-var name) for the API key (default `ANTHROPIC_API_KEY`). */
  readonly apiKeyEnv?: string | undefined
  /** Endpoint base; falls back to `$ANTHROPIC_BASE_URL`, then the public API. */
  readonly baseURL?: string | undefined
  /** Per-request output cap when the request does not set one (default 8192, capped by the model). */
  readonly defaultMaxTokens?: number | undefined
}

const configSchema = z
  .strictObject({
    apiKeyEnv: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
  })
  .optional()

export const anthropicPlugin: Plugin<AnthropicConfig | undefined> = {
  name: 'llm-anthropic',
  inject: [LLM, CREDENTIALS],
  config: configSchema,
  apply(ctx, config) {
    const ref = credentialRef(config?.apiKeyEnv ?? 'ANTHROPIC_API_KEY')
    const credentials = ctx.get(CREDENTIALS)
    const adapter = new AnthropicAdapter({
      apiKeyRef: ref,
      resolveKey: () => credentials.resolve(ref),
      baseURL: config?.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL,
      defaultMaxTokens: config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    })
    ctx.get(LLM).registerAdapter(ctx, adapter)
  },
}

export { ANTHROPIC_PROVIDER, AnthropicAdapter, classifyHttp } from './adapter.ts'
export { AnthropicTranslator } from './translate.ts'
export { serializeMessages, serializeTools } from './serialize.ts'
