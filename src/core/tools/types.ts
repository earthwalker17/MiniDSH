import type { z } from 'zod'
import type { CallId } from '../ids.ts'
import type { JsonValue } from '../json.ts'
import type { Agent } from '../agent/types.ts'
import type { ContentBlock, Message, ToolSchema } from '../llm/types.ts'

/** Immutable identity of one tool call through the pipeline. */
export interface ToolExecution {
  readonly callId: CallId
  readonly name: string
  /** Parsed model arguments (validated against the tool's input before the body runs). */
  readonly arguments: unknown
  readonly agent: Agent | undefined
  /** The body's signal: the caller's cancellation OR this call's own deadline. */
  readonly signal: AbortSignal
  /**
   * The caller's cancellation alone, without this call's deadline. Consent is
   * the human's time, not the tool's, so anything that waits on a person waits
   * on this — and a cancelled turn still settles it.
   */
  readonly callSignal: AbortSignal
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
  /** Not durable: the driver logs `content` only, so `value` never outlives this process. */
  readonly value?: JsonValue
  readonly error?: { readonly message: string; readonly info?: { readonly name: string; readonly code: string } }
  readonly additionalContexts?: readonly Message[]
  readonly concludesTurn?: boolean
}

/**
 * Non-model-facing tool annotations.
 *
 * How one capability recognises a KIND of tool another registered without
 * importing it (capabilities never import each other) and without hard-coding a
 * name a deployment is free to change. Three exist: the delegation depth cap
 * hides every delegation tool at the cap, whichever row registered it; a
 * compaction summary names the recall tool a deployment mounted, if it mounted
 * one; and delegation hides every network tool from every child. The first two
 * used to be process-global maps or would have been a literal string crossing a
 * capability boundary.
 */
/** A tool that starts a delegated child agent. */
export const DELEGATION_TOOL = 'delegation'
/** A tool that reads back history a compaction shadowed. */
export const RECALL_TOOL = 'recall'
/**
 * A tool whose body sends data off the machine and asks consent for EVERY
 * call (S18's `web_search`). Its reader is `tool-subagent`, which hides it
 * from every delegated child: a child's approvals are pinned `never`, which
 * refuses every network ask before any answerer sees it, so in a child the
 * tool could only ever spend a paid step learning that.
 */
export const NETWORK_TOOL = 'network'

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
  /**
   * Wall-clock budget for the body, counted from AFTER the gate — a human
   * deliberating over an approval never spends a tool's deadline. Omitted
   * takes the registry default; `null` opts out (a tool that owns its own
   * lifetime). Cooperative: the derived signal notifies, it does not kill.
   */
  readonly timeoutMs?: number | null
  /**
   * This tool's BODY may overlap its siblings' bodies in one step (ARCHITECTURE
   * §6, "joined at the step"); absent, every call of it runs alone, in model
   * order, as every call did before S21. A promise the tool makes, fail-closed:
   * its body asks nobody (only the ordered lane may ask), reads no budget
   * folded from the committed surface (image admission, recall), depends on no
   * sibling's effect having landed, and keeping shared-workspace effects
   * disjoint is its CALLER's job, fenced only by the editor's version check.
   * It also owns its clock: `timeoutMs` must be `null` (the registry refuses
   * anything else), because a deadline abandons a body, and an abandoned body
   * would leave the pool still running while the step believed it drained.
   */
  readonly concurrencySafe?: true
  /**
   * What KIND of tool this is, for the runtime — never for the model, which
   * only ever sees `{name, description, parameters}`. See `DELEGATION_TOOL` and
   * `RECALL_TOOL`; a tag is read through the registry, so what a tag means is
   * scoped to the deployment that registered it.
   */
  readonly tags?: readonly string[]
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
