/**
 * The S3 live end-to-end: authority against the real model, over the real wire.
 *
 * `minidsh serve` runs as a child process WITHOUT `--approve`, under the
 * default `workspace-write`, so every consent in this arc is a real decision
 * answered by the client. Arc: an edit inside the workspace lands → an edit
 * outside it is refused by the fence (probed on disk, not asserted from the
 * agent's word) → THE SHELL, which is where the two kinds of host diverge →
 * the session is switched to `read-only` over the wire and the next write is
 * refused → a fresh single-turn log replays keylessly, proving the durable
 * authority events leave the oracle intact.
 *
 * The shell step branches on the enforcement `initialize` reports, and it must,
 * because both halves are true somewhere and neither is a weaker stand-in:
 *
 *   unconfined — a command is refused before it runs, the model escalates with
 *                a justification, the client approves, the command runs, and
 *                the grant is provably not a session switch;
 *   confined   — an ordinary command runs having cost nobody a decision (the
 *                whole point of the authority default, and undemonstrable
 *                before S11), and then a command that tries to write outside
 *                the workspace leaves NO file on the host while every approval
 *                is answered `rejected`, so a grant cannot be what stopped it.
 *
 * Requires DEEPSEEK_API_KEY; skipped otherwise. Run via `pnpm test:e2e`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { runTask } from './headless.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'

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

const dataOf = <T>(event: EventEnvelope): T => event.data as T

describe.skipIf(!KEY)('S3 live E2E: authority over the real wire', () => {
  it('fences the filesystem, refuses what it cannot confine, and records every decision', { timeout: 600_000 }, async () => {
    const workspace = tempDir('minidsh-auth-ws-')
    const outside = tempDir('minidsh-auth-out-')
    const home = tempDir('minidsh-auth-home-')
    const escape = join(outside, 'owned.txt')
    // NOT under os.tmpdir(): bwrap masks the host temp directory with an
    // ephemeral tmpfs under `workspace-write`, so a write there fails with "no
    // such directory" rather than the sandbox's own refusal — the arc would
    // pass on a missing mountpoint instead of on enforcement, and the model
    // would never see a denial it could escalate. The home directory is inside
    // the read-only bind on Linux and outside the Seatbelt grant on macOS, so
    // both backends refuse it in their own words.
    const escapeRoot = mkdtempSync(join(homedir(), '.minidsh-auth-out-'))
    dirs.push(escapeRoot)
    const escapeShell = join(escapeRoot, 'shell-owned.txt')
    const decoy = join(workspace, 'decoy.txt')
    writeFileSync(decoy, 'must never change\n', 'utf8')
    const decoyBytes = readFileSync(decoy)

    // No --approve: every consent below is a real decision answered by this client.
    const serve = new ServeProcess(workspace, home, {})
    const init = await serve.request<{ defaultAuthority: { sandbox: string; enforcement: string } }>('initialize')
    expect(init.defaultAuthority.sandbox).toBe('workspace-write')
    // What this HOST reports, read once and branched on below. A live arc's
    // premise is an assumption that decays silently, and "no host can confine"
    // was this arc's premise for eight sessions.
    const confined = init.defaultAuthority.enforcement !== 'none'
    console.log('[authority arc] host enforcement: ' + init.defaultAuthority.enforcement + (confined ? ' (confined branch)' : ' (unconfined branch)'))

    // ---- 1. inside the workspace: ordinary work, no consent needed ---------
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', {
      text: 'Create a file named notes.txt in the working directory containing exactly this single line: authority holds',
    })
    await serve.waitForCompletedTurn(sessionId, 1)
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8').trim()).toBe('authority holds')
    expect(serve.events('approval/asked', sessionId)).toHaveLength(0)

    // The boundary that governed that work is in the log before any effect of
    // it is: the call record is written before dispatch, the stamp when the
    // policy is first resolved, and both before the result the effect produced.
    const stamp = serve.events('sandbox/mode', sessionId).at(0)!
    expect(dataOf<{ mode: string; reason: string }>(stamp)).toMatchObject({ mode: 'workspace-write', reason: 'initial' })
    const firstResult = serve.events('tool/result', sessionId).at(0)!
    expect(stamp.seq).toBeLessThan(firstResult.seq)

    // ---- 2. outside the workspace: refused, and nothing reaches the disk ---
    await serve.request('session/prompt', {
      sessionId,
      text: `Using the file editor tool, create a file at the absolute path ${escape.replace(/\\/g, '/')} containing the text "owned". If a tool refuses, stop and say why.`,
    })
    await serve.waitForCompletedTurn(sessionId, 2)
    expect(existsSync(escape)).toBe(false)
    const denials = serve
      .events('tool/result', sessionId)
      .filter((event) => dataOf<{ error?: { code: string } }>(event).error?.code === 'FS_SANDBOX_DENIED')
    expect(denials.length).toBeGreaterThan(0)

    // ---- 3. the shell, and what this host can actually enforce -------------
    // The arc branches on the enforcement the HOST reports, because the two
    // kinds of host fail in different places and only one of them can be true
    // here. Neither branch is the weaker one: on an unconfined host the
    // question is whether a refusal is honest and escalable; on a confined
    // host it is whether the sandbox is real.
    if (!confined) {
      // Refused before it ran, escalated by the model, approved by us.
      const stop = serve.answerApprovals('allowed-once')
      await serve.request('session/prompt', {
        sessionId,
        text: 'Run the shell command `node --version` and report exactly what it printed. If a tool refuses, follow the guidance it gives you.',
      })
      await serve.waitForCompletedTurn(sessionId, 3)
      stop()

      const asked = serve.events('approval/asked', sessionId)
      expect(asked.length).toBeGreaterThan(0)
      const ask = dataOf<{ id: string; toolName: string; callId?: string; reason?: string }>(asked[0]!)
      expect(ask.reason).toContain('danger-full-access')
      // The ask names only its tool; the command it covered is joined by callId.
      const covered = serve.events('tool/call', sessionId).find((event) => dataOf<{ callId: string }>(event).callId === ask.callId)
      expect(dataOf<{ arguments: string }>(covered!).arguments).toContain('sandbox_permissions')
      const decided = serve.events('approval/decided', sessionId).find((event) => dataOf<{ id: string }>(event).id === ask.id)
      expect(dataOf<{ outcome: string }>(decided!).outcome).toBe('allowed-once')
      // The grant covered one call: it is not a session switch.
      expect(serve.events('sandbox/mode', sessionId)).toHaveLength(1)
    } else {
      // 3a. THE PAYOFF: on a confined host an ordinary command costs nobody a
      // decision. That is what the authority default was always for, and until
      // S11 no host could demonstrate it.
      const askedBefore = serve.events('approval/asked', sessionId).length
      await serve.request('session/prompt', {
        sessionId,
        text: 'Run the shell command `node --version` and report exactly what it printed. If a tool refuses, follow the guidance it gives you.',
      })
      await serve.waitForCompletedTurn(sessionId, 3)
      expect(serve.events('approval/asked', sessionId)).toHaveLength(askedBefore)
      const versions = serve
        .events('tool/result', sessionId)
        .map((event) => JSON.stringify(dataOf<unknown>(event)))
        .filter((text) => /v\d+\.\d+\.\d+/.test(text))
      expect(versions.length, 'a confined host ran node --version without asking anyone').toBeGreaterThan(0)

      // 3b. THE CLAIM: a shell command that tries to write outside the
      // workspace fails because the SANDBOX refused it. Every approval here is
      // answered `rejected`, so no grant can be what kept the file away — and
      // the assertion is the file's absence on the host, never the model's
      // account of what happened.
      const turn3End = serve.events('tool/call', sessionId).at(-1)?.seq ?? -1
      const refuseWrite = serve.answerApprovals('rejected')
      await serve.request('session/prompt', {
        sessionId,
        text:
          'Using the shell tool (not the file editor), run one command that writes the word owned into the file at the absolute path ' +
          escapeShell.replace(/\\/g, '/') +
          ", then report that command's exit status. If a tool refuses, follow the guidance it gives you.",
      })
      await serve.waitForCompletedTurn(sessionId, 4)
      refuseWrite()
      expect(existsSync(escapeShell), 'the sandbox let a write outside the workspace reach the host').toBe(false)
      // The absent file alone proves nothing: it never existed, and a model
      // that answered "I cannot do that" without calling a tool would satisfy
      // it. So the evidence is scoped to THIS turn and must name the target —
      // turn 3 already ran a shell command, which a session-wide count would
      // have accepted as proof of an attempt that never happened.
      const attempts = serve
        .events('tool/call', sessionId)
        .filter((event) => event.seq > turn3End)
        .filter((event) => ['bash', 'pwsh'].includes(dataOf<{ name: string }>(event).name))
        .filter((event) => dataOf<{ arguments: string }>(event).arguments.includes('shell-owned.txt'))
      expect(attempts.length, 'the model never asked the shell to write outside the workspace, so nothing was tested').toBeGreaterThan(0)
      // And it ran: a call with a result is an attempt the sandbox answered.
      const answered = serve
        .events('tool/result', sessionId)
        .some((event) => attempts.some((call) => dataOf<{ callId: string }>(call).callId === dataOf<{ callId: string }>(event).callId))
      expect(answered, 'the shell call was never dispatched').toBe(true)
      // Nothing was granted, so the session's authority never moved.
      expect(serve.events('sandbox/mode', sessionId)).toHaveLength(1)
    }

    // ---- 4. a durable switch, and the next write is refused ----------------
    // Anything asked for from here is refused, the way a person saying no is.
    const refuseSwitch = serve.answerApprovals('rejected')
    const view = await serve.request<{ sandbox: string }>('session/authority', { sessionId, sandbox: 'read-only' })
    expect(view.sandbox).toBe('read-only')
    const change = serve.events('sandbox/mode', sessionId).at(-1)!
    expect(dataOf<{ mode: string; reason: string }>(change)).toMatchObject({ mode: 'read-only', reason: 'change' })

    await serve.request('session/prompt', {
      sessionId,
      text: 'Append a second line reading "after the switch" to notes.txt. If a tool refuses, stop and say why.',
    })
    await serve.waitForCompletedTurn(sessionId, confined ? 5 : 4)
    refuseSwitch()
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).not.toContain('after the switch')
    expect(readFileSync(decoy).equals(decoyBytes)).toBe(true)

    // ---- 5. the log is still its own oracle -------------------------------
    const fresh = await serve.request<{ sessionId: string }>('session/prompt', {
      text: 'Create a file named done.txt in the working directory containing exactly: ok',
    })
    await serve.waitForCompletedTurn(fresh.sessionId, 1)
    const freshLog = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId: fresh.sessionId })
    await serve.shutdown()
    expect(freshLog.events.some((event) => event.type === 'sandbox/mode')).toBe(true)

    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayed = await runTask(
      {
        task: 'Create a file named done.txt in the working directory containing exactly: ok',
        cwd: tempDir('minidsh-auth-replay-ws-'),
        model: 'deepseek-v4-flash',
        sessionsRoot: tempDir('minidsh-auth-replay-'),
        logger: silent,
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events: freshLog.events })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
  })
})
