/**
 * Boot-time settings: the user layer over the built-in agent defaults,
 * resolved ONCE at process entry and passed down as plain values
 * (`BootOptions.agentDefaults`). Settings are never authority (they cannot
 * touch sandbox/approval) and never composition (rows live in
 * composition.json); on a resumed session they sit in the DEFAULTS tier, so
 * the log's folded `request/header` always wins and a settings.json edit can
 * never silently rewrite what a session recorded. Precedence: flags (applied
 * at the call sites) → environment → settings.json → built-ins. Promotion to
 * a `core/settings` Definition is deferred to the first runtime consumer
 * (S6 model roles).
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
}

/** A malformed file throws naming the path — broken config surfaces as broken, never hidden. */
function readSettingsFile(path: string): SettingsFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
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
  const file = options.path === undefined ? {} : readSettingsFile(options.path)
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
