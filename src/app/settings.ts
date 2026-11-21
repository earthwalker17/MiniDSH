/**
 * Boot-time settings: the user layer over the built-in agent defaults,
 * resolved ONCE at process entry and passed down as plain values
 * (`BootOptions.agentDefaults`). Settings are never authority (they cannot
 * touch sandbox/approval) and never composition (rows live in
 * composition.json); on a resumed session they sit in the DEFAULTS tier, so
 * the log's folded base route (`agent/options`; `request/header` for a log
 * from before that record) always wins and a settings.json edit can never
 * silently rewrite what a session recorded. Precedence: flags (applied at the
 * call sites) → environment (`MINIDSH_MODEL`) → settings.json → built-ins.
 *
 * This is the BOOT-time read. The same file is a runtime service too
 * (`core/settings`, provided by `settings-local`, which reads and writes it):
 * the boot registers the `agent` namespace there with `agentSettingsSchema`
 * (`headless.ts` `registerAgentSettings`), and a surface that changes a
 * setting writes through that service, never through this module.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { mergeAgentOptions, type AgentOptions } from '../core/agent/index.ts'
import { defaultAgentOptions } from './compose.ts'

/** The `agent` namespace's USER layer: every field optional, because a layer states only overrides. */
const agentLayerSchema = z.strictObject({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().optional(),
  maxParallelToolCalls: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
})

/**
 * The `agent` namespace's RESOLVED value — the layer merged over the base a
 * boot registered. A route always names a provider and a model, so those are
 * required here and optional above; this is what a wire write is validated
 * against before anything is persisted.
 */
export const agentSettingsSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().optional(),
  maxParallelToolCalls: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
})

const settingsSchema = z.strictObject({
  agent: agentLayerSchema.optional(),
  /**
   * Per-namespace write revisions, the store's own bookkeeping. Read here only
   * so a document a wire client wrote still loads at boot.
   */
  revisions: z.record(z.string(), z.number().int().nonnegative()).optional(),
})

export type SettingsFile = z.infer<typeof settingsSchema>

export interface ResolvedSettings {
  /** The default agent options every surface shares (protocol `initialize` included). */
  readonly agent: AgentOptions
  /**
   * The BASE the runtime settings store is registered with: the pure built-ins.
   * The store applies settings.json as its own user layer, so anything already
   * merged here would be applied twice.
   */
  readonly agentBase: AgentOptions
  /**
   * What outranks the file — today just `MINIDSH_MODEL`. The store's two layers
   * cannot express it (a user layer always wins over its base), so it travels
   * separately and is applied ABOVE whatever the store resolves. Precedence
   * stays one statement in one place instead of an accident of merge order.
   */
  readonly agentOverrides: Partial<AgentOptions>
}

export interface ResolveSettingsOptions {
  /** settings.json path; omitted (or the file missing) = built-ins + environment only. */
  readonly path?: string
  /** Environment (default `process.env`); `MINIDSH_MODEL` overrides the file's model. */
  readonly env?: Record<string, string | undefined>
  /** Hears the one thing this read tolerates and a person should still know: an empty file read as no settings. */
  readonly warn?: (message: string) => void
}

/**
 * A missing file is absent; one that is there and cannot be read, or holds
 * bytes that are not the settings document, throws naming the path — broken
 * config surfaces as broken, never hidden. Two shapes are read rather than
 * refused, in step with the runtime store that owns this file
 * (`settings-local` `document()`), because this read gates every command:
 * a leading byte-order mark, and an EMPTY file, which is what a power cut
 * leaves of a document replaced without a sync (every version before 2.0
 * wrote it that way). Refusing that stopped every command at boot until a
 * person found the file and deleted it by hand.
 */
function readSettingsFile(path: string, warn: (message: string) => void): SettingsFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return {}
    throw new Error(`settings file ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  if (raw.trim().length === 0) {
    // The store's own words, so the two readers of one file say one thing.
    warn(`settings file ${path} is empty; it is read as no settings, and the next change saved replaces it`)
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`settings file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const result = settingsSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new Error(`settings file ${path} is invalid: ${issues}`)
  }
  return result.data
}

const present = (value: string | undefined): string | undefined => (value !== undefined && value.length > 0 ? value : undefined)

export function resolveSettings(options: ResolveSettingsOptions = {}): ResolvedSettings {
  const file = options.path === undefined ? {} : readSettingsFile(options.path, options.warn ?? (() => {}))
  const env = options.env ?? process.env
  const builtins = defaultAgentOptions()
  const model = present(env.MINIDSH_MODEL)
  const layer = file.agent ?? {}
  // Every field the layer may carry travels, or the same file would mean two
  // different things to the CLI and to the wire.
  const fromFile: AgentOptions = {
    provider: layer.provider ?? builtins.provider,
    model: layer.model ?? builtins.model,
    ...(layer.reasoningEffort === undefined ? {} : { reasoningEffort: layer.reasoningEffort }),
    ...(layer.maxSteps === undefined ? {} : { maxSteps: layer.maxSteps }),
    ...(layer.maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls: layer.maxParallelToolCalls }),
    ...(layer.maxTokens === undefined ? {} : { maxTokens: layer.maxTokens }),
    ...(layer.temperature === undefined ? {} : { temperature: layer.temperature }),
  }
  return {
    agentBase: builtins,
    agentOverrides: model === undefined ? {} : { model },
    // The environment still wins over the file, as it always has — but through
    // the SAME merge every other path takes, so it drops an effort the file
    // named for the route it is replacing. A hand-rolled merge here resolved
    // one settings.json plus one `MINIDSH_MODEL` into two different routes
    // depending on which surface read it, and the CLI's carried a DeepSeek
    // effort id onto an Anthropic model, which that adapter refuses per step.
    agent: model === undefined ? fromFile : mergeAgentOptions(fromFile, { model }),
  }
}
