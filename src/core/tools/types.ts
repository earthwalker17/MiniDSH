import type { z } from 'zod'
import type { CallId } from '../ids.ts'
import type { JsonValue } from '../json.ts'
import type { Agent } from '../agent/types.ts'
import type { ContentBlock, Message, ToolSchema } from '../llm/types.ts'
import type { ToolCallView } from './presentation.ts'

/** Immutable identity of one tool call through the pipeline. */
export interface ToolExecution {
  readonly callId: CallId
  readonly name: string
  /** Parsed model arguments (validated against the tool's input before the body runs). */
  readonly arguments: unknown
  readonly agent: Agent | undefined
  readonly signal: AbortSignal
}

/** The context handed to a tool body. */
export interface ToolContext extends ToolExecution {
  /** Queue a model-facing message after this call's result (FIFO). */
  deferContext(message: Message): void
  /** End the turn after this result even if the model asked for more. */
  concludeTurn(): void
}

export interface ToolResult {
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
  readonly value?: JsonValue
  readonly error?: { readonly message: string; readonly info?: { readonly name: string; readonly code: string } }
  readonly additionalContexts?: readonly Message[]
  readonly concludesTurn?: boolean
}

/**
 * A tool definition. The body returns the canonical value; `render` projects
 * it into model-facing content. Only `{name, description, parameters}` ever
 * reaches the model.
 */
export interface ToolDefinition<Args = unknown, Value extends JsonValue = JsonValue> {
  readonly name: string
  readonly description: string
  readonly input: z.ZodType<Args>
  readonly output: z.ZodType<Value>
  render(args: Args, value: Value): ContentBlock[]
  execute(args: Args, exec: ToolContext): Value | Promise<Value>
  presentCall?(args: Args): ToolCallView
}

export type AnyToolDefinition = ToolDefinition<never, JsonValue>

export type PreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string }

/** After the body: accept (optionally replacing the model-facing content) or block with feedback. */
export type PostToolDecision =
  | { readonly kind: 'accept'; readonly content?: readonly ContentBlock[] }
  | { readonly kind: 'block'; readonly feedback: readonly ContentBlock[] }

/** Monotonic, deny-only. Returns a reason to deny, or undefined to abstain. */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

export type { ToolSchema }
