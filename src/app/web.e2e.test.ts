/**
 * The S7 live end-to-end: the real MiniDSH runtime, the real DeepSeek API, a
 * real workspace outside the repo, over a real WebSocket — `minidsh web` runs
 * as a child process and everything below speaks to it exactly as the browser
 * client does, including the token-for-cookie sign-in.
 *
 * Arc: two clients attach to one host → one prompts and the OTHER sees the same
 * stream → a real approval is answered over the wire and the file lands → the
 * transcript is paged backwards to seq 0 → the socket is killed mid-turn and
 * the client reattaches, replaces its window and finishes the work → the host
 * is still serving, because a disconnect is not a shutdown → the fresh log
 * replays keylessly. Assertions are about the WORLD, never the agent's report.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedWebHosts, WebHostProcess } from '../test-support/web-process.ts'
import { AGENTS } from '../core/agent/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { bootComposition } from './headless.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
let dirs: string[] = []

afterAll(() => {
  killSpawnedWebHosts()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * The four prompts this arc sends, in order — the replay walks the same path.
 *
 * Each names its file by a RELATIVE path, and says so, because the replay runs
 * in a different working directory than the recording. A recorded tool call
 * that named an absolute path inside the live workspace is not reproducible
 * there: the fence refuses it (correctly — it is outside the replay's root),
 * the turn still completes on the recorded messages, and `assertConsumed`
 * still passes, so the only symptom is a file that never appears. Observed
 * once, on `notes.txt`. The log is an oracle for what the MODEL decided, not
 * for a path that embedded the workspace it decided in.
 */
const PROMPTS = [
  'Create a file at the relative path notes.txt (not an absolute path) whose only line is exactly "the browser drove this" without the quotation marks, then read it back and tell me what it says.',
  // The consent this arc answers over the socket, with no --approve anywhere.
  // It asks for an effect OUTSIDE the workspace, which needs authority this
  // session does not have on either kind of host: where the shell cannot be
  // confined the tool refuses before the command runs, and where it can the
  // command runs and the KERNEL refuses the write. Either way the cost is
  // exactly one one-shot approval — the sentence V1 makes about itself — so
  // this arc needs no branch of its own. Filled per run, since it names a path.
  '',
  'Read notes.txt one more time and reply with its line.',
  'Create a file at the relative path summary.txt (not an absolute path) whose only line is exactly "reconnected and finished" without the quotation marks.',
]

describe.skipIf(!KEY)('S7 live E2E: a browser-shaped client over a real socket', () => {
  it('two clients, one session, a real approval, backward paging, and a reconnect mid-turn', { timeout: 600_000 }, async () => {
    const workspace = tempDir('minidsh-web-e2e-ws-')
    // NOT under os.tmpdir(): a confined host masks it with an ephemeral tmpfs,
    // so the write would fail as a missing directory — no denial the backend
    // recognises, no escalation guidance, and no consent for this arc to answer.
    const outside = mkdtempSync(join(homedir(), '.minidsh-web-out-'))
    dirs.push(outside)
    const home = tempDir('minidsh-web-e2e-home-')
    const decoy = join(workspace, 'decoy.txt')
    writeFileSync(decoy, 'must never change\n', 'utf8')
    const decoyBytes = readFileSync(decoy)

    // No --approve: every consent is a real decision answered over the socket.
    const host = new WebHostProcess(workspace, home)
    const driver = await host.connect()
    const observer = await host.connect()

    const init = await driver.request<{ serverInfo: { name: string }; providers: { id: string }[]; workspaces: { id: string; root: string }[] }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')
    expect(init.providers.some((provider) => provider.id === 'deepseek')).toBe(true)
    expect(init.workspaces).toHaveLength(1)

    // ---- one client prompts, the other watches --------------------------
    // BOTH answer. First answer wins across clients, and the loser is told the
    // prompt is no longer pending — which is also what keeps the arc honest
    // when the driver's socket dies later with a question outstanding.
    const stopAnswering = driver.answerApprovals('allowed-once')
    const stopWatching = observer.answerApprovals('allowed-once')
    const { sessionId } = await driver.request<{ sessionId: string }>('session/prompt', {
      workspaceId: init.workspaces[0]!.id,
      text: PROMPTS[0],
    })
    await driver.waitForCompletedTurn(sessionId, 1)

    // The world, not the report.
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8').trim()).toBe('the browser drove this')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)
    // The observer saw the same durable stream without asking for anything.
    expect(observer.events('assistant/message', sessionId).length).toBeGreaterThan(0)
    expect(observer.events('tool/result', sessionId).length).toBeGreaterThan(0)
    // And the host computed the folds a paged client cannot.
    const view = observer.views.at(-1)!.view as { context?: { projectedTokens: number }; authority: { sandbox: string } }
    expect(view.context!.projectedTokens).toBeGreaterThan(0)
    expect(view.authority.sandbox).toBe('workspace-write')

    // ---- a real consent, answered over the socket -----------------------
    const granted = join(outside, 'granted.txt')
    PROMPTS[1] =
      'Using the shell tool (not the file editor), run one command that writes the word ok into the file at the absolute path ' +
      granted.replace(/\\/g, '/') +
      ". If a tool refuses, follow the guidance it gives you."
    await driver.request('session/prompt', { sessionId, text: PROMPTS[1] })
    await driver.waitForCompletedTurn(sessionId, 2)
    // No --approve anywhere: the effect needed authority this session did not
    // have, the model asked for it, and a browser-shaped client granted it over
    // the wire. The world says whether the grant was real.
    expect(driver.events('approval/asked', sessionId).length).toBeGreaterThan(0)
    expect(driver.events('approval/decided', sessionId).some((event) => (event.data as { outcome: string }).outcome === 'allowed-once')).toBe(true)
    // Both clients saw the same durable decision — it IS the frame.
    expect(observer.events('approval/decided', sessionId).length).toBe(driver.events('approval/decided', sessionId).length)
    // And the grant bought a real effect: outside the workspace, after consent.
    expect(readFileSync(granted, 'utf8')).toContain('ok')

    // ---- one more turn, then page the whole transcript backwards ---------
    await driver.request('session/prompt', { sessionId, text: PROMPTS[2] })
    await driver.waitForCompletedTurn(sessionId, 3)

    const attached = await driver.request<{
      cursor: number
      page: { events: EventEnvelope[]; from: number; hasMore: boolean }
    }>('session/attach', { sessionId, limit: 2 })
    expect(attached.page.hasMore).toBe(true)

    const seen: number[] = attached.page.events.map((event) => event.seq)
    let before = attached.page.from
    let hasMore = attached.page.hasMore
    let pages = 1
    while (hasMore) {
      const older = await driver.request<{ page: { events: EventEnvelope[]; from: number; hasMore: boolean } }>('session/page', {
        sessionId,
        throughSeq: attached.cursor,
        beforeSeq: before,
        limit: 2,
      })
      seen.unshift(...older.page.events.map((event) => event.seq))
      before = older.page.from
      hasMore = older.page.hasMore
      expect(++pages).toBeLessThan(400)
    }
    expect(pages).toBeGreaterThan(1)
    expect(seen[0]).toBe(0)
    // Paging lost nothing and repeated nothing, and it never carried the trace
    // tier — which is what makes a long session servable at all.
    expect(seen).toEqual([...new Set(seen)])
    expect(attached.page.events.some((event) => event.type === 'assistant/chunk')).toBe(false)
    const whole = await driver.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    expect(seen).toEqual(whole.events.filter((event) => event.type !== 'assistant/chunk').map((event) => event.seq))
    expect(whole.events.some((event) => event.type === 'assistant/chunk')).toBe(true)

    // ---- kill the socket mid-turn, then reattach and finish --------------
    await driver.request('session/prompt', {
      sessionId,
      text: PROMPTS[3],
    })
    await driver.waitFor(() => driver.statuses.find((entry) => entry.sessionId === sessionId && entry.status === 'running'), 'the turn to start')
    stopAnswering()
    driver.close()

    // A disconnect is not a shutdown: the host is still serving, and the agent
    // it was driving is still running.
    const reconnected = await host.connect()
    const fresh = await reconnected.request<{ cursor: number; view: { status: string } }>('session/attach', { sessionId })
    expect(fresh.cursor).toBeGreaterThan(attached.cursor)
    await reconnected.waitForCompletedTurn(sessionId, 4)
    stopWatching()
    expect(readFileSync(join(workspace, 'summary.txt'), 'utf8').trim()).toBe('reconnected and finished')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)

    // ---- the log is its own oracle --------------------------------------
    const recorded = await reconnected.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    reconnected.close()
    observer.close()
    host.kill()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const replayWorkspace = tempDir('minidsh-web-e2e-replay-')
    writeFileSync(join(replayWorkspace, 'decoy.txt'), 'must never change\n', 'utf8')
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const root = await bootComposition({
      sessionsRoot: tempDir('minidsh-web-e2e-replay-home-'),
      approve: true,
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (context) => {
        replayHandle = installLlmReplay(context, { events: recorded.events })
      },
    })
    try {
      const handle = await root.get(AGENTS).create(root, { cwd: replayWorkspace, agentOptions: { provider: 'deepseek', model: 'deepseek-v4-flash' } })
      // Every recorded prompt in order, so the replayed session walks the path
      // the browser walked — including the turn the socket died inside.
      for (const text of PROMPTS) {
        handle.agent.followup(createUserMessage(text))
        await handle.agent.whenIdle()
      }
      await handle.dispose()
    } finally {
      await root.dispose()
    }
    replayHandle!.assertConsumed()
    expect(readFileSync(join(replayWorkspace, 'notes.txt'), 'utf8')).toContain('the browser drove this')
    expect(readFileSync(join(replayWorkspace, 'summary.txt'), 'utf8').trim()).toBe('reconnected and finished')
    expect(readFileSync(join(replayWorkspace, 'decoy.txt')).equals(decoyBytes)).toBe(true)
  })
})
