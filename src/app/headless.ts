/**
 * The headless runner: a direct core entry point. Compose → settle (fail loud
 * on pending/failed plugins) → create/resume/fork an agent → followup(task) →
 * wait idle → flush → read the final assistant text and turn outcome from the
 * log. It only touches `ctx.agents`/`ctx.sessions` and renders through
 * `onEvent`.
 */
import { z } from 'zod'
import { createRoot, type Context, type Logger } from '../kernel/index.ts'
import { AGENTS, mergeAgentOptions, type AgentHandle, type AgentOptions } from '../core/agent/index.ts'
import { APPROVAL, type ApprovalPolicy } from '../core/approval/index.ts'
import { SANDBOX, type SandboxMode } from '../core/sandbox/index.ts'
import { asSessionId, type SessionId } from '../core/ids.ts'
import { messageText } from '../core/llm/message.ts'
import { PRESETS } from '../core/presets/index.ts'
import { SETTINGS } from '../core/settings/index.ts'
import type { JsonValue } from '../core/json.ts'
import { ASSISTANT_MESSAGE, matches, SESSION_EVENT, TURN_END, type EventEnvelope, type SessionEventFrame } from '../core/session/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { compose, COMPOSITION, defaultAgentOptions, defaultDialect, defineRow, mount, type Patch, type Row } from './compose.ts'
import { applyLayers, type NamedLayer } from './config.ts'
import { agentSettingsSchema } from './settings.ts'
import { compositionRecordPlugin } from '../capabilities/composition-record/index.ts'
import type { ShellDialect } from '../capabilities/shell-stdio/index.ts'

export interface BootOptions {
  readonly approve?: boolean
  readonly invariants?: boolean
  /**
   * Authority for this run. Given explicitly, it is also applied to the agent
   * as a durable switch, so it governs a RESUMED session whose log recorded
   * something else; left out, the session keeps whatever it recorded.
   */
  readonly sandbox?: SandboxMode
  readonly approvalPolicy?: ApprovalPolicy
  readonly sessionsRoot: string
  /** Store for oversized tool output; omitted mounts no store (hermetic tests). */
  readonly spillRoot?: string
  /** The user's global AGENTS.md; omitted reads only the workspace's own files (hermetic tests). */
  readonly globalInstructionsPath?: string
  /** Secret-store path for the credentials row; omitted = env-only (hermetic tests). */
  readonly credentialsPath?: string
  /** The settings document the runtime store reads and writes; omitted mounts no settings service. */
  readonly settingsStorePath?: string
  readonly dialect?: ShellDialect
  /** The programmatic app/test layer, applied before any disk layer. */
  readonly patches?: readonly Patch[]
  /** Disk layers (home composition.json, `--patch` files), applied in order after `patches`. */
  readonly configLayers?: readonly NamedLayer[]
  /** Rows the caller contributes to the BASE, before layering (serve's protocol row) — so disk patches can target them. */
  readonly extraBaseRows?: readonly Row[]
  /** Resolved agent defaults (settings layer); falls back to the pure built-ins. */
  readonly agentDefaults?: AgentOptions
  readonly logger?: Logger
  /** Runs after settle, before the agent is created (tests register a scripted adapter here). */
  readonly prepare?: (root: Context) => void | Promise<void>
}

export interface TaskOptions extends BootOptions {
  readonly task: string
  readonly cwd: string
  readonly model: string
  readonly provider?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
  /** Authority preset applied as a durable switch (validated by the service; exclusive with sandbox/approvalPolicy at the CLI). */
  readonly preset?: string
  /** Per-agent world: runs on the agent scope during creation (the factory's scoped settle is the fail-loud gate). */
  readonly setup?: (agentCtx: Context) => void | Promise<void>
  /** The name that world was composed from, recorded in the session header. */
  readonly agentPreset?: string
}

/** Continuing a stored session: `resumeTask` keeps its id, `forkTask` branches it. */
export interface ContinueOptions extends BootOptions {
  readonly id: string
  readonly task?: string
  /** Fork boundary (inclusive seq); fork only. */
  readonly boundary?: number
  /** Overrides; the stored log's folded request/header fills whatever is not given. */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
  /** Authority preset applied as a durable switch on the continued session. */
  readonly preset?: string
  /** Per-agent world for the continued lifecycle. */
  readonly setup?: (agentCtx: Context) => void | Promise<void>
  /** The name that world was composed from; a resumed session keeps the one its header already records. */
  readonly agentPreset?: string
}

export interface TaskResult {
  readonly exitCode: number
  readonly sessionId: SessionId
  readonly text: string
  readonly reason: string
}

/** Streams `{sessionId, event}` — the same frame the wire carries (ARCHITECTURE §8). */
export type EventListener = (frame: SessionEventFrame) => void

const silentLogger: Logger = { warn: () => {}, error: () => {} }

/** Base + layers → mount → settle (fail loud) → prepare; the shared boot for every app entry. */
export async function bootComposition(options: BootOptions, onEvent?: EventListener): Promise<Context> {
  const root = createRoot({ logger: options.logger ?? silentLogger })
  const base: Row[] = [
    ...compose({
      sessionsRoot: options.sessionsRoot,
      dialect: options.dialect ?? defaultDialect(),
      ...(options.spillRoot === undefined ? {} : { spillRoot: options.spillRoot }),
      ...(options.globalInstructionsPath === undefined ? {} : { globalInstructionsPath: options.globalInstructionsPath }),
      ...(options.credentialsPath === undefined ? {} : { credentialsPath: options.credentialsPath }),
      ...(options.settingsStorePath === undefined ? {} : { settingsStorePath: options.settingsStorePath }),
      ...(options.approve === undefined ? {} : { approve: options.approve }),
      ...(options.invariants === undefined ? {} : { invariants: options.invariants }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    }),
    ...(options.extraBaseRows ?? []),
  ]
  const layers: NamedLayer[] = [
    ...(options.patches !== undefined && options.patches.length > 0 ? [{ name: 'app', patches: options.patches }] : []),
    ...(options.configLayers ?? []),
  ]
  const effective = applyLayers(base, layers, (message) => options.logger?.warn(message))
  // The recorder sits OUTSIDE the layered composition: its config IS the
  // descriptor of the effective rows, and no layer can silently remove the
  // record of what the layers did.
  const rows = [...effective.rows, defineRow('composition-record', compositionRecordPlugin, { descriptor: effective.descriptor })]
  root.provide(COMPOSITION, mount(root, rows))
  const report = await root.settle()
  if (report.pending.length > 0 || report.failed.length > 0) {
    await root.dispose()
    const pending = report.pending.map((entry) => `${entry.name} (needs ${entry.missing.join(', ') || 'nothing'})`).join('; ')
    // The failure's own words, so a bad row config reads as what it is.
    const failed = report.failed.map((entry) => `${entry.name}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`).join('; ')
    throw new Error(`composition did not settle — pending: [${pending}] failed: [${failed}]`)
  }
  registerAgentSettings(root, options.agentDefaults ?? defaultAgentOptions())
  await options.prepare?.(root)
  if (onEvent) root.on(SESSION_EVENT, (session, event) => onEvent({ sessionId: session.id, event }))
  return root
}

/**
 * Which settings namespaces exist is app assembly, so the boot claims them —
 * not a capability, and never the model.
 *
 * The BASE is the value this process already resolved (built-ins, then the
 * environment, then the file), so boot precedence is untouched and a wire write
 * lands as one layer ABOVE it. Registering is skipped when no store is mounted:
 * a hermetic composition then has no settings service at all, and every reader
 * falls back to the values it was handed.
 */
function registerAgentSettings(root: Context, base: AgentOptions): void {
  const settings = root.tryGet(SETTINGS)
  if (!settings) return
  settings.register(root, 'agent', agentSettingsSchema, {
    base,
    schema: z.toJSONSchema(agentSettingsSchema) as JsonValue,
  })
}

/**
 * An explicitly requested authority is a durable switch on the agent session,
 * not just a composition default — so it also governs a resumed session.
 */
export function applyAuthority(root: Context, handle: AgentHandle, options: BootOptions): void {
  if (options.sandbox !== undefined) root.get(SANDBOX).setMode(handle.agent.session, options.sandbox)
  if (options.approvalPolicy !== undefined) root.get(APPROVAL).setPolicy(handle.agent.session, options.approvalPolicy)
}

/** A preset is the same durable act through the one selector; `applyAuthority` stays preset-ignorant. */
function applyPreset(root: Context, handle: AgentHandle, name: string | undefined): void {
  if (name === undefined) return
  const presets = root.tryGet(PRESETS)
  if (!presets) throw new Error('a preset needs the authority-presets row, which this composition removes')
  presets.apply(handle.agent.session, name)
}

/** Feed the task (if any), wait for quiescence, flush, fold the outcome; always disposes the handle. */
async function drive(handle: AgentHandle, task: string | undefined): Promise<TaskResult> {
  try {
    await handle.agent.whenIdle()
    if (task !== undefined && task.length > 0) {
      handle.agent.followup(createUserMessage(task))
      await handle.agent.whenIdle()
    }
    await handle.agent.session.flush()
    const events = handle.agent.session.facts
    return {
      exitCode: foldReason(events) === 'completed' ? 0 : 1,
      sessionId: asSessionId(handle.agent.id),
      text: foldFinalText(events),
      reason: foldReason(events),
    }
  } finally {
    await handle.dispose()
  }
}

export async function runTask(options: TaskOptions, onEvent?: EventListener): Promise<TaskResult> {
  const root = await bootComposition(options, onEvent)
  try {
    const defaults = options.agentDefaults ?? defaultAgentOptions()
    // The same merge a live switch and a resume take: an effort is an
    // ADAPTER-OWNED id, so a flag that changes the route drops an effort the
    // settings named for the old one rather than sending it to a provider
    // that would refuse it on every step.
    const agentOptions: AgentOptions = mergeAgentOptions(defaults, {
      model: options.model,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    })
    const handle = await root.get(AGENTS).create(root, {
      cwd: options.cwd,
      agentOptions,
      ...(options.setup === undefined ? {} : { setup: options.setup }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    })
    applyAuthority(root, handle, options)
    applyPreset(root, handle, options.preset)
    return await drive(handle, options.task)
  } finally {
    await root.dispose()
  }
}

function continueArgs(options: ContinueOptions): {
  agentOptions: Partial<AgentOptions>
  defaults: AgentOptions
  setup?: (agentCtx: Context) => void | Promise<void>
} {
  return {
    agentOptions: {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    },
    // The defaults tier: the stored log's folded request/header beats these,
    // so a settings-layer model can never rewrite what a session recorded.
    defaults: options.agentDefaults ?? defaultAgentOptions(),
    ...(options.setup === undefined ? {} : { setup: options.setup }),
  }
}

export async function resumeTask(options: ContinueOptions, onEvent?: EventListener): Promise<TaskResult> {
  const root = await bootComposition(options, onEvent)
  try {
    const handle = await root.get(AGENTS).resume(root, asSessionId(options.id), continueArgs(options))
    applyAuthority(root, handle, options)
    applyPreset(root, handle, options.preset)
    return await drive(handle, options.task)
  } finally {
    await root.dispose()
  }
}

export async function forkTask(options: ContinueOptions, onEvent?: EventListener): Promise<TaskResult> {
  const root = await bootComposition(options, onEvent)
  try {
    const handle = await root.get(AGENTS).fork(root, asSessionId(options.id), options.boundary, continueArgs(options))
    applyAuthority(root, handle, options)
    applyPreset(root, handle, options.preset)
    return await drive(handle, options.task)
  } finally {
    await root.dispose()
  }
}

function foldFinalText(events: readonly EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, ASSISTANT_MESSAGE)) {
      const text = messageText(event.data.message)
      if (text.length > 0) return text
    }
  }
  return ''
}

function foldReason(events: readonly EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, TURN_END)) return event.data.reason.kind
  }
  return 'unknown'
}
