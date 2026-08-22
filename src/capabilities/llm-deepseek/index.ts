/**
 * The DeepSeek provider capability. Registers an adapter on `ctx.llm` for the
 * OpenAI-compatible chat API. The API key is a reference (an env-var name)
 * resolved per request — never stored in configuration.
 */
import type { Plugin } from '../../kernel/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { DeepSeekAdapter, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS } from './adapter.ts'

export interface DeepSeekConfig {
  /** Environment variable holding the API key (default `DEEPSEEK_API_KEY`). */
  readonly apiKeyEnv?: string
  /** Endpoint base; falls back to `$DEEPSEEK_BASE_URL`, then the public API. */
  readonly baseURL?: string
  /** Per-request output cap when the request does not set one (default 8192). */
  readonly defaultMaxTokens?: number
}

export const deepseekPlugin: Plugin<DeepSeekConfig | undefined> = {
  name: 'llm-deepseek',
  inject: [LLM],
  apply(ctx, config) {
    const adapter = new DeepSeekAdapter({
      apiKeyEnv: config?.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
      baseURL: config?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
      defaultMaxTokens: config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    })
    ctx.get(LLM).registerAdapter(ctx, adapter)
  },
}

export { DEEPSEEK_PROVIDER, DeepSeekAdapter } from './adapter.ts'
export { DeepSeekTranslator, parseWireChunk } from './translate.ts'
export { serializeMessages, serializeTools } from './serialize.ts'
