/**
 * Which installed Chrome-family browser this host offers, found by path alone.
 *
 * A LOOKUP, never a launch: it runs at mount, and every boot pays for it, so it
 * only answers "is there an executable at a known place". Whether that
 * executable can actually start under this host's sandbox and policies is
 * learnt at the first launch, and a failure there is memoized for the process
 * (`BROWSER_UNAVAILABLE`) — the same answer a functional probe would give, paid
 * only by a session that browses.
 *
 * Chrome first, then Edge, then a Chromium build; the order Playwright's
 * channels and the pdf skill's probe use. Never a snap Chromium: its launcher
 * runs the browser inside snap confinement, which the debugging pipe's file
 * descriptors and the private profile directory do not reliably cross.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BrowserKind = 'chrome' | 'edge' | 'chromium'

export interface LocatedBrowser {
  readonly path: string
  readonly kind: BrowserKind
}

interface Candidate {
  readonly kind: BrowserKind
  readonly path: string
}

/** The known install locations, in preference order, for one platform. Pure: exported for the tests. */
export function candidates(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): Candidate[] {
  if (platform === 'win32') {
    // Per-user installs first (LOCALAPPDATA), then machine-wide. Deduplicated:
    // `ProgramW6432` and `ProgramFiles` name the same folder in a 64-bit process.
    const roots = [...new Set([env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter((root): root is string => root !== undefined && root !== ''))]
    return [
      ...roots.map((root) => ({ kind: 'chrome' as const, path: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })),
      ...roots.map((root) => ({ kind: 'edge' as const, path: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })),
      ...roots.map((root) => ({ kind: 'chromium' as const, path: join(root, 'Chromium', 'Application', 'chrome.exe') })),
    ]
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', join(home, 'Applications')]
    return [
      ...apps.map((dir) => ({ kind: 'chrome' as const, path: join(dir, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') })),
      ...apps.map((dir) => ({ kind: 'edge' as const, path: join(dir, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge') })),
      ...apps.map((dir) => ({ kind: 'chromium' as const, path: join(dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium') })),
    ]
  }
  // Linux and the rest. The binaries themselves, not the `/usr/bin` wrapper
  // scripts, where both exist: the wrappers exec the same file, and one less
  // process between the pipe and the browser is one less thing to reap.
  return [
    { kind: 'chrome', path: '/opt/google/chrome/chrome' },
    { kind: 'chrome', path: '/usr/bin/google-chrome-stable' },
    { kind: 'chrome', path: '/usr/bin/google-chrome' },
    { kind: 'edge', path: '/opt/microsoft/msedge/msedge' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge' },
    { kind: 'chromium', path: '/usr/lib/chromium/chromium' },
    { kind: 'chromium', path: '/usr/bin/chromium' },
  ]
}

/**
 * The configured executable when one is named (it must exist: a configured
 * path that is missing is the operator's mistake, and falling back to some
 * other browser would hide it), else the first known location that exists.
 */
export function locateBrowser(
  configured: string | undefined,
  options: { platform?: NodeJS.Platform; env?: Readonly<Record<string, string | undefined>>; home?: string; exists?: (path: string) => boolean } = {},
): LocatedBrowser | undefined {
  const exists = options.exists ?? existsSync
  if (configured !== undefined) return exists(configured) ? { path: configured, kind: kindOf(configured) } : undefined
  const found = candidates(options.platform ?? process.platform, options.env ?? process.env, options.home ?? homedir()).find((candidate) => exists(candidate.path))
  return found === undefined ? undefined : { path: found.path, kind: found.kind }
}

function kindOf(path: string): BrowserKind {
  const lower = path.toLowerCase()
  if (lower.includes('edge')) return 'edge'
  if (lower.includes('chromium')) return 'chromium'
  return 'chrome'
}
