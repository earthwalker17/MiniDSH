/**
 * The `minidsh` command line: argv to one command, and the process's exit
 * code. It is the headless surface itself (`run`, `resume --headless`,
 * `fork --headless`: rendered exclusively from `session/event`, driven only
 * through `ctx.agents`/`ctx.sessions` by the runner in `headless.ts`) and the
 * launcher of the others — the terminal (`chat`, an interactive `resume` or
 * `fork`), `serve` and `web`, which are protocol hosts with their own modules
 * — plus the commands that open no session (`config`, `sessions`, `skills`,
 * `credentials`).
 *
 * A headless command exits 0 iff the turn it drove completed; every command
 * exits 2 on a usage failure (a malformed or unlisted flag, a bad settings or
 * composition file), never starting a paid run on one. `--json` streams raw
 * session events to stdout; `sessions show` reads the log only.
 *
 * Every command plans its boot through ONE preamble (`planBoot`; `prepareBoot`
 * is the same plan with a refusal flattened to its message, and `web` calls
 * `planBoot` itself because its supervisor is owed the refusal's code):
 * flags, settings, the disk layers, the preset and agent-preset flags — so
 * `config`, `--preset` validation and `sessions` compose the exact rows a
 * boot would mount, not an approximation of them.
 */
import { createRoot, describeConfigError, type Logger } from '../kernel/index.ts'
import { formatTokens, meterSession } from '../core/metering/index.ts'
import { foldRequestContext, foldRequestHeader, foldSessionTitle, matches, SessionFormatError, TOOL_RESULT, TURN_END, TURN_START, USER_MESSAGE, type EventEnvelope } from '../core/session/index.ts'
import { heldByWriter, PERSISTENCE, type Persistence, type StoredSession } from '../core/persistence/index.ts'
import { foldAgentOptions, repairTail, type AgentOptions } from '../core/agent/index.ts'
import { LLM } from '../core/llm/index.ts'
import { persistenceJsonlPlugin, unreadableHeader } from '../capabilities/persistence-jsonl/index.ts'
import { APPROVAL_POLICIES, isApprovalPolicy, type ApprovalPolicy } from '../core/approval/index.ts'
import { isSandboxMode, SANDBOX_MODES, type SandboxEnforcement, type SandboxMode } from '../core/sandbox/index.ts'
import { constants as osConstants } from 'node:os'
import { fstatSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { canonicalPath, isInside } from '../core/sandbox/paths.ts'
import { CREDENTIALS, credentialRef, isHeaderSafe, type CredentialRef } from '../core/credentials/index.ts'
import { credentialSources, credentialsLocalPlugin, updateCredentialStore } from '../capabilities/credentials-local/index.ts'
import { presetTable } from '../core/presets/index.ts'
import type { AuthorityPresetsConfig } from '../capabilities/authority-presets/index.ts'
import type { Context } from '../kernel/index.ts'
import { FS } from '../core/fs/index.ts'
import { sandboxPlugin } from '../core/sandbox/index.ts'
import { fsLocalPlugin } from '../capabilities/fs-local/index.ts'
import { discoverSkills, fitSkillList, oneLine, skillsPlugin, type SkillDiscovery, type SkillsConfig } from '../capabilities/skills/index.ts'
import { builtinPlugins, compose, defaultDialect, type Row } from './compose.ts'
import {
  agentPresetWorld,
  applyLayers,
  loadCompositionFile,
  toPatches,
  toRow,
  withDeployment,
  type DiskRow,
  type EffectiveComposition,
  type NamedLayer,
} from './config.ts'
import { bootComposition, forkTask, resumeTask, runTask, type ContinueOptions, type EventListener, type TaskResult } from './headless.ts'
import { compositionPath, homeLayout, resolveHome, settingsPath, type HomeLayout } from './home.ts'
import { ATTACHMENTS, type Attachments } from '../core/attachments/index.ts'
import { collectImageRefs } from '../core/llm/content.ts'
import { printableLines, printableText } from '../core/text.ts'
import { auditLines, CallNames, describeEvent } from './present.ts'
import { inspectLines, inspectStored, verdictExitCode, verifyAttachments, verifyLines, verifyStored } from './inspect.ts'
import { resolveSettings, type ResolvedSettings } from './settings.ts'
import { startProtocolHost } from './serve.ts'
import { startWebHost, type WebHostHandle } from './web.ts'
import { runTerminal } from './terminal/index.ts'
import { VERSION } from './version.ts'

interface ParsedArgs {
  readonly command: string
  /** The command whose usage `help` should print, when `--help`/`-h` followed one. */
  readonly helpFor?: string
  readonly positional: string[]
  readonly flags: Map<string, string | true>
  /** `--patch <file>` is repeatable; the flags map is last-wins, so it collects here. */
  readonly patchFiles: string[]
  /** `--workspace <dir>` is repeatable too, and collects here as well as in the flags map (`parseArgs`). */
  readonly workspaceDirs: string[]
}

/**
 * Every flag the CLI knows, spelled as the help shows it. A flag whose spelling
 * carries an argument takes a value; the rest are switches. `--patch <file>` is
 * accepted by every command and handled by the parser on its own.
 */
const FLAGS = {
  cwd: '--cwd dir',
  provider: '--provider id',
  model: '--model id',
  effort: '--effort id',
  'max-steps': '--max-steps n',
  at: '--at seq',
  sandbox: '--sandbox mode',
  ask: '--ask ask|never',
  accept: '--accept full|none',
  preset: '--preset name',
  'agent-preset': '--agent-preset name',
  port: '--port n',
  host: '--host addr',
  workspace: '--workspace dir',
  patch: '--patch file',
  approve: '--approve',
  json: '--json',
  headless: '--headless',
  audit: '--audit',
  salvage: '--salvage',
  plain: '--plain',
} as const
type FlagName = keyof typeof FLAGS
const VALUE_FLAGS = new Set<string>((Object.keys(FLAGS) as FlagName[]).filter((name) => FLAGS[name].includes(' ')))

/** What each command takes, from which both its usage line and the general help are printed — one table, never two strings. */
const COMMANDS: Readonly<Record<string, { readonly positional: string; readonly flags: readonly FlagName[] }>> = {
  run: { positional: '"<task>"', flags: ['cwd', 'provider', 'model', 'effort', 'max-steps', 'sandbox', 'ask', 'accept', 'preset', 'agent-preset', 'approve', 'json'] },
  chat: { positional: '["<task>"]', flags: ['cwd', 'provider', 'model', 'effort', 'max-steps', 'sandbox', 'ask', 'accept', 'agent-preset', 'approve', 'plain'] },
  resume: { positional: '<id> ["<task>"]', flags: ['headless', 'provider', 'model', 'effort', 'max-steps', 'sandbox', 'ask', 'accept', 'preset', 'agent-preset', 'approve', 'json', 'plain'] },
  fork: { positional: '<id> ["<task>"]', flags: ['at', 'salvage', 'headless', 'provider', 'model', 'effort', 'max-steps', 'sandbox', 'ask', 'accept', 'preset', 'agent-preset', 'approve', 'json', 'plain'] },
  serve: { positional: '', flags: ['cwd', 'sandbox', 'ask', 'accept', 'agent-preset', 'approve'] },
  web: { positional: '', flags: ['cwd', 'workspace', 'port', 'host', 'sandbox', 'ask', 'accept', 'agent-preset', 'approve', 'json'] },
  config: { positional: '', flags: ['sandbox', 'ask', 'accept', 'json'] },
  sessions: { positional: 'list | show <id> | inspect <id> | verify <id>', flags: ['json', 'audit'] },
  skills: { positional: '', flags: ['cwd', 'json'] },
  credentials: { positional: 'list | set <NAME> | unset <NAME>', flags: ['json'] },
}

/**
 * `sessions` is four readers under one command, and a flag one of them does
 * not take is refused rather than ignored (`verify --audit` would otherwise
 * print a verdict and silently not the audit that was asked for).
 */
const SESSION_SUBCOMMANDS: Readonly<Record<string, readonly FlagName[]>> = {
  list: [],
  show: ['json', 'audit'],
  inspect: ['json'],
  verify: ['json'],
}

function usageFor(command: string): string {
  const spec = COMMANDS[command]!
  const flags = spec.flags.map((name) => `[${FLAGS[name]}]`).join(' ')
  return `minidsh ${command}${spec.positional ? ` ${spec.positional}` : ''}${flags ? ` ${flags}` : ''}`
}

const isHelp = (token: string | undefined): boolean => token === '--help' || token === '-h'
const isVersion = (token: string | undefined): boolean => token === '--version' || token === '-v'

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const patchFiles: string[] = []
  const workspaceDirs: string[] = []
  const first = argv[0]
  // `--version`/`-v` and `--help`/`-h` ANYWHERE make this that command, never
  // a usage error: `minidsh run -h` used to start a paid run whose task was
  // "-h", and `--version` on a command that does not list it would otherwise
  // be refused as an unlisted flag. Version is checked first, so it wins when
  // both are given.
  if (argv.some(isVersion)) return { command: 'version', positional, flags, patchFiles, workspaceDirs }
  if (first === undefined || argv.some(isHelp)) {
    const helpFor = first !== undefined && !isHelp(first) && first in COMMANDS ? first : undefined
    return { command: 'help', ...(helpFor === undefined ? {} : { helpFor }), positional, flags, patchFiles, workspaceDirs }
  }
  const command = first
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (name === 'patch') patchFiles.push(argv[++i] ?? '')
      else if (VALUE_FLAGS.has(name)) {
        const value = argv[++i] ?? ''
        flags.set(name, value)
        // Repeatable like --patch, and ALSO in the flags map: --patch is every
        // command's, --workspace is web's alone, so a command that does not
        // list it has to see it to refuse it.
        if (name === 'workspace') workspaceDirs.push(value)
      } else flags.set(name, true)
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags, patchFiles, workspaceDirs }
}

/**
 * A warning is said once per command (`main` clears this). One fact can reach
 * this logger twice on the way through a single command: the boot-time
 * settings read and the runtime store both report an empty settings.json, in
 * the same words on purpose, and a cold read before a boot (`fork --at`,
 * `fork --salvage`) prints the layer warnings the boot then prints again.
 */
const warned = new Set<string>()

const stderrLogger: Logger = {
  warn: (message) => {
    if (warned.has(message)) return
    warned.add(message)
    process.stderr.write(`warn: ${message}\n`)
  },
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
  readonly accepts?: SandboxEnforcement
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
  /**
   * The rows a boot would mount, layered once here so `--preset` validation,
   * `config` and `sessions` read the same composition a boot does. A command
   * that boots lets `bootComposition` print the layer warnings; one that does
   * not prints `warnings` itself.
   */
  readonly effective: EffectiveComposition
  /** Ids of the built-in rows, so a touched row can be told from an inserted one. */
  readonly baseIds: ReadonlySet<string>
  readonly warnings: readonly string[]
  /** `--preset`, validated against the effective presets row (headless commands only). */
  readonly preset?: string
  /** `--agent-preset`, resolved to a setup for the agent scope. */
  readonly agentWorld?: (agentCtx: Context) => void
  /** The name that setup came from, recorded in each session's header. */
  readonly agentPreset?: string
}

/** How a command treats `--preset`: applied as a durable switch, refused in favour of `/preset`, or not a flag at all. */
type PresetUse = 'headless' | 'interactive' | 'none'

/**
 * A flag a command does not list is refused, not ignored: `resume <id> --at 12`
 * used to resume at the log head with no message, and `chat --json` printed a
 * terminal. `--patch` is every command's. The table that prints the usage is
 * the table that decides.
 */
function refuseUnknownFlags(args: ParsedArgs): string | undefined {
  const spec = COMMANDS[args.command]
  if (!spec) return undefined
  for (const name of args.flags.keys()) {
    if (!(spec.flags as readonly string[]).includes(name)) return `--${name} is not a flag of "${args.command}"`
  }
  return undefined
}

/**
 * Flags a known name is not enough for: their VALUE can be wrong in a way that
 * would otherwise be dropped in silence, and the drop is expensive. A `--cwd`
 * naming nothing booted and durably recorded a session whose workspace root no
 * tool can act on; a `--max-steps abc` started a paid run under the DEFAULT
 * ceiling, the same typo `--at` and `--port` already refuse. The wire refuses
 * both of these (`"cwd" is not an existing directory`, `"maxSteps" must be a
 * positive integer`) — the CLI is the same runtime behind a different carrier,
 * so it refuses them in the same words.
 */
function refuseMalformedFlags(args: ParsedArgs): string | undefined {
  const cwd = args.flags.get('cwd')
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd.trim() === '') return '--cwd takes a directory'
    const root = resolve(cwd)
    if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) return `--cwd is not an existing directory: ${root}`
  }
  const maxSteps = args.flags.get('max-steps')
  if (maxSteps !== undefined) {
    const value = typeof maxSteps === 'string' ? Number(maxSteps) : Number.NaN
    if (!Number.isInteger(value) || value <= 0) return `--max-steps expects a positive integer, got "${String(maxSteps)}"`
  }
  // A value flag at the end of the line parses as the empty string, and an
  // empty id is not "no flag": `run "x" --model` recorded a session routed to
  // the model "", which no provider has.
  for (const name of ['provider', 'model', 'effort'] as const) {
    const value = args.flags.get(name)
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) return `--${name} expects ${name === 'effort' ? 'an effort' : `a ${name}`} id`
  }
  return undefined
}

/** The boot options every app entry shares, from one plan. */
function bootFields(plan: BootPlan): {
  sessionsRoot: string
  spillRoot: string
  attachmentsRoot: string
  browserProfileRoot: string
  globalInstructionsPath: string
  credentialsPath: string
  settingsStorePath: string
  skillRoots: HomeLayout['skillRoots']
  agentDefaults: ResolvedSettings['agent']
  agentSettingsBase: ResolvedSettings['agentBase']
  agentOverrides: ResolvedSettings['agentOverrides']
  configLayers: NamedLayer[]
  logger: Logger
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  accepts?: SandboxEnforcement
} {
  return { ...plan.home, agentDefaults: plan.settings.agent, agentSettingsBase: plan.settings.agentBase, agentOverrides: plan.settings.agentOverrides, configLayers: plan.loaded.layers, logger: stderrLogger, ...plan.authority }
}

/**
 * The rows a boot would mount from the built-ins alone — the base every
 * layered view starts from. `approve` travels as the boot passes it (`false`
 * for no flag), so this base is the boot's row for row.
 */
function baseRows(home: HomeLayout, authority: AuthorityFlags, approve: boolean): Row[] {
  return compose({ ...home, dialect: defaultDialect(), ...authority, approve })
}

/**
 * Why a command was refused before anything booted: its own flags (`USAGE`), or
 * a file a boot reads — settings, a composition layer, a `--patch` (`CONFIG`).
 * Both exit 2; the split is for a supervisor reading `web --json`, which must
 * tell "my argv is wrong" from "the user's config is broken".
 */
interface BootRefusal {
  readonly refused: 'USAGE' | 'CONFIG'
  readonly message: string
}

/**
 * `settings: 'optional'` is for commands that only read stored logs: a broken
 * settings.json must not stand between a user and `sessions show --audit`.
 */
async function prepareBoot(args: ParsedArgs, presets: PresetUse, settingsUse: 'required' | 'optional' = 'required'): Promise<BootPlan | string> {
  const plan = await planBoot(args, presets, settingsUse)
  return 'refused' in plan ? plan.message : plan
}

async function planBoot(args: ParsedArgs, presets: PresetUse, settingsUse: 'required' | 'optional' = 'required'): Promise<BootPlan | BootRefusal> {
  const usageError = (message: string): BootRefusal => ({ refused: 'USAGE', message })
  const configError = (message: string): BootRefusal => ({ refused: 'CONFIG', message })
  const unknown = refuseUnknownFlags(args)
  if (unknown !== undefined) return usageError(unknown)
  const malformed = refuseMalformedFlags(args)
  if (malformed !== undefined) return usageError(malformed)
  const authority = authorityFlags(args)
  if (typeof authority === 'string') return usageError(authority)
  const loadedSettings = loadSettings()
  if (typeof loadedSettings === 'string' && settingsUse === 'required') return configError(loadedSettings)
  if (typeof loadedSettings === 'string') stderrLogger.warn(loadedSettings)
  const settings = typeof loadedSettings === 'string' ? resolveSettings() : loadedSettings
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') return configError(loaded)
  const home = homeLayout()
  // Layered ONCE: every later reader of the effective composition — `--preset`
  // validation, `config`, `sessions` — reads this, so none can disagree.
  const approve = args.flags.get('approve') === true
  const base = baseRows(home, authority, approve)
  const warnings: string[] = []
  let effective: EffectiveComposition
  try {
    // The deployment's paths and the explicit authority flags applied after
    // the layers exactly as `bootComposition` applies them, so `config`
    // prints the rows and the hash a session records, `skills` reads the
    // roots a session is offered from, and a flag that took a key from a
    // layer is said here for a command that boots nothing.
    const warn = (message: string): void => void warnings.push(message)
    effective = withDeployment(
      applyLayers(base, loaded.layers, warn),
      {
        skillRoots: home.skillRoots,
        globalInstructionsPath: home.globalInstructionsPath,
        installRoots: home.installRoots,
        flags: { sandbox: authority.sandbox, accepts: authority.accepts, approvalPolicy: authority.approvalPolicy, approve },
      },
      warn,
    )
  } catch (error) {
    return configError(error instanceof Error ? error.message : String(error))
  }
  // A command that cannot apply a preset says so before it looks one up.
  if (args.flags.get('preset') !== undefined && presets === 'none') return usageError(`--preset is not a flag of "${args.command}"`)
  const preset = presetFlag(args, authority, effective)
  if (typeof preset === 'object') return usageError(preset.error)
  if (preset !== undefined && presets === 'interactive') return usageError('--preset works with --headless; in the interactive terminal use /preset')
  const agentWorld = await agentPresetFlag(args, loaded)
  if (typeof agentWorld === 'object') return { refused: agentWorld.refused, message: agentWorld.error }
  return {
    home,
    settings,
    loaded,
    authority,
    effective,
    baseIds: new Set(base.map((row) => row.id)),
    warnings,
    ...(preset === undefined ? {} : { preset }),
    ...(agentWorld === undefined ? {} : { agentWorld }),
    ...(typeof args.flags.get('agent-preset') === 'string' ? { agentPreset: args.flags.get('agent-preset') as string } : {}),
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
  const accept = args.flags.get('accept')
  // `partial` is not offered: no shipped backend reports it, so a flag value
  // no run could exercise would be a promise with nothing behind it.
  if (accept !== undefined && accept !== 'full' && accept !== 'none') return `--accept expects full | none, got "${String(accept)}"`
  return {
    ...(isSandboxMode(sandbox) ? { sandbox } : {}),
    ...(isApprovalPolicy(ask) ? { approvalPolicy: ask } : {}),
    ...(accept === 'full' || accept === 'none' ? { accepts: accept } : {}),
  }
}

/**
 * Settings resolve once per command; a malformed file is a usage-class failure
 * (exit 2), never silently ignored. An EMPTY one is read as no settings and
 * said on stderr (`settings.ts` `readSettingsFile`).
 */
function loadSettings(): ResolvedSettings | string {
  try {
    return resolveSettings({ path: settingsPath(), warn: stderrLogger.warn })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The disk layers, in fixed order: home composition.json, then each `--patch`
 * file. A missing home file is absent; a missing `--patch` file is a usage
 * error — someone asked for it by name — and either one that is there and
 * cannot be read or parsed stops the command in the loader's own words
 * (`loadCompositionFile`), never read as absent.
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
      if (!file) return `--patch file not found: ${raw}`
      layers.push({ name: `patch:${raw}`, patches: await toPatches(file, dirname(path)) })
      collect(file, dirname(path))
    }
    return { layers, agentPresets }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * `--agent-preset`: a named per-agent row list from the config files, resolved
 * to a setup for the agent scope. A name that is not there is the flag's
 * fault; a preset that is there and cannot be resolved is the file's.
 */
async function agentPresetFlag(
  args: ParsedArgs,
  loaded: LoadedConfig,
): Promise<((agentCtx: Context) => void) | { error: string; refused: BootRefusal['refused'] } | undefined> {
  const raw = args.flags.get('agent-preset')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return { error: '--agent-preset expects a preset name', refused: 'USAGE' }
  const spec = loaded.agentPresets.get(raw)
  if (!spec) {
    const known = [...loaded.agentPresets.keys()]
    return { error: `unknown agent preset "${raw}"${known.length > 0 ? ` (known: ${known.join(', ')})` : ' (no agentPresets configured)'}`, refused: 'USAGE' }
  }
  try {
    const rows: Row[] = []
    for (const row of spec.rows) rows.push(await toRow(row, spec.baseDir))
    return agentPresetWorld(rows)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), refused: 'CONFIG' }
  }
}

/**
 * `--preset`: exclusive with `--sandbox`/`--ask`, and validated pre-boot
 * against the EFFECTIVE presets row (a disk layer may have reconfigured the
 * table) — a typo boots nothing and litters no session file. Returns the
 * validated name, an error, or undefined when the flag is absent.
 */
function presetFlag(args: ParsedArgs, authority: AuthorityFlags, effective: EffectiveComposition): string | { error: string } | undefined {
  const raw = args.flags.get('preset')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return { error: '--preset expects a preset name' }
  if (authority.sandbox !== undefined || authority.approvalPolicy !== undefined) {
    return { error: '--preset replaces --sandbox/--ask; give one or the other' }
  }
  try {
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
  if (json) return (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
  // Parallel children's lines interleave with each other and the parent's
  // (S21), and a line no longer says whose it is by where it falls: every
  // session after the first this run printed is tagged with its id's tail.
  let root: string | undefined
  const names = new Map<string, CallNames>()
  return (frame) => {
    const own = names.get(frame.sessionId) ?? new CallNames()
    names.set(frame.sessionId, own)
    const line = describeEvent(frame.event, own)
    if (!line) return
    root ??= frame.sessionId
    const tag = frame.sessionId === root ? '' : `[${printableText(String(frame.sessionId).slice(-6))}] `
    process.stderr.write(`  ${tag}${line}\n`)
  }
}

function finishTask(result: TaskResult, json: boolean): number {
  // The answer is the model's text, and the one line of a headless run that
  // carried all of it reached the terminal raw: an ESC in it could repaint the
  // effect and denial lines printed above, or forge the `session:` line below
  // (§8). Its own lines and tabs are kept, so a piped answer is unchanged.
  if (!json) process.stdout.write(`${printableLines(result.text)}\n`)
  if (result.reason !== 'completed') process.stderr.write(`turn ended: ${result.reason}\n`)
  // Said, never folded into the exit code: the task's turn decides that, and a
  // job stopped at the end of a one-shot run is the rule working, not a failure.
  if (result.stoppedJobs > 0) process.stderr.write(`minidsh: ${result.stoppedJobs} background job(s) were still running when the run ended, and were stopped\n`)
  for (const note of result.notes) process.stderr.write(`minidsh: ${printableText(note)}\n`)
  process.stderr.write(`session: ${result.sessionId}\n`)
  return result.exitCode
}

/**
 * A refusal a command can only make once its composition has booted, and
 * makes before any session exists: still the command line's fault, so it
 * exits 2 like every other usage failure.
 */
class UsageRefusal extends Error {}

function reportError(error: unknown): number {
  if (error instanceof UsageRefusal) return usage(error.message)
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  return 1
}

/**
 * Refuses a route no request could be sent on. It is the boot's `prepare`:
 * the composition has settled, so the mounted providers and their catalogs
 * are known, and no session exists yet. `--provider anthropic` alone kept the
 * MODEL of the route it replaced (`anthropic/deepseek-flash`), and that, like
 * an unknown provider, failed only at the first paid step — after a session
 * had been stored for it, naming no id that would have worked.
 *
 * `over` is the route the flags are merged over: the settings' for a new
 * session, or the id of the stored session a continuation rebuilds its base
 * from (read only if the question arises). `whole` also holds the merged
 * provider to it, for `run`, which sends exactly one turn there. `envModel`
 * is the model `MINIDSH_MODEL` named for a new session, if it did. An unknown
 * MODEL is not refused: an adapter serves ids its catalog does not list, and
 * only the provider can say (`runNotes` then names the listed ones).
 */
function routeCheck(flags: CommonModelFlags, over: AgentOptions | { readonly stored: string }, whole: boolean, envModel?: string): (root: Context) => void {
  return (root) => {
    const llm = root.tryGet(LLM)
    if (!llm) return
    const catalog = llm.providers()
    const stored = 'stored' in over ? over.stored : undefined
    const settings = 'stored' in over ? undefined : over
    const provider = flags.provider ?? (whole ? settings?.provider : undefined)
    if (provider !== undefined && !llm.hasProvider(provider)) {
      throw new UsageRefusal(`no provider "${printableText(provider)}" is mounted; the mounted providers are: ${catalog.map((entry) => entry.id).join(', ')}`)
    }
    if (flags.provider === undefined || flags.model !== undefined) return
    // A model named by `MINIDSH_MODEL` is named: it outranks the settings file
    // for a new session (`settings.ts`), so `--provider X` beside it is a whole
    // route, and refusing it said the environment's model was "deepseek's".
    // Unless that model is plainly the provider's being left (the settings
    // provider lists it and the flag's does not): `MINIDSH_MODEL=deepseek-flash`
    // exported as a default, then `--provider anthropic`, is the mistake this
    // check exists for.
    if (settings !== undefined && envModel !== undefined) {
      const lists = (id: string): boolean => catalog.find((entry) => entry.id === id)?.models.some((model) => model.id === envModel) === true
      if (lists(flags.provider) || !lists(settings.provider)) return
    }
    const base = settings ?? storedRoute(root, stored!)
    if (base === undefined || base.provider === flags.provider) return
    const listed = catalog.find((entry) => entry.id === flags.provider)?.models.map((model) => model.id) ?? []
    throw new UsageRefusal(
      `--provider ${flags.provider} needs --model: the model in use (${printableText(base.model)}) is ${printableText(base.provider)}'s. ${flags.provider} lists: ${listed.join(', ')}`,
    )
  }
}

/** The base route a continuation of `id` would rebuild (`agent/options`, or the request header of a log from before it); undefined when there is no such log to read. */
function storedRoute(root: Context, id: string): { provider: string; model: string } | undefined {
  try {
    const events = root.tryGet(PERSISTENCE)?.load(id)?.events
    return events === undefined ? undefined : (foldAgentOptions(events) ?? foldRequestHeader(events))
  } catch {
    // The continuation itself says what is wrong with the log.
    return undefined
  }
}

// ---- commands -----------------------------------------------------------------

async function runCommand(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim()
  if (task.length === 0) return usage(`usage: ${usageFor('run')}`)
  const plan = await prepareBoot(args, 'headless')
  if (typeof plan === 'string') return usage(plan)
  const json = args.flags.get('json') === true
  const flags = modelFlags(args)
  // From here on a reader that went away is no reason to stop (`quietStreams`).
  quietStreams()
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
        ...(plan.agentWorld === undefined ? {} : { world: plan.agentWorld }),
        ...(plan.agentPreset === undefined ? {} : { agentPreset: plan.agentPreset }),
        approve: args.flags.get('approve') === true,
        ...bootFields(plan),
        prepare: routeCheck(flags, plan.settings.agent, true, plan.settings.agentOverrides.model),
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
  if (!id || (headless && task.length === 0)) return usage(`usage: ${usageFor(kind)}`)
  // Listed for the headless shape only. The interactive branch below runs the
  // terminal and reads no `--json`, so accepting the flag there printed a
  // banner where a script expected frames — the exact class `chat --json`
  // was fixed for (refuseUnknownFlags): a flag a command cannot honour is
  // refused, never ignored.
  if (headless && args.flags.get('plain') === true) return usage(`--plain chooses the interactive terminal's line view; a headless ${kind} has no terminal view`)
  if (!headless && args.flags.get('json') === true) return usage(`--json streams the wire's frames from a headless ${kind}: add --headless "<task>" (the interactive terminal has no JSON stream)`)
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
  if (at.boundary !== undefined) {
    // "cannot fork inside an open turn" named no point that would work, and
    // finding one meant reading every row of `sessions show` for `turn/end`.
    const inside = await withPersistence(plan, (persistence) => forkPointRefusal(persistence, id, at.boundary))
    if (inside !== undefined) return usage(inside)
  }
  const prepare = routeCheck(modelFlags(args), { stored: id }, false)
  // From here on a reader that went away is no reason to stop (`quietStreams`).
  quietStreams()
  // Salvage is asked for by name: a fork never quietly continues a damaged log.
  const salvage = kind === 'fork' && args.flags.get('salvage') === true ? { salvage: true } : {}
  if (salvage.salvage === true) {
    // The fork's model is told about lost work only through a call that was
    // open where reading stopped; damage that fell between turns leaves it no
    // sign at all. The person asking for the salvage is told here instead.
    const note = await withPersistence(plan, (persistence) => salvageNote(persistence, id))
    if (note !== undefined) process.stderr.write(`${note}\n`)
  }

  if (!headless) {
    try {
      return await runTerminal({
        cwd: process.cwd(),
        ...bootFields(plan),
        ...(plan.agentWorld === undefined ? {} : { agentWorld: plan.agentWorld }),
        ...(plan.agentPreset === undefined ? {} : { agentPreset: plan.agentPreset }),
        approve,
        ...(kind === 'resume' ? { resumeId: id } : { forkId: id }),
        ...at,
        ...salvage,
        ...(task.length > 0 ? { task } : {}),
        ...(args.flags.get('plain') === true ? { plain: true } : {}),
        ...modelFlags(args),
        prepare,
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
    prepare,
    ...(plan.preset === undefined ? {} : { preset: plan.preset }),
    ...(plan.agentWorld === undefined ? {} : { world: plan.agentWorld }),
    ...(plan.agentPreset === undefined ? {} : { agentPreset: plan.agentPreset }),
    ...modelFlags(args),
    ...at,
    ...salvage,
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
  // From here on a reader that went away is no reason to stop (`quietStreams`).
  quietStreams()
  try {
    return await runTerminal({
      cwd: cwdFlag(args),
      ...bootFields(plan),
      ...(plan.agentWorld === undefined ? {} : { agentWorld: plan.agentWorld }),
      ...(plan.agentPreset === undefined ? {} : { agentPreset: plan.agentPreset }),
      approve: args.flags.get('approve') === true,
      ...(task.length > 0 ? { task } : {}),
      ...(args.flags.get('plain') === true ? { plain: true } : {}),
      ...modelFlags(args),
      // Only what the flags name: a settings route this composition cannot
      // serve is still a session a person can open and `/model` out of.
      prepare: routeCheck(modelFlags(args), plan.settings.agent, false, plan.settings.agentOverrides.model),
    })
  } catch (error) {
    return reportError(error)
  }
}

/** `minidsh serve` — the JSON-RPC protocol on process stdio; stdout carries only frames. */
async function serveCommand(args: ParsedArgs): Promise<number> {
  const plan = await prepareBoot(args, 'none')
  if (typeof plan === 'string') return usage(plan)
  // Stdout is the frame carrier here, so a client that died is a failed write
  // on the next frame — possibly one racing the end of stdin that starts the
  // disposal below. Stdin decides, as under `web --json` (`quietStreams`).
  quietStreams()
  try {
    const host = await startProtocolHost({
      cwd: cwdFlag(args),
      ...bootFields(plan),
      ...(plan.agentWorld === undefined ? {} : { agentWorld: plan.agentWorld }),
      ...(plan.agentPreset === undefined ? {} : { agentPreset: plan.agentPreset }),
      approve: args.flags.get('approve') === true,
    })
    await host.closed
    await host.dispose()
    return 0
  } catch (error) {
    return reportError(error)
  }
}

/** What a supervisor of `web --json` is told an exit before `ready` was: a code it can act on, never a parse of the words. */
type WebErrorCode = 'USAGE' | 'CONFIG' | 'EADDRINUSE' | 'EACCES' | 'WORKSPACE' | 'BOOT'

/**
 * `minidsh web` — the same protocol over a WebSocket, plus the browser client.
 *
 * It prints ONE url carrying a one-shot launch token, and binds loopback unless
 * `--host` says otherwise: this surface can write files and run commands, so
 * reaching it is a deliberate act. There is no per-user identity — many
 * windows, one principal, whoever ran this.
 *
 * `--json` is the PROCESS CONTRACT for a supervisor (the desktop app, a
 * service manager): stdout carries only JSON records, one per line — `ready`
 * once, with the launch token in it and nowhere else, or exactly one `error`
 * for every exit before it. Then the stop (`armStop`).
 */
async function webCommand(args: ParsedArgs): Promise<number> {
  const json = args.flags.get('json') === true
  // Until `ready`, a signal ends the process at once, as it always did, but
  // a supervisor is still owed its one record (armStop takes over after).
  const preReady = (signal: NodeJS.Signals): void => {
    if (json) process.stdout.write(`${JSON.stringify({ type: 'error', code: 'BOOT', message: `stopped by ${signal} before ready` })}\n`)
    process.exit(exitCodeFor(signal))
  }
  const signals = stopSignals()
  for (const signal of signals) process.on(signal, preReady)
  const unarm = (): void => {
    for (const signal of signals) process.off(signal, preReady)
  }
  // Refusals before anything booted exit 2, as every command's usage errors
  // do; a boot or a listen that failed exits 1, as it always has. The record
  // was written, so the signal handlers that owed one come off with it.
  const refuse = (code: WebErrorCode, message: string): number => {
    const before = code === 'USAGE' || code === 'CONFIG' || code === 'WORKSPACE'
    process.stderr.write(`${before ? '' : 'error: '}${message}\n`)
    if (json) process.stdout.write(`${JSON.stringify({ type: 'error', code, message })}\n`)
    unarm()
    return before ? 2 : 1
  }
  const plan = await planBoot(args, 'none')
  if ('refused' in plan) return refuse(plan.refused, plan.message)
  const port = args.flags.get('port')
  // In range too: 99999 passed the digits check and failed inside `listen` as
  // BOOT (exit 1), which tells a supervisor to retry what no retry can fix.
  if (port !== undefined && (typeof port !== 'string' || !/^\d+$/.test(port) || Number(port) > 65_535)) return refuse('USAGE', '--port takes a number from 0 to 65535')
  const host = args.flags.get('host')
  // An EMPTY address is the one that matters: the parser stores '' for a value
  // flag with nothing after it (`--host`, `--host "$UNSET"`), and `listen`
  // reads '' as every interface — the opposite of the loopback default.
  if (host !== undefined && (typeof host !== 'string' || host.trim() === '')) return refuse('USAGE', '--host takes an address')
  const where = webWorkspaces(args)
  if (typeof where === 'string') return refuse('WORKSPACE', where)
  let web: WebHostHandle
  try {
    web = await startWebHost({
      cwd: where.cwd,
      ...(where.roots === undefined ? {} : { workspaceRoots: where.roots }),
      ...bootFields(plan),
      ...(plan.agentWorld === undefined ? {} : { agentWorld: plan.agentWorld }),
      ...(plan.agentPreset === undefined ? {} : { agentPreset: plan.agentPreset }),
      approve: args.flags.get('approve') === true,
      ...(port === undefined ? {} : { port: Number(port) }),
      ...(host === undefined ? {} : { host }),
    })
  } catch (error) {
    // By errno, so a supervisor can pick another port on exactly the two
    // failures another port cures (Windows reserves whole port ranges for
    // Hyper-V and answers EACCES there, not EADDRINUSE).
    const errno = (error as NodeJS.ErrnoException | undefined)?.code
    return refuse(errno === 'EADDRINUSE' || errno === 'EACCES' ? errno : 'BOOT', error instanceof Error ? error.message : String(error))
  }
  if (json) {
    const url = new URL(web.url)
    const ready = { type: 'ready', host: url.hostname, port: web.port, token: url.searchParams.get('token'), version: VERSION, home: resolveHome(), workspaces: web.workspaces }
    process.stdout.write(`${JSON.stringify(ready)}\n`)
    // A supervised host's pipes close when its supervisor dies, and the bin's
    // EPIPE handler would then exit 0 on the next write: possibly one racing
    // the stdin end that starts the stop. Under --json, stdin decides.
    quietStreams()
  } else {
    process.stdout.write(`minidsh web — open this once:\n\n  ${web.url}\n\n`)
  }
  if (host !== undefined && host !== '127.0.0.1' && host !== 'localhost') {
    process.stderr.write(`warning: bound to ${host}; whoever reaches this url first drives an agent on this machine\n`)
  }
  unarm()
  armStop(web, json)
  await web.closed
  await web.dispose()
  return 0
}

/**
 * Where `web` lets sessions open. Without `--workspace` it is `--cwd` (or the
 * process's directory) alone, as before. With it, each must be an existing
 * directory, named canonically as the protocol names roots; `--cwd` defaults
 * to the first and otherwise must be one of them, since a default session
 * outside every root is one no client could have opened.
 *
 * A root that holds MiniDSH's home, or lies inside it, is refused: the home's
 * `composition.json` is code-equivalent trust (§9), its logs are the record,
 * and a workspace is where an agent writes. A bare `--cwd` is not held to
 * this, because it never was.
 */
function webWorkspaces(args: ParsedArgs): { cwd: string; roots?: string[] } | string {
  if (args.workspaceDirs.length === 0) return { cwd: cwdFlag(args) }
  const home = resolveHome()
  try {
    const canonicalHome = canonicalPath(home)
    const roots: string[] = []
    for (const dir of args.workspaceDirs) {
      if (dir.trim() === '') return '--workspace takes a directory'
      const absolute = resolve(dir)
      if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory() !== true) return `--workspace is not an existing directory: ${absolute}`
      const root = canonicalPath(absolute)
      // Without case on win32, where the filesystem has none: refusing a
      // spelling that only might be the home is the safe direction here.
      const [a, b] = process.platform === 'win32' ? [root.toLowerCase(), canonicalHome.toLowerCase()] : [root, canonicalHome]
      if (isInside(a, b) || isInside(b, a)) return `a workspace may not contain MiniDSH's home (${home}) or lie inside it: its composition.json is code-equivalent trust and its logs are the record`
      if (!roots.includes(root)) roots.push(root)
    }
    const cwd = args.flags.get('cwd')
    if (typeof cwd !== 'string') return { cwd: roots[0]!, roots }
    const chosen = canonicalPath(resolve(cwd))
    if (!roots.includes(chosen)) return `--cwd must be one of the --workspace roots (${roots.join(', ')}); got ${chosen}`
    return { cwd: chosen, roots }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The triggers of `web`'s graceful stop (`WebHostHandle.stop`). SIGINT,
 * SIGTERM, SIGHUP and (Windows) SIGBREAK in every mode; a second trigger exits
 * at once with 128 + that signal's number (130 for SIGINT, 143 for SIGTERM).
 * Under `--json` only, the end of stdin too — a supervisor's pipe, so its death or its deliberate `end()` stops this process — and only
 * when fd 0 IS such a stream. By exclusion, because Windows reports a Node
 * pipe as neither FIFO nor socket (measured: mode 0x1000, `isFIFO()` false):
 * a terminal, `/dev/null` or `NUL` (character devices), a file or a directory
 * never stop it, so `minidsh web --json </dev/null` under systemd runs. The
 * stdin trigger only ever STARTS a stop: a parent that signals and then dies
 * must not turn its own hang-up into the force.
 *
 * Exit is explicit (0 stopped, 1 a bound ran out), so a stray handle cannot
 * hold the process open after its runtime is gone.
 */
function armStop(web: WebHostHandle, json: boolean): void {
  let begun = false
  const begin = (why: string, force: boolean): void => {
    if (begun) {
      if (force) process.exit(exitCodeFor(why))
      return
    }
    begun = true
    // From here on a closed stdout or stderr is no reason to stop part way:
    // the bin's EPIPE handler exits 0 on the first failed write, and a
    // supervisor that died is the commonest reason to be stopping at all —
    // exiting mid-disposal is what would strand its leases and its turns.
    quietStreams()
    process.stderr.write(json ? `minidsh web: stopping (${why})\n` : 'minidsh web: stopping… (again to force)\n')
    void web.stop().then(
      (outcome) => process.exit(outcome === 'stopped' ? 0 : 1),
      () => process.exit(1),
    )
  }
  for (const signal of stopSignals()) process.on(signal, () => begin(signal, true))
  if (!json || !stdinIsAStream()) return
  let ended = false
  const onEnd = (): void => {
    if (ended) return
    ended = true
    begin('stdin closed', false)
  }
  process.stdin.on('data', () => undefined)
  process.stdin.on('end', onEnd)
  process.stdin.on('close', onEnd)
  // A parent that died can surface as a read error rather than an end.
  process.stdin.on('error', onEnd)
  process.stdin.resume()
}

/** The signals that stop `web`: SIGBREAK is Windows' Ctrl+Break. */
function stopSignals(): NodeJS.Signals[] {
  return ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? (['SIGBREAK'] as const) : [])]
}

/** The conventional status of a process a signal ended: 128 + its number (130 for SIGINT, 143 for SIGTERM). */
function exitCodeFor(signal: string): number {
  const number = (osConstants.signals as Record<string, number | undefined>)[signal]
  return number === undefined ? 1 : 128 + number
}

/**
 * A failed write to stdout or stderr is dropped, never a reason to exit.
 *
 * The bin exits 0 on the first EPIPE (`bin/minidsh.js`), which is right for a
 * command that only prints (`minidsh --help | head -1`) and wrong for one
 * that is running something: `run … | head -2` stopped in the middle of a
 * paid turn with status 0 — no `turn/end`, its lease left on disk, a job
 * still running — and `serve` could exit part way through its disposal. So
 * every command that drives or hosts a turn (`run`, `resume`, `fork`, `chat`,
 * `serve`, and `web` once it is ready) calls this before it starts: the turn
 * finishes, disposes, and the exit code is its own.
 */
function quietStreams(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.removeAllListeners('error')
    stream.on('error', () => undefined)
  }
}

/** fd 0 is something whose writer can hang up: not a character device, not a file, not a directory, and there at all. */
function stdinIsAStream(): boolean {
  try {
    const stat = fstatSync(0)
    return !stat.isCharacterDevice() && !stat.isFile() && !stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * The plugins a config layer can widen authority, blind the runtime or silence
 * the record through: the authority knobs and their answerers, the invariants,
 * the effect boundaries themselves (the fence lives in the fs provider and the
 * refusal in the shell provider, so replacing either row with a module-loaded
 * provider is replacing the boundary), the tools that reach them, the stores
 * whose replacement silences or reroutes the durable record (persistence,
 * spill), and the credential store, whose replacement runs loaded code on
 * every secret resolve. Keyed by CAPABILITY because a layer's `insert` picks
 * its own row id; the built-in ids need no second list, since every built-in
 * row's plugin is here. Configuration may do all of this — it is the
 * deployment — but never silently.
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
  'core-jobs-invariant',
  'composition-record',
  'fs-local',
  'shell-stdio',
  // Its `allowHosts` is what the browser may reach beyond loopback (ARCHITECTURE §7).
  'tool-browser',
  'tool-shell',
  'tool-editor',
  'tool-subagent',
  // Opt-in, so a layer is the only way it mounts: the first tool that sends
  // data off the machine, and a credential the shell then stops inheriting.
  'tool-web-search',
  'spill-local',
  'persistence-jsonl',
  'credentials-local',
  // Their `baseURL` and `apiKeyEnv` decide where every conversation is sent and
  // under which credential: the reason web search is here, for every request.
  'llm-deepseek',
  'llm-anthropic',
  'llm-openai',
])

/**
 * A plugin no builtin row ships is arbitrary code (ARCHITECTURE §13), whatever
 * name it gives itself: a module could call itself `session-title` and answer
 * every approval. Keyed by IDENTITY, not by name, for exactly that reason.
 */
const BUILTIN_PLUGIN_OBJECTS: ReadonlySet<unknown> = new Set(builtinPlugins.values())

/**
 * `minidsh config` — the EFFECTIVE composition: the same base and layer
 * algorithm a boot uses, with per-row provenance. The rows that would actually
 * mount, not a pristine default.
 */
async function configCommand(args: ParsedArgs): Promise<number> {
  const plan = await prepareBoot(args, 'none')
  if (typeof plan === 'string') return usage(plan)
  try {
    const effective = plan.effective
    for (const warning of plan.warnings) process.stderr.write(`warn: ${warning}\n`)
    const touched = (id: string): string => effective.provenance.get(id) ?? 'built-in'
    // Judged ONCE, before either view: the JSON view used to return before
    // the marks were computed, so a machine reader got provenance and no sign
    // that a layer had touched an authority-sensitive row.
    const rows = effective.rows.map((row) => {
      const layer = touched(row.id)
      const sensitive = layer !== 'built-in' && (AUTHORITY_SENSITIVE_PLUGINS.has(row.plugin.name) || !BUILTIN_PLUGIN_OBJECTS.has(row.plugin))
      // What a boot would refuse, this command must refuse too: every enabled
      // row's config is parsed against the plugin's contract, exactly as load does.
      let invalidConfig: string | undefined
      if (row.disabled !== true && row.plugin.config) {
        try {
          row.plugin.config.parse(row.config)
        } catch (error) {
          invalidConfig = describeConfigError(error)
        }
      }
      return { row, layer, sensitive, invalidConfig }
    })
    // Agent presets are composition too: they mount plugins into an agent's
    // world, so the same authority check applies. A preset naming
    // `approval-headless{approve:true}` grants blanket consent to every agent
    // it composes, and it used to print as an ordinary row.
    const presets = [...plan.loaded.agentPresets].map(([name, spec]) => ({
      name,
      rows: spec.rows,
      sensitive: spec.rows.filter((row) => AUTHORITY_SENSITIVE_PLUGINS.has(row.plugin) || !builtinPlugins.has(row.plugin)),
    }))
    const warnings = [
      // A built-in row a layer touched was modified (or disabled); a row the
      // layer brought in was added.
      ...rows.flatMap(({ row, layer, sensitive }) =>
        sensitive ? [`layer "${layer}" ${row.disabled === true ? 'DISABLED' : plan.baseIds.has(row.id) ? 'modified' : 'added'} authority-sensitive row "${row.id}" (${row.plugin.name})`] : [],
      ),
      ...presets.flatMap(({ name, sensitive }) => sensitive.map((row) => `agent preset "${name}" mounts authority-sensitive row "${row.id}" (${row.plugin}) into every agent it composes`)),
    ]
    // On stderr in both views: they are about the deployment, not about how it is printed.
    for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`)
    const invalid = rows.some(({ invalidConfig }) => invalidConfig !== undefined)
    if (args.flags.get('json') === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            hash: effective.descriptor.hash,
            layers: effective.descriptor.layers,
            agentDefaults: plan.settings.agent,
            rows: rows.map(({ row, layer, sensitive, invalidConfig }) => ({
              id: row.id,
              plugin: row.plugin.name,
              ...(row.disabled === true ? { disabled: true } : {}),
              layer,
              ...(sensitive ? { sensitive: true } : {}),
              ...(invalidConfig === undefined ? {} : { invalidConfig }),
            })),
            agentPresets: presets.map(({ name, rows: presetRows, sensitive }) => ({
              name,
              rows: presetRows.map((row) => ({ id: row.id, plugin: row.plugin })),
              ...(sensitive.length === 0 ? {} : { sensitive: sensitive.map((row) => row.id) }),
            })),
          },
          null,
          2,
        )}\n`,
      )
      return invalid ? 1 : 0
    }
    process.stdout.write(`composition ${effective.descriptor.hash} (layers: ${effective.descriptor.layers.join(' → ')})\n`)
    process.stdout.write(`agent defaults: ${plan.settings.agent.provider}/${plan.settings.agent.model}\n\n`)
    for (const { row, layer, sensitive } of rows) {
      const marks = [row.disabled === true ? 'disabled' : undefined, sensitive ? '!' : undefined].filter((mark) => mark !== undefined)
      process.stdout.write(`  ${row.id.padEnd(22)} ${row.plugin.name.padEnd(28)} ${layer}${marks.length > 0 ? `  [${marks.join(' ')}]` : ''}\n`)
    }
    if (presets.length > 0) {
      process.stdout.write(`\nagent presets:\n`)
      for (const { name, rows: presetRows, sensitive } of presets) {
        process.stdout.write(`  ${name.padEnd(22)} ${presetRows.map((row) => `${row.id}(${row.plugin})`).join(', ')}${sensitive.length > 0 ? '  [!]' : ''}\n`)
      }
    }
    for (const { row, invalidConfig } of rows) {
      if (invalidConfig !== undefined) process.stderr.write(`error: row "${row.id}" (${row.plugin.name}): invalid config: ${invalidConfig}\n`)
    }
    return invalid ? 1 : 0
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
async function withPersistence<T>(
  plan: BootPlan,
  use: (persistence: Persistence, attachments: Attachments | undefined, storeRoot: string) => T | Promise<T>,
): Promise<T> {
  const effective = plan.effective
  for (const warning of plan.warnings) stderrLogger.warn(warning)
  const row = effective.rows.find((entry) => entry.plugin.name === 'persistence-jsonl' && entry.disabled !== true)
  const root = createRoot({ logger: stderrLogger })
  if (row) root.plugin(row.plugin, row.config)
  else root.plugin(persistenceJsonlPlugin, { root: plan.home.sessionsRoot })
  // The attachment row too, for the same reason the persistence row is the
  // EFFECTIVE one: a reader that resolved object paths for itself could
  // disagree with the store that wrote them, and an attachment id is
  // deliberately not a path any consumer may derive.
  const attachmentRow = effective.rows.find((entry) => entry.plugin.name === 'attachments-local' && entry.disabled !== true)
  if (attachmentRow) root.plugin(attachmentRow.plugin, attachmentRow.config)
  await root.settle()
  const storeRoot = (row?.config as { root?: string } | undefined)?.root ?? plan.home.sessionsRoot
  try {
    return await use(root.get(PERSISTENCE), root.tryGet(ATTACHMENTS), storeRoot)
  } finally {
    await root.dispose()
  }
}

/** What a person salvaging `id` must know that its fork's model may never be told: where the readable record stops. */
function salvageNote(persistence: Persistence, id: string): string | undefined {
  let stored: StoredSession | undefined
  try {
    stored = persistence.load(id)
  } catch {
    return undefined
  }
  if (stored?.damaged !== true) return undefined
  const stop = stored.integrity?.stop
  const where = stop === undefined ? 'part way through' : `at line ${stop.line} (${stop.reason})`
  return `salvaging ${id}: its log stops being readable ${where}. The fork holds only what came before; any later turns, and what they did, are not in its history, and its model is told so only about a call that was open where reading stopped.`
}

/**
 * What a resume would append to a crashed log nobody has resumed, for the
 * audit. None for a damaged log (a resume is refused), for one a live writer
 * holds (nothing has crashed), or when repair cannot fold it (`verify` names why).
 */
function pendingClosers(stored: StoredSession): EventEnvelope[] {
  if (stored.damaged === true || heldByWriter(stored)) return []
  try {
    return repairTail(stored.events)
  } catch {
    return []
  }
}

/** A fold over a stored log's payloads, or `fallback` when one cannot be read: the view still prints the rest. */
function safely<T>(fold: () => T, fallback: T): T {
  try {
    return fold()
  } catch {
    return fallback
  }
}

/**
 * Why `--at seq` cannot be a fork point of `id`, or undefined when it can (or
 * when the fork itself will say what is wrong: no such log, a seq out of
 * range). The rule is the fork's own (`sliceForkSeed`): no turn may be open at
 * the boundary. This adds what that refusal cannot know to say from inside a
 * slice — where the turn around `seq` begins and ends, so the person has a
 * number to type next.
 */
function forkPointRefusal(persistence: Persistence, id: string, seq: number): string | undefined {
  const read = safely(() => readStored(persistence, id), 'unreadable')
  if (typeof read === 'string') return undefined
  const events = read.events
  if (seq < 0 || seq >= events.length) return undefined
  let start: number | undefined
  for (let i = seq; i >= 0 && start === undefined; i--) {
    const type = events[i]!.type
    if (type === TURN_END.type) return undefined
    if (type === TURN_START.type) start = i
  }
  if (start === undefined) return undefined
  const ends = events.filter((event) => event.type === TURN_END.type).map((event) => event.seq)
  const before = ends.findLast((end) => end < seq)
  const after = ends.find((end) => end > seq)
  const nearest = [...(before === undefined ? [] : [`${before} (before)`]), ...(after === undefined ? [] : [`${after} (after)`])]
  const turn = `the turn that starts at seq ${start}${after === undefined ? ' and never ended' : ` and ends at ${after}`}`
  const points = nearest.length === 0 ? 'this log records no turn end to fork at' : `the nearest turn ${nearest.length === 1 ? 'end is' : 'ends are'} seq ${nearest.join(' and ')}`
  return `--at ${seq} is inside ${turn}, and a fork needs a point where no turn is open: ${points} (\`minidsh sessions inspect ${printableText(id)}\` lists every one)`
}

/** A stored log, or the line saying why there is none to read: absent, or of a newer format (which is not damage). */
function readStored(persistence: Persistence, id: string): StoredSession | string {
  try {
    return persistence.load(id) ?? `no session "${id}"`
  } catch (error) {
    if (error instanceof SessionFormatError) return error.message
    throw error
  }
}

/**
 * `sessions verify` and `sessions inspect`: COLD reads. The store is loaded,
 * never attached — no lease is taken and nothing is repaired or written; a
 * lease someone else holds is read, not touched, and only qualifies what an
 * open turn or an unterminated line means. `verify` is the exit-code contract
 * (`verdictExitCode`); `inspect` is a report and exits 0 whenever it could read.
 */
async function coldReadCommand(args: ParsedArgs, plan: BootPlan, sub: 'inspect' | 'verify'): Promise<number> {
  const id = args.positional[1]
  if (!id) return usage(`usage: ${usageFor('sessions')}`)
  const json = args.flags.get('json') === true
  return withPersistence(plan, async (persistence, attachments, storeRoot) => {
    const read = readStored(persistence, id)
    if (typeof read === 'string') {
      // A file whose header cannot be read is not a missing session: a power
      // cut at creation zero-fills exactly that line.
      const unreadable = read.startsWith('no session') ? unreadableHeader(storeRoot, id) : undefined
      const verdict = unreadable !== undefined ? 'damaged' : read.startsWith('no session') ? 'not-found' : 'unsupported'
      const message = unreadable === undefined ? read : `session "${id}": its log exists and cannot be read at all: ${unreadable}`
      if (json) process.stdout.write(`${JSON.stringify({ sessionId: id, verdict, message })}\n`)
      else process.stderr.write(`${message}\n`)
      return 1
    }
    const checked = verifyStored(read)
    const verification = { ...checked, findings: [...checked.findings, ...(await verifyAttachments(read.events, attachments))] }
    if (sub === 'verify') {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ sessionId: read.header.id, verdict: verification.verdict, inFlux: verification.inFlux, findings: verification.findings, closers: verification.closers })}\n`,
        )
      } else {
        for (const line of verifyLines(read.header.id, verification)) process.stdout.write(`${line}\n`)
      }
      return verdictExitCode(verification.verdict)
    }
    const inspection = inspectStored(read, verification)
    if (json) process.stdout.write(`${JSON.stringify(inspection)}\n`)
    else for (const line of inspectLines(inspection)) process.stdout.write(`${line}\n`)
    return 0
  })
}

/**
 * `minidsh skills` — what a NEW session in the cwd would be offered, what was
 * not listed and why, and the roots read: the human view of adding, replacing,
 * disabling and removing a skill, and of a repository skill that a user or
 * bundled one shadows (which a session only ever warns the operator about).
 *
 * Read-only, and no boot: the EFFECTIVE `skills` row (layers and filled roots
 * included, through the one preamble) over a throwaway root that mounts the
 * sandbox and the local fs alone — no persistence, no model, no session. The
 * scan is the capability's own `discoverSkills`, so this cannot disagree with
 * what a session's pre-step would read.
 */
async function skillsCommand(args: ParsedArgs): Promise<number> {
  // Settings choose a model, which this command never touches: a broken
  // settings.json must not stand between a person and their skill list.
  const plan = await prepareBoot(args, 'none', 'optional')
  if (typeof plan === 'string') return usage(plan)
  for (const warning of plan.warnings) stderrLogger.warn(warning)
  const json = args.flags.get('json') === true
  const row = plan.effective.rows.find((entry) => entry.plugin.name === skillsPlugin.name)
  if (!row || row.disabled === true) {
    const why = row ? `the composition disables row "${row.id}"` : 'the composition has no skills row'
    if (json) process.stdout.write(`${JSON.stringify({ disabled: true, reason: why, roots: [], listed: [], skipped: [], complete: true })}\n`)
    else process.stdout.write(`no skills are offered: ${why}\n`)
    return 0
  }
  let config: SkillsConfig
  try {
    config = skillsPlugin.config!.parse(row.config)
  } catch (error) {
    process.stderr.write(`error: row "${row.id}" (${row.plugin.name}): invalid config: ${describeConfigError(error)}\n`)
    return 1
  }
  const cwd = cwdFlag(args)
  const root = createRoot({ logger: stderrLogger })
  try {
    root.plugin(sandboxPlugin, {})
    root.plugin(fsLocalPlugin)
    await root.settle()
    const scanned = await discoverSkills(root.get(FS), cwd, config)
    // What a session is OFFERED is what fits the row's byte budget, so the
    // tail the render drops is reported as not listed — the review found this
    // command calling skills "offered" that no session would ever see.
    const kept = new Set(fitSkillList(scanned.listed, config.maxBytes)?.kept ?? [])
    const found: SkillDiscovery = {
      ...scanned,
      listed: scanned.listed.filter((entry) => kept.has(entry)),
      skipped: [
        ...scanned.skipped,
        ...scanned.listed.filter((entry) => !kept.has(entry)).map((entry) => ({ path: entry.path, reason: `over the skills row's maxBytes (${config.maxBytes}): the list a session gets drops it` })),
      ],
    }
    if (json) process.stdout.write(`${JSON.stringify({ roots: found.roots, listed: found.listed, skipped: found.skipped, complete: found.complete })}\n`)
    else for (const line of skillLines(cwd, found)) process.stdout.write(`${line}\n`)
    if (!found.complete) process.stderr.write('warning: the scan is incomplete; a running session keeps the skill list it already has until a scan completes\n')
    return 0
  } catch (error) {
    return reportError(error)
  } finally {
    await root.dispose()
  }
}

/** The human table: listed, then not listed with the reason, then the roots in precedence order. */
function skillLines(cwd: string, found: SkillDiscovery): string[] {
  const lines: string[] = []
  const width = Math.max(4, ...found.listed.map((entry) => entry.name.length))
  lines.push(found.listed.length === 0 ? `no skills are offered to a session in ${cwd}` : `skills offered to a session in ${cwd}:`)
  for (const entry of found.listed) {
    lines.push(`  ${entry.name.padEnd(width)}  ${entry.origin.padEnd(9)}  ${oneLine(entry.path, 400)}`)
    lines.push(`  ${''.padEnd(width)}  ${oneLine(entry.description, 100)}`)
  }
  if (found.skipped.length > 0) {
    lines.push('', 'not listed:')
    for (const entry of found.skipped) lines.push(`  ${oneLine(entry.path, 400)}`, `    ${oneLine(entry.reason, 400)}`)
  }
  lines.push('', 'roots, in precedence order:')
  for (const root of found.roots) lines.push(`  ${root.origin.padEnd(9)}  ${oneLine(root.path, 400)}${root.present ? '' : '  (absent)'}`)
  return lines
}

/**
 * `minidsh credentials` — the provider keys a person sets once, without an
 * editor and without a value ever on a command line.
 *
 * `list` reports, for every reference the deployment DECLARES, which layer
 * would answer it now (`env`, `store`, `absent`), by the provider's own
 * lookup (`credentialSources`), and never a value or any part of one. The
 * declared set is only known once each row has minted its own reference — a
 * layer may rename one (`apiKeyEnv`) — so it mounts the effective composition
 * on a throwaway root, as a boot would, with no agent, no session and no
 * surface, and reads `declaredRefs()`. It also names what the store holds
 * that no mounted row declares (`credentialSources`' `unused`): a key saved
 * for a row that is not mounted is otherwise a save that seems to have gone
 * nowhere.
 *
 * `set NAME` reads the value from stdin alone (argv lands in shell history
 * and in every process listing; an environment is inherited): hidden on a
 * terminal, otherwise everything on stdin less one trailing newline. `unset
 * NAME` removes it. Both write through the store's owner
 * (`updateCredentialStore`), at the store the deployment's `credentials-local`
 * row READS, so a layer that moved it does not leave a key saved where nothing
 * looks. Settings choose a model, which this command never touches: a broken
 * settings.json must not stand between a person and their key.
 */
async function credentialsCommand(args: ParsedArgs): Promise<number> {
  const [sub, name, ...rest] = args.positional
  const shape = sub === 'list' ? name === undefined : (sub === 'set' || sub === 'unset') && name !== undefined && rest.length === 0
  if (!shape) return usage(`usage: ${usageFor('credentials')}`)
  const plan = await prepareBoot(args, 'none', 'optional')
  if (typeof plan === 'string') return usage(plan)
  const json = args.flags.get('json') === true
  const row = plan.effective.rows.find((entry) => entry.plugin === credentialsLocalPlugin && entry.disabled !== true)
  const store = (row?.config as { path?: string } | undefined)?.path
  if (sub === 'list') return listCredentials(plan, store, json)

  let ref: CredentialRef
  try {
    ref = credentialRef(name!)
  } catch {
    // The rule, never the input: the commonest slip is a key pasted where its
    // NAME goes, and this message would print it back.
    return usage('the NAME must be an environment-variable name (letters, digits and _, not starting with a digit), such as DEEPSEEK_API_KEY')
  }
  if (store === undefined) {
    process.stderr.write(`error: this composition reads no credentials store (no enabled credentials-local row names a path); set ${ref} in the environment instead\n`)
    return 1
  }
  if (sub === 'unset') {
    let removed: boolean
    try {
      removed = updateCredentialStore(store, ref, undefined)
    } catch (error) {
      return reportError(error)
    }
    // Absent is not an error: the state asked for is the state it is in.
    if (json) process.stdout.write(`${JSON.stringify({ removed: ref, store })}\n`)
    process.stderr.write(removed ? `removed ${ref} from ${store}\n` : `${ref} was not in ${store}; nothing to remove\n`)
    return 0
  }
  const value = await readSecret(ref)
  if (value === undefined) {
    process.stderr.write('aborted; nothing was saved\n')
    return 130
  }
  // Which rule, never the value: a refusal message is exactly where a pasted
  // key would otherwise be echoed back.
  if (value.length === 0) return usage(`${ref}: the value is empty; nothing was saved`)
  if (!isHeaderSafe(value)) {
    return usage(`${ref}: the value holds a character a request header cannot carry (a space, a line break, a control or a non-ASCII character); nothing was saved`)
  }
  try {
    updateCredentialStore(store, ref, value)
  } catch (error) {
    return reportError(error)
  }
  if (json) process.stdout.write(`${JSON.stringify({ saved: ref, store })}\n`)
  process.stderr.write(`saved ${ref} to ${store}\n`)
  return 0
}

async function listCredentials(plan: BootPlan, store: string | undefined, json: boolean): Promise<number> {
  let refs: readonly CredentialRef[]
  try {
    const root = await bootComposition({ ...bootFields(plan) })
    try {
      refs = root.tryGet(CREDENTIALS)?.declaredRefs() ?? []
    } finally {
      await root.dispose()
    }
  } catch (error) {
    return reportError(error)
  }
  // `unused`: what `set` saved and no mounted row reads. `credentials set
  // TAVILY_API_KEY` answered "saved" and this list then showed three other
  // names, as if the save had gone nowhere. The row that would read it is not
  // mounted (web search is opt-in), which is the thing to say.
  const { sources, unused, problem } = credentialSources(store, refs)
  if (problem !== undefined) stderrLogger.warn(problem)
  if (json) {
    process.stdout.write(`${JSON.stringify({ home: resolveHome(), store: store ?? null, refs: sources, unused })}\n`)
    return 0
  }
  if (sources.length === 0) process.stdout.write('this composition declares no credential\n')
  const width = Math.max(0, ...sources.map((entry) => entry.name.length), ...unused.map((name) => name.length))
  for (const entry of sources) process.stdout.write(`${entry.name.padEnd(width)}  ${entry.source}\n`)
  for (const name of unused) process.stdout.write(`${printableText(name).padEnd(width)}  stored, and read by no mounted row\n`)
  process.stdout.write(`store: ${store ?? 'none (no enabled credentials-local row names a path)'}\n`)
  return 0
}

/** The secret, from stdin alone; `undefined` when a person aborted the prompt. */
async function readSecret(ref: CredentialRef): Promise<string | undefined> {
  if (process.stdin.isTTY) return promptHidden(`${ref}: `)
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  // ONE trailing newline is how `echo` and every editor end a value; anything
  // more is part of what was given, and the header rule refuses it.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '')
}

const CTRL_C = String.fromCharCode(3)
const CTRL_D = String.fromCharCode(4)
const BACKSPACE = String.fromCharCode(8)
const DELETE = String.fromCharCode(127)

/** One line from the terminal with echo off: raw mode, so nothing typed is drawn; Ctrl+C aborts. */
function promptHidden(prompt: string): Promise<string | undefined> {
  const stdin = process.stdin
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((answer) => {
    let value = ''
    const finish = (result: string | undefined): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      answer(result)
    }
    const onData = (chunk: Buffer | string): void => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n' || char === CTRL_D) return finish(value)
        if (char === CTRL_C) return finish(undefined)
        if (char === BACKSPACE || char === DELETE) value = [...value].slice(0, -1).join('')
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

async function sessionsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0]
  // A reader of stored logs: a broken settings file is a warning here, because
  // reading a log must not depend on it. Its flag table lists no authority
  // flag, so `--sandbox` is a usage error rather than something ignored.
  const plan = await prepareBoot(args, 'none', 'optional')
  if (typeof plan === 'string') return usage(plan)
  const allowed = sub === undefined ? undefined : SESSION_SUBCOMMANDS[sub]
  if (allowed === undefined) return usage(`usage: ${usageFor('sessions')}`)
  for (const name of args.flags.keys()) {
    if (!(allowed as readonly string[]).includes(name)) return usage(`--${name} is not a flag of "sessions ${sub}"`)
  }
  if (sub === 'inspect' || sub === 'verify') return coldReadCommand(args, plan, sub)
  if (sub === 'list') {
    return withPersistence(plan, (persistence) => {
      const stored = persistence.list()
      // An empty store said NOTHING, which reads the same as a listing that is
      // broken — and a fresh install is exactly the empty case, so it was the
      // first thing a stranger saw. On stderr, so a script cutting the rows
      // apart still reads an empty stdout.
      if (stored.length === 0) {
        process.stderr.write(`no stored sessions in ${plan.home.sessionsRoot}\n`)
        return 0
      }
      for (const { header, title } of stored) {
        // Lineage is durable: a delegated child says whose work it was doing.
        const lineage = header.delegatedBy === undefined ? '' : `\t↳ delegated by ${header.delegatedBy} (depth ${header.delegationDepth ?? 1})`
        // The name last, so the three columns that were here before keep their
        // positions for anything already cutting this output apart. A title has
        // no tabs by construction: the fold collapses whitespace.
        // Each column neutralized: a stored header is not this runtime's word.
        // Nor is its SHAPE: the store lists any header with an id and a
        // numeric `createdAt`, and one header with no `cwd`, or a time outside
        // a date's range, used to throw here and take every other row with it.
        const created = new Date(header.createdAt)
        const when = Number.isNaN(created.getTime()) ? printableText(String(header.createdAt)) : created.toISOString()
        process.stdout.write(`${printableText(header.id)}\t${when}\t${printableText(String(header.cwd ?? ''))}\t${printableText(title ?? '')}${printableText(lineage)}\n`)
      }
      return 0
    })
  }
  if (sub === 'show') {
    const id = args.positional[1]
    if (!id) return usage(`usage: ${usageFor('sessions')}`)
    // Two views of one log, not a combination: one of them would be dropped.
    if (args.flags.get('json') === true && args.flags.get('audit') === true) return usage('"sessions show" takes --json or --audit, not both')
    return withPersistence(plan, (persistence, attachments, storeRoot) => {
      const read = readStored(persistence, id)
      if (typeof read === 'string') {
        // A file whose header cannot be read is not a missing session
        // (`coldReadCommand` says the same, in the same words).
        const unreadable = read.startsWith('no session') ? unreadableHeader(storeRoot, id) : undefined
        process.stderr.write(`${unreadable === undefined ? read : `session "${id}": its log exists and cannot be read at all: ${unreadable}`}\n`)
        return 1
      }
      const stored = read
      if (args.flags.get('audit') === true) {
        process.stdout.write(`${printableText(`authority and effects of ${stored.header.id} (cwd ${stored.header.cwd})`)}\n`)
        // A crashed log nobody resumed yet: the call in flight is only a line
        // once something repairs it, so the audit shows what a resume would say.
        for (const line of auditLines(stored.events, pendingClosers(stored))) process.stdout.write(`${line}\n`)
        if (stored.damaged) {
          // The view a person opens after something went wrong must not read
          // as complete when reading stopped at damage: a last line of the
          // audit itself (it may be saved or piped), and the plain view's warning.
          const stop = stored.integrity?.stop
          const where = stop === undefined ? '' : ` at line ${stop.line} (${stop.reason})`
          process.stdout.write(`${printableText(`${String(stored.events.length).padStart(4)}  damaged     the log stops being readable here${where}: whatever it recorded after this is not in this audit`)}\n`)
          process.stderr.write('warning: the stored log is damaged beyond this point\n')
        }
      } else if (args.flags.get('json') === true) {
        for (const event of stored.events) process.stdout.write(`${JSON.stringify({ sessionId: stored.header.id, event })}\n`)
        // Machine readers must see damage too: a trailer object (no `event` field) a frame consumer skips.
        if (stored.damaged) process.stdout.write(`${JSON.stringify({ sessionId: stored.header.id, damaged: true })}\n`)
      } else {
        process.stdout.write(`${printableText(`session ${stored.header.id} (cwd ${stored.header.cwd})`)}\n`)
        // The whole log is in hand here, so this is the recorded title or the
        // derivation over everything — never the bounded-prefix answer a
        // listing settles for.
        const title = foldSessionTitle(stored.events)
        if (title !== undefined) process.stdout.write(`title: ${printableText(title)}\n`)
        if (stored.header.delegatedBy !== undefined) {
          // The CALL too, where the log records one: two children of a single
          // step are otherwise indistinguishable from this side.
          const call = stored.header.delegatedByCallId === undefined ? '' : `, call ${stored.header.delegatedByCallId}`
          process.stdout.write(`${printableText(`delegated by ${stored.header.delegatedBy} (depth ${stored.header.delegationDepth ?? 1}${call})`)}\n`)
        }
        // What this session cost and how full its context got, measured
        // against the window the log itself names for the route in use; a log
        // from before `request/context` existed prints the numbers alone.
        const window = foldRequestContext(stored.events)?.contextWindow ?? 0
        // `safely`, here and over the images below: a stored payload is not
        // this runtime's word, and a known kind with a wrong shape (a hand
        // edit, another tool's log) must cost its own summary line, not the
        // rows that follow. The title fold above guards its own payloads.
        const metrics = safely(() => meterSession(stored.events, window), undefined)
        if (metrics !== undefined && metrics.sessionInput + metrics.sessionOutput + metrics.sessionCacheRead > 0) {
          const ratio = window > 0 ? ` (${Math.round(metrics.ratio * 100)}% of ${formatTokens(window)})` : ''
          process.stdout.write(
            `usage: ${formatTokens(metrics.sessionInput)} in · ${formatTokens(metrics.sessionCacheRead)} cached · ` +
              `${formatTokens(metrics.sessionOutput)} out · context now ~${formatTokens(metrics.projectedTokens)}${ratio}\n`,
          )
        }
        const names = new CallNames()
        for (const event of stored.events) {
          const line = describeEvent(event, names)
          // The kind too: a stored line's `type` is any non-empty string the log holds (S20.5 review).
          process.stdout.write(`${String(event.seq).padStart(4)}  ${printableText(event.type)}${line ? ` ${line}` : ''}\n`)
        }
        // Where the bytes are, for every image this session was shown. The
        // local-first answer to "let me look at it": the object is on this
        // disk, so a human opens it with whatever they already use. It is also
        // the only runtime consumer of `hostPath`, which is what keeps that
        // method an honest part of the seam rather than a test affordance.
        if (attachments) {
          const seen = new Map<string, string>()
          for (const event of stored.events) {
            safely(() => {
              const message = matches(event, TOOL_RESULT) ? event.data.message : matches(event, USER_MESSAGE) ? event.data.message : undefined
              if (!message) return
              for (const ref of collectImageRefs(message.content).values()) {
                const where = attachments.hostPath(ref)
                if (where !== undefined) seen.set(ref.id, where)
              }
            }, undefined)
          }
          for (const [ref, where] of seen) process.stdout.write(`      ${ref.slice(0, 19)}… ${where}\n`)
        }
        if (stored.damaged) process.stderr.write('warning: the stored log is damaged beyond this point\n')
      }
      return 0
    })
  }
  return usage(`usage: ${usageFor('sessions')}`)
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  warned.clear()
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
    case 'web':
      return webCommand(args)
    case 'config':
      return configCommand(args)
    case 'sessions':
      return sessionsCommand(args)
    case 'skills':
      return skillsCommand(args)
    case 'credentials':
      return credentialsCommand(args)
    case 'version':
      process.stdout.write(`minidsh ${VERSION}\n`)
      return 0
    default: {
      if (args.helpFor !== undefined) {
        process.stdout.write(`usage: ${usageFor(args.helpFor)}\n`)
        return 0
      }
      // Help that was asked for is output; the same text after a command
      // nobody has is a refusal, so it goes to stderr under a line that names
      // the mistake (`minidsh runn "hi"` used to print all of this on stdout
      // and never say `runn`).
      const asked = args.command === 'help'
      const out = asked ? process.stdout : process.stderr
      if (!asked) process.stderr.write(`minidsh: unknown command "${printableText(args.command)}"\n\n`)
      out.write(
        [
          'MiniDSH — usage:',
          ...Object.keys(COMMANDS).map((command) => `  ${usageFor(command)}`),
          '  minidsh --version',
          '',
          'config:    ~/.minidsh/composition.json + settings.json layer over the built-ins;',
          '           --patch <file> (repeatable) layers after them on any command',
          'model:     --provider and --model, else MINIDSH_MODEL (the model alone), else settings.json, else the built-in default',
          'authority: --sandbox read-only|workspace-write|danger-full-access (default workspace-write)',
          '           --ask ask|never; --approve answers every request yes (headless runs; chat, serve and web then never ask)',
          '           --accept full|none: what a session accepts from a host that cannot confine the shell (default full)',
          'skills:    ~/.minidsh/skills/<name>/SKILL.md, the bundled skills, and the repository\'s .agents/skills and .claude/skills;',
          '           `minidsh skills` shows what a session in the cwd is offered, and what was not listed and why',
          'keys:      `minidsh credentials set DEEPSEEK_API_KEY` reads a key from stdin (hidden on a terminal) into',
          '           ~/.minidsh/credentials.json; the environment still wins; `credentials list` says which answers',
          '',
        ].join('\n'),
      )
      return asked ? 0 : 2
    }
  }
}
