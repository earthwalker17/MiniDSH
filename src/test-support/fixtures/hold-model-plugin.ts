/**
 * A from-disk plugin fixture, beside `hold-plugin.ts` and loaded the same way:
 * a scripted model under provider `scripted` that answers a prompt by calling
 * the `hold` tool, and a held call's result with text. Inserted together with
 * `hold-plugin.ts` and a settings.json routing to `scripted/scripted-model`, it
 * keeps a SPAWNED host's turn running — inside a dispatched call, with its
 * lease held — for as long as a test needs, with no key and no model: only
 * the model is scripted, and the loop, the tool, the log and the lease are the
 * real runtime's.
 */
import type { Plugin } from '../../kernel/index.ts'
import { LLM } from '../../core/llm/index.ts'
import type { LlmRequest } from '../../core/llm/types.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../scripted-adapter.ts'

/** More answers than any test asks for: the adapter consumes one per request. */
const ANSWERS = 64

const holdModelPlugin: Plugin = {
  name: 'llm-scripted-hold',
  inject: [LLM],
  apply(ctx) {
    let calls = 0
    const answer = (request: LlmRequest) => {
      const answered = request.messages.at(-1)?.content.some((block) => block.type === 'tool-result') === true
      return answered ? assistantText('released') : assistantToolCall(`hold-${++calls}`, 'hold', {})
    }
    ctx.get(LLM).registerAdapter(ctx, new ScriptedAdapter().script(...Array.from({ length: ANSWERS }, () => answer)))
  },
}

export default holdModelPlugin
