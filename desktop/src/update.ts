/**
 * Help ▸ Check for Updates: one GET of the repository's latest GitHub release,
 * a version comparison, and — when newer — the release page's URL for main
 * to open. Manual and read-only: nothing is downloaded or installed, because
 * an unsigned build gets no updater (an update channel that cannot verify
 * what it installs is a code-execution channel).
 *
 * The URL that main will hand the OS is validated here to the repository's
 * own releases pages, so a tampered or surprising response cannot send the
 * person anywhere else.
 *
 * Owns: the request, its reading and the comparison. Must not own: the
 * dialog (main) or the transport's proxy and certificate store (main injects
 * Electron's `net.fetch`, which uses the OS's).
 */
import type { FetchLike } from './runtime.ts'

export const LATEST_RELEASE_API = 'https://api.github.com/repos/earthwalker17/MiniDSH/releases/latest'
export const RELEASES_PAGE_PREFIX = 'https://github.com/earthwalker17/MiniDSH/releases/'

const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parts(version: string): { core: [number, number, number]; pre: string[] } {
  const match = VERSION.exec(version)
  if (match === null) throw new TypeError(`not an x.y.z version: ${JSON.stringify(version)}`)
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split('.') }
}

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0)

/** Semver precedence of prerelease identifiers: numeric below alphanumeric, numerics by value. */
function comparePre(a: string[], b: string[]): -1 | 0 | 1 {
  // A release sorts above any of its prereleases.
  if (a.length === 0 || b.length === 0) return sign(b.length - a.length)
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return sign(Number(x) - Number(y))
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return sign(a.length - b.length)
}

/** `x.y.z[-pre][+build]`, an optional leading `v`; throws on anything else. Build metadata is ignored. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return sign(x.core[i]! - y.core[i]!)
  return comparePre(x.pre, y.pre)
}

export interface LatestRelease {
  /** Without the `v`. */
  readonly version: string
  /** The release page, validated to this repository's releases. */
  readonly url: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The API's answer to a release, or `undefined` when it is not one this app would act on. */
export function parseLatestRelease(json: unknown): LatestRelease | undefined {
  if (!isRecord(json) || json.draft === true || json.prerelease === true) return undefined
  const tag = typeof json.tag_name === 'string' ? /^v(\d{1,9}\.\d{1,9}\.\d{1,9})$/.exec(json.tag_name) : null
  if (tag === null || typeof json.html_url !== 'string' || !json.html_url.startsWith(RELEASES_PAGE_PREFIX)) return undefined
  // Checked again AFTER parsing: `…/releases/../../elsewhere` passes the
  // prefix as text and is somewhere else as a URL.
  const url = URL.parse(json.html_url)
  if (url === null || url.username !== '' || url.password !== '' || !url.href.startsWith(RELEASES_PAGE_PREFIX)) return undefined
  return { version: tag[1]!, url: url.href }
}

export type UpdateCheck =
  | { readonly kind: 'current' }
  | { readonly kind: 'newer'; readonly version: string; readonly url: string }
  | { readonly kind: 'error'; readonly message: string }

export async function checkForUpdate({ current, fetchImpl = fetch, timeoutMs = 10_000 }: { readonly current: string; readonly fetchImpl?: FetchLike; readonly timeoutMs?: number }): Promise<UpdateCheck> {
  let response: Response
  try {
    response = await fetchImpl(LATEST_RELEASE_API, {
      headers: { 'User-Agent': 'MiniDSH-Desktop', Accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { kind: 'error', message: 'GitHub could not be reached.' }
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return { kind: 'error', message: 'No release has been published yet.' }
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    return { kind: 'error', message: `GitHub answered ${response.status}${response.status === 403 || response.status === 429 ? ' (rate limited; try again later)' : ''}.` }
  }
  let release: LatestRelease | undefined
  try {
    release = parseLatestRelease(await response.json())
  } catch {
    release = undefined
  }
  if (release === undefined) return { kind: 'error', message: 'The release information was not understood.' }
  try {
    return compareVersions(release.version, current) > 0 ? { kind: 'newer', version: release.version, url: release.url } : { kind: 'current' }
  } catch {
    return { kind: 'error', message: `This build's version (${current}) is not comparable.` }
  }
}
