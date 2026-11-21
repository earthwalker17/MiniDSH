/**
 * The DEFAULT summary request against every model the three adapters
 * catalogue, at every effort each one offers.
 *
 * Compaction sends an explicit output cap of its own. An adapter refuses,
 * before any I/O, an option pair it cannot serve, and a refused summary is a
 * failed one: two of them end automatic compaction for the session and the
 * overflow recovery with it. So "the default composition can compact" is a
 * claim about every (row, effort) pair, and this asks each adapter about each.
 *
 * Real engine, real adapters: the session runs on the catalogued route, the
 * summary request is the one `compaction-basic` built, and the verdict is the
 * adapter's own `validateOptions`. Only the model's answers are scripted, at
 * `llm/stream`, so nothing here opens a socket.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { AGENT_REQUEST, AGENTS, agentPlugin, type AgentHandle, type AgentOptions } from '../../core/agent/index.ts'
import { agentInvariantPlugin } from '../../core/agent/invariant.ts'
import { approvalPlugin } from '../../core/approval/index.ts'
import { COMPACTION } from '../../core/compaction/index.ts'
import { invariantsPlugin } from '../../core/invariants/index.ts'
import { LLM, LLM_STREAM, llmPlugin, type LlmAdapter, type LlmRequest, type StreamChunk } from '../../core/llm/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { loopInvariantPlugin, loopPlugin } from '../../core/loop/index.ts'
import { PROMPT, promptPlugin } from '../../core/prompt/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../../core/sandbox/invariant.ts'
import { sessionInvariantPlugin, sessionPlugin } from '../../core/session/index.ts'
import { toolsPlugin } from '../../core/tools/index.ts'
import { assistantText } from '../../test-support/scripted-adapter.ts'
import { AnthropicAdapter, DEFAULT_MAX_TOKENS as ANTHROPIC_MAX_TOKENS } from '../llm-anthropic/adapter.ts'
import { DeepSeekAdapter, DEFAULT_MAX_TOKENS as DEEPSEEK_MAX_TOKENS } from '../llm-deepseek/adapter.ts'
import { OpenAIAdapter, DEFAULT_MAX_TOKENS as OPENAI_MAX_TOKENS } from '../llm-openai/adapter.ts'
import { compactionBasicPlugin, type CompactionBasicConfig } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

/** An adapter that can say, without I/O, whether it would serve a request. */
type ValidatingAdapter = LlmAdapter & { validateOptions(request: LlmRequest): void }

/** The three shipped adapters at their rows' defaults; the key and the endpoint are never reached. */
function shippedAdapters(): ValidatingAdapter[] {
  const wire = { apiKeyRef: 'UNUSED', resolveKey: () => undefined, baseURL: 'http://127.0.0.1:1' }
  return [
    new DeepSeekAdapter({ ...wire, defaultMaxTokens: DEEPSEEK_MAX_TOKENS }),
    new AnthropicAdapter({ ...wire, defaultMaxTokens: ANTHROPIC_MAX_TOKENS }),
    new OpenAIAdapter({ ...wire, defaultMaxTokens: OPENAI_MAX_TOKENS }),
  ]
}

interface Mounted {
  readonly root: Context
  readonly adapters: readonly ValidatingAdapter[]
  /** Every summary request the engine built, in order. */
  readonly summaries: LlmRequest[]
  create(options: AgentOptions): Promise<AgentHandle>
}

let mounted: (Mounted & { dispose(): Promise<void> }) | undefined
afterEach(async () => {
  await mounted?.dispose()
  mounted = undefined
})

/** The default composition's compaction row (`{}`) unless a test names another. */
async function mount(config: CompactionBasicConfig = {}): Promise<Mounted> {
  const root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin, {})
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(sandboxPlugin, {})
  root.plugin(authorityInvariantPlugin)
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(loopPlugin)
  root.plugin(loopInvariantPlugin)
  root.plugin(compactionBasicPlugin, config)
  await root.settle()
  const adapters = shippedAdapters()
  for (const adapter of adapters) root.get(LLM).registerAdapter(root, adapter)
  root.get(PROMPT).section(root, { name: 'persona', order: 0, text: 'You are a test agent.' })
  const summaries: LlmRequest[] = []
  // The model, scripted where the replay harness scripts it: a step gets a
  // bulky reply, a summary request is kept for the adapter to judge.
  root.on(LLM_STREAM, (request) => {
    if (request.purpose === 'compaction') {
      summaries.push(request)
      return chunks(assistantText('## Primary Request\n- keep going'))
    }
    return chunks(assistantText(`reply ${'y'.repeat(320)}`, { inputTokens: 400, outputTokens: 6 }))
  })
  const handles: AgentHandle[] = []
  mounted = {
    root,
    adapters,
    summaries,
    async create(agentOptions) {
      const handle = await root.get(AGENTS).create(root, { cwd: process.cwd(), agentOptions })
      handles.push(handle)
      return handle
    },
    async dispose() {
      for (const handle of handles.toReversed()) await handle.dispose()
      await root.dispose()
    },
  }
  return mounted
}

async function* chunks(script: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* script
}

/** Grows a session on `options` and compacts it once; returns the summary request the engine built. */
async function summaryRequestFor(test: Mounted, options: AgentOptions): Promise<{ request: LlmRequest | undefined; outcome: string }> {
  const { agent } = await test.create(options)
  for (let turn = 1; turn <= 4; turn++) {
    agent.followup(createUserMessage(`prompt ${turn} ${'x'.repeat(320)}`))
    await agent.whenIdle()
  }
  const before = test.summaries.length
  const outcome = await test.root.get(COMPACTION).compactNow(agent)
  return { request: test.summaries[before], outcome: outcome.kind }
}

describe('the default summary request', () => {
  it('is one every catalogued model accepts at every effort it offers, and at none named', { timeout: 120_000 }, async () => {
    const test = await mount()
    const refused: string[] = []
    const asked: string[] = []
    for (const adapter of test.adapters) {
      for (const model of adapter.listModels()) {
        // `undefined` is the session that names no effort, which is the default one.
        for (const effort of [undefined, ...adapter.resolveModel(model.id).reasoning.efforts]) {
          const label = `${adapter.provider}/${model.id}@${effort ?? '(none named)'}`
          const { request, outcome } = await summaryRequestFor(test, { provider: adapter.provider, model: model.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
          asked.push(label)
          if (request === undefined) {
            refused.push(`${label}: no summary request was built (${outcome})`)
            continue
          }
          try {
            adapter.validateOptions(request)
          } catch (error) {
            refused.push(`${label}: ${(error as Error).message}`)
          }
          if (outcome !== 'compacted') refused.push(`${label}: the compaction ended ${outcome}`)
        }
      }
    }
    // Every shipped row was asked: three providers, and more pairs than any one adapter has rows.
    expect(new Set(asked.map((label) => label.split('/')[0]))).toEqual(new Set(['deepseek', 'anthropic', 'openai']))
    expect(asked.length, asked.join('\n')).toBeGreaterThan(60)
    expect(refused).toEqual([])
  })

  // The two halves of the rule that makes the above true. The session's own
  // effort is sized for a step; an effort a route was given FOR the summary is
  // that route's, and is sent (model-roles' own test pins it for a role).
  it('names no effort on the session\'s own call, and keeps one a listener gave the summary', async () => {
    const test = await mount()
    const session: AgentOptions = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', reasoningEffort: 'max' }
    const own = await summaryRequestFor(test, session)
    expect([own.outcome, own.request?.model, own.request?.reasoningEffort, own.request?.maxTokens]).toEqual(['compacted', 'claude-haiku-4-5-20251001', undefined, 8192])
    test.root.on(
      AGENT_REQUEST,
      async (context, next) => {
        const config = await next()
        return context.purpose === 'compaction' ? { ...config, reasoningEffort: 'low' } : config
      },
      { global: true },
    )
    const given = await summaryRequestFor(test, session)
    expect([given.outcome, given.request?.model, given.request?.reasoningEffort]).toEqual(['compacted', 'claude-haiku-4-5-20251001', 'low'])
  })
})
