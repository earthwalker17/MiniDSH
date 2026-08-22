import { z } from 'zod'
import { emitEvent, serviceKey, waterfallEvent, type Context, type Disposer, type Plugin } from '../../kernel/index.ts'
import type { Agent } from '../agent/types.ts'
import { APPROVAL } from '../approval/index.ts'
import { asCallId, type CallId } from '../ids.ts'
import { deepFreeze, snapshotJson, type JsonValue } from '../json.ts'
import type { ContentBlock, Message, ToolSchema } from '../llm/types.ts'
import { ScopedLayers } from '../scope.ts'
import type {
  AnyToolDefinition,
  PostToolDecision,
  PreToolDecision,
  ToolContext,
  ToolDefinition,
  ToolExecution,
  ToolGuard,
  ToolResult,
} from './types.ts'

export const TOOLS_PRE_EXECUTE = waterfallEvent<[execution: ToolExecution], Promise<PreToolDecision>>('tools/pre-execute')
export const TOOLS_EXECUTE = waterfallEvent<[execution: ToolExecution], Promise<ToolResult>>('tools/execute')
export const TOOLS_POST_EXECUTE = waterfallEvent<[execution: ToolExecution, result: ToolResult], Promise<PostToolDecision>>('tools/post-execute')
export const TOOLS_RESULT = emitEvent<[execution: ToolExecution, result: ToolResult]>('tools/result')
export const TOOLS_CHANGE = emitEvent<[]>('tools/change')

/** One model tool call, before parsing. */
export interface ToolCall {
  readonly callId: CallId
  readonly name: string
  readonly arguments: string
  readonly agent: Agent | undefined
  readonly signal: AbortSignal
}

export interface Tools {
  register<Args, Value extends JsonValue>(owner: Context, definition: ToolDefinition<Args, Value>): Disposer
  guard(owner: Context, guard: ToolGuard): Disposer
  get(name: string, agent?: Agent): AnyToolDefinition | undefined
  list(agent?: Agent): AnyToolDefinition[]
  schemas(agent?: Agent): ToolSchema[]
  execute(call: ToolCall): Promise<ToolResult>
}

export const TOOLS = serviceKey<Tools>('tools')

/** zod input schema → JSON Schema for the model (draft-7, `$schema` stripped). */
export function toParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
  const { $schema: _drop, ...rest } = json
  return rest
}

function errorResult(message: string, name: string, code: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }], error: { message, info: { name, code } } }
}

/**
 * Definitions and guards are per-agent layered (see `core/scope.ts`), and the
 * pipeline's events are dispatched through the acting agent's scope so that a
 * listener registered via one agent's context never sees another agent's
 * calls. Registry-membership notifications (`tools/change`) stay global.
 */
class ToolRegistry implements Tools {
  private readonly definitions = new ScopedLayers<AnyToolDefinition>()
  private readonly guards = new ScopedLayers<ToolGuard>()
  private guardSeq = 0
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  register<Args, Value extends JsonValue>(owner: Context, definition: ToolDefinition<Args, Value>): Disposer {
    const def = definition as unknown as AnyToolDefinition
    const layer = this.definitions.layerFor(owner)
    if (layer.has(def.name)) throw new Error(`tool "${def.name}" is already registered in this scope`)
    layer.set(def.name, def)
    this.ctx.emit(TOOLS_CHANGE)
    return owner.effect(() => () => {
      if (layer.get(def.name) === def) layer.delete(def.name)
      this.ctx.emit(TOOLS_CHANGE)
    }, `tool("${def.name}")`)
  }

  guard(owner: Context, guard: ToolGuard): Disposer {
    const layer = this.guards.layerFor(owner)
    const key = `guard#${++this.guardSeq}`
    layer.set(key, guard)
    return owner.effect(() => () => void layer.delete(key), 'tool.guard')
  }

  get(name: string, agent?: Agent): AnyToolDefinition | undefined {
    return this.definitions.get(name, agent)
  }

  list(agent?: Agent): AnyToolDefinition[] {
    return [...this.definitions.view(agent).values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** Events about a call are dispatched in the acting agent's scope; agent-less calls are unscoped. */
  private scopeOf(agent: Agent | undefined): Context {
    return agent?.ctx ?? this.ctx
  }

  schemas(agent?: Agent): ToolSchema[] {
    return this.list(agent).map((def) => ({ name: def.name, description: def.description, parameters: toParameters(def.input) }))
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.get(call.name, call.agent)
    if (!tool) return errorResult(`unknown tool "${call.name}"`, 'UnknownTool', 'UNKNOWN_TOOL')

    let parsed: unknown
    try {
      parsed = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
    } catch {
      return errorResult(`arguments for "${call.name}" are not valid JSON`, 'InvalidArgs', 'INVALID_ARGS')
    }
    const validated = tool.input.safeParse(parsed)
    if (!validated.success) {
      return errorResult(`invalid arguments for "${call.name}": ${validated.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 'InvalidArgs', 'INVALID_ARGS')
    }

    const additionalContexts: Message[] = []
    let concludesTurn = false
    const execution: ToolContext = {
      callId: call.callId,
      name: call.name,
      arguments: validated.data,
      agent: call.agent,
      signal: call.signal,
      deferContext: (message) => void additionalContexts.push(message),
      concludeTurn: () => void (concludesTurn = true),
    }

    const scope = this.scopeOf(call.agent)
    let result: ToolResult
    try {
      const gate = await this.gate(execution, scope)
      if (gate) {
        result = gate
      } else {
        const body = () => this.runBody(tool, validated.data as unknown, execution)
        const candidate = await scope.waterfall(TOOLS_EXECUTE, execution, body)
        result = await this.post(execution, candidate, scope)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = errorResult(message, error instanceof Error ? error.name : 'Error', 'TOOL_FAILED')
    }

    if (additionalContexts.length > 0 && !result.additionalContexts) result = { ...result, additionalContexts }
    if (concludesTurn && !result.concludesTurn) result = { ...result, concludesTurn: true }
    const frozen = deepFreeze({ ...result, content: [...result.content] })
    scope.emit(TOOLS_RESULT, execution, frozen)
    return frozen
  }

  /** Runs pre-execute policy, approval, and guards. Returns a denial result, or undefined to proceed. */
  private async gate(execution: ToolContext, scope: Context): Promise<ToolResult | undefined> {
    if (execution.signal.aborted) return errorResult('tool call aborted before dispatch', 'AbortError', 'ABORTED_BEFORE_DISPATCH')
    const decision = await scope.waterfall(TOOLS_PRE_EXECUTE, execution, async () => ({ kind: 'allow' }) as PreToolDecision)
    if (decision.kind === 'deny') return errorResult(`denied: ${decision.reason}`, 'Denied', 'DENIED')
    if (decision.kind === 'ask') {
      const approval = this.ctx.tryGet(APPROVAL)
      if (!approval || !execution.agent) return errorResult('approval unavailable', 'Denied', 'DENIED')
      const outcome = await approval.request({
        agent: execution.agent,
        toolName: execution.name,
        callId: execution.callId,
        signal: execution.signal,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      })
      if (outcome !== 'allowed-once') return errorResult(`approval ${outcome}`, 'Denied', outcome === 'cancelled' ? 'ABORTED' : 'DENIED')
    }
    for (const guard of this.guards.view(execution.agent).values()) {
      const denial = guard(execution)
      if (denial !== undefined) return errorResult(`denied: ${denial}`, 'Denied', 'DENIED')
    }
    return undefined
  }

  private async runBody(tool: AnyToolDefinition, args: unknown, execution: ToolContext): Promise<ToolResult> {
    const raw = await tool.execute(args as never, execution)
    const value = tool.output.parse(raw)
    const content = tool.render(args as never, value as never)
    return { isError: false, content, value: snapshotJson(value) as JsonValue }
  }

  private async post(execution: ToolContext, candidate: ToolResult, scope: Context): Promise<ToolResult> {
    const decision = await scope.waterfall(TOOLS_POST_EXECUTE, execution, candidate, async () => ({ kind: 'accept' }) as PostToolDecision)
    if (decision.kind === 'block') return { isError: true, content: [...decision.feedback], error: { message: 'blocked by policy', info: { name: 'Blocked', code: 'BLOCKED' } } }
    if (decision.kind === 'accept-value') return { ...candidate, value: decision.value }
    if (decision.content) return { ...candidate, content: [...decision.content] }
    return candidate
  }
}

/** The tool registry plugin: provides `ctx.tools`. */
export const toolsPlugin: Plugin = {
  name: 'core-tools',
  apply(ctx) {
    ctx.provide(TOOLS, new ToolRegistry(ctx))
  },
}

/** Helper for capabilities: build a tool call from a durable tool/call record. */
export function toolCall(callId: string, name: string, args: string, agent: Agent | undefined, signal: AbortSignal): ToolCall {
  return { callId: asCallId(callId), name, arguments: args, agent, signal }
}

export type { ContentBlock }
