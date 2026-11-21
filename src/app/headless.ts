/**
 * The headless runner: a direct core entry point. Compose → settle (fail loud
 * on pending/failed plugins) → create/resume/fork an agent → followup(task) →
 * wait idle → stop its background jobs → flush → read the final assistant text
 * and turn outcome of THIS run's turn from the log. It only touches
 * `ctx.agents`/`ctx.sessions` (and `ctx.jobs`, optional, to stop what a task
 * left running) and renders through `onEvent`.
 */
import { z } from 'zod'
import { createRoot, type Context, type Logger } from '../kernel/index.ts'
import { AGENTS, mergeAgentOptions, type Agent, type AgentHandle, type AgentOptions } from '../core/agent/index.ts'
import { APPROVAL, APPROVAL_DECIDED, type ApprovalPolicy } from '../core/approval/index.ts'
import { JOBS } from '../core/jobs/index.ts'
import { effectiveSandboxMode, SANDBOX, type SandboxEnforcement, type SandboxMode } from '../core/sandbox/index.ts'
import { asSessionId, type SessionId } from '../core/ids.ts'
import { authoritySwitchRefusal, PRESETS } from '../core/presets/index.ts'
import { SETTINGS } from '../core/settings/index.ts'
import type { JsonValue } from '../core/json.ts'
import { foldLastAssistantText, foldLastTurnEnd, foldRequestContext, matches, SESSION_EVENT, type EventEnvelope, type SessionEventFrame } from '../core/session/index.ts'
import { LLM } from '../core/llm/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import { compose, COMPOSITION, defaultAgentOptions, defaultDialect, defineRow, mount, type Patch, type Row } from './compose.ts'
import { applyLayers, withDeployment, type NamedLayer } from './config.ts'
import type { SkillRoot } from '../capabilities/skills/index.ts'
import { agentSettingsSchema } from './settings.ts'
import { compositionRecordPlugin } from '../capabilities/composition-record/index.ts'
import type { ConfinementChoice, ShellDialect } from '../capabilities/shell-stdio/index.ts'

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
  /**
   * What this run accepts from its execution world. `none` lets a host with no
   * confinement backend run a shell at all, instead of charging an escalation
   * per command — and leaves the in-process file fence in place, which
   * dropping the whole session to `danger-full-access` would not.
   */
  readonly accepts?: SandboxEnforcement
  readonly sessionsRoot: string
  /** Store for oversized tool output; omitted mounts no store (hermetic tests). */
  readonly spillRoot?: string
  /** Store for image attachments; omitted mounts no store, and a producer of images then refuses (hermetic tests). */
  readonly attachmentsRoot?: string
  /** Where the browser's profiles go; omitted mounts no browser. */
  readonly browserProfileRoot?: string
  /** The user's global AGENTS.md; omitted reads only the workspace's own files (hermetic tests). */
  readonly globalInstructionsPath?: string
  /** Secret-store path for the credentials row; omitted = env-only (hermetic tests). */
  readonly credentialsPath?: string
  /** The settings document the runtime store reads and writes; omitted mounts no settings service. */
  readonly settingsStorePath?: string
  /**
   * The deployment's skill roots (`skillRootsFor(home)`), filled into a
   * `skills` row that names none, AFTER layering. Omitted, only the
   * workspace's own skill dirs are read (hermetic tests). A replay of a log
   * that `serve` recorded passes what `serve` mounted: the list is in the
   * recorded requests, and a replay without it moves every later cut.
   */
  readonly skillRoots?: readonly SkillRoot[]
  /**
   * Where the runtime itself is installed (`app/home.ts` `installRoots`),
   * filled into a shell row that names no `expose`, after layering. Omitted,
   * the row exposes nothing (hermetic tests).
   */
  readonly installRoots?: readonly string[]
  readonly dialect?: ShellDialect
  /** Which confinement mechanism wraps the shell; `none` pins a test to a host with no backend. */
  readonly confinement?: ConfinementChoice
  /** The programmatic app/test layer, applied before any disk layer. */
  readonly patches?: readonly Patch[]
  /** Disk layers (home composition.json, `--patch` files), applied in order after `patches`. */
  readonly configLayers?: readonly NamedLayer[]
  /** Rows the caller contributes to the BASE, before layering (serve's protocol row) — so disk patches can target them. */
  readonly extraBaseRows?: readonly Row[]
  /** Resolved agent defaults (settings layer); falls back to the pure built-ins. */
  readonly agentDefaults?: AgentOptions
  /**
   * The BASE the runtime settings store is registered with — the pure built-ins.
   * The store applies settings.json as its own user layer, so registering the
   * merged value would apply that file twice.
   */
  readonly agentSettingsBase?: AgentOptions
  /**
   * What outranks the settings file (today `MINIDSH_MODEL`). The store's layers
   * cannot express it, so a surface reading the store live applies it on top.
   */
  readonly agentOverrides?: Partial<AgentOptions>
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
  readonly world?: (agentCtx: Context) => void | Promise<void>
  /** The name that world was composed from, recorded in the session header. */
  readonly agentPreset?: string
}

/** Continuing a stored session: `resumeTask` keeps its id, `forkTask` branches it. */
export interface ContinueOptions extends BootOptions {
  readonly id: string
  readonly task?: string
  /** Fork boundary (inclusive seq); fork only. */
  readonly boundary?: number
  /** Fork a damaged stored log from its readable prefix (fork only; `ForkAgentOptions.salvage`). */
  readonly salvage?: boolean
  /** Overrides; the stored log's folded base route (`agent/options`) fills whatever is not given. */
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
  /** Authority preset applied as a durable switch on the continued session. */
  readonly preset?: string
  /** Per-agent world for the continued lifecycle. */
  readonly world?: (agentCtx: Context) => void | Promise<void>
  /** The name that world was composed from; a resumed session keeps the one its header already records. */
  readonly agentPreset?: string
}

export interface TaskResult {
  readonly exitCode: number
  readonly sessionId: SessionId
  /** The last assistant text of the turn this run drove; empty when that turn said nothing. */
  readonly text: string
  /** How the turn this run drove ended; `unknown` when it never did. */
  readonly reason: string
  /** Background jobs still running when the task went idle, stopped by the headless rule (`drive`). */
  readonly stoppedJobs: number
  /** What a person can do about how the run went, one line each, for stderr (`runNotes`). */
  readonly notes: readonly string[]
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
      ...(options.confinement === undefined ? {} : { confinement: options.confinement }),
      ...(options.spillRoot === undefined ? {} : { spillRoot: options.spillRoot }),
      ...(options.attachmentsRoot === undefined ? {} : { attachmentsRoot: options.attachmentsRoot }),
      ...(options.browserProfileRoot === undefined ? {} : { browserProfileRoot: options.browserProfileRoot }),
      ...(options.globalInstructionsPath === undefined ? {} : { globalInstructionsPath: options.globalInstructionsPath }),
      ...(options.credentialsPath === undefined ? {} : { credentialsPath: options.credentialsPath }),
      ...(options.settingsStorePath === undefined ? {} : { settingsStorePath: options.settingsStorePath }),
      ...(options.approve === undefined ? {} : { approve: options.approve }),
      ...(options.invariants === undefined ? {} : { invariants: options.invariants }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
      // The deployment default, so that a session this process does not create
      // — every session `serve`, `web` and `chat` open over the wire — opens
      // under the flag too. The sandbox stamps a weakened default into every
      // session it opens, so the log names it either way, and `applyAuthority`
      // on a path that owns its creation finds it already recorded.
      ...(options.accepts === undefined ? {} : { accepts: options.accepts }),
    }),
    ...(options.extraBaseRows ?? []),
  ]
  const layers: NamedLayer[] = [
    ...(options.patches !== undefined && options.patches.length > 0 ? [{ name: 'app', patches: options.patches }] : []),
    ...(options.configLayers ?? []),
  ]
  const warn = (message: string): void => options.logger?.warn(message)
  // After the layers: the deployment's own paths where a patch's whole-config
  // replace left none, then the explicit authority flags, which a layer on the
  // same row would otherwise erase with the rest of the base row's config.
  const effective = withDeployment(
    applyLayers(base, layers, warn),
    {
      skillRoots: options.skillRoots,
      globalInstructionsPath: options.globalInstructionsPath,
      installRoots: options.installRoots,
      flags: { sandbox: options.sandbox, accepts: options.accepts, approvalPolicy: options.approvalPolicy, approve: options.approve },
    },
    warn,
  )
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
  registerAgentSettings(root, options.agentSettingsBase ?? options.agentDefaults ?? defaultAgentOptions())
  try {
    await options.prepare?.(root)
  } catch (error) {
    // A refusal here (the CLI's route check) must not leave a mounted
    // composition behind it: the caller never got the root to dispose.
    await root.dispose()
    throw error
  }
  if (onEvent) root.on(SESSION_EVENT, (session, event) => onEvent({ sessionId: session.id, event }))
  return root
}

/**
 * Which settings namespaces exist is app assembly, so the boot claims them —
 * not a capability, and never the model.
 *
 * The BASE is this process's resolution MINUS the settings file — built-ins and
 * the environment — because the store re-applies that file as its own user
 * layer. Handing it the merged value would apply the file twice and make it
 * outrank `MINIDSH_MODEL`. Registering is skipped when no store is mounted:
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
 *
 * On a resume or a fork it is the continuation's `opening`
 * (`ResumeAgentOptions`): the factory runs it inside the creation transaction,
 * AFTER publication (the services' own opening stamps land first, and a
 * switch note finds its agent registered) and BEFORE any restored prompt may
 * wake a turn (`core/loop/factory.ts`). A refusal rolls the continuation
 * back: nothing woke, so nothing was claimed, and the restored prompt stays
 * owed. Applied once the resume had returned instead, a refused flag disposed
 * a turn that had already claimed that prompt, and the claim lost it from the
 * log. Moving it BEFORE publication is the other wrong change: the switch
 * then reaches the log and not the model.
 */
export function applyAuthority(root: Context, agent: Agent, options: BootOptions & { readonly preset?: string }): void {
  // All or nothing: a delegated child's pin refused the approval only after
  // the mode had landed, durably (S20.5 review).
  const refusal = authoritySwitchRefusal(agent.session, { sandbox: options.sandbox, approval: options.approvalPolicy, accepts: options.accepts })
  if (refusal !== undefined) throw new Error(refusal)
  if (options.sandbox !== undefined) root.get(SANDBOX).setMode(agent.session, options.sandbox)
  if (options.approvalPolicy !== undefined) root.get(APPROVAL).setPolicy(agent.session, options.approvalPolicy)
  // The preset before the acceptance and after the pair, because the pair and
  // the preset are mutually exclusive at the CLI while the acceptance composes
  // with both — and an acceptance is given FOR a mode, so it must see the mode
  // this run ends up under, not the one it started from.
  applyPreset(root, agent, options.preset)
  if (options.accepts !== undefined) {
    const sandbox = root.get(SANDBOX)
    sandbox.setAcceptance(agent.session, options.accepts, effectiveSandboxMode(agent.session.facts) ?? sandbox.defaultMode)
  }
}

/** A preset is the same durable act through the one selector; `applyAuthority` stays preset-ignorant. */
function applyPreset(root: Context, agent: Agent, name: string | undefined): void {
  if (name === undefined) return
  const presets = root.tryGet(PRESETS)
  if (!presets) throw new Error('a preset needs the authority-presets row, which this composition removes')
  presets.apply(agent.session, name)
}

/**
 * Feed the task (if any), wait for quiescence, stop what is still running,
 * flush, fold the outcome; always disposes the handle.
 *
 * **The headless rule.** A one-shot run ends when its task goes idle, and
 * nothing will be there to read a background job's end: every job still
 * running is stopped, recorded `cancelled` by `disposal` and delivered quiet.
 * `stopAll` is called in the SAME continuation as `whenIdle`, before any other
 * await — a job's own end landing in between would wake a paid turn nobody
 * asked for. The exit code still reads the last `turn/end` alone.
 */
async function drive(root: Context, handle: AgentHandle, task: string | undefined): Promise<TaskResult> {
  try {
    await handle.agent.whenIdle()
    const session = handle.agent.session
    // Where THIS run's turn begins. The answer and the outcome are folded from
    // here on: over the whole log, a resumed or forked run whose own turn
    // failed before it said anything printed the previous turn's answer (for
    // a fork, its parent's) as if it were the reply to this task. With no
    // task there is no turn of this run's own, and the log's last one stands.
    let from = 0
    if (task !== undefined && task.length > 0) {
      from = session.facts.length
      handle.agent.followup(createUserMessage(task))
      await handle.agent.whenIdle()
    }
    const jobs = root.tryGet(JOBS)
    const running = new Set(jobs?.list(handle.agent).filter((job) => job.state === 'running').map((job) => job.jobId) ?? [])
    const stopping = jobs?.stopAll(handle.agent)
    if (stopping !== undefined) {
      await stopping
      await handle.agent.whenIdle()
    }
    // What the stop ENDED, read from the recorded ends: a job whose own exit
    // was still draining its pipes when the task went idle ended by itself.
    const stoppedJobs = (jobs?.list(handle.agent) ?? []).filter((job) => running.has(job.jobId) && job.end?.cause === 'cancelled' && job.end.by === 'disposal').length
    await session.flush()
    const events = session.facts.slice(from)
    const reason = foldLastTurnEnd(events)?.kind ?? 'unknown'
    return {
      exitCode: reason === 'completed' ? 0 : 1,
      sessionId: asSessionId(handle.agent.id),
      text: foldLastAssistantText(events),
      reason,
      stoppedJobs,
      notes: runNotes(root, handle.agent, events),
    }
  } finally {
    await handle.dispose()
  }
}

/**
 * What a person can do about how this run went, one line each, for stderr.
 * Read from the run's own events and from the mounted services, while both
 * are still there.
 *
 * A headless run has nobody to ask, so a call that needed an approval is
 * refused — and the only word the stream had for it was `unavailable`, with
 * the turn going on to complete and the run exiting 0. The exit code is the
 * turn's and stays so (a refused call is a result the model answered, not a
 * failed run); this says which flag would have let the call through. And a
 * model id the provider refused is answered with the ids it does list.
 */
function runNotes(root: Context, agent: Agent, events: readonly EventEnvelope[]): string[] {
  const notes: string[] = []
  if (events.some((event) => matches(event, APPROVAL_DECIDED) && event.data.outcome === 'unavailable')) {
    const sandbox = root.tryGet(SANDBOX)
    const mode = sandbox === undefined ? undefined : (effectiveSandboxMode(agent.session.facts) ?? sandbox.defaultMode)
    // The escalation a host with no confinement backend charges per command
    // is the commonest reason to be here, and it has a flag of its own.
    const unconfined = sandbox !== undefined && mode !== undefined && mode !== 'danger-full-access' && sandbox.enforcementFor(mode) !== 'full' && sandbox.acceptsFor(agent.session, mode) === 'full'
    notes.push(
      'an approval was needed and nobody could answer it (a headless run asks no one), so the call was refused. To allow it, rerun with --approve (answers every request yes)' +
        (unconfined ? '; this host cannot confine the shell, and --accept none runs shell commands unconfined without asking while the file tools stay fenced' : ''),
    )
  }
  const end = foldLastTurnEnd(events)
  if (end?.kind === 'error' && end.code === 'UNKNOWN_MODEL') {
    const route = foldRequestContext(events) ?? agent.options
    const listed = root.tryGet(LLM)?.providers().find((entry) => entry.id === route.provider)?.models.map((model) => model.id) ?? []
    if (listed.length > 0) notes.push(`${route.provider} refused the model "${route.model}"; the models it lists are: ${listed.join(', ')}`)
  }
  return notes
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
      ...(options.world === undefined ? {} : { world: options.world }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    })
    applyAuthority(root, handle.agent, options)
    return await drive(root, handle, options.task)
  } finally {
    await root.dispose()
  }
}

function continueArgs(options: ContinueOptions): {
  agentOptions: Partial<AgentOptions>
  defaults: AgentOptions
  world?: (agentCtx: Context) => void | Promise<void>
} {
  return {
    agentOptions: {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    },
    // The defaults tier: the stored log's folded base route beats these, so a
    // settings-layer model can never rewrite what a session recorded.
    defaults: options.agentDefaults ?? defaultAgentOptions(),
    ...(options.world === undefined ? {} : { world: options.world }),
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  }
}

export async function resumeTask(options: ContinueOptions, onEvent?: EventListener): Promise<TaskResult> {
  const root = await bootComposition(options, onEvent)
  try {
    const handle = await root.get(AGENTS).resume(root, asSessionId(options.id), { ...continueArgs(options), opening: (agent) => applyAuthority(root, agent, options) })
    return await drive(root, handle, options.task)
  } finally {
    await root.dispose()
  }
}

export async function forkTask(options: ContinueOptions, onEvent?: EventListener): Promise<TaskResult> {
  const root = await bootComposition(options, onEvent)
  try {
    const handle = await root.get(AGENTS).fork(root, asSessionId(options.id), options.boundary, {
      ...continueArgs(options),
      ...(options.salvage === true ? { salvage: true } : {}),
      opening: (agent) => applyAuthority(root, agent, options),
    })
    return await drive(root, handle, options.task)
  } finally {
    await root.dispose()
  }
}
