/**
 * The MiniDSH desktop app's main process: a launcher, one window and the
 * lifecycle around ONE runtime child. The rules with no Electron in them live
 * in pure, unit-tested modules beside it (runtime, inspect, folders, settings,
 * guards, env, menu, credentials, update, text); what stays here is wiring
 * and the lifecycle's ordering, which desktop/e2e drives in the packaged app
 * (not every menu path: Check for Updates, About and Show Logs are untested).
 *
 * What the desktop is (ARCHITECTURE §8, the desktop bullet): a SURFACE. It never
 * imports the runtime. It spawns the bundled CLI (`minidsh web --json`) on the
 * bundled Node, takes its `ready` record, spends the one-shot token itself,
 * and shows the unmodified Web UI in a window whose requests carry the cookie
 * main holds in memory. It decides nothing the runtime decides: whether work
 * is running is asked of the runtime over the wire (`inspect.ts`), never read
 * off the page.
 *
 * Two webContents, never one document (S22.2 plan critics): the window's own
 * is the Web UI and has NO preload, so the page that renders model-written
 * text gets no desktop API; the shell overlay (starting, welcome, keys,
 * stopping, stopped) is a separate WebContentsView with its own preload,
 * served from a privileged custom scheme because the hardened fuses deny
 * `file://` reads from the asar.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, screen, session, shell, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { listCredentials, setCredential } from './credentials.ts'
import { runtimeEnv } from './env.ts'
import { admitFolder, boundsVisible, type FolderContext } from './folders.ts'
import { externalUrl, isHostUrl as isHostUrlOf } from './guards.ts'
import { inspectRuntime } from './inspect.ts'
import { folderOfRemoveId, MENU_IDS, menuTemplate, type MenuItemTemplate } from './menu.ts'
import { choosePort, probePort, RuntimeProcess, RuntimeStartError, signIn, type RuntimeReady, type StartFailure } from './runtime.ts'
import { readSettings, withCurrentFolder, withoutFolder, writeSettings, type DesktopSettings } from './settings.ts'
import { displayTail } from './text.ts'
import { checkForUpdate } from './update.ts'

const APP_ID = 'io.github.earthwalker17.minidsh'
const REPOSITORY = 'https://github.com/earthwalker17/MiniDSH'
const SHELL_SCHEME = 'minidsh-shell'
const SHELL_URL = `${SHELL_SCHEME}://app/index.html`
/** The shell's whole file set, served by name: nothing else under the scheme exists. */
const SHELL_FILES: Readonly<Record<string, readonly [string, string]>> = {
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/shell.js': ['shell.js', 'text/javascript; charset=utf-8'],
  '/shell.css': ['shell.css', 'text/css; charset=utf-8'],
  '/mark.svg': ['mark.svg', 'image/svg+xml'],
}
/** The runtime's own stop deadline is 25 s (cli.ts); this is it plus a margin before a kill. */
const STOP_DEADLINE_MS = 35_000
const LOG_CAP_BYTES = 1024 * 1024

// ---------------------------------------------------------------- before ready

// Main's sign-in and inspection talk to 127.0.0.1 alone, carrying the launch
// token and the cookie: an environment proxy (Node honours NODE_USE_ENV_PROXY
// with HTTP_PROXY) must never see them.
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1'].filter(Boolean).join(',')

// Privileged before `ready`, as Electron requires: standard (a real origin for
// relative URLs), secure (no mixed-content downgrade). No fetch, no CORS.
protocol.registerSchemesAsPrivileged([{ scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } }])

// A port-based DevTools endpoint answers ANY local process, unauthenticated:
// it could drive approvals and read the injected cookie. Tests use the pipe,
// which only the launching parent holds.
if (app.isPackaged && app.commandLine.hasSwitch('remote-debugging-port')) app.exit(2)

// Tests and side-by-side instances: a separate profile, set before the lock
// (the lock is per userData). MINIDSH_* never reaches an agent's shell.
if (process.env.MINIDSH_DESKTOP_DATA) app.setPath('userData', process.env.MINIDSH_DESKTOP_DATA)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
// A separate profile keeps its own logs on every platform: macOS's default is
// ~/Library/Logs/<name> whatever userData says, which would mix a side-by-side
// instance's log into the installed app's (and leave a test reading nothing).
app.setAppLogsPath(process.env.MINIDSH_DESKTOP_DATA ? join(process.env.MINIDSH_DESKTOP_DATA, 'logs') : undefined)
if (!app.requestSingleInstanceLock()) app.exit(0)

// ---------------------------------------------------------------- state

type View =
  | { readonly kind: 'starting' }
  | { readonly kind: 'welcome'; readonly notice?: string }
  | { readonly kind: 'keys' }
  | { readonly kind: 'stopping'; readonly restarting: boolean }
  | { readonly kind: 'stopped'; readonly title: string; readonly detail: string; readonly tail: string }

interface Live {
  readonly runtime: RuntimeProcess
  readonly port: number
  readonly ready: RuntimeReady
  /** `minidsh_session=…`, injected into this window's requests only; cleared the instant the runtime exits. */
  cookie: string | undefined
}

let win: BrowserWindow | undefined
let overlay: WebContentsView | undefined
let view: View = { kind: 'starting' }
let live: Live | undefined
let settings: DesktopSettings
let settingsFile = ''
let logsDir = ''
/** Set once the stop has finished and nothing may veto the exit any more. */
let exiting = false
/** A quit, restart or folder change in progress: one at a time. */
let busy: Promise<void> | undefined
let reloads = 0
let home: string | undefined
/** The runtime being started (before `ready`), so a quit can stop it rather than wait out its boot. */
let starting: RuntimeProcess | undefined
/** A quit was asked for: a start it interrupts ends quietly, not in the stopped view. */
let quitting = false
/** What the keys view covers, so closing it returns there: the Web UI, or the view it replaced (or the lifecycle showed since). */
let keysReturn: View | 'web' = 'web'
/** The web renderer died while a lifecycle action ran (the reason): recovered once nothing runs. */
let webGone: string | undefined
/**
 * Folder changes asked for and not applied yet, in order. They live apart
 * from the queued action, so a later request replacing that action (or a quit
 * outranking it) never drops a change the person already confirmed.
 */
let pendingChanges: ((current: DesktopSettings) => DesktopSettings)[] = []

// ---------------------------------------------------------------- logs

function log(line: string): void {
  try {
    appendFileSync(join(logsDir, 'main.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A full or read-only disk must not take the window down with it.
  }
}

/** One rotation at start: the previous run's file is kept as `.1`, so a crash's log survives the relaunch that reports it. */
function rotate(name: string): void {
  const file = join(logsDir, name)
  try {
    if (existsSync(file) && statSync(file).size > 0) renameSync(file, `${file}.1`)
  } catch {
    // Best effort.
  }
}

let runtimeLogBytes = 0
function appendRuntimeLog(chunk: Buffer): void {
  if (runtimeLogBytes > LOG_CAP_BYTES) return
  runtimeLogBytes += chunk.length
  try {
    appendFileSync(join(logsDir, 'runtime.log'), runtimeLogBytes > LOG_CAP_BYTES ? Buffer.concat([chunk, Buffer.from(`\n[runtime.log capped at ${LOG_CAP_BYTES} bytes for this run]\n`)]) : chunk)
  } catch {
    // Best effort.
  }
}

// ---------------------------------------------------------------- the runtime

/** Where the bundled Node and CLI are. Unpackaged (development) runs name them explicitly. */
function runtimeFiles(): { node: string; bin: string; nodeDir: string } {
  if (app.isPackaged) {
    const resources = process.resourcesPath
    const node = process.platform === 'win32' ? join(resources, 'node', 'node.exe') : join(resources, 'node', 'bin', 'node')
    return { node, nodeDir: dirname(node), bin: join(resources, 'runtime', 'node_modules', 'minidsh', 'bin', 'minidsh.js') }
  }
  const node = process.env.MINIDSH_DESKTOP_NODE
  const bin = process.env.MINIDSH_DESKTOP_BIN
  if (!node || !bin) throw new Error('an unpackaged run needs MINIDSH_DESKTOP_NODE and MINIDSH_DESKTOP_BIN')
  return { node, nodeDir: dirname(node), bin }
}

/** The folder rules' context: MiniDSH's own places, which a workspace may neither hold nor sit inside. */
function folderContext(): FolderContext {
  // The install as the person launches it: an AppImage's FILE (its mount is
  // per launch and read-only; a folder holding the file is refused, a project
  // beside it in ~/Downloads is not), a macOS bundle, else the executable's folder.
  const installDir = process.env.APPIMAGE !== undefined ? process.env.APPIMAGE : process.platform === 'darwin' ? join(process.resourcesPath, '..', '..') : dirname(process.execPath)
  return { ...(home === undefined ? {} : { home }), userData: app.getPath('userData'), installDir, profile: homedir(), platform: process.platform }
}

async function freePort(): Promise<number> {
  if (settings.port !== undefined && (await probePort(settings.port))) return settings.port
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = choosePort()
    if (await probePort(port)) return port
  }
  return choosePort()
}

function describeStartError(error: StartFailure): { title: string; detail: string; tail: string } {
  switch (error.kind) {
    case 'spawn':
      return { title: "MiniDSH's runtime could not be started", detail: `${error.message}. If MiniDSH's own files are missing, reinstalling it restores them.`, tail: '' }
    case 'error-record':
      return { title: "MiniDSH's runtime refused to start", detail: `${error.code}: ${error.message}${error.code === 'WORKSPACE' ? ' Remove that folder in File > Remove Folder, or open another.' : ''}`, tail: '' }
    case 'exited':
      return { title: "MiniDSH's runtime stopped while starting", detail: `exit code ${String(error.code)}${error.signal ? ` (${error.signal})` : ''}`, tail: error.stderrTail }
    case 'timeout':
      return { title: "MiniDSH's runtime did not start", detail: 'it printed no ready record within two minutes', tail: '' }
    case 'protocol':
      return { title: "MiniDSH's runtime answered in a way this app does not understand", detail: error.detail, tail: '' }
  }
}

/**
 * The folders this start may serve: every stored one re-admitted (a settings
 * file written by another build, or moved under a rule since, is held to the
 * same rules as a fresh pick) and present now. A refused one leaves the
 * settings for good; a missing one (an unplugged drive, a deleted project)
 * stays remembered but is skipped this time, so it never blocks the start.
 */
function usableFolders(): { readonly usable: string[]; readonly missing: string[] } {
  const usable: string[] = []
  const missing: string[] = []
  const refused: string[] = []
  for (const folder of settings.folders) {
    if (!existsSync(folder)) {
      missing.push(folder)
      continue
    }
    const verdict = admitFolder(folder, folderContext())
    if (verdict.ok) usable.push(verdict.path)
    else {
      refused.push(folder)
      log(`folder refused and forgotten: ${folder} (${verdict.reason})`)
    }
  }
  if (refused.length > 0) persist({ ...settings, folders: settings.folders.filter((folder) => !refused.includes(folder)) })
  for (const folder of missing) log(`folder missing, skipped this start: ${folder}`)
  return { usable, missing }
}

/** Start the runtime over the usable folders and show the Web UI. A live runtime is stopped first, so there is never a second one. */
async function startRuntime(): Promise<void> {
  if (live) await stopRuntime(true)
  // A quit asked for during that stop (or before this start ran) waits for no boot.
  if (quitting) return
  const { usable, missing } = usableFolders()
  const folder = usable[0]
  if (folder === undefined) {
    return showView({ kind: 'welcome', ...(missing.length > 0 ? { notice: `MiniDSH could not find ${missing.length === 1 ? 'the folder it works in' : 'the folders it works in'}: ${missing.join(', ')}. Choose a folder, or reconnect the drive and restart MiniDSH.` } : {}) })
  }
  showView({ kind: 'starting' })
  const files = runtimeFiles()
  let port = await freePort()
  for (let attempt = 0; ; attempt++) {
    if (quitting) return
    const runtime = new RuntimeProcess()
    let ready: RuntimeReady
    starting = runtime
    try {
      ready = await runtime.start({
        node: files.node,
        bin: files.bin,
        port,
        cwd: folder,
        folders: usable,
        // The process runs from the app's own data folder: --cwd carries the
        // workspace, and a folder deleted under it never fails the spawn.
        spawnCwd: app.getPath('userData'),
        env: runtimeEnv(process.env, files.nodeDir),
        onStderr: appendRuntimeLog,
        onFault: (detail) => log(`runtime broke its launch contract after ready: ${detail}`),
      })
    } catch (error) {
      if (!(error instanceof RuntimeStartError)) throw error
      const failure = error.failure
      if (quitting) {
        starting = undefined
        return
      }
      // A persisted port another program took (or a range Hyper-V reserved
      // since): choose a fresh one ONCE, then report.
      if (attempt === 0 && failure.kind === 'error-record' && (failure.code === 'EADDRINUSE' || failure.code === 'EACCES')) {
        log(`port ${port} refused (${failure.code}); choosing another`)
        port = await freePort()
        continue
      }
      starting = undefined
      log(`start failed: ${failure.kind}`)
      return showView({ kind: 'stopped', ...describeStartError(failure) })
    }
    let cookie: string
    try {
      cookie = await signIn(ready.port, ready.token)
    } catch (error) {
      // The one-shot token was spent by someone else, or the answer was not
      // our host's: never retry with it, never show the page.
      starting = undefined
      log(`handoff refused: ${error instanceof Error ? error.message : String(error)}`)
      await runtime.stop({ deadlineMs: 2_000 })
      return showView({ kind: 'stopped', title: 'MiniDSH could not sign in to its own runtime', detail: 'the launch credential was not accepted; restart MiniDSH', tail: '' })
    }
    const current: Live = { runtime, port: ready.port, ready, cookie }
    starting = undefined
    live = current
    home = ready.home
    reloads = 0
    if (settings.port !== ready.port) persist({ ...settings, port: ready.port })
    log(`runtime ready on port ${ready.port} (minidsh ${ready.version}, ${ready.workspaces.length} folder(s))`)
    void runtime.exited.then((end) => onRuntimeExit(current, end))
    await loadWebUi(current)
    return
  }
}

/** Synchronous first: the credential must be gone before anything else runs, so a process binding the port next is never sent it. */
function onRuntimeExit(ended: Live, end: { code: number | null; signal: NodeJS.Signals | null; requested: boolean }): void {
  ended.cookie = undefined
  if (live === ended) live = undefined
  log(`runtime exited code=${String(end.code)} signal=${String(end.signal)} requested=${String(end.requested)}`)
  if (end.requested || exiting) return
  void win?.webContents.loadURL('about:blank')
  showView({
    kind: 'stopped',
    title: "MiniDSH's runtime stopped unexpectedly",
    detail: `exit code ${String(end.code)}${end.signal ? ` (${end.signal})` : ''}. Your sessions are kept; restarting repairs and resumes them.`,
    tail: ended.runtime.stderrTail(),
  })
}

async function loadWebUi(current: Live): Promise<void> {
  if (!win) return
  try {
    await win.webContents.loadURL(`http://127.0.0.1:${current.port}/`)
    webGone = undefined
    hideOverlay()
  } catch (error) {
    // ERR_ABORTED: another navigation superseded this one (a reload): the page
    // still loads, so this is no failure to cover it with.
    if (live !== current || (error as { code?: string }).code === 'ERR_ABORTED') return
    log(`web ui did not load: ${error instanceof Error ? error.message : String(error)}`)
    showView({ kind: 'stopped', title: 'The MiniDSH window could not load', detail: error instanceof Error ? error.message : String(error), tail: '' })
  }
}

/** Ask the runtime, through the wire, whether stopping it now would interrupt work. */
async function confirmInterrupt(action: 'quit' | 'restart'): Promise<boolean> {
  const current = live
  if (!current?.cookie || !win) return true
  const state = await inspectRuntime({ port: current.port, cookie: current.cookie })
  if (!state.busy) return true
  const parts = [
    state.running > 0 ? `${state.running} running turn${state.running === 1 ? '' : 's'}` : '',
    state.jobs > 0 ? `${state.jobs} background job${state.jobs === 1 ? '' : 's'}` : '',
    state.approvals > 0 ? `${state.approvals} approval${state.approvals === 1 ? '' : 's'} waiting` : '',
  ].filter(Boolean)
  const what = state.unknown ? "MiniDSH could not tell whether work is running." : `Work is running: ${parts.join(', ')}.`
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'MiniDSH',
    message: action === 'quit' ? 'Quit MiniDSH?' : "Restart MiniDSH's runtime?",
    detail: `${what} ${action === 'quit' ? 'Quitting' : 'Restarting'} stops it; every session is kept and can be resumed.`,
    buttons: [action === 'quit' ? 'Quit' : 'Restart', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return result.response === 0
}

/** Stop the runtime gracefully (stdin end), behind the stopping view, with the web page gone first so no prompt races the stop. */
async function stopRuntime(restarting: boolean): Promise<void> {
  const current = live
  if (!current) return
  showView({ kind: 'stopping', restarting })
  await win?.webContents.loadURL('about:blank').catch(() => undefined)
  const result = await current.runtime.stop({ deadlineMs: STOP_DEADLINE_MS })
  log(`runtime stop: graceful=${String(result.graceful)} killed=${String(result.killed)}`)
}

/**
 * One lifecycle action at a time (start, restart, quit), and NOTHING dropped:
 * a request arriving while one runs waits in a single slot, the latest
 * replacing an earlier one, except that a quit is never replaced. Dropping
 * was a defect the packaged E2E found: a close or a SIGTERM landing while
 * the start was still loading the page was ignored, and the app never quit.
 * What a replaced action was FOR is not lost with it: folder changes wait in
 * `pendingChanges`, and the action that runs applies them all.
 */
let queued: { readonly action: () => Promise<void>; readonly quit: boolean } | undefined

function serialize(action: () => Promise<void>, quit = false): void {
  if (busy) {
    if (quit || !queued?.quit) queued = { action, quit }
    showWindow()
    return
  }
  busy = action()
    .catch((error: unknown) => log(`lifecycle action failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      busy = undefined
      const next = queued
      queued = undefined
      if (next) serialize(next.action, next.quit)
      else settle()
    })
}

/**
 * Nothing runs or waits: put right what an action left only because it ended
 * early (a Cancel, a load another navigation superseded). A web renderer that
 * died meanwhile is recovered now; a leftover "starting" over a live runtime
 * is lifted.
 */
function settle(): void {
  const current = live
  if (!current || exiting) return
  if (webGone !== undefined) {
    const reason = webGone
    webGone = undefined
    return recoverWeb(current, reason)
  }
  if (view.kind === 'starting' && overlayShown()) removeOverlay()
}

/** Every pending folder change, in the order asked, saved as one. */
function applyPendingChanges(): void {
  if (pendingChanges.length === 0) return
  const changes = pendingChanges
  pendingChanges = []
  persist(changes.reduce((next, change) => change(next), settings))
}

function requestQuit(): void {
  quitting = true
  // A start still booting is stopped now (stdin's end, a kill at the bound),
  // so the quit queued behind it waits seconds, not the boot's two minutes.
  if (starting && !live) void starting.stop({ deadlineMs: 5_000 })
  serialize(async () => {
    if (!(await confirmInterrupt('quit'))) {
      quitting = false
      // A folder change that arrived behind this quit runs now.
      if (pendingChanges.length > 0) reconcile()
      return
    }
    // Folder changes the person asked for before quitting are kept for the next launch.
    applyPendingChanges()
    await stopRuntime(false)
    exiting = true
    // Both ends of the quit are logged: an app that stayed up after its
    // runtime stopped (seen on a macOS runner, S22.5) must say how far it got.
    log('quit: runtime stopped, closing')
    app.quit()
  }, true)
}

/**
 * The ONE way the runtime's folder set or life changes: decided when the
 * action RUNS, not when it was asked for (a start still running when a folder
 * was picked must not leave two runtimes). Confirm first if work would stop;
 * only then save the changes (a Cancel leaves settings, menu and runtime as
 * they were, every pending change dropped); then stop whatever is live and
 * start over the saved set.
 */
function reconcile(change?: (current: DesktopSettings) => DesktopSettings, confirm = true): void {
  if (change) pendingChanges.push(change)
  serialize(async () => {
    if (live && confirm && !(await confirmInterrupt('restart'))) {
      pendingChanges = []
      return
    }
    applyPendingChanges()
    await startRuntime()
  })
}

// ---------------------------------------------------------------- folders

function persist(next: DesktopSettings): void {
  settings = next
  try {
    writeSettings(settingsFile, next)
  } catch (error) {
    log(`settings not saved: ${error instanceof Error ? error.message : String(error)}`)
  }
  rebuildMenu()
}

async function openFolder(): Promise<void> {
  if (!win) return
  const picked = await dialog.showOpenDialog(win, { title: 'Open a folder for MiniDSH to work in', properties: ['openDirectory', 'createDirectory'] })
  const chosen = picked.filePaths[0]
  if (picked.canceled || chosen === undefined) return
  const verdict = admitFolder(chosen, folderContext())
  if (!verdict.ok) {
    await dialog.showMessageBox(win, { type: 'error', title: 'MiniDSH', message: 'MiniDSH cannot work in that folder', detail: verdict.reason, buttons: ['OK'], noLink: true })
    return
  }
  reconcile((current) => withCurrentFolder(current, verdict.path))
}

async function removeFolder(folder: string): Promise<void> {
  if (!win) return
  const answer = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'MiniDSH',
    message: `Remove ${folder} from MiniDSH?`,
    detail: 'New sessions can no longer start there. Its sessions are kept, and resuming or forking one still works in that folder.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (answer.response !== 0) return
  // With no folder left, the start shows the welcome view.
  reconcile((current) => withoutFolder(current, folder))
}

// ---------------------------------------------------------------- the window

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff'
}

/** http(s) and mailto open in the person's own browser or mail client; nothing else is ever handed to the OS. */
function openExternalSafe(url: string): void {
  const safe = externalUrl(url)
  if (safe !== undefined) void shell.openExternal(safe)
}

/** The live runtime's own origin (guards.ts). */
function isHostUrl(url: string): boolean {
  return isHostUrlOf(url, live?.port)
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function layoutOverlay(): void {
  if (!win || !overlay) return
  const [width, height] = win.getContentSize()
  overlay.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 })
}

/** A dead Web UI renderer: reloaded twice per runtime, then the stopped view. */
function recoverWeb(current: Live, reason: string): void {
  if (reloads++ < 2) void loadWebUi(current)
  else showView({ kind: 'stopped', title: 'The MiniDSH window stopped', detail: `${reason}. Restart asks first if work is running.`, tail: '' })
}

function overlayShown(): boolean {
  return win !== undefined && overlay !== undefined && win.contentView.children.includes(overlay)
}

/**
 * The lifecycle's view. An open keys form is never taken away by it (a key
 * half typed would vanish, and focus would fall to the composer, where a
 * paste and an Enter send the key as a prompt): what the lifecycle shows
 * meanwhile is where closing the form returns. Only a quit's stop replaces
 * the form, since the window is going.
 */
function showView(next: View): void {
  const shaped: View = next.kind === 'stopped' ? { ...next, tail: displayTail(next.tail, 6_000) } : next
  if (view.kind === 'keys' && !(shaped.kind === 'stopping' && !shaped.restarting)) {
    keysReturn = shaped
    return
  }
  present(shaped)
}

/** The lifecycle uncovering the Web UI; under an open keys form, the Web UI becomes where closing it returns. */
function hideOverlay(): void {
  if (view.kind === 'keys') {
    keysReturn = 'web'
    return
  }
  removeOverlay()
}

function present(next: View): void {
  view = next
  if (!win || !overlay) return
  if (!overlayShown()) win.contentView.addChildView(overlay)
  layoutOverlay()
  overlay.webContents.send('shell:view', shellState())
  // Keys go to what is on top: never to the Web UI's composer under a form
  // (a key pasted there and an Enter would have been sent as a prompt).
  overlay.webContents.focus()
}

function removeOverlay(): void {
  if (win && overlay && overlayShown()) win.contentView.removeChildView(overlay)
  view = { kind: 'starting' }
  win?.webContents.focus()
}

/** The keys view over whatever shows now; closing it returns there. Asked again while open, it stays as it is. */
function openKeys(): void {
  if (view.kind === 'keys') {
    overlay?.webContents.focus()
    return
  }
  keysReturn = overlayShown() ? view : 'web'
  present({ kind: 'keys' })
}

function closeKeys(): void {
  if (view.kind !== 'keys') return
  const back = keysReturn
  keysReturn = 'web'
  if (back !== 'web') return present(back)
  if (live) return removeOverlay()
  // Nothing live and nothing shown since: the action under way shows what comes next.
  present({ kind: 'starting' })
}

function shellState(): Record<string, unknown> {
  return {
    view,
    version: app.getVersion(),
    platform: process.platform,
    folders: settings.folders,
    live: live !== undefined,
    pwsh: process.platform === 'win32' ? findPwsh() : true,
  }
}

/** Windows needs PowerShell 7 for every shell call (ARCHITECTURE §13); the welcome view says so before the first refusal does. */
function findPwsh(): boolean {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH')
  const dirs = (key === undefined ? '' : (process.env[key] ?? '')).split(delimiter).filter(Boolean)
  // PATH alone: the runtime starts `pwsh` by name, so a pwsh.exe that is
  // installed but off PATH fails every shell call all the same.
  return dirs.some((dir) => existsSync(join(dir, 'pwsh.exe')))
}

function saveBounds(): void {
  if (!win || win.isDestroyed() || win.isMinimized()) return
  const maximized = win.isMaximized()
  const bounds = maximized ? (settings.window ?? win.getNormalBounds()) : win.getBounds()
  settings = { ...settings, window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized } }
  try {
    writeSettings(settingsFile, settings)
  } catch {
    // Best effort.
  }
}

function createWindow(): void {
  const remembered = settings.window
  const displays = screen.getAllDisplays().map((display) => display.workArea)
  const usable = remembered !== undefined && boundsVisible(remembered, displays)
  win = new BrowserWindow({
    ...(usable ? { x: remembered.x, y: remembered.y, width: remembered.width, height: remembered.height } : { width: 1280, height: 840 }),
    minWidth: 520,
    minHeight: 560,
    show: false,
    title: 'MiniDSH',
    backgroundColor: backgroundColor(),
    ...(process.platform === 'linux' ? { icon: join(process.resourcesPath, 'icon.png') } : {}),
    webPreferences: {
      partition: 'persist:minidsh',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  if (usable && remembered.maximized) win.maximize()
  const web = win.webContents
  guardWebView(web)
  overlay = new WebContentsView({
    webPreferences: {
      partition: SHELL_SCHEME,
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  overlay.setBackgroundColor(backgroundColor())
  overlay.webContents.on('will-navigate', (event) => event.preventDefault())
  overlay.webContents.on('context-menu', (_event, params) => editingMenu(params))
  win.contentView.addChildView(overlay)
  layoutOverlay()
  void overlay.webContents.loadURL(SHELL_URL)
  overlay.webContents.once('did-finish-load', () => {
    overlay?.webContents.send('shell:view', shellState())
    win?.show()
  })
  win.on('resize', layoutOverlay)
  win.on('resized', saveBounds)
  win.on('moved', saveBounds)
  win.on('maximize', saveBounds)
  win.on('unmaximize', saveBounds)
  win.on('close', (event) => {
    if (exiting) return
    event.preventDefault()
    saveBounds()
    requestQuit()
  })
  // Windows is ending the session: there is no time to ask or to wait. End
  // the runtime's stdin so it starts its own stop; the OS ends both of us, and
  // whatever is left the next open repairs (§13).
  win.on('session-end', () => {
    exiting = true
    void live?.runtime.stop()
  })
  void web.loadURL('about:blank')
}

/** The Web UI's webContents: its navigation, its windows, its crashes. */
function guardWebView(web: WebContents): void {
  web.on('will-navigate', (event, url) => {
    if (isHostUrl(url)) return
    event.preventDefault()
    openExternalSafe(url)
  })
  // The window never legitimately sees a redirect: main spent the token's 303 itself.
  web.on('will-redirect', (event) => event.preventDefault())
  web.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault()
  })
  web.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  web.on('render-process-gone', (_event, details) => {
    log(`web renderer gone: ${details.reason}`)
    if (exiting) return
    // Never under a stop, a restart or a start: reloading would bring a
    // stopping runtime's page back and reopen the race about:blank closed.
    // Remembered instead, and recovered when the action settles (a confirm
    // the person cancelled loads nothing that would replace the dead page).
    if (busy) {
      webGone = details.reason
      return
    }
    if (live) recoverWeb(live, details.reason)
  })
  web.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isHostUrl(url)) return
    log(`web ui load failed: ${code} ${description}`)
  })
  web.on('context-menu', (_event, params) => editingMenu(params))
}

/** Cut, copy, paste and select-all where editing; copy a selection; open an http(s)/mailto link outside. */
function editingMenu(params: Electron.ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = []
  if (params.isEditable) {
    items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' })
  } else if (params.selectionText.trim().length > 0) items.push({ role: 'copy' })
  if (params.linkURL && externalUrl(params.linkURL) !== undefined) {
    if (items.length > 0) items.push({ type: 'separator' })
    items.push({ label: 'Open Link', click: () => openExternalSafe(params.linkURL) })
  }
  if (items.length > 0 && win) Menu.buildFromTemplate(items).popup({ window: win })
}

/**
 * Every webContents, the web view's, the overlay's and any DevTools': no
 * permission, no device, no download, no webview, no window. The Web UI's copy
 * buttons fall back to `execCommand('copy')`, which needs none (measured).
 */
function hardenSession(s: Electron.Session): void {
  s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  s.setPermissionCheckHandler(() => false)
  s.setDevicePermissionHandler(() => false)
  s.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  s.on('will-download', (event) => event.preventDefault())
  s.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback('')
  })
  s.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault()
    callback('')
  })
  s.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback('')
  })
}

/**
 * The credential handoff (S22.2): the cookie main got for the token is
 * injected into the web view's own requests to its own runtime, and to
 * nothing else; nothing is ever stored in the jar, and a `set-cookie` never
 * lands there either.
 */
function installHandoff(): void {
  const web = session.fromPartition('persist:minidsh')
  void web.setProxy({ mode: 'direct' })
  web.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] }, (details, callback) => {
    const current = live
    if (current?.cookie && win && details.webContentsId === win.webContents.id && isHostUrl(details.url)) {
      callback({ requestHeaders: { ...details.requestHeaders, Cookie: current.cookie } })
      return
    }
    callback({ requestHeaders: details.requestHeaders })
  })
  web.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'set-cookie') delete headers[name]
    callback({ responseHeaders: headers })
  })
}

function serveShell(): void {
  const root = join(import.meta.dirname, '..', 'shell')
  session.fromPartition(SHELL_SCHEME).protocol.handle(SHELL_SCHEME, (request) => {
    const url = new URL(request.url)
    const file = url.host === 'app' ? SHELL_FILES[url.pathname] : undefined
    if (!file) return new Response('not found', { status: 404 })
    return new Response(readFileSync(join(root, file[0])), { headers: { 'content-type': file[1], 'x-content-type-options': 'nosniff' } })
  })
}

// ---------------------------------------------------------------- the shell overlay's API

/** Only the overlay's own main frame, on the shell's one page, may call. */
function fromShell(event: IpcMainInvokeEvent): boolean {
  return overlay !== undefined && event.sender === overlay.webContents && event.senderFrame === overlay.webContents.mainFrame && event.senderFrame?.url.split('#')[0] === SHELL_URL
}

function handle(channel: string, body: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromShell(event)) throw new Error('not allowed')
    return body(...args)
  })
}

function installShellApi(): void {
  handle('shell:state', () => shellState())
  handle('shell:chooseFolder', () => openFolder())
  // Restart from the stopped view: through reconcile, so a runtime still live
  // under it (the window, not the runtime, stopped) is asked about first.
  handle('shell:restart', () => reconcile())
  handle('shell:quit', () => requestQuit())
  handle('shell:showLogs', () => void shell.openPath(logsDir))
  handle('shell:closeKeys', () => closeKeys())
  // The shell sees names and where each is set, never a value; a value it
  // sends goes to the runtime's own writer on stdin, never argv or env.
  handle('shell:listKeys', async () => {
    const files = runtimeFiles()
    const result = await listCredentials({ node: files.node, bin: files.bin, env: runtimeEnv(process.env, files.nodeDir), cwd: app.getPath('userData') })
    // The home as the runtime resolves it: the folder rules need it before any start.
    if (result.ok) home = result.list.home
    return result.ok ? { ok: true, store: result.list.store, refs: result.list.refs } : { ok: false, message: result.reason }
  })
  handle('shell:saveKey', async (name, value) => {
    if (typeof name !== 'string' || typeof value !== 'string') return { ok: false, message: 'a name and a value' }
    const files = runtimeFiles()
    const result = await setCredential({ node: files.node, bin: files.bin, env: runtimeEnv(process.env, files.nodeDir), cwd: app.getPath('userData'), name, value })
    log(`provider key ${name}: ${result.ok ? 'saved' : 'refused'}`)
    return result.ok ? { ok: true } : { ok: false, message: result.reason }
  })
}

// ---------------------------------------------------------------- menus

async function checkUpdates(): Promise<void> {
  if (!win) return
  const result = await checkForUpdate({ current: app.getVersion(), fetchImpl: (input, init) => net.fetch(input, init) })
  if (result.kind === 'newer') {
    const answer = await dialog.showMessageBox(win, { type: 'info', title: 'MiniDSH', message: `MiniDSH ${result.version} is available`, detail: `You have ${app.getVersion()}. The release page has the installer; quit MiniDSH before running it.`, buttons: ['Open the release page', 'Later'], defaultId: 0, cancelId: 1, noLink: true })
    if (answer.response === 0) openExternalSafe(result.url)
  } else if (result.kind === 'current') {
    await dialog.showMessageBox(win, { type: 'info', title: 'MiniDSH', message: `MiniDSH ${app.getVersion()} is the latest release`, buttons: ['OK'], noLink: true })
  } else {
    await dialog.showMessageBox(win, { type: 'warning', title: 'MiniDSH', message: 'Could not check for updates', detail: result.message, buttons: ['OK'], noLink: true })
  }
}

function about(): void {
  if (!win) return
  const runtime = live?.ready.version
  void dialog.showMessageBox(win, {
    type: 'info',
    title: 'About MiniDSH',
    message: `MiniDSH ${app.getVersion()}`,
    detail: [`Runtime ${runtime ?? 'not running'}`, `Electron ${process.versions.electron}`, `Chromium ${process.versions.chrome}`, '', 'An independent project; not affiliated with DeepSeek.', REPOSITORY].join('\n'),
    buttons: ['OK'],
    noLink: true,
  })
}

function dispatch(id: string): void {
  const folder = folderOfRemoveId(id)
  if (folder !== undefined) {
    // Only a folder still in the settings: a menu built before a change names what it showed.
    if (settings.folders.includes(folder)) void removeFolder(folder)
    return
  }
  switch (id) {
    case MENU_IDS.openFolder:
      void openFolder()
      return
    case MENU_IDS.providerKeys:
      openKeys()
      return
    case MENU_IDS.quit:
      requestQuit()
      return
    case MENU_IDS.checkForUpdates:
      void checkUpdates()
      return
    case MENU_IDS.showLogs:
      void shell.openPath(logsDir)
      return
    case MENU_IDS.openGitHub:
      openExternalSafe(REPOSITORY)
      return
    case MENU_IDS.toggleDevTools:
      win?.webContents.toggleDevTools()
      return
    case MENU_IDS.about:
      about()
      return
  }
}

function toElectron(items: readonly MenuItemTemplate[]): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    const { id, submenu, ...rest } = item
    return {
      ...(rest as MenuItemConstructorOptions),
      ...(submenu === undefined ? {} : { submenu: toElectron(submenu) }),
      ...(id === undefined ? {} : { id, click: () => dispatch(id) }),
    }
  })
}

function rebuildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectron(menuTemplate({ platform: process.platform, folders: settings.folders, ...(settings.folders[0] === undefined ? {} : { current: settings.folders[0] }), appName: 'MiniDSH' }))))
}

// ---------------------------------------------------------------- start

app.on('second-instance', () => {
  log('a second launch deferred to this window')
  showWindow()
})
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
})
app.on('before-quit', (event) => {
  if (exiting) return
  event.preventDefault()
  requestQuit()
})
// Closing is quitting (the person's decision, S22.2): the window's close
// handler already asked; nothing here may quit behind it.
app.on('window-all-closed', () => {
  if (exiting) app.quit()
})
app.on('will-quit', () => log('quit: every window closed'))

// Electron shows an uncaught exception in main in a MODAL box, which parks the
// main thread until someone answers it. While quitting there is nobody to
// answer and nothing left to protect: such a box kept the app alive, with no
// window, after "every window closed" (sampled on a macOS runner in
// `-[NSAlert runModal]`, S22.5). So the exception is always logged, and while
// exiting the app ends, with a failing code. At any other time the person is
// told, as Electron would have told them.
process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  if (exiting) return app.exit(1)
  dialog.showErrorBox('MiniDSH met an internal error', `${error instanceof Error ? error.message : String(error)}\n\nmain.log has the details (Help, Show Logs). Your sessions are kept.`)
})

void app.whenReady().then(() => {
  logsDir = app.getPath('logs')
  mkdirSync(logsDir, { recursive: true })
  rotate('main.log')
  rotate('runtime.log')
  settingsFile = join(app.getPath('userData'), 'settings.json')
  const read = readSettings(settingsFile)
  settings = read.settings
  for (const problem of read.problems) log(`settings: ${problem}`)
  log(`MiniDSH ${app.getVersion()} starting (Electron ${process.versions.electron})`)
  // An AppImage's launcher adds this where unprivileged user namespaces are
  // unavailable (Ubuntu 24.04's default): the renderer then runs without
  // Chromium's OS sandbox, and the log says so (ARCHITECTURE §13).
  if (app.commandLine.hasSwitch('no-sandbox')) log('running WITHOUT the Chromium sandbox (--no-sandbox): the renderer is not OS-confined')
  for (const one of [session.fromPartition('persist:minidsh'), session.fromPartition(SHELL_SCHEME), session.defaultSession]) hardenSession(one)
  installHandoff()
  serveShell()
  installShellApi()
  rebuildMenu()
  nativeTheme.on('updated', () => {
    win?.setBackgroundColor(backgroundColor())
    overlay?.setBackgroundColor(backgroundColor())
  })
  createWindow()
  reconcile(undefined, false)
})

