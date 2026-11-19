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
import { LLM, type LlmRequest } from '../../core/llm/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE, type PreToolDecision } from '../../core/tools/index.ts'
import { assistantMessage, assistantText, assistantTextPaused, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { VtScreen } from '../../test-support/vt-screen.ts'
import { runTask } from '../headless.ts'
import { runTerminal } from './index.ts'
import { Tty } from './tty.ts'

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

/** A terminal of a given size: keys in, a screen model out. */
function scriptedTerminal(columns = 100, rows = 32) {
  const input = new PassThrough()
  const output = new PassThrough()
  let screen = new VtScreen(columns, rows)
  output.on('data', (chunk: Buffer) => screen.write(String(chunk)))
  return {
    io: { input, output, fullScreen: { columns, rows, depth: 24 as const } },
    screen: () => screen,
    text: () => screen.text(),
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
    // At once, a `y` is typing, not consent: it goes to the draft beneath.
    await term.press('y')
    await term.see('draft: y')
    // A chunk ending in `y` is a word being typed, never an answer.
    await sleep(QUIET)
    await term.press('abcy')
    await term.see('draft: yabcy')
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
    await term.see('draft: yabcyoky')
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
    await term.say('also check the tests')
    await term.see('queued')
    release()
    await term.see('steered')
    expect(term.text()).not.toContain('queued')
    expect(term.text()).toContain('▎ also check the tests')
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
    const adapter = new ScriptedAdapter().script(untilCancelled('busy '))
    const exitCode = runTerminal({ cwd, sessionsRoot, ...scriptedBoot(adapter), ...SCRIPTED, io: term.io })
    await term.see('Ask for anything')
    await term.say('start')
    await term.see('busy')
    await term.say('/new')
    await term.see('the turn is still running')
    await term.press('\x1b')
    await term.see('Turn cancelled')
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
        root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'longy' ? { kind: 'ask', reason: 'long' } : next()))
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
    await term.see('become', 6000).catch(() => {})
    await term.see('narrow')
    term.resize(50, 20)
    await term.see(/╭─{48}╮/)
    expect(term.text().split('\n').every((row) => row.length <= 50)).toBe(true)
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
  it('sets a fixed table of modes and undoes it in reverse, once, on any path', () => {
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
