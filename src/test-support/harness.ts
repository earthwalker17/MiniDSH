/**
 * A real core composition for tests: every core plugin mounted through the
 * kernel, with only the LLM adapter scripted. Invariants are on. This is the
 * "real entry path" — no hand-wired service mocks.
 */
import { createRoot, type Context, type Logger } from '../kernel/index.ts'
import { AGENTS, type AgentHandle, type AgentOptions } from '../core/agent/index.ts'
import { approvalPlugin } from '../core/approval/index.ts'
import { invariantsPlugin } from '../core/invariants/index.ts'
import { LLM, llmPlugin } from '../core/llm/index.ts'
import { PROMPT, promptPlugin } from '../core/prompt/index.ts'
import { sessionInvariantPlugin, sessionPlugin } from '../core/session/index.ts'
import { toolsPlugin } from '../core/tools/index.ts'
import { agentPlugin } from '../core/agent/index.ts'
import { agentInvariantPlugin } from '../core/agent/invariant.ts'
import { loopInvariantPlugin, loopPlugin } from '../core/loop/index.ts'
import { ScriptedAdapter } from './scripted-adapter.ts'

const silentLogger: Logger = { warn: () => {}, error: () => {} }

export interface CoreHarness {
  readonly root: Context
  readonly adapter: ScriptedAdapter
  create(options?: Partial<AgentOptions> & { cwd?: string }): Promise<AgentHandle>
  dispose(): Promise<void>
}

export async function coreHarness(options: { persona?: string; logger?: Logger } = {}): Promise<CoreHarness> {
  const root = createRoot({ logger: options.logger ?? silentLogger })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin)
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(loopPlugin)
  root.plugin(loopInvariantPlugin)
  await root.settle()

  const adapter = new ScriptedAdapter()
  root.get(LLM).registerAdapter(root, adapter)
  root.get(PROMPT).section(root, { name: 'persona', order: 0, text: options.persona ?? 'You are a test agent.' })

  const handles: AgentHandle[] = []
  return {
    root,
    adapter,
    async create(over = {}) {
      const agentOptions: AgentOptions = {
        provider: 'scripted',
        model: 'scripted-model',
        ...(over.maxSteps === undefined ? {} : { maxSteps: over.maxSteps }),
        ...(over.reasoningEffort === undefined ? {} : { reasoningEffort: over.reasoningEffort }),
      }
      const handle = await root.get(AGENTS).create(root, { cwd: over.cwd ?? process.cwd(), agentOptions })
      handles.push(handle)
      return handle
    },
    async dispose() {
      for (const handle of handles.toReversed()) await handle.dispose()
      await root.dispose()
    },
  }
}
