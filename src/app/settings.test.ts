/**
 * Boot-time settings: precedence is flags → env → file → built-ins, a broken
 * file surfaces as broken, and on resume the settings layer sits in the
 * DEFAULTS tier — the log's folded request/header wins, so settings.json can
 * never silently rewrite what a session recorded.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
import { assistantText, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { defaultAgentOptions } from './compose.ts'
import { resumeTask, runTask } from './headless.ts'
import { resolveSettings } from './settings.ts'

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

function settingsFile(content: unknown): string {
  const path = join(tempDir('minidsh-settings-'), 'settings.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

describe('resolveSettings', () => {
  it('layers env over file over the pure built-ins', () => {
    // Built-ins are env-free: an ambient MINIDSH_MODEL must not leak in here.
    expect(defaultAgentOptions()).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })

    expect(resolveSettings({ env: {} }).agent).toEqual(defaultAgentOptions())
    const path = settingsFile({ agent: { model: 'from-file', reasoningEffort: 'low', maxSteps: 7 } })
    expect(resolveSettings({ path, env: {} }).agent).toEqual({ provider: 'deepseek', model: 'from-file', reasoningEffort: 'low', maxSteps: 7 })
    expect(resolveSettings({ path, env: { MINIDSH_MODEL: 'from-env' } }).agent.model).toBe('from-env')
    // A blank env value is unset, not an empty model id.
    expect(resolveSettings({ path, env: { MINIDSH_MODEL: '' } }).agent.model).toBe('from-file')
    // A missing file is simply absent.
    expect(resolveSettings({ path: join(tempDir('minidsh-none-'), 'settings.json'), env: {} }).agent).toEqual(defaultAgentOptions())
  })

  it('carries every field the layer may hold, so one file means one thing to every reader', () => {
    const path = settingsFile({ agent: { maxTokens: 2048, temperature: 0.25 } })
    expect(resolveSettings({ path, env: {} }).agent).toEqual({ ...defaultAgentOptions(), maxTokens: 2048, temperature: 0.25 })
  })

  it('drops an effort belonging to the route MINIDSH_MODEL replaces, exactly as every other switch does', () => {
    // An effort id is adapter-owned, so it means nothing across a route change.
    // A hand-rolled merge here resolved one file plus one env var into two
    // different routes depending on which surface read it: the CLI kept the
    // file's DeepSeek effort and carried it onto an Anthropic model, which that
    // adapter refuses on every step, while the wire dropped it.
    const path = settingsFile({ agent: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'max' } })
    const switched = resolveSettings({ path, env: { MINIDSH_MODEL: 'claude-sonnet-5' } })
    expect(switched.agent.model).toBe('claude-sonnet-5')
    expect(switched.agent.reasoningEffort).toBeUndefined()
    // With no route change the file's effort stands.
    expect(resolveSettings({ path, env: {} }).agent.reasoningEffort).toBe('max')
    expect(resolveSettings({ path, env: { MINIDSH_MODEL: 'deepseek-v4-pro' } }).agent.reasoningEffort).toBe('max')
  })

  it('splits the store base from what outranks the store, so the file cannot beat the environment', () => {
    const layer = { provider: 'from-file', model: 'from-file' }
    const path = settingsFile({ agent: layer })
    const resolved = resolveSettings({ path, env: { MINIDSH_MODEL: 'from-env' } })
    expect(resolved.agent.model).toBe('from-env')

    // The store is registered with the pure built-ins and applies the file as
    // its own user layer; a base with the file already in it would apply the
    // file twice. But a user layer always beats its base, so the environment
    // cannot live in the base either — it travels separately and is applied on
    // top, which is the only order that keeps the documented precedence.
    expect(resolved.agentBase).toEqual(defaultAgentOptions())
    const stored = { ...resolved.agentBase, ...layer }
    expect(stored.model).toBe('from-file')
    expect({ ...stored, ...resolved.agentOverrides }.model).toBe('from-env')

    // With no environment override there is nothing to apply, and the store's
    // own resolution is the whole answer.
    expect(resolveSettings({ path, env: {} }).agentOverrides).toEqual({})
  })

  it('surfaces a broken file as broken, naming the path', () => {
    const garbled = settingsFile('not json')
    expect(() => resolveSettings({ path: garbled, env: {} })).toThrow(/not valid JSON/)
    expect(() => resolveSettings({ path: garbled, env: {} })).toThrow(garbled)
    const unknownKey = settingsFile({ agent: { modle: 'typo' } })
    expect(() => resolveSettings({ path: unknownKey, env: {} })).toThrow(/invalid/)
    const badSteps = settingsFile({ agent: { maxSteps: -2 } })
    expect(() => resolveSettings({ path: badSteps, env: {} })).toThrow(/maxSteps/)
  })
})

describe('settings on resume', () => {
  function scripted(adapter: ScriptedAdapter): {
    patches: [{ id: string; disabled: true }]
    prepare: (root: Context) => void
    provider: string
  } {
    return {
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root) => void root.get(LLM).registerAdapter(root, adapter),
      provider: 'scripted',
    }
  }

  it('a different settings-layer model never rewrites the recorded header of a resumed session', async () => {
    const sessionsRoot = tempDir('minidsh-settings-resume-')
    const cwd = tempDir('minidsh-settings-cwd-')
    const first = await runTask(
      { task: 'one', cwd, model: 'scripted-model', sessionsRoot, logger: silent, ...scripted(new ScriptedAdapter().script(assistantText('a'))) },
      undefined,
    )
    expect(first.exitCode).toBe(0)

    const second = await resumeTask(
      {
        id: first.sessionId,
        task: 'two',
        sessionsRoot,
        logger: silent,
        agentDefaults: { provider: 'scripted', model: 'settings-model' },
        ...scripted(new ScriptedAdapter().script(assistantText('b'))),
      },
      undefined,
    )
    expect(second.exitCode).toBe(0)

    const lines = readFileSync(join(sessionsRoot, `${encodeURIComponent(first.sessionId)}.jsonl`), 'utf8').trim().split('\n')
    const headers = lines
      .slice(1)
      .map((line) => JSON.parse(line) as { type: string; data: { header?: { model?: string } } })
      .filter((event) => event.type === 'request/header')
    // One header, the recorded model — the settings tier stayed underneath it.
    expect(headers).toHaveLength(1)
    expect(headers[0]!.data.header?.model).toBe('scripted-model')
  })
})
