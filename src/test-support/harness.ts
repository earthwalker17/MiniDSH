/**
 * A real core composition for tests: every core plugin mounted through the
 * kernel, with only the LLM adapter scripted. Invariants are on. This is the
 * "real entry path" — no hand-wired service mocks.
 *
 * **The tripwire.** "Invariants are on" used to mean only that a violation
 * was RAISED. Inside a turn the driver catches it and writes `turn/end{error}`;
 * past the turn boundary it goes to the logger, which this harness silences;
 * inside a tool body it becomes that call's error result. A test that awaited
 * `whenIdle()` and asserted on something earlier stayed green through all
 * three. So every violation the composition swallows that way is kept, and
 * `dispose()` throws them: the test that caused one fails, and says which. A
 * violation thrown straight back at the test's own call (an `append` the test
 * expects to throw) was never swallowed and is not counted. A test that
 * provokes a swallowed one on purpose says so with `expectViolations()`.
 */
import { createRoot, type Context, type Logger, type PluginHandle } from '../kernel/index.ts'
import { AGENT_ERROR, AGENTS, type AgentHandle, type AgentOptions } from '../core/agent/index.ts'
import { approvalPlugin } from '../core/approval/index.ts'
import { InvariantError, invariantsPlugin } from '../core/invariants/index.ts'
import { LLM, llmPlugin } from '../core/llm/index.ts'
import { PROMPT, promptPlugin } from '../core/prompt/index.ts'
import { jobsPlugin, type JobsConfig } from '../core/jobs/index.ts'
import { jobsInvariantPlugin } from '../core/jobs/invariant.ts'
import { sandboxPlugin, type SandboxConfig } from '../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../core/sandbox/invariant.ts'
import { matches, SESSION_EVENT, sessionInvariantPlugin, sessionPlugin, TOOL_RESULT } from '../core/session/index.ts'
import { toolsPlugin, type ToolsConfig } from '../core/tools/index.ts'
import { agentPlugin } from '../core/agent/index.ts'
import { agentInvariantPlugin } from '../core/agent/invariant.ts'
import { loopInvariantPlugin, loopPlugin, type LoopConfig } from '../core/loop/index.ts'
import { ScriptedAdapter } from './scripted-adapter.ts'

const silentLogger: Logger = { warn: () => {}, error: () => {} }

export interface CoreHarness {
  readonly root: Context
  readonly adapter: ScriptedAdapter
  /** The loop plugin's handle, so tests can unload the driver under live agents. */
  readonly loop: PluginHandle
  create(options?: Partial<AgentOptions> & { cwd?: string }): Promise<AgentHandle>
  /**
   * Takes the runtime-invariant violations the composition has swallowed so
   * far, each as where it went and what it said, so they no longer fail
   * `dispose()`. For a test that provokes one on purpose: it asserts on what
   * comes back, and any violation it did not expect (one raised later) still fails.
   */
  expectViolations(): string[]
  /** Disposes every agent and the root, then throws if a swallowed violation was never expected (the tripwire). */
  dispose(): Promise<void>
}

export async function coreHarness(
  options: { persona?: string; logger?: Logger; tools?: ToolsConfig; sandbox?: SandboxConfig; jobs?: JobsConfig; loop?: LoopConfig } = {},
): Promise<CoreHarness> {
  // The three places a violation goes when no caller is there to receive the
  // throw. The same error can reach two of them (the driver reports an escaped
  // one to `agent/error` and to the logger), so it is counted once.
  const swallowed: string[] = []
  const seen = new Set<unknown>()
  const note = (where: string, error: unknown): void => {
    if (!(error instanceof InvariantError) || seen.has(error)) return
    seen.add(error)
    swallowed.push(`${where}: ${error.message}`)
  }
  const inner = options.logger ?? silentLogger
  const logger: Logger = {
    warn: (message, detail) => inner.warn(message, detail),
    error: (message, detail) => {
      note(`logged (${message})`, detail)
      inner.error(message, detail)
    },
  }
  const root = createRoot({ logger })
  root.on(AGENT_ERROR, (agent, error) => note(`failed a turn of ${agent.id}`, error))
  root.on(SESSION_EVENT, (session, event) => {
    // A violation raised under a tool body is answered as that call's error: only the record of it is left.
    if (matches(event, TOOL_RESULT) && event.data.error?.name === 'InvariantError') {
      const block = event.data.message.content[0]
      const said = block?.type === 'tool-result' ? block.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
      swallowed.push(`answered call ${event.data.callId} of ${session.id}: ${said}`)
    }
  })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin, options.tools ?? {})
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(sandboxPlugin, options.sandbox ?? {})
  root.plugin(authorityInvariantPlugin)
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(jobsPlugin, options.jobs ?? {})
  root.plugin(jobsInvariantPlugin)
  const loop = root.plugin(loopPlugin, options.loop)
  root.plugin(loopInvariantPlugin)
  await root.settle()

  const adapter = new ScriptedAdapter()
  root.get(LLM).registerAdapter(root, adapter)
  root.get(PROMPT).section(root, { name: 'persona', order: 0, text: options.persona ?? 'You are a test agent.' })

  const handles: AgentHandle[] = []
  return {
    root,
    adapter,
    loop,
    async create(over = {}) {
      const agentOptions: AgentOptions = {
        provider: 'scripted',
        model: 'scripted-model',
        ...(over.maxSteps === undefined ? {} : { maxSteps: over.maxSteps }),
        ...(over.maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls: over.maxParallelToolCalls }),
        ...(over.reasoningEffort === undefined ? {} : { reasoningEffort: over.reasoningEffort }),
      }
      const handle = await root.get(AGENTS).create(root, { cwd: over.cwd ?? process.cwd(), agentOptions })
      handles.push(handle)
      return handle
    },
    expectViolations() {
      return swallowed.splice(0)
    },
    async dispose() {
      for (const handle of handles.toReversed()) await handle.dispose()
      await root.dispose()
      // After the disposal, which can raise one itself (closing an open step),
      // and taken as it is thrown: a second dispose of this harness says nothing.
      const unexpected = swallowed.splice(0)
      if (unexpected.length > 0) {
        throw new Error(
          `coreHarness: ${unexpected.length} runtime-invariant violation(s) were raised where no test saw them (a failed turn, a logged error, a tool's error result):\n  ${unexpected.join('\n  ')}\n` +
            'A test that provokes one on purpose claims it with harness.expectViolations().',
        )
      }
    },
  }
}
