/**
 * The client protocol as a capability: ONE plugin, one host, N carriers.
 * Mounted on real process stdio it serves out-of-process clients
 * (`minidsh serve`); on an in-process duplex stream pair it serves the terminal
 * surface; on a WebSocket it serves browsers — same frames, same semantics, no
 * shared objects, and one ownership plane for the agents behind them. It
 * injects `agents` and
 * `sessions` (the surface contract) plus `llm` for the initialize catalog and
 * the authority services for the policy control plane (a switch a client asks
 * for IS its durable event, so no authority state lives on the wire);
 * `persistence` is deliberately NOT injected (a declared-but-absent
 * key would pend the plugin forever in persistence-less compositions) — cold
 * reads use a call-time optional lookup.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { basename } from 'node:path'
import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENTS, AGENT_STATUS, type AgentOptions } from '../../core/agent/index.ts'
import { APPROVAL, APPROVAL_REQUEST } from '../../core/approval/index.ts'
import { LLM } from '../../core/llm/index.ts'
import { canonicalPath, SANDBOX } from '../../core/sandbox/index.ts'
import { SESSIONS, SESSION_EVENT } from '../../core/session/index.ts'
import { ClientConnection } from './connection.ts'
import { ProtocolHost } from './host.ts'
import { NdjsonTransport } from './transport-ndjson.ts'
import { serveWebSocket } from './transport-ws.ts'

export * from './frames.ts'
import type { WorkspaceInfo } from './frames.ts'
export { ClientConnection } from './connection.ts'
export { ProtocolHost } from './host.ts'
export { NdjsonTransport } from './transport-ndjson.ts'
export { acceptKey, decodeFrames, encodeTextFrame, serveWebSocket } from './transport-ws.ts'

/**
 * One way clients reach the host. A stream pair is one client; other carriers
 * (a socket) accept many. `allowShutdown` says whether a client on this carrier
 * may end the host — true where the client owns the process, false where it
 * does not.
 */
export interface StreamCarrier {
  readonly kind: 'stream'
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
  readonly allowShutdown?: boolean
}

/**
 * A WebSocket carrier over an HTTP server the APP owns and routes. Many
 * clients, and by default none of them may shut the host down: a browser tab is
 * not a process. `authorize` is the app's trust fence (origin, credential).
 */
export interface WebSocketCarrier {
  readonly kind: 'websocket'
  readonly server: HttpServer
  readonly path?: string
  readonly authorize?: (request: IncomingMessage) => true | number
  readonly allowShutdown?: boolean
  readonly softLimitBytes?: number
  readonly hardLimitBytes?: number
  readonly heartbeatMs?: number
}

export type Carrier = StreamCarrier | WebSocketCarrier

export interface ProtocolConfig {
  /** Defaults: process stdin/stdout. stdout is reserved for frames — log to stderr. */
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  /**
   * Every carrier this host serves. Omitted, it is one stream carrier over
   * `input`/`output` (process stdio by default) — the shape `serve` and the
   * terminal use. One plugin, one set of semantics, N ways in.
   */
  readonly carriers?: readonly Carrier[]
  readonly cwd?: string
  /** Directories a client-chosen session `cwd` must lie under (default: `cwd` alone). Host policy. */
  readonly workspaceRoots?: readonly string[]
  /**
   * Named places to work, so a client need not know host paths. Omitted, one
   * is derived per workspace root. A workspace is ADDRESSING: it grants nothing
   * `workspaceRoots` does not already allow, and its root is held to the same
   * checks a raw path is.
   */
  readonly workspaces?: readonly { readonly id?: string; readonly name?: string; readonly root: string }[]
  readonly defaultAgentOptions: AgentOptions
  readonly serverVersion?: string
  /** Per-agent world for every agent this surface creates or resumes (the app builds it from a named preset). */
  readonly setup?: (agentCtx: Context) => void | Promise<void>
  /** The name of that preset, recorded in each session's header so a resume can compose the same world. */
  readonly agentPreset?: string
  /** Called once when the protocol is done (shutdown answered, or the client hung up). The app owns process exit. */
  readonly onClose?: () => void
}

export const protocolPlugin: Plugin<ProtocolConfig> = {
  name: 'protocol',
  inject: [AGENTS, SESSIONS, LLM, SANDBOX, APPROVAL],
  apply(ctx, config) {
    // The host's own default is held to the identity rule the wire is held to:
    // canonical, so the immutable header records the same path the roots name.
    const cwd = canonicalPath(config.cwd ?? process.cwd())
    const workspaceRoots = (config.workspaceRoots ?? [cwd]).map((root) => canonicalPath(root))
    // An id the deployment did not choose is derived from the canonical root, so
    // it is stable across restarts without anything being stored anywhere.
    const declared: readonly { readonly id?: string; readonly name?: string; readonly root: string }[] =
      config.workspaces ?? workspaceRoots.map((root) => ({ root }))
    const workspaces: readonly WorkspaceInfo[] = declared.map((workspace) => {
      const root = canonicalPath(workspace.root)
      return {
        id: workspace.id ?? createHash('sha256').update(root).digest('hex').slice(0, 12),
        name: workspace.name ?? (basename(root) || root),
        root,
      }
    })
    const carriers: readonly Carrier[] = config.carriers ?? [
      { kind: 'stream', input: config.input ?? process.stdin, output: config.output ?? process.stdout, allowShutdown: true },
    ]
    const host = new ProtocolHost(ctx, {
      cwd,
      workspaceRoots,
      workspaces,
      defaultAgentOptions: config.defaultAgentOptions,
      serverVersion: config.serverVersion ?? '0.1.0',
      // A stream carrier's client IS this process's reason to run: when the
      // last one hangs up, the host is done. A socket says otherwise — nobody
      // being connected right now is the normal state of a served host.
      closeWithLastClient: carriers.every((carrier) => carrier.kind === 'stream'),
      ...(config.setup === undefined ? {} : { setup: config.setup }),
      ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
      ...(config.onClose === undefined ? {} : { onClose: config.onClose }),
    })
    ctx.on(SESSION_EVENT, (session, event) => host.onSessionEvent(session, event))
    ctx.on(AGENT_STATUS, (agent, status) => host.onAgentStatus(agent, status))
    ctx.on(APPROVAL_REQUEST, (prompt, next) => host.answerApproval(prompt, next))
    ctx.effect(() => {
      const stops = carriers.map((carrier) => {
        if (carrier.kind === 'websocket') {
          return serveWebSocket({
            server: carrier.server,
            ...(carrier.path === undefined ? {} : { path: carrier.path }),
            ...(carrier.authorize === undefined ? {} : { authorize: carrier.authorize }),
            ...(carrier.allowShutdown === undefined ? {} : { allowShutdown: carrier.allowShutdown }),
            ...(carrier.softLimitBytes === undefined ? {} : { softLimitBytes: carrier.softLimitBytes }),
            ...(carrier.hardLimitBytes === undefined ? {} : { hardLimitBytes: carrier.hardLimitBytes }),
            ...(carrier.heartbeatMs === undefined ? {} : { heartbeatMs: carrier.heartbeatMs }),
            onConnection: (connection) => host.connect(connection),
            onClose: (connection) => host.disconnect(connection),
            onMessage: (connection, frame) => void host.onFrame(connection, frame),
            onMalformed: (detail) => ctx.logger.warn(`protocol: ignoring malformed frame: ${detail}`),
          })
        }
        const transport = new NdjsonTransport(carrier.input, carrier.output)
        // One stream pair is one client. `shutdown` is theirs to call by
        // default: on stdio and on the terminal's loopback pair the client owns
        // the process.
        const connection = new ClientConnection({ send: (frame) => transport.send(frame), allowShutdown: carrier.allowShutdown ?? true })
        host.connect(connection)
        transport.start({
          onFrame: (frame) => void host.onFrame(connection, frame),
          onEnd: () => host.disconnect(connection),
          onMalformed: (line) => ctx.logger.warn(`protocol: ignoring malformed frame: ${line.slice(0, 120)}`),
        })
        return () => transport.stop()
      })
      return () => {
        host.close()
        for (const stop of stops) stop()
      }
    }, 'protocol-transport')
  },
}
