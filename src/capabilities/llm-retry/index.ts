/**
 * Bounded request retry on `agent/request-error`. Failed attempts stay durable
 * (each attempt's chunks carry their own `attempt` number within the same
 * step); only the retryable code set is retried, with jittered exponential
 * backoff honoring a provider `retryAfterMs` — up to a ceiling, past which the failure
 * stands: a provider asking for an hour is not a transient blip, and sleeping
 * the turn for it, with nothing logged, looked like a hang.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { AGENT_REQUEST_ERROR, type Agent, type RequestErrorAction } from '../../core/agent/index.ts'
import { RETRYABLE_CODES, type LlmErrorCode } from '../../core/llm/index.ts'

export interface RetryConfig {
  readonly maxRetries?: number | undefined
  readonly initialDelayMs?: number | undefined
  readonly maxDelayMs?: number | undefined
  /** The longest provider `retry-after` honoured (default 60 s); one longer ends the retries. */
  readonly maxRetryAfterMs?: number | undefined
}

/**
 * Node's timer limit: a `setTimeout` past 2^31-1 ms fires after 1 ms, so a
 * delay that large is not a long wait but an immediate retry.
 */
const MAX_TIMER_MS = 2 ** 31 - 1

const configSchema = z
  .strictObject({
    maxRetries: z.number().int().nonnegative().optional(),
    initialDelayMs: z.number().nonnegative().max(MAX_TIMER_MS).optional(),
    maxDelayMs: z.number().nonnegative().max(MAX_TIMER_MS).optional(),
    maxRetryAfterMs: z.number().nonnegative().max(MAX_TIMER_MS).optional(),
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
    const maxRetryAfterMs = config?.maxRetryAfterMs ?? 60_000
    const attempts = new WeakMap<Agent, Attempt>()

    ctx.on(AGENT_REQUEST_ERROR, async (context, next) => {
      const prior = await next()
      if (prior) return prior
      if (!RETRYABLE_CODES.has(context.failure.code as LlmErrorCode)) return undefined
      const retryAfterMs = context.failure.retryAfterMs ?? 0
      // Past the ceiling the failure stands, naming its own wait in its message.
      if (retryAfterMs > maxRetryAfterMs) return undefined

      const key = `${context.turn}:${context.step}`
      const attempt = attempts.get(context.agent)
      const count = attempt && attempt.key === key ? attempt.count : 0
      if (count >= maxRetries) return undefined
      attempts.set(context.agent, { key, count: count + 1 })

      // Full jitter: parallel children on one provider meet a rate limit
      // together, and a deterministic backoff sent them back together, three
      // times, into the same limit (S21). A provider's own wait is the floor.
      const backoff = Math.random() * Math.min(maxDelayMs, initialDelayMs * 2 ** count)
      await sleep(Math.max(backoff, retryAfterMs), context.signal)
      if (context.signal.aborted) return undefined
      return { kind: 'retry' } satisfies RequestErrorAction
    })
  },
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    // Bounded again here, so no caller can hand the timer an overflow.
    const timer = setTimeout(finish, Math.min(ms, MAX_TIMER_MS))
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
