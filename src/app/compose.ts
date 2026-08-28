/**
 * Application assembly: the default composition as typed rows, one patch
 * algorithm shared by boot and `--dump-config`, and the mount step. This is the
 * only place the default provider/model surface is chosen.
 */
import { serviceKey, type Context, type Plugin, type PluginHandle } from '../kernel/index.ts'
import { agentInvariantPlugin } from '../core/agent/invariant.ts'
import { AGENTS, agentPlugin, type AgentOptions } from '../core/agent/index.ts'
import { approvalPlugin, type ApprovalPolicy } from '../core/approval/index.ts'
import { invariantsPlugin } from '../core/invariants/index.ts'
import { llmPlugin } from '../core/llm/index.ts'
import { loopInvariantPlugin, loopPlugin } from '../core/loop/index.ts'
import { promptPlugin } from '../core/prompt/index.ts'
import { sandboxPlugin, type SandboxMode } from '../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../core/sandbox/invariant.ts'
import { sessionInvariantPlugin, sessionPlugin } from '../core/session/index.ts'
import { toolsPlugin } from '../core/tools/index.ts'
import { approvalHeadlessPlugin } from '../capabilities/approval-headless/index.ts'
import { authorityPresetsPlugin } from '../capabilities/authority-presets/index.ts'
import { compactionBasicPlugin } from '../capabilities/compaction-basic/index.ts'
import { contextRuntimePlugin } from '../capabilities/context-runtime/index.ts'
import { credentialsLocalPlugin } from '../capabilities/credentials-local/index.ts'
import { deepseekPlugin } from '../capabilities/llm-deepseek/index.ts'
import { fsLocalPlugin } from '../capabilities/fs-local/index.ts'
import { fsObservationPolicyPlugin } from '../capabilities/fs-observation-policy/index.ts'
import { persistenceJsonlPlugin } from '../capabilities/persistence-jsonl/index.ts'
import { retryPlugin } from '../capabilities/llm-retry/index.ts'
import { shellStdioPlugin, type ShellDialect } from '../capabilities/shell-stdio/index.ts'
import { spillLocalPlugin } from '../capabilities/spill-local/index.ts'
import { workspaceInstructionsPlugin } from '../capabilities/workspace-instructions/index.ts'
import { toolEditorPlugin } from '../capabilities/tool-editor/index.ts'
import { toolShellPlugin } from '../capabilities/tool-shell/index.ts'

export interface Row {
  readonly id: string
  readonly plugin: Plugin<unknown>
  config?: unknown
  disabled?: boolean
}

/**
 * Every shipped plugin by its kernel name — what a disk row's `plugin` string
 * resolves against before falling back to a module import. The protocol plugin
 * is deliberately absent: its config carries live streams and callbacks no
 * disk file can construct (serve contributes its row as part of the base).
 */
export const builtinPlugins: ReadonlyMap<string, Plugin<unknown>> = new Map(
  (
    [
      invariantsPlugin,
      sessionPlugin,
      sessionInvariantPlugin,
      credentialsLocalPlugin,
      llmPlugin,
      deepseekPlugin,
      retryPlugin,
      toolsPlugin,
      promptPlugin,
      approvalPlugin,
      approvalHeadlessPlugin,
      sandboxPlugin,
      authorityInvariantPlugin,
      authorityPresetsPlugin,
      compactionBasicPlugin,
      fsLocalPlugin,
      fsObservationPolicyPlugin,
      shellStdioPlugin,
      spillLocalPlugin,
      toolEditorPlugin,
      toolShellPlugin,
      contextRuntimePlugin,
      workspaceInstructionsPlugin,
      agentPlugin,
      agentInvariantPlugin,
      loopPlugin,
      loopInvariantPlugin,
      persistenceJsonlPlugin,
    ] as readonly Plugin<unknown>[]
  ).map((plugin) => [plugin.name, plugin]),
)

export type Patch = { readonly id: string; readonly config?: unknown; readonly disabled?: boolean } | { readonly insert: readonly Row[] }

/** Declares a row, capturing the plugin's config type at the call site. */
export function defineRow<C>(id: string, plugin: Plugin<C>, config?: C): Row {
  return { id, plugin: plugin as Plugin<unknown>, ...(config === undefined ? {} : { config }) }
}

/** The one composition algorithm: replace a row's whole config, warn+skip unknown ids, append inserts. */
export function applyPatches(rows: readonly Row[], patches: readonly Patch[], warn: (message: string) => void = console.warn): Row[] {
  const result = rows.map((row) => ({ ...row }))
  for (const patch of patches) {
    if ('insert' in patch) {
      result.push(...patch.insert.map((row) => ({ ...row })))
      continue
    }
    const target = result.find((row) => row.id === patch.id)
    if (!target) {
      warn(`patch targets unknown row id "${patch.id}"`)
      continue
    }
    if (patch.config !== undefined) target.config = patch.config
    if (patch.disabled !== undefined) target.disabled = patch.disabled
  }
  return result
}

/**
 * The mounted composition: row-id → live plugin instance, and the
 * application-level way to change rows against a live root. Reconfigure is
 * dispose-then-remount — the kernel reloads dependents on provider change,
 * not on config change, so a fresh instance IS the config-change mechanism.
 */
export interface Composition {
  rows(): readonly Row[]
  /** Mounts a new row (duplicate ids refused) and waits for it to settle. */
  insert(row: Row): Promise<void>
  /** Disposes a row's instance; the kernel cascade parks dependents as pending. */
  remove(id: string): Promise<void>
  /** Dispose → remount with the new config → settled (a bad config fails the call, not a silent dead row). */
  reconfigure(id: string, config: unknown): Promise<void>
}

/** Provided on the root by the app boot; app-layer only — no core or capability may consume it. */
export const COMPOSITION = serviceKey<Composition>('app-composition')

/**
 * The spine: rows whose removal under live agents tears a half-live world
 * (their services vanish while captured references keep acting). `loop` alone
 * would cascade cleanly, but removing the driver under live agents is never
 * what an operator meant. `persistence` is here for a sharper reason: its
 * per-session state and write leases die with the plugin instance, so swapping
 * it under a live session silently stops durable writes while `flush()` — now
 * a dispatch with no listeners — keeps reporting success. This is the runtime
 * half of "what a layer must not override".
 */
const SPINE = new Set(['session', 'llm', 'tools', 'prompt', 'agent', 'loop', 'persistence'])

class MountedComposition implements Composition {
  private readonly root: Context
  private readonly list: Row[]
  private readonly handles = new Map<string, PluginHandle>()
  /**
   * Row changes are serialized. Each mutator spans awaits, and two overlapping
   * calls for one id would both mount a fresh instance: the loser's `provide`
   * throws SERVICE_DUPLICATE while its live twin keeps its registrations, and
   * the handle map ends up naming the wrong one.
   */
  private queue: Promise<unknown> = Promise.resolve()
  constructor(root: Context, rows: readonly Row[]) {
    this.root = root
    this.list = rows.map((row) => ({ ...row }))
    for (const row of this.list) {
      if (row.disabled) continue
      this.handles.set(row.id, root.plugin(row.plugin, row.config))
    }
  }

  rows(): readonly Row[] {
    return this.list
  }

  private guardSpine(id: string, verb: string): void {
    if (!SPINE.has(id)) return
    const live = this.root.tryGet(AGENTS)?.list() ?? []
    if (live.length === 0) return
    throw new Error(`cannot ${verb} spine row "${id}" while agents are live: ${live.map((agent) => agent.id).join(', ')}`)
  }

  /** One row change at a time; a failed change never blocks the next. */
  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.queue.then(body, body)
    this.queue = run.catch(() => undefined)
    return run
  }

  insert(row: Row): Promise<void> {
    return this.serialize(() => this.insertNow(row))
  }

  remove(id: string): Promise<void> {
    return this.serialize(() => this.removeNow(id))
  }

  reconfigure(id: string, config: unknown): Promise<void> {
    return this.serialize(() => this.reconfigureNow(id, config))
  }

  private async insertNow(row: Row): Promise<void> {
    if (this.list.some((existing) => existing.id === row.id)) throw new Error(`composition already has a row "${row.id}"`)
    const copy = { ...row }
    this.list.push(copy)
    if (copy.disabled) return
    const handle = this.root.plugin(copy.plugin, copy.config)
    this.handles.set(copy.id, handle)
    try {
      await handle.settled()
    } catch (error) {
      this.list.splice(this.list.indexOf(copy), 1)
      this.handles.delete(copy.id)
      await handle.dispose()
      throw error
    }
  }

  private async removeNow(id: string): Promise<void> {
    this.guardSpine(id, 'remove')
    const index = this.list.findIndex((row) => row.id === id)
    if (index < 0) throw new Error(`no composition row "${id}"`)
    const handle = this.handles.get(id)
    this.list.splice(index, 1)
    this.handles.delete(id)
    await handle?.dispose()
  }

  private async reconfigureNow(id: string, config: unknown): Promise<void> {
    this.guardSpine(id, 'reconfigure')
    const row = this.list.find((entry) => entry.id === id)
    if (!row) throw new Error(`no composition row "${id}"`)
    // Validate BEFORE disposing: a rejected config must leave the last good
    // instance running, not a dead row (the kernel would refuse the remount
    // anyway, but by then the old instance is gone).
    if (row.plugin.config) {
      try {
        row.plugin.config.parse(config)
      } catch (error) {
        throw new Error(`cannot reconfigure row "${id}": invalid config: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
    // Dispose FIRST: the old instance's provide unwinds on its inertia chain,
    // and an early remount would hit SERVICE_DUPLICATE.
    await this.handles.get(id)?.dispose()
    this.handles.delete(id)
    row.config = config
    if (row.disabled) return
    const handle = this.root.plugin(row.plugin, row.config)
    this.handles.set(id, handle)
    await handle.settled()
  }
}

/** Mounts each enabled row on the context. Activation order is dependency-driven. */
export function mount(root: Context, rows: readonly Row[]): Composition {
  return new MountedComposition(root, rows)
}

export interface ComposeOptions {
  readonly sessionsRoot: string
  /** Where oversized tool output is saved; omitted mounts no store, and tools then say what they dropped. */
  readonly spillRoot?: string
  /** The user's global AGENTS.md; omitted reads only the workspace's own files. */
  readonly globalInstructionsPath?: string
  readonly dialect: ShellDialect
  /** Secret-store path for `credentials-local`; omitted = env-only resolution. */
  readonly credentialsPath?: string
  readonly approve?: boolean
  readonly invariants?: boolean
  /** Deployment default for sessions that have recorded no mode of their own. */
  readonly sandbox?: SandboxMode
  /** Deployment default approval policy (`never` refuses every request unattended). */
  readonly approvalPolicy?: ApprovalPolicy
}

export function defaultDialect(): ShellDialect {
  return process.platform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * The built-in provider/model, pure and env-free: the environment and the
 * settings file layer over this in `app/settings.ts`, once, at process entry —
 * not ambiently at every call site.
 */
export function defaultAgentOptions(): AgentOptions {
  return { provider: 'deepseek', model: 'deepseek-v4-flash' }
}

/** The default MiniDSH composition. DeepSeek is the provider; the model is chosen per run. */
export function compose(options: ComposeOptions): Row[] {
  const withInvariants = options.invariants !== false
  const rows: Row[] = []
  if (withInvariants) rows.push(defineRow('invariants', invariantsPlugin, {}))
  rows.push(defineRow('session', sessionPlugin))
  if (withInvariants) rows.push(defineRow('session-invariant', sessionInvariantPlugin))
  rows.push(defineRow('credentials', credentialsLocalPlugin, options.credentialsPath === undefined ? {} : { path: options.credentialsPath }))
  rows.push(defineRow('llm', llmPlugin))
  rows.push(defineRow('llm-deepseek', deepseekPlugin, {}))
  rows.push(defineRow('llm-retry', retryPlugin, {}))
  rows.push(defineRow('tools', toolsPlugin))
  rows.push(defineRow('prompt', promptPlugin))
  rows.push(defineRow('approval', approvalPlugin, options.approvalPolicy === undefined ? {} : { policy: options.approvalPolicy }))
  rows.push(defineRow('approval-headless', approvalHeadlessPlugin, { approve: options.approve ?? false }))
  rows.push(defineRow('sandbox', sandboxPlugin, options.sandbox === undefined ? {} : { mode: options.sandbox }))
  if (withInvariants) rows.push(defineRow('authority-invariant', authorityInvariantPlugin))
  rows.push(defineRow('authority-presets', authorityPresetsPlugin, {}))
  rows.push(defineRow('fs', fsLocalPlugin))
  rows.push(defineRow('fs-observation-policy', fsObservationPolicyPlugin))
  rows.push(defineRow('shell', shellStdioPlugin, { dialect: options.dialect }))
  if (options.spillRoot !== undefined) rows.push(defineRow('spill', spillLocalPlugin, { root: options.spillRoot }))
  rows.push(defineRow('tool-editor', toolEditorPlugin, {}))
  rows.push(defineRow('tool-shell', toolShellPlugin, {}))
  rows.push(defineRow('context-runtime', contextRuntimePlugin, {}))
  // `maxBytes` is the deployment's prompt-budget choice, made here rather than
  // defaulted inside the capability.
  rows.push(
    defineRow('workspace-instructions', workspaceInstructionsPlugin, {
      maxBytes: 32_000,
      ...(options.globalInstructionsPath === undefined ? {} : { globalPath: options.globalInstructionsPath }),
    }),
  )
  rows.push(defineRow('compaction', compactionBasicPlugin, {}))
  rows.push(defineRow('agent', agentPlugin))
  if (withInvariants) rows.push(defineRow('agent-invariant', agentInvariantPlugin))
  rows.push(defineRow('loop', loopPlugin))
  if (withInvariants) rows.push(defineRow('loop-invariant', loopInvariantPlugin))
  rows.push(defineRow('persistence', persistenceJsonlPlugin, { root: options.sessionsRoot }))
  return rows
}
