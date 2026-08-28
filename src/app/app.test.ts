import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  /**
   * A cross-capability claim, tested against the FULL composition: the
   * composition record, the opening authority stamps and the persistence
   * provider all act at agent creation, and only their interplay decides
   * whether an abandoned session litters the home. It used to (the record made
   * every session "recorded a fact"); materialization on the first conversation
   * fact is what makes the claim true again.
   */
  it('an agent created and disposed without a prompt leaves no session file under the full composition', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const sessionsRoot = tempDir('minidsh-sessions-')
    const { bootComposition } = await import('./headless.ts')
    const { AGENTS } = await import('../core/agent/index.ts')
    const adapter = new ScriptedAdapter().script(assistantText('hello'))
    const root = await bootComposition({ sessionsRoot, logger: silent, ...scripted(adapter) })
    try {
      const agents = root.get(AGENTS)
      const abandoned = await agents.create(root, { cwd, agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      // Stamps were recorded, the log is not empty — and still nothing is stored.
      expect(abandoned.agent.session.events.map((event) => event.type)).toEqual(['approval/policy', 'sandbox/mode', 'composition/applied'])
      await abandoned.dispose()
      expect(readdirSync(sessionsRoot)).toEqual([])

      const { createUserMessage } = await import('../core/llm/message.ts')
      const used = await agents.create(root, { cwd, agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      used.agent.followup(createUserMessage('hi'))
      await used.agent.whenIdle()
      await used.dispose()
      const files = readdirSync(sessionsRoot).filter((name) => name.endsWith('.jsonl'))
      expect(files).toHaveLength(1)
      const lines = readFileSync(join(sessionsRoot, files[0]!), 'utf8').trim().split('\n')
      expect(lines.slice(1, 4).map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(['approval/policy', 'sandbox/mode', 'composition/applied'])
    } finally {
      await root.dispose()
    }
  })

  it('refuses a row config outside the plugin contract at boot, naming the row and the key', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const sessionsRoot = tempDir('minidsh-sessions-')
    const adapter = new ScriptedAdapter().script(assistantText('never'))
    // A typo'd authority mode used to settle green and then reject every write
    // as an INVARIANT error; a stale key (the S5 rename) used to be silently
    // ignored and take the default.
    await expect(
      runTask({ task: 'x', cwd, model: 'scripted-model', sessionsRoot, logger: silent, ...scripted(adapter), patches: [{ id: 'sandbox', config: { mode: 'full' } }] }),
    ).rejects.toThrowError(/failed: \[core-sandbox: plugin "core-sandbox": invalid config: .*mode/s)
    await expect(
      runTask({ task: 'x', cwd, model: 'scripted-model', sessionsRoot, logger: silent, ...scripted(adapter), patches: [{ id: 'shell', config: { dialect: 'bash', maxOutputChars: 1 } }] }),
    ).rejects.toThrowError(/shell-stdio.*invalid config.*maxOutputChars/s)
  })

  it('a rejected reconfigure keeps the last good instance running', async () => {
    const sessionsRoot = tempDir('minidsh-sessions-')
    const { bootComposition } = await import('./headless.ts')
    const { COMPOSITION } = await import('./compose.ts')
    const { TOOLS } = await import('../core/tools/index.ts')
    const root = await bootComposition({ sessionsRoot, logger: silent, ...scripted(new ScriptedAdapter()) })
    try {
      const composition = root.get(COMPOSITION)
      await expect(composition.reconfigure('tool-editor', { maxOutputChars: 'lots' })).rejects.toThrowError(/cannot reconfigure row "tool-editor": invalid config/)
      // The old instance was never disposed: the editor is still registered.
      expect(root.get(TOOLS).get('str_replace_editor')).toBeDefined()
      await composition.reconfigure('tool-editor', { maxOutputChars: 500 })
      expect(root.get(TOOLS).get('str_replace_editor')).toBeDefined()
    } finally {
      await root.dispose()
    }
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

  it('refuses in `config` what a boot would refuse: a row config outside its plugin contract', async () => {
    const home = tempDir('minidsh-home-')
    const previousHome = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ id: 'sandbox', config: { mode: 'full' } }] }))
    const out: string[] = []
    const err: string[] = []
    const writeOut = process.stdout.write.bind(process.stdout)
    const writeErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((text: string) => (out.push(text), true)) as typeof process.stdout.write
    process.stderr.write = ((text: string) => (err.push(text), true)) as typeof process.stderr.write
    let code: number
    let jsonCode: number
    try {
      code = await main(['config'])
      jsonCode = await main(['config', '--json'])
    } finally {
      process.stdout.write = writeOut
      process.stderr.write = writeErr
      if (previousHome === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previousHome
    }
    expect(code).toBe(1)
    expect(err.join('')).toMatch(/error: row "sandbox" \(core-sandbox\): invalid config: mode/)
    expect(jsonCode).toBe(1)
    expect(out.join('')).toMatch(/"invalidConfig": "mode/)
  })

  it('marks provenance only for a patch that changes a row: a byte-identical restatement stays built-in', async () => {
    const { applyLayers } = await import('./config.ts')
    const { defineRow } = await import('./compose.ts')
    const plugin = { name: 'p', apply: () => {} }
    const base = [defineRow('a', plugin, { x: 1, y: [1, 2] }), defineRow('b', plugin, { x: 2 })]
    const effective = applyLayers(
      base,
      [
        { name: 'home', patches: [{ id: 'a', config: { y: [1, 2], x: 1 } }, { id: 'b', disabled: false }] },
        { name: 'patch', patches: [{ id: 'b', config: { x: 3 } }] },
      ],
      () => {},
    )
    expect(effective.provenance.get('a')).toBe('built-in')
    expect(effective.provenance.get('b')).toBe('patch')
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
