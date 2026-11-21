/**
 * The interactive terminal: a protocol CLIENT on a loopback byte-stream pair
 * to the same protocol plugin `minidsh serve` exposes on real stdio —
 * identical frames, no shared objects, zero harness semantics here
 * (ARCHITECTURE §8). A stored session is continued over the wire
 * (`session/resume`, `session/fork`) like every other driving method.
 *
 * Two views over one controller (`controller.ts`): the full-screen view
 * (`tui.ts`) where both ends are a TTY, and the line view (`line.ts`) for a
 * pipe, a script, `TERM=dumb` or `--plain`. `canOwnTerminal` below is the
 * whole rule: nothing detects a screen reader, so a person using one passes
 * `--plain`. Neither holds a copy of the session:
 * the full-screen view folds its attached window into the browser's
 * presentation model, which is presentation, never a surface fold.
 */
import { PassThrough } from 'node:stream'
import type { Context } from '../../kernel/index.ts'
import type { AgentOptions } from '../../core/agent/index.ts'
import { formatTokens } from '../../core/metering/index.ts'
import type { InitializeResult } from '../../capabilities/protocol/index.ts'
import type { BootOptions } from '../headless.ts'
import { startProtocolHost } from '../serve.ts'
import { ProtocolClient } from './client.ts'
import { SessionController, type ContinueRequest } from './controller.ts'
import { createLineView } from './line.ts'
import { runFullScreen } from './tui.ts'

export interface TerminalOptions extends BootOptions {
  readonly cwd: string
  /** Attach to a stored session under its own id. */
  readonly resumeId?: string
  /** Branch a stored (or live) session into a new one and attach to it. */
  readonly forkId?: string
  readonly boundary?: number
  /** Fork a damaged stored log from its readable prefix (`ForkAgentOptions.salvage`). */
  readonly salvage?: boolean
  /** An initial prompt, sent as soon as the surface is attached. */
  readonly task?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
  /** Per-agent world for every agent this surface creates or continues (built from a named agent preset). */
  readonly agentWorld?: (agentCtx: Context) => void | Promise<void>
  /** The name of that preset, recorded in the header of a session this surface creates. */
  readonly agentPreset?: string
  /** `--plain`: the line view even on a terminal. */
  readonly plain?: boolean
  /** Injected for tests; defaults to process stdin/stdout. */
  readonly io?: {
    readonly input: NodeJS.ReadableStream
    readonly output: NodeJS.WritableStream
    /** Run the full-screen view over these streams (a scripted terminal in tests). */
    readonly fullScreen?: { readonly columns: number; readonly rows: number; readonly depth?: 1 | 4 | 8 | 24 }
    /** The full-screen view's clock: a test moves it instead of waiting out the approval band's arming time. */
    readonly now?: () => number
  }
}

/** The first line of the line view: version, route and the commands worth knowing. */
function banner(init: InitializeResult, overrides: Partial<AgentOptions>): string {
  const provider = overrides.provider ?? init.defaultAgentOptions.provider
  const model = overrides.model ?? init.defaultAgentOptions.model
  // From the advertised catalog: this client reads the wire, never the host's
  // registry. A retired alias an adapter still resolves is unlisted, so it
  // shows no window here until the view's context reports one.
  const contextWindow = init.providers.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model)?.contextWindow
  const window = contextWindow ? ` · ctx ${formatTokens(contextWindow)}` : ''
  return `minidsh ${init.serverInfo.version} — ${provider}/${model}${window} (/help lists the commands: /model switches the route, /compact shrinks context, /sessions lists them, /jobs lists background jobs, /exit quits, Ctrl+C cancels)\n`
}

/** Whether this process can own the terminal: a real TTY on both ends, and a terminal that can draw. */
function canOwnTerminal(options: TerminalOptions): boolean {
  if (options.plain === true) return false
  if (options.io !== undefined) return options.io.fullScreen !== undefined
  return process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== 'dumb'
}

export async function runTerminal(options: TerminalOptions): Promise<number> {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const host = await startProtocolHost({ ...options, input: toHost, output: fromHost })

  let route: (method: string, params: unknown) => void = () => {}
  let hostEnded: () => void = () => {}
  const client = new ProtocolClient(fromHost, toHost, { onNotification: (method, params) => route(method, params), onEnd: () => hostEnded() })

  let done!: (code: number) => void
  const finished = new Promise<number>((resolve) => (done = resolve))
  let exiting = false
  const exit = async (code: number): Promise<void> => {
    if (exiting) return
    exiting = true
    try {
      await client.request('shutdown')
    } catch {
      // The host is already gone.
    }
    client.close()
    await host.dispose()
    done(code)
  }

  const overrides: Partial<AgentOptions> = {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  }
  // A CLI continuation carries the launch's explicit model flags: that is this
  // command's own request. An in-place one never does.
  const continueRequest: ContinueRequest | undefined =
    options.resumeId !== undefined
      ? { kind: 'resume', sessionId: options.resumeId, agentOptions: overrides }
      : options.forkId !== undefined
        ? {
            kind: 'fork',
            sessionId: options.forkId,
            agentOptions: overrides,
            ...(options.boundary === undefined ? {} : { atSeq: options.boundary }),
            ...(options.salvage === true ? { salvage: true } : {}),
          }
        : undefined

  if (canOwnTerminal(options)) {
    const tui = runFullScreen({
      client,
      overrides,
      cwd: options.cwd,
      ...(continueRequest === undefined ? {} : { continueRequest }),
      ...(options.task === undefined ? {} : { task: options.task }),
      exit,
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.io?.now === undefined ? {} : { now: options.io.now }),
    })
    route = (method, params) => tui.controller.onNotification(method, params)
    hostEnded = () => tui.controller.closed()
    await tui.run()
    return finished
  }

  const view = createLineView({
    input: options.io?.input ?? process.stdin,
    output: options.io?.output ?? process.stdout,
    echoes: options.io === undefined && process.stdin.isTTY === true,
    handleSigint: options.io === undefined,
    ...(continueRequest === undefined ? {} : { continueRequest }),
    ...(options.task === undefined ? {} : { task: options.task }),
    banner: (init) => banner(init, overrides),
    exit,
  })
  const controller = new SessionController(client, view.hooks, overrides)
  route = (method, params) => controller.onNotification(method, params)
  hostEnded = () => controller.closed()
  await view.run(controller)
  const code = await finished
  // What to come back to, in the words `run` ends with and on stderr as it
  // does: a piped transcript on stdout stays the conversation. The full-screen
  // view says the same on leaving the alternate screen; this view said
  // nothing, so a piped `chat` left no way to name its session but the list.
  if (options.io === undefined && controller.sessionId !== undefined) process.stderr.write(`session: ${controller.sessionId}\n`)
  return code
}
