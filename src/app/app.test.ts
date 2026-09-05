import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
import { ScriptedAdapter, assistantText, assistantToolCall } from '../test-support/scripted-adapter.ts'
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
      expect(abandoned.agent.session.events.map((event) => event.type)).toEqual(['agent/options', 'approval/policy', 'sandbox/mode', 'composition/applied'])
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
      expect(lines.slice(1, 5).map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(['agent/options', 'approval/policy', 'sandbox/mode', 'composition/applied'])
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

  /**
   * A cross-capability claim, so it belongs against the FULL composition: the
   * attachment plane exists wherever MiniDSH runs, but the model-facing tools
   * that produce images do not, so the shipped tool surface is unchanged. And
   * the store creates nothing until something is saved — the same discipline
   * as a session that opened and was abandoned leaving no file behind.
   */
  it('ships the attachment service and no new model-facing tool', async () => {
    const sessionsRoot = tempDir('minidsh-sessions-')
    const attachmentsRoot = tempDir('minidsh-attachments-')
    const { bootComposition } = await import('./headless.ts')
    const { ATTACHMENTS } = await import('../core/attachments/index.ts')
    const { TOOLS } = await import('../core/tools/index.ts')
    const root = await bootComposition({ sessionsRoot, attachmentsRoot, logger: silent, ...scripted(new ScriptedAdapter()) })
    try {
      expect(root.tryGet(ATTACHMENTS)).toBeDefined()
      // The shell tool is named after the host dialect, so name it that way
      // rather than pinning one platform.
      const { defaultDialect } = await import('./compose.ts')
      // `history_read` is registered in the globals so a compaction summary can
      // name it, and hidden from every agent until that agent's first applied
      // compaction — so what an agent is OFFERED is the shorter list, asserted
      // in the recall capability's own tests.
      expect(root.get(TOOLS).schemas().map((schema) => schema.name).toSorted()).toEqual(
        [defaultDialect(), 'str_replace_editor', 'subagent', 'history_read'].toSorted(),
      )
      expect(readdirSync(attachmentsRoot)).toEqual([])
    } finally {
      await root.dispose()
    }
  })

  it('mounts no attachment service when the deployment names no store', async () => {
    const sessionsRoot = tempDir('minidsh-sessions-')
    const { bootComposition } = await import('./headless.ts')
    const { ATTACHMENTS } = await import('../core/attachments/index.ts')
    const root = await bootComposition({ sessionsRoot, logger: silent, ...scripted(new ScriptedAdapter()) })
    try {
      expect(root.tryGet(ATTACHMENTS)).toBeUndefined()
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
  /**
   * The local-first answer to "let me look at the image": the object is on this
   * disk, so `sessions show` names where. It is also the only runtime consumer
   * of `Attachments.hostPath`, which is what keeps that method an honest part of
   * the seam rather than a test affordance — and it reads through the EFFECTIVE
   * attachments row for the same reason the read path already mounts the
   * effective persistence row.
   */
  it('names where each image in a stored session lives', async () => {
    const home = tempDir('minidsh-home-')
    const cwd = tempDir('minidsh-cwd-')
    const previousHome = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    const { quadPng } = await import('../test-support/images.ts')
    const { createHash } = await import('node:crypto')
    const { ATTACHMENTS } = await import('../core/attachments/index.ts')
    const { bootComposition } = await import('./headless.ts')
    const { AGENTS } = await import('../core/agent/index.ts')
    const { createUserMessage } = await import('../core/llm/message.ts')
    const { imageDescriptor } = await import('../core/llm/content.ts')
    const { TOOLS, defineTool } = await import('../core/tools/index.ts')
    const { z } = await import('zod')
    const png = quadPng(32)
    const digest = createHash('sha256').update(png).digest('hex')

    const adapter = new ScriptedAdapter()
    const root = await bootComposition({
      sessionsRoot: join(home, 'sessions'),
      attachmentsRoot: join(home, 'attachments'),
      logger: silent,
      ...scripted(adapter),
    })
    let sessionId = ''
    try {
      // A tool that produces an image, so the stored log carries a real ref.
      const ref = await root.get(ATTACHMENTS).saveImage({ data: png, name: 'quad.png' })
      root.get(TOOLS).register(
        root,
        defineTool({
          name: 'emit_image',
          description: 'emit',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          render: () => [{ type: 'image', attachment: ref, text: imageDescriptor(ref) }],
          execute: () => ({ ok: true }),
        }),
      )
      adapter.script(assistantToolCall('c1', 'emit_image', {}), assistantText('done'))
      const handle = await root.get(AGENTS).create(root, { cwd, agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      sessionId = handle.agent.id
      handle.agent.followup(createUserMessage('go'))
      await handle.agent.whenIdle()
      await handle.agent.session.flush()
      await handle.dispose()
    } finally {
      await root.dispose()
    }

    const chunks: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((text: string) => {
      chunks.push(text)
      return true
    }) as typeof process.stdout.write
    let code: number
    try {
      code = await main(['sessions', 'show', sessionId])
    } finally {
      process.stdout.write = write
      if (previousHome === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previousHome
    }
    expect(code).toBe(0)
    const out = chunks.join('')
    // The descriptor on the result row, and the path to the bytes beneath it.
    expect(out).toContain('32×32')
    expect(out, `no host path in:\n${out}`).toContain(join('attachments', 'v1', 'objects', digest.slice(0, 2), digest))
  })

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

describe('what the review found', () => {
  it('drops a settings effort when a flag changes the route, instead of sending it to a provider that refuses it', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const adapter = new ScriptedAdapter().script(assistantText('ok'))
    const seen: (string | undefined)[] = []
    const result = await runTask({
      task: 'go',
      cwd,
      // The settings named an effort for ANOTHER provider's model.
      agentDefaults: { provider: 'anthropic', model: 'claude-sonnet-5', reasoningEffort: 'xhigh' },
      provider: 'scripted',
      model: 'scripted-model',
      sessionsRoot: tempDir('minidsh-sessions-'),
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root) => {
        root.get(LLM).registerAdapter(root, adapter)
      },
    })
    seen.push(adapter.calls[0]?.reasoningEffort)
    expect(result.exitCode).toBe(0)
    // An effort id belongs to the adapter that defined it: the route changed, so it is gone.
    expect(seen).toEqual([undefined])
  })

  it('records the agent preset a session was composed from, so a resume can compose the same world', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const sessionsRoot = tempDir('minidsh-sessions-')
    const adapter = new ScriptedAdapter().script(assistantText('done'))
    const result = await runTask({
      task: 'go',
      cwd,
      model: 'scripted-model',
      provider: 'scripted',
      agentPreset: 'reviewer',
      sessionsRoot,
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root) => void root.get(LLM).registerAdapter(root, adapter),
    })
    expect(result.exitCode).toBe(0)
    const file = readdirSync(sessionsRoot).find((name) => name.endsWith('.jsonl'))!
    const header = JSON.parse(readFileSync(join(sessionsRoot, file), 'utf8').split('\n')[0]!) as { agentPreset?: string }
    expect(header.agentPreset).toBe('reviewer')
  })
})

describe('the CLI front door', () => {
  const quiet = async (run: () => Promise<number>): Promise<number> => {
    const out = process.stdout.write.bind(process.stdout)
    const err = process.stderr.write.bind(process.stderr)
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      return await run()
    } finally {
      process.stdout.write = out
      process.stderr.write = err
    }
  }

  /**
   * The one place a person meets a stored session without already knowing its
   * id. Nothing asserted this output before S10; the name is why it is worth
   * asserting now.
   */
  it('names each stored session in a listing, beside its id', async () => {
    const home = tempDir('minidsh-home-')
    const cwd = tempDir('minidsh-cwd-')
    const previous = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    const adapter = new ScriptedAdapter()
    adapter.script(assistantText('done'))
    const lines: string[] = []
    const out = process.stdout.write.bind(process.stdout)
    try {
      await runTask({ task: 'teach the parser about trailing commas', cwd, model: 'scripted-model', sessionsRoot: join(home, 'sessions'), logger: silent, ...scripted(adapter) })
      process.stdout.write = ((chunk: string | Uint8Array) => {
        lines.push(String(chunk))
        return true
      }) as typeof process.stdout.write
      expect(await main(['sessions', 'list'])).toBe(0)
    } finally {
      process.stdout.write = out
      if (previous === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previous
    }
    const [row] = lines.join('').trimEnd().split(String.fromCharCode(10))
    const columns = row!.split(String.fromCharCode(9))
    // id, when, cwd, name — the three that were here before keep their places.
    expect(columns).toHaveLength(4)
    expect(columns[0]).toMatch(/^session-/)
    expect(columns[3]).toBe('teach the parser about trailing commas')
  })

  it('treats --help and -h as help, which is never a usage error', async () => {
    expect(await quiet(() => main(['--help']))).toBe(0)
    expect(await quiet(() => main(['-h']))).toBe(0)
    expect(await quiet(() => main([]))).toBe(0)
    // An unknown command still prints the help and fails.
    expect(await quiet(() => main(['frobnicate']))).toBe(2)
  })

  it('refuses an authority flag on a command that only reads stored logs, instead of accepting and ignoring it', async () => {
    expect(await quiet(() => main(['sessions', 'list', '--sandbox', 'read-only']))).toBe(2)
    expect(await quiet(() => main(['sessions', 'list', '--ask', 'never']))).toBe(2)
  })

  it('is help after a command too, and never a paid run with the task "-h"', async () => {
    expect(await quiet(() => main(['run', '--help']))).toBe(0)
    expect(await quiet(() => main(['run', '-h']))).toBe(0)
    expect(await quiet(() => main(['chat', '--help']))).toBe(0)
    expect(await quiet(() => main(['web', '-h']))).toBe(0)
  })

  it('refuses a flag a command does not list, for every command in the table', async () => {
    // `resume <id> --at 12` used to resume at the log head silently; `chat --json` printed a terminal.
    for (const command of ['run', 'chat', 'resume', 'fork', 'serve', 'web', 'config', 'sessions']) {
      expect(await quiet(() => main([command, 'x', '--frobnicate']))).toBe(2)
    }
    expect(await quiet(() => main(['resume', 'some-id', '--at', '12']))).toBe(2)
    expect(await quiet(() => main(['chat', '--json']))).toBe(2)
  })

  it('prints a layer warning exactly once, and a malformed layer is a usage error', async () => {
    const home = tempDir('minidsh-home-')
    const previous = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    const lines: string[] = []
    const out = process.stdout.write.bind(process.stdout)
    const err = process.stderr.write.bind(process.stderr)
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ id: 'ghost', disabled: true }] }), 'utf8')
      expect(await main(['config'])).toBe(0)
      expect(lines.filter((line) => line.includes('unknown row id "ghost"'))).toHaveLength(1)
      lines.length = 0
      expect(await main(['sessions', 'list'])).toBe(0)
      expect(lines.filter((line) => line.includes('unknown row id "ghost"'))).toHaveLength(1)
      // A duplicate id is half-patchable, so the layer is refused before anything boots.
      writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ insert: [{ id: 'sandbox', plugin: 'core-sandbox' }] }] }), 'utf8')
      lines.length = 0
      expect(await main(['config'])).toBe(2)
      expect(lines.join('')).toContain('duplicate row id "sandbox"')
    } finally {
      process.stdout.write = out
      process.stderr.write = err
      if (previous === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previous
    }
  })
})
