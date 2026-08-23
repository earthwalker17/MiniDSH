/**
 * Application assembly: the default composition as typed rows, one patch
 * algorithm shared by boot and `--dump-config`, and the mount step. This is the
 * only place the default provider/model surface is chosen.
 */
import type { Context, Plugin } from '../kernel/index.ts'
import { agentInvariantPlugin } from '../core/agent/invariant.ts'
import { agentPlugin, type AgentOptions } from '../core/agent/index.ts'
import { approvalPlugin } from '../core/approval/index.ts'
import { invariantsPlugin } from '../core/invariants/index.ts'
import { llmPlugin } from '../core/llm/index.ts'
import { loopInvariantPlugin, loopPlugin } from '../core/loop/index.ts'
import { promptPlugin } from '../core/prompt/index.ts'
import { sessionInvariantPlugin, sessionPlugin } from '../core/session/index.ts'
import { toolsPlugin } from '../core/tools/index.ts'
import { approvalHeadlessPlugin } from '../capabilities/approval-headless/index.ts'
import { contextRuntimePlugin } from '../capabilities/context-runtime/index.ts'
import { deepseekPlugin } from '../capabilities/llm-deepseek/index.ts'
import { fsLocalPlugin } from '../capabilities/fs-local/index.ts'
import { fsObservationPolicyPlugin } from '../capabilities/fs-observation-policy/index.ts'
import { persistenceJsonlPlugin } from '../capabilities/persistence-jsonl/index.ts'
import { policyWorkspacePlugin } from '../capabilities/policy-workspace/index.ts'
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
  readonly approve?: boolean
  readonly invariants?: boolean
}

export function defaultDialect(): ShellDialect {
  return process.platform === 'win32' ? 'pwsh' : 'bash'
}

/** The one place the default provider/model live; every surface shares them. */
export function defaultAgentOptions(): AgentOptions {
  return { provider: 'deepseek', model: process.env.MINIDSH_MODEL ?? 'deepseek-v4-flash' }
}

/** The default MiniDSH composition. DeepSeek is the provider; the model is chosen per run. */
export function compose(options: ComposeOptions): Row[] {
  const withInvariants = options.invariants !== false
  const rows: Row[] = []
  if (withInvariants) rows.push(defineRow('invariants', invariantsPlugin, {}))
  rows.push(defineRow('session', sessionPlugin))
  if (withInvariants) rows.push(defineRow('session-invariant', sessionInvariantPlugin))
  rows.push(defineRow('llm', llmPlugin))
  rows.push(defineRow('llm-deepseek', deepseekPlugin, {}))
  rows.push(defineRow('llm-retry', retryPlugin, {}))
  rows.push(defineRow('tools', toolsPlugin))
  rows.push(defineRow('prompt', promptPlugin))
  rows.push(defineRow('approval', approvalPlugin))
  rows.push(defineRow('approval-headless', approvalHeadlessPlugin, { approve: options.approve ?? false }))
  rows.push(defineRow('fs', fsLocalPlugin))
  rows.push(defineRow('fs-observation-policy', fsObservationPolicyPlugin))
  rows.push(defineRow('policy-workspace', policyWorkspacePlugin))
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
