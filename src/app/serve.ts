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
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
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
    defaultAgentOptions: options.agentDefaults ?? defaultAgentOptions(),
    onClose: () => resolveClosed(),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.output === undefined ? {} : { output: options.output }),
  }
  const root = await bootComposition({
    ...options,
    patches: [...(options.patches ?? []), { insert: [defineRow('protocol', protocolStdioPlugin, protocolConfig)] }],
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
