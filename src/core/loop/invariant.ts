import type { Plugin } from '../../kernel/index.ts'
import { INVARIANTS, type InvariantInstaller } from '../invariants/index.ts'
import { LLM_STREAM, type LlmRequest } from '../llm/index.ts'
import type { RequestHeader } from '../session/index.ts'
import { loopRequestSession } from './marker.ts'

/** Canonical string for header equality, including nullable optional fields. */
function canonHeader(header: RequestHeader): string {
  return JSON.stringify({
    provider: header.provider,
    model: header.model,
    system: header.system,
    tools: header.tools,
    reasoningEffort: header.reasoningEffort ?? null,
    maxTokens: header.maxTokens ?? null,
    temperature: header.temperature ?? null,
  })
}

/**
 * Every MODEL-VISIBLE field of the request outside `messages`; adding one to
 * `LlmRequest` means adding it here and to `RequestHeader`.
 *
 * The qualifier is load-bearing. `signal`, `sessionId` and `purpose` are on the
 * request and belong in neither: the provider never sees them, so a header that
 * carried them would claim the model saw something it did not — and the canon
 * comparison would fail on a difference the model cannot observe.
 */
function requestAsHeader(request: LlmRequest): string {
  return JSON.stringify({
    provider: request.provider,
    model: request.model,
    system: request.system ?? '',
    tools: (request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    reasoningEffort: request.reasoningEffort ?? null,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
  })
}

/**
 * Model-visible ⟺ logged. For every loop-built request, the messages must
 * equal `deriveMessages()` and the header must equal the folded `request/header`.
 *
 * An OBSERVER, not a listener: observers run in the dispatch preflight, before
 * any listener is selected, so no middleware — however it is ordered, and
 * `prepend` is an unshift that puts the LAST registrant first — can run ahead
 * of it and send a request the check never saw.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.observe((info) => {
    if (info.name !== LLM_STREAM.name) return
    const request = info.args[0] as LlmRequest | undefined
    // An observer sees raw dispatch args: if the dispatch shape ever changes
    // under this check, it must fail loud rather than pass every request.
    if (typeof request !== 'object' || request === null || !('messages' in request)) {
      fail('llm/stream dispatched without a request as its first argument')
      return
    }
    const session = loopRequestSession(request)
    if (!session) return
    if (!Object.isFrozen(request)) fail('loop-built request is not frozen')
    if (JSON.stringify(request.messages) !== JSON.stringify(session.deriveMessages())) {
      fail('request messages diverge from deriveMessages()')
    }
    const header = session.foldRequestHeader()
    if (!header) fail('loop-built request has no request/header in the log')
    else if (canonHeader(header) !== requestAsHeader(request)) fail('request header diverges from the folded request/header')
  })
}

/** Registers the request-reconstruction invariant. Mount only where invariants run. */
export const loopInvariantPlugin: Plugin = {
  name: 'core-agent-loop-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, 'core-agent-loop', install)
  },
}
