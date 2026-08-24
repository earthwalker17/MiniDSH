/** The client protocol, exercised byte-level over an in-memory duplex pair. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { LLM, LlmError } from '../../core/llm/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE, type PreToolDecision } from '../../core/tools/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { startProtocolHost, type ProtocolHostHandle } from '../../app/serve.ts'

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

  frames(type?: string): { sessionId: string; event: { type: string; data: Record<string, unknown> } }[] {
    return this.notifications
      .filter((entry) => entry.method === 'session.event')
      .map((entry) => entry.params as { sessionId: string; event: { type: string; data: Record<string, unknown> } })
      .filter((frame) => type === undefined || frame.event.type === type)
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
  extra?: { sessionsRoot?: string; prepare?: (root: Context) => void; approve?: boolean },
): Promise<{ host: ProtocolHostHandle; client: TestClient; sessionsRoot: string }> {
  const client = new TestClient()
  const sessionsRoot = extra?.sessionsRoot ?? tempDir('minidsh-proto-sessions-')
  const host = await startProtocolHost({
    cwd: tempDir('minidsh-proto-cwd-'),
    sessionsRoot,
    logger: silent,
    ...(extra?.approve === undefined ? {} : { approve: extra.approve }),
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root) => {
      root.get(LLM).registerAdapter(root, adapter)
      extra?.prepare?.(root)
    },
    input: client.input,
    output: client.output,
  })
  hosts.push(host)
  return { host, client, sessionsRoot }
}

describe('protocol-stdio: handshake and streaming', () => {
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

describe('protocol-stdio: steering and cancel', () => {
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
})

describe('protocol-stdio: approvals are the durable frames', () => {
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

describe('protocol-stdio: resume over the wire', () => {
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

describe('protocol-stdio: shutdown', () => {
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

describe('protocol-stdio: the authority control plane', () => {
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
    const policy = client.frames('approval/policy').at(-1)!
    expect(policy.event.data).toEqual({ policy: 'never', reason: 'initial' })

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
