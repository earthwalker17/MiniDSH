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
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_POLICY } from '../core/approval/index.ts'
import { COMPACTION_APPLIED } from '../core/compaction/index.ts'
import { messageText, restoreMessage } from '../core/llm/message.ts'
import { formatTokens } from '../core/metering/index.ts'
import { AUTHORITY_PRESET } from '../core/presets/index.ts'
import { SANDBOX_MODE } from '../core/sandbox/index.ts'
import { ASSISTANT_MESSAGE, matches, TOOL_CALL, TOOL_RESULT, TURN_END, USER_MESSAGE, type EventEnvelope } from '../core/session/index.ts'

export function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** One line for one event, or nothing when the event has no human-facing shape. No indentation, no newline. */
export function describeEvent(event: EventEnvelope): string | undefined {
  if (matches(event, USER_MESSAGE)) {
    const message = restoreMessage(event.data.message)
    return message.source.kind === 'user' ? undefined : `· context (${message.source.kind})`
  }
  if (matches(event, TOOL_CALL)) return `→ ${event.data.name} ${preview(event.data.arguments)}`
  if (matches(event, TOOL_RESULT)) return event.data.error ? `✗ ${event.data.error.code}` : '✓'
  if (matches(event, ASSISTANT_MESSAGE)) {
    const text = messageText(restoreMessage(event.data.message))
    return text.length > 0 ? preview(text, 120) : undefined
  }
  if (matches(event, TURN_END)) return `[turn ${event.data.reason.kind}]`
  if (matches(event, SANDBOX_MODE)) {
    const { mode, enforcement, reason } = event.data
    // Authority is visible where it changes: a surface that hides a widened
    // boundary is a surface that lets one happen quietly.
    return `[sandbox: ${mode} (${reason}; ${mode === 'danger-full-access' ? 'unconfined' : `shell confinement ${enforcement}`})]`
  }
  if (matches(event, APPROVAL_POLICY)) return `[approvals: ${event.data.policy}]`
  if (matches(event, AUTHORITY_PRESET)) return `[preset: ${event.data.name}]`
  if (matches(event, APPROVAL_ASKED)) return `? ${event.data.id} ${event.data.toolName}${event.data.reason ? `: ${event.data.reason}` : ''}`
  if (matches(event, APPROVAL_DECIDED)) return `! ${event.data.id} ${event.data.outcome}`
  if (matches(event, COMPACTION_APPLIED)) {
    const { shadowedSeqs, trigger, surfaceTokensBefore, surfaceTokensAfter } = event.data
    return `[compacted ${shadowedSeqs.length} messages · ${trigger} · ~${formatTokens(surfaceTokensBefore)} → ~${formatTokens(surfaceTokensAfter)}]`
  }
  return undefined
}

/** A stored log folded into a conversation transcript for an attaching client. */
export function transcriptLines(events: readonly EventEnvelope[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (matches(event, USER_MESSAGE)) {
      const message = restoreMessage(event.data.message)
      const text = messageText(message)
      if (message.source.kind === 'user' && text.length > 0) lines.push(`you> ${preview(text, 200)}`)
    } else if (matches(event, ASSISTANT_MESSAGE)) {
      const text = messageText(restoreMessage(event.data.message))
      if (text.length > 0) lines.push(preview(text, 400))
    } else if (matches(event, TOOL_CALL)) {
      lines.push(`→ ${event.data.name} ${preview(event.data.arguments)}`)
    }
  }
  return lines
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
      lines.push(`${at(event.seq)}  sandbox     ${event.data.mode} (${event.data.reason}; shell confinement ${event.data.enforcement})`)
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
    } else if (matches(event, TOOL_RESULT)) {
      const error = event.data.error
      if (error && DENIALS.has(error.code)) lines.push(`${at(event.seq)}  denied      ${error.code} (${calls.get(event.data.callId) ?? ''})`)
    }
  }
  return lines
}
