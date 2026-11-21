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
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { alive, answerNativeDialog, killDesktopApps, type DesktopApp, type DesktopLaunch } from '../../src/test-support/desktop-app.ts'
import { launchApp as launchOwned, locksUnder, nsis, scratch as scratchOwned, seed, storedEvents, turnEnds, waitUntil, type Cleanup } from './support.ts'

const EXE = process.env.MINIDSH_DESKTOP_EXE
const INSTALLER = process.env.MINIDSH_DESKTOP_INSTALLER
const EXPECTED = process.env.MINIDSH_EXPECT_DESKTOP === '1'
const KEYS = ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'DEEPSEEK_BASE_URL']
const win = process.platform === 'win32'

const cleanup: Cleanup = []
afterEach(async () => {
  for (const undo of cleanup.splice(0).toReversed()) await undo()
})
afterAll(() => killDesktopApps())

const scratch = (prefix: string): string => scratchOwned(cleanup, prefix)
const launchApp = (launch: DesktopLaunch): DesktopApp => launchOwned(cleanup, launch)

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

describe.runIf(EXPECTED && (!EXE || (win && !INSTALLER)))('the desktop E2E', () => {
  it('needs MINIDSH_DESKTOP_EXE, and on Windows MINIDSH_DESKTOP_INSTALLER, when MINIDSH_EXPECT_DESKTOP=1', () => {
    expect.fail('MINIDSH_EXPECT_DESKTOP=1 but MINIDSH_DESKTOP_EXE names no app, or on Windows MINIDSH_DESKTOP_INSTALLER no installer: build them (node desktop/scripts/package.ts) and point at them')
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

    // A packaged build refuses a port-based DevTools endpoint (any local
    // process could drive it); tests use the pipe, which only a parent holds.
    const refused = spawn(exe, ['--remote-debugging-port=0'], { env: { ...process.env, MINIDSH_DESKTOP_DATA: scratch('minidsh-e2e-ud-'), MINIDSH_HOME: scratch('minidsh-e2e-home-') }, stdio: 'ignore' })
    const refusedExit = await new Promise<number | null>((resolve) => refused.once('exit', (code) => resolve(code)))
    expect(refusedExit).toBe(2)
  })

  // Found by the S22.2 review: one deleted folder blocked every start, with
  // advice to reinstall; and a stored folder was never held to the rules again.
  it('a missing folder is skipped, a refused one forgotten, and neither blocks the start', { timeout: 120_000 }, async () => {
    const userData = scratch('minidsh-e2e-ud-')
    const home = scratch('minidsh-e2e-home-')
    const gone = join(scratch('minidsh-e2e-gone-'), 'deleted project')
    const kept = scratch('minidsh-e2e-ws-')
    const driveRoot = join(kept, '..', '..', '..').split(/[\\/]/)[0] + (win ? '\\' : '/')
    seed(userData, [gone, driveRoot, kept])
    const app = launchApp({ exe, userData, home, drop: KEYS })
    const web = await app.page('http://127.0.0.1')
    await web.waitFor(`document.querySelector('#hero')?.textContent.includes('works in')`, 60_000)
    const folders = await web.evaluate<string[]>(`JSON.stringify([...document.querySelectorAll('#workspace-row, #hero')].map((node) => node.textContent))`)
    expect(String(folders)).not.toContain('deleted project')
    // The missing one is still remembered (a drive may come back); the drive root is forgotten.
    const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { folders: string[] }
    expect(saved.folders).toContain(gone)
    expect(saved.folders).not.toContain(driveRoot)
    expect(app.mainLog()).toMatch(/folder missing, skipped this start/)
    expect(app.mainLog()).toMatch(/folder refused and forgotten/)
    app.closeWindow()
    expect((await app.waitForExit(60_000)).code).toBe(0)

    // Only the missing one left: the welcome view says what it could not find.
    seed(userData, [gone])
    const second = launchApp({ exe, userData, home, drop: KEYS })
    const shell = await second.page('minidsh-shell:')
    await shell.waitFor(`document.querySelector('h1')?.textContent === 'Welcome to MiniDSH' && document.body.innerText.includes('could not find')`, 30_000)
    second.closeWindow()
    expect((await second.waitForExit(30_000)).code).toBe(0)
  })

  // Found by this suite: a close landing while the start was still loading
  // the page was dropped, and the app never quit. The window shows once the
  // shell is drawn, while the runtime is still booting: close right then.
  it('a close while the runtime is still starting is honoured, never dropped', { timeout: 120_000 }, async () => {
    const userData = scratch('minidsh-e2e-ud-')
    const home = scratch('minidsh-e2e-home-')
    seed(userData, [scratch('minidsh-e2e-ws-')])
    const app = launchApp({ exe, userData, home, drop: KEYS })
    await app.page('minidsh-shell:')
    app.closeWindow()
    const end = await app.waitForExit(60_000)
    expect(end.code, app.mainLog()).toBe(0)
    expect(locksUnder(home)).toEqual([])
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
    // The jar itself, HttpOnly cookies included: main injects the cookie per
    // request and strips every set-cookie, so the browser stores none.
    expect(await app.cookies('http://127.0.0.1', [`http://127.0.0.1:${(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { port: number }).port}/`])).toEqual([])
    const port = (JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { port: number }).port
    expect(port).toBeGreaterThanOrEqual(20_000)
    expect(port).toBeLessThan(45_000)
    expect(await web.evaluate<string>('location.origin')).toBe(`http://127.0.0.1:${port}`)

    // A second launch of the same install defers to this one and exits.
    const second = spawn(exe, [], { env: { ...process.env, MINIDSH_DESKTOP_DATA: userData, MINIDSH_HOME: home }, stdio: 'ignore' })
    const secondExit = await new Promise<number | null>((resolve) => second.once('exit', (code) => resolve(code)))
    expect(secondExit).toBe(0)
    expect(alive(app.pid)).toBe(true)

    // A running turn: the request reaches the model and is never answered.
    // The second launch above made this window show and focus itself, and a
    // key event dispatched over CDP while a window's focus is changing is
    // dropped by the browser, silently: on the Linux runner the draft sat in
    // the composer with nothing sent, three attempts in four (S22.5). The
    // composer empties the moment it sends, so Enter is pressed until it has,
    // and a press that had to be repeated is said out loud.
    await web.type('#prompt', 'say hello')
    let presses = 0
    while (presses < 5 && (await web.evaluate<string>(`document.querySelector('#prompt').value`)) !== '') {
      presses++
      await web.press('Enter')
      await web.waitFor(`document.querySelector('#prompt').value === ''`, 3_000).catch(() => undefined)
    }
    if (presses !== 1) process.stderr.write(`[app.e2e] Enter was pressed ${presses} times before the composer sent its draft\n`)
    await waitUntil('the turn to reach the model', () => model.requests() > 0, 60_000).catch(async (error: Error) => {
      // What a timeout here must say: where the prompt stopped, in the page
      // (focus, a draft never sent), on the wire, or in the runtime.
      const page = await web
        .evaluate<string>(`JSON.stringify({ focus: document.activeElement?.id || document.activeElement?.tagName, draft: document.querySelector('#prompt')?.value, hasFocus: document.hasFocus(), tail: document.body.innerText.slice(-400) })`)
        .catch((unreadable: unknown) => `unreadable: ${String(unreadable)}`)
      const logged = storedEvents(home).map((event) => event.type)
      throw new Error(`${error.message} (Enter pressed ${presses} times)\nlogged: ${logged.join(' ') || 'nothing'}\npage: ${page}\nmain.log (tail):\n${app.mainLog().slice(-2000)}`)
    })

    if (win) {
      app.closeWindow()
      const asked = answerNativeDialog(app.pid, 'Cancel')
      expect(asked.clicked, `no native confirm appeared; main.log:\n${app.mainLog()}`).toBe(true)
      expect(asked.text).toMatch(/1 running turn/)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(alive(app.pid)).toBe(true)
      app.closeWindow()
      expect(answerNativeDialog(app.pid, 'Quit').clicked).toBe(true)
      const end = await app.waitForExit(60_000)
      expect(end.code, app.mainLog()).toBe(0)
      expect(app.mainLog()).toMatch(/runtime stop: graceful=true killed=false/)
    } else {
      // No UI Automation to answer the confirm off Windows. What POSIX proves
      // instead is the parent-death path: the app killed outright, its runtime
      // sees its stdin end and stops gracefully on its own (on Windows a
      // kill-on-close Job ends it at once; repair covers that, §13).
      const orphan = app.runtimePid()
      expect(orphan, 'the runtime child was not found').toBeDefined()
      app.child.kill('SIGKILL')
      await app.waitForExit(15_000)
      await waitUntil('the orphaned runtime to stop on its own', () => !alive(orphan!), 60_000)
    }
    expect(turnEnds(home)).toContain('cancelled')
    expect(locksUnder(home)).toEqual([])

    // Relaunch: the same origin. A preference set there survives a quit and
    // the next launch (the page writes localStorage lazily, so it is set
    // before a GRACEFUL quit: a killed app loses an unflushed write, as any
    // Chromium does).
    const relaunch = (): DesktopApp => launchApp({ exe, userData, home, drop: KEYS, env: { DEEPSEEK_BASE_URL: model.url, DEEPSEEK_API_KEY: 'sk-e2e-dummy' } })
    const again = relaunch()
    const page = await again.page('http://127.0.0.1')
    await page.waitFor(`document.querySelector('#hero')?.textContent.includes('works in')`, 60_000)
    expect(await page.evaluate<string>('location.origin')).toBe(`http://127.0.0.1:${port}`)
    await page.evaluate(`localStorage.setItem('minidsh.theme', 'dark')`)
    again.closeWindow()
    expect((await again.waitForExit(60_000)).code, again.mainLog()).toBe(0)

    const third = relaunch()
    const themed = await third.page('http://127.0.0.1')
    await themed.waitFor(`document.querySelector('#hero')?.textContent.includes('works in')`, 60_000)
    expect(await themed.evaluate<string>('location.origin')).toBe(`http://127.0.0.1:${port}`)
    expect(await themed.evaluate<string>(`document.documentElement.dataset.theme`)).toBe('dark')

    // The runtime dies under the window: the stopped view, then Restart.
    const runtime = third.runtimePid()
    expect(runtime, 'the runtime child was not found').toBeDefined()
    process.kill(runtime!, 'SIGKILL')
    const shell = await third.page('minidsh-shell:')
    await shell.waitFor(`document.querySelector('h1')?.textContent.includes('stopped unexpectedly')`, 30_000)
    await shell.click('button.primary')
    const back = await third.page('http://127.0.0.1')
    await back.waitFor(`document.querySelector('#hero')?.textContent.includes('works in') && location.port === '${port}'`, 60_000)
    expect(third.runtimePid()).not.toBe(runtime)

    // The app is killed outright: its runtime goes with it (a kill-on-close
    // Job on Windows; its stdin's end elsewhere), and the next launch
    // reclaims the lease and lists the stored session.
    const orphan = third.runtimePid()!
    third.child.kill('SIGKILL')
    await third.waitForExit(15_000)
    await waitUntil('the runtime to end with its app', () => !alive(orphan), 30_000)
    const fourth = relaunch()
    const resumed = await fourth.page('http://127.0.0.1')
    await resumed.waitFor(`document.querySelectorAll('#sessions .session-row').length > 0`, 60_000)
    fourth.closeWindow()
    expect((await fourth.waitForExit(60_000)).code, fourth.mainLog()).toBe(0)
    expect(locksUnder(home)).toEqual([])
  })
})

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
    await web.waitFor(`document.querySelector('#hero')?.textContent.includes('works in')`, 60_000)

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
