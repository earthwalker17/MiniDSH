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
import { AGENTS, resolveCallConfig, SUBAGENT_END, SUBAGENT_START, type Agent, type AgentOptions } from '../../core/agent/index.ts'
import { APPROVAL, type Approval } from '../../core/approval/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { PROMPT, type Prompt } from '../../core/prompt/index.ts'
import { effectiveSandboxMode, narrowest, SANDBOX, SANDBOX_MODES, type Sandbox, type SandboxMode } from '../../core/sandbox/index.ts'
import { ASSISTANT_MESSAGE, foldLastAssistantText, foldLastTurnEnd, matches, type Session, type TurnEndReason } from '../../core/session/index.ts'
import { defineTool, DELEGATION_TOOL, RECALL_TOOL, TOOLS, type ToolContext, type ToolRestriction, type Tools } from '../../core/tools/index.ts'
import type { TokenUsage } from '../../core/llm/index.ts'

export interface SubagentConfig {
  /** How deep delegation may go; `0` forbids it entirely (default 2). */
  readonly maxDepth?: number | undefined
  /** The subtractive view every child gets over the tools it inherits (the delegation tool itself is always denied). */
  readonly toolFilter?: ToolRestriction | undefined
  /**
   * Replaces the persona section in the child's world — a scoped section
   * shadows a same-named global, and the deployment's persona is a global.
   * Where the child's inherited world has already claimed that name in its own
   * scope (an agent preset that registers a persona), replacement is not
   * expressible, so this is added ahead of it instead of failing the delegation.
   */
  readonly persona?: string | undefined
  /** Step ceiling for a child's single turn (default 12). */
  readonly maxSteps?: number | undefined
  /** Model-facing name (default `subagent`). */
  readonly toolName?: string | undefined
  /**
   * Model-facing description. Without one, a second delegation row advertises
   * the FIRST one's text — two tools a model cannot tell apart, whose shared
   * description actively steers away from whatever the second was mounted for.
   */
  readonly description?: string | undefined
  /**
   * The purpose this delegation's route resolves under (default `subagent`),
   * so a second row can take a different route through `model-roles`.
   *
   * A purpose with no matching role passes through SILENTLY to the parent's base
   * route — that is `model-roles`' contract, and it means the two rows must be
   * patched together. A verifier row without its role produces a child on the
   * parent's own model, which then refuses its own image exactly as the parent
   * did, and answers from the filename instead. Nothing fails; the arc asserts
   * the binding for that reason.
   */
  readonly purpose?: string | undefined
  /**
   * A ceiling this row imposes on top of the parent's. It can only NARROW: a
   * verifier is mounted `read-only` and stays read-only under a
   * `danger-full-access` parent. Widening is not expressible.
   */
  readonly sandbox?: SandboxMode | undefined
}

const configSchema = z
  .strictObject({
    maxDepth: z.number().int().nonnegative().optional(),
    toolFilter: z.strictObject({ allow: z.array(z.string().min(1)).optional(), deny: z.array(z.string().min(1)).optional() }).optional(),
    persona: z.string().min(1).optional(),
    maxSteps: z.number().int().positive().optional(),
    toolName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    purpose: z.string().min(1).optional(),
    sandbox: z.enum(SANDBOX_MODES as [SandboxMode, ...SandboxMode[]]).optional(),
  })
  .optional()

const DEFAULT_PURPOSE = 'subagent'
const DEFAULT_TOOL_NAME = 'subagent'

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
  readonly purpose: string
  readonly sandbox?: SandboxMode | undefined
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

/**
 * Every delegation tool this DEPLOYMENT registered, read from its own registry.
 *
 * The depth cap is meant to be a fact about the child's WORLD rather than an
 * error it discovers by trying, and hiding only this row's own tool stopped
 * being enough the moment a verifier became a second row of the same plugin:
 * a grandchild at the cap would still see the other row's tool, call it, and
 * spend a paid step learning what its tool list should already have told it.
 *
 * This used to be a ref-counted module map, which is process state in a process
 * that mounts many compositions: a row named `verify` in one composition denied
 * a tool of that name to another composition's children, and the count existed
 * only so out-of-order disposal could not un-hide a name a live composition had
 * added. A tag read through `TOOLS` is scoped to one registry by construction,
 * so both problems are gone. Unscoped, because the globals are exactly what a
 * child inherits: a scoped registration is never inherited (`core/scope.ts`).
 */
function delegationToolNames(tools: Tools): string[] {
  return taggedToolNames(tools, DELEGATION_TOOL)
}

function taggedToolNames(tools: Tools, tag: string): string[] {
  return tools
    .list()
    .filter((definition) => definition.tags?.includes(tag))
    .map((definition) => definition.name)
}

/**
 * The authority a child opens under, read from the parent BEFORE the first
 * await, then narrowed by this row's own ceiling if it has one.
 *
 * Computed here, once, so the mode the parent's `subagent/start` records is the
 * mode the child actually opens under. Recording the captured parent mode and
 * stamping a narrower one would make the parent's audit line — the place a human
 * looks first — state a wider authority than was ever granted.
 */
function captureAuthority(parent: Agent, sandbox: Sandbox, ceiling: SandboxMode | undefined): { readonly mode: SandboxMode } {
  const inherited = effectiveSandboxMode(parent.session.facts) ?? sandbox.defaultMode
  return { mode: ceiling === undefined ? inherited : narrowest(inherited, ceiling) }
}

/** How the child's turn ended; a child whose log holds no turn at all is its own error. */
function finalReason(session: Session): TurnEndReason {
  return foldLastTurnEnd(session.facts) ?? { kind: 'error', code: 'NO_TURN', message: 'the subagent never ran a turn' }
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
  const inherited = captureAuthority(parent, deps.sandbox, deps.config.sandbox)
  const route = await resolveCallConfig(parent, { purpose: deps.config.purpose, signal: exec.callSignal })
  const agentOptions: AgentOptions = { ...route, maxSteps: deps.config.maxSteps }
  // The child keeps this tool only if it could still use it: at the cap it is
  // hidden AND unknown, so a depth limit is a fact about the child's world
  // rather than an error it discovers by trying.
  const childMayDelegate = depth + 1 <= deps.config.maxDepth
  const tools = deps.ctx.get(TOOLS)
  const denied = [...(childMayDelegate ? [] : delegationToolNames(tools)), ...(deps.config.toolFilter?.deny ?? [])]
  // A recall tool survives an `allow` filter, for the same reason the delegation
  // tool does when the child may still delegate: the filter says what WORK the
  // child is scoped to, and reading back its own shadowed history is not work
  // it was scoped away from — it is the child's own context. Without this, a
  // child under `allow` that compacts is handed a durable summary naming a tool
  // its schemas do not contain, and spends a step learning that.
  const restriction: ToolRestriction = {
    ...(deps.config.toolFilter?.allow === undefined
      ? {}
      : {
          allow: [
            ...deps.config.toolFilter.allow,
            ...(childMayDelegate ? [deps.toolName] : []),
            ...taggedToolNames(tools, RECALL_TOOL),
          ],
        }),
    ...(denied.length > 0 ? { deny: denied } : {}),
  }
  // The parent's WORLD — the inheritable half of what it was composed from,
  // which the registry keeps separate from the narrowing `setup` below. A child
  // is created with both; a grandchild inherits only this one, so nobody
  // re-runs a generation's authority stamps one generation late.
  const world = parent.world

  const handle = await deps.ctx.get(AGENTS).create(parent.ctx, {
    cwd: parent.session.header.cwd,
    agentOptions,
    delegatedBy: parent.id,
    delegationDepth: depth,
    ...(parent.session.header.agentPreset === undefined ? {} : { agentPreset: parent.session.header.agentPreset }),
    signal: exec.callSignal,
    // The factory runs `world` first and this second: the child's world is its
    // parent's, then narrowed — same preset, same tools minus the filter, its
    // own persona, and an authority that opens as a ceiling before a single
    // effect can run.
    ...(world === undefined ? {} : { world }),
    setup: (childCtx, child) => {
      deps.sandbox.open(child.session, { mode: inherited.mode, reason: 'delegation' })
      deps.approval.open(child.session, { policy: 'never', reason: 'delegation' })
      deps.ctx.get(TOOLS).restrict(childCtx, restriction)
      // `persona` first, because a SCOPED section shadows a same-named global
      // and the deployment persona is a global — shadowing is how this replaces
      // it, which is what the config says it does. The name is only ever taken
      // when the world above put its own persona in THIS scope (an agent preset
      // that registers one), and a duplicate registration throws; that used to
      // fail the whole delegation. Then, and only then, it composes instead:
      // its own name, ordered ahead, so the child gets both rather than none.
      if (deps.config.persona !== undefined) {
        try {
          deps.prompt.section(childCtx, { name: 'persona', order: -50, text: deps.config.persona })
        } catch {
          deps.prompt.section(childCtx, { name: 'subagent', order: -60, text: deps.config.persona })
        }
      }
    },
  })

  const child = handle.agent
  // A cancelled parent call cancels the child: its turn ends `cancelled`, its
  // log stays whole, and the tool answers with whatever it had.
  const onAbort = (): void => child.cancel({ kind: 'parent' })
  try {
    // Inside the try, because everything from here owes `handle.dispose()`: an
    // append an invariant rejected used to leave a live, published,
    // wire-addressable child behind with nothing left holding it.
    parent.session.append(SUBAGENT_START, {
      callId: exec.callId,
      childId: child.id,
      depth,
      provider: route.provider,
      model: route.model,
      sandbox: inherited.mode,
      approval: 'never',
    })
    exec.callSignal.addEventListener('abort', onAbort, { once: true })
    // `addEventListener('abort')` never fires on an ALREADY-aborted signal, and
    // two awaits stand between the tool call and here. Cancelling is not enough
    // either: `cancel` only aborts a RUNNING agent, and this child has not
    // started, so the `followup` below would start a full paid turn for a call
    // its caller had already given up on. Never start it.
    if (exec.callSignal.aborted) {
      parent.session.append(SUBAGENT_END, { callId: exec.callId, childId: child.id, reason: { kind: 'cancelled' } })
      throw Object.assign(new Error('the subagent was not started: the call was cancelled'), { code: 'ABORTED_BEFORE_DISPATCH' })
    }
    child.followup(createUserMessage(args.prompt))
    await child.whenIdle()
    // The end record is owed on EVERY exit path, exactly as the driver owes
    // `step/end`: a child whose persistence is quarantined makes this flush
    // throw, and an unpaired `subagent/start` would leave the parent's log
    // unable to explain the very failure the pair exists for.
    let lost: unknown
    try {
      await child.session.flush()
    } catch (error) {
      lost = error
    }
    const reason: TurnEndReason = lost
      ? { kind: 'error', code: 'DURABILITY_LOST', message: lost instanceof Error ? lost.message : String(lost) }
      : finalReason(child.session)
    const output = foldLastAssistantText(child.session.facts)
    const usage = childUsage(child.session)
    parent.session.append(SUBAGENT_END, { callId: exec.callId, childId: child.id, reason, ...(usage === undefined ? {} : { usage }) })
    if (reason.kind !== 'completed') {
      // Not a partial success: the parent is told the turn did not finish, and
      // still gets whatever the child managed to say.
      const detail = reason.kind === 'error' ? `${reason.kind} (${reason.code})` : reason.kind
      throw Object.assign(new Error(`the subagent's turn ended ${detail}${output.length > 0 ? `; it had said: ${output}` : ''}`), { code: 'SUBAGENT_INCOMPLETE' })
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
        purpose: config?.purpose ?? DEFAULT_PURPOSE,
        ...(config?.sandbox === undefined ? {} : { sandbox: config.sandbox }),
        ...(config?.toolFilter === undefined ? {} : { toolFilter: config.toolFilter }),
        ...(config?.persona === undefined ? {} : { persona: config.persona }),
      },
    }
    ctx.get(TOOLS).register(
      ctx,
      defineTool({
        name: toolName,
        description: config?.description ?? DESCRIPTION,
        input: InputSchema,
        output: z.object({ output: z.string(), childId: z.string() }),
        // The child owns its own clock (its turn, its tools' deadlines); a
        // registry deadline here would kill a child mid-effect and leave its
        // log open, and the caller's cancellation already reaches it.
        timeoutMs: null,
        // Not model-facing: how the depth cap recognises every delegation tool
        // in this deployment, including a second row of this same plugin.
        tags: [DELEGATION_TOOL],
        render: (_args, value) => [{ type: 'text', text: value.output.length > 0 ? value.output : '(the subagent produced no text)' }],
        execute: (args, exec) => delegate(args, exec, deps),
      }),
    )
  },
}
