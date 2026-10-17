/**
 * The S18 search arc: the first tool that reaches the network, on the real
 * runtime, the real DeepSeek and Tavily APIs, over `minidsh serve`'s stdio,
 * with consent answered over the wire the way a person's client would.
 *
 *   consent      every query asks first, and the line a person answers is the
 *                runtime's own record of what would leave the machine: the
 *                query, where it goes, and as whom — never model prose
 *   structure    the model is shown only structured sources behind a fixed
 *                untrusted-content notice; what it writes is checked against
 *                those sources (the WORLD), not against its own report
 *   refusal      a refused query sends nothing and says so
 *   the store    the key reaches the row from the home's `credentials.json`:
 *                the host is spawned WITHOUT it in its environment
 *   replay       the log replays keylessly, every recorded answer served
 *
 * Requires DEEPSEEK_API_KEY and TAVILY_API_KEY; skipped otherwise. A LOCAL
 * gate: live.yml carries no Tavily secret (ARCHITECTURE §10). The gate loads
 * the key into this process only, from the developer's own credential store.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { WEB_SEARCH_NOTICE } from '../capabilities/tool-web-search/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { loadCompositionFile, toPatches } from './config.ts'
import { bootComposition } from './headless.ts'
import { skillRootsFor } from './home.ts'

const DEEPSEEK = process.env.DEEPSEEK_API_KEY
const TAVILY = process.env.TAVILY_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }

let dirs: string[] = []
afterAll(() => {
  killSpawnedServes()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const data = <T>(event: EventEnvelope | undefined): T => (event?.data ?? {}) as T

const COMPOSITION = JSON.stringify({ patches: [{ insert: [{ id: 'tool-web-search', plugin: 'tool-web-search' }] }] })

/**
 * Each prompt names the tool and forbids the shell. The first asks for the
 * LAST result listed, because a well-known page for a well-known query could be
 * written from memory and still be among the results: which one comes last is
 * something only the search's own answer says, so the WORLD assertion below
 * separates reading the results from guessing (S18 review).
 */
const PROMPTS = [
  'Use the web_search tool exactly once, with the query: Node.js release schedule. Then use str_replace_editor with the create command to write url.txt in the working directory containing exactly the URL of the LAST search result listed, copied verbatim, and nothing else. Do not use the shell.',
  'Use the web_search tool exactly once, with the query: Node.js 26 release date. Then reply in one sentence saying what happened.',
] as const

type Subject = { effect: string; destination: string; credential: string; payload: string }

describe.skipIf(!DEEPSEEK || !TAVILY)('S18 live E2E: a network tool under per-query consent', () => {
  it('asks before each query, shows structured sources only, refuses what a person refuses, and replays', { timeout: 600_000 }, async () => {
    const workspace = tempDir('minidsh-e2e18s-ws-')
    const home = tempDir('minidsh-e2e18s-home-')
    writeFileSync(join(home, 'composition.json'), COMPOSITION, 'utf8')
    // The key lives in the home's credential store, and the host is spawned
    // without it in its environment: the store path is the one under test.
    writeFileSync(join(home, 'credentials.json'), JSON.stringify({ TAVILY_API_KEY: TAVILY }), 'utf8')

    const serve = new ServeProcess(workspace, home, { withoutEnv: ['TAVILY_API_KEY'] })
    await serve.request('initialize')

    // ---- turn 1: a person says yes over the wire ----------------------------
    const allow = serve.answerApprovals('allowed-once')
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: PROMPTS[0], agentOptions: { provider: 'deepseek', model: 'deepseek-flash' } })
    await serve.waitForCompletedTurn(sessionId, 1)
    allow()

    // ---- turn 2: a person says no -------------------------------------------
    const reject = serve.answerApprovals('rejected')
    await serve.request('session/prompt', { sessionId, text: PROMPTS[1] })
    await serve.waitForCompletedTurn(sessionId, 2)
    reject()
    const events = (await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })).events
    await serve.shutdown()

    const turnStarts = events.filter((event) => event.type === 'turn/start').map((event) => event.seq)
    const inTurn = (seq: number): number => turnStarts.filter((start) => start <= seq).length
    const calls = events.filter((event) => event.type === 'tool/call' && data<{ name: string }>(event).name === 'web_search')
    const asked = events.filter((event) => event.type === 'approval/asked')
    const decided = events.filter((event) => event.type === 'approval/decided')
    const results = events.filter((event) => event.type === 'tool/result')
    const resultOf = (callId: string) => results.find((event) => data<{ callId: string }>(event).callId === callId)
    const shape =
      `calls ${JSON.stringify(events.filter((event) => event.type === 'tool/call').map((event) => [inTurn(event.seq), data<{ name: string }>(event).name]))}; ` +
      `asked ${asked.length}; decided ${JSON.stringify(decided.map((event) => data<{ outcome: string; decidedBy?: string }>(event)))}`
    console.log(`[search arc] ${shape}`)

    // ---- consent: the runtime's record, answered by a person -----------------
    const first = calls.find((event) => inTurn(event.seq) === 1)
    expect(first, `turn 1 never searched — ${shape}`).toBeDefined()
    const firstQuery = (JSON.parse(data<{ arguments: string }>(first).arguments) as { query: string }).query
    const firstAsk = asked.find((event) => data<{ callId?: string }>(event).callId === data<{ callId: string }>(first).callId)
    expect(data<{ subject?: Subject }>(firstAsk).subject, 'the consent names what leaves, where, and as whom').toEqual({
      effect: 'network-request',
      destination: 'https://api.tavily.com/search',
      credential: 'TAVILY_API_KEY',
      payload: firstQuery,
    })
    const firstDecision = decided.find((event) => data<{ id: string }>(event).id === data<{ id: string }>(firstAsk).id)
    expect(data<{ outcome: string; decidedBy?: string }>(firstDecision)).toMatchObject({ outcome: 'allowed-once', decidedBy: 'user' })

    // ---- structure: the notice, then sources; the WORLD written from them ----
    const firstResult = resultOf(data<{ callId: string }>(first).callId)
    const shown = data<{ message: { content: { content?: { type: string; text?: string }[] }[] } }>(firstResult).message.content[0]!.content!.map((block) => block.text ?? '').join('')
    expect(shown.startsWith(WEB_SEARCH_NOTICE), `the result does not open with the fixed notice:\n${shown.slice(0, 300)}`).toBe(true)
    const sources = [...shown.matchAll(/^\s+(https?:\/\/\S+)$/gmu)].map((match) => match[1]!)
    expect(sources.length, `no structured sources were shown:\n${shown.slice(0, 600)}`).toBeGreaterThan(0)
    const written = readFileSync(join(workspace, 'url.txt'), 'utf8').trim().replace(/^<|>$/gu, '')
    expect(written, `url.txt holds "${written}"; the results listed ${JSON.stringify(sources)}`).toBe(sources.at(-1))

    // ---- refusal: nothing was sent, and the model was told ------------------
    const second = calls.filter((event) => inTurn(event.seq) === 2)
    expect(second.length, `turn 2 never searched — ${shape}`).toBeGreaterThan(0)
    for (const call of second) {
      const query = (JSON.parse(data<{ arguments: string }>(call).arguments) as { query: string }).query
      const ask = asked.find((event) => data<{ callId?: string }>(event).callId === data<{ callId: string }>(call).callId)
      expect(data<{ subject?: Subject }>(ask).subject?.payload, 'each refusal is of the query that call carried').toBe(query)
      // A PERSON refused it: NETWORK_DENIED alone would also follow an
      // unavailable or cancelled ask.
      const decision = decided.find((event) => data<{ id: string }>(event).id === data<{ id: string }>(ask).id)
      expect(data<{ outcome: string; decidedBy?: string }>(decision)).toMatchObject({ outcome: 'rejected', decidedBy: 'user' })
      expect(data<{ error?: { code: string } }>(resultOf(data<{ callId: string }>(call).callId)).error?.code).toBe('NETWORK_DENIED')
    }

    // ---- replay: keyless, every recorded answer served -----------------------
    const file = loadCompositionFile(join(home, 'composition.json'))!
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-e2e18s-replay-'),
      // What `serve` mounted: the recorded requests carry its skill list.
      skillRoots: skillRootsFor(home),
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      configLayers: [{ name: 'home', patches: await toPatches(file, home) }],
      prepare: (context) => {
        replayHandle = installLlmReplay(context, { events, effects: 'recorded' })
      },
    })
    try {
      const handle = await root.get(AGENTS).create(root, { cwd: tempDir('minidsh-e2e18s-replay-ws-'), agentOptions: { provider: 'deepseek', model: 'deepseek-flash' } })
      for (const text of PROMPTS) {
        handle.agent.followup(createUserMessage(text))
        await handle.agent.whenIdle()
      }
      await handle.dispose()
    } finally {
      await root.dispose()
    }
    replayHandle!.assertConsumed()
  })
})
