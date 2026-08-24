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
import type { AgentOptions } from '../core/agent/index.ts'
import { defaultAgentOptions } from './compose.ts'

const settingsSchema = z.strictObject({
  agent: z
    .strictObject({
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      reasoningEffort: z.string().min(1).optional(),
      maxSteps: z.number().int().positive().optional(),
    })
    .optional(),
})

export type SettingsFile = z.infer<typeof settingsSchema>

export interface ResolvedSettings {
  /** The default agent options every surface shares (protocol `initialize` included). */
  readonly agent: AgentOptions
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
    throw new Error(`settings file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
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
  const base = defaultAgentOptions()
  const effort = file.agent?.reasoningEffort
  const maxSteps = file.agent?.maxSteps
  return {
    agent: {
      provider: file.agent?.provider ?? base.provider,
      model: present(env.MINIDSH_MODEL) ?? file.agent?.model ?? base.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(maxSteps === undefined ? {} : { maxSteps }),
    },
  }
}
