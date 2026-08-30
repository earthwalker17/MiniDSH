/**
 * The headless CLI surface. It renders exclusively from `session/event`, drives
 * only `ctx.agents`/`ctx.sessions` via the runner, and exits 0 iff the turn
 * completed. `--json` streams raw session events to stdout; `sessions show`
 * reads the log only.
 *
 * Every command boots through ONE preamble (`prepareBoot`): flags, settings,
 * the disk layers, the preset and agent-preset flags — so `config`, `--preset`
 * validation and `sessions` compose the exact rows a boot would mount, not an
 * approximation of them.
 */
import { createRoot, describeConfigError, type Logger } from '../kernel/index.ts'
import { formatTokens, meterSession } from '../core/metering/index.ts'
import { foldRequestContext } from '../core/session/index.ts'
import { PERSISTENCE, type Persistence } from '../core/persistence/index.ts'
import { persistenceJsonlPlugin } from '../capabilities/persistence-jsonl/index.ts'
import { APPROVAL_POLICIES, isApprovalPolicy, type ApprovalPolicy } from '../core/approval/index.ts'
import { isSandboxMode, SANDBOX_MODES, type SandboxMode } from '../core/sandbox/index.ts'
import { dirname, resolve } from 'node:path'
import { presetTable } from '../core/presets/index.ts'
import type { AuthorityPresetsConfig } from '../capabilities/authority-presets/index.ts'
import type { Context } from '../kernel/index.ts'
import { compose, defaultDialect, type Row } from './compose.ts'
import { agentPresetSetup, applyLayers, loadCompositionFile, toPatches, toRow, type DiskRow, type NamedLayer } from './config.ts'
import { forkTask, resumeTask, runTask, type ContinueOptions, type EventListener, type TaskResult } from './headless.ts'
import { compositionPath, homeLayout, resolveHome, settingsPath, type HomeLayout } from './home.ts'
import { auditLines, describeEvent } from './present.ts'
import { resolveSettings, type ResolvedSettings } from './settings.ts'
import { startProtocolHost } from './serve.ts'
import { runTerminal } from './terminal/index.ts'

interface ParsedArgs {
  readonly command: string
  readonly positional: string[]
  readonly flags: Map<string, string | true>
  /** `--patch <file>` is repeatable; the flags map is last-wins, so it collects here. */
  readonly patchFiles: string[]
}

const VALUE_FLAGS = new Set(['cwd', 'provider', 'model', 'effort', 'max-steps', 'at', 'sandbox', 'ask', 'preset', 'agent-preset'])

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const patchFiles: string[] = []
  const command = argv[0] ?? 'help'
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (name === 'patch') patchFiles.push(argv[++i] ?? '')
      else if (VALUE_FLAGS.has(name)) flags.set(name, argv[++i] ?? '')
      else flags.set(name, true)
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags, patchFiles }
}

const stderrLogger: Logger = {
  warn: (message) => process.stderr.write(`warn: ${message}\n`),
  error: (message) => process.stderr.write(`error: ${message}\n`),
}

function usage(line: string): number {
  process.stderr.write(`${line}\n`)
  return 2
}

// ---- the one boot preamble --------------------------------------------------

interface AuthorityFlags {
  readonly sandbox?: SandboxMode
  readonly approvalPolicy?: ApprovalPolicy
}

interface LoadedConfig {
  readonly layers: NamedLayer[]
  /** Named agent presets merged across files, later files winning per name; rows resolve against their source file's directory. */
  readonly agentPresets: Map<string, { rows: readonly DiskRow[]; baseDir: string }>
}

/** Everything a command needs to boot, resolved once and the same way for every command. */
interface BootPlan {
  readonly home: HomeLayout
  readonly settings: ResolvedSettings
  readonly loaded: LoadedConfig
  readonly authority: AuthorityFlags
  /** `--preset`, validated against the effective presets row (headless commands only). */
  readonly preset?: string
  /** `--agent-preset`, resolved to a setup for the agent scope. */
  readonly agentSetup?: (agentCtx: Context) => void
}

/** How a command treats `--preset`: applied as a durable switch, refused in favour of `/preset`, or not a flag at all. */
type PresetUse = 'headless' | 'interactive' | 'none'

/** The boot options every app entry shares, from one plan. */
function bootFields(plan: BootPlan): {
  sessionsRoot: string
  spillRoot: string
  globalInstructionsPath: string
  credentialsPath: string
  agentDefaults: ResolvedSettings['agent']
  configLayers: NamedLayer[]
  logger: Logger
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
} {
  return { ...plan.home, agentDefaults: plan.settings.agent, configLayers: plan.loaded.layers, logger: stderrLogger, ...plan.authority }
}

/** The rows a boot would mount from the built-ins alone — the base every layered view starts from. */
function baseRows(home: HomeLayout, authority: AuthorityFlags = {}): Row[] {
  return compose({ ...home, dialect: defaultDialect(), ...authority })
}

/**
 * `settings: 'optional'` is for commands that only read stored logs: a broken
 * settings.json must not stand between a user and `sessions show --audit`.
 */
async function prepareBoot(args: ParsedArgs, presets: PresetUse, settingsUse: 'required' | 'optional' = 'required'): Promise<BootPlan | string> {
  const authority = authorityFlags(args)
  if (typeof authority === 'string') return authority
  const loadedSettings = loadSettings()
  if (typeof loadedSettings === 'string' && settingsUse === 'required') return loadedSettings
  if (typeof loadedSettings === 'string') stderrLogger.warn(loadedSettings)
  const settings = typeof loadedSettings === 'string' ? resolveSettings() : loadedSettings
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') return loaded
  const home = homeLayout()
  // A command that cannot apply a preset says so before it looks one up.
  if (args.flags.get('preset') !== undefined && presets === 'none') return `--preset is not a flag of "${args.command}"`
  const preset = presetFlag(args, authority, home, loaded.layers)
  if (typeof preset === 'object') return preset.error
  if (preset !== undefined && presets === 'interactive') return '--preset works with --headless; in the interactive terminal use /preset'
  const agentSetup = await agentPresetFlag(args, loaded)
  if (typeof agentSetup === 'object') return agentSetup.error
  return {
    home,
    settings,
    loaded,
    authority,
    ...(preset === undefined ? {} : { preset }),
    ...(agentSetup === undefined ? {} : { agentSetup }),
  }
}

/** `--sandbox` / `--ask`: an explicit authority for this run, validated before anything boots. */
function authorityFlags(args: ParsedArgs): AuthorityFlags | string {
  const sandbox = args.flags.get('sandbox')
  const ask = args.flags.get('ask')
  if (sandbox !== undefined && !isSandboxMode(sandbox)) {
    return `--sandbox expects ${SANDBOX_MODES.join(' | ')}, got "${String(sandbox)}"`
  }
  if (ask !== undefined && !isApprovalPolicy(ask)) return `--ask expects ${APPROVAL_POLICIES.join(' | ')}, got "${String(ask)}"`
  return {
    ...(isSandboxMode(sandbox) ? { sandbox } : {}),
    ...(isApprovalPolicy(ask) ? { approvalPolicy: ask } : {}),
  }
}

/** Settings resolve once per command; a malformed file is a usage-class failure (exit 2), never silently ignored. */
function loadSettings(): ResolvedSettings | string {
  try {
    return resolveSettings({ path: settingsPath() })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The disk layers, in fixed order: home composition.json, then each `--patch`
 * file. A missing home file is absent; a missing or malformed `--patch` file
 * is a usage error — someone asked for it by name.
 */
async function loadConfigLayers(patchFiles: readonly string[]): Promise<LoadedConfig | string> {
  try {
    const layers: NamedLayer[] = []
    const agentPresets: LoadedConfig['agentPresets'] = new Map()
    const collect = (file: { agentPresets?: Record<string, readonly DiskRow[]> | undefined }, baseDir: string): void => {
      for (const [name, rows] of Object.entries(file.agentPresets ?? {})) agentPresets.set(name, { rows, baseDir })
    }
    const home = loadCompositionFile(compositionPath())
    if (home) {
      layers.push({ name: 'home', patches: await toPatches(home, resolveHome()) })
      collect(home, resolveHome())
    }
    for (const raw of patchFiles) {
      if (raw.trim().length === 0) return '--patch expects a file path'
      const path = resolve(raw)
      const file = loadCompositionFile(path)
      if (!file) return `--patch file not found or unreadable: ${raw}`
      layers.push({ name: `patch:${raw}`, patches: await toPatches(file, dirname(path)) })
      collect(file, dirname(path))
    }
    return { layers, agentPresets }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** `--agent-preset`: a named per-agent row list from the config files, resolved to a setup for the agent scope. */
async function agentPresetFlag(args: ParsedArgs, loaded: LoadedConfig): Promise<((agentCtx: Context) => void) | { error: string } | undefined> {
  const raw = args.flags.get('agent-preset')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return { error: '--agent-preset expects a preset name' }
  const spec = loaded.agentPresets.get(raw)
  if (!spec) {
    const known = [...loaded.agentPresets.keys()]
    return { error: `unknown agent preset "${raw}"${known.length > 0 ? ` (known: ${known.join(', ')})` : ' (no agentPresets configured)'}` }
  }
  try {
    const rows: Row[] = []
    for (const row of spec.rows) rows.push(await toRow(row, spec.baseDir))
    return agentPresetSetup(rows)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * `--preset`: exclusive with `--sandbox`/`--ask`, and validated pre-boot
 * against the EFFECTIVE presets row (a disk layer may have reconfigured the
 * table) — a typo boots nothing and litters no session file. Returns the
 * validated name, an error, or undefined when the flag is absent.
 */
function presetFlag(args: ParsedArgs, authority: AuthorityFlags, home: HomeLayout, configLayers: readonly NamedLayer[]): string | { error: string } | undefined {
  const raw = args.flags.get('preset')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return { error: '--preset expects a preset name' }
  if (authority.sandbox !== undefined || authority.approvalPolicy !== undefined) {
    return { error: '--preset replaces --sandbox/--ask; give one or the other' }
  }
  try {
    const effective = applyLayers(baseRows(home, authority), [...configLayers], () => {})
    // Match the CAPABILITY, not the built-in row id: a composition may supply
    // it under any id, and the runtime resolves PRESETS by service key.
    const row = effective.rows.find((entry) => entry.plugin.name === 'authority-presets' && entry.disabled !== true)
    if (!row) return { error: 'this composition has no enabled authority-presets row' }
    const table = presetTable((row.config as AuthorityPresetsConfig | undefined)?.presets)
    if (!table.has(raw)) return { error: `unknown preset "${raw}" (known: ${[...table.keys()].join(', ')})` }
    return raw
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

interface CommonModelFlags {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
}

function modelFlags(args: ParsedArgs): CommonModelFlags {
  const provider = args.flags.get('provider')
  const model = args.flags.get('model')
  const effort = args.flags.get('effort')
  const maxStepsRaw = args.flags.get('max-steps')
  const maxSteps = typeof maxStepsRaw === 'string' ? Number(maxStepsRaw) : undefined
  return {
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
    ...(maxSteps === undefined || Number.isNaN(maxSteps) ? {} : { maxSteps }),
  }
}

/** Absolute, always: the cwd becomes the immutable workspace root of every session it opens. */
function cwdFlag(args: ParsedArgs): string {
  const cwd = args.flags.get('cwd')
  return typeof cwd === 'string' ? resolve(cwd) : process.cwd()
}

// ---- rendering ----------------------------------------------------------------

function eventPrinter(json: boolean): EventListener {
  // --json emits the wire frame: one {sessionId, event} per line.
  return json
    ? (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
    : (frame) => {
        const line = describeEvent(frame.event)
        if (line) process.stderr.write(`  ${line}\n`)
      }
}

function finishTask(result: TaskResult, json: boolean): number {
  if (!json) process.stdout.write(`${result.text}\n`)
  if (result.reason !== 'completed') process.stderr.write(`turn ended: ${result.reason}\n`)
  process.stderr.write(`session: ${result.sessionId}\n`)
  return result.exitCode
}

function reportError(error: unknown): number {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  return 1
}

// ---- commands -----------------------------------------------------------------

async function runCommand(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim()
  if (task.length === 0) {
    return usage('usage: minidsh run "<task>" [--cwd dir] [--provider id] [--model id] [--effort id] [--max-steps n] [--sandbox mode] [--approve] [--json]')
  }
  const plan = await prepareBoot(args, 'headless')
  if (typeof plan === 'string') return usage(plan)
  const json = args.flags.get('json') === true
  const flags = modelFlags(args)
  try {
    const result = await runTask(
      {
        task,
        cwd: cwdFlag(args),
        model: flags.model ?? plan.settings.agent.model,
        ...(flags.provider === undefined ? {} : { provider: flags.provider }),
        ...(flags.reasoningEffort === undefined ? {} : { reasoningEffort: flags.reasoningEffort }),
        ...(flags.maxSteps === undefined ? {} : { maxSteps: flags.maxSteps }),
        ...(plan.preset === undefined ? {} : { preset: plan.preset }),
        ...(plan.agentSetup === undefined ? {} : { setup: plan.agentSetup }),
        approve: args.flags.get('approve') === true,
        ...bootFields(plan),
      },
      eventPrinter(json),
    )
    return finishTask(result, json)
  } catch (error) {
    return reportError(error)
  }
}

/**
 * `minidsh resume <id>` / `minidsh fork <id>` — interactive by default;
 * `--headless` (task required) is the scripted one-shot.
 */
async function continueCommand(args: ParsedArgs, kind: 'resume' | 'fork'): Promise<number> {
  const id = args.positional[0]
  const task = args.positional.slice(1).join(' ').trim()
  const headless = args.flags.get('headless') === true
  if (!id || (headless && task.length === 0)) {
    return usage(
      `usage: minidsh ${kind} <id> ["<task>"]${kind === 'fork' ? ' [--at seq]' : ''} [--headless] [--provider id] [--model id] [--effort id] [--max-steps n] [--approve] [--json]`,
    )
  }
  const atRaw = args.flags.get('at')
  const boundary = typeof atRaw === 'string' ? Number(atRaw) : undefined
  // A typo'd --at must not silently fork at the log head.
  if (atRaw !== undefined && (typeof atRaw !== 'string' || atRaw.trim() === '' || !Number.isInteger(boundary))) {
    return usage(`--at expects an integer event seq, got "${String(atRaw)}"`)
  }
  const plan = await prepareBoot(args, headless ? 'headless' : 'interactive')
  if (typeof plan === 'string') return usage(plan)
  const approve = args.flags.get('approve') === true
  const at = kind === 'fork' && boundary !== undefined && !Number.isNaN(boundary) ? { boundary } : {}

  if (!headless) {
    try {
      return await runTerminal({
        cwd: process.cwd(),
        ...bootFields(plan),
        ...(plan.agentSetup === undefined ? {} : { agentSetup: plan.agentSetup }),
        approve,
        ...(kind === 'resume' ? { resumeId: id } : { forkId: id }),
        ...at,
        ...(task.length > 0 ? { task } : {}),
        ...modelFlags(args),
      })
    } catch (error) {
      return reportError(error)
    }
  }

  const json = args.flags.get('json') === true
  const options: ContinueOptions = {
    id,
    task,
    ...bootFields(plan),
    ...(plan.preset === undefined ? {} : { preset: plan.preset }),
    ...(plan.agentSetup === undefined ? {} : { setup: plan.agentSetup }),
    ...modelFlags(args),
    ...at,
    approve,
  }
  try {
    const result = kind === 'resume' ? await resumeTask(options, eventPrinter(json)) : await forkTask(options, eventPrinter(json))
    return finishTask(result, json)
  } catch (error) {
    return reportError(error)
  }
}

/** `minidsh chat` — a fresh interactive session over the protocol. */
async function chatCommand(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim()
  const plan = await prepareBoot(args, 'interactive')
  if (typeof plan === 'string') return usage(plan)
  try {
    return await runTerminal({
      cwd: cwdFlag(args),
      ...bootFields(plan),
      ...(plan.agentSetup === undefined ? {} : { agentSetup: plan.agentSetup }),
      approve: args.flags.get('approve') === true,
      ...(task.length > 0 ? { task } : {}),
      ...modelFlags(args),
    })
  } catch (error) {
    return reportError(error)
  }
}

/** `minidsh serve` — the JSON-RPC protocol on process stdio; stdout carries only frames. */
async function serveCommand(args: ParsedArgs): Promise<number> {
  const plan = await prepareBoot(args, 'none')
  if (typeof plan === 'string') return usage(plan)
  try {
    const host = await startProtocolHost({
      cwd: cwdFlag(args),
      ...bootFields(plan),
      ...(plan.agentSetup === undefined ? {} : { agentSetup: plan.agentSetup }),
      approve: args.flags.get('approve') === true,
    })
    await host.closed
    await host.dispose()
    return 0
  } catch (error) {
    return reportError(error)
  }
}

/**
 * Built-in rows a config layer can widen authority or blind the runtime
 * through — including the effect boundaries themselves: the fence lives in
 * the fs provider and the refusal in the shell provider, so replacing either
 * row with a module-loaded provider is replacing the boundary.
 */
const AUTHORITY_SENSITIVE = new Set([
  'sandbox',
  'approval',
  'approval-headless',
  'authority-presets',
  'invariants',
  'session-invariant',
  'authority-invariant',
  'agent-invariant',
  'loop-invariant',
  'fs',
  'shell',
  'tool-shell',
  'tool-editor',
  'spill',
])

/**
 * The same check by CAPABILITY, because a layer's `insert` picks its own row
 * id: an inserted `approval-headless {approve: true}` answers every escalation
 * for the whole deployment, and keying on id alone would print it as an
 * ordinary row. Configuration may do this — it is the deployment — but never
 * silently.
 */
const AUTHORITY_SENSITIVE_PLUGINS = new Set([
  'core-sandbox',
  'core-approval',
  'approval-headless',
  'authority-presets',
  'core-invariants',
  'core-session-invariant',
  'core-authority-invariant',
  'core-agent-invariant',
  'core-agent-loop-invariant',
  'composition-record',
  'fs-local',
  'shell-stdio',
  'tool-shell',
  'tool-editor',
  'spill-local',
])

/**
 * `minidsh config` — the EFFECTIVE composition: the same base and layer
 * algorithm a boot uses, with per-row provenance. The rows that would actually
 * mount, not a pristine default.
 */
async function configCommand(args: ParsedArgs): Promise<number> {
  const plan = await prepareBoot(args, 'none')
  if (typeof plan === 'string') return usage(plan)
  try {
    const effective = applyLayers(baseRows(plan.home, plan.authority), plan.loaded.layers, (message) => process.stderr.write(`warn: ${message}\n`))
    const touched = (id: string): string => effective.provenance.get(id) ?? 'built-in'
    if (args.flags.get('json') === true) {
      const rows = effective.rows.map((row) => {
        let invalidConfig: string | undefined
        if (row.disabled !== true && row.plugin.config) {
          try {
            row.plugin.config.parse(row.config)
          } catch (error) {
            invalidConfig = describeConfigError(error)
          }
        }
        return {
          id: row.id,
          plugin: row.plugin.name,
          ...(row.disabled === true ? { disabled: true } : {}),
          layer: touched(row.id),
          ...(invalidConfig === undefined ? {} : { invalidConfig }),
        }
      })
      const agentPresets = [...plan.loaded.agentPresets].map(([name, spec]) => ({ name, rows: spec.rows.map((row) => ({ id: row.id, plugin: row.plugin })) }))
      process.stdout.write(
        `${JSON.stringify({ hash: effective.descriptor.hash, layers: effective.descriptor.layers, agentDefaults: plan.settings.agent, rows, agentPresets }, null, 2)}\n`,
      )
      return rows.some((row) => row.invalidConfig !== undefined) ? 1 : 0
    }
    process.stdout.write(`composition ${effective.descriptor.hash} (layers: ${effective.descriptor.layers.join(' → ')})\n`)
    process.stdout.write(`agent defaults: ${plan.settings.agent.provider}/${plan.settings.agent.model}\n\n`)
    const warnings: string[] = []
    // What a boot would refuse, this command must refuse too: every enabled
    // row's config is parsed against the plugin's contract, exactly as load does.
    const invalid: string[] = []
    for (const row of effective.rows) {
      if (row.disabled === true || !row.plugin.config) continue
      try {
        row.plugin.config.parse(row.config)
      } catch (error) {
        invalid.push(`row "${row.id}" (${row.plugin.name}): invalid config: ${describeConfigError(error)}`)
      }
    }
    for (const row of effective.rows) {
      const layer = touched(row.id)
      const sensitive = layer !== 'built-in' && (AUTHORITY_SENSITIVE.has(row.id) || AUTHORITY_SENSITIVE_PLUGINS.has(row.plugin.name))
      const marks = [row.disabled === true ? 'disabled' : undefined, sensitive ? '!' : undefined].filter((mark) => mark !== undefined)
      process.stdout.write(`  ${row.id.padEnd(22)} ${row.plugin.name.padEnd(28)} ${layer}${marks.length > 0 ? `  [${marks.join(' ')}]` : ''}\n`)
      if (sensitive) {
        // A built-in row a layer touched was modified (or disabled); a row the
        // layer brought in was added.
        const verb = row.disabled === true ? 'DISABLED' : AUTHORITY_SENSITIVE.has(row.id) ? 'modified' : 'added'
        warnings.push(`layer "${layer}" ${verb} authority-sensitive row "${row.id}" (${row.plugin.name})`)
      }
    }
    // Agent presets are composition too: they mount plugins into an agent's world.
    if (plan.loaded.agentPresets.size > 0) {
      process.stdout.write(`\nagent presets:\n`)
      for (const [name, spec] of plan.loaded.agentPresets) {
        process.stdout.write(`  ${name.padEnd(22)} ${spec.rows.map((row) => `${row.id}(${row.plugin})`).join(', ')}\n`)
      }
    }
    for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`)
    for (const line of invalid) process.stderr.write(`error: ${line}\n`)
    return invalid.length > 0 ? 1 : 0
  } catch (error) {
    return reportError(error)
  }
}

/**
 * Mounts the persistence provider on a bare root and hands its Definition to
 * `use`. The row comes from the EFFECTIVE composition, so `sessions list/show`
 * read exactly where `run`/`resume` write — a layer that repoints the store
 * must not split the CLI's read path from its write path.
 */
async function withPersistence<T>(plan: BootPlan, use: (persistence: Persistence) => T): Promise<T> {
  const effective = applyLayers(baseRows(plan.home), plan.loaded.layers, (message) => stderrLogger.warn(message))
  const row = effective.rows.find((entry) => entry.plugin.name === 'persistence-jsonl' && entry.disabled !== true)
  const root = createRoot({ logger: stderrLogger })
  if (row) root.plugin(row.plugin, row.config)
  else root.plugin(persistenceJsonlPlugin, { root: plan.home.sessionsRoot })
  await root.settle()
  try {
    return use(root.get(PERSISTENCE))
  } finally {
    await root.dispose()
  }
}

async function sessionsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0]
  const plan = await prepareBoot(args, 'none', 'optional')
  if (typeof plan === 'string') return usage(plan)
  if (sub === 'list') {
    return withPersistence(plan, (persistence) => {
      for (const header of persistence.list()) {
        process.stdout.write(`${header.id}\t${new Date(header.createdAt).toISOString()}\t${header.cwd}\n`)
      }
      return 0
    })
  }
  if (sub === 'show') {
    const id = args.positional[1]
    if (!id) return usage('usage: minidsh sessions show <id> [--json|--audit]')
    return withPersistence(plan, (persistence) => {
      const stored = persistence.load(id)
      if (!stored) {
        process.stderr.write(`no session "${id}"\n`)
        return 1
      }
      if (args.flags.get('audit') === true) {
        process.stdout.write(`authority of ${stored.header.id} (cwd ${stored.header.cwd})\n`)
        for (const line of auditLines(stored.events)) process.stdout.write(`${line}\n`)
      } else if (args.flags.get('json') === true) {
        for (const event of stored.events) process.stdout.write(`${JSON.stringify({ sessionId: stored.header.id, event })}\n`)
        // Machine readers must see damage too: a trailer object (no `event` field) a frame consumer skips.
        if (stored.damaged) process.stdout.write(`${JSON.stringify({ sessionId: stored.header.id, damaged: true })}\n`)
      } else {
        process.stdout.write(`session ${stored.header.id} (cwd ${stored.header.cwd})\n`)
        // What this session cost and how full its context got, measured
        // against the window the log itself names for the route in use; a log
        // from before `request/context` existed prints the numbers alone.
        const window = foldRequestContext(stored.events)?.contextWindow ?? 0
        const metrics = meterSession(stored.events, window)
        if (metrics.sessionInput + metrics.sessionOutput + metrics.sessionCacheRead > 0) {
          const ratio = window > 0 ? ` (${Math.round(metrics.ratio * 100)}% of ${formatTokens(window)})` : ''
          process.stdout.write(
            `usage: ${formatTokens(metrics.sessionInput)} in · ${formatTokens(metrics.sessionCacheRead)} cached · ` +
              `${formatTokens(metrics.sessionOutput)} out · context now ~${formatTokens(metrics.projectedTokens)}${ratio}\n`,
          )
        }
        for (const event of stored.events) {
          const line = describeEvent(event)
          process.stdout.write(`${String(event.seq).padStart(4)}  ${event.type}${line ? ` ${line}` : ''}\n`)
        }
        if (stored.damaged) process.stderr.write('warning: the stored log is damaged beyond this point\n')
      }
      return 0
    })
  }
  return usage('usage: minidsh sessions <list|show>')
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  switch (args.command) {
    case 'run':
      return runCommand(args)
    case 'chat':
      return chatCommand(args)
    case 'resume':
      return continueCommand(args, 'resume')
    case 'fork':
      return continueCommand(args, 'fork')
    case 'serve':
      return serveCommand(args)
    case 'config':
      return configCommand(args)
    case 'sessions':
      return sessionsCommand(args)
    default:
      process.stdout.write(
        'MiniDSH — usage:\n' +
          '  minidsh run "<task>" [--cwd dir] [--provider id] [--model id] [--effort id] [--max-steps n] [--sandbox mode] [--ask ask|never] [--preset name] [--agent-preset name] [--approve] [--json]\n' +
          '  minidsh chat ["<task>"] [--cwd dir] [--provider id] [--model id] [--effort id] [--sandbox mode] [--ask ask|never] [--agent-preset name] [--approve]\n' +
          '  minidsh resume <id> ["<task>"] [--headless] [--provider id] [--model id] [--effort id] [--max-steps n] [--preset name] [--agent-preset name] [--approve] [--json]\n' +
          '  minidsh fork <id> ["<task>"] [--at seq] [--headless] [--provider id] [--model id] [--effort id] [--max-steps n] [--preset name] [--agent-preset name] [--approve] [--json]\n' +
          '  minidsh serve [--cwd dir] [--sandbox mode] [--ask ask|never] [--agent-preset name] [--approve]\n' +
          '  minidsh config [--json]\n' +
          '  minidsh sessions list\n' +
          '  minidsh sessions show <id> [--json|--audit]\n' +
          '\nconfig:    ~/.minidsh/composition.json + settings.json layer over the built-ins;\n' +
          '           --patch <file> (repeatable) layers after them on any command\n' +
          'authority: --sandbox read-only|workspace-write|danger-full-access (default workspace-write)\n' +
          '           --ask ask|never; --approve grants every request in a headless run\n',
      )
      return args.command === 'help' ? 0 : 2
  }
}
