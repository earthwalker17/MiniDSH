/**
 * Skill discovery: which `SKILL.md` directories a session in a cwd may be
 * offered, which it may not, and why.
 *
 * **Roots and precedence.** `user` > `bundled` > `workspace`. The first two
 * come from the row config — the app fills the deployment's home and package
 * directories there after layering (`app/compose.ts` `fillSkillRoots`), so a
 * capability never resolves a home for itself. Workspace roots are each
 * `workspaceDirs` entry in each directory from the cwd up to the project root,
 * the NEAREST directory first, so a package's own skill beats its monorepo's.
 * A repository can add skills and can never replace one the user or the
 * package installed: a repo skill whose name is held is not listed, and only
 * the operator hears about it. That is the trust boundary in one rule — what
 * a checkout says is context, and a checkout may not rewrite the know-how the
 * operator chose.
 *
 * **One level deep.** `<root>/<dir>/SKILL.md`, as the open format lays it out.
 * Dot-directories and `node_modules` are skipped; an entry typed `other` (a
 * symlink, a Windows junction) is followed by listing it, because a symlinked
 * skill directory is how people install one they keep elsewhere. The same
 * canonical `SKILL.md` reached twice is read once, by the root that reached
 * it first.
 *
 * **The failure rule, and why it is narrow.** Absence and failure are decided
 * by `listDir`'s errno ALONE. `LocalFs.stat` swallows every error into
 * "absent" and `readBytes` maps every failure to `FS_NOT_FOUND`
 * (`fs-local/index.ts`), so neither can tell a missing directory from one the
 * host refused to show. Guessing "absent" from them would read a transient
 * EACCES as "every skill was removed" and retire a list the model is using.
 * So: a root whose listing fails ENOENT/ENOTDIR is absent; any other failure,
 * and a `SKILL.md` a listing showed but a read could not return, makes the
 * scan INCOMPLETE — and an incomplete scan changes nothing the model sees.
 * `stat` is consulted only as a size hint before a read, never to decide.
 *
 * Reads go through `readBytes`, which emits no `fs/observed`: the runtime
 * reading a skill's front-matter is not the model reading the file, and must
 * not hand out a read-before-edit token for it.
 */
import { join, dirname } from 'node:path'
import type { DirEntry, Fs, FsTarget } from '../../core/fs/index.ts'
import { isSkillName, parseSkillFile } from './frontmatter.ts'

export type SkillOrigin = 'user' | 'bundled' | 'workspace'

/** A configured root. `workspace` is never configured this way: those roots are derived from the cwd. */
export interface SkillRoot {
  readonly path: string
  readonly origin: 'user' | 'bundled'
}

export interface SkillEntry {
  readonly name: string
  readonly description: string
  /** The canonical absolute `SKILL.md`, as the fs provider resolved it: what the model reads. */
  readonly path: string
  readonly origin: SkillOrigin
}

export interface SkippedSkill {
  readonly path: string
  readonly reason: string
}

export interface ScannedRoot {
  readonly path: string
  readonly origin: SkillOrigin
  /** False when the listing said ENOENT/ENOTDIR; a root that failed otherwise is present and made the scan incomplete. */
  readonly present: boolean
}

export interface SkillDiscovery {
  /** False when some listing or read failed for a reason other than absence; the caller must then change nothing. */
  readonly complete: boolean
  /** In precedence order, then by name: the order the list renders in. */
  readonly listed: SkillEntry[]
  readonly skipped: SkippedSkill[]
  readonly roots: ScannedRoot[]
}

export interface DiscoveryConfig {
  readonly roots?: readonly SkillRoot[] | undefined
  readonly workspaceDirs?: readonly string[] | undefined
  readonly projectRootMarkers?: readonly string[] | undefined
  readonly exclude?: readonly string[] | undefined
  readonly maxSkillBytes?: number | undefined
}

export const DEFAULT_WORKSPACE_DIRS = ['.agents/skills', '.claude/skills'] as const
const DEFAULT_ROOT_MARKERS = ['.git'] as const
export const DEFAULT_MAX_SKILL_BYTES = 256 * 1024
/** Per root. A directory of thousands is not a skill collection anyone meant to show a model. */
export const MAX_ENTRIES_PER_ROOT = 200
/** A walk that never terminates on a pathological mount is worse than one that stops early. */
const MAX_WALK_DEPTH = 64

export const ORIGIN_RANK: Readonly<Record<SkillOrigin, number>> = { user: 0, bundled: 1, workspace: 2 }

/** What a listing failure means: only these two say "nothing is there". */
function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function describeFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.message : String(error)
}

/** Plain code-unit order: the same on every host and locale, so the list is byte-stable. */
function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Directories from `cwd` up to the project root, NEAREST first — the same walk
 * as `workspace-instructions`' `scopeChain`, read the other way round, because
 * here the nearest wins outright instead of reading last.
 */
async function nearestFirst(fs: Fs, cwd: string, markers: readonly string[]): Promise<string[]> {
  const chain: string[] = []
  let current = cwd
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    chain.push(current)
    for (const marker of markers) {
      if (await fs.stat(fs.resolve(join(current, marker), current))) return chain
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // No marker found: the cwd is its own root, and nothing above it is searched.
  return [cwd]
}

interface Candidate {
  readonly name: string
  readonly description: string
  readonly disableModelInvocation: boolean
  readonly path: string
  readonly origin: SkillOrigin
}

export async function discoverSkills(fs: Fs, cwd: string, config: DiscoveryConfig): Promise<SkillDiscovery> {
  const maxSkillBytes = config.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES
  const exclude = new Set(config.exclude ?? [])
  const skipped: SkippedSkill[] = []
  const roots: ScannedRoot[] = []
  let complete = true
  const incomplete = (path: string, why: string): void => {
    complete = false
    skipped.push({ path, reason: `${why}; the scan is incomplete, so the list a session already has stands` })
  }

  // Configured roots by origin rank, stably: `user` outranks `bundled` whatever
  // order a patch wrote them in.
  const ordered: { path: string; origin: SkillOrigin }[] = [...(config.roots ?? [])].toSorted((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin])
  try {
    for (const dir of await nearestFirst(fs, cwd, config.projectRootMarkers ?? DEFAULT_ROOT_MARKERS)) {
      for (const sub of config.workspaceDirs ?? DEFAULT_WORKSPACE_DIRS) ordered.push({ path: join(dir, sub), origin: 'workspace' })
    }
  } catch (error) {
    // `fs.resolve` refuses a path whose identity the host will not disclose.
    incomplete(cwd, `the walk to the project root failed (${describeFailure(error)})`)
  }

  const candidates: Candidate[] = []
  const seenFiles = new Map<string, string>()
  for (const root of ordered) {
    let target: FsTarget
    try {
      target = fs.resolve(root.path, cwd)
    } catch (error) {
      roots.push({ path: root.path, origin: root.origin, present: true })
      incomplete(root.path, `the root cannot be resolved (${describeFailure(error)})`)
      continue
    }
    let entries: DirEntry[]
    try {
      entries = await fs.listDir(target)
    } catch (error) {
      const absent = isAbsence(error)
      roots.push({ path: target.path, origin: root.origin, present: !absent })
      if (!absent) incomplete(target.path, `the root cannot be listed (${describeFailure(error)})`)
      continue
    }
    roots.push({ path: target.path, origin: root.origin, present: true })
    const dirs = entries
      .filter((entry) => entry.type !== 'file' && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .toSorted(byName)
    if (dirs.length > MAX_ENTRIES_PER_ROOT) {
      skipped.push({ path: target.path, reason: `${dirs.length - MAX_ENTRIES_PER_ROOT} entries past the first ${MAX_ENTRIES_PER_ROOT} of this root were not read` })
    }
    for (const entry of dirs.slice(0, MAX_ENTRIES_PER_ROOT)) {
      const found = await readCandidate(fs, cwd, target.path, entry, root.origin, maxSkillBytes)
      if (found.kind === 'none') continue
      if (found.kind === 'incomplete') {
        incomplete(found.path, found.reason)
        continue
      }
      if (found.kind === 'skip') {
        skipped.push({ path: found.path, reason: found.reason })
        continue
      }
      const first = seenFiles.get(found.candidate.path)
      if (first !== undefined) {
        skipped.push({ path: join(target.path, entry.name), reason: `the same SKILL.md as ${first}, already read` })
        continue
      }
      seenFiles.set(found.candidate.path, join(target.path, entry.name))
      candidates.push(found.candidate)
    }
  }

  // Name precedence, in the order the roots were read: the first holder of a
  // name keeps it. A hidden or excluded holder still holds it — a user skill
  // named like a bundled one replaces it whether or not it is itself listed,
  // which is how a person retires a bundled skill without deleting a file.
  const holders = new Map<string, Candidate>()
  const listed: SkillEntry[] = []
  for (const candidate of candidates) {
    const holder = holders.get(candidate.name)
    if (holder !== undefined) {
      const reason =
        holder.origin === 'user' && candidate.origin === 'bundled'
          ? `replaced by user skill ${holder.path}`
          : candidate.origin === 'workspace' && holder.origin === 'workspace'
            ? `name "${candidate.name}" held by a nearer workspace skill ${holder.path}`
            : `name "${candidate.name}" held by ${holder.origin} skill ${holder.path}`
      skipped.push({ path: candidate.path, reason })
      continue
    }
    holders.set(candidate.name, candidate)
    if (candidate.disableModelInvocation) {
      skipped.push({ path: candidate.path, reason: 'disable-model-invocation is set' })
      continue
    }
    if (exclude.has(candidate.name)) {
      skipped.push({ path: candidate.path, reason: `"${candidate.name}" is excluded by the skills row` })
      continue
    }
    listed.push({ name: candidate.name, description: candidate.description, path: candidate.path, origin: candidate.origin })
  }
  listed.sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || byName(a, b))
  return { complete, listed, skipped, roots }
}

type Read =
  | { readonly kind: 'none' }
  | { readonly kind: 'skip'; readonly path: string; readonly reason: string }
  | { readonly kind: 'incomplete'; readonly path: string; readonly reason: string }
  | { readonly kind: 'candidate'; readonly candidate: Candidate }

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** One `<root>/<entry>`: not a skill, a skip with its reason, an incomplete read, or a candidate. */
async function readCandidate(fs: Fs, cwd: string, rootPath: string, entry: DirEntry, origin: SkillOrigin, maxSkillBytes: number): Promise<Read> {
  const spelled = join(rootPath, entry.name)
  let dir: FsTarget
  let children: DirEntry[]
  try {
    dir = fs.resolve(spelled, cwd)
  } catch (error) {
    return { kind: 'incomplete', path: spelled, reason: `cannot be resolved (${describeFailure(error)})` }
  }
  try {
    children = await fs.listDir(dir)
  } catch (error) {
    // A link to a file, or a dangling one: not a skill directory, and nothing
    // the operator needs telling about.
    if (isAbsence(error)) return { kind: 'none' }
    return { kind: 'incomplete', path: spelled, reason: `cannot be listed (${describeFailure(error)})` }
  }
  const file = children.find((child) => child.name === 'SKILL.md')
  if (!file || file.type === 'directory') return { kind: 'skip', path: spelled, reason: 'no SKILL.md in this directory' }
  let skill: FsTarget
  try {
    skill = fs.resolve(join(dir.path, 'SKILL.md'), cwd)
  } catch (error) {
    return { kind: 'incomplete', path: spelled, reason: `its SKILL.md cannot be resolved (${describeFailure(error)})` }
  }
  // A size hint only: `stat` cannot say why it failed, so its silence decides nothing.
  const info = await fs.stat(skill)
  if (info !== undefined && info.size > maxSkillBytes) return { kind: 'skip', path: skill.path, reason: `larger than ${maxSkillBytes} bytes` }
  let bytes: Uint8Array
  try {
    ;({ bytes } = await fs.readBytes(skill, {}))
  } catch (error) {
    // The listing showed the file, so this is a failure, not an absence.
    return { kind: 'incomplete', path: skill.path, reason: `cannot be read (${describeFailure(error)})` }
  }
  if (bytes.byteLength > maxSkillBytes) return { kind: 'skip', path: skill.path, reason: `larger than ${maxSkillBytes} bytes` }
  let text: string
  try {
    text = utf8.decode(bytes)
  } catch {
    return { kind: 'skip', path: skill.path, reason: 'not valid UTF-8' }
  }
  const parsed = parseSkillFile(text)
  if (!parsed.ok) return { kind: 'skip', path: skill.path, reason: parsed.reason }
  const { frontmatter } = parsed
  const name =
    frontmatter.name !== undefined && isSkillName(frontmatter.name) ? frontmatter.name : isSkillName(entry.name) ? entry.name : undefined
  if (name === undefined) {
    const spelledName = frontmatter.name === undefined ? '' : `front-matter "${frontmatter.name.slice(0, 80)}" and `
    return { kind: 'skip', path: skill.path, reason: `no valid name (${spelledName}directory "${entry.name}"; lowercase letters, digits and inner hyphens, at most 64)` }
  }
  if (frontmatter.description === undefined) return { kind: 'skip', path: skill.path, reason: 'no description' }
  return {
    kind: 'candidate',
    candidate: { name, description: frontmatter.description, disableModelInvocation: frontmatter.disableModelInvocation, path: skill.path, origin },
  }
}
