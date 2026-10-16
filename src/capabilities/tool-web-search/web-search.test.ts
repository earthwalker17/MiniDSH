/**
 * The first tool that sends data off the machine, against a Tavily stand-in
 * this file owns (`node:http` on 127.0.0.1), so every claim is about what
 * actually reached a socket — never a mocked `fetch`.
 *
 * The order is the contract: no key means nobody is asked; consent comes
 * before any byte leaves; a refusal sends nothing; the consented destination
 * is the only one the query reaches; and the model is shown structured
 * sources behind a fixed notice, whatever else the provider sent.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../../kernel/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_REQUEST, type ApprovalAnswer, type ApprovalPrompt } from '../../core/approval/index.ts'
import { CREDENTIALS } from '../../core/credentials/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { matches } from '../../core/session/index.ts'
import { NETWORK_TOOL, TOOLS, toolCall } from '../../core/tools/index.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { credentialsLocalPlugin } from '../credentials-local/index.ts'
import { spillLocalPlugin } from '../spill-local/index.ts'
import { toolWebSearchPlugin, WEB_SEARCH_NOTICE, type WebSearchConfig } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const shellAvailable = spawnSync(process.platform === 'win32' ? 'pwsh' : 'bash', ['--version'], { stdio: 'ignore' }).status === 0
const KEY = 'tvly-test-not-a-real-key'
const ESC = String.fromCharCode(27)

// ---- the stand-in ------------------------------------------------------------

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

interface Stub {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  readonly url: string
  readonly seen: Seen[]
  respond: (request: Seen, response: ServerResponse) => void
  close(): Promise<void>
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

async function stub(): Promise<Stub> {
  const seen: Seen[] = []
  const state: Stub = {
    url: '',
    seen,
    respond: (_request, response) => json(response, 200, { results: [] }),
    close: async () => {},
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: Seen = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(entry)
      state.respond(entry, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  })
}

const results = (...entries: object[]): ((request: Seen, response: ServerResponse) => void) => (_request, response) => json(response, 200, { query: 'q', results: entries })

// ---- the composition ---------------------------------------------------------

let harness: CoreHarness | undefined
let server: Stub | undefined
let dirs: string[] = []
const savedKey = process.env.TAVILY_API_KEY

beforeEach(() => {
  // Hermetic: the developer's own key, if any, must neither satisfy the
  // missing-key case nor reach the stand-in.
  delete process.env.TAVILY_API_KEY
})

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  await server?.close()
  server = undefined
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
  if (savedKey === undefined) delete process.env.TAVILY_API_KEY
  else process.env.TAVILY_API_KEY = savedKey
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Outcome {
  readonly isError: boolean
  readonly code: string | undefined
  readonly text: string
  readonly sources: number | undefined
}

interface Fixture {
  readonly agent: Agent
  readonly server: Stub
  readonly storePath: string
  run(query: unknown, options?: { callId?: string; signal?: AbortSignal }): Promise<Outcome>
  answer(answerer: (prompt: ApprovalPrompt) => Promise<ApprovalAnswer>): void
}

/**
 * The real core plus the three rows the tool needs: the local credential
 * store (the key lives in its JSON file, where the S18 deployment keeps it),
 * the spill store when asked, and the row itself pointed at the stand-in.
 */
async function setup(options: { key?: string; config?: WebSearchConfig | ((stubURL: string) => WebSearchConfig); spill?: boolean } = {}): Promise<Fixture> {
  server = await stub()
  const config = typeof options.config === 'function' ? options.config(server.url) : options.config
  const home = tempDir('minidsh-search-home-')
  const storePath = join(home, 'credentials.json')
  if (options.key !== undefined) writeFileSync(storePath, JSON.stringify({ [config?.apiKeyEnv ?? 'TAVILY_API_KEY']: options.key }))
  harness = await coreHarness()
  harness.root.plugin(credentialsLocalPlugin, { path: storePath })
  if (options.spill === true) harness.root.plugin(spillLocalPlugin, { root: tempDir('minidsh-search-spill-') })
  harness.root.plugin(toolWebSearchPlugin, { baseURL: server.url, ...config })
  const report = await harness.root.settle()
  expect(report.failed).toEqual([])
  const { agent } = await harness.create()
  const tools = harness.root.get(TOOLS)
  const root = harness.root
  return {
    agent,
    server,
    storePath,
    answer: (answerer) => void root.on(APPROVAL_REQUEST, answerer),
    run: async (query, run = {}) => {
      const result = await tools.execute(
        toolCall(run.callId ?? `call-${Math.random()}`, 'web_search', JSON.stringify({ query }), agent, run.signal ?? new AbortController().signal),
      )
      const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      const value = result.value as { sources?: number } | undefined
      return { isError: result.isError, code: result.error?.info?.code, text, sources: value?.sources }
    },
  }
}

const allow = async (): Promise<ApprovalAnswer> => 'allowed-once'

// ---- consent ---------------------------------------------------------------

describe('consent, before anything leaves', () => {
  it('asks with the exact subject — the query, where it goes, as whom — and sends nothing until answered', async () => {
    const f = await setup({ key: KEY })
    const prompts: ApprovalPrompt[] = []
    let sentWhileAsking = -1
    f.answer(async (prompt) => {
      prompts.push(prompt)
      sentWhileAsking = f.server.seen.length
      return 'allowed-once'
    })
    f.server.respond = results({ title: 'Node.js 24', url: 'https://nodejs.org/en/blog/release/v24.0.0', content: 'released' })
    const outcome = await f.run('node 24 release date', { callId: 'call-ask' })
    expect(outcome.isError).toBe(false)
    const subject = { effect: 'network-request', destination: `${f.server.url}/search`, credential: 'TAVILY_API_KEY', payload: 'node 24 release date' }
    expect(prompts.map((prompt) => ({ toolName: prompt.toolName, subject: prompt.subject }))).toEqual([{ toolName: 'web_search', subject }])
    expect(sentWhileAsking, 'a byte left before the person answered').toBe(0)
    // The durable ask carries the same subject, joined to the call it covers.
    const asked = f.agent.session.events.filter((event) => matches(event, APPROVAL_ASKED)).map((event) => event.data as { callId?: string; subject?: unknown })
    expect(asked).toEqual([expect.objectContaining({ callId: 'call-ask', subject })])
    expect(f.server.seen).toHaveLength(1)
  })

  it('sends nothing when the answer is anything but yes, and says nothing was sent', async () => {
    const f = await setup({ key: KEY })
    // No answerer at all: the seam's fail-closed default.
    const unanswered = await f.run('first query')
    expect(unanswered).toMatchObject({ isError: true, code: 'NETWORK_DENIED' })
    expect(unanswered.text).toContain('web search was unavailable; nothing was sent')
    f.answer(async () => 'rejected')
    const refused = await f.run('second query')
    expect(refused).toMatchObject({ isError: true, code: 'NETWORK_DENIED' })
    expect(refused.text).toContain('web search was rejected; nothing was sent')
    expect(f.server.seen, 'the stand-in received a request nobody consented to').toHaveLength(0)
  })

  // The S18 review's reproduction: a key with a stray newline made the
  // platform's header error QUOTE it, and that message was the tool result —
  // durable, and sent to the model on the next request.
  it('refuses a key no header can carry, naming only its reference, and never echoes it', async () => {
    const f = await setup({ key: `${KEY}\nsecond-line` })
    let asked = 0
    f.answer(async () => {
      asked += 1
      return 'allowed-once'
    })
    const outcome = await f.run('anything')
    expect(outcome).toMatchObject({ isError: true, code: 'SEARCH_CREDENTIAL_INVALID' })
    expect(outcome.text).toContain('TAVILY_API_KEY')
    expect(outcome.text).not.toContain(KEY)
    expect(JSON.stringify(f.agent.session.events)).not.toContain(KEY)
    expect(asked).toBe(0)
    expect(f.server.seen).toHaveLength(0)
  })

  it('without a key, refuses and names where to put one — asking nobody, sending nothing', async () => {
    const f = await setup()
    let asked = 0
    f.answer(async () => {
      asked += 1
      return 'allowed-once'
    })
    // The row mounted keyless: the tool exists, it just cannot run.
    expect(harness!.root.get(TOOLS).list().map((tool) => tool.name)).toContain('web_search')
    const outcome = await f.run('anything')
    expect(outcome).toMatchObject({ isError: true, code: 'SEARCH_CREDENTIAL_MISSING' })
    expect(outcome.text).toContain('TAVILY_API_KEY')
    expect(outcome.text).toContain(f.storePath)
    expect(asked).toBe(0)
    expect(f.agent.session.events.some((event) => matches(event, APPROVAL_ASKED))).toBe(false)
    expect(f.server.seen).toHaveLength(0)
  })

  it('lets an exact grant answer the identical query again, and asks again for any other', async () => {
    const f = await setup({ key: KEY })
    let prompts = 0
    f.answer(async () => {
      prompts += 1
      return { outcome: 'allowed-once', by: 'user', grant: true }
    })
    expect((await f.run('pnpm 11 changelog')).isError).toBe(false)
    expect((await f.run('pnpm 11 changelog')).isError).toBe(false)
    expect((await f.run('pnpm 11 changelog ')).isError).toBe(false)
    expect(prompts, 'the repeat should be answered by the grant; the near-miss must ask').toBe(2)
    const deciders = f.agent.session.events.filter((event) => matches(event, APPROVAL_DECIDED)).map((event) => (event.data as { decidedBy?: string }).decidedBy)
    expect(deciders).toEqual(['user', 'grant', 'user'])
    expect(f.server.seen).toHaveLength(3)
  })

  it('arms its own deadline only after consent, so a person deliberating never spends it', async () => {
    // A deliberation longer than the deadline, with room for a loaded host:
    // the request after it must still have the whole deadline to itself.
    const f = await setup({ key: KEY, config: { timeoutMs: 2_000 } })
    f.answer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      return 'allowed-once'
    })
    f.server.respond = results({ title: 'ok', url: 'https://example.com/', content: '' })
    expect((await f.run('slow person')).isError, 'the deadline ran while consent was pending').toBe(false)
    // And it does cover the request itself: a provider that never answers times out.
    f.server.respond = () => {}
    const hung = await f.run('silent provider')
    expect(hung).toMatchObject({ isError: true, code: 'SEARCH_TIMEOUT' })
  }, 15_000)

  it('reports a cancellation after the query was sent as what it is', async () => {
    const f = await setup({ key: KEY })
    f.answer(allow)
    f.server.respond = () => {}
    const controller = new AbortController()
    const pending = f.run('cancel me', { signal: controller.signal })
    for (let i = 0; i < 200 && f.server.seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.server.seen).toHaveLength(1)
    controller.abort()
    const outcome = await pending
    expect(outcome).toMatchObject({ isError: true, code: 'SEARCH_CANCELLED' })
    expect(outcome.text).toContain('may have reached the provider')
  })
})

// ---- the request -------------------------------------------------------------

describe('what is sent', () => {
  it('POSTs one query with the bearer key, every prose and raw switch off, and the configured result count', async () => {
    const f = await setup({ key: KEY, config: { maxResults: 3 } })
    f.answer(allow)
    await f.run('tavily search api')
    expect(f.server.seen).toHaveLength(1)
    const [request] = f.server.seen
    expect(request).toMatchObject({ method: 'POST', url: '/search' })
    expect(request!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(request!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request!.body)).toEqual({
      query: 'tavily search api',
      search_depth: 'basic',
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      auto_parameters: false,
      topic: 'general',
    })
  })

  it('refuses a redirect instead of re-posting the query to a destination nobody consented to', async () => {
    const f = await setup({ key: KEY })
    f.answer(allow)
    f.server.respond = (request, response) => {
      if (request.url === '/search') {
        response.writeHead(307, { location: `${f.server.url}/elsewhere` })
        response.end()
        return
      }
      json(response, 200, { results: [{ title: 'redirected', url: 'https://example.com/', content: '' }] })
    }
    const outcome = await f.run('follow me')
    expect(outcome).toMatchObject({ isError: true, code: 'SEARCH_TRANSPORT' })
    expect(f.server.seen.map((request) => request.url)).toEqual(['/search'])
  })

  it('keeps a path prefix the base carries, and the subject names the endpoint actually reached', async () => {
    const f = await setup({ key: KEY, config: (url) => ({ baseURL: `${url}/proxy/tavily?ignored=1` }) })
    const prompts: ApprovalPrompt[] = []
    f.answer(async (prompt) => {
      prompts.push(prompt)
      return 'allowed-once'
    })
    await f.run('q')
    expect(f.server.seen.map((request) => request.url)).toEqual(['/proxy/tavily/search'])
    expect(prompts[0]!.subject).toMatchObject({ destination: `${f.server.url}/proxy/tavily/search` })
  })

  it.each([
    [401, 'SEARCH_AUTH'],
    [403, 'SEARCH_AUTH'],
    [429, 'SEARCH_RATE_LIMIT'],
    [432, 'SEARCH_QUOTA'],
    [433, 'SEARCH_QUOTA'],
    [400, 'SEARCH_INVALID'],
    [422, 'SEARCH_INVALID'],
    [500, 'SEARCH_SERVER'],
    [503, 'SEARCH_SERVER'],
    [404, 'SEARCH_HTTP'],
  ])('maps HTTP %i to %s, with the provider’s words and never the key', async (status, code) => {
    const f = await setup({ key: KEY })
    f.answer(allow)
    f.server.respond = (_request, response) => json(response, status, { detail: { error: `provider says ${status}` } }, status === 429 ? { 'retry-after': '7' } : {})
    const outcome = await f.run('status')
    expect(outcome).toMatchObject({ isError: true, code })
    expect(outcome.text).toContain(`provider says ${status}`)
    expect(outcome.text).not.toContain(KEY)
    if (status === 429) expect(outcome.text).toContain('retry after 7s')
  })

  it('refuses a body that is not the expected JSON rather than reading it as no results', async () => {
    const f = await setup({ key: KEY })
    f.answer(allow)
    f.server.respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>captive portal</html>')
    }
    expect(await f.run('portal')).toMatchObject({ isError: true, code: 'SEARCH_MALFORMED' })
    f.server.respond = (_request, response) => json(response, 200, { answer: 'no list here' })
    expect(await f.run('no list')).toMatchObject({ isError: true, code: 'SEARCH_MALFORMED' })
  })

  it('stops reading a body past its byte cap, declared or streamed, before anything parses it', async () => {
    const f = await setup({ key: KEY })
    f.answer(allow)
    const chunk = 'x'.repeat(64 * 1024)
    f.server.respond = (_request, response) => {
      // Chunked, no declared length: the cap must hold on the stream itself.
      response.writeHead(200, { 'content-type': 'application/json' })
      for (let i = 0; i < 33; i++) response.write(chunk)
      response.end()
    }
    expect(await f.run('huge')).toMatchObject({ isError: true, code: 'SEARCH_TOO_LARGE' })
    f.server.respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) })
      response.write(chunk)
    }
    expect(await f.run('declared huge')).toMatchObject({ isError: true, code: 'SEARCH_TOO_LARGE' })
  })
})

// ---- what the model sees -----------------------------------------------------

describe('what the model is shown', () => {
  it('opens with the fixed notice and lists structured sources only — never the answer, raw content, images or follow-ups', async () => {
    const f = await setup({ key: KEY })
    f.answer(allow)
    f.server.respond = (_request, response) =>
      json(response, 200, {
        query: 'node 24',
        answer: 'THE-PROVIDER-ANSWER-PROSE',
        images: ['https://img.example/IMAGE-LEAK.png'],
        follow_up_questions: ['FOLLOW-UP-LEAK?'],
        results: [
          { title: 'Node.js 24', url: 'https://nodejs.org/en/blog/release/v24.0.0', content: 'Node 24 was released.', raw_content: 'RAW-PAGE-LEAK', score: 0.9 },
          { title: 'FTP mirror', url: 'ftp://mirror.example/node', content: 'dropped' },
          { title: 'Garbage', url: 'not a url at all', content: 'dropped' },
          { title: 'Nowhere', content: 'dropped' },
          { title: `Esc${ESC}[2Kaped\ntitle`, url: 'https://example.com/a', content: 'y'.repeat(900) },
        ],
      })
    const outcome = await f.run('node 24')
    expect(outcome.isError).toBe(false)
    expect(outcome.text.startsWith(`${WEB_SEARCH_NOTICE}\n\n1. Node.js 24\n   https://nodejs.org/en/blog/release/v24.0.0\n   Node 24 was released.\n\n2. `)).toBe(true)
    for (const leak of ['THE-PROVIDER-ANSWER-PROSE', 'IMAGE-LEAK', 'FOLLOW-UP-LEAK', 'RAW-PAGE-LEAK', 'ftp://', 'not a url', 'FTP mirror', 'Garbage', 'Nowhere']) {
      expect(outcome.text, leak).not.toContain(leak)
    }
    // A control character becomes a space, never an escape a terminal runs.
    expect(outcome.text).toContain('2. Esc [2Kaped title\n   https://example.com/a\n')
    expect(outcome.text).not.toContain(ESC)
    // The snippet is clamped and says so.
    expect(outcome.text).toContain(`${'y'.repeat(499)}…`)
    expect(outcome.text).not.toContain('y'.repeat(500))
    expect(outcome.text).not.toContain('3. ')
    expect(outcome.sources).toBe(2)
  })

  it('says "No results." under the notice when there are none, and never shows more sources than it asked for', async () => {
    const f = await setup({ key: KEY, config: { maxResults: 2 } })
    f.answer(allow)
    expect((await f.run('nothing')).text).toBe(`${WEB_SEARCH_NOTICE}\n\nNo results.`)
    f.server.respond = results(...Array.from({ length: 6 }, (_, index) => ({ title: `T${index}`, url: `https://example.com/${index}`, content: '' })))
    const many = await f.run('many')
    expect(many.sources).toBe(2)
    expect(many.text).toContain('2. T1')
    expect(many.text).not.toContain('T2')
  })

  it('spills a long rendering to the store and keeps the notice whole', async () => {
    const f = await setup({ key: KEY, spill: true, config: { maxOutputChars: 300 } })
    f.answer(allow)
    f.server.respond = results(...Array.from({ length: 5 }, (_, index) => ({ title: `Source ${index + 1}`, url: `https://example.com/${index + 1}`, content: 'z'.repeat(400) })))
    const outcome = await f.run('long')
    expect(outcome.isError).toBe(false)
    expect(outcome.text.startsWith(`${WEB_SEARCH_NOTICE}\n\n1. Source 1`)).toBe(true)
    expect(outcome.text).toContain('characters omitted')
    const saved = /saved at (.+?) — read it/u.exec(outcome.text)?.[1]
    expect(saved, 'the excerpt names no saved file').toBeDefined()
    const full = readFileSync(saved!, 'utf8')
    for (let index = 1; index <= 5; index++) expect(full).toContain(`https://example.com/${index}`)
  })
})

// ---- the row -----------------------------------------------------------------

describe('the row', () => {
  it('tags its tool NETWORK, owns its own deadline, bounds the query, and declares its credential under any name', async () => {
    const f = await setup({ key: KEY, config: { apiKeyEnv: 'CORP_SEARCH_KEY' } })
    const tool = harness!.root
      .get(TOOLS)
      .list()
      .find((definition) => definition.name === 'web_search')!
    expect(tool.tags).toEqual([NETWORK_TOOL])
    expect(tool.timeoutMs).toBeNull()
    expect(harness!.root.get(CREDENTIALS).declaredRefs()).toEqual(['CORP_SEARCH_KEY'])
    // Long enough to keep every subject whole, and never blank.
    expect(await f.run('q'.repeat(401))).toMatchObject({ isError: true, code: 'INVALID_ARGS' })
    expect(await f.run('   ')).toMatchObject({ isError: true, code: 'INVALID_ARGS' })
    const prompts: ApprovalPrompt[] = []
    f.answer(async (prompt) => {
      prompts.push(prompt)
      return 'allowed-once'
    })
    await f.run('renamed key')
    expect(prompts[0]!.subject).toMatchObject({ credential: 'CORP_SEARCH_KEY' })
    expect(f.server.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('refuses a base a person could not read as an endpoint, at the contract', () => {
    const parse = (config: unknown): unknown => toolWebSearchPlugin.config!.parse(config)
    expect(() => parse({ baseURL: 'ftp://api.tavily.com' })).toThrow()
    expect(() => parse({ baseURL: 'https://user:secret@api.tavily.com' })).toThrow()
    expect(() => parse({ maxResults: 11 })).toThrow()
    expect(() => parse({ maxResults: 0 })).toThrow()
    expect(() => parse({ unknown: true })).toThrow()
    expect(parse({ baseURL: 'https://api.tavily.com', maxResults: 10 })).toEqual({ baseURL: 'https://api.tavily.com', maxResults: 10 })
  })

  /**
   * The scrub's list is what the mounted rows declared, so this row's key is
   * withheld from a shell child exactly while the row is mounted — and only
   * then: without the row, `TAVILY_API_KEY` is the user's own variable and
   * reaches the user's shell. Two boots of the shipped composition, as
   * `app.test.ts` pins the adapter rows.
   */
  it.skipIf(!shellAvailable)('withholds its key from a shell child exactly while the row is mounted', async () => {
    const { bootComposition } = await import('../../app/headless.ts')
    const { AGENTS } = await import('../../core/agent/index.ts')
    const { SHELL } = await import('../../core/shell/index.ts')
    process.env.TAVILY_API_KEY = 'tavily-secret-value'
    const command = process.platform === 'win32' ? 'Write-Output "[$env:TAVILY_API_KEY]"' : 'echo "[$TAVILY_API_KEY]"'
    for (const mounted of [true, false]) {
      const cwd = tempDir('minidsh-search-cwd-')
      const adapter = new ScriptedAdapter()
      const root = await bootComposition({
        sessionsRoot: tempDir('minidsh-search-sessions-'),
        logger: silent,
        ...(mounted ? { patches: [{ insert: [{ id: 'web-search', plugin: toolWebSearchPlugin }] }] } : {}),
        prepare: (context) => void context.get(LLM).registerAdapter(context, adapter),
      })
      try {
        expect(root.get(CREDENTIALS).declaredRefs().includes('TAVILY_API_KEY' as never), `mounted: ${mounted}`).toBe(mounted)
        const handle = await root.get(AGENTS).create(root, { cwd, agentOptions: { provider: 'scripted', model: 'scripted-model' } })
        try {
          const shell = root.get(SHELL).sessionFor(handle.agent)
          const { output } = await shell.exec({ command, policy: { mode: 'danger-full-access' as const, workspaceRoot: cwd }, timeoutMs: 30_000 })
          if (mounted) expect(output, 'the key reached the shell while the row that declares it was mounted').not.toContain('tavily-secret-value')
          else expect(output, 'without the row the variable is the user’s, and reaches the user’s shell').toContain('[tavily-secret-value]')
        } finally {
          await handle.dispose()
        }
      } finally {
        await root.dispose()
      }
    }
  }, 120_000)

  it('is flagged by `minidsh config` as an authority-sensitive row a layer added', async () => {
    const { main } = await import('../../app/cli.ts')
    const home = tempDir('minidsh-search-config-')
    const previousHome = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    // By module path, so the claim does not depend on the builtin catalog listing the row.
    writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ insert: [{ id: 'web-search', plugin: join(import.meta.dirname, 'index.ts') }] }] }))
    const out: string[] = []
    const err: string[] = []
    const writeOut = process.stdout.write.bind(process.stdout)
    const writeErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((text: string) => (out.push(text), true)) as typeof process.stdout.write
    process.stderr.write = ((text: string) => (err.push(text), true)) as typeof process.stderr.write
    let code: number
    try {
      code = await main(['config'])
    } finally {
      process.stdout.write = writeOut
      process.stderr.write = writeErr
      if (previousHome === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previousHome
    }
    expect(code, err.join('')).toBe(0)
    expect(err.join('')).toContain('warn: layer "home" added authority-sensitive row "web-search" (tool-web-search)')
    expect(out.join('')).toMatch(/web-search\s+tool-web-search\s+home\s+\[!\]/u)
  })
})
