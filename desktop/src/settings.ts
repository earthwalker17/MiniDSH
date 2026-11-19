/**
 * The launcher's own settings file (`<userData>/settings.json`): the folders
 * the runtime is started over, the port it listens on, and the window's
 * bounds. Nothing else is ever stored — no credential, no runtime setting
 * (those are the runtime's, under MINIDSH_HOME), no UI preference (the Web UI
 * keeps its own in the page's storage, which is why the port must be stable).
 *
 * The folders are AUTHORITY-BEARING (ARCHITECTURE §8): each becomes a
 * `--workspace` root. They are written only by main from its native dialog,
 * through `folders.ts` admission; this module only keeps them well-formed:
 * absolute, deduplicated by the platform's path identity, order kept, the
 * current folder first.
 *
 * Reading never throws. A missing file is the first run; a field that fails
 * validation is dropped ALONE and named in `problems` for the log, so one bad
 * value (a hand edit, a truncated write from an older build) costs that field,
 * not every folder. Writing is atomic: a temp file in the same directory,
 * flushed, then renamed over — a crash leaves the old file or the new one.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, win32 } from 'node:path'
import { randomBytes } from 'node:crypto'
import { folderKey } from './folders.ts'

export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly maximized: boolean
}

export interface DesktopSettings {
  readonly version: 1
  /** Workspace roots, current first. */
  readonly folders: readonly string[]
  /** The runtime's port, persisted so the Web UI's origin (and its stored theme) survives relaunches. */
  readonly port?: number
  readonly window?: WindowBounds
}

/** The launcher's port range: below Windows' dynamic range, where Hyper-V and WSL exclusions land. */
export const PORT_MIN = 20_000
/** Exclusive. */
export const PORT_MAX = 45_000

/** Past this a coordinate is a corrupted file, not a monitor layout. */
const COORDINATE_LIMIT = 100_000

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

export const isDesktopPort = (value: unknown): value is number => isInteger(value) && value >= PORT_MIN && value < PORT_MAX

export const defaultSettings = (): DesktopSettings => ({ version: 1, folders: [] })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Absolute on this platform, deduplicated by path identity, first spelling and order kept. */
export function normalizeFolders(folders: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === 'win32' ? win32 : posix
  const seen = new Set<string>()
  const out: string[] = []
  for (const folder of folders) {
    if (folder.length === 0 || folder.includes('\0') || !paths.isAbsolute(folder)) continue
    const key = folderKey(folder, platform)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(folder)
  }
  return out
}

/** `folder` made current: moved (or added) to the front. */
export function withCurrentFolder(settings: DesktopSettings, folder: string, platform: NodeJS.Platform = process.platform): DesktopSettings {
  return { ...settings, folders: normalizeFolders([folder, ...settings.folders], platform) }
}

/** `folder` removed, by path identity; the next one becomes current. */
export function withoutFolder(settings: DesktopSettings, folder: string, platform: NodeJS.Platform = process.platform): DesktopSettings {
  const key = folderKey(folder, platform)
  return { ...settings, folders: settings.folders.filter((each) => folderKey(each, platform) !== key) }
}

function windowBounds(value: unknown): WindowBounds | undefined {
  if (!isRecord(value)) return undefined
  const { x, y, width, height, maximized } = value
  const coordinate = (n: unknown): n is number => isInteger(n) && Math.abs(n) <= COORDINATE_LIMIT
  const extent = (n: unknown): n is number => isInteger(n) && n > 0 && n <= COORDINATE_LIMIT
  if (!coordinate(x) || !coordinate(y) || !extent(width) || !extent(height) || typeof maximized !== 'boolean') return undefined
  return { x, y, width, height, maximized }
}

/**
 * Any value to settings, field by field: what validates is kept, what does
 * not is dropped and named. The one validation both directions share, so a
 * value that would not read back is never written.
 */
export function sanitizeSettings(value: unknown, platform: NodeJS.Platform = process.platform): { settings: DesktopSettings; problems: string[] } {
  const problems: string[] = []
  if (!isRecord(value)) return { settings: defaultSettings(), problems: ['the settings are not a JSON object; using defaults'] }
  if (value.version !== 1) problems.push(`unknown settings version ${JSON.stringify(value.version) ?? 'undefined'}; reading the fields version 1 knows`)
  let folders: string[] = []
  if (Array.isArray(value.folders)) {
    const strings = value.folders.filter((folder): folder is string => typeof folder === 'string')
    folders = normalizeFolders(strings, platform)
    const dropped = value.folders.length - folders.length
    if (dropped > 0) problems.push(`dropped ${dropped} folder entr${dropped === 1 ? 'y' : 'ies'} that were not absolute paths or repeated one`)
  } else if (value.folders !== undefined) {
    problems.push('"folders" is not a list; ignoring it')
  }
  let settings: DesktopSettings = { version: 1, folders }
  if (value.port !== undefined) {
    if (isDesktopPort(value.port)) settings = { ...settings, port: value.port }
    else problems.push(`"port" is not an integer in [${PORT_MIN}, ${PORT_MAX}); ignoring it`)
  }
  if (value.window !== undefined) {
    const bounds = windowBounds(value.window)
    if (bounds !== undefined) settings = { ...settings, window: bounds }
    else problems.push('"window" is not a valid set of bounds; ignoring it')
  }
  return { settings, problems }
}

/** Never throws: a missing file is the defaults, anything unreadable is the defaults plus a problem. */
export function readSettings(path: string, platform: NodeJS.Platform = process.platform): { settings: DesktopSettings; problems: string[] } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: defaultSettings(), problems: [] }
    return { settings: defaultSettings(), problems: [`the settings file could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}); using defaults`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { settings: defaultSettings(), problems: ['the settings file is not valid JSON; using defaults'] }
  }
  return sanitizeSettings(parsed, platform)
}

/**
 * Atomic: the temp file sits in the same directory (a rename never crosses a
 * volume), is flushed before the rename, and is removed if anything fails.
 * Only the known fields are written; returns what sanitizing dropped.
 */
export function writeSettings(path: string, settings: DesktopSettings, platform: NodeJS.Platform = process.platform): string[] {
  const { settings: clean, problems } = sanitizeSettings(settings, platform)
  const stored = {
    version: clean.version,
    folders: clean.folders,
    ...(clean.port === undefined ? {} : { port: clean.port }),
    ...(clean.window === undefined ? {} : { window: clean.window }),
  }
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temp = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return problems
}
