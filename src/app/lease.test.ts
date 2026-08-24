/**
 * The write lease must reach `agents.resume` as a rejection BEFORE any paid
 * work — publication effects run in a contained emit, so without the factory's
 * resumed-publication flush the refusal would surface only at turn-end, after
 * a full model turn with real tool effects.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { AGENTS } from '../core/agent/index.ts'
import { LLM } from '../core/llm/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { assistantText, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { bootComposition } from './headless.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

let dirs: string[] = []
let roots: Context[] = []

afterEach(async () => {
  for (const root of roots.toReversed()) await root.dispose()
  roots = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function boot(sessionsRoot: string, adapter: ScriptedAdapter): Promise<Context> {
  const root = await bootComposition({
    sessionsRoot,
    logger: silent,
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (ctx) => void ctx.get(LLM).registerAdapter(ctx, adapter),
  })
  roots.push(root)
  return root
}

describe('the session write lease at agents.resume', () => {
  it('a second composition is refused before any work, and takes over after release', async () => {
    const sessionsRoot = tempDir('minidsh-lease-app-')
    const cwd = tempDir('minidsh-lease-cwd-')
    const defaults = { provider: 'scripted', model: 'scripted-model' }

    const rootA = await boot(sessionsRoot, new ScriptedAdapter().script(assistantText('first')))
    const handleA = await rootA.get(AGENTS).create(rootA, { cwd, agentOptions: defaults })
    handleA.agent.followup(createUserMessage('hello'))
    await handleA.agent.whenIdle()
    const id = handleA.agent.id
    const file = join(sessionsRoot, `${encodeURIComponent(id)}.jsonl`)
    const before = readFileSync(file)

    const rootB = await boot(sessionsRoot, new ScriptedAdapter().script(assistantText('second')))
    await expect(rootB.get(AGENTS).resume(rootB, id, { defaults })).rejects.toThrow(/locked by pid/)
    // Rolled back unannounced: no live agent in B, stored log byte-identical.
    expect(rootB.get(AGENTS).get(id)).toBeUndefined()
    expect(readFileSync(file).equals(before)).toBe(true)

    // Release by disposing the holder; the same resume then succeeds.
    await handleA.dispose()
    const handleB = await rootB.get(AGENTS).resume(rootB, id, { defaults })
    expect(handleB.agent.id).toBe(id)
    // The resumed lifecycle attached append-only: the old bytes are a prefix.
    const after = readFileSync(file)
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    await handleB.dispose()
  })
})
