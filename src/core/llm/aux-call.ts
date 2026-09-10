/**
 * A model call that is not a loop step.
 *
 * A summary, a verification, a title: work the runtime does with the model
 * without it being a turn. `docs/ARCHITECTURE.md` §11 reserves the shape — the
 * caller logs its own durable record with route and usage, because a bare
 * `llm.stream` is neither durable nor retried and would leave the session log
 * unable to explain a fact the model later acts on.
 *
 * Exactly ONE record per call, and deliberately no `assistant/chunk`s: the
 * replay oracle groups chunks by (turn, step), so chunks written under a loop's
 * numbering would silently corrupt the derived script. The record instead
 * carries the finished text, which is all a replay needs to reproduce the call.
 *
 * The request's MESSAGES are not recorded. They are already in the log — the
 * caller's own record names the seqs it fed in — and copying them would
 * duplicate the whole history on every compaction.
 */
import { BlockAssembler } from './assembler.ts'
import type { Llm } from './runtime.ts'
import { eventKind, matches, type EventEnvelope } from '../session/types.ts'
import type { Session } from '../session/session.ts'
import { LlmError, type LlmFailure, type LlmRequest, type TokenUsage } from './types.ts'

export interface AuxCallRecord {
  /** Why the call was made; the same string the request carried. */
  readonly purpose: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  /**
   * The seqs of the surface nodes this call was fed, so the log explains its
   * own input. An ordinary data field on purpose: `sourceEventSeqs` is an
   * envelope field the session reserves for SURFACE events, and a log-only
   * record carrying one is rejected at append (`surface.ts`).
   */
  readonly inputSeqs?: readonly number[]
  readonly usage?: TokenUsage
  readonly outcome: { readonly kind: 'text'; readonly text: string } | { readonly kind: 'error'; readonly failure: LlmFailure }
}

/** Log-only: durable and replayable, never part of model history. */
export const LLM_AUX_CALL = eventKind<AuxCallRecord>('llm/aux-call')

export interface AuxCallResult {
  readonly seq: number
  readonly text: string
  readonly usage?: TokenUsage
}

export class AuxCallError extends Error {
  readonly failure: LlmFailure
  /** The seq of the record that already explains this failure. */
  readonly seq: number
  constructor(failure: LlmFailure, seq: number) {
    super(failure.message)
    this.name = 'AuxCallError'
    this.failure = failure
    this.seq = seq
  }
}

/** Concatenated text of the assembled blocks; reasoning is not part of the answer. */
function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/**
 * Performs one out-of-loop model call and records it. A failure is recorded
 * before it is thrown, so the log explains an abandoned compaction as readily
 * as a completed one.
 */
export async function runAuxCall(
  llm: Llm,
  session: Session,
  request: LlmRequest & { readonly purpose: string },
  inputSeqs?: readonly number[],
): Promise<AuxCallResult> {
  const assembler = new BlockAssembler()
  const base = {
    purpose: request.purpose,
    provider: request.provider,
    model: request.model,
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(inputSeqs === undefined ? {} : { inputSeqs: [...inputSeqs] }),
  }
  let failure: LlmFailure | undefined
  try {
    for await (const chunk of llm.stream(request)) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') failure = finish.failure
  } catch (error) {
    // An `LlmError` keeps its own code. Flattening everything to
    // `AUX_CALL_FAILED` erased the one distinction a caller acts on: a
    // cancellation and a summariser failure are different facts, and a
    // compaction that counts the first as the second can disable its own
    // automatic triggers with no summary having failed.
    const code = error instanceof LlmError ? error.code : 'AUX_CALL_FAILED'
    failure = { message: error instanceof Error ? error.message : String(error), code }
  }

  if (failure) {
    const event = session.append(LLM_AUX_CALL, { ...base, outcome: { kind: 'error', failure } })
    throw new AuxCallError(failure, event.seq)
  }
  const usage = assembler.usage
  const text = textOf(assembler.blocks())
  const event = session.append(LLM_AUX_CALL, { ...base, ...(usage === undefined ? {} : { usage }), outcome: { kind: 'text', text } })
  return { seq: event.seq, text, ...(usage === undefined ? {} : { usage }) }
}

/** Every recorded auxiliary call, in log order — the replay script's source. */
export function foldAuxCalls(events: readonly EventEnvelope[]): readonly AuxCallRecord[] {
  const out: AuxCallRecord[] = []
  for (const event of events) {
    if (matches(event, LLM_AUX_CALL)) out.push(event.data)
  }
  return out
}
