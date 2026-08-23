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
import { runTask, type BootOptions } from './headless.ts'

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
