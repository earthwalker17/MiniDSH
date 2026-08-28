/**
 * The client protocol as a capability: one plugin, two carriers. Mounted on
 * real process stdio it serves out-of-process clients (`minidsh serve`);
 * mounted on an in-process duplex stream pair it serves the terminal surface —
 * same frames, same semantics, no shared objects. It injects `agents` and
 * `sessions` (the surface contract) plus `llm` for the initialize catalog and
 * the authority services for the policy control plane (a switch a client asks
 * for IS its durable event, so no authority state lives on the wire);
 * `persistence` is deliberately NOT injected (a declared-but-absent
 * key would pend the plugin forever in persistence-less compositions) — cold
 * reads use a call-time optional lookup.
 */
import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENTS, AGENT_STATUS, type AgentOptions } from '../../core/agent/index.ts'
import { APPROVAL, APPROVAL_REQUEST } from '../../core/approval/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { canonicalPath, SANDBOX } from '../../core/sandbox/index.ts'
import { SESSIONS, SESSION_EVENT } from '../../core/session/index.ts'
import { ProtocolServer } from './server.ts'
import { NdjsonTransport } from './transport.ts'

export * from './frames.ts'
export { ProtocolServer } from './server.ts'
export { NdjsonTransport } from './transport.ts'

export interface ProtocolConfig {
  /** Defaults: process stdin/stdout. stdout is reserved for frames — log to stderr. */
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly cwd?: string
  /** Directories a client-chosen session `cwd` must lie under (default: `cwd` alone). Host policy. */
  readonly workspaceRoots?: readonly string[]
  readonly defaultAgentOptions: AgentOptions
  readonly serverVersion?: string
  /** Per-agent world for every agent this surface creates or resumes (the app builds it from a named preset). */
  readonly setup?: (agentCtx: Context) => void | Promise<void>
  /** Called once when the protocol is done (shutdown answered, or the client hung up). The app owns process exit. */
  readonly onClose?: () => void
}

export const protocolStdioPlugin: Plugin<ProtocolConfig> = {
  name: 'protocol-stdio',
  inject: [AGENTS, SESSIONS, LLM, SANDBOX, APPROVAL],
  apply(ctx, config) {
    const input = config.input ?? process.stdin
    const output = config.output ?? process.stdout
    const transport = new NdjsonTransport(input, output)
    const cwd = config.cwd ?? process.cwd()
    const server = new ProtocolServer(
      ctx,
      {
        cwd,
        workspaceRoots: (config.workspaceRoots ?? [cwd]).map((root) => canonicalPath(root)),
        defaultAgentOptions: config.defaultAgentOptions,
        serverVersion: config.serverVersion ?? '0.1.0',
        ...(config.setup === undefined ? {} : { setup: config.setup }),
        ...(config.onClose === undefined ? {} : { onClose: config.onClose }),
      },
      (frame) => transport.send(frame),
    )
    ctx.on(SESSION_EVENT, (session, event) => server.onSessionEvent(session, event))
    ctx.on(AGENT_STATUS, (agent, status) => server.onAgentStatus(agent, status))
    ctx.on(APPROVAL_REQUEST, (prompt, next) => server.answerApproval(prompt, next))
    ctx.effect(() => {
      transport.start({
        onFrame: (frame) => void server.onFrame(frame),
        onEnd: () => server.close(),
        onMalformed: (line) => ctx.logger.warn(`protocol-stdio: ignoring malformed frame: ${line.slice(0, 120)}`),
      })
      return () => {
        server.close()
        transport.stop()
      }
    }, 'protocol-transport')
  },
}
