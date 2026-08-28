/**
 * The coding persona and a static runtime-context prompt section (cwd,
 * platform, shell). Deliberately time-free: anything time-varying would rewrite
 * the cached system-prompt prefix every step and belongs in an `agent/pre-step`
 * message instead.
 */
import type { Context, Plugin } from '../../kernel/index.ts'
import { PROMPT } from '../../core/prompt/index.ts'
import { SANDBOX, SANDBOX_MODE, type SandboxMode } from '../../core/sandbox/index.ts'
import { matches } from '../../core/session/index.ts'
import { SHELL } from '../../core/shell/index.ts'
import type { Agent } from '../../core/agent/types.ts'

export interface ContextRuntimeConfig {
  readonly persona?: string
}

const DEFAULT_PERSONA = `You are MiniDSH, a focused local software-engineering agent.
Work directly in the user's workspace using the provided tools. Prefer small, verified steps:
inspect files before editing, make one change at a time, and run the project's tests or commands to
confirm your work. When the task is complete, stop and give a short summary of what you changed.`

/**
 * The authority the session STARTED under — its first recorded stamp, which is
 * immutable, so this section stays byte-identical for the whole session and the
 * cached prompt prefix survives a mid-session switch. A switch announces itself
 * as a durable injected message instead (see `core/sandbox`).
 */
function authorityLines(ctx: Context, agent: Agent | undefined): string[] {
  const sandbox = ctx.tryGet(SANDBOX)
  if (!sandbox) return []
  const first = agent?.session.facts.find((event) => matches(event, SANDBOX_MODE))
  const mode: SandboxMode = first ? first.data.mode : sandbox.defaultMode
  const effect =
    mode === 'read-only'
      ? 'File modifications are refused by policy; reads are unrestricted.'
      : mode === 'danger-full-access'
        ? 'File modifications are unrestricted.'
        : 'File modifications are confined to the working directory; reads are unrestricted.'
  const confinement =
    mode === 'danger-full-access'
      ? []
      : sandbox.enforcementFor(mode) === 'none'
        ? [
            '- This host cannot confine shell commands, so the shell refuses to run under this mode.',
            '  Follow the escalation guidance a refusal returns rather than working around it.',
          ]
        : []
  return [`- Sandbox: ${mode}. ${effect}`, ...confinement, '- A denial is policy, not a bug: never rewrite an action to hide its effect.']
}

export const contextRuntimePlugin: Plugin<ContextRuntimeConfig | undefined> = {
  name: 'context-runtime',
  inject: [PROMPT],
  apply(ctx, config) {
    const prompt = ctx.get(PROMPT)
    prompt.section(ctx, { name: 'persona', order: -50, text: config?.persona ?? DEFAULT_PERSONA })

    prompt.section(ctx, {
      name: 'runtime-context',
      order: 200,
      text: (agent: Agent | undefined) => {
        // Resolved at render time, not at mount time: the section must not depend on row order.
        const dialect = ctx.tryGet(SHELL)?.dialect
        const cwd = agent?.session.header.cwd ?? process.cwd()
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
  },
}
