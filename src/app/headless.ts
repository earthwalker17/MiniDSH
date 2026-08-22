/**
 * The headless runner: a direct core entry point. Compose → settle (fail loud
 * on pending/failed plugins) → create agent → followup(task) → wait idle →
 * flush → read the final assistant text and turn outcome from the log. It only
 * touches `ctx.agents`/`ctx.sessions` and renders through `onEvent`.
 */
import { createRoot, type Context, type Logger } from '../kernel/index.ts'
import { AGENTS, type AgentOptions } from '../core/agent/index.ts'
import { asSessionId, type SessionId } from '../core/ids.ts'
import { messageText } from '../core/llm/message.ts'
import { ASSISTANT_MESSAGE, matches, SESSION_EVENT, TURN_END, type EventEnvelope } from '../core/session/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { applyPatches, compose, defaultDialect, mount, type Patch } from './compose.ts'
import type { ShellDialect } from '../capabilities/shell-stdio/index.ts'

export interface TaskOptions {
  readonly task: string
  readonly cwd: string
  readonly model: string
  readonly provider?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
  readonly approve?: boolean
  readonly invariants?: boolean
  readonly sessionsRoot: string
  readonly dialect?: ShellDialect
  readonly patches?: readonly Patch[]
  readonly logger?: Logger
  /** Runs after settle, before the agent is created (tests register a scripted adapter here). */
  readonly prepare?: (root: Context) => void | Promise<void>
}

export interface TaskResult {
  readonly exitCode: number
  readonly sessionId: SessionId
  readonly text: string
  readonly reason: string
}

export type EventListener = (event: EventEnvelope) => void

const silentLogger: Logger = { warn: () => {}, error: () => {} }

export async function runTask(options: TaskOptions, onEvent?: EventListener): Promise<TaskResult> {
  const root = createRoot({ logger: options.logger ?? silentLogger })
  const rows = applyPatches(
    compose({
      sessionsRoot: options.sessionsRoot,
      dialect: options.dialect ?? defaultDialect(),
      ...(options.approve === undefined ? {} : { approve: options.approve }),
      ...(options.invariants === undefined ? {} : { invariants: options.invariants }),
    }),
    options.patches ?? [],
    (message) => options.logger?.warn(message),
  )
  mount(root, rows)
  const report = await root.settle()
  if (report.pending.length > 0 || report.failed.length > 0) {
    await root.dispose()
    const pending = report.pending.map((entry) => `${entry.name} (needs ${entry.missing.join(', ') || 'nothing'})`).join('; ')
    const failed = report.failed.map((entry) => entry.name).join('; ')
    throw new Error(`composition did not settle — pending: [${pending}] failed: [${failed}]`)
  }

  await options.prepare?.(root)

  if (onEvent) root.on(SESSION_EVENT, (_session, event) => onEvent(event))

  const agentOptions: AgentOptions = {
    provider: options.provider ?? 'deepseek',
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  }
  const handle = await root.get(AGENTS).create(root, { cwd: options.cwd, agentOptions })
  try {
    await handle.agent.whenIdle()
    handle.agent.followup(createUserMessage(options.task))
    await handle.agent.whenIdle()
    await handle.agent.session.flush()
    const events = handle.agent.session.events
    return {
      exitCode: foldReason(events) === 'completed' ? 0 : 1,
      sessionId: asSessionId(handle.agent.id),
      text: foldFinalText(events),
      reason: foldReason(events),
    }
  } finally {
    await handle.dispose()
    await root.dispose()
  }
}

function foldFinalText(events: readonly EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, ASSISTANT_MESSAGE)) {
      const text = messageText(event.data.message)
      if (text.length > 0) return text
    }
  }
  return ''
}

function foldReason(events: readonly EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, TURN_END)) return event.data.reason.kind
  }
  return 'unknown'
}
