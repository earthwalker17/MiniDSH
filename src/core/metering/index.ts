/**
 * Context metering: one definition of "how full is this session's request",
 * shared by the compaction trigger, the terminal, and the CLI, so no two of
 * them can disagree about pressure.
 *
 * A pure fold over facts the log already holds — `assistant/message.usage` and
 * the folded `request/header` — plus a fixed heuristic for what the provider
 * has not priced yet. Deliberately NOT a service: there is no lifecycle here
 * and nothing to replace until an adapter owns a real tokenizer, and a fold
 * that a protocol client must also run cannot live behind a ctx key anyway.
 *
 * Determinism is the point. The same log yields the same numbers in a live run
 * and in a keyless replay, which is what lets a compaction trigger reproduce.
 */
import type { ContentBlock, Message, TokenUsage } from '../llm/types.ts'
import { deriveEventMessage, foldRequestHeader, foldSurfaceSeqs } from '../session/surface.ts'
import { LLM_AUX_CALL, type AuxCallRecord } from '../llm/aux-call.ts'
import { ASSISTANT_MESSAGE, matches, REQUEST_HEADER, type EventEnvelope, type RequestHeader } from '../session/types.ts'

/** The estimator's whole model of a tokenizer. Wrong in the small, stable in the large. */
const CHARS_PER_TOKEN = 4
/** Role, delimiters, and the provider's own message framing. */
const MESSAGE_OVERHEAD = 4
/** A tool call carries an id and a JSON envelope the arguments string does not include. */
const TOOL_CALL_OVERHEAD = 8

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function estimateBlocks(blocks: readonly ContentBlock[]): number {
  let total = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        // Reasoning counts: a reasoning-carrying assistant message is echoed
        // back to the provider on every later request (see the adapter).
        total += estimateTokens(block.text)
        break
      case 'tool-call':
        total += estimateTokens(block.name) + estimateTokens(block.arguments) + TOOL_CALL_OVERHEAD
        break
      case 'tool-result':
        total += estimateBlocks(block.content) + MESSAGE_OVERHEAD
        break
    }
  }
  return total
}

export function estimateMessage(message: Message): number {
  return estimateBlocks(message.content) + MESSAGE_OVERHEAD
}

/** The non-conversation half of a request: the system prompt and the tool schemas. */
function estimateHeader(header: RequestHeader | undefined): number {
  if (!header) return 0
  return estimateTokens(header.system) + estimateTokens(JSON.stringify(header.tools))
}

export interface ContextMetrics {
  /** Prompt tokens the provider billed for the last successful request (uncached + cache reads). */
  readonly reportedPrompt: number
  readonly reportedOutput: number
  /**
   * Cumulative across the whole log, for a session-level cost line — INCLUDING
   * out-of-loop calls, because a compaction summary replays a whole shadowed
   * span and is usually the largest single request a session makes.
   */
  readonly sessionInput: number
  readonly sessionOutput: number
  readonly sessionCacheRead: number
  /** What the NEXT request is expected to cost, in prompt tokens. */
  readonly projectedTokens: number
  readonly budgetTokens: number
  /** `projectedTokens / budgetTokens`; 0 when no budget is known. */
  readonly ratio: number
  /** True when `projectedTokens` came from provider usage plus a delta rather than a whole-surface estimate. */
  readonly priced: boolean
}

/**
 * Meters a session from its events — `Session.facts` for a live session (the
 * fold never reads a chunk), the whole stored log off-line.
 *
 * The projection prefers what the provider actually charged: the last priced
 * request plus an estimate of every surface node appended since. That holds
 * only while the surface has grown by appends under the same header — a
 * `replace` (compaction) makes the priced prefix describe history that is no
 * longer sent, and a `request/header` after the priced call means the prompt
 * or tools changed under it — so the whole surface is re-estimated instead.
 * Estimating low right after a compaction is the safe direction: it cannot
 * make compaction re-trigger on its own output.
 */
export function meterSession(events: readonly EventEnvelope[], budgetTokens: number): ContextMetrics {
  let sessionInput = 0
  let sessionOutput = 0
  let sessionCacheRead = 0
  let lastUsage: TokenUsage | undefined
  let lastUsageSeq = -1
  let replacedSinceUsage = false
  let headerSinceUsage = false

  for (const event of events) {
    if (event.surfaceOp?.op === 'replace' && event.seq > lastUsageSeq) replacedSinceUsage = true
    // A header written after the priced call means the NEXT request's system
    // prompt, tools or route are not what was priced: the anchor is stale.
    if (event.type === REQUEST_HEADER.type && event.seq > lastUsageSeq) headerSinceUsage = true
    // An out-of-loop call costs real money and is billed to this session, but it
    // is NOT the loop's prompt: it counts towards the totals and never towards
    // the projection of what the next request will cost.
    if (event.type === LLM_AUX_CALL.type) {
      const auxUsage = (event.data as AuxCallRecord).usage
      if (auxUsage) {
        sessionInput += auxUsage.inputTokens
        sessionOutput += auxUsage.outputTokens
        sessionCacheRead += auxUsage.cacheReadTokens ?? 0
      }
      continue
    }
    if (!matches(event, ASSISTANT_MESSAGE)) continue
    const usage = event.data.usage
    if (!usage) continue
    sessionInput += usage.inputTokens
    sessionOutput += usage.outputTokens
    sessionCacheRead += usage.cacheReadTokens ?? 0
    lastUsage = usage
    lastUsageSeq = event.seq
    replacedSinceUsage = false
    headerSinceUsage = false
  }

  // `inputTokens` is cache-EXCLUSIVE by the vocabulary's own contract, so the
  // prompt the provider actually read is the sum of the two.
  const reportedPrompt = lastUsage ? lastUsage.inputTokens + (lastUsage.cacheReadTokens ?? 0) : 0
  const reportedOutput = lastUsage?.outputTokens ?? 0

  // Addressed by seq, never by array index: a seeded or repaired log can hold
  // events this fold must look up by name rather than by position. It takes a
  // WHOLE log from seq 0 — `foldSurfaceSeqs` would reject a replace whose start
  // node fell outside a partial slice, which is the correct refusal but not a
  // shape any caller should hand it.
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const surfaceSeqs = foldSurfaceSeqs(events)
  const priced = lastUsage !== undefined && !replacedSinceUsage && !headerSinceUsage
  let projectedTokens: number
  if (priced) {
    let delta = 0
    for (const seq of surfaceSeqs) {
      if (seq <= lastUsageSeq) continue
      const node = bySeq.get(seq)
      const message = node ? deriveEventMessage(node) : null
      if (message) delta += estimateMessage(message)
    }
    // The priced prompt already contains the assistant turn that produced it.
    projectedTokens = reportedPrompt + reportedOutput + delta
  } else {
    let total = estimateHeader(foldRequestHeader(events))
    for (const seq of surfaceSeqs) {
      const node = bySeq.get(seq)
      const message = node ? deriveEventMessage(node) : null
      if (message) total += estimateMessage(message)
    }
    projectedTokens = total
  }

  return {
    reportedPrompt,
    reportedOutput,
    sessionInput,
    sessionOutput,
    sessionCacheRead,
    projectedTokens,
    budgetTokens,
    ratio: budgetTokens > 0 ? projectedTokens / budgetTokens : 0,
    priced,
  }
}

/** `12.4k` / `10k` / `980` — a compact count for a status line. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  const thousands = count / 1000
  const text = thousands < 100 ? thousands.toFixed(1) : String(Math.round(thousands))
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}k`
}
