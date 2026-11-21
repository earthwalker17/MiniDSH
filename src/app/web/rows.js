// @ts-check
/**
 * The browser's event projection, without the DOM: one row DESCRIPTOR per
 * durable event. `conversation.js` reads it to decide whether an event is
 * shown at all and keeps it on the block it places; `transcript.js` and the
 * full-screen terminal's `blocks.ts` then draw a block's own shape and read
 * only the descriptor's `text`.
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
/** @typedef {DataOf<typeof import('../../core/approval/events.ts').APPROVAL_GRANT>} ApprovalGrantData */
/** @typedef {DataOf<typeof import('../../core/sandbox/events.ts').SANDBOX_MODE>} SandboxModeData */
/** @typedef {DataOf<typeof import('../../core/sandbox/events.ts').SANDBOX_ACCEPTANCE>} SandboxAcceptanceData */
/** @typedef {DataOf<typeof import('../../core/presets/index.ts').AUTHORITY_PRESET>} AuthorityPresetData */
/** @typedef {DataOf<typeof import('../../core/agent/events.ts').AGENT_OPTIONS>} AgentOptionsData */
/** @typedef {DataOf<typeof import('../../core/agent/events.ts').AGENT_NARROWING>} AgentNarrowingData */
/** @typedef {DataOf<typeof import('../../core/agent/events.ts').SUBAGENT_START>} SubagentStartData */
/** @typedef {DataOf<typeof import('../../core/agent/events.ts').SUBAGENT_END>} SubagentEndData */
/** @typedef {DataOf<typeof import('../../core/effects/index.ts').EFFECT_RECORDED>} EffectRecordedData */
/** @typedef {import('../../core/effects/index.ts').EffectIntent} EffectIntent */
/** @typedef {DataOf<typeof import('../../core/compaction/index.ts').COMPACTION_START>} CompactionStartData */
/** @typedef {DataOf<typeof import('../../core/compaction/index.ts').COMPACTION_END>} CompactionEndData */
/** @typedef {DataOf<typeof import('../../core/compaction/index.ts').COMPACTION_APPLIED>} CompactionAppliedData */
/** @typedef {DataOf<typeof import('../../core/jobs/events.ts').JOB_START>} JobStartData */
/** @typedef {DataOf<typeof import('../../core/jobs/events.ts').JOB_END>} JobEndData */

/**
 * The shape `narrowingFault` (core/agent/events.ts) accepts, as far as this
 * renderer reads it. Plain boolean, deliberately: a type predicate here would
 * narrow the typed payload into `any`.
 * @param {unknown} data
 * @returns {boolean}
 */
function readableNarrowing(data) {
  const names = (/** @type {unknown} */ list) => list === undefined || (Array.isArray(list) && list.every((item) => typeof item === 'string'))
  if (typeof data !== 'object' || data === null) return false
  const { tools, sections } = /** @type {{ tools?: unknown, sections?: unknown }} */ (data)
  const restrictions = tools === undefined || (Array.isArray(tools) && tools.every((r) => typeof r === 'object' && r !== null && names(r.allow) && names(r.deny) && names(r.allowTags) && names(r.denyTags)))
  const parts = sections === undefined || (Array.isArray(sections) && sections.every((section) => typeof section?.name === 'string'))
  return restrictions && parts
}

/**
 * One event as a line of text. The two renderers (`transcript.js`,
 * `terminal/blocks.ts`) read `text` alone; `cls` and `who` say what kind of
 * row it is (a speaker row carries `who`) and are read by the parity gate
 * (`rows.test.ts`), not drawn.
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
 * A consent subject as one clause — `describeIntent`'s words, spelled here
 * because nothing is imported at runtime. Both families, and only the two:
 * the authority invariant refuses any other before it reaches a log. The
 * joined form of `subjectParts` below, which the approval card (`approval.js`)
 * and the terminal's band build from: so the card, a call's own approvals
 * (`cards.js`), the panel's grants and the transcript all say the same.
 * Not a `switch`: the parity gate reads every `case` here as an event kind.
 * @param {EffectIntent} subject
 */
export function subjectText(subject) {
  return subjectParts(subject)
    .map((part) => ('code' in part ? `\`${part.code}\`` : part.text))
    .join('')
}

/**
 * The same clause as parts: the model-chosen value (a command, a payload) is
 * ONE code part, everything the runtime says about it text. A surface that
 * styles code builds from these, never by splitting the joined string on
 * backticks — a backtick inside the command would otherwise flip which words
 * look like the runtime's account (S22 review).
 * @param {EffectIntent} subject
 * @returns {({ text: string } | { code: string })[]}
 */
export function subjectParts(subject) {
  // The same two notes `describeIntent` carries: without them an escaped real
  // newline reads as a typed `\n`, and a cut subject reads as whole.
  const notes = [
    ...(subject.escaped === true ? ['control or invisible characters shown escaped'] : []),
    ...(subject.truncated === true ? ['cut at 4000 characters'] : []),
  ]
  const said = notes.length === 0 ? '' : ` […${notes.join('; ')}]`
  if (subject.effect === 'network-request') return [{ text: 'send ' }, { code: subject.payload }, { text: ` to ${subject.destination} as ${subject.credential}${said}` }]
  return [{ text: 'run ' }, { code: subject.command }, { text: `${said} under ${subject.mode}/${subject.enforcement}` }]
}

/** @param {number | undefined} ms */
const after = (ms) => (ms === undefined ? '' : ` after ${(ms / 1000).toFixed(1)}s`)

/**
 * How a job ended, in the words `jobStatus` (`capabilities/tool-jobs`) uses —
 * spelled here because nothing is imported at runtime, and held to the same
 * visibility, not the same bytes, by the parity gate. Not a `switch`: the
 * gate reads every `case` in this file as an event kind.
 * @param {JobEndData} end
 */
export function jobEnded(end) {
  if (end.cause === 'exited') {
    const how = end.exitCode !== undefined ? `exited with code ${end.exitCode}` : end.signal !== undefined ? `terminated by signal ${end.signal}` : 'exited'
    return `${how}${after(end.durationMs)}`
  }
  if (end.cause === 'failed') return `failed${end.detail === undefined ? '' : `: ${end.detail}`}`
  if (end.cause === 'cancelled') {
    const by = end.by === 'model' ? '' : end.by === 'user' ? ' by the user' : end.by === 'authority' ? ' (the sandbox policy changed)' : ' (its session ended)'
    return `stopped${by}${after(end.durationMs)}`
  }
  return 'lost: no longer supervised by this session (its process may still be running)'
}

/**
 * One row per event, or nothing when the event has no shape a person reads.
 * @param {EventEnvelope} event
 * @returns {Row | undefined}
 */
export function describeRow(event) {
  switch (event.type) {
    case 'user/message': {
      const data = /** @type {UserMessageData} */ (event.data)
      const source = data.message.source
      // Context the runtime entered is visible whatever its body holds, as in
      // `describeEvent`: only a PERSON's empty message has nothing to show.
      if (source.kind !== 'user') return note(`context (${source.kind}${source.kind === 'plugin' && source.form ? `: ${source.form}` : ''})`)
      const text = messageText(data.message)
      return text ? { cls: 'row user', who: 'you', text } : undefined
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
      // The subject is spelled here rather than imported: this file ships to a
      // browser with no build step and shares nothing with the host but the
      // wire. The two projections must agree on WHETHER an event is visible
      // (`rows.test.ts`), never on its wording.
      const says = data.subject ? ` ${subjectText(data.subject)}` : ''
      return note(`? ${data.toolName}${says}${data.reason ? `: ${data.reason}` : ''}`)
    }
    case 'approval/decided': {
      const data = /** @type {ApprovalDecidedData} */ (event.data)
      const named = data.grantId ? ` ${data.grantId}` : ''
      return note(`! ${data.outcome}${data.decidedBy ? ` (by ${data.decidedBy}${named})` : ''}`)
    }
    case 'sandbox/mode': {
      const data = /** @type {SandboxModeData} */ (event.data)
      return note(`[sandbox: ${data.mode} (${data.reason}; enforcement ${data.enforcement})]`)
    }
    case 'sandbox/acceptance': {
      const data = /** @type {SandboxAcceptanceData} */ (event.data)
      return note(`[shell enforcement: accepts ${data.accepts} under ${data.forMode} (${data.reason})]`)
    }
    case 'approval/grant': {
      const data = /** @type {ApprovalGrantData} */ (event.data)
      if (data.op === 'revoke') return note(`[grant revoked: ${data.id}]`)
      return note(`[grant ${data.id}: ${data.toolName} ${subjectText(data.subject)}]`)
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
    case 'effect/recorded': {
      // What a call actually did. The FORM differs from `present.ts` — a
      // browser row has room for neither the full hash nor the absolute path —
      // but the visibility never may, and the parity gate holds it to that.
      const data = /** @type {EffectRecordedData} */ (event.data)
      if (data.effect === 'fs-write') {
        const name = data.path.split(/[\\/]/).pop() ?? data.path
        return note(`[effect: wrote ${name} · ${data.bytes} B · sha256 ${data.sha256.slice(0, 12)}]`)
      }
      const outcome = data.timedOut === true ? 'timed out' : data.exitCode === undefined ? 'no exit code' : `exit ${data.exitCode}`
      return note(`[effect: shell command · ${outcome} · ${data.mode}/${data.enforcement}]`)
    }
    case 'agent/narrowing': {
      // `describeNarrowing` (core/agent/events.ts) in the browser's words: this
      // module shares only the wire with the host, never its code.
      const data = /** @type {AgentNarrowingData} */ (event.data)
      // A stored payload is untrusted: a record no fold would believe is named
      // as such, never described as a narrowing (present.ts says the same).
      if (!readableNarrowing(event.data)) return note('[narrowed: a record this reader cannot read]')
      const parts = []
      for (const restriction of data.tools ?? []) {
        const only = [...(restriction.allow ?? []), ...(restriction.allowTags ?? []).map((tag) => `${tag} tools`)]
        if (only.length > 0) parts.push(`only ${only.join(', ')}`)
        const no = [...(restriction.deny ?? []), ...(restriction.denyTags ?? []).map((tag) => `${tag} tools`)]
        if (no.length > 0) parts.push(`no ${no.join(', ')}`)
      }
      for (const section of data.sections ?? []) parts.push(`its own ${section.name}`)
      return note(`[narrowed: ${parts.length === 0 ? 'nothing' : parts.join(' · ')}]`)
    }
    case 'subagent/start': {
      const data = /** @type {SubagentStartData} */ (event.data)
      return note(`[subagent ${data.childId} · depth ${data.depth} · ${data.provider}/${data.model} · ${data.sandbox}, approvals never]`)
    }
    case 'subagent/end': {
      const data = /** @type {SubagentEndData} */ (event.data)
      return note(`[subagent ${data.childId} ${data.reason.kind}]`)
    }
    case 'job/start': {
      // The authority it runs under belongs on the row, as it does on a shell
      // effect's: a job is an effect that outlives the call that started it.
      const data = /** @type {JobStartData} */ (event.data)
      return note(`job ${data.jobId} started: ${preview(data.label, 160)} [${data.mode}/${data.enforcement}${data.pid === undefined ? '' : `, pid ${data.pid}`}]`)
    }
    case 'job/end': {
      const data = /** @type {JobEndData} */ (event.data)
      return note(`job ${data.jobId} ${jobEnded(data)}`)
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

/**
 * A consent's outcome in words, for every surface that shows a decision (the
 * browser's card and transcript, the terminal's decided line), so a person
 * reads the same verdict wherever they look.
 * @param {string | undefined} outcome
 * @param {string | undefined} by
 * @returns {string}
 */
export function decisionWords(outcome, by) {
  if (outcome === undefined) return 'No decision recorded'
  const what = outcome === 'allowed-once' ? 'Allowed once' : outcome === 'rejected' ? 'Rejected' : outcome === 'cancelled' ? 'Cancelled' : outcome === 'unavailable' ? 'Nobody could answer' : outcome
  const who = by === 'user' ? ' by you' : by ? ` by ${by}` : ''
  return `${what}${who}`
}

/**
 * What a context message is, in a person's words: the plugin that wrote it
 * names a kind of context, never shown as plugin jargon.
 * @param {string} plugin
 * @param {string | undefined} form
 * @param {boolean} replace a compaction's replacing summary
 * @returns {string}
 */
export function contextTitle(plugin, form, replace) {
  if (replace) return 'Context summary · what the model keeps of the history above'
  const known = /** @type {Record<string, string>} */ ({
    'workspace-instructions': 'Workspace instructions',
    skills: 'Skills available',
    'context-runtime': 'Runtime context',
    'compaction-basic': 'Context summary',
    'tool-jobs': 'Background job update',
    jobs: 'Background job update',
  })
  return known[plugin] ?? `Context from ${plugin}${form ? ` (${form})` : ''}`
}

/**
 * An authority switch or a decision as a sentence, its model-chosen value
 * (a command, a payload) as a code part: what both the browser and the
 * terminal draw for a `system` block. Undefined for a kind with no sentence
 * of its own (the row's text is the fallback). An if-chain, not a `switch`:
 * the parity gate reads every `case` in this file as an event kind.
 * @param {string} type
 * @param {Record<string, any>} data
 * @param {Record<string, any> | undefined} asked the question a decision answers, when the window holds it
 * @returns {({ text: string } | { code: string })[] | undefined}
 */
export function systemParts(type, data, asked) {
  if (type === 'sandbox/mode') return [{ text: `Sandbox set to ${data.mode} · enforcement ${data.enforcement}` }]
  if (type === 'approval/policy') return [{ text: `Approvals set to ${data.policy}` }]
  if (type === 'sandbox/acceptance') return [{ text: `Shell enforcement accepted: ${data.accepts} under ${data.forMode}` }]
  if (type === 'authority/preset') return [{ text: `Preset ${data.name}` }]
  if (type === 'agent/options') {
    const route = data.options ?? {}
    return [{ text: `Model set to ${route.provider}/${route.model}${route.reasoningEffort ? ` · effort ${route.reasoningEffort}` : ''}` }]
  }
  if (type === 'approval/grant') return data.op === 'revoke' ? [{ text: 'A session grant was revoked; the next such action asks again' }] : [{ text: `Standing grant for ${data.toolName}: ` }, ...subjectParts(data.subject)]
  if (type === 'approval/decided') {
    const subject = asked?.subject ? subjectParts(asked.subject) : [{ text: asked?.toolName ? `use ${asked.toolName}` : String(data.id) }]
    const words = data.grantId && data.outcome === 'allowed-once' ? `Allowed for this session${data.decidedBy === 'user' ? ' by you' : ''}` : decisionWords(String(data.outcome), data.decidedBy === undefined ? undefined : String(data.decidedBy))
    return [{ text: `${words}: ` }, ...subject]
  }
  return undefined
}
