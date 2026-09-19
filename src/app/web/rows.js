// @ts-check
/**
 * The browser's event projection, without the DOM: one row DESCRIPTOR per
 * durable event, which `app.js` turns into nodes.
 *
 * A different projection from `app/present.ts` on purpose: that one is the
 * single projection every PLAIN-TEXT surface shares, and this one feeds
 * structure a terminal cannot render. The two may differ in FORM, never in
 * whether an event is visible at all, and that rule used to be held by hand
 * in an untyped `switch` no test imported, so it drifted: `request/context`
 * had a line in every terminal and none here, and a role-routed step's route
 * was invisible in the browser. Split out so both halves of the rule are
 * checked: the payload types below are the CORE kinds' own (a renamed field is
 * a type error here, as it is in `present.ts`), and `rows.test.ts` holds this
 * file to the visibility of `transcriptLines` kind by kind.
 *
 * Plain JS, no build step, nothing imported at runtime: the type imports are
 * JSDoc and erase. Neither projection folds the surface.
 */

/**
 * @template K
 * @typedef {K extends { readonly __data?: infer D } ? NonNullable<D> : never} DataOf
 */
/** @typedef {import('../../core/session/types.ts').EventEnvelope} EventEnvelope */
/** @typedef {import('../../core/llm/types.ts').ContentBlock} ContentBlock */
/** @typedef {DataOf<typeof import('../../core/session/types.ts').USER_MESSAGE>} UserMessageData */
/** @typedef {DataOf<typeof import('../../core/session/types.ts').ASSISTANT_MESSAGE>} AssistantMessageData */
/** @typedef {DataOf<typeof import('../../core/session/types.ts').TOOL_CALL>} ToolCallData */
/** @typedef {DataOf<typeof import('../../core/session/types.ts').TOOL_RESULT>} ToolResultData */
/** @typedef {DataOf<typeof import('../../core/session/types.ts').TURN_END>} TurnEndData */
/** @typedef {DataOf<typeof import('../../core/session/types.ts').REQUEST_CONTEXT>} RequestContextData */
/** @typedef {DataOf<typeof import('../../core/approval/events.ts').APPROVAL_ASKED>} ApprovalAskedData */
/** @typedef {DataOf<typeof import('../../core/approval/events.ts').APPROVAL_DECIDED>} ApprovalDecidedData */
/** @typedef {DataOf<typeof import('../../core/approval/events.ts').APPROVAL_POLICY>} ApprovalPolicyData */
/** @typedef {DataOf<typeof import('../../core/sandbox/events.ts').SANDBOX_MODE>} SandboxModeData */
/** @typedef {DataOf<typeof import('../../core/presets/index.ts').AUTHORITY_PRESET>} AuthorityPresetData */
/** @typedef {DataOf<typeof import('../../core/agent/events.ts').AGENT_OPTIONS>} AgentOptionsData */
/** @typedef {DataOf<typeof import('../../core/agent/events.ts').SUBAGENT_START>} SubagentStartData */
/** @typedef {DataOf<typeof import('../../core/agent/events.ts').SUBAGENT_END>} SubagentEndData */
/** @typedef {DataOf<typeof import('../../core/compaction/index.ts').COMPACTION_START>} CompactionStartData */
/** @typedef {DataOf<typeof import('../../core/compaction/index.ts').COMPACTION_END>} CompactionEndData */
/** @typedef {DataOf<typeof import('../../core/compaction/index.ts').COMPACTION_APPLIED>} CompactionAppliedData */

/**
 * What `app.js` renders: `cls` is the row's class list; a row with `who` is a
 * speaker row (a label and a body), any other is one line of text.
 * @typedef {{ cls: string, who?: string, text: string }} Row
 */

/**
 * The text a message shows. An image block shows its stored descriptor — a
 * user-side image would otherwise have an empty body and be dropped entirely.
 * @param {{ readonly content?: readonly ContentBlock[] } | undefined} message
 */
export const messageText = (message) =>
  (message?.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : block.type === 'image' ? (block.text ?? '[image]') : ''))
    .join('')

/** @param {string} text @param {number} max */
export const preview = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * Every image descriptor a result carries, at any depth. Every image MiniDSH
 * produces arrives inside a `tool/result`, so without this the browser shows a
 * bare checkmark for the one event a vision session exists to produce.
 * @param {readonly ContentBlock[] | undefined} blocks
 * @returns {string[]}
 */
const imagesIn = (blocks) => {
  /** @type {string[]} */
  const out = []
  for (const block of blocks ?? []) {
    if (block.type === 'image') out.push(block.text ?? '[image]')
    else if (block.type === 'tool-result') out.push(...imagesIn(block.content))
  }
  return out
}

/** @param {number} count */
export const tokens = (count) => (count < 1000 ? String(count) : `${(count / 1000).toFixed(count < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`)

/** @param {string} text @returns {Row} */
const note = (text) => ({ cls: 'row note', text })

/**
 * One row per event, or nothing when the event has no shape a person reads.
 * @param {EventEnvelope} event
 * @returns {Row | undefined}
 */
export function describeRow(event) {
  switch (event.type) {
    case 'user/message': {
      const data = /** @type {UserMessageData} */ (event.data)
      const text = messageText(data.message)
      if (!text) return undefined
      const source = data.message.source
      if (source.kind !== 'user') return note(`context (${source.kind}${source.kind === 'plugin' && source.form ? `: ${source.form}` : ''})`)
      return { cls: 'row user', who: 'you', text }
    }
    case 'assistant/message': {
      const data = /** @type {AssistantMessageData} */ (event.data)
      const text = messageText(data.message)
      if (!text) return undefined
      const source = data.message.source
      return { cls: 'row assistant', who: source.kind === 'assistant' ? source.model : 'assistant', text }
    }
    case 'tool/call': {
      const data = /** @type {ToolCallData} */ (event.data)
      return { cls: 'row tool', text: `→ ${data.name} ${preview(data.arguments ?? '', 160)}` }
    }
    case 'tool/result': {
      const data = /** @type {ToolResultData} */ (event.data)
      if (data.error) return { cls: 'row denied', text: `✗ ${data.error.code}` }
      const images = imagesIn(data.message.content)
      return { cls: 'row ok', text: images.length === 0 ? '✓' : `✓ ${images.join(' ')}` }
    }
    case 'approval/asked': {
      const data = /** @type {ApprovalAskedData} */ (event.data)
      return note(`? ${data.toolName}${data.reason ? `: ${data.reason}` : ''}`)
    }
    case 'approval/decided':
      return note(`! ${/** @type {ApprovalDecidedData} */ (event.data).outcome}`)
    case 'sandbox/mode': {
      const data = /** @type {SandboxModeData} */ (event.data)
      return note(`[sandbox: ${data.mode} (${data.reason}; enforcement ${data.enforcement})]`)
    }
    case 'approval/policy':
      return note(`[approvals: ${/** @type {ApprovalPolicyData} */ (event.data).policy}]`)
    case 'authority/preset':
      return note(`[preset: ${/** @type {AuthorityPresetData} */ (event.data).name}]`)
    case 'agent/options': {
      const data = /** @type {AgentOptionsData} */ (event.data)
      // The opening base is what the header already shows; a switch is news.
      if (data.reason === 'initial') return undefined
      const { provider, model, reasoningEffort } = data.options
      return note(`[model: ${provider}/${model}${reasoningEffort ? ` · ${reasoningEffort}` : ''}]`)
    }
    case 'request/context': {
      // The EFFECTIVE route of a step. Written only when it changes, so a line
      // here is a role rewrite or a switch taking effect: the one place a
      // reader learns that a step ran somewhere other than the base route.
      const data = /** @type {RequestContextData} */ (event.data)
      return note(`[route: ${data.provider}/${data.model}${data.contextWindow === undefined ? '' : ` · window ${tokens(data.contextWindow)}`}]`)
    }
    case 'compaction/start': {
      const data = /** @type {CompactionStartData} */ (event.data)
      return note(`[compacting ${data.plannedNodes} messages · ${data.trigger}]`)
    }
    case 'compaction/end': {
      // The applied path already has its own record; a DECLINE had no line
      // anywhere, and an automatic one has no RPC result to carry it either.
      const data = /** @type {CompactionEndData} */ (event.data)
      return data.outcome.kind === 'applied' ? undefined : note(`[compaction declined: ${data.outcome.reason}]`)
    }
    case 'compaction/applied': {
      const data = /** @type {CompactionAppliedData} */ (event.data)
      return note(`[compacted ${data.shadowedSeqs.length} messages · ${data.trigger}]`)
    }
    case 'subagent/start': {
      const data = /** @type {SubagentStartData} */ (event.data)
      return note(`[subagent ${data.childId} · depth ${data.depth} · ${data.provider}/${data.model} · ${data.sandbox}, approvals never]`)
    }
    case 'subagent/end': {
      const data = /** @type {SubagentEndData} */ (event.data)
      return note(`[subagent ${data.childId} ${data.reason.kind}]`)
    }
    case 'turn/end': {
      // A failed turn says WHY here too. The code alone left a keyless first
      // run in the browser reading `[turn error: MISSING_CREDENTIAL]` with the
      // remedy — which the event carries — shown nowhere, while the terminal
      // printed it (present.ts). One runtime, one answer on every surface.
      const { reason } = /** @type {TurnEndData} */ (event.data)
      if (reason.kind === 'completed') return undefined
      return note(reason.kind === 'error' ? `[turn error: ${reason.code} — ${reason.message}]` : `[turn ${reason.kind}]`)
    }
    default:
      return undefined
  }
}
