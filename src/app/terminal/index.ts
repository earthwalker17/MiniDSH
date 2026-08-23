/**
 * The interactive terminal surface: a protocol CLIENT on a loopback byte-stream
 * pair to the same protocol plugin `minidsh serve` exposes on real stdio —
 * identical frames, no shared objects, zero harness semantics here. It renders
 * streaming output from durable `assistant/chunk` events, answers approval
 * frames by their durable ids, steers the running turn by typing, and cancels
 * on Ctrl+C. Attaching to a stored session (resume/fork) is prepared host-side
 * by the app assembly; the client then drives the live session over the wire.
 */
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { AGENTS, type AgentOptions } from '../../core/agent/index.ts'
import { asSessionId } from '../../core/ids.ts'
import type { SessionEventFrame } from '../../core/session/index.ts'
import type { EventsResult, InitializeResult, PromptResult } from '../../capabilities/protocol-stdio/index.ts'
import type { BootOptions } from '../headless.ts'
import { startProtocolHost } from '../serve.ts'
import { ProtocolClient } from './client.ts'
import { renderHistory, TerminalRenderer } from './render.ts'

export interface TerminalOptions extends BootOptions {
  readonly cwd: string
  /** Attach to a stored session under its own id. */
  readonly resumeId?: string
  /** Branch a stored (or live) session into a new one and attach to it. */
  readonly forkId?: string
  readonly boundary?: number
  /** An initial prompt, sent as soon as the surface is attached. */
  readonly task?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
  /** Injected for tests; defaults to process stdin/stdout. */
  readonly io?: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream }
}

export async function runTerminal(options: TerminalOptions): Promise<number> {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const host = await startProtocolHost({ ...options, input: toHost, output: fromHost })
  const out = options.io?.output ?? process.stdout
  const renderer = new TerminalRenderer()

  let done!: (code: number) => void
  const finished = new Promise<number>((resolve) => {
    done = resolve
  })

  const overrides: Partial<AgentOptions> = {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  }

  let sessionId: string | undefined
  let status: 'idle' | 'running' = 'idle'
  let pendingApproval: { id: string; toolName: string } | undefined
  let exiting = false
  let lastInterrupt = 0

  const prompt = (): void => {
    if (!exiting) out.write('you> ')
  }
  const printError = (error: unknown): void => {
    out.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  const client = new ProtocolClient(fromHost, toHost, {
    onNotification: (method, params) => {
      if (method === 'session.event') {
        const frame = params as SessionEventFrame
        if (sessionId !== undefined && frame.sessionId !== sessionId) return
        const text = renderer.onEvent(frame.event)
        if (text) out.write(text)
        if (frame.event.type === 'approval/asked') {
          const data = frame.event.data as { id: string; toolName: string; reason?: string }
          pendingApproval = { id: data.id, toolName: data.toolName }
          out.write(`approve ${data.toolName}${data.reason ? ` (${data.reason})` : ''}? [y/N] `)
        } else if (frame.event.type === 'approval/decided') {
          // Settled elsewhere (cancelled turn, another answerer): stop asking.
          if (pendingApproval?.id === (frame.event.data as { id: string }).id) pendingApproval = undefined
        }
      } else if (method === 'session.status') {
        const projected = params as { sessionId: string; status: 'idle' | 'running' }
        if (sessionId !== undefined && projected.sessionId !== sessionId) return
        status = projected.status
        if (status === 'idle') prompt()
      }
    },
    onEnd: () => void exit(1),
  })

  const rl = createInterface({ input: options.io?.input ?? process.stdin, terminal: false })

  async function exit(code: number): Promise<void> {
    if (exiting) return
    exiting = true
    try {
      await client.request('shutdown')
    } catch {
      // The host is already gone.
    }
    client.close()
    rl.close()
    await host.dispose()
    done(code)
  }

  async function onLine(raw: string): Promise<void> {
    if (exiting) return
    const line = raw.trim()
    if (pendingApproval) {
      const approval = pendingApproval
      pendingApproval = undefined
      const answer = line.toLowerCase()
      const outcome = answer === 'y' || answer === 'yes' ? 'allowed-once' : 'rejected'
      await client.request('approval/answer', { sessionId, id: approval.id, outcome }).catch(printError)
      return
    }
    if (line.length === 0) {
      if (status === 'idle') prompt()
      return
    }
    if (line === '/exit' || line === '/quit') {
      await exit(0)
      return
    }
    if (line === '/cancel') {
      if (sessionId !== undefined && status === 'running') await client.request('session/cancel', { sessionId }).catch(printError)
      return
    }
    try {
      const result = await client.request<PromptResult>('session/prompt', {
        text: line,
        ...(sessionId === undefined ? { agentOptions: overrides } : { sessionId }),
        ...(status === 'running' ? { mode: 'steer' } : {}),
      })
      sessionId = result.sessionId
    } catch (error) {
      printError(error)
      if (status === 'idle') prompt()
    }
  }

  async function onInterrupt(): Promise<void> {
    const now = Date.now()
    const again = now - lastInterrupt < 2000
    lastInterrupt = now
    if (status === 'running' && sessionId !== undefined && !again) {
      out.write('\n(cancelling — Ctrl+C again to exit)\n')
      await client.request('session/cancel', { sessionId }).catch(() => {})
      return
    }
    await exit(0)
  }

  rl.on('line', (raw) => void onLine(raw))
  rl.on('close', () => void exit(0))
  rl.on('SIGINT', () => void onInterrupt())

  try {
    const init = await client.request<InitializeResult>('initialize')
    const provider = overrides.provider ?? init.defaultAgentOptions.provider
    const model = overrides.model ?? init.defaultAgentOptions.model
    out.write(`minidsh ${init.serverInfo.version} — ${provider}/${model} (/exit quits, Ctrl+C cancels)\n`)

    if (options.resumeId !== undefined || options.forkId !== undefined) {
      const agents = host.root.get(AGENTS)
      const continueOptions = { agentOptions: overrides, defaults: init.defaultAgentOptions }
      const handle =
        options.resumeId !== undefined
          ? await agents.resume(host.root, asSessionId(options.resumeId), continueOptions)
          : await agents.fork(host.root, asSessionId(options.forkId!), options.boundary, continueOptions)
      sessionId = handle.agent.id
      const history = await client.request<EventsResult>('session/events', { sessionId })
      const transcript = renderHistory(history.events)
      if (transcript) out.write(transcript)
      out.write(options.resumeId !== undefined ? `resumed ${sessionId}\n` : `forked ${options.forkId} → ${sessionId}\n`)
    }

    if (options.task !== undefined && options.task.length > 0) await onLine(options.task)
    else if (status === 'idle') prompt()
  } catch (error) {
    printError(error)
    await exit(1)
  }

  return finished
}
