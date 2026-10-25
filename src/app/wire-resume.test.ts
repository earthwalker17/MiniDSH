/**
 * What a wire RESUME composes, end to end over the real protocol host
 * (`minidsh serve`'s assembly). Two claims of ARCHITECTURE §9 that held on the
 * CLI path and not on the wire (S20.5 audit, A7-5 and A7-6):
 *
 * - the agent preset is named in the header "so a resume composes the same
 *   world" — a host with another preset ran ITS world under the old header;
 * - an explicit authority flag is a durable switch "on resume too" — a
 *   `serve --sandbox read-only` host continued a stored session at its
 *   recorded, wider mode.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { APPROVAL } from '../core/approval/index.ts'
import { asSessionId } from '../core/ids.ts'
import { LLM } from '../core/llm/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { SANDBOX } from '../core/sandbox/index.ts'
import { assistantText, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { startProtocolHost, type ProtocolHostHandle } from './serve.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
let base: string | undefined
const hosts: ProtocolHostHandle[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  base = undefined
})

interface Reply {
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
}

async function startHost(sessionsRoot: string, cwd: string, extra: Record<string, unknown>) {
  const input = new PassThrough()
  const output = new PassThrough()
  const replies = new Map<number, (reply: Reply) => void>()
  const statuses: { sessionId: string; status: string }[] = []
  createInterface({ input: output }).on('line', (line) => {
    const frame = JSON.parse(line) as { id?: number; method?: string; params?: { sessionId: string; status: string } } & Reply
    if (frame.id !== undefined) replies.get(frame.id)?.(frame)
    else if (frame.method === 'session.status' && frame.params) statuses.push(frame.params)
  })
  let next = 0
  const call = (method: string, params?: unknown): Promise<Reply> =>
    new Promise((resolve) => {
      const id = ++next
      replies.set(id, resolve)
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const handle = await startProtocolHost({
    confinement: 'none',
    cwd,
    sessionsRoot,
    logger: silent,
    agentDefaults: { provider: 'scripted', model: 'scripted-model' },
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root: Context) => void root.get(LLM).registerAdapter(root, new ScriptedAdapter().script(assistantText('one'), assistantText('two'))),
    input,
    output,
    ...extra,
  })
  hosts.push(handle)
  const idle = async (sessionId: string): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const mine = statuses.filter((status) => status.sessionId === sessionId)
      if (mine.some((status) => status.status === 'running') && mine.at(-1)?.status === 'idle') return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`session ${sessionId} never went idle`)
  }
  return { handle, call, idle }
}

describe('a wire resume', () => {
  // The S20.5 review: the host's explicit flags were applied one by one, so a
  // delegated child's pin refused the approval after the narrowed mode had
  // landed, and the client was answered -32603.
  it('refuses flags a stored delegated child cannot take, whole, before any of them lands', async () => {
    base = mkdtempSync(join(tmpdir(), 'minidsh-wire-resume-'))
    const sessionsRoot = join(base, 'sessions')
    let root!: Context
    const first = await startHost(sessionsRoot, base, {
      prepare: (r: Context) => {
        root = r
        void r.get(LLM).registerAdapter(r, new ScriptedAdapter().script(assistantText('one'), assistantText('two')))
      },
    })
    const child = await root.get(AGENTS).create(root, {
      cwd: base,
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      delegatedBy: asSessionId('session-parent-gone'),
      setup: (_ctx, agent) => {
        root.get(SANDBOX).open(agent.session, { mode: 'workspace-write', reason: 'delegation' })
        root.get(APPROVAL).open(agent.session, { policy: 'never', reason: 'delegation' })
      },
    })
    child.agent.followup(createUserMessage('hi'))
    await child.agent.whenIdle()
    const childId = child.agent.id
    await child.dispose()
    await first.handle.dispose()
    const file = join(sessionsRoot, `${childId}.jsonl`)
    const authorityFacts = (): string[] =>
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .slice(1)
        .filter((line) => line.includes('"type":"sandbox/') || line.includes('"type":"approval/'))
    const before = authorityFacts()

    const strict = await startHost(sessionsRoot, base, { sandbox: 'read-only', approvalPolicy: 'ask' })
    const refused = await strict.call('session/prompt', { sessionId: childId, text: 'again' })
    expect(refused.error).toMatchObject({ code: -32602, message: expect.stringContaining('pinned "never"') })
    // No authority fact landed (the resume's own opening records are the resume's).
    expect(authorityFacts()).toEqual(before)
    expect(before.length).toBeGreaterThan(0)
  })

  it('composes the preset its header names, and applies the host\'s explicit authority flags', async () => {
    base = mkdtempSync(join(tmpdir(), 'minidsh-wire-resume-'))
    const sessionsRoot = join(base, 'sessions')
    const world = (): void => {}
    const first = await startHost(sessionsRoot, base, { agentWorld: world, agentPreset: 'reviewer' })
    const created = await first.call('session/prompt', { text: 'hi' })
    const sessionId = created.result!.sessionId as string
    await first.idle(sessionId)
    await first.handle.dispose()

    const other = await startHost(sessionsRoot, base, { agentWorld: world, agentPreset: 'builder' })
    const refused = await other.call('session/prompt', { sessionId, text: 'again' })
    expect(refused.error?.message).toMatch(/agent preset "reviewer"/)
    await other.handle.dispose()

    const strict = await startHost(sessionsRoot, base, { agentWorld: world, agentPreset: 'reviewer', sandbox: 'read-only' })
    const resumed = await strict.call('session/prompt', { sessionId, text: 'again' })
    expect(resumed.error).toBeUndefined()
    await strict.idle(sessionId)
    const authority = await strict.call('session/authority', { sessionId })
    expect(authority.result).toMatchObject({ sandbox: 'read-only' })
  })
})
