/**
 * The PACKAGED desktop app, keyless: the executable `MINIDSH_DESKTOP_EXE`
 * names (an unpacked build or an installed one), driven like a person drives
 * it. Nothing here calls a model: a turn is kept running against a local
 * server that accepts the request and never answers (`DEEPSEEK_BASE_URL`, a
 * dummy key), which is all "work is running" needs.
 *
 * What it proves, each in the real app:
 *   - the first run is the welcome view, and the Web UI never gets the shell's API;
 *   - a remembered folder starts the runtime and loads the unmodified Web UI
 *     with the cookie injected and nothing in reach of the page;
 *   - a second launch exits and leaves the first alone;
 *   - closing while a turn runs asks first (UI Automation reads the native
 *     box), Cancel keeps everything, Quit stops gracefully: the turn ends
 *     `cancelled` in the log and no lease is left;
 *   - a relaunch keeps the origin, so the page's theme survives;
 *   - a runtime killed under the window shows the stopped view, and Restart
 *     brings the Web UI back;
 *   - killing the app takes its runtime with it, and the next launch resumes
 *     the stored session (its lease reclaimed).
 *
 * `MINIDSH_DESKTOP_INSTALLER` (Windows) adds the installed path: a silent
 * install to a folder whose name has a space and a non-ASCII letter, the
 * installer refusing while the app runs, and a silent uninstall that leaves
 * MINIDSH_HOME untouched.
 *
 * Self-skips without the executable; `MINIDSH_EXPECT_DESKTOP=1` (CI's desktop
 * job) makes that skip a failure.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { alive, answerNativeDialog, DesktopApp, killDesktopApps } from '../../src/test-support/desktop-app.ts'

const EXE = process.env.MINIDSH_DESKTOP_EXE
const INSTALLER = process.env.MINIDSH_DESKTOP_INSTALLER
const EXPECTED = process.env.MINIDSH_EXPECT_DESKTOP === '1'
const KEYS = ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'DEEPSEEK_BASE_URL']
const win = process.platform === 'win32'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const undo of cleanup.splice(0).toReversed()) await undo()
})
afterAll(() => killDesktopApps())

const scratch = (prefix: string): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  return dir
}

/** A model endpoint that takes every request and never answers it: a turn that stays running. */
async function hangingModel(): Promise<{ url: string; requests: () => number }> {
  let requests = 0
  const held: import('node:http').ServerResponse[] = []
  const server: Server = createServer((request, response) => {
    requests++
    request.resume()
    held.push(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const response of held) response.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests }
}

/** An app this test owns: killed (and its exit awaited) before the scratch directories it holds are removed. */
function launchApp(launch: ConstructorParameters<typeof DesktopApp>[0]): DesktopApp {
  const app = new DesktopApp(launch)
  cleanup.push(async () => {
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill()
    await app.exited
    await new Promise((resolve) => setTimeout(resolve, 500))
  })
  return app
}

function seed(userData: string, folders: readonly string[]): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), `${JSON.stringify({ version: 1, folders })}\n`)
}

const locksUnder = (home: string): string[] => {
  const sessions = join(home, 'sessions')
  return existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
}

/** Every `turn/end` reason in every stored log under the home, in order. */
function turnEnds(home: string): string[] {
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return []
  const reasons: string[] = []
  for (const name of readdirSync(sessions).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(sessions, name), 'utf8').split('\n')) {
      if (!line.includes('"turn/end"')) continue
      const event = JSON.parse(line) as { type: string; data: { reason?: { kind?: string } } }
      if (event.type === 'turn/end') reasons.push(String(event.data.reason?.kind))
    }
  }
  return reasons
}

async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe.runIf(EXPECTED && !EXE)('the desktop E2E', () => {
  it('needs MINIDSH_DESKTOP_EXE when MINIDSH_EXPECT_DESKTOP=1', () => {
    expect.fail('MINIDSH_EXPECT_DESKTOP=1 but MINIDSH_DESKTOP_EXE names no app: build it (node desktop/scripts/package.ts --dir) and point at it')
  })
})

describe.runIf(EXE)('the packaged desktop app (keyless)', () => {
  const exe = EXE!

  it('first run: the welcome view, its keys read through the runtime, and no API for the Web UI', { timeout: 120_000 }, async () => {
    const app = launchApp({ exe, userData: scratch('minidsh-e2e-ud-'), home: scratch('minidsh-e2e-home-'), drop: KEYS })
    const shell = await app.page('minidsh-shell:')
    await shell.waitFor(`document.querySelector('h1')?.textContent === 'Welcome to MiniDSH'`, 30_000)
    expect(await shell.evaluate<string>('typeof window.minidshShell')).toBe('object')
    // The key list is the runtime's own (`credentials list`), with every provider key removed from the env.
    await shell.waitFor(`document.body.innerText.includes('DEEPSEEK_API_KEY') && document.body.innerText.includes('not set')`, 30_000)
    const web = await app.page('about:blank')
    expect(await web.evaluate<string>('typeof window.minidshShell')).toBe('undefined')
    expect(await shell.unexpectedProblems()).toEqual([])
    app.closeWindow()
    // Nothing is running, so nothing asks: the app exits on its own.
    expect((await app.waitForExit(30_000)).code).toBe(0)
  })

  it('a folder: the Web UI with the credential injected; busy close asks, Cancel keeps, Quit stops gracefully; a second launch defers', { timeout: 240_000 }, async () => {
    const userData = scratch('minidsh-e2e-ud-')
    const home = scratch('minidsh-e2e-home-')
    const folder = join(scratch('minidsh-e2e-ws-'), 'ws ü')
    mkdirSync(folder)
    seed(userData, [folder])
    const model = await hangingModel()
    const app = launchApp({ exe, userData, home, drop: KEYS, env: { DEEPSEEK_BASE_URL: model.url, DEEPSEEK_API_KEY: 'sk-e2e-dummy' } })
    const web = await app.page('http://127.0.0.1')
    await web.waitFor(`document.querySelector('#hero')?.textContent.includes('ws ü')`, 60_000)
    expect(await web.evaluate<string>('typeof window.minidshShell')).toBe('undefined')
    expect(await web.evaluate<string>('document.cookie')).toBe('')
    const port = (JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { port: number }).port
    expect(port).toBeGreaterThanOrEqual(20_000)
    expect(port).toBeLessThan(45_000)
    expect(await web.evaluate<string>('location.origin')).toBe(`http://127.0.0.1:${port}`)
    await web.evaluate(`localStorage.setItem('minidsh.theme', 'dark')`)

    // A second launch of the same install defers to this one and exits.
    const second = spawn(exe, [], { env: { ...process.env, MINIDSH_DESKTOP_DATA: userData, MINIDSH_HOME: home }, stdio: 'ignore' })
    const secondExit = await new Promise<number | null>((resolve) => second.once('exit', (code) => resolve(code)))
    expect(secondExit).toBe(0)
    expect(alive(app.pid)).toBe(true)

    // A running turn: the request reaches the model and is never answered.
    await web.type('#prompt', 'say hello')
    await web.press('Enter')
    await waitUntil('the turn to reach the model', () => model.requests() > 0, 60_000)

    if (win) {
      app.closeWindow()
      const asked = answerNativeDialog(app.pid, 'Cancel')
      expect(asked.clicked, `no native confirm appeared; main.log:\n${app.mainLog()}`).toBe(true)
      expect(asked.text).toMatch(/1 running turn/)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(alive(app.pid)).toBe(true)
      app.closeWindow()
      expect(answerNativeDialog(app.pid, 'Quit').clicked).toBe(true)
    } else {
      // No UI Automation off Windows: SIGTERM is a quit, and the confirm is Windows-proven.
      app.closeWindow()
    }
    const end = await app.waitForExit(60_000)
    expect(end.code, app.mainLog()).toBe(0)
    expect(app.mainLog()).toMatch(/runtime stop: graceful=true killed=false/)
    expect(turnEnds(home)).toContain('cancelled')
    expect(locksUnder(home)).toEqual([])

    // Relaunch: the same origin, so the page's own preference survived.
    const again = launchApp({ exe, userData, home, drop: KEYS, env: { DEEPSEEK_BASE_URL: model.url, DEEPSEEK_API_KEY: 'sk-e2e-dummy' } })
    const page = await again.page('http://127.0.0.1')
    await page.waitFor(`document.querySelector('#hero') !== null`, 60_000)
    expect(await page.evaluate<string>('location.origin')).toBe(`http://127.0.0.1:${port}`)
    expect(await page.evaluate<string>(`document.documentElement.dataset.theme`)).toBe('dark')

    // The runtime dies under the window: the stopped view, then Restart.
    const runtime = again.runtimePid()
    expect(runtime, 'the runtime child was not found').toBeDefined()
    process.kill(runtime!)
    const shell = await again.page('minidsh-shell:')
    await shell.waitFor(`document.querySelector('h1')?.textContent.includes('stopped unexpectedly')`, 30_000)
    await shell.click('button.primary')
    const back = await again.page('http://127.0.0.1')
    await back.waitFor(`document.querySelector('#hero') !== null && location.port === '${port}'`, 60_000)
    expect(again.runtimePid()).not.toBe(runtime)

    // The app is killed: its runtime goes with it (a kill-on-close Job on
    // Windows; stdin's end elsewhere), and the next launch reclaims the lease.
    const orphan = again.runtimePid()!
    again.child.kill()
    await again.waitForExit(15_000)
    await waitUntil('the runtime to end with its app', () => !alive(orphan), 30_000)
    const third = launchApp({ exe, userData, home, drop: KEYS, env: { DEEPSEEK_BASE_URL: model.url, DEEPSEEK_API_KEY: 'sk-e2e-dummy' } })
    const resumed = await third.page('http://127.0.0.1')
    await resumed.waitFor(`document.querySelectorAll('#sessions .session-row').length > 0`, 60_000)
    third.closeWindow()
    if (win) answerNativeDialog(third.pid, 'Quit', 5_000)
    expect((await third.waitForExit(60_000)).code).toBe(0)
    expect(locksUnder(home)).toEqual([])
  })
})

/**
 * An NSIS installer or uninstaller, waited for. `/D=` and `_?=` must come LAST
 * and UNQUOTED (they take the rest of the line, spaces included): Node would
 * quote a path with a space, NSIS would then ignore `_?=` and relaunch itself
 * from %TEMP%, and the exit status would arrive before the work did.
 */
function nsis(file: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  // Through cmd's `/s /c "…"`, which hands the inner line over untouched; our
  // paths hold a space and a letter outside ASCII, never cmd's & ^ % or quotes.
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], { timeout: 180_000, windowsVerbatimArguments: true })
}

describe.runIf(EXE && INSTALLER && win)('the installed desktop app (Windows)', () => {
  it('installs silently, refuses to reinstall while running, uninstalls leaving MINIDSH_HOME', { timeout: 300_000 }, async () => {
    const root = scratch('minidsh-e2e-install-')
    const dir = join(root, 'Mini DSH ü')
    const home = scratch('minidsh-e2e-home-')
    writeFileSync(join(home, 'keep.txt'), 'the home is the person\'s, never the installer\'s\n')
    const install = nsis(INSTALLER!, ['/S', `/D=${dir}`])
    expect(install.status).toBe(0)
    const exe = join(dir, 'MiniDSH.exe')
    expect(existsSync(exe)).toBe(true)
    expect(existsSync(join(dir, 'resources', 'node', 'node.exe'))).toBe(true)

    const userData = scratch('minidsh-e2e-ud-')
    const folder = scratch('minidsh-e2e-ws-')
    seed(userData, [folder])
    const app = launchApp({ exe, userData, home, drop: KEYS })
    const web = await app.page('http://127.0.0.1')
    await web.waitFor(`document.querySelector('#hero') !== null`, 60_000)

    // While it runs, the installer refuses (exit 2) and kills nothing.
    const runtime = app.runtimePid()!
    const refused = nsis(INSTALLER!, ['/S', `/D=${dir}`])
    expect(refused.status).toBe(2)
    expect(alive(app.pid) && alive(runtime)).toBe(true)

    app.closeWindow()
    expect((await app.waitForExit(60_000)).code).toBe(0)
    await waitUntil('every MiniDSH process under the install to end', () => !alive(runtime), 30_000)
    // `_?=` runs the uninstaller in place, so the wait is real (it leaves itself behind).
    const uninstall = nsis(join(dir, 'Uninstall MiniDSH.exe'), ['/currentuser', '/S', `_?=${dir}`])
    expect(uninstall.status).toBe(0)
    expect(existsSync(exe)).toBe(false)
    expect(readFileSync(join(home, 'keep.txt'), 'utf8')).toMatch(/never the installer's/)
  })
})
