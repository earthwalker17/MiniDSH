/**
 * What the desktop E2E files share: scratch directories registered for
 * cleanup, a seeded launcher profile, the stored log read back as facts, and
 * NSIS invoked the way it parses its own command line.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive, DesktopApp, type DesktopLaunch } from '../../src/test-support/desktop-app.ts'

/** Cleanup steps, run newest first by each file's afterEach/afterAll. */
export type Cleanup = (() => void | Promise<void>)[]

export function scratch(cleanup: Cleanup, prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  return dir
}

/** An app the test owns: killed (and its exit awaited) before the scratch directories it holds are removed. */
export function launchApp(cleanup: Cleanup, launch: DesktopLaunch): DesktopApp {
  const app = new DesktopApp(launch)
  cleanup.push(async () => {
    // Forceful and bounded: cleanup tests nothing, and a quit that asks (a
    // native confirm nobody answers) must not hold the hook.
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGKILL')
    await Promise.race([app.exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
    const runtime = app.runtimePid()
    if (runtime !== undefined && alive(runtime)) process.kill(runtime, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 500))
  })
  return app
}

/** The launcher's own settings, as the app would have written them. */
export function seed(userData: string, folders: readonly string[]): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), `${JSON.stringify({ version: 1, folders })}\n`)
}

export function locksUnder(home: string): string[] {
  const sessions = join(home, 'sessions')
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
}

export interface LoggedEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

/** Every event of every TOP-LEVEL stored log under the home (a delegated child's log is its own file). */
export function storedEvents(home: string): LoggedEvent[] {
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return []
  const events: LoggedEvent[] = []
  for (const name of readdirSync(sessions).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(sessions, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as { type?: string; seq?: number; data?: Record<string, unknown> }
        if (typeof parsed.type === 'string') events.push({ type: parsed.type, seq: parsed.seq ?? -1, data: parsed.data ?? {} })
      } catch {
        // A torn last line while the writer is mid-append: the next poll reads it whole.
      }
    }
  }
  return events
}

/** Every `turn/end` reason under the home, in log order. */
export function turnEnds(home: string): string[] {
  return storedEvents(home)
    .filter((event) => event.type === 'turn/end')
    .map((event) => String((event.data.reason as { kind?: string } | undefined)?.kind))
}

export async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * An NSIS installer or uninstaller, waited for. `/D=` and `_?=` must come LAST
 * and UNQUOTED (they take the rest of the line, spaces included): Node would
 * quote a path with a space, NSIS would then ignore `_?=` and relaunch itself
 * from %TEMP%, and the exit status would arrive before the work did. Through
 * cmd's `/s /c "…"`, which hands the inner line over untouched; the paths
 * here hold a space and a letter outside ASCII, never cmd's & ^ % or quotes.
 */
export function nsis(file: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], { timeout: 180_000, windowsVerbatimArguments: true })
}
