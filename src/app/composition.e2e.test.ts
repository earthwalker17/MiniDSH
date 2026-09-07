/**
 * The S4 live end-to-end: a from-disk composition drives the real runtime.
 * MINIDSH_HOME carries composition.json (a module-loaded tool inserted, a
 * builtin row reconfigured) and settings.json (model + effort); the run
 * switches authority through the preset selector over the wire. Assertions
 * are about the world and the durable log — the module tool's real output,
 * the recorded route, the composition/applied stamp, the preset's intent and
 * knob events — and the fresh log then replays keylessly under the SAME disk
 * composition, proving the layers reproduce the world.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { loadCompositionFile, toPatches } from './config.ts'
import { runTask } from './headless.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
const GREET_PLUGIN = fileURLToPath(new URL('../test-support/fixtures/greet-plugin.ts', import.meta.url))
const TASK = 'Call the greet tool with name "minidsh" and reply with the tool output exactly, and nothing else.'

let dirs: string[] = []
afterAll(() => {
  killSpawnedServes()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe.skipIf(!KEY)('S4 live E2E: a from-disk composition drives the real runtime', () => {
  it('a module-loaded tool executes, settings choose the route, a preset switches authority, and the log replays', { timeout: 480_000 }, async () => {
    const workspace = tempDir('minidsh-e2e4-ws-')
    const home = tempDir('minidsh-e2e4-home-')
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ agent: { model: 'deepseek-v4-flash', reasoningEffort: 'low' } }))
    writeFileSync(
      join(home, 'composition.json'),
      JSON.stringify({
        patches: [{ insert: [{ id: 'tool-greet', plugin: GREET_PLUGIN }] }, { id: 'llm-retry', config: { maxRetries: 1 } }],
      }),
    )

    const serve = new ServeProcess(workspace, home, { approve: true })
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: TASK })
    // Authority through the one selector, over the wire, mid-run.
    const view = await serve.request<{ sandbox: string; approval: string; preset?: string }>('session/authority', {
      sessionId,
      preset: 'danger-full-access',
    })
    expect(view).toMatchObject({ sandbox: 'danger-full-access', approval: 'never', preset: 'danger-full-access' })
    await serve.waitForCompletedTurn(sessionId, 1)

    const log = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    await serve.shutdown()

    // The WORLD: the module-loaded tool really executed in the runtime.
    const call = log.events.find((event) => event.type === 'tool/call' && (event.data as { name: string }).name === 'greet')
    expect(call).toBeDefined()
    const callId = (call!.data as { callId: string }).callId
    const result = log.events.find((event) => event.type === 'tool/result' && (event.data as { callId?: string }).callId === callId)
    expect(JSON.stringify(result!.data)).toContain('greeting:MINIDSH-7')
    // The tool/result above is the proof; the echo only shows the model consumed
    // it — and a live model may trim the prefix, so assert the deterministic core.
    expect(lastAssistantText(log.events)).toContain('MINIDSH-7')

    // The settings layer chose the route, recorded in the durable header.
    const header = log.events.find((event) => event.type === 'request/header')!
    expect((header.data as { header: { model: string; reasoningEffort?: string } }).header).toMatchObject({
      model: 'deepseek-v4-flash',
      reasoningEffort: 'low',
    })

    // The session records which composition produced it.
    const applied = log.events.filter((event) => event.type === 'composition/applied')
    expect(applied).toHaveLength(1)
    const composition = applied[0]!.data as { hash: string; layers: string[]; rows: { id: string; plugin: string }[] }
    expect(composition.layers).toEqual(['built-in', 'home'])
    expect(composition.rows.some((row) => row.id === 'tool-greet' && row.plugin === 'tool-greet')).toBe(true)

    // The preset: durable intent plus both knob events.
    expect(log.events.some((event) => event.type === 'authority/preset' && (event.data as { name: string }).name === 'danger-full-access')).toBe(true)
    expect(log.events.some((event) => event.type === 'sandbox/mode' && (event.data as { mode: string }).mode === 'danger-full-access')).toBe(true)
    expect(log.events.some((event) => event.type === 'approval/policy' && (event.data as { policy: string }).policy === 'never')).toBe(true)

    // Keyless replay under the SAME disk composition: the layers reproduce the world.
    const file = loadCompositionFile(join(home, 'composition.json'))!
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replaySessionsRoot = tempDir('minidsh-e2e4-replay-')
    const replayed = await runTask(
      {
        task: TASK,
        cwd: workspace,
        model: 'deepseek-v4-flash',
        sessionsRoot: replaySessionsRoot,
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        configLayers: [{ name: 'home', patches: await toPatches(file, home) }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events: log.events })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    expect(replayed.text).toBe(lastAssistantText(log.events))
    replayHandle!.assertConsumed()
    // The claim is "the layers reproduce the WORLD", and none of the three
    // assertions above can fail if they did not: an unmounted `tool-greet`
    // answers UNKNOWN_TOOL, which is an isError result the turn survives, so
    // the recorded chunks replay, the text matches and the cursors drain on
    // arithmetic (the S7.5 class). The replayed log is where the tool ran.
    const replayLog = readFileSync(join(replaySessionsRoot, `${encodeURIComponent(replayed.sessionId)}.jsonl`), 'utf8')
    expect(replayLog, 'the replay drained its script without ever running the module-loaded tool').toContain('greeting:MINIDSH-7')
  })
})

function lastAssistantText(events: readonly EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'assistant/message') continue
    const message = event.data as { message: { content: { type: string; text?: string }[] } }
    const text = message.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    if (text.length > 0) return text
  }
  return ''
}
