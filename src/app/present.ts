/**
 * The one projection from durable events to human lines, shared by every
 * plain-text surface: the headless progress stream, `sessions show`, the
 * audit view and the terminal. Every payload is read through `matches()`, so a
 * renamed field is a type error here rather than a `NaN` on someone's screen —
 * which is exactly how the terminal came to print `~NaNk → ~NaNk` for a
 * compaction after the S5 review renamed two fields.
 *
 * Pure functions over events, no state: a surface that streams (the terminal)
 * layers its own live cases on top and falls back here for everything else.
 */
import { AGENT_OPTIONS, SUBAGENT_END, SUBAGENT_START } from '../core/agent/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_POLICY } from '../core/approval/index.ts'
import { COMPACTION_APPLIED, COMPACTION_END, COMPACTION_START } from '../core/compaction/index.ts'
import { blockText } from '../core/llm/content.ts'
import { messageText, restoreMessage } from '../core/llm/message.ts'
import type { ContentBlock } from '../core/llm/index.ts'
import { formatTokens } from '../core/metering/index.ts'
import { AUTHORITY_PRESET } from '../core/presets/index.ts'
import { SANDBOX_MODE } from '../core/sandbox/index.ts'
import { ASSISTANT_MESSAGE, matches, REQUEST_CONTEXT, TOOL_CALL, TOOL_RESULT, TURN_END, USER_MESSAGE, type EventEnvelope } from '../core/session/index.ts'

/** Every image descriptor a result carries, at any depth. */
function imagesIn(blocks: readonly ContentBlock[]): string[] {
  const out: string[] = []
  for (const block of blocks) {
    if (block.type === 'image') out.push(blockText(block))
    else if (block.type === 'tool-result') out.push(...imagesIn(block.content))
  }
  return out
}

export function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** One spelling of what a stamp's enforcement means, for every line that shows one. */
function confinement(mode: string, enforcement: string): string {
  return mode === 'danger-full-access' ? 'unconfined' : `shell confinement ${enforcement}`
}

/** One line for one event, or nothing when the event has no human-facing shape. No indentation, no newline. */
export function describeEvent(event: EventEnvelope): string | undefined {
  if (matches(event, USER_MESSAGE)) {
    const message = restoreMessage(event.data.message)
    return message.source.kind === 'user' ? undefined : `· context (${message.source.kind})`
  }
  if (matches(event, TOOL_CALL)) return `→ ${event.data.name} ${preview(event.data.arguments)}`
  if (matches(event, TOOL_RESULT)) {
    if (event.data.error) return `✗ ${event.data.error.code}`
    // A tool result renders as a checkmark and nothing else — deliberately, a
    // one-line live projection. An IMAGE is the exception, because it is the
    // only tool output that is content rather than text, and every image
    // MiniDSH produces arrives exactly here. Without this the one event a
    // vision session exists to produce is invisible on every plain-text
    // surface. It stays in `describeEvent` rather than only in the transcript
    // so live rendering and history cannot disagree, which is the defect S7.5
    // spent a session closing.
    const images = imagesIn(restoreMessage(event.data.message).content)
    return images.length === 0 ? '✓' : `✓ ${images.join(' ')}`
  }
  if (matches(event, ASSISTANT_MESSAGE)) {
    const text = messageText(restoreMessage(event.data.message))
    return text.length > 0 ? preview(text, 120) : undefined
  }
  if (matches(event, TURN_END)) return `[turn ${event.data.reason.kind}]`
  if (matches(event, SANDBOX_MODE)) {
    const { mode, enforcement, reason } = event.data
    // Authority is visible where it changes: a surface that hides a widened
    // boundary is a surface that lets one happen quietly.
    return `[sandbox: ${mode} (${reason}; ${confinement(mode, enforcement)})]`
  }
  if (matches(event, APPROVAL_POLICY)) return `[approvals: ${event.data.policy}]`
  if (matches(event, AGENT_OPTIONS)) {
    // The opening base is what the banner already said; a switch is news.
    if (event.data.reason === 'initial') return undefined
    const { provider, model, reasoningEffort } = event.data.options
    return `[model: ${provider}/${model}${reasoningEffort ? ` · effort ${reasoningEffort}` : ''} (${event.data.reason})]`
  }
  if (matches(event, REQUEST_CONTEXT)) {
    const { provider, model, contextWindow } = event.data
    return `[route: ${provider}/${model}${contextWindow === undefined ? '' : ` · window ${formatTokens(contextWindow)}`}]`
  }
  if (matches(event, AUTHORITY_PRESET)) return `[preset: ${event.data.name}]`
  if (matches(event, APPROVAL_ASKED)) return `? ${event.data.id} ${event.data.toolName}${event.data.reason ? `: ${event.data.reason}` : ''}`
  if (matches(event, APPROVAL_DECIDED)) return `! ${event.data.id} ${event.data.outcome}`
  if (matches(event, SUBAGENT_START)) {
    const { childId, depth, provider, model, sandbox } = event.data
    return `[subagent ${childId} · depth ${depth} · ${provider}/${model} · ${sandbox}, approvals never]`
  }
  if (matches(event, SUBAGENT_END)) {
    const { childId, reason, usage } = event.data
    const cost = usage === undefined ? '' : ` · ${formatTokens(usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))} in · ${formatTokens(usage.outputTokens)} out`
    return `[subagent ${childId} ${reason.kind}${cost}]`
  }
  if (matches(event, COMPACTION_START)) {
    const { trigger, budgetTokens, plannedNodes } = event.data
    return `[compacting ${plannedNodes} messages · ${trigger} · budget ${formatTokens(budgetTokens)}]`
  }
  if (matches(event, COMPACTION_END)) {
    // Only the decline needs a line of its own: the applied path already has
    // `compaction/applied`, which says what it cost. A decline had nothing at
    // all until now — the reason reached only whichever client happened to be
    // holding the `/compact` RPC, and an AUTOMATIC decline has no RPC at all.
    return event.data.outcome.kind === 'applied' ? undefined : `[compaction declined: ${event.data.outcome.reason}]`
  }
  if (matches(event, COMPACTION_APPLIED)) {
    const { shadowedSeqs, trigger, surfaceTokensBefore, surfaceTokensAfter } = event.data
    return `[compacted ${shadowedSeqs.length} messages · ${trigger} · ~${formatTokens(surfaceTokensBefore)} → ~${formatTokens(surfaceTokensAfter)}]`
  }
  return undefined
}

/**
 * A stored log folded into a conversation transcript — what a client renders
 * for the PAGE it attached to, and what `/history` prints walking backwards.
 *
 * It is `describeEvent` with two widenings and one exclusion, not a second
 * projection: conversation gets more room here than in a live one-liner (a
 * transcript is read, not watched), and a completed `turn/end` needs no line —
 * the same exclusion the terminal's live renderer makes. Everything else falls
 * through, because it did when it happened: this used to render three kinds and
 * hide nine, so paging back over an authority switch, a denial, a delegation or
 * a compaction showed none of them, while watching the same session live showed
 * them all. Which of two things you saw depended on when you looked.
 */
export function transcriptLines(events: readonly EventEnvelope[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    const line = transcriptLine(event)
    if (line !== undefined) lines.push(line)
  }
  return lines
}

function transcriptLine(event: EventEnvelope): string | undefined {
  if (matches(event, USER_MESSAGE)) {
    const message = restoreMessage(event.data.message)
    const text = messageText(message)
    if (message.source.kind === 'user') return text.length > 0 ? `you> ${preview(text, 200)}` : undefined
  } else if (matches(event, ASSISTANT_MESSAGE)) {
    const text = messageText(restoreMessage(event.data.message))
    if (text.length > 0) return preview(text, 400)
  } else if (matches(event, TURN_END) && event.data.reason.kind === 'completed') {
    return undefined
  }
  return describeEvent(event)
}

/** Result codes that are a decision of the authority plane, not a tool failure. */
const DENIALS: ReadonlySet<string> = new Set([
  'DENIED',
  'BLOCKED',
  'ABORTED',
  'ABORTED_BEFORE_DISPATCH',
  'FS_SANDBOX_DENIED',
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_ESCALATION_DENIED',
  'SANDBOX_NOT_WIDER',
])

/**
 * The audit projection: what this session was permitted to do, when, and every
 * time someone was asked. An escalation names only its tool, so the command it
 * covered is joined in from the `tool/call` its `callId` points at — the same
 * join a reader would otherwise do by hand.
 */
export function auditLines(events: readonly EventEnvelope[]): string[] {
  const calls = new Map<string, string>()
  const at = (seq: number): string => String(seq).padStart(4)
  const lines: string[] = []
  for (const event of events) {
    if (matches(event, TOOL_CALL)) {
      calls.set(event.data.callId, `${event.data.name} ${preview(event.data.arguments, 100)}`)
    } else if (matches(event, SANDBOX_MODE)) {
      lines.push(`${at(event.seq)}  sandbox     ${event.data.mode} (${event.data.reason}; ${confinement(event.data.mode, event.data.enforcement)})`)
    } else if (matches(event, APPROVAL_POLICY)) {
      lines.push(`${at(event.seq)}  approvals   ${event.data.policy} (${event.data.reason})`)
    } else if (matches(event, AUTHORITY_PRESET)) {
      // The intent; the knob events that follow are the truth a reader folds.
      lines.push(`${at(event.seq)}  preset      ${event.data.name}`)
    } else if (matches(event, APPROVAL_ASKED)) {
      const covered = event.data.callId ? calls.get(event.data.callId) : undefined
      lines.push(`${at(event.seq)}  asked       ${event.data.id} ${event.data.toolName}${event.data.reason ? `: ${event.data.reason}` : ''}`)
      if (covered) lines.push(`                    for: ${covered}`)
    } else if (matches(event, APPROVAL_DECIDED)) {
      lines.push(`${at(event.seq)}  decided     ${event.data.id} ${event.data.outcome}`)
    } else if (matches(event, COMPACTION_APPLIED)) {
      // A compaction rewrites what the model can see, which is the kind of act
      // this view exists for.
      lines.push(`${at(event.seq)}  compacted   ${event.data.shadowedSeqs.length} messages (${event.data.trigger}; from compaction/start ${event.data.startSeq})`)
    } else if (matches(event, SUBAGENT_START)) {
      // A delegation is an authority act: the child's whole scope is decided here.
      lines.push(`${at(event.seq)}  delegated   ${event.data.childId} under ${event.data.sandbox}, approvals ${event.data.approval} (depth ${event.data.depth})`)
    } else if (matches(event, TOOL_RESULT)) {
      const error = event.data.error
      if (error && DENIALS.has(error.code)) lines.push(`${at(event.seq)}  denied      ${error.code} (${calls.get(event.data.callId) ?? ''})`)
    }
  }
  return lines
}
