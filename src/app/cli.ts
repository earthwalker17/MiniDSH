/**
 * The headless CLI surface. It renders exclusively from `session/event`, drives
 * only `ctx.agents`/`ctx.sessions` via the runner, and exits 0 iff the turn
 * completed. `--json` streams raw session events to stdout; `sessions show`
 * reads the log only.
 */
import { createRoot, type Logger } from '../kernel/index.ts'
import { messageText, restoreMessage } from '../core/llm/message.ts'
import { PERSISTENCE, type Persistence } from '../core/persistence/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { persistenceJsonlPlugin } from '../capabilities/persistence-jsonl/index.ts'
import { compose, defaultAgentOptions, defaultDialect } from './compose.ts'
import { forkTask, resumeTask, runTask, type ContinueOptions, type EventListener, type TaskResult } from './headless.ts'
import { sessionsDir } from './home.ts'
import { startProtocolHost } from './serve.ts'
import { runTerminal } from './terminal/index.ts'

interface ParsedArgs {
  readonly command: string
  readonly positional: string[]
  readonly flags: Map<string, string | true>
}

const VALUE_FLAGS = new Set(['cwd', 'model', 'effort', 'max-steps', 'at'])

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const command = argv[0] ?? 'help'
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (VALUE_FLAGS.has(name)) flags.set(name, argv[++i] ?? '')
      else flags.set(name, true)
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags }
}

function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Human-readable progress line for one session event, or undefined to skip. */
function renderEvent(event: EventEnvelope): string | undefined {
  switch (event.type) {
    case 'user/message': {
      const message = restoreMessage((event.data as { message: Parameters<typeof restoreMessage>[0] }).message)
      return message.source.kind === 'user' ? undefined : `  · context (${message.source.kind})`
    }
    case 'tool/call': {
      const data = event.data as { name: string; arguments: string }
      return `  → ${data.name} ${preview(data.arguments)}`
    }
    case 'tool/result': {
      const data = event.data as { error?: { code: string } }
      return data.error ? `    ✗ ${data.error.code}` : '    ✓'
    }
    case 'assistant/message': {
      const text = messageText(restoreMessage((event.data as { message: Parameters<typeof restoreMessage>[0] }).message))
      return text.length > 0 ? `  ${preview(text, 120)}` : undefined
    }
    case 'turn/end': {
      const data = event.data as { reason: { kind: string } }
      return `  [turn ${data.reason.kind}]`
    }
    default:
      return undefined
  }
}

async function runCommand(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim()
  if (task.length === 0) {
    process.stderr.write('usage: minidsh run "<task>" [--cwd dir] [--model id] [--effort id] [--max-steps n] [--approve] [--json]\n')
    return 2
  }
  const json = args.flags.get('json') === true
  const cwd = typeof args.flags.get('cwd') === 'string' ? (args.flags.get('cwd') as string) : process.cwd()
  const model = typeof args.flags.get('model') === 'string' ? (args.flags.get('model') as string) : defaultAgentOptions().model
  const effort = typeof args.flags.get('effort') === 'string' ? (args.flags.get('effort') as string) : undefined
  const maxStepsRaw = args.flags.get('max-steps')
  const maxSteps = typeof maxStepsRaw === 'string' ? Number(maxStepsRaw) : undefined

  if (args.flags.get('dump-config') === true) {
    const rows = compose({ sessionsRoot: sessionsDir(), dialect: defaultDialect() })
    process.stdout.write(`${JSON.stringify(rows.map((row) => ({ id: row.id, plugin: row.plugin.name, config: row.config ?? null })), null, 2)}\n`)
    return 0
  }

  try {
    const result = await runTask(
      {
        task,
        cwd,
        model,
        sessionsRoot: sessionsDir(),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(maxSteps === undefined || Number.isNaN(maxSteps) ? {} : { maxSteps }),
        approve: args.flags.get('approve') === true,
      },
      eventPrinter(json),
    )
    return finishTask(result, json)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function eventPrinter(json: boolean): EventListener {
  // --json emits the wire frame: one {sessionId, event} per line.
  return json
    ? (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
    : (frame) => {
        const line = renderEvent(frame.event)
        if (line) process.stderr.write(`${line}\n`)
      }
}

function finishTask(result: TaskResult, json: boolean): number {
  if (!json) process.stdout.write(`${result.text}\n`)
  if (result.reason !== 'completed') process.stderr.write(`turn ended: ${result.reason}\n`)
  process.stderr.write(`session: ${result.sessionId}\n`)
  return result.exitCode
}

interface CommonModelFlags {
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
}

function modelFlags(args: ParsedArgs): CommonModelFlags {
  const model = args.flags.get('model')
  const effort = args.flags.get('effort')
  const maxStepsRaw = args.flags.get('max-steps')
  const maxSteps = typeof maxStepsRaw === 'string' ? Number(maxStepsRaw) : undefined
  return {
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
    ...(maxSteps === undefined || Number.isNaN(maxSteps) ? {} : { maxSteps }),
  }
}

/**
 * `minidsh resume <id>` / `minidsh fork <id>` — interactive by default;
 * `--headless` (task required) is the scripted one-shot.
 */
async function continueCommand(args: ParsedArgs, kind: 'resume' | 'fork'): Promise<number> {
  const id = args.positional[0]
  const task = args.positional.slice(1).join(' ').trim()
  const headless = args.flags.get('headless') === true
  if (!id || (headless && task.length === 0)) {
    process.stderr.write(
      `usage: minidsh ${kind} <id> ["<task>"]${kind === 'fork' ? ' [--at seq]' : ''} [--headless] [--model id] [--effort id] [--max-steps n] [--approve] [--json]\n`,
    )
    return 2
  }
  const atRaw = args.flags.get('at')
  const boundary = typeof atRaw === 'string' ? Number(atRaw) : undefined
  const approve = args.flags.get('approve') === true

  if (!headless) {
    try {
      return await runTerminal({
        cwd: process.cwd(),
        sessionsRoot: sessionsDir(),
        approve,
        ...(kind === 'resume' ? { resumeId: id } : { forkId: id }),
        ...(kind === 'fork' && boundary !== undefined && !Number.isNaN(boundary) ? { boundary } : {}),
        ...(task.length > 0 ? { task } : {}),
        ...modelFlags(args),
        logger: stderrLogger,
      })
    } catch (error) {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const json = args.flags.get('json') === true
  const options: ContinueOptions = {
    id,
    task,
    sessionsRoot: sessionsDir(),
    ...modelFlags(args),
    ...(kind === 'fork' && boundary !== undefined && !Number.isNaN(boundary) ? { boundary } : {}),
    approve,
  }
  try {
    const result = kind === 'resume' ? await resumeTask(options, eventPrinter(json)) : await forkTask(options, eventPrinter(json))
    return finishTask(result, json)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** `minidsh chat` — a fresh interactive session over the protocol. */
async function chatCommand(args: ParsedArgs): Promise<number> {
  const cwd = typeof args.flags.get('cwd') === 'string' ? (args.flags.get('cwd') as string) : process.cwd()
  const task = args.positional.join(' ').trim()
  try {
    return await runTerminal({
      cwd,
      sessionsRoot: sessionsDir(),
      approve: args.flags.get('approve') === true,
      ...(task.length > 0 ? { task } : {}),
      ...modelFlags(args),
      logger: stderrLogger,
    })
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const stderrLogger: Logger = {
  warn: (message) => process.stderr.write(`warn: ${message}\n`),
  error: (message) => process.stderr.write(`error: ${message}\n`),
}

/** Mounts the persistence provider on a bare root and hands its Definition to `use`. */
async function withPersistence<T>(use: (persistence: Persistence) => T): Promise<T> {
  const root = createRoot({ logger: stderrLogger })
  root.plugin(persistenceJsonlPlugin, { root: sessionsDir() })
  await root.settle()
  try {
    return use(root.get(PERSISTENCE))
  } finally {
    await root.dispose()
  }
}

/** `minidsh serve` — the JSON-RPC protocol on process stdio; stdout carries only frames. */
async function serveCommand(args: ParsedArgs): Promise<number> {
  const cwd = typeof args.flags.get('cwd') === 'string' ? (args.flags.get('cwd') as string) : process.cwd()
  try {
    const host = await startProtocolHost({
      cwd,
      sessionsRoot: sessionsDir(),
      approve: args.flags.get('approve') === true,
      logger: stderrLogger,
    })
    await host.closed
    await host.dispose()
    return 0
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function sessionsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0]
  if (sub === 'list') {
    return withPersistence((persistence) => {
      for (const header of persistence.list()) {
        process.stdout.write(`${header.id}\t${new Date(header.createdAt).toISOString()}\t${header.cwd}\n`)
      }
      return 0
    })
  }
  if (sub === 'show') {
    const id = args.positional[1]
    if (!id) {
      process.stderr.write('usage: minidsh sessions show <id>\n')
      return 2
    }
    return withPersistence((persistence) => {
      const stored = persistence.load(id)
      if (!stored) {
        process.stderr.write(`no session "${id}"\n`)
        return 1
      }
      if (args.flags.get('json') === true) {
        for (const event of stored.events) process.stdout.write(`${JSON.stringify({ sessionId: stored.header.id, event })}\n`)
      } else {
        process.stdout.write(`session ${stored.header.id} (cwd ${stored.header.cwd})\n`)
        for (const event of stored.events) {
          const line = renderEvent(event)
          process.stdout.write(`${String(event.seq).padStart(4)}  ${event.type}${line ? ` ${line.trim()}` : ''}\n`)
        }
        if (stored.damaged) process.stderr.write('warning: the stored log is damaged beyond this point\n')
      }
      return 0
    })
  }
  process.stderr.write('usage: minidsh sessions <list|show>\n')
  return 2
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  switch (args.command) {
    case 'run':
      return runCommand(args)
    case 'chat':
      return chatCommand(args)
    case 'resume':
      return continueCommand(args, 'resume')
    case 'fork':
      return continueCommand(args, 'fork')
    case 'serve':
      return serveCommand(args)
    case 'sessions':
      return sessionsCommand(args)
    default:
      process.stdout.write(
        'MiniDSH — usage:\n' +
          '  minidsh run "<task>" [--cwd dir] [--model id] [--effort id] [--max-steps n] [--approve] [--json]\n' +
          '  minidsh chat ["<task>"] [--cwd dir] [--model id] [--effort id] [--approve]\n' +
          '  minidsh resume <id> ["<task>"] [--headless] [--model id] [--effort id] [--max-steps n] [--approve] [--json]\n' +
          '  minidsh fork <id> ["<task>"] [--at seq] [--headless] [--model id] [--effort id] [--max-steps n] [--approve] [--json]\n' +
          '  minidsh serve [--cwd dir] [--approve]\n' +
          '  minidsh sessions list\n' +
          '  minidsh sessions show <id> [--json]\n',
      )
      return args.command === 'help' ? 0 : 2
  }
}
