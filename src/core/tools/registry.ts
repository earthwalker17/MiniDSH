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

/**
 * A subtractive view over the tools an agent inherits: `allow` keeps only the
 * named ones, `deny` removes the named ones, allow before deny, several
 * restrictions intersect. A tool the restriction hides is unknown to the
 * model (absent from its schemas) AND refused at execution — one resolver
 * decides both, so nothing can be called that was never shown. The scope's
 * OWN registrations are exempt: a child keeps the tools it answers through.
 */
export interface ToolRestriction {
  readonly allow?: readonly string[] | undefined
  readonly deny?: readonly string[] | undefined
}

export interface Tools {
  register<Args, Value extends JsonValue>(owner: Context, definition: ToolDefinition<Args, Value>): Disposer
  guard(owner: Context, guard: ToolGuard): Disposer
  /** Installs a restriction on the owner's scope (an unscoped owner is refused: it would hide tools from every agent). */
  restrict(owner: Context, restriction: ToolRestriction): Disposer
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
 * A thrown error that names its own failure keeps that name in the durable
 * record: a policy denial must read as `FS_SANDBOX_DENIED` in the log, not as
 * an indistinguishable `TOOL_FAILED`.
 */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'TOOL_FAILED'
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
  private readonly restrictions = new WeakMap<object, ToolRestriction[]>()
  private guardSeq = 0
  private readonly ctx: Context
  private readonly defaultTimeoutMs: number
  constructor(ctx: Context, config: ToolsConfig) {
    this.ctx = ctx
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000
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

  restrict(owner: Context, restriction: ToolRestriction): Disposer {
    const scope = owner.scope
    if (scope === null || typeof scope !== 'object') {
      throw new Error('a tool restriction needs a scoped owner: an unscoped one would hide tools from every agent')
    }
    let list = this.restrictions.get(scope)
    if (!list) {
      list = []
      this.restrictions.set(scope, list)
    }
    const entry: ToolRestriction = { ...(restriction.allow === undefined ? {} : { allow: [...restriction.allow] }), ...(restriction.deny === undefined ? {} : { deny: [...restriction.deny] }) }
    list.push(entry)
    this.ctx.emit(TOOLS_CHANGE)
    return owner.effect(() => () => {
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
      this.ctx.emit(TOOLS_CHANGE)
    }, 'tool.restrict')
  }

  /** The one visibility rule: the agent's own registrations always; an inherited one unless a restriction hides it. */
  private visible(name: string, agent: Agent | undefined): boolean {
    if (!agent) return true
    const restrictions = this.restrictions.get(agent)
    if (!restrictions || restrictions.length === 0) return true
    if (this.definitions.owns(name, agent)) return true
    return restrictions.every((restriction) => (restriction.allow === undefined || restriction.allow.includes(name)) && !(restriction.deny ?? []).includes(name))
  }

  get(name: string, agent?: Agent): AnyToolDefinition | undefined {
    return this.visible(name, agent) ? this.definitions.get(name, agent) : undefined
  }

  list(agent?: Agent): AnyToolDefinition[] {
    return [...this.definitions.view(agent).values()]
      .filter((def) => this.visible(def.name, agent))
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
      callSignal: call.signal,
      deferContext: (message) => void additionalContexts.push(message),
      concludeTurn: () => void (concludesTurn = true),
    }

    const scope = this.scopeOf(call.agent)
    let result: ToolResult
    try {
      const gate = await this.gate(execution, scope)
      result = gate ?? (await this.dispatch(tool, validated.data as unknown, execution, scope))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = errorResult(message, error instanceof Error ? error.name : 'Error', codeOf(error))
    }

    if (additionalContexts.length > 0 && !result.additionalContexts) result = { ...result, additionalContexts }
    if (concludesTurn && !result.concludesTurn) result = { ...result, concludesTurn: true }
    const frozen = deepFreeze({ ...result, content: [...result.content] })
    scope.emit(TOOLS_RESULT, execution, frozen)
    return frozen
  }

  /** The tool's own budget, else the registry default; a non-positive budget means none. */
  private deadlineFor(tool: AnyToolDefinition): number | undefined {
    if (tool.timeoutMs === null) return undefined
    const ms = tool.timeoutMs ?? this.defaultTimeoutMs
    return ms > 0 ? ms : undefined
  }

  /**
   * The body, under its deadline. The clock starts here — after the gate — so
   * an approval a human is still thinking about never spends it. When it
   * fires, the call ends as TOOL_TIMEOUT and the body's signal is aborted so
   * it can release what it holds; a late result is discarded. The deadline is
   * therefore a backstop, not a way to collect partial work: a tool that has
   * something useful to say about running out of time owns a shorter deadline
   * of its own (the shell executor kills its child and returns the tail).
   */
  private async dispatch(tool: AnyToolDefinition, args: unknown, execution: ToolContext, scope: Context): Promise<ToolResult> {
    const ms = this.deadlineFor(tool)
    if (ms === undefined) {
      const candidate = await scope.waterfall(TOOLS_EXECUTE, execution, () => this.runBody(tool, args, execution))
      return this.post(execution, candidate, scope)
    }
    const timer = AbortSignal.timeout(ms)
    const timed: ToolContext = { ...execution, signal: AbortSignal.any([execution.signal, timer]) }
    const body = scope.waterfall(TOOLS_EXECUTE, timed, () => this.runBody(tool, args, timed))
    const expired = new Promise<'timeout'>((resolve) => timer.addEventListener('abort', () => resolve('timeout'), { once: true }))
    const outcome = await Promise.race([body.then((candidate) => ({ candidate })), expired])
    if (outcome === 'timeout') {
      // The body may still settle later; its rejection must not surface unhandled.
      void body.catch(() => undefined)
      return errorResult(`tool "${execution.name}" timed out after ${ms}ms`, 'ToolTimeoutError', 'TOOL_TIMEOUT')
    }
    return this.post(timed, outcome.candidate, scope)
  }

  /**
   * Runs pre-execute policy, the guards, then approval. Returns a denial
   * result, or undefined to proceed. Guards come BEFORE the ask: they are
   * synchronous and consent-independent, so a call they would refuse anyway
   * must never interrupt a person or spend an allowed-once in the log.
   */
  private async gate(execution: ToolContext, scope: Context): Promise<ToolResult | undefined> {
    if (execution.signal.aborted) return errorResult('tool call aborted before dispatch', 'AbortError', 'ABORTED_BEFORE_DISPATCH')
    const decision = await scope.waterfall(TOOLS_PRE_EXECUTE, execution, async () => ({ kind: 'allow' }) as PreToolDecision)
    if (decision.kind === 'deny') return errorResult(`denied: ${decision.reason}`, 'Denied', 'DENIED')
    for (const guard of this.guards.view(execution.agent).values()) {
      const denial = guard(execution)
      if (denial !== undefined) return errorResult(`denied: ${denial}`, 'Denied', 'DENIED')
    }
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
    if (decision.content) return { ...candidate, content: [...decision.content] }
    return candidate
  }
}

export interface ToolsConfig {
  /** Budget for a tool that declares none (default 60s). Non-positive means no deadline at all. */
  readonly defaultTimeoutMs?: number | undefined
}

const configSchema = z.strictObject({ defaultTimeoutMs: z.number().optional() }).optional()

/** The tool registry plugin: provides `ctx.tools`. */
export const toolsPlugin: Plugin<ToolsConfig | undefined> = {
  name: 'core-tools',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(TOOLS, new ToolRegistry(ctx, config ?? {}))
  },
}

/** Helper for capabilities: build a tool call from a durable tool/call record. */
export function toolCall(callId: string, name: string, args: string, agent: Agent | undefined, signal: AbortSignal): ToolCall {
  return { callId: asCallId(callId), name, arguments: args, agent, signal }
}

export type { ContentBlock }
