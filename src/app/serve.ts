/**
 * The protocol host assembly: the default composition plus one protocol row.
 * `minidsh serve` mounts it on real process stdio; the terminal surface mounts
 * the identical row on an in-process duplex pair. The app owns process exit:
 * the plugin only reports that the surface is done.
 */
import type { Context } from '../kernel/index.ts'
import { protocolStdioPlugin, type ProtocolConfig } from '../capabilities/protocol-stdio/index.ts'
import { defineRow, defaultAgentOptions } from './compose.ts'
import { bootComposition, type BootOptions } from './headless.ts'

export interface ServeOptions extends BootOptions {
  readonly cwd: string
  /** Directories a client-chosen session cwd may lie under (default: `cwd`). Host policy, never the wire's. */
  readonly workspaceRoots?: readonly string[]
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  /** Per-agent world for every agent the protocol surface creates or resumes (built from a named agent preset). */
  readonly agentSetup?: (agentCtx: Context) => void | Promise<void>
}

export interface ProtocolHostHandle {
  readonly root: Context
  /** Resolves when the protocol surface is done (shutdown answered, client hung up, or dispose()). */
  readonly closed: Promise<void>
  dispose(): Promise<void>
}

export async function startProtocolHost(options: ServeOptions): Promise<ProtocolHostHandle> {
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const protocolConfig: ProtocolConfig = {
    cwd: options.cwd,
    workspaceRoots: options.workspaceRoots ?? [options.cwd],
    defaultAgentOptions: options.agentDefaults ?? defaultAgentOptions(),
    onClose: () => resolveClosed(),
    ...(options.agentSetup === undefined ? {} : { setup: options.agentSetup }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.output === undefined ? {} : { output: options.output }),
  }
  // The protocol row joins the BASE, not a patch layer: a disk patch may
  // target row id "protocol" (it exists before layering), and a layer that
  // disables it is refused here instead of serving a dead socket.
  let protocolDisabled = false
  for (const patch of [...(options.patches ?? []), ...(options.configLayers ?? []).flatMap((layer) => layer.patches)]) {
    if ('insert' in patch || patch.id !== 'protocol') continue
    if (patch.disabled !== undefined) protocolDisabled = patch.disabled
    // A config patch REPLACES a row's whole config, which here would discard
    // the live streams and callbacks this surface just built — the plugin
    // would silently fall back to process stdio and the client would hang.
    // Symmetrical with the disable refusal below.
    if (patch.config !== undefined) {
      throw new Error('the composition may not replace the config of row "protocol": it carries this surface\'s live streams')
    }
  }
  if (protocolDisabled) throw new Error('the composition disables row "protocol"; a protocol host cannot run without its surface')
  const root = await bootComposition({
    ...options,
    extraBaseRows: [...(options.extraBaseRows ?? []), defineRow('protocol', protocolStdioPlugin, protocolConfig)],
  })
  let disposed: Promise<void> | undefined
  return {
    root,
    closed,
    dispose: () =>
      (disposed ??= root.dispose().then(() => {
        resolveClosed()
      })),
  }
}
