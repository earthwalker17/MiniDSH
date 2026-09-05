/**
 * Authority through a real composition: what the model proposes, what policy
 * decides, and what the log records. Assertions are about the world and the
 * durable log — never the agent's own account of what it did.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
import { SANDBOX_MODE } from '../core/sandbox/index.ts'
import { matches, type EventEnvelope } from '../core/session/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { AGENTS } from '../core/agent/index.ts'
import { PROMPT } from '../core/prompt/index.ts'
import { SANDBOX } from '../core/sandbox/index.ts'
import { main } from './cli.ts'
import { applyAuthority, bootComposition, resumeTask, runTask, type BootOptions } from './headless.ts'

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

function scripted(adapter: ScriptedAdapter): { patches: [{ id: string; disabled: true }]; prepare: (root: Context) => void; provider: string } {
  return {
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root) => void root.get(LLM).registerAdapter(root, adapter),
    provider: 'scripted',
  }
}

/** One editor call the model proposes, then a closing message. */
async function editorRun(
  cwd: string,
  args: Record<string, unknown>,
  boot: Partial<BootOptions> = {},
): Promise<{ events: EventEnvelope[]; text: string }> {
  const adapter = new ScriptedAdapter().script(
    assistantToolCall('call-1', 'str_replace_editor', args),
    assistantText('done'),
  )
  const events: EventEnvelope[] = []
  const result = await runTask(
    { task: 'write the file', cwd, model: 'scripted-model', sessionsRoot: tempDir('minidsh-sessions-'), logger: silent, ...scripted(adapter), ...boot },
    (frame) => void events.push(frame.event),
  )
  return { events, text: result.text }
}

const toolError = (events: readonly EventEnvelope[]): { name: string; code: string } | undefined => {
  const result = events.find((event) => event.type === 'tool/result')
  return (result?.data as { error?: { name: string; code: string } } | undefined)?.error
}

const modeStamps = (events: readonly EventEnvelope[]) => events.filter((event) => matches(event, SANDBOX_MODE)).map((event) => event.data)

describe('authority in a real composition', () => {
  it('refuses an editor write outside the workspace and records why, leaving the world untouched', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const elsewhere = tempDir('minidsh-out-')
    const escape = join(elsewhere, 'owned.txt')

    const { events } = await editorRun(cwd, { command: 'create', path: escape, file_text: 'pwned' })

    expect(existsSync(escape)).toBe(false)
    expect(toolError(events)?.code).toBe('FS_SANDBOX_DENIED')
    // The boundary that governed the call is in the log, before the call.
    expect(modeStamps(events)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'initial' }])
  })

  it('allows the same write inside the workspace', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const { events } = await editorRun(cwd, { command: 'create', path: join(cwd, 'note.txt'), file_text: 'kept' })
    expect(readFileSync(join(cwd, 'note.txt'), 'utf8')).toBe('kept')
    expect(toolError(events)).toBeUndefined()
  })

  it('refuses every write under read-only, including one inside the workspace', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const target = join(cwd, 'note.txt')
    const { events } = await editorRun(cwd, { command: 'create', path: target, file_text: 'kept' }, { sandbox: 'read-only' })
    expect(existsSync(target)).toBe(false)
    expect(toolError(events)?.code).toBe('FS_SANDBOX_DENIED')
    expect(modeStamps(events)).toEqual([{ mode: 'read-only', enforcement: 'none', reason: 'initial' }])
  })

  it('records an explicitly requested mode as the session own durable switch', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const { events } = await editorRun(cwd, { command: 'create', path: join(cwd, 'note.txt'), file_text: 'kept' }, { sandbox: 'danger-full-access' })
    expect(modeStamps(events)).toEqual([{ mode: 'danger-full-access', enforcement: 'none', reason: 'initial' }])
  })
})

describe('authority survives the process', () => {
  it('a resumed session keeps the mode it recorded, not the deployment default', async () => {
    const cwd = tempDir('minidsh-cwd-')
    const sessionsRoot = tempDir('minidsh-sessions-')
    const first = await runTask({
      task: 'note it',
      cwd,
      model: 'scripted-model',
      sessionsRoot,
      logger: silent,
      sandbox: 'read-only',
      ...scripted(new ScriptedAdapter().script(assistantText('noted'))),
    })
    expect(first.exitCode).toBe(0)

    // The resumed run asks for nothing, so the deployment default applies -
    // except that the session recorded read-only, and its own record wins.
    const events: EventEnvelope[] = []
    const target = join(cwd, 'after-resume.txt')
    await resumeTask(
      {
        id: first.sessionId,
        task: 'write the file',
        sessionsRoot,
        logger: silent,
        ...scripted(new ScriptedAdapter().script(assistantToolCall('call-2', 'str_replace_editor', { command: 'create', path: target, file_text: 'x' }), assistantText('done'))),
      },
      (frame) => void events.push(frame.event),
    )
    expect(existsSync(target)).toBe(false)
    expect(toolError(events)?.code).toBe('FS_SANDBOX_DENIED')
    // Nothing changed, so the pickup records no new stamp.
    expect(modeStamps(events)).toHaveLength(0)
  })
})

describe('the audit view', () => {
  it('projects what the session could do, when, and every denial', async () => {
    const home = tempDir('minidsh-home-')
    const cwd = tempDir('minidsh-cwd-')
    const elsewhere = tempDir('minidsh-out-')
    const previous = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    const chunks: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    try {
      const result = await runTask({
        task: 'escape',
        cwd,
        model: 'scripted-model',
        sessionsRoot: join(home, 'sessions'),
        logger: silent,
        ...scripted(
          new ScriptedAdapter().script(
            assistantToolCall('call-1', 'str_replace_editor', { command: 'create', path: join(elsewhere, 'owned.txt'), file_text: 'no' }),
            assistantText('blocked'),
          ),
        ),
      })
      process.stdout.write = ((text: string) => {
        chunks.push(text)
        return true
      }) as typeof process.stdout.write
      const code = await main(['sessions', 'show', result.sessionId, '--audit'])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = write
      if (previous === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previous
    }
    const audit = chunks.join('')
    expect(audit).toContain('sandbox     workspace-write (initial; shell confinement none)')
    expect(audit).toContain('denied      FS_SANDBOX_DENIED')
    // The projection is authority only: ordinary conversation is not in it.
    expect(audit).not.toContain('assistant/message')
  })
})

describe('authority flags', () => {
  it('refuses an unknown mode before anything boots, and says what it expects', async () => {
    const lines: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((text: string) => {
      lines.push(text)
      return true
    }) as typeof process.stderr.write
    let code: number
    try {
      code = await main(['run', 'anything', '--sandbox', 'bogus'])
    } finally {
      process.stderr.write = write
    }
    expect(code).toBe(2)
    const message = lines.join('')
    expect(message).toContain('--sandbox expects read-only | workspace-write | danger-full-access')
    expect(message.endsWith('\n')).toBe(true)
  })

  it('refuses an unknown approval policy the same way', async () => {
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      expect(await main(['run', 'anything', '--ask', 'sometimes'])).toBe(2)
      expect(await main(['serve', '--sandbox', 'bogus'])).toBe(2)
      expect(await main(['chat', '--ask', 'maybe'])).toBe(2)
      expect(await main(['resume', 'some-id', '--sandbox', 'bogus'])).toBe(2)
    } finally {
      process.stderr.write = write
    }
  })
})

describe('what the model is told about its authority', () => {
  async function bootWithAgent(cwd: string, sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access') {
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-sessions-'),
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (context) => void context.get(LLM).registerAdapter(context, new ScriptedAdapter()),
      ...(sandbox === undefined ? {} : { sandbox }),
    })
    const handle = await root.get(AGENTS).create(root, { cwd, agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    if (sandbox !== undefined) applyAuthority(root, handle, { sandbox, sessionsRoot: '' })
    return { root, handle }
  }

  it('stays byte-identical across a mid-session switch, so the cached prefix survives it', async () => {
    const { root, handle } = await bootWithAgent(tempDir('minidsh-cwd-'))
    try {
      const before = await root.get(PROMPT).assemble(handle.agent)
      expect(before.system).toContain('Sandbox: workspace-write')
      root.get(SANDBOX).setMode(handle.agent.session, 'read-only')
      const after = await root.get(PROMPT).assemble(handle.agent)
      // The switch reaches the model as a durable message, never by rewriting
      // the section the whole session's prompt cache is keyed on.
      expect(after.system).toBe(before.system)
    } finally {
      await handle.dispose()
      await root.dispose()
    }
  })

  it('states the mode the session actually opened under, and that a denial is policy', async () => {
    const { root, handle } = await bootWithAgent(tempDir('minidsh-cwd-'), 'read-only')
    try {
      const assembled = await root.get(PROMPT).assemble(handle.agent)
      expect(assembled.system).toContain('Sandbox: read-only')
      expect(assembled.system).toContain('refused by policy')
      expect(assembled.system).toContain('A denial is policy, not a bug')
      // This host confines nothing, so the model is told what a refusal means.
      expect(assembled.system).toContain('cannot confine shell commands')
    } finally {
      await handle.dispose()
      await root.dispose()
    }
  })
})

describe('what a delegated child is told', () => {
  it('renders the approval policy the session opened under and, for a child, the delegation statement — byte-stable', async () => {
    const { APPROVAL } = await import('../core/approval/index.ts')
    const { asSessionId } = await import('../core/ids.ts')
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-sessions-'),
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (context) => void context.get(LLM).registerAdapter(context, new ScriptedAdapter()),
    })
    try {
      const cwd = tempDir('minidsh-cwd-')
      const options = { provider: 'scripted', model: 'scripted-model' }
      const top = await root.get(AGENTS).create(root, { cwd, agentOptions: options })
      const topPrompt = await root.get(PROMPT).assemble(top.agent)
      expect(topPrompt.system).toContain('Approvals: ask.')
      // The clause after the pinned prefix promises an approval STEP, never a person: a headless run has no answerer.
      expect(topPrompt.system).toContain('Approvals: ask. An action outside the sandbox needs an approval before it runs; a request that is refused, or that nobody answers, means the action did not run.')
      expect(topPrompt.system).not.toContain('delegated subagent')

      const child = await root.get(AGENTS).create(root, {
        cwd,
        agentOptions: options,
        delegatedBy: asSessionId(top.agent.id),
        delegationDepth: 1,
        setup: (_agentCtx, agent) => {
          root.get(SANDBOX).open(agent.session, { mode: 'read-only', reason: 'delegation' })
          root.get(APPROVAL).open(agent.session, { policy: 'never', reason: 'delegation' })
        },
      })
      const before = await root.get(PROMPT).assemble(child.agent)
      expect(before.system).toContain('Sandbox: read-only')
      expect(before.system).toContain('Approvals: never.')
      expect(before.system).toContain('You are a delegated subagent')
      // The statement reads the OPENING stamps: the section never moves for the session's life.
      root.get(SANDBOX).setMode(child.agent.session, 'read-only')
      const after = await root.get(PROMPT).assemble(child.agent)
      expect(after.system).toBe(before.system)
      await child.dispose()
      await top.dispose()
    } finally {
      await root.dispose()
    }
  })
})
