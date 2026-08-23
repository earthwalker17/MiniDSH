/** The terminal surface: pure render folds plus scripted end-to-end runs over the loopback pair. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { APPROVAL } from '../../core/approval/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { createAssistantMessage, createUserMessage } from '../../core/llm/message.ts'
import type { EventEnvelope } from '../../core/session/index.ts'
import { defineTool, TOOLS, TOOLS_PRE_EXECUTE, type PreToolDecision } from '../../core/tools/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { runTask } from '../headless.ts'
import { renderHistory, TerminalRenderer } from './render.ts'
import { runTerminal } from './index.ts'

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

function chunkEvent(chunk: unknown, seq: number): EventEnvelope {
  return { type: 'assistant/chunk', seq, time: 1, data: { turn: 1, step: 1, attempt: 1, chunk } }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface TerminalDriver {
  readonly input: PassThrough
  readonly output: PassThrough
  readonly text: () => string
  readonly type: (line: string) => void
  readonly see: (needle: string) => Promise<void>
}

function terminalDriver(): TerminalDriver {
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (chunk: Buffer) => {
    text += String(chunk)
  })
  return {
    input,
    output,
    text: () => text,
    type: (line) => void input.write(`${line}\n`),
    see: (needle) => waitFor(() => text.includes(needle), `terminal output "${needle}"`),
  }
}

const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

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

describe('terminal render (pure)', () => {
  it('streams text deltas raw, closes the line on finish, and marks thinking once', () => {
    const renderer = new TerminalRenderer()
    expect(renderer.onEvent(chunkEvent({ type: 'reasoning-delta', index: 0, text: 'hmm' }, 0))).toBe('… thinking\n')
    expect(renderer.onEvent(chunkEvent({ type: 'reasoning-delta', index: 0, text: 'more' }, 1))).toBe('')
    expect(renderer.onEvent(chunkEvent({ type: 'text-delta', index: 1, text: 'hel' }, 2))).toBe('hel')
    expect(renderer.onEvent(chunkEvent({ type: 'text-delta', index: 1, text: 'lo' }, 3))).toBe('lo')
    expect(renderer.onEvent(chunkEvent({ type: 'finish', reason: { kind: 'stop' } }, 4))).toBe('\n')
    // The next step starts fresh.
    expect(renderer.onEvent(chunkEvent({ type: 'reasoning-delta', index: 0, text: 'again' }, 5))).toBe('… thinking\n')
  })

  it('renders a stored transcript from durable surface events', () => {
    const logged = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
    const events: EventEnvelope[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1, data: { message: logged(createUserMessage('fix the bug')) }, surfaceOp: { op: 'append' } },
      { type: 'tool/call', seq: 2, time: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'shell', arguments: '{"command":"ls"}' } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 1,
        data: { message: logged(createAssistantMessage([{ type: 'text', text: 'done, fixed' }], 'p', 'm')) },
        surfaceOp: { op: 'append' },
      },
    ]
    expect(renderHistory(events)).toBe('you> fix the bug\n→ shell {"command":"ls"}\ndone, fixed\n')
  })
})

describe('terminal surface (scripted end-to-end over the loopback pair)', () => {
  it('runs a chat: prompt in, streamed answer out, /exit quits cleanly', async () => {
    const driver = terminalDriver()
    const adapter = new ScriptedAdapter().script(assistantText('hello human'))
    const exitCode = runTerminal({
      cwd: tempDir('minidsh-term-cwd-'),
      sessionsRoot: tempDir('minidsh-term-sessions-'),
      ...scriptedBoot(adapter),
      ...SCRIPTED,
      io: { input: driver.input, output: driver.output },
    })
    await driver.see('you> ')
    driver.type('hi there')
    await driver.see('hello human')
    driver.type('/exit')
    expect(await exitCode).toBe(0)
    expect(adapter.calls).toHaveLength(1)
  })

  it('asks for approval on the durable frame and applies the typed answer', async () => {
    const touchy = defineTool({
      name: 'touchy',
      description: 'needs approval',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
      render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
    })
    const driver = terminalDriver()
    const adapter = new ScriptedAdapter().script(assistantToolCall('c1', 'touchy', {}), assistantText('tool went through'))
    const exitCode = runTerminal({
      cwd: tempDir('minidsh-term-cwd-'),
      sessionsRoot: tempDir('minidsh-term-sessions-'),
      ...scriptedBoot(adapter, (root) => {
        root.get(TOOLS).register(root, touchy)
        root.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => (execution.name === 'touchy' ? { kind: 'ask', reason: 'careful' } : next()))
      }),
      ...SCRIPTED,
      io: { input: driver.input, output: driver.output },
    })
    await driver.see('you> ')
    driver.type('use the tool')
    await driver.see('approve touchy (careful)? [y/N] ')
    driver.type('y')
    await driver.see('tool went through')
    driver.type('/exit')
    expect(await exitCode).toBe(0)
  })

  it('resumes a stored session interactively: transcript first, then the conversation continues', async () => {
    const sessionsRoot = tempDir('minidsh-term-sessions-')
    const cwd = tempDir('minidsh-term-cwd-')
    const first = await runTask({
      task: 'remember the plan',
      cwd,
      model: 'scripted-model',
      provider: 'scripted',
      sessionsRoot,
      ...scriptedBoot(new ScriptedAdapter().script(assistantText('plan remembered'))),
    })
    expect(first.exitCode).toBe(0)

    const driver = terminalDriver()
    const exitCode = runTerminal({
      cwd,
      sessionsRoot,
      resumeId: first.sessionId,
      ...scriptedBoot(new ScriptedAdapter().script(assistantText('continuing the plan'))),
      io: { input: driver.input, output: driver.output },
    })
    await driver.see(`resumed ${first.sessionId}`)
    expect(driver.text()).toContain('you> remember the plan')
    expect(driver.text()).toContain('plan remembered')
    driver.type('go on')
    await driver.see('continuing the plan')
    driver.type('/exit')
    expect(await exitCode).toBe(0)
  })
})

describe('terminal authority', () => {
  it('switches the session over the wire and shows the switch as the durable event', async () => {
    const driver = terminalDriver()
    const adapter = new ScriptedAdapter().script(assistantText('hello there'), assistantText('still here'))
    const exitCode = runTerminal({
      cwd: tempDir('minidsh-term-cwd-'),
      sessionsRoot: tempDir('minidsh-term-sessions-'),
      ...scriptedBoot(adapter),
      ...SCRIPTED,
      io: { input: driver.input, output: driver.output },
    })
    await driver.see('you> ')
    driver.type('hi')
    await driver.see('hello there')

    driver.type('/sandbox read-only')
    await driver.see('sandbox: read-only')
    // The durable event is what the transcript shows, not a client-side echo.
    await driver.see('[sandbox: read-only')

    driver.type('/sandbox nonsense')
    await driver.see('must be read-only')
    driver.type('/exit')
    expect(await exitCode).toBe(0)
  })

  it('answers a shell escalation with y and shows the durable decision', async () => {
    const driver = terminalDriver()
    const adapter = new ScriptedAdapter().script(
      assistantToolCall('c1', 'risky', { command: 'rm -rf /' }),
      assistantText('escalation handled'),
    )
    const exitCode = runTerminal({
      cwd: tempDir('minidsh-term-cwd-'),
      sessionsRoot: tempDir('minidsh-term-sessions-'),
      ...scriptedBoot(adapter, (root) => {
        root.get(TOOLS).register(
          root,
          defineTool({
            name: 'risky',
            description: 'asks to widen its own authority',
            input: z.object({ command: z.string() }),
            output: z.object({ ok: z.boolean() }),
            render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
            execute: async (_args, exec) => {
              const outcome = await root.get(APPROVAL).request({
                agent: exec.agent!,
                toolName: 'risky',
                callId: exec.callId,
                reason: 'run under "danger-full-access": the suite needs the network',
              })
              return { ok: outcome === 'allowed-once' }
            },
          }),
        )
      }),
      ...SCRIPTED,
      io: { input: driver.input, output: driver.output },
    })
    await driver.see('you> ')
    driver.type('do the risky thing')
    await driver.see('approve risky (run under "danger-full-access": the suite needs the network)? [y/N] ')
    driver.type('y')
    await driver.see('escalation handled')
    driver.type('/exit')
    expect(await exitCode).toBe(0)
  })
})
