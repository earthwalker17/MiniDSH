/**
 * The headless CLI surface. It renders exclusively from `session/event`, drives
 * only `ctx.agents`/`ctx.sessions` via the runner, and exits 0 iff the turn
 * completed. `--json` streams raw session events to stdout; `sessions show`
 * reads the log only.
 */
import { createRoot, type Logger } from '../kernel/index.ts'
import { messageText, restoreMessage } from '../core/llm/message.ts'
import { formatTokens, meterSession } from '../core/metering/index.ts'
import { PERSISTENCE, type Persistence } from '../core/persistence/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
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
import { compositionPath, credentialsPath, globalInstructionsPath, resolveHome, sessionsDir, spillDir, settingsPath } from './home.ts'
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

const VALUE_FLAGS = new Set(['cwd', 'model', 'effort', 'max-steps', 'at', 'sandbox', 'ask', 'preset', 'agent-preset'])

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

function preview(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Human-readable progress line for one session event, or undefined to skip. */
function renderEvent(event: EventEnvelope): string | undefined {
  switch (event.type) {
    case 'user/message': {
      const message = restoreMessage((event.data as { message: Parameters<typeof restoreMessage>[0] }).message)
      return message.source.kind === 'user' ? undefined : `  · context (${message.source.kind})`
    }
    case 'tool/call': {
      const data = event.data as { name: string; arguments: string }
      return `  → ${data.name} ${preview(data.arguments)}`
    }
    case 'tool/result': {
      const data = event.data as { error?: { code: string } }
      return data.error ? `    ✗ ${data.error.code}` : '    ✓'
    }
    case 'assistant/message': {
      const text = messageText(restoreMessage((event.data as { message: Parameters<typeof restoreMessage>[0] }).message))
      return text.length > 0 ? `  ${preview(text, 120)}` : undefined
    }
    case 'turn/end': {
      const data = event.data as { reason: { kind: string } }
      return `  [turn ${data.reason.kind}]`
    }
    case 'sandbox/mode': {
      const data = event.data as { mode: string; enforcement: string; reason: string }
      return `  [sandbox ${data.reason}: ${data.mode}, shell confinement ${data.enforcement}]`
    }
    case 'approval/policy':
      return `  [approvals: ${(event.data as { policy: string }).policy}]`
    case 'authority/preset':
      return `  [preset: ${(event.data as { name: string }).name}]`
    case 'approval/asked': {
      const data = event.data as { id: string; toolName: string; reason?: string }
      return `  ? ${data.id} ${data.toolName}${data.reason ? `: ${data.reason}` : ''}`
    }
    case 'approval/decided': {
      const data = event.data as { id: string; outcome: string }
      return `  ! ${data.id} ${data.outcome}`
    }
    default:
      return undefined
  }
}

async function runCommand(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim()
  if (task.length === 0) {
    process.stderr.write('usage: minidsh run "<task>" [--cwd dir] [--model id] [--effort id] [--max-steps n] [--sandbox mode] [--approve] [--json]\n')
    return 2
  }
  const json = args.flags.get('json') === true
  const cwd = typeof args.flags.get('cwd') === 'string' ? (args.flags.get('cwd') as string) : process.cwd()
  const effort = typeof args.flags.get('effort') === 'string' ? (args.flags.get('effort') as string) : undefined
  const maxStepsRaw = args.flags.get('max-steps')
  const maxSteps = typeof maxStepsRaw === 'string' ? Number(maxStepsRaw) : undefined
  const authority = authorityFlags(args)
  if (typeof authority === 'string') {
    process.stderr.write(`${authority}\n`)
    return 2
  }
  const settings = loadSettings()
  if (typeof settings === 'string') {
    process.stderr.write(`${settings}\n`)
    return 2
  }
  const model = typeof args.flags.get('model') === 'string' ? (args.flags.get('model') as string) : settings.agent.model
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') {
    process.stderr.write(`${loaded}\n`)
    return 2
  }
  const configLayers = loaded.layers
  const preset = presetFlag(args, authority, configLayers)
  if (typeof preset === 'object') {
    process.stderr.write(`${preset.error}\n`)
    return 2
  }
  const agentSetup = await agentPresetFlag(args, loaded)
  if (typeof agentSetup === 'object') {
    process.stderr.write(`${agentSetup.error}\n`)
    return 2
  }

  try {
    const result = await runTask(
      {
        task,
        cwd,
        model,
        ...(preset === undefined ? {} : { preset }),
        ...(agentSetup === undefined ? {} : { setup: agentSetup }),
        sessionsRoot: sessionsDir(),
        spillRoot: spillDir(),
        globalInstructionsPath: globalInstructionsPath(),
        credentialsPath: credentialsPath(),
        agentDefaults: settings.agent,
        configLayers,
        // Warnings (an unknown patch id, a kernel listener error) must reach the
        // user; the boot's default logger is silent.
        logger: stderrLogger,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(maxSteps === undefined || Number.isNaN(maxSteps) ? {} : { maxSteps }),
        approve: args.flags.get('approve') === true,
        ...authority,
      },
      eventPrinter(json),
    )
    return finishTask(result, json)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function eventPrinter(json: boolean): EventListener {
  // --json emits the wire frame: one {sessionId, event} per line.
  return json
    ? (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
    : (frame) => {
        const line = renderEvent(frame.event)
        if (line) process.stderr.write(`${line}\n`)
      }
}

function finishTask(result: TaskResult, json: boolean): number {
  if (!json) process.stdout.write(`${result.text}\n`)
  if (result.reason !== 'completed') process.stderr.write(`turn ended: ${result.reason}\n`)
  process.stderr.write(`session: ${result.sessionId}\n`)
  return result.exitCode
}

/** Settings resolve once per command; a malformed file is a usage-class failure (exit 2), never silently ignored. */
function loadSettings(): ResolvedSettings | string {
  try {
    return resolveSettings({ path: settingsPath() })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

interface LoadedConfig {
  readonly layers: NamedLayer[]
  /** Named agent presets merged across files, later files winning per name; rows resolve against their source file's directory. */
  readonly agentPresets: Map<string, { rows: readonly DiskRow[]; baseDir: string }>
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
 * validated name, an error string, or undefined when the flag is absent.
 */
function presetFlag(
  args: ParsedArgs,
  authority: { sandbox?: SandboxMode; approvalPolicy?: ApprovalPolicy },
  configLayers: readonly NamedLayer[],
): string | { error: string } | undefined {
  const raw = args.flags.get('preset')
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return { error: '--preset expects a preset name' }
  if (authority.sandbox !== undefined || authority.approvalPolicy !== undefined) {
    return { error: '--preset replaces --sandbox/--ask; give one or the other' }
  }
  try {
    const base = compose({ sessionsRoot: sessionsDir(), spillRoot: spillDir(), dialect: defaultDialect(), credentialsPath: credentialsPath() })
    const effective = applyLayers(base, [...configLayers], () => {})
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

/** `--sandbox` / `--ask`: an explicit authority for this run, validated before anything boots. */
function authorityFlags(args: ParsedArgs): { sandbox?: SandboxMode; approvalPolicy?: ApprovalPolicy } | string {
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

interface CommonModelFlags {
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxSteps?: number
}

function modelFlags(args: ParsedArgs): CommonModelFlags {
  const model = args.flags.get('model')
  const effort = args.flags.get('effort')
  const maxStepsRaw = args.flags.get('max-steps')
  const maxSteps = typeof maxStepsRaw === 'string' ? Number(maxStepsRaw) : undefined
  return {
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
    ...(maxSteps === undefined || Number.isNaN(maxSteps) ? {} : { maxSteps }),
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
    process.stderr.write(
      `usage: minidsh ${kind} <id> ["<task>"]${kind === 'fork' ? ' [--at seq]' : ''} [--headless] [--model id] [--effort id] [--max-steps n] [--approve] [--json]\n`,
    )
    return 2
  }
  const atRaw = args.flags.get('at')
  const boundary = typeof atRaw === 'string' ? Number(atRaw) : undefined
  // A typo'd --at must not silently fork at the log head.
  if (atRaw !== undefined && (typeof atRaw !== 'string' || atRaw.trim() === '' || !Number.isInteger(boundary))) {
    process.stderr.write(`--at expects an integer event seq, got "${String(atRaw)}"\n`)
    return 2
  }
  const approve = args.flags.get('approve') === true
  const authority = authorityFlags(args)
  if (typeof authority === 'string') {
    process.stderr.write(`${authority}\n`)
    return 2
  }
  const settings = loadSettings()
  if (typeof settings === 'string') {
    process.stderr.write(`${settings}\n`)
    return 2
  }
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') {
    process.stderr.write(`${loaded}\n`)
    return 2
  }
  const configLayers = loaded.layers
  const preset = presetFlag(args, authority, configLayers)
  if (typeof preset === 'object') {
    process.stderr.write(`${preset.error}\n`)
    return 2
  }
  if (preset !== undefined && !headless) {
    process.stderr.write('--preset works with --headless; in the interactive terminal use /preset\n')
    return 2
  }
  const agentSetup = await agentPresetFlag(args, loaded)
  if (typeof agentSetup === 'object') {
    process.stderr.write(`${agentSetup.error}\n`)
    return 2
  }

  if (!headless) {
    try {
      return await runTerminal({
        cwd: process.cwd(),
        sessionsRoot: sessionsDir(),
        spillRoot: spillDir(),
        globalInstructionsPath: globalInstructionsPath(),
        credentialsPath: credentialsPath(),
        agentDefaults: settings.agent,
        configLayers,
        ...(agentSetup === undefined ? {} : { agentSetup }),
        approve,
        ...(kind === 'resume' ? { resumeId: id } : { forkId: id }),
        ...(kind === 'fork' && boundary !== undefined && !Number.isNaN(boundary) ? { boundary } : {}),
        ...(task.length > 0 ? { task } : {}),
        ...modelFlags(args),
        ...authority,
        logger: stderrLogger,
      })
    } catch (error) {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const json = args.flags.get('json') === true
  const options: ContinueOptions = {
    id,
    task,
    sessionsRoot: sessionsDir(),
    spillRoot: spillDir(),
    globalInstructionsPath: globalInstructionsPath(),
    credentialsPath: credentialsPath(),
    agentDefaults: settings.agent,
    configLayers,
    logger: stderrLogger,
    ...(preset === undefined ? {} : { preset }),
    ...(agentSetup === undefined ? {} : { setup: agentSetup }),
    ...modelFlags(args),
    ...(kind === 'fork' && boundary !== undefined && !Number.isNaN(boundary) ? { boundary } : {}),
    approve,
    ...authority,
  }
  try {
    const result = kind === 'resume' ? await resumeTask(options, eventPrinter(json)) : await forkTask(options, eventPrinter(json))
    return finishTask(result, json)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** `minidsh chat` — a fresh interactive session over the protocol. */
async function chatCommand(args: ParsedArgs): Promise<number> {
  const cwd = typeof args.flags.get('cwd') === 'string' ? (args.flags.get('cwd') as string) : process.cwd()
  const task = args.positional.join(' ').trim()
  const authority = authorityFlags(args)
  if (typeof authority === 'string') {
    process.stderr.write(`${authority}\n`)
    return 2
  }
  const settings = loadSettings()
  if (typeof settings === 'string') {
    process.stderr.write(`${settings}\n`)
    return 2
  }
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') {
    process.stderr.write(`${loaded}\n`)
    return 2
  }
  // Same guard the interactive resume/fork path uses: swallowing --preset here
  // (where a sibling command refuses it loudly) would silently drop an
  // authority request AND skip the --preset/--sandbox exclusivity check.
  const preset = presetFlag(args, authority, loaded.layers)
  if (typeof preset === 'object') {
    process.stderr.write(`${preset.error}\n`)
    return 2
  }
  if (preset !== undefined) {
    process.stderr.write('--preset works with --headless; in the interactive terminal use /preset\n')
    return 2
  }
  const agentSetup = await agentPresetFlag(args, loaded)
  if (typeof agentSetup === 'object') {
    process.stderr.write(`${agentSetup.error}\n`)
    return 2
  }
  try {
    return await runTerminal({
      cwd,
      sessionsRoot: sessionsDir(),
      spillRoot: spillDir(),
      globalInstructionsPath: globalInstructionsPath(),
      credentialsPath: credentialsPath(),
      agentDefaults: settings.agent,
      configLayers: loaded.layers,
      ...(agentSetup === undefined ? {} : { agentSetup }),
      approve: args.flags.get('approve') === true,
      ...(task.length > 0 ? { task } : {}),
      ...modelFlags(args),
      ...authority,
      logger: stderrLogger,
    })
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const stderrLogger: Logger = {
  warn: (message) => process.stderr.write(`warn: ${message}\n`),
  error: (message) => process.stderr.write(`error: ${message}\n`),
}

/** Built-in rows a config layer can widen authority or blind the runtime through. */
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
])

/**
 * `minidsh config` — the EFFECTIVE composition: the same base and layer
 * algorithm a boot uses, with per-row provenance. This is what `--dump-config`
 * never was: the rows that would actually mount, not a pristine default.
 */
async function configCommand(args: ParsedArgs): Promise<number> {
  const authority = authorityFlags(args)
  if (typeof authority === 'string') {
    process.stderr.write(`${authority}\n`)
    return 2
  }
  const settings = loadSettings()
  if (typeof settings === 'string') {
    process.stderr.write(`${settings}\n`)
    return 2
  }
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') {
    process.stderr.write(`${loaded}\n`)
    return 2
  }
  const configLayers = loaded.layers
  try {
    const base = compose({
      sessionsRoot: sessionsDir(),
      spillRoot: spillDir(),
      globalInstructionsPath: globalInstructionsPath(),
      dialect: defaultDialect(),
      credentialsPath: credentialsPath(),
      ...authority,
    })
    const effective = applyLayers(base, configLayers, (message) => process.stderr.write(`warn: ${message}\n`))
    const touched = (id: string): string => effective.provenance.get(id) ?? 'built-in'
    if (args.flags.get('json') === true) {
      const rows = effective.rows.map((row) => ({
        id: row.id,
        plugin: row.plugin.name,
        ...(row.disabled === true ? { disabled: true } : {}),
        layer: touched(row.id),
      }))
      const agentPresets = [...loaded.agentPresets].map(([name, spec]) => ({ name, rows: spec.rows.map((row) => ({ id: row.id, plugin: row.plugin })) }))
      process.stdout.write(
        `${JSON.stringify({ hash: effective.descriptor.hash, layers: effective.descriptor.layers, agentDefaults: settings.agent, rows, agentPresets }, null, 2)}\n`,
      )
      return 0
    }
    process.stdout.write(`composition ${effective.descriptor.hash} (layers: ${effective.descriptor.layers.join(' → ')})\n`)
    process.stdout.write(`agent defaults: ${settings.agent.provider}/${settings.agent.model}\n\n`)
    const warnings: string[] = []
    for (const row of effective.rows) {
      const layer = touched(row.id)
      const sensitive = layer !== 'built-in' && (AUTHORITY_SENSITIVE.has(row.id) || AUTHORITY_SENSITIVE_PLUGINS.has(row.plugin.name))
      const marks = [row.disabled === true ? 'disabled' : undefined, sensitive ? '!' : undefined].filter((mark) => mark !== undefined)
      process.stdout.write(`  ${row.id.padEnd(22)} ${row.plugin.name.padEnd(28)} ${layer}${marks.length > 0 ? `  [${marks.join(' ')}]` : ''}\n`)
      if (sensitive) {
        const verb = row.disabled === true ? 'DISABLED' : layer === touched(row.id) && AUTHORITY_SENSITIVE.has(row.id) ? 'modified' : 'added'
        warnings.push(`layer "${layer}" ${verb} authority-sensitive row "${row.id}" (${row.plugin.name})`)
      }
    }
    // Agent presets are composition too: they mount plugins into an agent's world.
    if (loaded.agentPresets.size > 0) {
      process.stdout.write(`\nagent presets:\n`)
      for (const [name, spec] of loaded.agentPresets) {
        process.stdout.write(`  ${name.padEnd(22)} ${spec.rows.map((row) => `${row.id}(${row.plugin})`).join(', ')}\n`)
      }
    }
    for (const warning of warnings) process.stderr.write(`warn: ${warning}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Mounts the persistence provider on a bare root and hands its Definition to
 * `use`. The row comes from the EFFECTIVE composition, so `sessions list/show`
 * read exactly where `run`/`resume` write — a layer that repoints the store
 * must not split the CLI's read path from its write path.
 */
async function withPersistence<T>(layers: readonly NamedLayer[], use: (persistence: Persistence) => T): Promise<T> {
  const base = compose({ sessionsRoot: sessionsDir(), spillRoot: spillDir(), dialect: defaultDialect(), credentialsPath: credentialsPath() })
  const effective = applyLayers(base, layers, (message) => stderrLogger.warn(message))
  const row = effective.rows.find((entry) => entry.plugin.name === 'persistence-jsonl' && entry.disabled !== true)
  const root = createRoot({ logger: stderrLogger })
  root.plugin(row ? row.plugin : persistenceJsonlPlugin, row ? row.config : { root: sessionsDir() })
  await root.settle()
  try {
    return use(root.get(PERSISTENCE))
  } finally {
    await root.dispose()
  }
}

/** `minidsh serve` — the JSON-RPC protocol on process stdio; stdout carries only frames. */
async function serveCommand(args: ParsedArgs): Promise<number> {
  const cwd = typeof args.flags.get('cwd') === 'string' ? (args.flags.get('cwd') as string) : process.cwd()
  const authority = authorityFlags(args)
  if (typeof authority === 'string') {
    process.stderr.write(`${authority}\n`)
    return 2
  }
  const settings = loadSettings()
  if (typeof settings === 'string') {
    process.stderr.write(`${settings}\n`)
    return 2
  }
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') {
    process.stderr.write(`${loaded}\n`)
    return 2
  }
  try {
    const host = await startProtocolHost({
      cwd,
      sessionsRoot: sessionsDir(),
      spillRoot: spillDir(),
      globalInstructionsPath: globalInstructionsPath(),
      credentialsPath: credentialsPath(),
      agentDefaults: settings.agent,
      configLayers: loaded.layers,
      approve: args.flags.get('approve') === true,
      ...authority,
      logger: stderrLogger,
    })
    await host.closed
    await host.dispose()
    return 0
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * The audit projection: what this session was permitted to do, when, and every
 * time someone was asked. An escalation names only its tool, so the command it
 * covered is joined in from the `tool/call` its `callId` points at - the same
 * join a reader would otherwise do by hand.
 */
function renderAudit(events: readonly EventEnvelope[], write: (line: string) => void): void {
  const calls = new Map<string, string>()
  const denials = new Set(['DENIED', 'ABORTED', 'FS_SANDBOX_DENIED', 'SANDBOX_ESCALATION_DENIED', 'SANDBOX_NOT_WIDER'])
  const at = (seq: number): string => String(seq).padStart(4)
  for (const event of events) {
    const data = event.data as Record<string, string | undefined>
    switch (event.type) {
      case 'tool/call':
        calls.set(String(data.callId), `${String(data.name)} ${preview(String(data.arguments), 100)}`)
        break
      case 'sandbox/mode':
        write(`${at(event.seq)}  sandbox     ${String(data.mode)} (${String(data.reason)}; shell confinement ${String(data.enforcement)})`)
        break
      case 'approval/policy':
        write(`${at(event.seq)}  approvals   ${String(data.policy)} (${String(data.reason)})`)
        break
      case 'authority/preset':
        // The intent; the knob events that follow are the truth a reader folds.
        write(`${at(event.seq)}  preset      ${String(data.name)}`)
        break
      case 'approval/asked': {
        const covered = data.callId ? calls.get(String(data.callId)) : undefined
        write(`${at(event.seq)}  asked       ${String(data.id)} ${String(data.toolName)}${data.reason ? `: ${data.reason}` : ''}`)
        if (covered) write(`                    for: ${covered}`)
        break
      }
      case 'approval/decided':
        write(`${at(event.seq)}  decided     ${String(data.id)} ${String(data.outcome)}`)
        break
      case 'tool/result': {
        const error = (event.data as { error?: { code: string } }).error
        if (error && denials.has(error.code)) {
          write(`${at(event.seq)}  denied      ${error.code}${data.callId ? ` (${calls.get(String(data.callId)) ?? ''})` : ''}`)
        }
        break
      }
      default:
        break
    }
  }
}

async function sessionsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0]
  const loaded = await loadConfigLayers(args.patchFiles)
  if (typeof loaded === 'string') {
    process.stderr.write(`${loaded}\n`)
    return 2
  }
  if (sub === 'list') {
    return withPersistence(loaded.layers, (persistence) => {
      for (const header of persistence.list()) {
        process.stdout.write(`${header.id}\t${new Date(header.createdAt).toISOString()}\t${header.cwd}\n`)
      }
      return 0
    })
  }
  if (sub === 'show') {
    const id = args.positional[1]
    if (!id) {
      process.stderr.write('usage: minidsh sessions show <id> [--json|--audit]\n')
      return 2
    }
    return withPersistence(loaded.layers, (persistence) => {
      const stored = persistence.load(id)
      if (!stored) {
        process.stderr.write(`no session "${id}"\n`)
        return 1
      }
      if (args.flags.get('audit') === true) {
        process.stdout.write(`authority of ${stored.header.id} (cwd ${stored.header.cwd})\n`)
        renderAudit(stored.events, (line) => process.stdout.write(line + '\n'))
      } else if (args.flags.get('json') === true) {
        for (const event of stored.events) process.stdout.write(`${JSON.stringify({ sessionId: stored.header.id, event })}\n`)
        // Machine readers must see damage too: a trailer object (no `event` field) a frame consumer skips.
        if (stored.damaged) process.stdout.write(`${JSON.stringify({ sessionId: stored.header.id, damaged: true })}\n`)
      } else {
        process.stdout.write(`session ${stored.header.id} (cwd ${stored.header.cwd})\n`)
        // What this session cost and how full its context got. The window is
        // not known off-line (it is a live adapter fact), so the ratio is
        // omitted and only the measured numbers are printed.
        const metrics = meterSession(stored.events, 0)
        if (metrics.sessionInput + metrics.sessionOutput + metrics.sessionCacheRead > 0) {
          process.stdout.write(
            `usage: ${formatTokens(metrics.sessionInput)} in · ${formatTokens(metrics.sessionCacheRead)} cached · ` +
              `${formatTokens(metrics.sessionOutput)} out · context now ~${formatTokens(metrics.projectedTokens)}\n`,
          )
        }
        for (const event of stored.events) {
          const line = renderEvent(event)
          process.stdout.write(`${String(event.seq).padStart(4)}  ${event.type}${line ? ` ${line.trim()}` : ''}\n`)
        }
        if (stored.damaged) process.stderr.write('warning: the stored log is damaged beyond this point\n')
      }
      return 0
    })
  }
  process.stderr.write('usage: minidsh sessions <list|show>\n')
  return 2
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
          '  minidsh run "<task>" [--cwd dir] [--model id] [--effort id] [--max-steps n] [--sandbox mode] [--ask ask|never] [--preset name] [--agent-preset name] [--approve] [--json]\n' +
          '  minidsh chat ["<task>"] [--cwd dir] [--model id] [--effort id] [--sandbox mode] [--ask ask|never] [--agent-preset name] [--approve]\n' +
          '  minidsh resume <id> ["<task>"] [--headless] [--model id] [--effort id] [--max-steps n] [--preset name] [--agent-preset name] [--approve] [--json]\n' +
          '  minidsh fork <id> ["<task>"] [--at seq] [--headless] [--model id] [--effort id] [--max-steps n] [--preset name] [--agent-preset name] [--approve] [--json]\n' +
          '  minidsh serve [--cwd dir] [--sandbox mode] [--ask ask|never] [--approve]\n' +
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
