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

export interface Approval {
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
}

export const APPROVAL = serviceKey<Approval>('approval')

/** Answerer chain; first non-delegating listener wins. Default thunk returns `unavailable`. */
export const APPROVAL_REQUEST = waterfallEvent<[request: ApprovalRequest], Promise<ApprovalOutcome>>('approval/request')

export const APPROVAL_ASKED = eventKind<{ id: string; toolName: string; callId?: string; reason?: string }>('approval/asked')
export const APPROVAL_DECIDED = eventKind<{ id: string; outcome: ApprovalOutcome }>('approval/decided')

class ApprovalService implements Approval {
  private counter = 0

  async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = request.agent.session
    const id = `approval-${session.id}-${++this.counter}`
    session.append(APPROVAL_ASKED, {
      id,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    let outcome: ApprovalOutcome
    try {
      // Dispatched in the requesting agent's scope: an answerer registered through
      // one agent's context never answers for another agent.
      outcome = await request.agent.ctx.waterfall(APPROVAL_REQUEST, request, async () => 'unavailable' as ApprovalOutcome)
      if (!VALID_OUTCOMES.has(outcome)) outcome = 'unavailable'
    } catch {
      outcome = 'unavailable'
    }
    if (request.signal?.aborted) outcome = 'cancelled'
    session.append(APPROVAL_DECIDED, { id, outcome })
    return outcome
  }
}

/** Provides `ctx.approval`. */
export const approvalPlugin: Plugin = {
  name: 'core-approval',
  apply(ctx) {
    ctx.provide(APPROVAL, new ApprovalService())
  },
}

export type { EventEnvelope }
