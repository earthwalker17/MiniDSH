/**
 * Pure rendering for the terminal surface. Live output streams straight from
 * durable `assistant/chunk` events (text deltas as they arrive), so streaming
 * fidelity costs nothing beyond the log itself; history render folds the same
 * durable events after the fact. No terminal state leaks in here — the
 * controller owns interaction.
 */
import { messageText, restoreMessage } from '../../core/llm/message.ts'
import type { EventEnvelope } from '../../core/session/index.ts'

function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

type LoggedMessage = Parameters<typeof restoreMessage>[0]

/** Folds live session events into raw terminal writes (may be partial lines). */
export class TerminalRenderer {
  private streaming = false
  private thinking = false

  onEvent(event: EventEnvelope): string {
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = (event.data as { chunk: { type: string; text?: string } }).chunk
        if (chunk.type === 'text-delta') {
          this.streaming = true
          return chunk.text ?? ''
        }
        if (chunk.type === 'reasoning-delta' && !this.thinking) {
          this.thinking = true
          return '… thinking\n'
        }
        if (chunk.type === 'finish') {
          const closer = this.streaming ? '\n' : ''
          this.streaming = false
          this.thinking = false
          return closer
        }
        return ''
      }
      case 'user/message': {
        const message = restoreMessage((event.data as { message: LoggedMessage }).message)
        return message.source.kind === 'user' ? '' : `· context (${message.source.kind})\n`
      }
      case 'tool/call': {
        const data = event.data as { name: string; arguments: string }
        return `→ ${data.name} ${preview(data.arguments)}\n`
      }
      case 'tool/result': {
        const data = event.data as { error?: { code: string } }
        return data.error ? `  ✗ ${data.error.code}\n` : '  ✓\n'
      }
      case 'turn/end': {
        const reason = (event.data as { reason: { kind: string } }).reason.kind
        return reason === 'completed' ? '' : `[turn ${reason}]\n`
      }
      // Authority is visible where it changes: a surface that hides a widened
      // boundary is a surface that lets one happen quietly.
      case 'sandbox/mode': {
        const data = event.data as { mode: string; enforcement: string; reason: string }
        const enforced = data.mode === 'danger-full-access' ? 'unconfined' : `shell confinement: ${data.enforcement}`
        return `[sandbox: ${data.mode} (${enforced})]\n`
      }
      case 'approval/policy':
        return `[approvals: ${(event.data as { policy: string }).policy}]\n`
      default:
        return ''
    }
  }
}

/** Folds a stored log into a conversation transcript for an attaching client. */
export function renderHistory(events: readonly EventEnvelope[]): string {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const message = restoreMessage((event.data as { message: LoggedMessage }).message)
      const text = messageText(message)
      if (message.source.kind === 'user' && text.length > 0) lines.push(`you> ${preview(text, 200)}`)
    } else if (event.type === 'assistant/message') {
      const message = restoreMessage((event.data as { message: LoggedMessage }).message)
      const text = messageText(message)
      if (text.length > 0) lines.push(preview(text, 400))
    } else if (event.type === 'tool/call') {
      const data = event.data as { name: string; arguments: string }
      lines.push(`→ ${data.name} ${preview(data.arguments)}`)
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
