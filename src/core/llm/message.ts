import { asMessageId, newMessageId, type CallId } from '../ids.ts'
import { deepFreeze } from '../json.ts'
import { contentText } from './content.ts'
import type { ContentBlock, Message, MessageSource, ReplayEnvelope } from './types.ts'

/** Builds a frozen message with a fresh id. */
export function createMessage(role: Message['role'], content: ContentBlock[], source: MessageSource): Message {
  return deepFreeze({ id: newMessageId(), role, content: content.slice(), source })
}

/** A user-authored prompt or steering message. */
export function createUserMessage(text: string): Message {
  return createMessage('user', [{ type: 'text', text }], { kind: 'user' })
}

/** Injected model-facing context; `plugin` names the producer. */
export function createPluginMessage(plugin: string, text: string, form?: string): Message {
  return createMessage('user', [{ type: 'text', text }], form === undefined ? { kind: 'plugin', plugin } : { kind: 'plugin', plugin, form })
}

/** `replayState` is the adapter's own envelope for replaying this response to the same provider (see `ReplayEnvelope`). */
export function createAssistantMessage(content: ContentBlock[], provider: string, model: string, replayState?: ReplayEnvelope): Message {
  return createMessage('assistant', content, replayState === undefined ? { kind: 'assistant', provider, model } : { kind: 'assistant', provider, model, replayState })
}

/** A tool result is a user-role message carrying one tool-result block. */
export function createToolResultMessage(callId: CallId, content: ContentBlock[], isError: boolean): Message {
  const block: ContentBlock = isError
    ? { type: 'tool-result', toolCallId: callId, content: content.slice(), isError: true }
    : { type: 'tool-result', toolCallId: callId, content: content.slice() }
  return createMessage('user', [block], { kind: 'tool', callId })
}

/** Rehydrates a message read from the log as a frozen value with a preserved id. */
export function restoreMessage(raw: Message): Message {
  return deepFreeze({ ...raw, id: asMessageId(raw.id), content: raw.content.slice() })
}

/**
 * What a message says, as text — what a headless surface prints, what the
 * terminal renders, and what a delegation answers with.
 *
 * It projects through `blockText` rather than filtering for `type === 'text'`,
 * so an image contributes its descriptor instead of vanishing. For the four
 * original block kinds the result is byte-identical to the filter it replaces.
 */
export function messageText(message: Message): string {
  return contentText(message.content)
}
