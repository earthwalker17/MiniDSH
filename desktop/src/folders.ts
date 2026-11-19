/**
 * Folder admission: which directories the launcher may hand the runtime as
 * workspace roots, and the path identity every launcher comparison uses.
 *
 * A folder is AUTHORITY-BEARING launcher state (ARCHITECTURE §8): it becomes
 * a `--workspace` root, and under the default `workspace-write` authority the
 * agent writes there. So admission refuses what no project folder is — a
 * drive or share root, the user profile itself — and anything that would put
 * MiniDSH's own state inside the agent's reach: Electron's userData (the
 * launcher's settings, the cookie partition), the install directory (the
 * bundled node and runtime that the next launch executes) and MINIDSH_HOME,
 * whose `composition.json` is code-equivalent trust (§9; the CLI refuses that
 * one too). Paths are canonicalized through realpath first, so a junction or
 * a differently-cased spelling cannot walk around a refusal.
 *
 * Owns: admission and the platform's path identity. Must not own: where the
 * path came from (main's native dialog, never IPC or argv) or persistence
 * (`settings.ts`). Electron-free; `boundsVisible` is the one window rule that
 * needs no Electron either, so it lives here beside the other admission.
 */
import { realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export interface FolderContext {
  /** MINIDSH_HOME as the runtime will resolve it; it need not exist yet. */
  readonly home?: string
  /** Electron's userData directory. */
  readonly userData: string
  /** Where the app is installed (the directory holding the executable). */
  readonly installDir: string
  /** The user profile root (`os.homedir()`). */
  readonly profile: string
  readonly platform: NodeJS.Platform
}

export type Admission = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }

const pathsFor = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/**
 * A path's identity on this platform, for equality and dedup: normalized, no
 * trailing separator (a root keeps its own), and case-folded on Windows,
 * whose filesystems compare case-insensitively.
 */
export function folderKey(path: string, platform: NodeJS.Platform): string {
  const paths = pathsFor(platform)
  let normalized = paths.normalize(path)
  const root = paths.parse(normalized).root
  while (normalized.length > root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether `child` is `parent` or lies beneath it, by path identity. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const paths = pathsFor(platform)
  const relation = paths.relative(folderKey(parent, platform), folderKey(child, platform))
  if (relation === '') return true
  // `..foo` is a sibling's child named `..foo`, not a climb: only a whole `..` segment leaves.
  return relation !== '..' && !relation.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relation)
}

function isRoot(path: string, platform: NodeJS.Platform): boolean {
  const paths = pathsFor(platform)
  const normalized = paths.normalize(path)
  return paths.parse(normalized).root === normalized || paths.dirname(normalized) === normalized
}

/** `\\?\C:\x` and `\\?\UNC\srv\share` as their ordinary spellings, which every other comparison uses. */
function withoutVerbatimPrefix(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`
  if (path.startsWith('\\\\?\\')) return path.slice(4)
  return path
}

export interface FolderFs {
  readonly realpath: (path: string) => string
  readonly isDirectory: (path: string) => boolean
}

const nodeFs: FolderFs = {
  realpath: (path) => realpathSync.native(path),
  isDirectory: (path) => statSync(path).isDirectory(),
}

/**
 * The canonical spelling of a path that may not exist yet (userData before the
 * first run, MINIDSH_HOME before the first session): the realpath of its
 * nearest existing ancestor, with the missing remainder joined back on.
 */
export function canonicalPath(path: string, platform: NodeJS.Platform, fs: FolderFs = nodeFs): string {
  const paths = pathsFor(platform)
  let existing = paths.resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return withoutVerbatimPrefix(paths.join(fs.realpath(existing), ...rest))
    } catch {
      const parent = paths.dirname(existing)
      if (parent === existing) return withoutVerbatimPrefix(paths.resolve(path))
      rest.unshift(paths.basename(existing))
      existing = parent
    }
  }
}

/**
 * The refusal for an already-canonical, existing directory, or `undefined`.
 * Pure over its inputs (every `ctx` path canonical too), so each rule is
 * tested for both platforms on any host.
 */
export function refusalFor(path: string, ctx: FolderContext): string | undefined {
  const { platform } = ctx
  if (isRoot(path, platform)) return 'A whole drive or network share cannot be a workspace. Choose a folder inside it.'
  if (folderKey(path, platform) === folderKey(ctx.profile, platform)) return 'Your whole user folder cannot be a workspace. Choose a project folder inside it.'
  const own: readonly { readonly at: string | undefined; readonly what: string; readonly inside: boolean }[] = [
    { at: ctx.userData, what: "MiniDSH's app data", inside: true },
    { at: ctx.installDir, what: 'the MiniDSH installation', inside: true },
    // The agent may not reach composition.json, which is trusted as code. A
    // folder INSIDE the home is not refused here: the CLI owns that rule.
    { at: ctx.home, what: "MiniDSH's home folder (its settings are trusted as code)", inside: false },
  ]
  for (const { at, what } of own) if (at !== undefined && isWithin(at, path, platform)) return `That folder contains ${what}. Choose a project folder.`
  for (const { at, what, inside } of own) if (inside && at !== undefined && isWithin(path, at, platform)) return `That folder is inside ${what}. Choose a project folder.`
  return undefined
}

/** Admits a folder the user picked, as its canonical path, or says in one sentence why not. */
export function admitFolder(path: string, ctx: FolderContext, fs: FolderFs = nodeFs): Admission {
  const paths = pathsFor(ctx.platform)
  if (path.length === 0 || path.includes('\0') || !paths.isAbsolute(path)) return { ok: false, reason: 'That is not a full folder path.' }
  let canonical: string
  try {
    canonical = withoutVerbatimPrefix(fs.realpath(path))
    if (!fs.isDirectory(canonical)) return { ok: false, reason: 'That is not a folder.' }
  } catch {
    return { ok: false, reason: 'That folder does not exist or cannot be read.' }
  }
  const canonicalCtx: FolderContext = {
    platform: ctx.platform,
    userData: canonicalPath(ctx.userData, ctx.platform, fs),
    installDir: canonicalPath(ctx.installDir, ctx.platform, fs),
    profile: canonicalPath(ctx.profile, ctx.platform, fs),
    ...(ctx.home === undefined ? {} : { home: canonicalPath(ctx.home, ctx.platform, fs) }),
  }
  const reason = refusalFor(canonical, canonicalCtx)
  return reason === undefined ? { ok: true, path: canonical } : { ok: false, reason }
}

// ---- window bounds ------------------------------------------------------------

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The grab-able piece a restored window must keep on screen. */
const TITLE_GRIP = 64

/**
 * Whether persisted bounds would put the window somewhere a person can grab
 * it: some display's WORK AREA (taskbar excluded) must overlap the window's
 * title strip — its top 64 px — by at least 64 × 64 px (or the whole strip of
 * a smaller window). A monitor unplugged since the last run, or a resolution
 * change, otherwise restores a window nobody can see or move.
 */
export function boundsVisible(bounds: Rect, displays: readonly Rect[]): boolean {
  const numbers = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!numbers.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return false
  const strip = { x: bounds.x, y: bounds.y, width: bounds.width, height: Math.min(TITLE_GRIP, bounds.height) }
  const needWidth = Math.min(TITLE_GRIP, strip.width)
  for (const area of displays) {
    if (![area.x, area.y, area.width, area.height].every(Number.isFinite)) continue
    const width = Math.min(strip.x + strip.width, area.x + area.width) - Math.max(strip.x, area.x)
    const height = Math.min(strip.y + strip.height, area.y + area.height) - Math.max(strip.y, area.y)
    if (width >= needWidth && height >= strip.height) return true
  }
  return false
}
