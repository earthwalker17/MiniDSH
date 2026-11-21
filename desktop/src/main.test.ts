/**
 * main.ts's own ORDER around a quit, a start and a save, run under Node:
 * against a stand-in for Electron (`test-fixtures/fake-electron.ts`) and a
 * stand-in runtime that listens (`test-fixtures/fake-web-runtime.ts`), which
 * main spawns itself through the real `RuntimeProcess` and signs in to with
 * the real `signIn`.
 *
 * The packaged E2E (desktop/e2e) proves the real app, but it cannot choose
 * the MOMENT a quit lands in, and that moment is where main's defects have
 * lived: a quit during the boot met a runtime that was already closing, was
 * refused the sign-in, logged a spent credential and showed the stopped view
 * on its way out (seen on a macOS runner, S22.5). Here the stand-in runtime
 * waits on a file for each step, so the test decides the order and no sleep
 * stands in for it.
 *
 * Every case reads what main DID (the exchanges asked of the runtime, the
 * URLs it loaded into the window, the views it sent the shell, the boxes it
 * showed, its own log), never a flag inside it.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeElectron, FakeWebContents, type FakeElectron } from './test-fixtures/fake-electron.ts'

const FIXTURE = join(import.meta.dirname, 'test-fixtures', 'fake-web-runtime.ts')
/** What a launch sets in this process's environment (main reads it, and passes it on to the runtime), put back afterwards. */
const ENV = ['MINIDSH_DESKTOP_DATA', 'MINIDSH_DESKTOP_NODE', 'MINIDSH_DESKTOP_BIN', 'FAKE_WEB_DIR', 'FAKE_WEB', 'NO_PROXY', 'no_proxy']
/** What main logs about a start: that the runtime became usable, or what went wrong with it. A quit that interrupted the start leaves none. */
const START_LINE = /handoff refused|runtime ready|start failed|web ui did not load|lifecycle action failed|uncaught exception/

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const undo of cleanup.splice(0).toReversed()) await undo()
})

const scratch = (prefix: string): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Polls a condition to a deadline: the wait is for the condition, and a miss says what was there instead. */
async function waitFor(what: string, check: () => boolean, detail: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${detail()}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

interface Launch {
  /** The settings file's text, given the folder the launch may work in; none is a first run. */
  readonly settings?: (folder: string) => string
  /** The stand-in runtime's steps (`FAKE_WEB`). */
  readonly mode?: string
  /** A `no_proxy` the person's environment already holds. */
  readonly noProxy?: string
}

interface Launched {
  readonly fake: FakeElectron
  /** The folder the launch may work in. */
  readonly folder: string
  readonly settingsFile: string
  mainLog(): string
  /** Token exchanges the runtime was asked for. */
  signIns(): number
  /** The runtime's pid, once it is listening: from then on main's start of it is pending or done. */
  runtimePid(): Promise<number>
  /** Lets the runtime print `ready` (under `hold-ready`). */
  releaseReady(): void
  /** Waits for the app to quit, and for nothing else. */
  quitted(): Promise<void>
  /** What main did that a person or a log reader would see. */
  account(): { signIns: number; pageLoads: string[]; stoppedViews: (string | undefined)[]; boxes: (string | undefined)[]; startLog: string[]; exits: number[] }
}

async function launch(options: Launch = {}): Promise<Launched> {
  const data = scratch('minidsh-main-ud-')
  const gate = scratch('minidsh-main-gate-')
  const folder = scratch('minidsh-main-ws-')
  const bundle = scratch('minidsh-main-app-')
  const settingsFile = join(data, 'settings.json')
  if (options.settings !== undefined) writeFileSync(settingsFile, options.settings(folder))

  const saved = ENV.map((name) => [name, process.env[name]] as const)
  cleanup.push(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  for (const name of ['NO_PROXY', 'no_proxy']) delete process.env[name]
  if (options.noProxy !== undefined) process.env.no_proxy = options.noProxy
  Object.assign(process.env, { MINIDSH_DESKTOP_DATA: data, MINIDSH_DESKTOP_NODE: process.execPath, MINIDSH_DESKTOP_BIN: FIXTURE, FAKE_WEB_DIR: gate, FAKE_WEB: options.mode ?? '' })
  // Electron's own; main reads it for the window's icon and, on macOS, for where the app is installed.
  const resources = join(bundle, 'MiniDSH.app', 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
  cleanup.push(() => {
    delete (process as { resourcesPath?: string }).resourcesPath
  })

  const fake = createFakeElectron()
  // main.ts keeps its state in the module and listens on the process: every launch is a fresh copy, and its listener goes with it.
  const listeners = process.listeners('uncaughtException')
  cleanup.push(() => {
    for (const listener of process.listeners('uncaughtException')) if (!listeners.includes(listener)) process.removeListener('uncaughtException', listener)
  })
  vi.resetModules()
  vi.doMock('electron', () => fake.module)
  cleanup.push(() => vi.doUnmock('electron'))
  await import('./main.ts')

  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  const mainLog = (): string => read(join(data, 'logs', 'main.log'))
  const signIns = (): number => read(join(gate, 'signins')).split('\n').filter((line) => line.length > 0).length
  const state = (): string => `main.log:\n${mainLog()}\nshell views: ${JSON.stringify(fake.shellViews())}\nsign-ins asked: ${signIns()}`
  cleanup.push(() => {
    const pid = Number(read(join(gate, 'started')))
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
  })

  fake.becomeReady()
  await waitFor('main to build its window', () => fake.windows.length === 1 && fake.views.length === 1, state)
  return {
    fake,
    folder,
    settingsFile,
    mainLog,
    signIns,
    async runtimePid() {
      await waitFor('the runtime to be started', () => existsSync(join(gate, 'started')), state)
      return Number(read(join(gate, 'started')))
    },
    releaseReady: () => appendFileSync(join(gate, 'release-ready'), ''),
    async quitted() {
      await waitFor('the app to quit', () => fake.app.hasQuit, state)
    },
    account: () => ({
      signIns: signIns(),
      pageLoads: fake.windows[0]!.webContents.loads.filter((url) => url.startsWith('http://127.0.0.1')),
      stoppedViews: fake.shellViews().filter((view) => view.kind === 'stopped').map((view) => view.title),
      boxes: fake.dialog.messageBoxes.map((box) => box.detail),
      startLog: mainLog().split('\n').filter((line) => START_LINE.test(line)),
      exits: fake.app.exits,
    }),
  }
}

const remembered = (folder: string): string => `${JSON.stringify({ version: 1, folders: [folder] })}\n`
/** What a quit that interrupted the start must leave: no page, no stopped view, no question, no word of a start in the log. */
const QUIET = { pageLoads: [], stoppedViews: [], boxes: [], startLog: [], exits: [] }

describe("main's lifecycle, in an order the test chooses", { timeout: 90_000 }, () => {
  it('a close while the runtime is booting never signs in to it or shows it: the runtime it told to stop is waited for, and the app quits', async () => {
    const app = await launch({ settings: remembered, mode: 'hold-ready' })
    const pid = await app.runtimePid()
    let runtimeAliveAtQuit: boolean | undefined
    app.fake.app.once('will-quit', () => {
      runtimeAliveAtQuit = alive(pid)
    })
    // The person closes the window: main vetoes the close and queues a quit
    // behind the start, ending the booting runtime's stdin as it does.
    app.fake.windows[0]!.close()
    expect(app.fake.app.hasQuit).toBe(false)
    // Only now does the runtime print `ready`: the start resolves into a quit.
    app.releaseReady()
    await app.quitted()

    expect(app.account()).toEqual({ signIns: 0, ...QUIET })
    expect(runtimeAliveAtQuit, 'the runtime was still running when the app quit').toBe(false)
    expect(app.mainLog()).toMatch(/quit: the runtime that was starting was stopped before it was used/)
    expect(app.mainLog()).toMatch(/quit: runtime stopped, closing\n[^\n]*quit: every window closed/)
  })

  for (const [mode, outcome] of [
    ['hold-signin:drop', 'the runtime closed without answering'],
    ['hold-signin:answer', 'the runtime answered while closing'],
  ] as const) {
    it(`a quit during the sign-in (${outcome}) reports no refused credential, loads no page and asks nothing`, async () => {
      const app = await launch({ settings: remembered, mode })
      const pid = await app.runtimePid()
      await waitFor(
        'main to be signing in',
        () => app.signIns() === 1,
        () => app.mainLog(),
      )
      let runtimeAliveAtQuit: boolean | undefined
      app.fake.app.once('will-quit', () => {
        runtimeAliveAtQuit = alive(pid)
      })
      // Electron's own quit (a SIGTERM, the menu), vetoed by main until the runtime has stopped.
      app.fake.app.quit()
      await app.quitted()

      expect(app.account()).toEqual({ signIns: 1, ...QUIET })
      expect(runtimeAliveAtQuit, 'the runtime was still running when the app quit').toBe(false)
      expect(app.mainLog()).toMatch(/quit: the runtime that was starting was stopped before it was used/)
    })
  }

  it('a start nothing interrupts signs in once and shows the page; a close then asks, because this runtime cannot say it is idle, and stops it gracefully', async () => {
    const app = await launch({ settings: remembered, noProxy: 'example.com' })
    await waitFor(
      "the runtime's page to be loaded",
      () => app.account().pageLoads.length === 1,
      () => app.mainLog(),
    )
    const port = (JSON.parse(readFileSync(app.settingsFile, 'utf8')) as { port?: number }).port
    expect(app.account()).toEqual({ signIns: 1, ...QUIET, pageLoads: [`http://127.0.0.1:${String(port)}/`], startLog: [expect.stringMatching(/runtime ready on port/)] })
    // Main's own requests go around an environment proxy, under both spellings (env.ts), with what was there kept.
    expect({ upper: process.env.NO_PROXY?.split(','), lower: process.env.no_proxy?.split(',') }).toEqual({ upper: expect.arrayContaining(['127.0.0.1']), lower: expect.arrayContaining(['example.com', '127.0.0.1']) })

    app.fake.dialog.answer = 0
    app.fake.windows[0]!.close()
    await app.quitted()
    expect(app.account().boxes).toEqual([expect.stringMatching(/could not tell whether work is running/)])
    expect(app.mainLog()).toMatch(/runtime stop: graceful=true killed=false/)
    expect(app.account().exits).toEqual([])
  })

  // The remembered folders are authority the person granted. One launch that
  // could not read the file (here a hand edit's stray comma; a lock held by
  // another program reads the same) used to start on the defaults and write
  // them back at the first window move, and every folder was gone.
  it('a settings file it could not read is left byte for byte, and said so, through a move and a quit', async () => {
    const text = (folder: string): string => `{ "version": 1, "folders": [${JSON.stringify(folder)}], }\n`
    const app = await launch({ settings: text })
    const original = text(app.folder)
    await waitFor(
      'the welcome view',
      () => app.fake.shellViews().some((view) => view.kind === 'welcome'),
      () => app.mainLog(),
    )
    const notice = app.fake.shellViews().findLast((view) => view.kind === 'welcome')?.notice
    expect(notice).toMatch(/settings file is not valid JSON/)
    expect(notice).toContain(app.settingsFile)
    expect(app.mainLog()).toMatch(/settings: the settings file is not valid JSON; it is left as it is/)

    app.fake.windows[0]!.moveTo(300, 200)
    app.fake.windows[0]!.close()
    await app.quitted()
    expect(readFileSync(app.settingsFile, 'utf8')).toBe(original)
  })

  it('choosing a folder is the deliberate change that replaces such a file, and ordinary saves resume after it', async () => {
    const app = await launch({ settings: () => 'not json at all', mode: 'hold-ready' })
    await waitFor(
      'the welcome view',
      () => app.fake.shellViews().some((view) => view.kind === 'welcome'),
      () => app.mainLog(),
    )
    app.fake.windows[0]!.moveTo(300, 200)
    expect(readFileSync(app.settingsFile, 'utf8')).toBe('not json at all')

    app.fake.dialog.openResult = { canceled: false, filePaths: [app.folder] }
    await app.fake.invokeShell('shell:chooseFolder')
    expect(JSON.parse(readFileSync(app.settingsFile, 'utf8'))).toMatchObject({ version: 1, folders: [app.folder] })
    app.fake.windows[0]!.moveTo(320, 220)
    expect(JSON.parse(readFileSync(app.settingsFile, 'utf8'))).toMatchObject({ folders: [app.folder], window: { x: 320, y: 220 } })
    expect(app.mainLog()).toMatch(/settings: the file that is not valid JSON is replaced now, by a folder change/)

    // The folder started a runtime, still booting or not yet spawned: the quit ends it either way.
    app.fake.app.quit()
    app.releaseReady()
    await app.quitted()
    expect(app.account()).toEqual({ signIns: 0, ...QUIET })
  })

  // Found on a macOS runner (S22.5): a callback that used the window after it
  // closed threw, Electron showed the exception in a modal box, and the app
  // stayed up with no window. The lane that fixed the start then listed what
  // else could reach a gone window; these three hold those.
  it('asks nothing on a window that went away while the runtime was being asked whether work is running: the quit goes on', async () => {
    const app = await launch({ settings: remembered })
    await waitFor(
      "the runtime's page to be loaded",
      () => app.account().pageLoads.length === 1,
      () => app.mainLog(),
    )
    // No answer is set: a message box shown now throws in the fake, as a box
    // nobody can answer parks the real app.
    app.fake.app.quit()
    // The quit is asking the runtime over the wire. The window goes now.
    app.fake.windows[0]!.destroy()
    await app.quitted()
    expect(app.account().boxes).toEqual([])
    expect(app.mainLog()).toMatch(/runtime stop: graceful=true killed=false/)
    expect(app.mainLog()).not.toMatch(/lifecycle action failed|uncaught exception/)
  })

  it('a quit that fails on its way is no quit: the next restart still starts a runtime', async () => {
    const app = await launch({ settings: remembered })
    await waitFor(
      "the runtime's page to be loaded",
      () => app.account().pageLoads.length === 1,
      () => app.mainLog(),
    )
    // The close asks (this runtime cannot say it is idle), and the box throws: no answer was set.
    app.fake.windows[0]!.close()
    await waitFor(
      'the failed quit to be logged',
      () => /lifecycle action failed/.test(app.mainLog()),
      () => app.mainLog(),
    )
    expect(app.fake.app.hasQuit).toBe(false)
    // Restart from the shell page, confirmed: with `quitting` left set, the start returned before spawning anything.
    app.fake.dialog.answer = 0
    await app.fake.invokeShell('shell:restart')
    await waitFor(
      'a second runtime to be signed in to',
      () => app.signIns() === 2,
      () => app.mainLog(),
    )
    app.fake.windows[0]!.close()
    await app.quitted()
  })

  it('a shell page that does not load still shows the window, and the log says why', async () => {
    FakeWebContents.failing = (url) => url.startsWith('minidsh-shell:')
    cleanup.push(() => {
      FakeWebContents.failing = undefined
    })
    const app = await launch()
    await waitFor(
      'the window to be shown',
      () => app.fake.windows[0]!.shown,
      () => app.mainLog(),
    )
    expect(app.mainLog()).toMatch(/the shell page did not load \(-6 ERR_FILE_NOT_FOUND\); showing the window anyway/)
    app.fake.app.quit()
    await app.quitted()
  })
})
