import type { LlmRequest } from '../llm/types.ts'
import type { Session } from '../session/index.ts'

/**
 * Marks the exact frozen request the loop built for a step, keyed to its
 * session. The reconstruction invariant reads this so it recognizes
 * conversation work and can rebuild the request from the log; direct one-shots
 * (never marked) are excluded.
 */
const loopRequests = new WeakMap<LlmRequest, Session>()

export function markLoopRequest(request: LlmRequest, session: Session): void {
  loopRequests.set(request, session)
}

export function loopRequestSession(request: LlmRequest): Session | undefined {
  return loopRequests.get(request)
}
