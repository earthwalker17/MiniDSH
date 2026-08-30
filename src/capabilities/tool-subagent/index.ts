/**
 * Delegation: a model-facing tool that hands a bounded task to a child agent
 * whose authority can never be wider than its parent's.
 *
 * The child is an ordinary agent — its own session, its own log, its own
 * turn — created through the same factory a top-level agent goes through,
 * bound to the PARENT's scope so it cannot outlive it. Spawn mode: the child
 * starts empty, with only the task it was given, because inheriting a
 * parent's history is a different thing (a fork) with different costs.
 *
 * The authority is captured BEFORE the first await — a parent that widens
 * its own mode later widened it for its own future, not for this child — and
 * written into the child's log inside `setup`, before publication, as the
 * two opening stamps `reason: 'delegation'`. That opening is the ceiling
 * (`core/sandbox`, `core/approval`): approvals pinned `never` means every
 * escalation the child asks for is refused inside the service before any
 * answerer sees it, and the sandbox ceiling refuses a widening even if one
 * somehow arrived. So the child cannot buy authority its parent did not
 * have, and nothing in the composition can grant it.
 *
 * What the parent's log records is the call and its result, plus two log-only
 * facts naming the child (`subagent/start|end`) — the child's own steps live
 * in the child's own log, where `sessions show <child>` reads them. That is a
 * deliberate divergence from DSH, which emits its lifecycle events as runtime
 * events and finds children by scanning stored headers; MiniDSH has no
 * projections, so the parent's log is where a human looks first.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENTS, resolveCallConfig, type Agent, type AgentOptions } from '../../core/agent/index.ts'
import { APPROVAL, type Approval } from '../../core/approval/index.ts'
import { messageText, createUserMessage } from '../../core/llm/message.ts'
import { PROMPT, type Prompt } from '../../core/prompt/index.ts'
import { effectiveSandboxMode, SANDBOX, type Sandbox, type SandboxMode } from '../../core/sandbox/index.ts'
import { ASSISTANT_MESSAGE, eventKind, matches, TURN_END, type Session, type TurnEndReason } from '../../core/session/index.ts'
import { defineTool, TOOLS, type ToolContext, type ToolRestriction } from '../../core/tools/index.ts'
import type { TokenUsage } from '../../core/llm/index.ts'

export interface SubagentConfig {
  /** How deep delegation may go; `0` forbids it entirely (default 2). */
  readonly maxDepth?: number | undefined
  /** The subtractive view every child gets over the tools it inherits (the delegation tool itself is always denied). */
  readonly toolFilter?: ToolRestriction | undefined
  /** Replaces the persona section in the child's world. */
  readonly persona?: string | undefined
  /** Step ceiling for a child's single turn (default 12). */
  readonly maxSteps?: number | undefined
  /** Model-facing name (default `subagent`). */
  readonly toolName?: string | undefined
}

const configSchema = z
  .strictObject({
    maxDepth: z.number().int().nonnegative().optional(),
    toolFilter: z.strictObject({ allow: z.array(z.string().min(1)).optional(), deny: z.array(z.string().min(1)).optional() }).optional(),
    persona: z.string().min(1).optional(),
    maxSteps: z.number().int().positive().optional(),
    toolName: z.string().min(1).optional(),
  })
  .optional()

const PURPOSE = 'subagent'
const DEFAULT_TOOL_NAME = 'subagent'

/** Log-only, in the PARENT's session: which child was started for which call, and under what. */
export const SUBAGENT_START = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly depth: number
  readonly provider: string
  readonly model: string
  readonly sandbox: SandboxMode
  readonly approval: 'never'
}>('subagent/start')

/** Log-only, in the PARENT's session: how the child's turn ended, and what it cost. */
export const SUBAGENT_END = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly reason: TurnEndReason
  readonly usage?: TokenUsage
}>('subagent/end')

const DESCRIPTION = `Delegate one bounded, self-contained task to a subagent and wait for its answer.

* The subagent starts fresh: it sees NONE of this conversation. Its prompt must carry everything it needs — paths, names, constraints, and what to report back.
* It runs under this session's authority or narrower, with approvals disabled: it cannot ask the user for anything, and an action needing approval is refused. Do not delegate work that needs an escalation.
* It answers once, in text. Use it to scope, search, read or summarise; keep decisions and edits that need this conversation's context here.`

const InputSchema = z.object({
  description: z.string().describe('A short (3-5 word) label for the delegated task, shown to the user.'),
  prompt: z.string().describe('The task, complete in itself: the subagent sees none of this conversation.'),
})
type Input = z.infer<typeof InputSchema>

/**
 * The resolved config. Spelled out rather than `Required<Pick<…>>`, which
 * does NOT strip an explicit `| undefined` from an optional field.
 */
interface ResolvedConfig {
  readonly maxDepth: number
  readonly maxSteps: number
  readonly toolFilter?: ToolRestriction | undefined
  readonly persona?: string | undefined
}

interface Deps {
  readonly ctx: Context
  readonly sandbox: Sandbox
  readonly approval: Approval
  readonly prompt: Prompt
  readonly config: ResolvedConfig
  readonly toolName: string
}

/** The authority a child opens under, read from the parent BEFORE the first await. */
function captureAuthority(parent: Agent, sandbox: Sandbox): { readonly mode: SandboxMode } {
  return { mode: effectiveSandboxMode(parent.session.facts) ?? sandbox.defaultMode }
}

/** The last non-empty assistant text of a session — what a child answers with. */
function finalText(session: Session): string {
  for (let i = session.facts.length - 1; i >= 0; i--) {
    const event = session.facts[i]!
    if (!matches(event, ASSISTANT_MESSAGE)) continue
    const text = messageText(event.data.message)
    if (text.length > 0) return text
  }
  return ''
}

function finalReason(session: Session): TurnEndReason {
  for (let i = session.facts.length - 1; i >= 0; i--) {
    const event = session.facts[i]!
    if (matches(event, TURN_END)) return event.data.reason
  }
  return { kind: 'error', code: 'NO_TURN', message: 'the subagent never ran a turn' }
}

/** Everything the child's own log priced, summed — the parent's record of what the delegation cost. */
function childUsage(session: Session): TokenUsage | undefined {
  let seen = false
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  for (const event of session.facts) {
    if (!matches(event, ASSISTANT_MESSAGE) || !event.data.usage) continue
    seen = true
    const usage = event.data.usage
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    total.reasoningTokens += usage.reasoningTokens ?? 0
  }
  if (!seen) return undefined
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    ...(total.cacheReadTokens > 0 ? { cacheReadTokens: total.cacheReadTokens } : {}),
    ...(total.cacheWriteTokens > 0 ? { cacheWriteTokens: total.cacheWriteTokens } : {}),
    ...(total.reasoningTokens > 0 ? { reasoningTokens: total.reasoningTokens } : {}),
  }
}

async function delegate(args: Input, exec: ToolContext, deps: Deps): Promise<{ output: string; childId: string }> {
  const parent = exec.agent
  if (!parent) throw new Error('the subagent tool requires an owning agent')
  // Depth first, before anything is created: a refusal at the cap costs nothing.
  const depth = (parent.session.header.delegationDepth ?? 0) + 1
  if (depth > deps.config.maxDepth) {
    throw Object.assign(new Error(`delegation depth ${depth} exceeds the limit of ${deps.config.maxDepth}; do this work yourself`), { code: 'SUBAGENT_DEPTH' })
  }
  // Captured before the first await: a parent switch after this belongs to the parent's future.
  const inherited = captureAuthority(parent, deps.sandbox)
  const route = await resolveCallConfig(parent, { purpose: PURPOSE, signal: exec.callSignal })
  const agentOptions: AgentOptions = { ...route, maxSteps: deps.config.maxSteps }
  const denied = [deps.toolName, ...(deps.config.toolFilter?.deny ?? [])]
  const restriction: ToolRestriction = { ...(deps.config.toolFilter?.allow === undefined ? {} : { allow: deps.config.toolFilter.allow }), deny: denied }

  const handle = await deps.ctx.get(AGENTS).create(parent.ctx, {
    cwd: parent.session.header.cwd,
    agentOptions,
    delegatedBy: parent.id,
    delegationDepth: depth,
    ...(parent.session.header.agentPreset === undefined ? {} : { agentPreset: parent.session.header.agentPreset }),
    signal: exec.callSignal,
    setup: async (childCtx, child) => {
      // The child's world is its parent's, then narrowed: same preset, same
      // tools minus the filter, its own persona, and an authority that opens
      // as a ceiling before a single effect can run.
      await parent.setup?.(childCtx, child)
      deps.sandbox.open(child.session, { mode: inherited.mode, reason: 'delegation' })
      deps.approval.open(child.session, { policy: 'never', reason: 'delegation' })
      deps.ctx.get(TOOLS).restrict(childCtx, restriction)
      if (deps.config.persona !== undefined) deps.prompt.section(childCtx, { name: 'persona', order: -50, text: deps.config.persona })
    },
  })

  const child = handle.agent
  parent.session.append(SUBAGENT_START, {
    callId: exec.callId,
    childId: child.id,
    depth,
    provider: route.provider,
    model: route.model,
    sandbox: inherited.mode,
    approval: 'never',
  })
  // A cancelled parent call cancels the child: its turn ends `cancelled`, its
  // log stays whole, and the tool answers with whatever it had.
  const onAbort = (): void => child.cancel({ kind: 'parent' })
  exec.callSignal.addEventListener('abort', onAbort, { once: true })
  try {
    child.followup(createUserMessage(args.prompt))
    await child.whenIdle()
    await child.session.flush()
    const reason = finalReason(child.session)
    const output = finalText(child.session)
    const usage = childUsage(child.session)
    parent.session.append(SUBAGENT_END, { callId: exec.callId, childId: child.id, reason, ...(usage === undefined ? {} : { usage }) })
    if (reason.kind !== 'completed') {
      // Not a partial success: the parent is told the turn did not finish, and
      // still gets whatever the child managed to say.
      throw Object.assign(new Error(`the subagent's turn ended ${reason.kind}${output.length > 0 ? `; it had said: ${output}` : ''}`), { code: 'SUBAGENT_INCOMPLETE' })
    }
    return { output, childId: child.id }
  } finally {
    exec.callSignal.removeEventListener('abort', onAbort)
    await handle.dispose()
  }
}

export const toolSubagentPlugin: Plugin<SubagentConfig | undefined> = {
  name: 'tool-subagent',
  inject: [TOOLS, AGENTS, SANDBOX, APPROVAL, PROMPT],
  config: configSchema,
  apply(ctx, config) {
    const toolName = config?.toolName ?? DEFAULT_TOOL_NAME
    const deps: Deps = {
      ctx,
      sandbox: ctx.get(SANDBOX),
      approval: ctx.get(APPROVAL),
      prompt: ctx.get(PROMPT),
      toolName,
      config: {
        maxDepth: config?.maxDepth ?? 2,
        maxSteps: config?.maxSteps ?? 12,
        ...(config?.toolFilter === undefined ? {} : { toolFilter: config.toolFilter }),
        ...(config?.persona === undefined ? {} : { persona: config.persona }),
      },
    }
    ctx.get(TOOLS).register(
      ctx,
      defineTool({
        name: toolName,
        description: DESCRIPTION,
        input: InputSchema,
        output: z.object({ output: z.string(), childId: z.string() }),
        // The child owns its own clock (its turn, its tools' deadlines); a
        // registry deadline here would kill a child mid-effect and leave its
        // log open, and the caller's cancellation already reaches it.
        timeoutMs: null,
        presentCall: (args) => ({ card: 'generic', title: args.description, kind: 'other' }),
        render: (_args, value) => [{ type: 'text', text: value.output.length > 0 ? value.output : '(the subagent produced no text)' }],
        execute: (args, exec) => delegate(args, exec, deps),
      }),
    )
  },
}
