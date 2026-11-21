/**
 * Declarative composition: the disk vocabulary (`composition.json`), the
 * layer algorithm with per-row provenance, the plugin reference resolver
 * (builtin catalog, then module import), and the JSON-safe descriptor a
 * session records. A composition file is code-equivalent trust — an insert
 * can load a module and run it — and it is an INPUT, never a persistence
 * target: nothing here writes it back. There is no workspace layer: a
 * repository may say how it likes its code (`AGENTS.md`, skills), never what
 * the harness may do.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Context, Plugin } from '../kernel/index.ts'
import { snapshotJson } from '../core/json.ts'
import type { CompositionApplied } from '../capabilities/composition-record/index.ts'
import type { SkillRoot } from '../capabilities/skills/index.ts'
import {
  applyExplicitAuthority,
  applyPatches,
  builtinPlugins,
  fillDeploymentDefaults,
  fillSkillRoots,
  type DeploymentDefaults,
  type ExplicitAuthority,
  type Patch,
  type Row,
} from './compose.ts'
import { VERSION } from './version.ts'

const diskRowSchema = z.strictObject({
  id: z.string().min(1),
  /** Builtin plugin name, or a module specifier (relative paths resolve against the file's directory). */
  plugin: z.string().min(1),
  config: z.unknown().optional(),
  disabled: z.boolean().optional(),
})

const diskPatchSchema = z.union([
  z.strictObject({ id: z.string().min(1), config: z.unknown().optional(), disabled: z.boolean().optional() }),
  z.strictObject({ insert: z.array(diskRowSchema) }),
])

const compositionFileSchema = z.strictObject({
  patches: z.array(diskPatchSchema).optional(),
  /** Named per-agent row lists, mounted on an agent's scope at setup (`--agent-preset`). */
  agentPresets: z.record(z.string().min(1), z.array(diskRowSchema)).optional(),
})

export type DiskRow = z.infer<typeof diskRowSchema>
export type CompositionFile = z.infer<typeof compositionFileSchema>

/**
 * A missing file is absent; one that is there and cannot be read, or is
 * malformed, throws naming the path — broken config surfaces, never hides.
 * Only "not there" is absence: a home layer that narrows authority (a
 * read-only default, a disabled shell) and could not be opened (EACCES after a
 * restore under another owner, a sharing violation on Windows, a directory in
 * its place) used to boot the wider built-ins without a word.
 */
export function loadCompositionFile(path: string): CompositionFile | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ENOTDIR: a component of the path is a file, so nothing can be at it.
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new Error(`composition file ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  // One leading byte-order mark is an editor's habit (Notepad, Windows
  // PowerShell's `Set-Content -Encoding UTF8`), not a syntax error, and this
  // file is hand-edited by design.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`composition file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const result = compositionFileSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new Error(`composition file ${path} is invalid: ${issues}`)
  }
  return result.data
}

function isPluginShaped(value: unknown): value is Plugin<unknown> {
  return (
    typeof value === 'object' && value !== null && typeof (value as Plugin<unknown>).name === 'string' && typeof (value as Plugin<unknown>).apply === 'function'
  )
}

/**
 * A builtin name, or a module specifier: path-like refs resolve against
 * `baseDir` (the composition file's directory) through a file URL — a raw
 * Windows path would parse its drive letter as a protocol. The module must
 * export exactly one plugin (default preferred). Plugin authors write
 * erasable-syntax TypeScript (Node strips types outside node_modules) and
 * import repo modules by absolute `file://` URL or not at all.
 */
export async function resolvePluginRef(ref: string, baseDir: string): Promise<Plugin<unknown>> {
  const builtin = builtinPlugins.get(ref)
  if (builtin) return builtin
  const pathLike = ref.startsWith('.') || isAbsolute(ref)
  const specifier = pathLike ? pathToFileURL(resolve(baseDir, ref)).href : ref
  let module: Record<string, unknown>
  try {
    module = (await import(specifier)) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `plugin "${ref}" is not a builtin and could not be imported from ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (isPluginShaped(module.default)) return module.default
  const candidates = Object.values(module).filter(isPluginShaped)
  if (candidates.length === 1) return candidates[0]!
  throw new Error(`module ${specifier} must export exactly one plugin (default or named); found ${candidates.length}`)
}

/** Disk patches to runtime patches: inserts resolve their plugin references (the only async step). */
export async function toPatches(file: CompositionFile, baseDir: string): Promise<Patch[]> {
  const patches: Patch[] = []
  for (const patch of file.patches ?? []) {
    if ('insert' in patch) {
      const rows: Row[] = []
      for (const row of patch.insert) rows.push(await toRow(row, baseDir))
      patches.push({ insert: rows })
    } else {
      patches.push({
        id: patch.id,
        ...(patch.config === undefined ? {} : { config: patch.config }),
        ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
      })
    }
  }
  return patches
}

export async function toRow(row: DiskRow, baseDir: string): Promise<Row> {
  return {
    id: row.id,
    plugin: await resolvePluginRef(row.plugin, baseDir),
    ...(row.config === undefined ? {} : { config: row.config }),
    ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
  }
}

/**
 * Per-agent world from a named preset: mounts the rows on the agent scope
 * during creation. Registrations and services live and die with that agent
 * (the scope contract); the factory's scoped fail-loud settle is the gate for
 * unmet dependencies. Host-plane rows do not belong here — a service provided
 * in the scope shadows only for scope-mounted plugins, so a preset
 * structurally cannot widen enforcement (asserted by test).
 */
export function agentPresetWorld(rows: readonly Row[]): (agentCtx: Context) => void {
  return (agentCtx) => {
    for (const row of rows) {
      if (row.disabled) continue
      agentCtx.plugin(row.plugin, row.config)
    }
  }
}

export interface NamedLayer {
  readonly name: string
  readonly patches: readonly Patch[]
}

export interface EffectiveComposition {
  readonly rows: Row[]
  /** Row id → the layer that last touched it (`built-in` when none did). */
  readonly provenance: ReadonlyMap<string, string>
  readonly descriptor: CompositionApplied
}

export const BASE_LAYER = 'built-in'

/**
 * The one layering algorithm boot and `minidsh config` share: `applyPatches`
 * per layer, provenance recorded, duplicate ids refused (a duplicate is
 * half-patchable — the patch reaches the first, the mount runs both).
 */
export function applyLayers(base: readonly Row[], layers: readonly NamedLayer[], warn: (message: string) => void): EffectiveComposition {
  const provenance = new Map<string, string>()
  for (const row of base) provenance.set(row.id, BASE_LAYER)
  let rows = base.map((row) => ({ ...row }))
  for (const layer of layers) {
    const before = new Map(rows.map((row) => [row.id, row]))
    rows = applyPatches(rows, layer.patches, (message) => warn(`${layer.name}: ${message}`))
    for (const patch of layer.patches) {
      if ('insert' in patch) continue
      const target = before.get(patch.id)
      if (!target) continue
      // A touch is a CHANGE: a patch that restates the row as it already was
      // (`disabled: false` on an enabled row, a byte-identical config) is not
      // something to flag. Configs compare by the same canonical JSON the
      // composition hash uses; one that cannot snapshot compares by reference.
      const changed =
        (patch.config !== undefined && !sameConfig(patch.config, target.config)) || (patch.disabled !== undefined && patch.disabled !== (target.disabled ?? false))
      if (changed) provenance.set(patch.id, layer.name)
    }
    for (const row of rows) {
      if (!before.has(row.id)) provenance.set(row.id, layer.name)
    }
  }
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`composition has duplicate row id "${row.id}"`)
    seen.add(row.id)
  }
  return { rows, provenance, descriptor: describeComposition(rows, [BASE_LAYER, ...layers.map((layer) => layer.name)]) }
}

/** What this command line and this deployment say about the rows, beside the layers. */
export interface Deployment extends DeploymentDefaults {
  readonly skillRoots?: readonly SkillRoot[] | undefined
  /** The explicit authority flags; they win over every layer for the keys they name. */
  readonly flags?: ExplicitAuthority | undefined
}

/**
 * The last step of layering, shared by a boot and by `minidsh config` so the
 * two cannot disagree about a row or about the hash a session records: the
 * deployment's defaults filled where a layer's whole-config patch left none
 * (`fillSkillRoots`, `fillDeploymentDefaults`), then the explicit authority
 * flags (`applyExplicitAuthority`). The descriptor is re-derived from the
 * resulting rows, so the hash a session records, and the one `minidsh config`
 * prints, name the skill roots that session was actually offered from.
 * Provenance is untouched: filling an omitted value is the deployment's
 * default, not a layer's change. `warn` hears one line per key a flag took
 * from a layer.
 */
export function withDeployment(effective: EffectiveComposition, deployment: Deployment, warn: (message: string) => void): EffectiveComposition {
  let rows = fillDeploymentDefaults(effective.rows, deployment)
  if (deployment.skillRoots !== undefined) rows = fillSkillRoots(rows, deployment.skillRoots)
  rows = applyExplicitAuthority(rows, deployment.flags ?? {}, ({ row, flag, key, was }) => {
    const layer = effective.provenance.get(row.id)
    // Only a LAYER is overridden. A built-in row no layer touched holds the
    // app's own default (`approve: false`), and a flag over that is no news.
    if (layer === undefined || layer === BASE_LAYER) return
    warn(`${flag} wins over layer "${layer}", which sets ${key}: ${JSON.stringify(was)} on row "${row.id}"`)
  })
  return { rows, provenance: effective.provenance, descriptor: describeComposition(rows, effective.descriptor.layers) }
}

function sameConfig(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(canonical(snapshotJson(a ?? null))) === JSON.stringify(canonical(snapshotJson(b ?? null)))
  } catch {
    return false
  }
}

/** Stable key order, so hashing never depends on object construction order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]))
  }
  return value
}

/**
 * The JSON-safe descriptor a session records. Configs are hashed, never
 * inlined; a config that cannot snapshot to JSON (live streams, callbacks —
 * the protocol row) hashes by presence (`opaqueConfig`), so a per-boot
 * closure does not churn the hash. Row order is significant — it IS the
 * composition.
 */
export function describeComposition(rows: readonly Row[], layers: readonly string[]): CompositionApplied {
  const hashed = rows.map((row) => {
    let config: unknown = null
    let opaque = false
    try {
      config = snapshotJson(row.config ?? null)
    } catch {
      opaque = true
    }
    return { id: row.id, plugin: row.plugin.name, disabled: row.disabled === true, config, ...(opaque ? { opaqueConfig: true } : {}) }
  })
  const writer = `minidsh ${VERSION}`
  const hash = createHash('sha256').update(JSON.stringify(canonical({ writer, rows: hashed }))).digest('hex').slice(0, 16)
  return {
    hash,
    writer,
    layers: [...layers],
    rows: rows.map((row) => ({ id: row.id, plugin: row.plugin.name, ...(row.disabled === true ? { disabled: true } : {}) })),
  }
}
