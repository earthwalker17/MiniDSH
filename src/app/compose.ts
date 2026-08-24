/**
 * Application assembly: the default composition as typed rows, one patch
 * algorithm shared by boot and `--dump-config`, and the mount step. This is the
 * only place the default provider/model surface is chosen.
 */
import type { Context, Plugin } from '../kernel/index.ts'
import { agentInvariantPlugin } from '../core/agent/invariant.ts'
import { agentPlugin, type AgentOptions } from '../core/agent/index.ts'
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
import { contextRuntimePlugin } from '../capabilities/context-runtime/index.ts'
import { credentialsLocalPlugin } from '../capabilities/credentials-local/index.ts'
import { deepseekPlugin } from '../capabilities/llm-deepseek/index.ts'
import { fsLocalPlugin } from '../capabilities/fs-local/index.ts'
import { fsObservationPolicyPlugin } from '../capabilities/fs-observation-policy/index.ts'
import { persistenceJsonlPlugin } from '../capabilities/persistence-jsonl/index.ts'
import { retryPlugin } from '../capabilities/llm-retry/index.ts'
import { shellStdioPlugin, type ShellDialect } from '../capabilities/shell-stdio/index.ts'
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
      fsLocalPlugin,
      fsObservationPolicyPlugin,
      shellStdioPlugin,
      toolEditorPlugin,
      toolShellPlugin,
      contextRuntimePlugin,
      agentPlugin,
      agentInvariantPlugin,
      loopPlugin,
      loopInvariantPlugin,
      persistenceJsonlPlugin,
    ] as readonly Plugin<never>[]
  ).map((plugin) => [plugin.name, plugin as Plugin<unknown>]),
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

/** Mounts each enabled row on the context. Activation order is dependency-driven. */
export function mount(root: Context, rows: readonly Row[]): void {
  for (const row of rows) {
    if (row.disabled) continue
    root.plugin(row.plugin, row.config)
  }
}

export interface ComposeOptions {
  readonly sessionsRoot: string
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
  rows.push(defineRow('fs', fsLocalPlugin))
  rows.push(defineRow('fs-observation-policy', fsObservationPolicyPlugin))
  rows.push(defineRow('shell', shellStdioPlugin, { dialect: options.dialect }))
  rows.push(defineRow('tool-editor', toolEditorPlugin, {}))
  rows.push(defineRow('tool-shell', toolShellPlugin, {}))
  rows.push(defineRow('context-runtime', contextRuntimePlugin, {}))
  rows.push(defineRow('agent', agentPlugin))
  if (withInvariants) rows.push(defineRow('agent-invariant', agentInvariantPlugin))
  rows.push(defineRow('loop', loopPlugin))
  if (withInvariants) rows.push(defineRow('loop-invariant', loopInvariantPlugin))
  rows.push(defineRow('persistence', persistenceJsonlPlugin, { root: options.sessionsRoot }))
  return rows
}
