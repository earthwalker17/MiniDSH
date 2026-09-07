/**
 * The coding persona, the runtime-context prompt section, and every model-facing
 * sentence about this session's authority.
 *
 * Prose about authority lives HERE, not in the services that own the knobs.
 * `core/sandbox` records a switch; what a model is TOLD about one is a question
 * about context, and answering it inside the service meant a core seam
 * composing English and reaching for `ctx.agents` to deliver it. The services
 * now publish the fact and this capability reads it — the same split DSH draws,
 * where the sandbox and approval packages contribute to a runtime-context
 * snapshot instead of writing prompt text of their own.
 *
 * The section is deliberately time-free: anything time-varying would rewrite the
 * cached system-prompt prefix every step and belongs in a message instead. Two
 * rules keep it byte-stable for a whole lifecycle, which is what the prefix
 * cache is keyed on, without letting it be wrong:
 *
 *   - it states the stamp this LIFECYCLE opened under rather than the log's
 *     first, so a session resumed after a switch to `read-only` is no longer
 *     told it is `workspace-write`;
 *   - `enforcement` comes off that same stamp instead of asking the mounted
 *     shell at every assemble, so the section is a fold of the log and nothing
 *     outside it — a shell row swapped under a live agent — can rewrite the
 *     cached prefix.
 *
 * A switch announces itself as a durable injected message instead, written from
 * here for the same reason the section is.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENTS, type Agent } from '../../core/agent/index.ts'
import { APPROVAL, APPROVAL_POLICY, openingApprovalPolicy, type ApprovalPolicy } from '../../core/approval/index.ts'
import { createPluginMessage } from '../../core/llm/message.ts'
import { PROMPT } from '../../core/prompt/index.ts'
import { openingSandboxStamp, SANDBOX, SANDBOX_MODE, type SandboxEnforcement, type SandboxMode } from '../../core/sandbox/index.ts'
import { canonicalPath } from '../../core/sandbox/paths.ts'
import type { SessionId } from '../../core/ids.ts'
import { matches, SESSION_EVENT, type Session } from '../../core/session/index.ts'
import { SHELL } from '../../core/shell/index.ts'

export interface ContextRuntimeConfig {
  readonly persona?: string | undefined
}

const configSchema = z.strictObject({ persona: z.string().optional() }).optional()

const PLUGIN = 'context-runtime'

const DEFAULT_PERSONA = `You are MiniDSH, a focused local software-engineering agent.
Work directly in the user's workspace using the provided tools. Prefer small, verified steps:
inspect files before editing, make one change at a time, and run the project's tests or commands to
confirm your work. When the task is complete, stop and give a short summary of what you changed.`

/** What a mode means for file effects. One spelling, shared by the section and the switch note. */
/**
 * The workspace root as the SANDBOX means it, which is the canonical spelling.
 *
 * The fence, the shell child's cwd and every denial message name
 * `canonicalPath(header.cwd)`; the raw header spelling is only what the session
 * was created with. On a host where that path runs through a symlink — macOS
 * `/tmp` -> `/private/tmp` is the ordinary case, and every temp workspace sits
 * under it — the model was told one directory and shown another by the first
 * refusal it read. A path this host will not resolve keeps its spelling: a
 * prompt render may not throw.
 */
function statedRoot(cwd: string): string {
  try {
    return canonicalPath(cwd)
  } catch {
    return cwd
  }
}

function modeEffect(mode: SandboxMode, workspaceRoot: string | undefined): string {
  if (mode === 'read-only') return 'File modifications are refused by policy; reads are unrestricted.'
  if (mode === 'danger-full-access') return 'File modifications are unrestricted.'
  return workspaceRoot === undefined
    ? 'File modifications are confined to the working directory; reads are unrestricted.'
    : `File modifications are confined to ${workspaceRoot}; reads are unrestricted.`
}

/**
 * What the recorded `enforcement` means for a shell command, in the model's
 * terms. Three answers, because they are three different worlds:
 *
 *   `none`    the shell REFUSES a confined command before running it, and the
 *             refusal carries the escalation;
 *   `full`    the command runs and the operating system refuses the write —
 *             which reads like an ordinary command failure unless it is said;
 *   `partial` the same, minus the promise that every effect is governed. No
 *             backend reports it today; the vocabulary carries it because a
 *             caller needing an absolute boundary must not read it as `full`.
 */
function confinementLines(enforcement: SandboxEnforcement): string[] {
  if (enforcement === 'none') {
    return [
      '- This host cannot confine shell commands, so the shell refuses to run under this mode.',
      '  Follow the escalation guidance a refusal returns rather than working around it.',
    ]
  }
  const governed = enforcement === 'full' ? 'enforces this mode' : 'enforces this mode only partially'
  return [
    `- Shell commands run inside an OS sandbox that ${governed}: a file write outside the sandbox fails`,
    '  because the operating system refused it, not because a tool did. Follow the escalation guidance rather than working around it.',
  ]
}

/** What a policy means for an action that needs consent. One spelling, shared the same way. */
function policyEffect(policy: ApprovalPolicy): string {
  return policy === 'ask'
    ? 'An action outside the sandbox needs an approval before it runs; a request that is refused, or that nobody answers, means the action did not run.'
    : 'Nothing is put to the user; an action that would need approval is refused.'
}

/**
 * The authority this LIFECYCLE opened under, read from the log.
 *
 * Both halves come off one recorded stamp. The mode used to be the log's first
 * and the enforcement a live question to the mounted shell, which made one
 * sentence out of two sources that can disagree — and made a resumed session
 * describe the session it was resumed from.
 */
function authorityLines(ctx: Context, agent: Agent | undefined): string[] {
  const sandbox = ctx.tryGet(SANDBOX)
  if (!sandbox) return []
  const stamp = agent ? openingSandboxStamp(agent.session.facts, agent.session.liveStart) : undefined
  const mode: SandboxMode = stamp?.mode ?? sandbox.defaultMode
  // An agent with no stamp at all was not created through the registry; there is
  // nothing recorded to read, so the live world is the only honest answer.
  const enforcement: SandboxEnforcement = stamp?.enforcement ?? sandbox.enforcementFor(mode)
  const confinement = mode === 'danger-full-access' ? [] : confinementLines(enforcement)
  return [
    `- Sandbox: ${mode}. ${modeEffect(mode, undefined)}`,
    ...confinement,
    ...approvalLines(ctx, agent),
    '- A denial is policy, not a bug: never rewrite an action to hide its effect.',
  ]
}

/** The approval policy this lifecycle opened under — and, for a delegated child, what that means. */
function approvalLines(ctx: Context, agent: Agent | undefined): string[] {
  const approval = ctx.tryGet(APPROVAL)
  if (!approval) return []
  const policy = (agent ? openingApprovalPolicy(agent.session.facts, agent.session.liveStart) : undefined) ?? approval.defaultPolicy
  // Under `ask` the line promises an approval step, not a person: a headless
  // run has no answerer, and there every request settles `unavailable`. The
  // prefix is pinned by a test and byte-stable; the clause after it says what
  // every composition can actually deliver.
  const lines = [`- Approvals: ${policy}. ${policyEffect(policy)}`]
  if (agent?.session.header.delegatedBy !== undefined) {
    lines.push(
      '- You are a delegated subagent. Your authority was fixed when you were started and cannot be widened from inside this session:',
      '  an action that would need approval is refused automatically. When the task needs access beyond that, do not retry the refused action —',
      '  finish what you can and state the limitation in your reply, so the delegating agent can handle it.',
    )
  }
  return lines
}

/**
 * Announces an authority switch to the model as a durable message.
 *
 * Drained on a microtask rather than inside the `session/event` listener,
 * because an inject APPENDS (`inbox/spliced`) and a nested append during an
 * event's delivery overtakes the event that caused it: `persistence-jsonl`
 * writes lines in delivery order, and the relational invariant stages its trace
 * across the observer/listener pair. The microtask still runs before the caller
 * of `setMode`/`setPolicy` resumes, so the note reaches the same step it always
 * did. Draining per agent also means one note for a preset switch, which moves
 * both knobs at once.
 */
class SwitchNotes {
  private readonly ctx: Context
  private readonly pending = new Map<SessionId, { session: Session; sandbox?: SandboxMode; approval?: ApprovalPolicy }>()
  private scheduled = false

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  note(session: Session, change: { sandbox?: SandboxMode; approval?: ApprovalPolicy }): void {
    this.pending.set(session.id, { ...(this.pending.get(session.id) ?? { session }), ...change })
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => this.drain())
  }

  private drain(): void {
    this.scheduled = false
    const agents = this.ctx.tryGet(AGENTS)
    try {
      for (const [id, change] of this.pending) {
        const agent = agents?.get(id)
        if (!agent) continue
        const lines: string[] = []
        if (change.sandbox !== undefined) {
          lines.push(`Sandbox mode is now "${change.sandbox}". ${modeEffect(change.sandbox, statedRoot(change.session.header.cwd))}`)
        }
        if (change.approval !== undefined) lines.push(`Approvals are now "${change.approval}". ${policyEffect(change.approval)}`)
        // Each agent on its own: an inject that throws (an invariant rejecting
        // the splice, a session whose store is gone) must not cost every other
        // agent its note, and must not escape into the microtask queue, where an
        // uncaught exception is the process rather than one lost message.
        if (lines.length > 0) {
          try {
            agent.inject(createPluginMessage(PLUGIN, lines.join('\n')))
          } catch {
            // The switch is recorded either way; the note is the only casualty.
          }
        }
      }
    } finally {
      // Cleared whatever happened: a pending entry that survived a throw would
      // be re-announced by the next switch, telling the model about a change it
      // was already told about.
      this.pending.clear()
    }
  }
}

export const contextRuntimePlugin: Plugin<ContextRuntimeConfig | undefined> = {
  name: PLUGIN,
  inject: [PROMPT],
  config: configSchema,
  apply(ctx, config) {
    const prompt = ctx.get(PROMPT)
    prompt.section(ctx, { name: 'persona', order: -50, text: config?.persona ?? DEFAULT_PERSONA })

    prompt.section(ctx, {
      name: 'runtime-context',
      order: 200,
      text: (agent: Agent | undefined) => {
        // Resolved at render time, not at mount time: the section must not depend on row order.
        const dialect = ctx.tryGet(SHELL)?.dialect
        const cwd = statedRoot(agent?.session.header.cwd ?? process.cwd())
        const lines = [
          'Runtime context (stable for this session):',
          `- Working directory: ${cwd}`,
          `- Platform: ${process.platform}`,
          ...(dialect ? [`- Shell: ${dialect}`] : []),
          ...authorityLines(ctx, agent),
        ]
        return lines.join('\n')
      },
    })

    const notes = new SwitchNotes(ctx)
    ctx.on(SESSION_EVENT, (session, event) => {
      if (matches(event, SANDBOX_MODE)) {
        if (event.data.reason === 'change') notes.note(session, { sandbox: event.data.mode })
      } else if (matches(event, APPROVAL_POLICY) && event.data.reason === 'change') {
        notes.note(session, { approval: event.data.policy })
      }
    })
  },
}
