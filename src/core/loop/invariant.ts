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
  })
}

function requestAsHeader(request: LlmRequest): string {
  return JSON.stringify({
    provider: request.provider,
    model: request.model,
    system: request.system ?? '',
    tools: (request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    reasoningEffort: request.reasoningEffort ?? null,
    maxTokens: request.maxTokens ?? null,
  })
}

/**
 * Model-visible ⟺ logged. For every loop-built request, the messages must
 * equal `deriveMessages()` and the header must equal the folded `request/header`.
 * Registered with `prepend` so a short-circuiting middleware cannot silence it.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on(
    LLM_STREAM,
    (request, next) => {
      const session = loopRequestSession(request)
      if (session) {
        if (!Object.isFrozen(request)) fail('loop-built request is not frozen')
        if (JSON.stringify(request.messages) !== JSON.stringify(session.deriveMessages())) {
          fail('request messages diverge from deriveMessages()')
        }
        const header = session.foldRequestHeader()
        if (!header) fail('loop-built request has no request/header in the log')
        else if (canonHeader(header) !== requestAsHeader(request)) fail('request header diverges from the folded request/header')
      }
      return next()
    },
    { prepend: true, global: true },
  )
}

/** Registers the request-reconstruction invariant. Mount only where invariants run. */
export const loopInvariantPlugin: Plugin = {
  name: 'core-agent-loop-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, 'core-agent-loop', install)
  },
}
