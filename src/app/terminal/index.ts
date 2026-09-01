/**
 * The interactive terminal surface: a protocol CLIENT on a loopback byte-stream
 * pair to the same protocol plugin `minidsh serve` exposes on real stdio —
 * identical frames, no shared objects, zero harness semantics here. It renders
 * streaming output from durable `assistant/chunk` events, answers approval
 * frames by their durable ids, steers the running turn by typing, and cancels
 * on Ctrl+C. Attaching to a stored session (resume/fork) is prepared host-side
 * by the app assembly; the client then drives the live session over the wire —
 * a bounded tail PAGE first, live rendering only from the seq after the cursor
 * the host cut it against, so a self-waking resumed session never renders twice
 * and a long one is never dumped whole into a terminal (`/history` pages back).
 *
 * It holds no copy of the session: context pressure arrives as `session.view`,
 * because a client with one page cannot fold it.
 */
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { Context } from '../../kernel/index.ts'
import { AGENTS, type AgentOptions } from '../../core/agent/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED } from '../../core/approval/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { formatTokens } from '../../core/metering/index.ts'
import { matches, type SessionEventFrame } from '../../core/session/index.ts'
import type {
  ApprovalAnswerResult,
  AttachResult,
  AuthorityView,
  CompactResult,
  InitializeResult,
  ModelResult,
  PageResult,
  PromptResult,
  SessionView,
} from '../../capabilities/protocol/index.ts'
import { applyAuthority, type BootOptions } from '../headless.ts'
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
  /** Per-agent world for every agent this surface creates or attaches (built from a named agent preset). */
  readonly agentSetup?: (agentCtx: Context) => void | Promise<void>
  /** The name of that preset, recorded in the header of a session this surface creates. */
  readonly agentPreset?: string
  /** Injected for tests; defaults to process stdin/stdout. */
  readonly io?: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream }
}

export async function runTerminal(options: TerminalOptions): Promise<number> {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const host = await startProtocolHost({ ...options, input: toHost, output: fromHost })
  const out = options.io?.output ?? process.stdout
  const renderer = new TerminalRenderer()
  const attaching = options.resumeId !== undefined || options.forkId !== undefined

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
  /** Until the attach page is rendered, live frames wait in the backlog. */
  let attached = !attaching
  let liveFromSeq = 0
  const backlog: SessionEventFrame[] = []
  /** Where `/history` reads from: the cut this client synchronized on, and the oldest event it holds. */
  let history: { cursor: number; oldest: number; hasMore: boolean } | undefined

  const prompt = (): void => {
    if (!exiting) out.write('you> ')
  }
  const printError = (error: unknown): void => {
    out.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  const askApproval = (data: { id: string; toolName: string; reason?: string }): void => {
    pendingApproval = { id: data.id, toolName: data.toolName }
    out.write(`approve ${data.toolName}${data.reason ? ` (${data.reason})` : ''}? [y/N] `)
  }

  const handleFrame = (frame: SessionEventFrame): void => {
    if (sessionId !== undefined && frame.sessionId !== sessionId) return
    if (frame.event.seq < liveFromSeq) return // already in the rendered snapshot
    const text = renderer.onEvent(frame.event)
    if (text) out.write(text)
    if (matches(frame.event, APPROVAL_ASKED)) {
      askApproval(frame.event.data)
    } else if (matches(frame.event, APPROVAL_DECIDED)) {
      // Settled elsewhere (cancelled turn, another answerer): stop asking.
      if (pendingApproval?.id === frame.event.data.id) pendingApproval = undefined
    }
  }

  const client = new ProtocolClient(fromHost, toHost, {
    onNotification: (method, params) => {
      if (method === 'session.event') {
        const frame = params as SessionEventFrame
        if (!attached) backlog.push(frame)
        else handleFrame(frame)
      } else if (method === 'session.status') {
        const projected = params as { sessionId: string; status: 'idle' | 'running' }
        if (sessionId !== undefined && projected.sessionId !== sessionId) return
        status = projected.status
        if (status === 'idle' && attached) prompt()
      } else if (method === 'session.view') {
        const projected = params as { sessionId: string; view: SessionView }
        if (sessionId !== undefined && projected.sessionId !== sessionId) return
        if (!attached) return
        const line = renderer.onView(projected.view)
        if (line) out.write(line)
      }
    },
    onEnd: () => void exit(1),
  })

  const rl = createInterface({ input: options.io?.input ?? process.stdin, terminal: false })

  const onSigint = (): void => void onInterrupt()

  async function exit(code: number): Promise<void> {
    if (exiting) return
    exiting = true
    if (!options.io) process.removeListener('SIGINT', onSigint)
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
      try {
        const result = await client.request<ApprovalAnswerResult>('approval/answer', { sessionId, id: approval.id, outcome })
        // Settled elsewhere before the answer landed: say so rather than let a
        // y/N vanish into a prompt nothing was waiting on.
        if (result.outcome === 'not-pending') out.write(`that approval (${approval.id}) is no longer pending\n`)
      } catch (error) {
        printError(error)
      }
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
    // Exact token, never a prefix: `/presets …` once reached switchAuthority
    // as an unrecognized command and fell through to the SANDBOX setter,
    // durably widening the wrong knob with no error.
    const command = line.split(/\s+/, 1)[0]
    if (command === '/sandbox' || command === '/ask' || command === '/preset') {
      await switchAuthority(line)
      return
    }
    if (command === '/compact') {
      await compactNow()
      return
    }
    if (command === '/history') {
      await showOlder()
      return
    }
    if (command === '/model') {
      await switchModel(line)
      return
    }
    // Before the catch-all, not after it: `/cancel` sat below the unknown-command
    // branch and could never run.
    if (command === '/cancel') {
      if (sessionId !== undefined && status === 'running') await client.request('session/cancel', { sessionId }).catch(printError)
      return
    }
    if (command?.startsWith('/')) {
      out.write(`unknown command ${command}\n`)
      prompt()
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

  /**
   * One page further back, anchored to the cut this client attached on. A
   * terminal cannot scroll, so it prints; the anchor is what keeps the pages
   * consistent while the session keeps appending underneath them.
   */
  async function showOlder(): Promise<void> {
    if (sessionId === undefined || history === undefined) {
      out.write('nothing attached to page back through\n')
      prompt()
      return
    }
    if (!history.hasMore) {
      out.write('that is the whole session\n')
      prompt()
      return
    }
    try {
      const older = await client.request<PageResult>('session/page', { sessionId, throughSeq: history.cursor, beforeSeq: history.oldest })
      const transcript = renderHistory(older.page.events)
      if (older.page.hasMore) out.write('… earlier events remain (/history again)\n')
      if (transcript) out.write(transcript)
      history = { cursor: history.cursor, oldest: older.page.from, hasMore: older.page.hasMore }
    } catch (error) {
      printError(error)
    }
    if (status === 'idle') prompt()
  }

  /**
   * Compaction is a human command over the wire, not a model-facing tool. The
   * summary it produces arrives as a durable event like everything else, so the
   * renderer reports the result twice over: once here, once from the log.
   */
  async function compactNow(): Promise<void> {
    if (sessionId === undefined) {
      out.write('no session yet - send a prompt first\n')
      prompt()
      return
    }
    try {
      const result = await client.request<CompactResult>('session/compact', { sessionId })
      if (result.kind === 'compacted') {
        out.write(`compacted ${result.shadowedNodes} messages (~${formatTokens(result.surfaceTokensBefore)} → ~${formatTokens(result.surfaceTokensAfter)})\n`)
      } else if (result.kind === 'scheduled') {
        out.write('the turn is still running; compaction will run before its next step\n')
      } else {
        out.write('nothing worth compacting yet\n')
      }
    } catch (error) {
      printError(error)
    }
    if (status === 'idle') prompt()
  }

  /**
   * `/model` reads the base route; `/model <provider>/<model> [effort]` (or
   * `/model <model> [effort]` on the same provider) switches it over the wire,
   * where it becomes a durable `agent/options` event the renderer reports back.
   */
  async function switchModel(line: string): Promise<void> {
    const [, target, effort] = line.split(/\s+/, 3)
    if (sessionId === undefined) {
      out.write('no session yet - send a prompt first\n')
      prompt()
      return
    }
    const params: Record<string, string> = { sessionId }
    if (target) {
      const slash = target.indexOf('/')
      if (slash > 0) {
        params.provider = target.slice(0, slash)
        params.model = target.slice(slash + 1)
      } else {
        params.model = target
      }
    }
    if (effort) params.reasoningEffort = effort
    try {
      const route = await client.request<ModelResult>('session/model', params)
      out.write(`model: ${route.provider}/${route.model}${route.reasoningEffort ? ` · effort ${route.reasoningEffort}` : ''}\n`)
    } catch (error) {
      printError(error)
    }
    if (status === 'idle') prompt()
  }

  /**
   * Authority changes go over the wire like everything else: the terminal is a
   * protocol client, and the switch it asks for becomes a durable event the
   * renderer then reports back to it.
   */
  async function switchAuthority(line: string): Promise<void> {
    const [command, value] = line.split(/\s+/, 2)
    if (sessionId === undefined) {
      out.write('no session yet - send a prompt first\n')
      prompt()
      return
    }
    if (!value) {
      const usage =
        command === '/ask' ? 'usage: /ask <ask|never>\n' : command === '/preset' ? 'usage: /preset <name>\n' : 'usage: /sandbox <read-only|workspace-write|danger-full-access>\n'
      out.write(usage)
      prompt()
      return
    }
    const params = command === '/ask' ? { sessionId, approval: value } : command === '/preset' ? { sessionId, preset: value } : { sessionId, sandbox: value }
    try {
      const view = await client.request<AuthorityView>('session/authority', params)
      const preset = view.preset === undefined ? '' : ` · preset: ${view.preset}`
      out.write(`sandbox: ${view.sandbox} (shell confinement: ${view.enforcement}) · approvals: ${view.approval}${preset}\n`)
    } catch (error) {
      printError(error)
    }
    if (status === 'idle') prompt()
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

  // Lines are strictly serialized: a pasted second line waits for the first
  // prompt's response, sees its sessionId, and becomes a followup/steer instead
  // of creating a second session.
  let lineChain: Promise<void> = Promise.resolve()
  const enqueueLine = (raw: string): void => {
    lineChain = lineChain.then(() => onLine(raw)).catch(printError)
  }
  rl.on('line', enqueueLine)
  rl.on('close', () => void exit(0))
  // readline never emits 'SIGINT' with terminal:false — on a real TTY Ctrl+C
  // arrives as the process signal, so the interrupt handler must live there.
  if (!options.io) process.on('SIGINT', onSigint)

  try {
    const init = await client.request<InitializeResult>('initialize')
    const provider = overrides.provider ?? init.defaultAgentOptions.provider
    const model = overrides.model ?? init.defaultAgentOptions.model
    const contextWindow = init.providers.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model)?.contextWindow
    const window = contextWindow ? ` · ctx ${formatTokens(contextWindow)}` : ''
    out.write(`minidsh ${init.serverInfo.version} — ${provider}/${model}${window} (/model switches the route, /compact shrinks context, /exit quits, Ctrl+C cancels)\n`)

    if (attaching) {
      const agents = host.root.get(AGENTS)
      const continueOptions = {
        agentOptions: overrides,
        defaults: init.defaultAgentOptions,
        ...(options.agentSetup === undefined ? {} : { setup: options.agentSetup }),
      }
      const handle =
        options.resumeId !== undefined
          ? await agents.resume(host.root, asSessionId(options.resumeId), continueOptions)
          : await agents.fork(host.root, asSessionId(options.forkId!), options.boundary, continueOptions)
      // An explicitly requested authority is a durable switch here too: a
      // resumed session keeps what it recorded unless someone says otherwise.
      applyAuthority(host.root, handle, options)
      sessionId = handle.agent.id
      // Attach first; live rendering starts at the seq after the cursor, and
      // the backlog replays whatever streamed while we attached (a resumed
      // session may have woken on its restored inbox already).
      const attachment = await client.request<AttachResult>('session/attach', { sessionId })
      const transcript = renderHistory(attachment.page.events)
      // Not `page.from`: that is an inclusive lower SEQ bound, not a count, and
      // seq space counts the trace tier a page never carries.
      if (attachment.page.hasMore) out.write('… earlier events remain (/history shows the page before this one)\n')
      if (transcript) out.write(transcript)
      out.write(options.resumeId !== undefined ? `resumed ${sessionId}\n` : `forked ${options.forkId} → ${sessionId}\n`)
      // The cursor is the host's own, not inferred from the last event on the
      // page: a page that does not run to the head would otherwise open a gap.
      liveFromSeq = attachment.cursor + 1
      history = { cursor: attachment.cursor, oldest: attachment.page.from, hasMore: attachment.page.hasMore }
      const line = renderer.onView(attachment.view)
      if (line) out.write(line)
      // A prompt asked and never decided still needs an answer; the host folds
      // that pair, because half of it can fall outside a page.
      for (const pending of attachment.view.pendingApprovals) askApproval(pending)
      attached = true
      for (const frame of backlog.splice(0)) handleFrame(frame)
    }

    if (options.task !== undefined && options.task.length > 0) enqueueLine(options.task)
    else if (status === 'idle') prompt()
  } catch (error) {
    printError(error)
    await exit(1)
  }

  return finished
}
