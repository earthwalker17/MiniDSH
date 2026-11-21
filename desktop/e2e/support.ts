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
    // The lookup throws when it cannot answer (it used to answer "none"), and
    // cleanup must go on to the directories either way: said, not swallowed.
    try {
      const runtime = app.runtimePid()
      if (runtime !== undefined && alive(runtime)) process.kill(runtime, 'SIGKILL')
    } catch (error) {
      process.stderr.write(`[desktop e2e] cleanup could not look for a runtime left by pid ${app.pid}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  })
  return app
}

/**
 * A home whose runtime never finishes starting: a from-disk plugin whose
 * `apply` does not settle until the returned file exists, so `minidsh web
 * --json` never prints `ready`. For a test about a quit DURING a start, which
 * a real start is too quick and too variable to be caught in: with this the
 * moment is the test's, and no sleep stands in for it. The plugin is one
 * dependency-free module written into the home, as a person's own would be.
 */
export function holdRuntimeStart(home: string): string {
  const release = join(home, 'release-runtime-start')
  const plugin = join(home, 'hold-runtime-start.mjs')
  writeFileSync(
    plugin,
    `import { existsSync } from 'node:fs'
export default {
  name: 'e2e-hold-runtime-start',
  async apply() {
    await new Promise((resolve) => {
      const poll = setInterval(() => {
        if (!existsSync(${JSON.stringify(release)})) return
        clearInterval(poll)
        resolve()
      }, 50)
    })
  },
}
`,
  )
  writeFileSync(join(home, 'composition.json'), `${JSON.stringify({ patches: [{ insert: [{ id: 'e2e-hold-runtime-start', plugin }] }] })}\n`)
  return release
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

/**
 * Every event of every TOP-LEVEL stored log under the home. A delegated
 * child's log is a file of its own beside its parent's, told apart by its
 * header line (`delegatedBy`), and it is skipped: read with the rest, a
 * child's `turn/end` ended a wait for the PERSON's turn while that turn was
 * still running, and its `completed` stood in for the turn's.
 */
export function storedEvents(home: string): LoggedEvent[] {
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return []
  const events: LoggedEvent[] = []
  for (const name of readdirSync(sessions).filter((file) => file.endsWith('.jsonl'))) {
    const lines = readFileSync(join(sessions, name), 'utf8').split('\n')
    if (delegated(lines[0] ?? '')) continue
    for (const line of lines) {
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

/** Whether a stored log's header line says its session was delegated by another. */
function delegated(header: string): boolean {
  try {
    return typeof (JSON.parse(header) as { delegatedBy?: unknown }).delegatedBy === 'string'
  } catch {
    // No readable header yet (a file just created): nothing says it is a child's.
    return false
  }
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

/**
 * A verdict on a workspace's `slug.mjs` that the agent working in that
 * workspace cannot have written: the module is copied OUT, beside a test this
 * process writes, and that test is run there. The workspace's own test file
 * is the agent's to edit (it runs approved, in that folder), so running it was
 * asking the agent whether the agent had succeeded.
 */
export function judgeSlug(workspace: string, judgeDir: string, test: string): { pass: boolean; output: string } {
  mkdirSync(judgeDir, { recursive: true })
  writeFileSync(join(judgeDir, 'package.json'), '{ "name": "slug-judge", "type": "module", "private": true }\n')
  writeFileSync(join(judgeDir, 'slug.test.mjs'), test)
  const module = join(workspace, 'slug.mjs')
  if (!existsSync(module)) return { pass: false, output: `${module} is gone` }
  writeFileSync(join(judgeDir, 'slug.mjs'), readFileSync(module))
  // The file is named: a bare `node --test` passes on a folder with no test in it.
  const run = spawnSync(process.execPath, ['--test', join(judgeDir, 'slug.test.mjs')], { cwd: judgeDir, encoding: 'utf8', timeout: 120_000 })
  if (run.error !== undefined) throw new Error(`the judge's own test could not run: ${run.error.message}`)
  return { pass: run.status === 0, output: `${run.stdout}${run.stderr}`.slice(-2000) }
}
