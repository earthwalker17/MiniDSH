/**
 * The model-facing shell tool. Its name and guidance follow the mounted
 * dialect (`bash` on POSIX, `pwsh` on Windows); it runs commands in the
 * agent's persistent shell.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { SANDBOX, SandboxError } from '../../core/sandbox/index.ts'
import { SHELL } from '../../core/shell/index.ts'
import { defineTool, TOOLS, type ToolCallView } from '../../core/tools/index.ts'

export interface ShellToolConfig {
  readonly timeoutMs?: number
}

const BASH_DESCRIPTION = `Run a command in a persistent bash shell.
* State (working directory, environment) persists across calls.
* Combine multiple steps with && or ; in one call.
* Avoid commands that never terminate; long output is truncated.`

const PWSH_DESCRIPTION = `Run a command in a persistent PowerShell (pwsh) shell.
* State (working directory, environment) persists across calls.
* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.
* Combine multiple steps with ; in one call.
* Avoid commands that never terminate; long output is truncated.`

export const toolShellPlugin: Plugin<ShellToolConfig | undefined> = {
  name: 'tool-shell',
  inject: [TOOLS, SHELL, SANDBOX],
  apply(ctx, config) {
    ctx.get(TOOLS).register(ctx, buildShellTool(ctx, config?.timeoutMs ?? 300_000))
  },
}

function buildShellTool(ctx: Context, timeoutMs: number) {
  const shell = ctx.get(SHELL)
  const sandbox = ctx.get(SANDBOX)
  const name = shell.dialect === 'pwsh' ? 'pwsh' : 'bash'
  return defineTool({
    name,
    description: shell.dialect === 'pwsh' ? PWSH_DESCRIPTION : BASH_DESCRIPTION,
    input: z.object({ command: z.string() }),
    output: z.object({ output: z.string(), exitCode: z.number().nullable() }),
    presentCall: (args): ToolCallView => ({ card: 'terminal', title: args.command }),
    render: (_args, value) => {
      const suffix = value.exitCode !== null && value.exitCode !== 0 ? `\n[exit code: ${value.exitCode}]` : ''
      return [{ type: 'text', text: (value.output.length > 0 ? value.output : '(no output)') + suffix }]
    },
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('the shell tool requires an owning agent')
      const policy = sandbox.resolve({ session: exec.agent.session })
      const shellSession = shell.sessionFor(exec.agent)
      let result
      try {
        result = await shellSession.exec({ command: args.command, policy, timeoutMs, signal: exec.signal })
      } catch (error) {
        if (error instanceof SandboxError && error.code === 'SANDBOX_UNAVAILABLE') {
          return { output: `[sandbox: ${error.message}]`, exitCode: null }
        }
        throw error
      }
      const notice = result.timedOut ? `\n[timed out after ${timeoutMs}ms; the shell was reset]` : ''
      return { output: result.output + notice, exitCode: result.exitCode ?? null }
    },
  })
}
