/**
 * The full-screen terminal, driven end to end over a scripted terminal: the
 * real `runTerminal`, the real protocol host and runtime on the scripted
 * model, keys written as a terminal sends them, and the screen read back
 * through a terminal model (`test-support/vt-screen.ts`). What a person would
 * see, and what they can and cannot do with a key.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { APPROVAL, type Approval } from '../../core/approval/index.ts'
import { LLM, type LlmRequest } from '../../core/llm/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE, type PreToolDecision } from '../../core/tools/index.ts'
import { assistantMessage, assistantText, assistantTextPaused, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { VtScreen } from '../../test-support/vt-screen.ts'
import { runTask } from '../headless.ts'
import { runTerminal } from './index.ts'
import { ARM_MS } from './tui.ts'
import { Tty } from './tty.ts'
import { graphemes, graphemeWidth } from './width.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Longer than the band's arming time with room for a loaded runner. */
const QUIET = 1100

async function waitFor(predicate: () => boolean, what: () => string, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what()}`)
    await sleep(15)
  }
}

/**
 * A clock the test moves. The approval band's arming rule is two durations
 * (on screen, keyboard quiet); a test that sleeps through them is slow, and
 * one that must act INSIDE one of them races a loaded host. Stepped, both are
 * exact: time passes only when the test says so.
 */
function steppedClock(start = 1_700_000_000_000) {
  let at = start
  return { now: () => at, advance: (ms: number): void => void (at += ms) }
}

/** The furthest cell any byte of `bytes` reaches (1-based), following its cursor moves: what a terminal was asked to draw, whatever its width. */
function reach(bytes: string): number {
  let x = 0
  let furthest = 0
  let i = 0
  while (i < bytes.length) {
    if (bytes[i] === '\x1b') {
      // oxlint-disable-next-line no-control-regex
      const csi = /^\x1b\[([?]?)([\d;]*)([A-Za-z])/.exec(bytes.slice(i, i + 32))
      if (csi === null) throw new Error(`an escape this walker does not know: ${JSON.stringify(bytes.slice(i, i + 12))}`)
      if (csi[3] === 'H') x = Number(csi[2]!.split(';')[1] || '1') - 1
      i += csi[0].length
      continue
    }
    if (bytes[i] === '\x07') {
      i++
      continue
    }
    const g = graphemes(bytes.slice(i, i + 16))[0]!
    x += graphemeWidth(g)
    furthest = Math.max(furthest, x)
    i += g.length
  }
  return furthest
}

/** A terminal of a given size: keys in, a screen model out. */
function scriptedTerminal(columns = 100, rows = 32, clock?: { readonly now: () => number }) {
  const input = new PassThrough()
  const output = new PassThrough()
  let screen = new VtScreen(columns, rows)
  let written = ''
  output.on('data', (chunk: Buffer) => {
    written += String(chunk)
    screen.write(String(chunk))
  })
  return {
    io: { input, output, fullScreen: { columns, rows, depth: 24 as const }, ...(clock === undefined ? {} : { now: clock.now }) },
    screen: () => screen,
    text: () => screen.text(),
    /** Every byte written from `from` on (a mark taken with `written().length`). */
    written: (from = 0) => written.slice(from),
    /** One chunk, as a terminal sends one key or one paste. */
    press: async (bytes: string) => {
      input.write(bytes)
      await sleep(40)
    },
    /** Typed text, then Enter as its own chunk (a burst ending in Enter would read as a paste). */
    say: async (text: string) => {
      input.write(text)
      await sleep(60)
      input.write('\r')
      await sleep(40)
    },
    see: (needle: string | RegExp, timeoutMs?: number) =>
      waitFor(
        () => (typeof needle === 'string' ? screen.text().includes(needle) : needle.test(screen.text())),
        () => `${String(needle)} on screen:\n${screen.text()}`,
        timeoutMs,
      ),
    resize: (nextColumns: number, nextRows: number) => {
      Object.assign(output, { columns: nextColumns, rows: nextRows })
      screen = screen.resize(nextColumns, nextRows)
      output.emit('resize')
    },
  }
}

function scriptedBoot(adapter: ScriptedAdapter, prepare?: (root: Context) => void) {
  return {
    logger: silent,
    patches: [{ id: 'llm-deepseek', disabled: true as const }],
    prepare: (root: Context) => {
      root.get(LLM).registerAdapter(root, adapter)
      prepare?.(root)
    },
  }
}

/** A reply that streams its head, then holds until a cancel aborts it (a gate that ignores the abort could never be cancelled). */
const untilCancelled = (head: string) => (request: LlmRequest) => assistantTextPaused(head, 'never shown', new Promise((resolve) => request.signal?.addEventListener('abort', () => resolve(undefined))))

const touchy = defineTool({
  name: 'touchy',
  description: 'needs approval',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  execute: () => ({ ok: true }),
  render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
})

const asksForTouchy = (root: Context): void => {
  root.get(TOOLS).register(root, touchy)
  root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'touchy' ? { kind: 'ask', reason: 'careful' } : next()))
}

describe('the full-screen terminal', () => {
  it('draws the welcome, streams a reply, and gives the terminal back exactly as it found it', async () => {
    const term = scriptedTerminal()
    const adapter = new ScriptedAdapter().script(assistantText('## Hello human\n\nA reply with `code` in it.'))
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('scripted/scripted-model')
    expect(term.screen().alternate).toBe(true)
    expect(term.screen().modes.get('?2004')).toBe(true)
    expect(term.text()).toContain('Ask for anything')
    await term.say('hi there')
    await term.see('Hello human')
    expect(term.text()).toContain('▎ hi there')
    expect(term.text()).toContain('● Hello human')
    expect(term.text()).toContain('A reply with code in it.')
    await term.see('ready')
    await term.press('\x04')
    expect(await exitCode).toBe(0)
    // Every mode it set is undone: the main screen, the cursor, paste, wrap.
    expect(term.screen().alternate).toBe(false)
    expect(term.screen().modes.get('?25')).toBe(true)
    expect(term.screen().modes.get('?2004')).toBe(false)
    expect(term.screen().modes.get('?7')).toBe(true)
    expect(term.screen().modes.get('?2026')).toBe(false)
    expect(term.screen().mainText).toMatch(/resume it with: minidsh resume session-/)
  })

  it('arms an approval only once the keyboard is quiet, and only a lone key answers', async () => {
    const term = scriptedTerminal()
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'touchy', {}), assistantText('tool went through'))
    const sessionsRoot = tempDir('tui-sessions-')
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot, confinement: 'none', ...scriptedBoot(adapter, asksForTouchy), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('use the tool')
    await term.see('Approval needed')
    expect(term.text()).toContain('model says: careful')
    // A `y` right behind another key is typing, not consent: it goes to the
    // draft beneath. The key before it is pressed HERE, so "typing" does not
    // depend on how long the band took to appear after the Enter above (on a
    // loaded host that gap passed the arming time, the `y` was an early answer
    // on a quiet keyboard instead, and it was swallowed).
    await term.press('x')
    await term.press('y')
    await term.see('draft: xy')
    // A chunk ending in `y` is a word being typed, never an answer.
    await sleep(QUIET)
    await term.press('abcy')
    await term.see('draft: xyabcy')
    // Enter and Esc never answer.
    await sleep(QUIET)
    await term.press('\r')
    await term.press('\x1b')
    await sleep(100)
    expect(term.text()).toContain('Approval needed')
    // Armed, then typing resumes: a `y` in the middle of typing is a letter of
    // the draft, never consent (the S22.1 review's blocker: once armed, it was).
    await sleep(QUIET)
    await term.press('o')
    await term.press('k')
    await term.press('y')
    await term.see('draft: xyabcyoky')
    expect(term.text()).toContain('Approval needed')
    // Quiet for the arming time, then a lone `y` answers.
    await sleep(QUIET)
    await term.press('y')
    await term.see('tool went through')
    expect(term.text()).toContain('Allowed once by you:')
    expect(term.screen().bells).toBe(1)
    // The draft typed meanwhile was kept, not sent.
    expect(adapter.calls).toHaveLength(2)
    await term.press('\x15')
    await term.see('ready', 30_000)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  /**
   * The other half of the arming rule, and the two answers no other test
   * gives. On a stepped clock, because the first step must act INSIDE the
   * arming time: a quiet keyboard and a band that has only just been drawn.
   */
  it('answers no band younger than its arming time, rejects on n, and takes a only where the host offered it', async () => {
    const clock = steppedClock()
    const term = scriptedTerminal(100, 32, clock)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const ran: string[] = []
    const guarded = defineTool({
      name: 'touchy',
      description: 'needs approval',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: () => {
        ran.push('touchy')
        return { ok: true }
      },
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    })
    let approval: Approval | undefined
    const keyed = defineTool({
      name: 'risky',
      description: 'asks for itself, with a subject the runtime can key',
      input: z.object({ command: z.string() }),
      output: z.object({ ok: z.boolean() }),
      execute: async (args, exec) => {
        const outcome = await approval!.request({ agent: exec.agent!, toolName: 'risky', callId: exec.callId, subject: { effect: 'shell-command', command: args.command, mode: 'danger-full-access', enforcement: 'none' } })
        if (outcome === 'allowed-once') ran.push(args.command)
        return { ok: outcome === 'allowed-once' }
      },
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    })
    const adapter = new ScriptedAdapter().script(
      // Held, so the keyboard can have been quiet for longer than the arming time when the band appears.
      async () => {
        await held
        return assistantToolCall('c1', 'touchy', {})
      },
      assistantText('moved on after the refusal'),
      assistantToolCall('c2', 'risky', { command: 'make test' }),
      assistantText('granted and done'),
    )
    const exitCode = runTerminal({
      cwd: tempDir('tui-cwd-'),
      sessionsRoot: tempDir('tui-sessions-'),
      confinement: 'none',
      ...scriptedBoot(adapter, (root) => {
        approval = root.get(APPROVAL)
        root.get(TOOLS).register(root, guarded)
        root.get(TOOLS).register(root, keyed)
        root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'touchy' ? { kind: 'ask', reason: 'careful' } : next()))
      }),
      ...SCRIPTED,
      io: term.io,
    })
    await term.see('Ask for anything')
    await term.say('use the tool')
    await term.see('esc to interrupt')
    clock.advance(1000)
    release()
    await term.see('Approval needed')
    // The keyboard has been quiet for a second, so this `y` is no letter of a
    // word: it is an answer, to a question drawn this instant. It is refused,
    // said, and neither decides anything nor lands in the draft.
    await term.press('y')
    await term.see('the answer keys arm in a moment: read it first')
    expect(term.text()).not.toContain('draft:')
    expect(term.text()).toContain('Approval needed')
    expect(adapter.calls, 'model requests after the early y').toHaveLength(1)
    // `a` is an answer only where the host offered that scope: here it is a letter.
    clock.advance(ARM_MS + 100)
    await term.press('a')
    await term.see('draft: a')
    expect(term.text()).toContain('Approval needed')
    expect(term.text()).not.toContain('allow for this session')
    // Armed, quiet, and `n`: rejected, and the tool's body never runs.
    clock.advance(ARM_MS + 100)
    await term.press('n')
    await term.see('Rejected by you:')
    await term.see('moved on after the refusal')
    expect(ran, `bodies that ran after n: ${JSON.stringify(ran)}`).toEqual([])
    await term.see('ready', 30_000)
    await term.press('\x15')
    // A question the runtime can key offers the scope, and `a` takes it.
    await term.say('use the risky tool')
    await term.see('allow for this session')
    clock.advance(ARM_MS + 100)
    await term.press('a')
    await term.see('Allowed for this session by you:')
    await term.see('granted and done')
    expect(ran, `bodies that ran after a: ${JSON.stringify(ran)}`).toEqual(['make test'])
    await term.see('ready', 30_000)
    // The grant it left is the session's, and listed.
    await term.say('/grants')
    await term.see('standing approvals')
    expect(term.text()).toMatch(/grant-\d+ {2}run make test under danger-full-access\/none/)
    await term.press('\x1b')
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  /**
   * The menu a person opened before a question arrived is the draft's, and the
   * draft can be edited under the band: left as it was, its highlighted item
   * ran on the next Enter in place of the message then typed (a sandbox
   * switch, in the review's reproduction).
   */
  it('keeps the command menu in step with a draft edited under an approval band, so Enter sends what was typed', async () => {
    const clock = steppedClock()
    const term = scriptedTerminal(100, 32, clock)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const adapter = new ScriptedAdapter().script(
      async () => {
        await held
        return assistantToolCall('c1', 'touchy', {})
      },
      assistantText('tool went through'),
      assistantText('ran the tests too'),
    )
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), confinement: 'none', ...scriptedBoot(adapter, asksForTouchy), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('use the tool')
    await term.see('esc to interrupt')
    // Half a command, typed while the turn runs: its menu is up, one item highlighted.
    await term.press('/sandbox d')
    await term.see('no file fence, no shell sandbox')
    release()
    await term.see('Approval needed')
    // Every key that edits the draft under the band moves the menu with it.
    // A menu row is a mode alone on its line; `d` matched two of the three.
    const offered = /^\s+(?:▸ )?workspace-write\s*$/m
    expect(term.text()).not.toMatch(offered)
    // Backspace: `/sandbox ` lists all three modes.
    await term.press('\x7f')
    await term.see(offered)
    expect(term.text()).toContain('no file fence, no shell sandbox')
    // A letter: `/sandbox k` leaves the one mode with a k in it, highlighted.
    await term.press('k')
    await term.see('draft: /sandbox k')
    await waitFor(() => !term.text().includes('no file fence, no shell sandbox'), () => `the menu narrowed to workspace-write:\n${term.text()}`)
    expect(term.text()).toContain('▸ workspace-write')
    // Ctrl+W takes the word back: all three again.
    await term.press('\x17')
    await term.see('no file fence, no shell sandbox')
    // Ctrl+U clears the draft, and the menu goes with the draft it belonged to.
    await term.press('\x15')
    await waitFor(() => !term.text().includes('no file fence, no shell sandbox'), () => `the menu closed:\n${term.text()}`)
    expect(term.text()).not.toMatch(offered)
    // A message typed in its place.
    await term.press('please also run the tests')
    await term.see('draft: please also run the tests')
    clock.advance(ARM_MS + 100)
    await term.press('y')
    await term.see('tool went through')
    await term.see('ready', 30_000)
    await term.press('\r')
    // What was typed is what was sent, and no authority moved.
    await term.see('ran the tests too')
    expect(term.text()).toContain('▎ please also run the tests')
    expect(term.text()).not.toContain('Sandbox set to')
    expect(term.text()).toContain('Workspace write')
    expect(JSON.stringify(adapter.calls.at(-1)!.messages)).toContain('please also run the tests')
    await term.see('ready', 30_000)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('shows a steer typed while a turn runs as queued until it lands, and Esc cancels the turn', async () => {
    const term = scriptedTerminal()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const adapter = new ScriptedAdapter().script(assistantTextPaused('working on it ', 'and done', held), assistantText('steered'))
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('start')
    await term.see('working on it')
    await term.see('esc to interrupt')
    // Two lines (Ctrl+J between them): the queued bubble lays them out as the
    // settled one will, a row each. Wrapped as one string, the line feed
    // measured no cells, the two ran together and each row's tail was clipped.
    await term.press('also check')
    await term.press('\n')
    await term.press('the tests')
    await term.press('\r')
    await term.see('queued')
    expect(term.text()).toMatch(/▎ also check\n\s*▎ the tests\n\s*queued/)
    release()
    await term.see('steered')
    expect(term.text()).not.toContain('queued')
    expect(term.text()).toMatch(/▎ also check\n\s*▎ the tests\n/)
    await term.see('ready', 30_000)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('cancels a running turn with Esc, keeping the conversation', async () => {
    const term = scriptedTerminal()
    const adapter = new ScriptedAdapter().script(untilCancelled('thinking about it '))
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('go')
    await term.see('thinking about it')
    await term.press('\x1b')
    await term.see('Turn cancelled')
    await term.see('ready')
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('refuses to leave a running session, starts a fresh one with /new, and resumes another in place', async () => {
    const sessionsRoot = tempDir('tui-sessions-')
    const cwd = tempDir('tui-cwd-')
    const stored = await runTask({ task: 'remember the plan', cwd, sessionsRoot, ...scriptedBoot(new ScriptedAdapter().script(assistantText('plan remembered'))), ...SCRIPTED }, undefined)
    expect(stored.exitCode).toBe(0)
    const term = scriptedTerminal()
    const adapter = new ScriptedAdapter().script(untilCancelled('busy '), assistantText('the second session answered'))
    const exitCode = runTerminal({ cwd, sessionsRoot, ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('start')
    await term.see('busy')
    await term.say('/new')
    await term.see('the turn is still running')
    await term.press('\x1b')
    await term.see('Turn cancelled')
    // "Turn cancelled" is drawn when the cancel is asked; the session is
    // switchable only once the turn has ended. Without this wait a loaded
    // host types the second /new into a turn still running, and it is
    // refused again (CI, windows-latest, 2026-11-20).
    await term.see('ready')
    await term.say('/new')
    await term.see('a fresh session starts with your next message')
    await term.see('Ask for anything')
    // The first message after `/new`: the connection watches NOTHING by then
    // (it detached the session it left), so none of the new session's first
    // frames stream to it. What was appended before its attach (the opening
    // stamps at the least; on a slow host the message and the reply too)
    // reaches the view only through the page that attach returns.
    await term.say('a message for the second session')
    await term.see('▎ a message for the second session')
    await term.see('the second session answered')
    await term.see('ready', 30_000)
    expect(term.text(), 'the second session, from its first event').toMatch(/· opened · approvals: ask · sandbox: workspace-write/)
    expect(term.text()).not.toContain('busy')
    await term.say('/new')
    await term.see('a fresh session starts with your next message')
    await term.see('Ask for anything')
    // A preset chosen for the session the next message would create is drawn
    // as the pair it selects, and is DROPPED by opening another session
    // instead: it never comes back as the opening of an unrelated one (the
    // S22.1 pre-push review).
    await term.say('/preset danger-full-access')
    await term.see('applies when the session starts')
    await term.see('Full access')
    await term.say(`/resume ${stored.sessionId}`)
    await term.see('plan remembered')
    expect(term.text()).toContain('▎ remember the plan')
    await term.see('ready', 30_000)
    expect(term.text()).not.toContain('Full access')
    // `/new` again: the dropped preset would show here if it had survived.
    await term.say('/new')
    await term.see('a fresh session starts with your next message')
    await term.see('Workspace write')
    expect(term.text()).not.toContain('Full access')
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it("draws a running child's latest actions on its delegate card", { timeout: 90_000 }, async () => {
    const term = scriptedTerminal(110, 34)
    let release!: () => void
    const childGate = new Promise<void>((resolve) => (release = resolve))
    const echo = defineTool({
      name: 'echo',
      description: 'echoes',
      input: z.object({ text: z.string() }),
      output: z.string(),
      execute: ({ text }) => text,
      render: (_args, value) => [{ type: 'text', text: value }],
    })
    const adapter = new ScriptedAdapter()
      .script(assistantMessage([{ text: 'delegating' }, { call: ['p1', 'subagent', { description: 'look around', prompt: 'look around the repo' }] }]))
      .scriptWhen((request) => JSON.stringify(request.messages).includes('look around the repo'), assistantToolCall('k1', 'echo', { text: 'child was here' }), async () => {
        await childGate
        return assistantText('child report')
      })
      .script(assistantText('parent summary'))
    const exitCode = runTerminal({
      cwd: tempDir('tui-cwd-'),
      sessionsRoot: tempDir('tui-sessions-'),
      ...scriptedBoot(adapter, (root) => root.get(TOOLS).register(root, echo)),
      ...SCRIPTED,
      io: term.io,
    })
    await term.see('Ask for anything')
    await term.say('please delegate')
    await term.see('Delegate a task')
    await term.see('1 subagent')
    // The child's own call, seen through the read-only attach.
    await term.see('echo', 30_000)
    release()
    await term.see('parent summary', 30_000)
    await term.see('ready', 30_000)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('opens the first session under the authority chosen before it, and keeps a mistyped command', async () => {
    const term = scriptedTerminal()
    const adapter = new ScriptedAdapter().script(assistantText('opened as asked'))
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    // A value outside the closed list fails at the command, not at the first prompt.
    await term.say('/sandbox nonsense')
    await term.see('/sandbox takes read-only | workspace-write | danger-full-access')
    await term.say('/sandbox read-only')
    await term.see('applies when the session starts')
    await term.see('Read only')
    // An unknown command is the person's to fix: the line stays in the composer.
    await term.say('/nosuch thing')
    await term.see('unknown command /nosuch')
    expect(term.text()).toContain('/nosuch thing')
    await term.press('\x15')
    await term.say('hello')
    await term.see('opened as asked')
    // The switch was the creating prompt's opening: a durable fact in the conversation, before the reply.
    await term.see('Sandbox set to read-only · enforcement')
    expect(term.text()).toContain('Read only')
    await term.see('ready', 30_000)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('overrides one half of a preset chosen before the first message with a knob set after it, and keeps the other', async () => {
    const term = scriptedTerminal()
    const adapter = new ScriptedAdapter().script(assistantText('opened under the pair'))
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('/preset danger-full-access')
    await term.see('applies when the session starts')
    await term.see(/Full access · never/)
    // One knob after the preset, as on a live session: the sandbox changes and
    // the preset's approval policy stays. Dropping the preset whole put the
    // policy back at the host's default.
    await term.say('/sandbox read-only')
    await term.see(/Read only · never/)
    expect(term.text()).not.toMatch(/Read only · ask/)
    // And that pair is what the creating message opens the session under.
    await term.say('hello')
    await term.see('opened under the pair')
    await term.see('Sandbox set to read-only · enforcement')
    await term.see('ready', 30_000)
    expect(term.text()).toMatch(/Read only · never/)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('scrolls the help list, and answers a long question only once it was read to its end', async () => {
    const term = scriptedTerminal(80, 20)
    const longy = defineTool({
      name: 'longy',
      description: 'needs approval, with a long argument',
      input: z.object({ text: z.string() }),
      output: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    })
    const body = Array.from({ length: 40 }, (_, index) => `line ${index} of the payload`).join('\n') + '\nTHE LAST LINE'
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'longy', { text: body }), assistantText('long one went through'))
    const exitCode = runTerminal({
      cwd: tempDir('tui-cwd-'),
      sessionsRoot: tempDir('tui-sessions-'),
      confinement: 'none',
      ...scriptedBoot(adapter, (root) => {
        root.get(TOOLS).register(root, longy)
        root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'longy' ? { kind: 'ask', reason: 'a long reason '.repeat(30) } : next()))
      }),
      ...SCRIPTED,
      io: term.io,
    })
    await term.see('Ask for anything')
    // Help is longer than this screen: it scrolls, and says where it is.
    await term.say('/help')
    await term.see(/ 1-\d+ of \d+/)
    await term.press('\x1b[B')
    await term.see(/ 2-\d+ of \d+/)
    await term.press('\x1b')
    await term.say('use the long tool')
    await term.see('Approval needed')
    await term.see('read to the end to answer')
    // The model's claim is clamped to two rows, and the clamp says so.
    expect(term.text()).toMatch(/model says: a long reason/)
    expect(term.text()).toMatch(/a long reason a long[^\n]*… *\n/)
    // Armed by time, but not read: a lone y is refused, and nothing is decided.
    await sleep(QUIET)
    await term.press('y')
    await term.see('scroll through the whole question')
    expect(adapter.calls).toHaveLength(1)
    // Scrolled by the band's own indicator: the card above already shows the payload.
    const atEnd = (): boolean => {
      const where = / (\d+)-(\d+) of (\d+) lines/.exec(term.text())
      return where !== null && where[2] === where[3]
    }
    for (let step = 0; step < 80 && !atEnd(); step++) await term.press('\x1b[B')
    expect(atEnd(), term.text()).toBe(true)
    await sleep(QUIET)
    await term.press('y')
    await term.see('long one went through')
    await term.see('ready', 30_000)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('redraws whole at a new size', async () => {
    const term = scriptedTerminal(100, 30)
    const adapter = new ScriptedAdapter().script(assistantText('a reply that is long enough to wrap differently once the terminal becomes narrow'))
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('hello')
    await term.see('narrow')
    // Idle, so nothing but the resize redraws from here.
    await term.see('ready', 30_000)
    const beforeResize = term.written().length
    // The walker's own control: what was drawn at 100 columns reaches column 100, so a write past a narrower edge would be seen.
    expect(reach(term.written()), 'the furthest cell written at 100 columns').toBe(100)
    term.resize(50, 20)
    await term.see(/╭─{48}╮/)
    // Read from the BYTES written since the resize: the screen model above
    // drops whatever is written past its edge, so its rows fit at any width
    // whatever the view drew.
    const since = term.written(beforeResize)
    expect(reach(since), `the furthest cell written after a resize to 50 columns:\n${JSON.stringify(since.slice(0, 400))}`).toBeLessThanOrEqual(50)
    expect(reach(since), 'the redraw reached the new right edge').toBe(50)
    term.resize(30, 10)
    await term.see('Enlarge the terminal')
    term.resize(80, 24)
    await term.see(/╭─{78}╮/)
    await term.see('ready', 30_000)
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })

  it('lists keys and commands from the palette, and runs the highlighted one on Enter', async () => {
    const term = scriptedTerminal()
    const exitCode = runTerminal({ cwd: tempDir('tui-cwd-'), sessionsRoot: tempDir('tui-sessions-'), ...scriptedBoot(new ScriptedAdapter()), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.press('/he')
    await term.see('/help')
    await term.press('\r')
    await term.see('keys and commands')
    expect(term.text()).toContain('Ctrl+J')
    await term.press('\x1b')
    await sleep(80)
    expect(term.text()).not.toContain('keys and commands')
    await term.press('\x04')
    expect(await exitCode).toBe(0)
  })
})

describe('owning the terminal', () => {
  const MODES_SET = '\x1b[?1049h\x1b[?2004h\x1b[?7l\x1b[?25l'
  const MODES_UNDONE = '\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?7h\x1b[?2004l\x1b[?1049l'

  /**
   * The paths nobody calls `leave` on: a signal, a crash, the process ending.
   * The real process's terminal (`ownProcess`) registers a handler for each,
   * and each must leave the terminal as it found it BEFORE the process goes.
   */
  it('undoes its modes when the process is signalled, crashes or exits, before it ends', () => {
    const exits: (number | string | null | undefined)[] = []
    const realExit = process.exit
    const realStderr = process.stderr.write
    process.exit = ((code?: number | string | null) => {
      exits.push(code)
      return undefined as never
    }) as typeof process.exit
    /** A terminal this process owns, entered; and the listeners entering it added for `event`. */
    const entered = (event: string) => {
      const raws: boolean[] = []
      const written: string[] = []
      const input = Object.assign(new PassThrough(), { setRawMode: (raw: boolean) => void raws.push(raw) })
      const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
      output.on('data', (chunk: Buffer) => written.push(String(chunk)))
      const before = new Set(process.listeners(event as 'exit'))
      const tty = new Tty({ input, output }, true)
      tty.enter()
      const added = process.listeners(event as 'exit').filter((listener) => !before.has(listener)) as ((...args: unknown[]) => void)[]
      return { tty, raws, written: () => written.join(''), added }
    }
    try {
      const signals: readonly (readonly [NodeJS.Signals, number])[] = [['SIGTERM', 143], ['SIGHUP', 143], ['SIGINT', 130], ...(process.platform === 'win32' ? ([['SIGBREAK', 143]] as const) : [])]
      for (const [signal, code] of signals) {
        const term = entered(signal)
        expect(term.added, `handlers registered for ${signal}`).toHaveLength(1)
        expect(term.written()).toBe(MODES_SET)
        term.added[0]!(signal)
        expect(term.written(), `after ${signal}`).toBe(`${MODES_SET}${MODES_UNDONE}`)
        expect(term.raws, `raw mode after ${signal}`).toEqual([true, false])
        expect(exits.at(-1), `exit code after ${signal}`).toBe(code)
        // Undone once: its handlers are gone, and a late `leave` writes nothing more.
        expect(process.listeners(signal)).not.toContain(term.added[0])
        term.tty.leave()
        expect(term.written()).toBe(`${MODES_SET}${MODES_UNDONE}`)
      }
      for (const crash of ['uncaughtException', 'unhandledRejection'] as const) {
        // The stream the view captures while the screen is its own, and gives back with it.
        const said: string[] = []
        process.stderr.write = ((chunk: string) => {
          said.push(String(chunk))
          return true
        }) as typeof process.stderr.write
        const term = entered(crash)
        expect(term.added, `handlers registered for ${crash}`).toHaveLength(1)
        term.added[0]!(new Error(`boom from ${crash}`))
        process.stderr.write = realStderr
        expect(term.written(), `after ${crash}`).toBe(`${MODES_SET}${MODES_UNDONE}`)
        expect(term.raws, `raw mode after ${crash}`).toEqual([true, false])
        // The crash is said on the stream the terminal was given back to, not into the capture.
        expect(said.join(''), `stderr after ${crash}`).toContain(`minidsh: Error: boom from ${crash}`)
        expect(exits.at(-1), `exit code after ${crash}`).toBe(1)
      }
      const term = entered('exit')
      expect(term.added, 'handlers registered for exit').toHaveLength(1)
      term.added[0]!(0)
      expect(term.written(), 'after the process exit event').toBe(`${MODES_SET}${MODES_UNDONE}`)
      expect(term.raws).toEqual([true, false])
    } finally {
      process.exit = realExit
      process.stderr.write = realStderr
    }
  })

  it('sets a fixed table of modes and undoes it in reverse, once, on an explicit leave', () => {
    const input = Object.assign(new PassThrough(), { setRawMode: (raw: boolean) => void raws.push(raw) })
    const raws: boolean[] = []
    const written: string[] = []
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
    output.on('data', (chunk: Buffer) => written.push(String(chunk)))
    const tty = new Tty({ input, output }, false)
    tty.enter()
    tty.enter()
    tty.leave()
    tty.leave()
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(raws).toEqual([true, false])
        expect(written.join('')).toBe('\x1b[?1049h\x1b[?2004h\x1b[?7l\x1b[?25l\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?7h\x1b[?2004l\x1b[?1049l')
        resolve()
      })
    })
  })

  it("while the screen is its own, holds what other code writes to stderr and says it afterwards", () => {
    const input = new PassThrough()
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
    const tty = new Tty({ input, output }, true)
    const seen: string[] = []
    tty.onCaptured = (text) => seen.push(text)
    const real = process.stderr.write
    const printed: string[] = []
    process.stderr.write = ((chunk: string) => {
      printed.push(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      tty.enter()
      process.stderr.write('warn: a stray line\n')
      expect(seen).toEqual(['warn: a stray line\n'])
      expect(printed).toEqual([])
      tty.leave()
      expect(printed).toEqual(['warn: a stray line\n'])
    } finally {
      process.stderr.write = real
    }
  })
})
