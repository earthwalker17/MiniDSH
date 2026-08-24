import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
import { ScriptedAdapter, assistantText } from '../test-support/scripted-adapter.ts'
import { main } from './cli.ts'
import { runTask } from './headless.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A prepare hook that swaps DeepSeek for a scripted adapter. */
function scripted(adapter: ScriptedAdapter): { patches: [{ id: string; disabled: true }]; prepare: (root: Context) => void; provider: string } {
  return {
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root) => void root.get(LLM).registerAdapter(root, adapter),
    provider: 'scripted',
  }
}

describe('headless runner (real composition, scripted model)', () => {
  it('runs a task end to end, returns the final text, and persists the log', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const sessionsRoot = tempDir('minidsh-sessions-')
    const adapter = new ScriptedAdapter().script(assistantText('all done'))
    const events: string[] = []
    const frames: { sessionId: string; event: { type: string } }[] = []
    const result = await runTask(
      { task: 'do the thing', cwd, model: 'scripted-model', sessionsRoot, logger: silent, ...scripted(adapter) },
      (frame) => {
        events.push(frame.event.type)
        frames.push(frame)
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.reason).toBe('completed')
    expect(result.text).toBe('all done')
    expect(events).toContain('turn/start')
    expect(events).toContain('assistant/message')
    // The stream is the wire envelope: {sessionId, event}, sessionId first.
    expect(frames.every((frame) => frame.sessionId === result.sessionId)).toBe(true)
    expect(JSON.stringify(frames[0]).startsWith('{"sessionId":')).toBe(true)
    // The session was persisted as JSONL.
    const files = readdirSync(sessionsRoot).filter((name) => name.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
  })

  it('fails loud when a required provider cannot settle', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const sessionsRoot = tempDir('minidsh-sessions-')
    // Disable the agent registry so the loop cannot settle.
    await expect(
      runTask({ task: 'x', cwd, model: 'scripted-model', sessionsRoot, logger: silent, patches: [{ id: 'agent', disabled: true }] }),
    ).rejects.toThrowError(/did not settle/)
  })
})

describe('cli surface', () => {
  it('prints the effective composition with provenance, without a network call', async () => {
    const home = tempDir('minidsh-home-')
    const previousHome = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ id: 'llm-retry', disabled: true }] }))
    const chunks: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((text: string) => {
      chunks.push(text)
      return true
    }) as typeof process.stdout.write
    let code: number
    try {
      code = await main(['config', '--json'])
    } finally {
      process.stdout.write = write
      if (previousHome === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previousHome
    }
    expect(code).toBe(0)
    const parsed = JSON.parse(chunks.join('')) as {
      hash: string
      layers: string[]
      rows: { id: string; plugin: string; disabled?: boolean; layer: string }[]
    }
    expect(parsed.layers).toEqual(['built-in', 'home'])
    expect(parsed.rows.some((row) => row.id === 'loop' && row.plugin === 'core-agent-loop' && row.layer === 'built-in')).toBe(true)
    // The home layer's touch is visible as provenance, not silently merged away.
    const retry = parsed.rows.find((row) => row.id === 'llm-retry')
    expect(retry).toMatchObject({ disabled: true, layer: 'home' })
  })

  it('prints help and returns 0', async () => {
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      expect(await main(['help'])).toBe(0)
    } finally {
      process.stdout.write = write
    }
  })
})
