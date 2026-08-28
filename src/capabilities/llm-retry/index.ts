/**
 * Bounded request retry on `agent/request-error`. Failed attempts stay durable
 * (each opens a fresh step); only the retryable code set is retried, with
 * exponential backoff honoring a provider `retryAfterMs`.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { AGENT_REQUEST_ERROR, type Agent, type RequestErrorAction } from '../../core/agent/index.ts'
import { RETRYABLE_CODES, type LlmErrorCode } from '../../core/llm/index.ts'

export interface RetryConfig {
  readonly maxRetries?: number | undefined
  readonly initialDelayMs?: number | undefined
  readonly maxDelayMs?: number | undefined
}

const configSchema = z
  .strictObject({
    maxRetries: z.number().int().nonnegative().optional(),
    initialDelayMs: z.number().nonnegative().optional(),
    maxDelayMs: z.number().nonnegative().optional(),
  })
  .optional()

interface Attempt {
  key: string
  count: number
}

export const retryPlugin: Plugin<RetryConfig | undefined> = {
  name: 'llm-retry',
  config: configSchema,
  apply(ctx, config) {
    const maxRetries = config?.maxRetries ?? 3
    const initialDelayMs = config?.initialDelayMs ?? 500
    const maxDelayMs = config?.maxDelayMs ?? 10_000
    const attempts = new WeakMap<Agent, Attempt>()

    ctx.on(AGENT_REQUEST_ERROR, async (context, next) => {
      const prior = await next()
      if (prior) return prior
      if (!RETRYABLE_CODES.has(context.failure.code as LlmErrorCode)) return undefined

      const key = `${context.turn}:${context.step}`
      const attempt = attempts.get(context.agent)
      const count = attempt && attempt.key === key ? attempt.count : 0
      if (count >= maxRetries) return undefined
      attempts.set(context.agent, { key, count: count + 1 })

      const backoff = Math.min(maxDelayMs, initialDelayMs * 2 ** count)
      const delayMs = Math.max(backoff, context.failure.retryAfterMs ?? 0)
      await sleep(delayMs, context.signal)
      if (context.signal.aborted) return undefined
      return { kind: 'retry' } satisfies RequestErrorAction
    })
  },
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
