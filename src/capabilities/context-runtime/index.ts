/**
 * The coding persona and a static runtime-context prompt section (cwd,
 * platform, shell). Deliberately time-free: anything time-varying would rewrite
 * the cached system-prompt prefix every step and belongs in an `agent/pre-step`
 * message instead.
 */
import type { Plugin } from '../../kernel/index.ts'
import { PROMPT } from '../../core/prompt/index.ts'
import { SHELL } from '../../core/shell/index.ts'
import type { Agent } from '../../core/agent/types.ts'

export interface ContextRuntimeConfig {
  readonly persona?: string
}

const DEFAULT_PERSONA = `You are MiniDSH, a focused local software-engineering agent.
Work directly in the user's workspace using the provided tools. Prefer small, verified steps:
inspect files before editing, make one change at a time, and run the project's tests or commands to
confirm your work. When the task is complete, stop and give a short summary of what you changed.`

export const contextRuntimePlugin: Plugin<ContextRuntimeConfig | undefined> = {
  name: 'context-runtime',
  inject: [PROMPT],
  apply(ctx, config) {
    const prompt = ctx.get(PROMPT)
    prompt.section(ctx, { name: 'persona', order: -50, text: config?.persona ?? DEFAULT_PERSONA })

    const dialect = ctx.tryGet(SHELL)?.dialect
    prompt.section(ctx, {
      name: 'runtime-context',
      order: 200,
      text: (agent: Agent | undefined) => {
        const cwd = agent?.session.header.cwd ?? process.cwd()
        const lines = [
          'Runtime context (stable for this session):',
          `- Working directory: ${cwd}`,
          `- Platform: ${process.platform}`,
          ...(dialect ? [`- Shell: ${dialect}`] : []),
          '- File edits are confined to the working directory.',
        ]
        return lines.join('\n')
      },
    })
  },
}
