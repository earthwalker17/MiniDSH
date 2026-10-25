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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
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
