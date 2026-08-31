/** The client protocol, exercised byte-level over an in-memory duplex pair. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { serviceKey, type Context, type Logger } from '../../kernel/index.ts'
import { AGENTS } from '../../core/agent/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { LLM, LlmError } from '../../core/llm/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE, type PreToolDecision } from '../../core/tools/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { startProtocolHost, type ProtocolHostHandle } from '../../app/serve.ts'
import type { AttachResult, PageResult, SessionView } from './frames.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

let dirs: string[] = []
let hosts: ProtocolHostHandle[] = []

afterEach(async () => {
  for (const host of hosts.toReversed()) await host.dispose()
  hosts = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface RpcReply {
  result?: unknown
  error?: { code: number; message: string }
}

class TestClient {
  readonly input = new PassThrough()
  readonly output = new PassThrough()
  readonly notifications: { method: string; params: Record<string, unknown> }[] = []
  private nextId = 1
  private readonly pending = new Map<number, (reply: RpcReply) => void>()

  constructor() {
    const reader = createInterface({ input: this.output, crlfDelay: Infinity })
    reader.on('line', (line) => {
      const frame = JSON.parse(line) as Record<string, unknown>
      if (typeof frame.method === 'string') {
        this.notifications.push(frame as { method: string; params: Record<string, unknown> })
      } else {
        this.pending.get(frame.id as number)?.(frame as RpcReply)
        this.pending.delete(frame.id as number)
      }
    })
  }

  raw(line: string): void {
    this.input.write(`${line}\n`)
  }

  call(method: string, params?: unknown): Promise<RpcReply> {
    const id = this.nextId++
    const reply = new Promise<RpcReply>((resolve) => this.pending.set(id, resolve))
    this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    return reply
  }

  async result<T>(method: string, params?: unknown): Promise<T> {
    const reply = await this.call(method, params)
    if (reply.error) throw new Error(`${method} failed: ${reply.error.message}`)
    return reply.result as T
  }

  frames(type?: string, sessionId?: string): { sessionId: string; event: { type: string; data: Record<string, unknown> } }[] {
    return this.notifications
      .filter((entry) => entry.method === 'session.event')
      .map((entry) => entry.params as { sessionId: string; event: { type: string; data: Record<string, unknown> } })
      .filter((frame) => (type === undefined || frame.event.type === type) && (sessionId === undefined || frame.sessionId === sessionId))
  }

  statuses(): { sessionId: string; status: string }[] {
    return this.notifications.filter((entry) => entry.method === 'session.status').map((entry) => entry.params as { sessionId: string; status: string })
  }

  async waitFor<T>(pick: () => T | undefined, what: string, timeoutMs = 3000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const value = pick()
      if (value !== undefined) return value
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /** Waits for the agent to have gone running and come back to idle. */
  waitForIdle(sessionId: string): Promise<{ status: string }> {
    return this.waitFor(() => {
      const mine = this.statuses().filter((entry) => entry.sessionId === sessionId)
      return mine.some((entry) => entry.status === 'running') && mine.at(-1)?.status === 'idle' ? mine.at(-1) : undefined
    }, `idle status for ${sessionId}`)
  }
}

async function startHost(
  adapter: ScriptedAdapter,
  extra?: {
    sessionsRoot?: string
    prepare?: (root: Context) => void
    approve?: boolean
    agentSetup?: (agentCtx: Context) => void
    agentPreset?: string
    /** Extra clients on their own stream carriers — the multi-client shape, with no socket needed. */
    extraClients?: number
    /** Whether each client's carrier may shut the host down (default true, as stdio is). */
    allowShutdown?: boolean
  },
): Promise<{ host: ProtocolHostHandle; client: TestClient; clients: TestClient[]; sessionsRoot: string }> {
  const clients = Array.from({ length: 1 + (extra?.extraClients ?? 0) }, () => new TestClient())
  const sessionsRoot = extra?.sessionsRoot ?? tempDir('minidsh-proto-sessions-')
  const host = await startProtocolHost({
    cwd: tempDir('minidsh-proto-cwd-'),
    sessionsRoot,
    logger: silent,
    ...(extra?.approve === undefined ? {} : { approve: extra.approve }),
    ...(extra?.agentSetup === undefined ? {} : { agentSetup: extra.agentSetup }),
    ...(extra?.agentPreset === undefined ? {} : { agentPreset: extra.agentPreset }),
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root) => {
      root.get(LLM).registerAdapter(root, adapter)
      extra?.prepare?.(root)
    },
    carriers: clients.map((one) => ({
      kind: 'stream' as const,
      input: one.input,
      output: one.output,
      allowShutdown: extra?.allowShutdown ?? true,
    })),
  })
  hosts.push(host)
  return { host, client: clients[0]!, clients, sessionsRoot }
}

describe('protocol: handshake and streaming', () => {
  it('initialize returns the server info, the provider catalog, and the default agent options', async () => {
    const { client } = await startHost(new ScriptedAdapter())
    const result = await client.result<{
      serverInfo: { name: string; version: string }
      providers: { id: string; models: { id: string }[] }[]
      defaultAgentOptions: { provider: string; model: string }
    }>('initialize')
    expect(result.serverInfo.name).toBe('minidsh')
    expect(result.providers.some((provider) => provider.id === 'scripted')).toBe(true)
    expect(typeof result.defaultAgentOptions.provider).toBe('string')
    expect(typeof result.defaultAgentOptions.model).toBe('string')
  })

  it('session/prompt creates a session and streams durable frames plus the status projection', async () => {
    const { client } = await startHost(new ScriptedAdapter().script(assistantText('hello from the wire')))
    const result = await client.result<{ sessionId: string; messageId: string }>('session/prompt', {
      text: 'hi',
      agentOptions: SCRIPTED,
    })
    expect(result.sessionId.length).toBeGreaterThan(0)
    expect(result.messageId.length).toBeGreaterThan(0)
    await client.waitForIdle(result.sessionId)
    const types = client.frames().map((frame) => frame.event.type)
    for (const expected of ['turn/start', 'user/message', 'assistant/chunk', 'assistant/message', 'turn/end']) {
      expect(types).toContain(expected)
    }
    expect(client.frames().every((frame) => frame.sessionId === result.sessionId)).toBe(true)
  })

  it('ignores malformed lines and rejects unknown methods with -32601', async () => {
    const { client } = await startHost(new ScriptedAdapter())
    client.raw('this is not json {{{')
    const bad = await client.call('no/such-method')
    expect(bad.error?.code).toBe(-32601)
    const good = await client.result<{ serverInfo: { name: string } }>('initialize')
    expect(good.serverInfo.name).toBe('minidsh')
  })
})

describe('protocol: steering and cancel', () => {
  it('a steer prompt lands at the next step boundary of the running turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = new ScriptedAdapter().script(async () => {
      await gate
      return assistantText('first step')
    }, assistantText('after the steer'))
    const { client } = await startHost(adapter)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'start', agentOptions: SCRIPTED })
    await client.waitFor(() => client.statuses().find((entry) => entry.status === 'running'), 'running status')
    await client.result('session/prompt', { sessionId, text: 'also consider this', mode: 'steer' })
    release()
    await client.waitForIdle(sessionId)
    const userTexts = client
      .frames('user/message')
      .map((frame) => ((frame.event.data.message as { content: { text?: string }[] }).content[0] as { text: string }).text)
    expect(userTexts).toEqual(['start', 'also consider this'])
    // One turn, two steps: the steer stayed inside the running turn.
    expect(client.frames('turn/start')).toHaveLength(1)
  })

  it('session/cancel aborts the running turn, which closes as cancelled', async () => {
    const adapter = new ScriptedAdapter().script(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new LlmError('ABORTED', 'aborted')))
        }),
    )
    const { client } = await startHost(adapter)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hang', agentOptions: SCRIPTED })
    await client.waitFor(() => client.statuses().find((entry) => entry.status === 'running'), 'running status')
    await client.result('session/cancel', { sessionId })
    await client.waitForIdle(sessionId)
    const turnEnd = client.frames('turn/end').at(-1)!
    expect((turnEnd.event.data.reason as { kind: string }).kind).toBe('cancelled')
  })

  /**
   * Compaction reaches the wire as a HUMAN command — it is deliberately not a
   * model-facing tool. The result is honest about doing nothing: a short
   * session has no useful span to summarise, and says so rather than
   * fabricating one.
   */
  it('session/compact answers over the wire and reports when there is nothing to do', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('done'))
    const { client } = await startHost(adapter)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hello', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)

    const result = await client.result<{ kind: string }>('session/compact', { sessionId })
    expect(result.kind).toBe('nothing-to-do')
    // No summary was invented, so no surface event was written.
    expect(client.frames('compaction/applied')).toHaveLength(0)
  })
})

describe('protocol: approvals are the durable frames', () => {
  const touchy = defineTool({
    name: 'touchy',
    description: 'needs approval',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    execute: () => ({ ok: true }),
    render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
  })
  const askForTouchy = (root: Context): void => {
    root.get(TOOLS).register(root, touchy)
    root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'touchy' ? { kind: 'ask', reason: 'careful' } : next()))
  }

  it('answers a live approval by its durable id; a second answer is not-pending', async () => {
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'touchy', {}), assistantText('did it'))
    const { client } = await startHost(adapter, { prepare: askForTouchy })
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'use the tool', agentOptions: SCRIPTED })
    const asked = await client.waitFor(() => client.frames('approval/asked').at(0), 'approval/asked frame')
    const answer = await client.result<{ outcome: string }>('approval/answer', {
      sessionId,
      id: asked.event.data.id as string,
      outcome: 'allowed-once',
    })
    expect(answer.outcome).toBe('accepted')
    await client.waitForIdle(sessionId)
    const decided = client.frames('approval/decided').at(0)!
    expect(decided.event.data.outcome).toBe('allowed-once')
    const result = client.frames('tool/result').at(0)!
    expect(result.event.data.error).toBeUndefined()
    const again = await client.result<{ outcome: string }>('approval/answer', {
      sessionId,
      id: asked.event.data.id as string,
      outcome: 'rejected',
    })
    expect(again.outcome).toBe('not-pending')
  })

  it('host disposal fails a pending approval closed instead of hanging', async () => {
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'touchy', {}))
    const { host, client } = await startHost(adapter, { prepare: askForTouchy })
    await client.result<{ sessionId: string }>('session/prompt', { text: 'use the tool', agentOptions: SCRIPTED })
    await client.waitFor(() => client.frames('approval/asked').at(0), 'approval/asked frame')
    await host.dispose() // must not deadlock on the unanswered prompt
  })
})

describe('protocol: resume over the wire', () => {
  it('prompting a stored session id resumes it in a fresh host, appending to the same file', async () => {
    const first = await startHost(new ScriptedAdapter().script(assistantText('one')))
    const { sessionId } = await first.client.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await first.client.waitForIdle(sessionId)
    await first.host.dispose()
    const file = join(first.sessionsRoot, `${encodeURIComponent(sessionId)}.jsonl`)
    const before = readFileSync(file)

    const second = await startHost(new ScriptedAdapter().script(assistantText('two')), { sessionsRoot: first.sessionsRoot })
    const reply = await second.client.result<{ sessionId: string }>('session/prompt', { sessionId, text: 'more' })
    expect(reply.sessionId).toBe(sessionId)
    await second.client.waitForIdle(sessionId)
    const after = readFileSync(file)
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    const events = await second.client.result<{ events: { type: string; data: { turn?: number } }[] }>('session/events', { sessionId })
    const turns = events.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
    expect(turns).toEqual([1, 2])
    expect(readdirSync(first.sessionsRoot).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1)
  })

  it('two prompts racing the same stored id share one resume instead of colliding', async () => {
    const first = await startHost(new ScriptedAdapter().script(assistantText('one')))
    const { sessionId } = await first.client.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await first.client.waitForIdle(sessionId)
    await first.host.dispose()

    const second = await startHost(new ScriptedAdapter().script(assistantText('two'), assistantText('three')), { sessionsRoot: first.sessionsRoot })
    const [a, b] = await Promise.all([
      second.client.result<{ sessionId: string }>('session/prompt', { sessionId, text: 'first prompt' }),
      second.client.result<{ sessionId: string }>('session/prompt', { sessionId, text: 'second prompt' }),
    ])
    expect(a.sessionId).toBe(sessionId)
    expect(b.sessionId).toBe(sessionId)
    await second.client.waitForIdle(sessionId)
    await second.client.waitFor(
      () => (second.client.frames('turn/end').length >= 2 ? true : undefined),
      'both prompted turns to finish',
    )
    const events = await second.client.result<{ events: { type: string }[] }>('session/events', { sessionId })
    expect(events.events.filter((event) => event.type === 'turn/start')).toHaveLength(3)
  })

  it('session/events serves a cold stored session without resuming it', async () => {
    const first = await startHost(new ScriptedAdapter().script(assistantText('one')))
    const { sessionId } = await first.client.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await first.client.waitForIdle(sessionId)
    await first.host.dispose()

    const second = await startHost(new ScriptedAdapter(), { sessionsRoot: first.sessionsRoot })
    const events = await second.client.result<{ header: { id: string }; events: { type: string }[] }>('session/events', { sessionId })
    expect(events.header.id).toBe(sessionId)
    expect(events.events.some((event) => event.type === 'assistant/message')).toBe(true)
    // fromSeq slices the tail.
    const tail = await second.client.result<{ events: { seq: number }[] }>('session/events', { sessionId, fromSeq: 3 })
    expect(tail.events[0]?.seq).toBe(3)
  })
})

describe('protocol: shutdown', () => {
  it('disposes owned agents to idle, answers, and reports the surface done — the stored log stays clean', async () => {
    const { host, client, sessionsRoot } = await startHost(new ScriptedAdapter().script(assistantText('done')))
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)
    const reply = await client.result<Record<string, never>>('shutdown')
    expect(reply).toEqual({})
    await host.closed
    await host.dispose()
    const file = join(sessionsRoot, `${encodeURIComponent(sessionId)}.jsonl`)
    const lines = readFileSync(file, 'utf8').trim().split('\n').slice(1)
    const lastTurnEnd = lines
      .map((line) => JSON.parse(line) as { type: string; data: { reason?: { kind: string } } })
      .filter((event) => event.type === 'turn/end')
      .at(-1)!
    expect(lastTurnEnd.data.reason?.kind).toBe('completed')
  })
})

describe('protocol: the workspace root is host policy', () => {
  /**
   * `session/prompt.cwd` becomes the immutable `SessionHeader.cwd`, which IS the
   * sandbox workspace root for the session's whole life. It used to be taken
   * verbatim: any client could make the drive root writable under
   * workspace-write. A client may now choose WHERE inside the host's roots.
   */
  it('refuses a cwd outside the host workspace roots, a non-directory, and a relative path; accepts a subdirectory', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    const { client } = await startHost(adapter)
    const init = await client.result<{ workspaceRoots: string[] }>('initialize')
    expect(init.workspaceRoots).toHaveLength(1)
    const root = init.workspaceRoots[0]!

    const outside = tempDir('minidsh-proto-outside-')
    await expect(client.result('session/prompt', { text: 'x', cwd: outside, agentOptions: SCRIPTED })).rejects.toThrow(/must lie inside one of this host's workspace roots/)
    await expect(client.result('session/prompt', { text: 'x', cwd: join(root, 'missing'), agentOptions: SCRIPTED })).rejects.toThrow(/not an existing directory/)
    writeFileSync(join(root, 'file.txt'), 'x')
    await expect(client.result('session/prompt', { text: 'x', cwd: join(root, 'file.txt'), agentOptions: SCRIPTED })).rejects.toThrow(/not an existing directory/)
    await expect(client.result('session/prompt', { text: 'x', cwd: 'sub', agentOptions: SCRIPTED })).rejects.toThrow(/absolute/)

    mkdirSync(join(root, 'sub'))
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hello', cwd: join(root, 'sub'), agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)
    const { header } = await client.result<{ header: { cwd: string } }>('session/events', { sessionId })
    expect(header.cwd.toLowerCase()).toBe(join(root, 'sub').toLowerCase())
  })
})

describe('protocol: the authority control plane', () => {
  it('reports what a new session would start under, and what this host can enforce', async () => {
    const { client } = await startHost(new ScriptedAdapter())
    const result = await client.result<{ defaultAuthority: { sandbox: string; approval: string; enforcement: string } }>('initialize')
    expect(result.defaultAuthority).toEqual({ sandbox: 'workspace-write', approval: 'ask', enforcement: 'none', preset: 'workspace-write' })
  })

  it('switches a live session and streams the switch as the durable event', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    const { client } = await startHost(adapter)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hello', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)

    const view = await client.result<{ sandbox: string; approval: string }>('session/authority', { sessionId, sandbox: 'read-only', approval: 'never' })
    // read-only + never matches no shipped preset: the derived value is `custom`.
    expect(view).toEqual({ sandbox: 'read-only', approval: 'never', enforcement: 'none', preset: 'custom' })

    // Two stamps: the mode the session opened under, then the switch.
    const stamp = await client.waitFor(() => client.frames('sandbox/mode').at(1), 'the switch frame')
    expect(client.frames('sandbox/mode').at(0)!.event.data).toEqual({ mode: 'workspace-write', enforcement: 'none', reason: 'initial' })
    expect(stamp.event.data).toEqual({ mode: 'read-only', enforcement: 'none', reason: 'change' })
    // The policy opened as `ask` at creation; the switch is a change.
    expect(client.frames('approval/policy').map((frame) => frame.event.data)).toEqual([
      { policy: 'ask', reason: 'initial' },
      { policy: 'never', reason: 'change' },
    ])

    // Reading takes no arguments and changes nothing.
    const again = await client.result<{ sandbox: string }>('session/authority', { sessionId })
    expect(again.sandbox).toBe('read-only')
    expect(client.frames('sandbox/mode')).toHaveLength(2)
  })

  it('refuses a mode outside the closed vocabulary', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    const { client } = await startHost(adapter)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hello', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)
    const reply = await client.call('session/authority', { sessionId, sandbox: 'unfenced' })
    expect(reply.error?.code).toBe(-32602)
  })

  it('applies the configured per-agent setup to every agent the surface creates', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    const marker = serviceKey<number>('proto-preset-marker')
    const { host, client } = await startHost(adapter, {
      agentSetup: (agentCtx) => void agentCtx.provide(marker, 7),
    })
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hello', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)
    const agent = host.root.get(AGENTS).get(asSessionId(sessionId))!
    // Scoped to that agent's world; never visible on the root.
    expect(agent.ctx.tryGet(marker)).toBe(7)
    expect(host.root.tryGet(marker)).toBeUndefined()
  })

  it('switches both knobs through one preset, recording the intent durably', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    const { client } = await startHost(adapter)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hello', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)

    const view = await client.result<{ sandbox: string; approval: string; preset?: string }>('session/authority', {
      sessionId,
      preset: 'danger-full-access',
    })
    expect(view).toMatchObject({ sandbox: 'danger-full-access', approval: 'never', preset: 'danger-full-access' })
    // The log-only intent event streamed like any other durable event.
    const intent = await client.waitFor(() => client.frames('authority/preset').at(0), 'the preset intent frame')
    expect(intent.event.data).toEqual({ name: 'danger-full-access' })

    // A preset combined with a knob, and an unknown name, are both refused.
    expect((await client.call('session/authority', { sessionId, preset: 'workspace-write', sandbox: 'read-only' })).error?.code).toBe(-32602)
    expect((await client.call('session/authority', { sessionId, preset: 'nope' })).error?.code).toBe(-32602)
  })
})

describe('the route over the wire', () => {
  it('session/model reads and switches the base route as a durable event, refusing a provider this host lacks', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('hi'), assistantText('again'))
    const { client } = await startHost(adapter)
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'hello', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)
    expect(await client.result('session/model', { sessionId })).toEqual(SCRIPTED)
    const switched = await client.result('session/model', { sessionId, model: 'scripted-2', reasoningEffort: 'low' })
    expect(switched).toEqual({ provider: 'scripted', model: 'scripted-2', reasoningEffort: 'low' })
    const record = await client.waitFor(() => client.frames('agent/options').at(1), 'the switch frame')
    expect(record.event.data).toEqual({ options: { provider: 'scripted', model: 'scripted-2', reasoningEffort: 'low' }, reason: 'change' })
    expect((await client.call('session/model', { sessionId, provider: 'nowhere' })).error?.code).toBe(-32602)
    expect((await client.call('session/model', { sessionId, model: '' })).error?.code).toBe(-32602)
    // A prompt to a live session may carry the same switch; the next step follows it.
    await client.result('session/prompt', { sessionId, text: 'more', agentOptions: { model: 'scripted-3' } })
    await client.waitForIdle(sessionId)
    expect(adapter.calls.map((call) => call.model)).toEqual(['scripted-model', 'scripted-3'])
    expect(client.frames('agent/options')).toHaveLength(3)
  })
})

describe('what the review found', () => {
  it('validates agentOptions on the create path, where they become the session base route', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    const { client } = await startHost(adapter)
    // A step ceiling that is not a number would silently remove the ceiling.
    expect((await client.call('session/prompt', { text: 'go', agentOptions: { ...SCRIPTED, maxSteps: 'lots' } })).error?.code).toBe(-32602)
    expect((await client.call('session/prompt', { text: 'go', agentOptions: { ...SCRIPTED, maxSteps: 0 } })).error?.code).toBe(-32602)
    // A route to nowhere is refused before it becomes a durable fact.
    expect((await client.call('session/prompt', { text: 'go', agentOptions: { provider: 'nowhere', model: 'x' } })).error?.code).toBe(-32602)
    // And a field the vocabulary does not have is named rather than ignored.
    expect((await client.call('session/prompt', { text: 'go', agentOptions: { ...SCRIPTED, effort: 'high' } })).error?.code).toBe(-32602)
    // Nothing was created by any of them.
    expect(client.frames('agent/options')).toHaveLength(0)
    const ok = await client.result<{ sessionId: string }>('session/prompt', { text: 'go', agentOptions: { ...SCRIPTED, maxSteps: 3 } })
    await client.waitForIdle(ok.sessionId)
    expect((client.frames('agent/options')[0]!.event.data as { options: { maxSteps: number } }).options.maxSteps).toBe(3)
  })

  it('records the preset a surface composed its agents from', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('hi'))
    const { host, client } = await startHost(adapter, { agentSetup: () => {}, agentPreset: 'reviewer' })
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'go', agentOptions: SCRIPTED })
    await client.waitForIdle(sessionId)
    const agent = host.root.get(AGENTS).get(asSessionId(sessionId))!
    expect(agent.session.header.agentPreset).toBe('reviewer')
  })
})

describe('protocol: the paged attach', () => {
  /** `turns` completed turns on one session, so a page has something to cut. */
  async function session(turns: number, extra?: Parameters<typeof startHost>[1]) {
    const adapter = new ScriptedAdapter().script(...Array.from({ length: turns }, (_unused, index) => assistantText(`answer ${index + 1}`)))
    const started = await startHost(adapter, extra)
    const { sessionId } = await started.client.result<{ sessionId: string }>('session/prompt', { text: 'turn 1', agentOptions: SCRIPTED })
    await started.client.waitForIdle(sessionId)
    for (let turn = 2; turn <= turns; turn++) {
      await started.client.result('session/prompt', { sessionId, text: `turn ${turn}` })
      await started.client.waitFor(
        () => (started.client.frames('turn/end').filter((frame) => frame.sessionId === sessionId).length >= turn ? true : undefined),
        `turn ${turn} to end`,
      )
    }
    return { ...started, sessionId }
  }

  it('answers with the header, a bounded tail page, the cursor it was cut against, and the folds a page cannot do', async () => {
    const { client, sessionId } = await session(6)
    const attached = await client.result<AttachResult>('session/attach', { sessionId, limit: 2 })

    expect(attached.header.id).toBe(sessionId)
    expect(attached.cursor).toBeGreaterThan(0)
    expect(attached.page.to).toBe(attached.cursor)
    expect(attached.page.hasMore).toBe(true)
    // Two arrived messages, not six turns' worth.
    const arrivals = attached.page.events.filter((event) => event.surfaceOp?.op === 'append')
    expect(arrivals).toHaveLength(2)
    // The folds a partial reader provably cannot compute for itself.
    expect(attached.view.status).toBe('idle')
    expect(attached.view.authority.sandbox).toBe('workspace-write')
    expect(attached.view.pendingApprovals).toEqual([])
    expect(attached.view.options?.model).toBe(SCRIPTED.model)
    expect(attached.view.context?.projectedTokens).toBeGreaterThan(0)
  })

  it('leaves the trace tier out of a page — that is what turns megabytes into kilobytes', async () => {
    const { client, sessionId } = await session(3)
    const attached = await client.result<AttachResult>('session/attach', { sessionId })
    expect(attached.page.events.some((event) => event.type === 'assistant/chunk')).toBe(false)
    // The whole-log read still serves every tier: replay and the audit need it.
    const whole = await client.result<{ events: { type: string }[] }>('session/events', { sessionId })
    expect(whole.events.some((event) => event.type === 'assistant/chunk')).toBe(true)
  })

  it('pages backwards to the head of the log and stops claiming more exactly there', async () => {
    const { client, sessionId } = await session(6)
    const attached = await client.result<AttachResult>('session/attach', { sessionId, limit: 2 })

    const seen: number[] = attached.page.events.map((event) => event.seq)
    let before = attached.page.from
    let hasMore = attached.page.hasMore
    let pages = 1
    while (hasMore) {
      const older = await client.result<PageResult>('session/page', { sessionId, throughSeq: attached.cursor, beforeSeq: before, limit: 2 })
      seen.unshift(...older.page.events.map((event) => event.seq))
      before = older.page.from
      hasMore = older.page.hasMore
      expect(++pages).toBeLessThan(30)
    }
    expect(pages).toBeGreaterThan(1)
    expect(seen[0]).toBe(0)
    // Every fact of the log, once, in order — paging lost nothing and repeated nothing.
    const whole = await client.result<{ events: { type: string; seq: number }[] }>('session/events', { sessionId })
    expect(seen).toEqual(whole.events.filter((event) => event.type !== 'assistant/chunk').map((event) => event.seq))
  })

  it('refuses a page anchored past the cursor the client synchronized on', async () => {
    const { client, sessionId } = await session(2)
    const attached = await client.result<AttachResult>('session/attach', { sessionId })
    const reply = await client.call('session/page', { sessionId, throughSeq: attached.cursor + 5 })
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('past this session')
  })

  it('reads a stored session without resuming it — looking at a transcript must not start an agent', async () => {
    const first = await session(2)
    const { sessionId, sessionsRoot } = first
    await first.host.dispose()

    const second = await startHost(new ScriptedAdapter(), { sessionsRoot })
    const attached = await second.client.result<AttachResult>('session/attach', { sessionId })
    expect(attached.header.id).toBe(sessionId)
    expect(attached.page.events.length).toBeGreaterThan(0)
    expect(attached.view.status).toBe('idle')
    // No agent, and no write lease: the session is still exactly stored.
    expect(second.host.root.get(AGENTS).list()).toHaveLength(0)
    expect(readdirSync(sessionsRoot).filter((name) => name.endsWith('.lock'))).toHaveLength(0)
    // And a second read is served from the same parse.
    const again = await second.client.result<AttachResult>('session/attach', { sessionId })
    expect(again.cursor).toBe(attached.cursor)
  })

  it('publishes the view again whenever a durable fact moves one of its folds', async () => {
    const { client, sessionId } = await session(2)
    const views = client.notifications.filter((entry) => entry.method === 'session.view')
    expect(views.length).toBeGreaterThan(0)
    const last = views.at(-1)!.params as unknown as { sessionId: string; view: SessionView }
    expect(last.sessionId).toBe(sessionId)
    expect(last.view.context?.projectedTokens).toBeGreaterThan(0)
    expect(last.view.authority.enforcement).toBe('none')
  })

  it('serves a gap repair as a range bounded at both ends, with the trace tier dropped', async () => {
    const { client, sessionId } = await session(4)
    const attached = await client.result<AttachResult>('session/attach', { sessionId, limit: 1 })
    expect(attached.page.from).toBeGreaterThan(2)
    const repair = await client.result<{ events: { seq: number; type: string }[] }>('session/events', {
      sessionId,
      fromSeq: 2,
      toSeq: attached.page.from,
      omitTrace: true,
    })
    expect(repair.events[0]!.seq).toBe(2)
    expect(repair.events.at(-1)!.seq).toBeLessThanOrEqual(attached.page.from)
    expect(repair.events.some((event) => event.type === 'assistant/chunk')).toBe(false)
  })

  it('shows an outstanding approval in the view, and drops it once it is decided', async () => {
    const gated = defineTool({
      name: 'gated',
      description: 'needs consent',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    })
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'gated', {}), assistantText('done'))
    const { client } = await startHost(adapter, {
      prepare: (root) => {
        root.get(TOOLS).register(root, gated)
        root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'gated' ? { kind: 'ask' } : next()))
      },
    })
    const { sessionId } = await client.result<{ sessionId: string }>('session/prompt', { text: 'go', agentOptions: SCRIPTED })
    const ask = await client.waitFor(() => client.frames('approval/asked')[0], 'the approval frame')
    const id = ask.event.data.id as string

    const waiting = await client.result<AttachResult>('session/attach', { sessionId })
    expect(waiting.view.pendingApprovals.map((pending) => pending.id)).toEqual([id])
    expect(waiting.view.pendingApprovals[0]!.toolName).toBe('gated')

    await client.result('approval/answer', { sessionId, id, outcome: 'allowed-once' })
    await client.waitForIdle(sessionId)
    const settled = await client.result<AttachResult>('session/attach', { sessionId })
    expect(settled.view.pendingApprovals).toEqual([])
  })
})

describe('protocol: more than one client', () => {
  it('streams one session to every client that has not narrowed away from it', async () => {
    const { clients } = await startHost(new ScriptedAdapter().script(assistantText('for everyone')), { extraClients: 1 })
    const [first, second] = clients as [TestClient, TestClient]
    const { sessionId } = await first.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await first.waitForIdle(sessionId)

    // The second client never asked for anything and still sees the session:
    // an un-narrowed connection receives everything, exactly as before.
    expect(second.frames('assistant/message', sessionId).length).toBeGreaterThan(0)
    expect(second.statuses().some((entry) => entry.sessionId === sessionId)).toBe(true)
  })

  it('narrows a client to the sessions it attached to, and detaching stops delivery', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('one'), assistantText('two'), assistantText('three'))
    const { clients } = await startHost(adapter, { extraClients: 1 })
    const [first, second] = clients as [TestClient, TestClient]
    const { sessionId: watched } = await first.result<{ sessionId: string }>('session/prompt', { text: 'first', agentOptions: SCRIPTED })
    await first.waitForIdle(watched)

    await second.result('session/attach', { sessionId: watched })
    const before = second.frames().length
    // A second session the narrowed client never attached to.
    const { sessionId: other } = await first.result<{ sessionId: string }>('session/prompt', { text: 'second', agentOptions: SCRIPTED })
    await first.waitForIdle(other)
    expect(second.frames(undefined, other)).toHaveLength(0)
    expect(second.frames().length).toBe(before)

    // And detaching stops the one it did attach to.
    await second.result('session/detach', { sessionId: watched })
    const quiet = second.frames().length
    await first.result('session/prompt', { sessionId: watched, text: 'more' })
    await first.waitFor(() => (first.frames('turn/end', watched).length >= 2 ? true : undefined), 'the second turn to end')
    expect(second.frames().length).toBe(quiet)
  })

  it('lets either client answer an approval, and tells the loser it is no longer pending', async () => {
    const gated = defineTool({
      name: 'shared',
      description: 'needs consent',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    })
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'shared', {}), assistantText('done'))
    const { clients } = await startHost(adapter, {
      extraClients: 1,
      prepare: (root) => {
        root.get(TOOLS).register(root, gated)
        root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'shared' ? { kind: 'ask' } : next()))
      },
    })
    const [first, second] = clients as [TestClient, TestClient]
    const { sessionId } = await first.result<{ sessionId: string }>('session/prompt', { text: 'go', agentOptions: SCRIPTED })

    // Both clients see the ask, because the durable event IS the frame.
    const asked = await first.waitFor(() => first.frames('approval/asked')[0], 'the ask on the first client')
    await second.waitFor(() => second.frames('approval/asked')[0], 'the ask on the second client')
    const id = asked.event.data.id as string

    const winner = await second.result<{ outcome: string }>('approval/answer', { sessionId, id, outcome: 'allowed-once' })
    expect(winner.outcome).toBe('accepted')
    const loser = await first.result<{ outcome: string }>('approval/answer', { sessionId, id, outcome: 'rejected' })
    expect(loser.outcome).toBe('not-pending')
    await first.waitForIdle(sessionId)
    // The decision the other client made reaches this one as the durable event.
    expect(first.frames('approval/decided')[0]!.event.data.outcome).toBe('allowed-once')
  })

  it('treats a disconnect as one client leaving, not as a shutdown', async () => {
    const adapter = new ScriptedAdapter().script(assistantText('one'), assistantText('two'))
    const { host, clients } = await startHost(adapter, { extraClients: 1 })
    const [first, second] = clients as [TestClient, TestClient]
    const { sessionId } = await first.result<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED })
    await first.waitForIdle(sessionId)

    // The second client hangs up. The agent it was watching is not its to end.
    second.input.end()
    await first.waitFor(() => (host.root.get(AGENTS).get(asSessionId(sessionId)) ? true : undefined), 'the agent to still be live')
    await first.result('session/prompt', { sessionId, text: 'still here?' })
    await first.waitFor(() => (first.frames('turn/end', sessionId).length >= 2 ? true : undefined), 'the second turn to end')
    expect(host.root.get(AGENTS).get(asSessionId(sessionId))).toBeDefined()
  })

  it('settles an approval nobody is left to answer, rather than parking the agent forever', async () => {
    const gated = defineTool({
      name: 'gated',
      description: 'needs consent',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    })
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'gated', {}), assistantText('done'))
    const { clients } = await startHost(adapter, {
      extraClients: 1,
      prepare: (root) => {
        root.get(TOOLS).register(root, gated)
        root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'gated' ? { kind: 'ask' } : next()))
      },
    })
    const [first, second] = clients as [TestClient, TestClient]
    const { sessionId } = await first.result<{ sessionId: string }>('session/prompt', { text: 'go', agentOptions: SCRIPTED })
    await first.waitFor(() => first.frames('approval/asked', sessionId)[0], 'the ask')
    // Only the second client is watching this session now.
    await first.result('session/detach', { sessionId })
    // It is genuinely parked: nothing has decided it.
    expect(first.frames('approval/decided', sessionId)).toHaveLength(0)

    second.input.end()
    // With its last possible answerer gone the question is closed, and the turn
    // finishes instead of hanging on someone who will never look. Polled by
    // re-reading the view, because this client stopped receiving frames.
    const deadline = Date.now() + 5000
    let settled: AttachResult | undefined
    for (;;) {
      const attached = await first.result<AttachResult>('session/attach', { sessionId })
      if (attached.view.status === 'idle' && attached.view.pendingApprovals.length === 0) {
        settled = attached
        break
      }
      if (Date.now() > deadline) throw new Error(`the approval never settled: ${JSON.stringify(attached.view)}`)
      // Re-attaching to read the view widened this client's watch set again; step back out.
      await first.result('session/detach', { sessionId })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const decided = settled.page.events.filter((event) => event.type === 'approval/decided')
    expect(decided).toHaveLength(1)
  })

  it('refuses shutdown from a carrier that does not own the process', async () => {
    const { client } = await startHost(new ScriptedAdapter(), { allowShutdown: false })
    const reply = await client.call('shutdown')
    expect(reply.error?.code).toBe(-32602)
    expect(reply.error?.message).toContain('may not shut the host down')
    // And the host is still serving.
    const init = await client.result<{ serverInfo: { name: string } }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')
  })

  /** Every user message this client saw enter the session, in order. */
  const entered = (client: TestClient, sessionId: string): string[] =>
    client.frames('user/message', sessionId).map((frame) => ((frame.event.data.message as { content: { text?: string }[] }).content[0] as { text: string }).text)

  async function cancelRace(keepQueued: boolean): Promise<{ first: TestClient; sessionId: string }> {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = new ScriptedAdapter().script(
      async () => {
        await gate
        return assistantText('the interrupted turn')
      },
      assistantText('a'),
      assistantText('b'),
      assistantText('c'),
    )
    const { clients } = await startHost(adapter, { extraClients: 1 })
    const [first, second] = clients as [TestClient, TestClient]
    const { sessionId } = await first.result<{ sessionId: string }>('session/prompt', { text: 'start', agentOptions: SCRIPTED })
    await first.waitFor(() => first.statuses().find((entry) => entry.status === 'running'), 'the turn to start')

    // The other client queues work; then this one cancels the running turn.
    await second.result('session/prompt', { sessionId, text: 'the other client work' })
    await first.result('session/cancel', { sessionId, ...(keepQueued ? { keepQueued: true } : {}) })
    release()
    return { first, sessionId }
  }

  it('does not discard another client work when a cancel says the queue is not its own', async () => {
    const { first, sessionId } = await cancelRace(true)
    await first.waitFor(() => (entered(first, sessionId).includes('the other client work') ? true : undefined), 'the queued prompt to be entered')
  })

  it('still forgets the queue on a plain cancel, which is what one client at a keyboard means', async () => {
    const { first, sessionId } = await cancelRace(false)
    // The inbox is FIFO, so anything that survived would run BEFORE this does:
    // seeing this one entered without the other proves the queue was cleared.
    await first.result('session/prompt', { sessionId, text: 'sent after the cancel' })
    await first.waitFor(() => (entered(first, sessionId).includes('sent after the cancel') ? true : undefined), 'the later prompt to be entered')
    expect(entered(first, sessionId)).not.toContain('the other client work')
  })
})
