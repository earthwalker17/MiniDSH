/**
 * The model-facing shell tool. Its name and guidance follow the mounted
 * dialect (`bash` on POSIX, `pwsh` on Windows); it runs commands in the
 * agent's persistent shell under the session sandbox policy.
 *
 * The executor never negotiates: a command it cannot confine is refused, and
 * the refusal is reported to the model as a fact plus the escalation it may
 * ask for. Escalation is the model's own move — the SAME command, retried once
 * with the narrowest wider mode and a justification — and the approval seam is
 * the consent step. A grant covers that one call and is never persisted.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { APPROVAL, type Approval } from '../../core/approval/index.ts'
import { isWider, SANDBOX, SANDBOX_MODES, SandboxError, type Sandbox, type SandboxExecutionPolicy, type SandboxMode } from '../../core/sandbox/index.ts'
import { SHELL } from '../../core/shell/index.ts'
import { excerptWithSpill, excerptWithoutSpill, SPILL } from '../../core/spill/index.ts'
import { defineTool, TOOLS, type ToolCallView, type ToolContext } from '../../core/tools/index.ts'

export interface ShellToolConfig {
  readonly timeoutMs?: number | undefined
  /** How much of a command's output the MODEL sees inline; the rest spills. */
  readonly maxOutputChars?: number | undefined
  /** Kept from the end, because a command's last lines are how it ended. */
  readonly tailChars?: number | undefined
}

const configSchema = z
  .strictObject({
    timeoutMs: z.number().positive().optional(),
    maxOutputChars: z.number().int().positive().optional(),
    tailChars: z.number().int().nonnegative().optional(),
  })
  .optional()

const CONFINEMENT_GUIDANCE = `* Commands run under this session's sandbox policy. A command that cannot be confined on this host is REFUSED and the result says so.
* To run a refused command anyway, retry THE SAME command once with sandbox_permissions (the narrowest wider mode that suffices) and justification (why it is required). The user is asked to approve, and a grant covers that one call only.
* Never work around a denial by rewriting the command to hide its effect.`

const BASH_DESCRIPTION = `Run a command in a persistent bash shell.
* State (working directory, environment) persists across calls.
* Combine multiple steps with && or ; in one call.
* Avoid commands that never terminate. Output too long to show inline is shortened to its head and tail; the result says how much was omitted and, when it was saved, the file to read it from.
${CONFINEMENT_GUIDANCE}`

const PWSH_DESCRIPTION = `Run a command in a persistent PowerShell (pwsh) shell.
* State (working directory, environment) persists across calls.
* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.
* Combine multiple steps with ; in one call.
* Avoid commands that never terminate. Output too long to show inline is shortened to its head and tail; the result says how much was omitted and, when it was saved, the file to read it from.
${CONFINEMENT_GUIDANCE}`

const InputSchema = z
  .object({
    command: z.string(),
    sandbox_permissions: z
      .enum(['workspace-write', 'danger-full-access'])
      .optional()
      .describe('Request a wider sandbox mode for this one command. Requires justification and the user approval.'),
    justification: z.string().optional().describe('Why this command needs the wider mode. Requires sandbox_permissions.'),
  })
  // On the schema, not in the body: an argument mistake must read as an argument
  // mistake (INVALID_ARGS), the way every other one does.
  .superRefine((value, ctx) => {
    if ((value.sandbox_permissions === undefined) !== (value.justification === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'sandbox_permissions and justification must be given together' })
    }
  })
type Input = z.infer<typeof InputSchema>

export const toolShellPlugin: Plugin<ShellToolConfig | undefined> = {
  name: 'tool-shell',
  inject: [TOOLS, SHELL, SANDBOX, APPROVAL],
  config: configSchema,
  apply(ctx, config) {
    ctx.get(TOOLS).register(
      ctx,
      buildShellTool(ctx, config?.timeoutMs ?? 120_000, { headChars: config?.maxOutputChars ?? 16_000, tailChars: config?.tailChars ?? 2_000 }),
    )
  },
}

function buildShellTool(ctx: Context, timeoutMs: number, excerpt: { headChars: number; tailChars: number }) {
  const shell = ctx.get(SHELL)
  const sandbox = ctx.get(SANDBOX)
  const approval = ctx.get(APPROVAL)
  const name = shell.dialect === 'pwsh' ? 'pwsh' : 'bash'
  return defineTool({
    name,
    description: shell.dialect === 'pwsh' ? PWSH_DESCRIPTION : BASH_DESCRIPTION,
    input: InputSchema,
    output: z.object({ output: z.string(), exitCode: z.number().nullable() }),
    // The executor owns the deadline outright: it kills the child and returns
    // the partial output. No registry backstop, because the registry clock
    // would also tick while a person deliberated over this body's escalation
    // consent — and a grant landing after TOOL_TIMEOUT ran the command on a
    // call the model had already been told was over.
    timeoutMs: null,
    presentCall: (args): ToolCallView => ({ card: 'terminal', title: args.command }),
    render: (_args, value) => {
      const suffix = value.exitCode !== null && value.exitCode !== 0 ? `\n[exit code: ${value.exitCode}]` : ''
      return [{ type: 'text', text: (value.output.length > 0 ? value.output : '(no output)') + suffix }]
    },
    execute: async (args: Input, exec) => {
      const agent = exec.agent
      if (!agent) throw new Error('the shell tool requires an owning agent')
      const policy = await resolvePolicy(args, agent, exec, { sandbox, approval, toolName: name })
      const shellSession = shell.sessionFor(agent)
      try {
        const result = await shellSession.exec({ command: args.command, policy, timeoutMs, signal: exec.signal })
        // "Nothing ran" must never read as "ran and printed nothing".
        if (result.aborted) throw Object.assign(new Error('command not dispatched: the call was cancelled'), { code: 'ABORTED_BEFORE_DISPATCH' })
        const notice = result.timedOut ? `\n[timed out after ${timeoutMs}ms; the shell was reset]` : ''
        // The tool owns what the model sees. A command's stdout exists nowhere
        // once the process exits, so output too large to show inline is SAVED
        // and located rather than thrown away — through a store the composition
        // may or may not have mounted, hence `tryGet`.
        return { output: bound(ctx, exec, result.output + notice, excerpt), exitCode: result.exitCode ?? null }
      } catch (error) {
        if (error instanceof SandboxError && error.code === 'SANDBOX_UNAVAILABLE') {
          // A reported fact, not a failure: the command never ran, and the model
          // is told the one legitimate way to ask for more.
          return { output: refusal(sandbox, policy, error.message), exitCode: null }
        }
        throw error
      }
    },
  })
}

/** Full output when it fits; otherwise a head/tail excerpt plus wherever the rest went. */
function bound(ctx: Context, exec: ToolContext, text: string, options: { headChars: number; tailChars: number }): string {
  // `length` counts UTF-16 units and is therefore never LESS than the code-point
  // count, so this settles the common case without materializing the string.
  if (text.length <= options.headChars + options.tailChars) return text
  const spill = ctx.tryGet(SPILL)
  const sessionId = exec.agent?.session.id
  if (!spill || !sessionId) return excerptWithoutSpill(text, options)
  try {
    return excerptWithSpill(text, spill.save({ sessionId, callId: exec.callId, label: 'shell', text }), options)
  } catch {
    // A store that cannot write must not fail the command that succeeded.
    return excerptWithoutSpill(text, options)
  }
}

interface Escalation {
  readonly sandbox: Sandbox
  readonly approval: Approval
  readonly toolName: string
}

/** The base policy, or an approved one-shot escalation of it. */
async function resolvePolicy(args: Input, agent: Agent, exec: ToolContext, deps: Escalation): Promise<SandboxExecutionPolicy> {
  const session = agent.session
  const base = deps.sandbox.resolve({ session })
  const target = args.sandbox_permissions
  if (target === undefined) return base
  if (!isWider(target, base.mode)) {
    throw new SandboxError('SANDBOX_NOT_WIDER', `escalation to "${target}" is not wider than this call's "${base.mode}" mode`)
  }
  // Never spend someone's consent on a mode that still could not run: a grant
  // this host cannot honour would be refused anyway, one ask later.
  if (!viableEscalations(deps.sandbox, base.mode).includes(target)) {
    throw new SandboxError('SANDBOX_UNAVAILABLE', `"${target}" cannot be confined on this host either, so escalating to it would not let the command run`)
  }
  const outcome = await deps.approval.request({
    agent,
    toolName: deps.toolName,
    callId: exec.callId,
    reason: `run under "${target}": ${args.justification}`,
    // The caller's signal, not the body's: a person deciding must not be racing
    // this call's deadline.
    signal: exec.callSignal,
  })
  if (outcome !== 'allowed-once') {
    // One ask per escalation: a refused command is finished, not re-asked.
    throw new SandboxError('SANDBOX_ESCALATION_DENIED', `escalation to "${target}" was ${outcome}; the command did not run`)
  }
  return deps.sandbox.resolve({ session, mode: target })
}

/** The wider modes this host could actually run under — the only ones worth asking for. */
function viableEscalations(sandbox: Sandbox, base: SandboxMode): SandboxMode[] {
  return SANDBOX_MODES.filter((mode) => isWider(mode, base) && (mode === 'danger-full-access' || sandbox.enforcementFor(mode) !== 'none'))
}

function refusal(sandbox: Sandbox, policy: SandboxExecutionPolicy, reason: string): string {
  const viable = viableEscalations(sandbox, policy.mode)
  if (viable.length === 0) return `[sandbox: ${reason}]`
  return (
    `[sandbox: ${reason}]\n` +
    `[escalation available — retry this exact command once with sandbox_permissions (the narrowest of ${viable.map((mode) => `"${mode}"`).join(', ')} that suffices) ` +
    `and justification; the user is asked to approve]`
  )
}
