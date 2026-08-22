/**
 * The approval seam. The model proposes an action; an answerer decides. The
 * default is fail-closed (`unavailable`), a grant is one-shot, and every
 * decision is a turn-enclosed audit pair in the session log — never in the
 * model transcript.
 */
import { serviceKey, waterfallEvent, type Plugin } from '../../kernel/index.ts'
import type { Agent } from '../agent/types.ts'
import type { CallId } from '../ids.ts'
import { eventKind, type EventEnvelope } from '../session/types.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
const VALID_OUTCOMES: ReadonlySet<string> = new Set<ApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

export interface ApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: CallId
  readonly reason?: string
  readonly signal?: AbortSignal
}

/**
 * What answerers see: the request plus its durable id — the same id the
 * `approval/asked` audit event carries, so a surface can correlate a live
 * prompt with the log and echo the id back in its answer.
 */
export interface ApprovalPrompt extends ApprovalRequest {
  readonly id: string
}

export interface Approval {
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
}

export const APPROVAL = serviceKey<Approval>('approval')

/** Answerer chain; first non-delegating listener wins. Default thunk returns `unavailable`. */
export const APPROVAL_REQUEST = waterfallEvent<[prompt: ApprovalPrompt], Promise<ApprovalOutcome>>('approval/request')

export const APPROVAL_ASKED = eventKind<{ id: string; toolName: string; callId?: string; reason?: string }>('approval/asked')
export const APPROVAL_DECIDED = eventKind<{ id: string; outcome: ApprovalOutcome }>('approval/decided')

class ApprovalService implements Approval {
  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = request.agent.session
    // The id is the asked event's own seq: unique within the session for its whole
    // lifetime (across resume and fork), with no in-memory counter to reset.
    const id = `approval-${session.seq}`
    session.append(APPROVAL_ASKED, {
      id,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    // A request cancelled before it could be asked is decided without consulting
    // anyone: no answerer should ever see a prompt whose outcome is already fixed.
    if (request.signal?.aborted) {
      session.append(APPROVAL_DECIDED, { id, outcome: 'cancelled' })
      return 'cancelled'
    }
    const prompt: ApprovalPrompt = { ...request, id }
    let outcome: ApprovalOutcome
    try {
      // Dispatched in the requesting agent's scope: an answerer registered through
      // one agent's context never answers for another agent. The seam, not the
      // answerer, owns cancellation: an aborted signal settles the request even
      // if an answerer (a disconnected client) never does.
      const answer = Promise.resolve(request.agent.ctx.waterfall(APPROVAL_REQUEST, prompt, async () => 'unavailable' as ApprovalOutcome))
      outcome = await settleOrCancel(answer, request.signal)
      if (!VALID_OUTCOMES.has(outcome)) outcome = 'unavailable'
    } catch {
      outcome = 'unavailable'
    }
    if (request.signal?.aborted) outcome = 'cancelled'
    session.append(APPROVAL_DECIDED, { id, outcome })
    return outcome
  }
}

function settleOrCancel(answer: Promise<ApprovalOutcome>, signal: AbortSignal | undefined): Promise<ApprovalOutcome> {
  if (!signal) return answer
  if (signal.aborted) {
    answer.catch(() => undefined)
    return Promise.resolve('cancelled')
  }
  return new Promise((resolve) => {
    const onAbort = (): void => resolve('cancelled')
    signal.addEventListener('abort', onAbort, { once: true })
    answer.then(resolve, () => resolve('unavailable')).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Provides `ctx.approval`. */
export const approvalPlugin: Plugin = {
  name: 'core-approval',
  apply(ctx) {
    ctx.provide(APPROVAL, new ApprovalService())
  },
}

export type { EventEnvelope }
