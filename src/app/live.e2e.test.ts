/**
 * The S2 live end-to-end: the real MiniDSH runtime, the real DeepSeek API, a
 * real workspace outside the repo, over the real wire — `minidsh serve` runs
 * as a child process and everything below speaks newline-delimited JSON-RPC to
 * its stdio, exactly as an external client would.
 *
 * Arc: task A completes → task B is killed mid-turn (SIGKILL) → a second serve
 * process resumes the stored session over the wire (crash repair + append-only
 * attach, byte-prefix asserted) and finishes the work → a fresh session's log
 * replays keylessly (the log is its own oracle). Assertions are about the
 * WORLD (file bytes, decoy untouched), never the agent's self-report.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess, validPrefix } from '../test-support/serve-process.ts'
import { runTask } from './headless.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
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

describe.skipIf(!KEY)('S2 live E2E: kill, resume, and replay over the real wire', () => {
  it('a session survives a hard kill and finishes its work in a second process', { timeout: 480_000 }, async () => {
    const workspace = tempDir('minidsh-e2e-ws-')
    const home = tempDir('minidsh-e2e-home-')
    const decoy = join(workspace, 'decoy.txt')
    writeFileSync(decoy, 'must never change\n', 'utf8')
    const decoyBytes = readFileSync(decoy)

    // ---- lifecycle 1: complete task A, then die mid-task-B ----------------
    const first = new ServeProcess(workspace, home, { approve: true })
    const init = await first.request<{ serverInfo: { name: string }; providers: { id: string }[] }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')
    expect(init.providers.some((provider) => provider.id === 'deepseek')).toBe(true)

    const { sessionId } = await first.request<{ sessionId: string }>('session/prompt', {
      text: 'Create a file named greeting.txt in the workspace containing exactly this single line: hello from minidsh',
    })
    await first.waitForCompletedTurn(sessionId, 1)
    expect(readFileSync(join(workspace, 'greeting.txt'), 'utf8').trim()).toBe('hello from minidsh')

    await first.request('session/prompt', {
      sessionId,
      text: 'Now append a second line to greeting.txt reading exactly: resumed and finished',
    })
    // Die mid-turn: as soon as turn 2 issues its first tool call.
    await first.waitFor(
      () => first.events('tool/call', sessionId).find((event) => (event.data as { turn: number }).turn === 2),
      'the first tool call of turn 2',
    )
    await first.kill()

    const sessionFile = join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl`)
    const beforeResume = validPrefix(sessionFile)
    expect(beforeResume.length).toBeGreaterThan(0)

    // ---- lifecycle 2: resume over the wire, repair, finish ----------------
    const second = new ServeProcess(workspace, home, { approve: true })
    const resumed = await second.request<{ sessionId: string }>('session/prompt', {
      sessionId,
      text: 'The previous attempt was interrupted. Ensure greeting.txt ends with the exact second line: resumed and finished',
    })
    expect(resumed.sessionId).toBe(sessionId)
    await second.waitFor(
      () =>
        second
          .events('turn/end', sessionId)
          .find((event) => (event.data as { turn: number; reason: { kind: string } }).turn >= 3 && (event.data as { reason: { kind: string } }).reason.kind === 'completed'),
      'the resumed turn to complete',
    )

    // The WORLD: the file is finished, the decoy is untouched.
    const lines = readFileSync(join(workspace, 'greeting.txt'), 'utf8').trim().split(/\r?\n/)
    expect(lines[0]).toBe('hello from minidsh')
    expect(lines.at(-1)).toBe('resumed and finished')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)

    // The LOG: append-only attach (byte prefix), crash repair recorded.
    const afterResume = readFileSync(sessionFile)
    expect(afterResume.subarray(0, beforeResume.length).equals(beforeResume)).toBe(true)
    const storedEvents = readFileSync(sessionFile, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line) as EventEnvelope)
    const interrupted = storedEvents.filter(
      (event) => event.type === 'turn/end' && (event.data as { reason: { kind: string } }).reason.kind === 'interrupted',
    )
    expect(interrupted).toHaveLength(1)
    expect((interrupted[0]!.data as { turn: number }).turn).toBe(2)
    expect(storedEvents.some((event) => event.type === 'session/end-seed')).toBe(true)

    // The WIRE: history reads back over the protocol, seqs contiguous.
    const history = await second.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    expect(history.events.every((event, index) => event.seq === index)).toBe(true)

    // ---- lifecycle 2 continued: a fresh session for the replay oracle -----
    const fresh = await second.request<{ sessionId: string }>('session/prompt', {
      text: 'Read greeting.txt and reply with its second line, exactly, and nothing else.',
    })
    await second.waitForCompletedTurn(fresh.sessionId, 1)
    const freshLog = await second.request<{ events: EventEnvelope[] }>('session/events', { sessionId: fresh.sessionId })
    await second.shutdown()

    // ---- keyless replay: the fresh log is its own oracle ------------------
    const recordedText = lastAssistantText(freshLog.events)
    expect(recordedText).toContain('resumed and finished')
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayed = await runTask(
      {
        task: 'Read greeting.txt and reply with its second line, exactly, and nothing else.',
        cwd: workspace,
        model: 'deepseek-v4-flash',
        sessionsRoot: tempDir('minidsh-e2e-replay-'),
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events: freshLog.events })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    expect(replayed.text).toBe(recordedText)
    replayHandle!.assertConsumed()
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
