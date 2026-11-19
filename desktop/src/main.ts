/**
 * The MiniDSH desktop app's main process: a launcher, one window and the
 * lifecycle around ONE runtime child. Wiring only — every decision with a
 * rule lives in a pure module beside it (runtime, inspect, folders, settings,
 * menu, credentials, update, text), so this file has nothing to test that
 * the packaged app's end-to-end run does not exercise.
 *
 * What the desktop is (ARCHITECTURE §8, the desktop row): a SURFACE. It never
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
import { admitFolder, boundsVisible } from './folders.ts'
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
app.setAppLogsPath()
if (!app.requestSingleInstanceLock()) app.exit(0)

// ---------------------------------------------------------------- state

type View =
  | { readonly kind: 'starting' }
  | { readonly kind: 'welcome' }
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

/**
 * The runtime's environment: the person's own, with the bundled Node's
 * directory APPENDED to PATH so an agent's `node` finds the person's own first
 * and a machine without one still runs the bundled office and pdf skills.
 */
function runtimeEnv(nodeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = env[key]
  env[key] = current ? `${current}${delimiter}${nodeDir}` : nodeDir
  return env
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
      return { title: "MiniDSH's runtime could not be started", detail: `${error.message}. Reinstalling MiniDSH restores its bundled files.`, tail: '' }
    case 'error-record':
      return { title: "MiniDSH's runtime refused to start", detail: `${error.code}: ${error.message}`, tail: '' }
    case 'exited':
      return { title: "MiniDSH's runtime stopped while starting", detail: `exit code ${String(error.code)}${error.signal ? ` (${error.signal})` : ''}`, tail: error.stderrTail }
    case 'timeout':
      return { title: "MiniDSH's runtime did not start", detail: 'it printed no ready record within two minutes', tail: '' }
    case 'protocol':
      return { title: "MiniDSH's runtime answered in a way this app does not understand", detail: error.detail, tail: '' }
  }
}

/** Start the runtime over the remembered folders and show the Web UI. Never called with a live runtime. */
async function startRuntime(): Promise<void> {
  const folder = settings.folders[0]
  if (folder === undefined) return showView({ kind: 'welcome' })
  showView({ kind: 'starting' })
  const files = runtimeFiles()
  let port = await freePort()
  for (let attempt = 0; ; attempt++) {
    const runtime = new RuntimeProcess()
    let ready: RuntimeReady
    try {
      ready = await runtime.start({
        node: files.node,
        bin: files.bin,
        port,
        cwd: folder,
        folders: settings.folders,
        env: runtimeEnv(files.nodeDir),
        onStderr: appendRuntimeLog,
        onFault: (detail) => log(`runtime broke its launch contract after ready: ${detail}`),
      })
    } catch (error) {
      if (!(error instanceof RuntimeStartError)) throw error
      const failure = error.failure
      // A persisted port another program took (or a range Hyper-V reserved
      // since): choose a fresh one ONCE, then report.
      if (attempt === 0 && failure.kind === 'error-record' && (failure.code === 'EADDRINUSE' || failure.code === 'EACCES')) {
        log(`port ${port} refused (${failure.code}); choosing another`)
        port = await freePort()
        continue
      }
      log(`start failed: ${failure.kind}`)
      return showView({ kind: 'stopped', ...describeStartError(failure) })
    }
    let cookie: string
    try {
      cookie = await signIn(ready.port, ready.token)
    } catch (error) {
      // The one-shot token was spent by someone else, or the answer was not
      // our host's: never retry with it, never show the page.
      log(`handoff refused: ${error instanceof Error ? error.message : String(error)}`)
      await runtime.stop({ deadlineMs: 2_000 })
      return showView({ kind: 'stopped', title: 'MiniDSH could not sign in to its own runtime', detail: 'the launch credential was not accepted; restart MiniDSH', tail: '' })
    }
    const current: Live = { runtime, port: ready.port, ready, cookie }
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
    hideOverlay()
  } catch (error) {
    if (live !== current) return
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

/** One serialized lifecycle action at a time; a second request while one runs only shows the window. */
function serialize(action: () => Promise<void>): void {
  if (busy) {
    showWindow()
    return
  }
  busy = action().finally(() => {
    busy = undefined
  })
}

function requestQuit(): void {
  serialize(async () => {
    if (!(await confirmInterrupt('quit'))) return
    await stopRuntime(false)
    exiting = true
    app.quit()
  })
}

function restartRuntime(confirm: boolean): void {
  serialize(async () => {
    if (confirm && !(await confirmInterrupt('restart'))) return
    await stopRuntime(true)
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
  const verdict = admitFolder(chosen, { ...(home === undefined ? {} : { home }), userData: app.getPath('userData'), installDir: dirname(process.execPath), profile: homedir(), platform: process.platform })
  if (!verdict.ok) {
    await dialog.showMessageBox(win, { type: 'error', title: 'MiniDSH', message: 'MiniDSH cannot work in that folder', detail: verdict.reason, buttons: ['OK'], noLink: true })
    return
  }
  persist(withCurrentFolder(settings, verdict.path))
  if (live) restartRuntime(true)
  else serialize(startRuntime)
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
  persist(withoutFolder(settings, folder))
  if (settings.folders.length === 0) {
    serialize(async () => {
      if (!(await confirmInterrupt('restart'))) return
      await stopRuntime(true)
      showView({ kind: 'welcome' })
    })
  } else restartRuntime(true)
}

// ---------------------------------------------------------------- the window

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff'
}

/** http(s) and mailto open in the person's own browser or mail client; nothing else is ever handed to the OS. */
function openExternalSafe(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') void shell.openExternal(parsed.href)
}

function isHostUrl(url: string): boolean {
  const current = live
  if (!current) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'ws:') && parsed.host === `127.0.0.1:${current.port}`
  } catch {
    return false
  }
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

function showView(next: View): void {
  view = next.kind === 'stopped' ? { ...next, tail: displayTail(next.tail, 6_000) } : next
  if (!win || !overlay) return
  if (!win.contentView.children.includes(overlay)) win.contentView.addChildView(overlay)
  layoutOverlay()
  overlay.webContents.send('shell:view', shellState())
}

function hideOverlay(): void {
  if (win && overlay && win.contentView.children.includes(overlay)) win.contentView.removeChildView(overlay)
  view = { kind: 'starting' }
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
  dirs.push(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7'))
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
    const current = live
    if (current && reloads++ < 2) void loadWebUi(current)
    else if (!exiting) showView({ kind: 'stopped', title: 'The MiniDSH window stopped', detail: details.reason, tail: '' })
  })
  web.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isHostUrl(url)) return
    log(`web ui load failed: ${code} ${description}`)
  })
  web.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' })
    } else if (params.selectionText.trim().length > 0) items.push({ role: 'copy' })
    if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({ label: 'Open Link', click: () => openExternalSafe(params.linkURL) })
    }
    if (items.length > 0 && win) Menu.buildFromTemplate(items).popup({ window: win })
  })
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
  handle('shell:restart', () => {
    if (live) restartRuntime(false)
    else serialize(startRuntime)
  })
  handle('shell:quit', () => requestQuit())
  handle('shell:showLogs', () => void shell.openPath(logsDir))
  handle('shell:closeKeys', () => {
    if (live) hideOverlay()
    else showView({ kind: 'welcome' })
  })
  // The shell sees names and where each is set, never a value; a value it
  // sends goes to the runtime's own writer on stdin, never argv or env.
  handle('shell:listKeys', async () => {
    const files = runtimeFiles()
    const result = await listCredentials({ node: files.node, bin: files.bin, env: runtimeEnv(files.nodeDir), cwd: app.getPath('userData') })
    return result.ok ? { ok: true, store: result.list.store, refs: result.list.refs } : { ok: false, message: result.reason }
  })
  handle('shell:saveKey', async (name, value) => {
    if (typeof name !== 'string' || typeof value !== 'string') return { ok: false, message: 'a name and a value' }
    const files = runtimeFiles()
    const result = await setCredential({ node: files.node, bin: files.bin, env: runtimeEnv(files.nodeDir), cwd: app.getPath('userData'), name, value })
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
      showView({ kind: 'keys' })
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectron(menuTemplate({ platform: process.platform, folders: settings.folders, appName: 'MiniDSH' }))))
}

// ---------------------------------------------------------------- start

app.on('second-instance', () => showWindow())
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
  serialize(startRuntime)
})

