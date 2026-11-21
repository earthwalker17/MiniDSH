/**
 * The packaged desktop app, driven the way a person uses it: launched as its
 * own executable with `--remote-debugging-pipe` (the pipe, never a port: only
 * this parent holds fds 3 and 4, and a packaged build refuses the port), its
 * pages reached over tool-browser's own CDP client, its window closed through
 * the window manager, and its native dialogs answered through UI Automation.
 *
 * The app opens its own two pages (the shell overlay and the Web UI's web
 * view), so `page` ATTACHES to a target by URL prefix rather than creating
 * one; the page object is web-ui.ts's (`pageFor`), tripwire included.
 *
 * Hermetic by construction: every launch names its own Electron userData
 * (`MINIDSH_DESKTOP_DATA`, which also gives it its own single-instance lock)
 * and its own `MINIDSH_HOME`, so a person's running copy is never touched.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from '../capabilities/tool-browser/cdp.ts'
import { pageFor, problemOf, type UiPage, type UiProblem } from './web-ui.ts'

export interface DesktopLaunch {
  /** The packaged or installed executable. */
  readonly exe: string
  /** Electron userData for this launch: settings, logs, profile, the lock. */
  readonly userData: string
  /** MINIDSH_HOME for the runtime this launch starts. */
  readonly home: string
  /** Extra environment for the app (and so its runtime), e.g. DEEPSEEK_BASE_URL. */
  readonly env?: NodeJS.ProcessEnv
  /** Variables removed from the inherited environment, e.g. provider keys. */
  readonly drop?: readonly string[]
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const launched = new Set<ChildProcess>()
/** For an afterAll: no app outlives its test file. */
export function killDesktopApps(): void {
  for (const child of launched) child.kill()
  launched.clear()
}

export class DesktopApp {
  readonly child: ChildProcess
  readonly cdp: CdpConnection
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  readonly launch: DesktopLaunch
  stderr = ''
  private readonly pages = new Map<string, UiPage>()
  private readonly sessions = new Map<string, string>()
  private readonly problems = new Map<string, UiProblem[]>()

  constructor(launch: DesktopLaunch) {
    this.launch = launch
    // Dropped from the INHERITED environment first, so a test's own `env` (a
    // dummy key, a local model URL) survives a drop of the same names.
    const inherited: NodeJS.ProcessEnv = { ...process.env }
    for (const name of launch.drop ?? []) delete inherited[name]
    const env: NodeJS.ProcessEnv = { ...inherited, ...launch.env, MINIDSH_DESKTOP_DATA: launch.userData, MINIDSH_HOME: launch.home }
    this.child = spawn(launch.exe, ['--remote-debugging-pipe'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], env })
    launched.add(this.child)
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr += String(chunk)
    })
    this.child.stdout!.resume()
    const [, , , toApp, fromApp] = this.child.stdio as unknown as [null, null, null, Writable, Readable]
    this.cdp = new CdpConnection(toApp, fromApp)
    this.cdp.onEvent((event) => {
      if (event.sessionId === undefined) return
      const problem = problemOf(event)
      if (problem !== undefined) this.problems.get(event.sessionId)?.push(problem)
    })
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        launched.delete(this.child)
        resolve({ code, signal })
      })
    })
  }

  get pid(): number {
    return this.child.pid!
  }

  /** The page whose URL starts with `prefix` (`minidsh-shell:` or `http://127.0.0.1`), attached once it exists. */
  async page(prefix: string, timeoutMs = 60_000): Promise<UiPage> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { targetInfos } = await this.cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')
      const target = targetInfos.find((info) => info.type === 'page' && info.url.startsWith(prefix))
      if (target !== undefined) return this.attach(target.targetId)
      if (Date.now() > deadline) throw new Error(`no page at ${prefix} within ${timeoutMs} ms; pages: ${targetInfos.map((info) => info.url.replace(/token=[^&]+/, 'token=…')).join(', ')}\nstderr: ${this.stderr.slice(-2000)}`)
      await pause(200)
    }
  }

  private async attach(targetId: string): Promise<UiPage> {
    const known = this.pages.get(targetId)
    if (known !== undefined) return known
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    this.sessions.set(targetId, sessionId)
    const problems: UiProblem[] = []
    this.problems.set(sessionId, problems)
    await this.cdp.send('Runtime.enable', {}, { sessionId })
    await this.cdp.send('Log.enable', {}, { sessionId })
    const page = pageFor(this.cdp, sessionId, problems, async () => {
      this.pages.delete(targetId)
      this.problems.delete(sessionId)
      await this.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
    })
    this.pages.set(targetId, page)
    return page
  }

  /**
   * Every cookie the browser holds for the page at `prefix`, read from the
   * browser itself (CDP `Network.getCookies`), HttpOnly ones included: what a
   * page's `document.cookie` cannot show.
   */
  async cookies(prefix: string, urls: readonly string[]): Promise<{ name: string; domain: string }[]> {
    await this.page(prefix)
    const { targetInfos } = await this.cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')
    const target = targetInfos.find((info) => info.type === 'page' && info.url.startsWith(prefix))
    const sessionId = target === undefined ? undefined : this.sessions.get(target.targetId)
    if (sessionId === undefined) throw new Error(`no attached page at ${prefix}`)
    await this.cdp.send('Network.enable', {}, { sessionId })
    const { cookies } = await this.cdp.send<{ cookies: { name: string; domain: string }[] }>('Network.getCookies', { urls }, { sessionId })
    return cookies
  }

  /**
   * The runtime child (the bundled node running `minidsh web --json`), by
   * parentage. `undefined` means one thing: the query RAN and this app has no
   * such child. A query that could not run, or answered something that is no
   * pid, throws — "not found" from a broken lookup read as "the runtime is
   * gone" and as "a different runtime" in the tests that compare pids.
   */
  runtimePid(): number | undefined {
    const pidOf = (text: string, how: string): number | undefined => {
      const first = text.trim().split(/\s+/)[0] ?? ''
      if (first === '') return undefined
      const pid = Number(first)
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`runtimePid: ${how} answered ${JSON.stringify(text.slice(0, 200))}, which is no pid`)
      return pid
    }
    if (process.platform === 'win32') {
      // `Stop`, so a failing CIM call is a non-zero exit and not an empty answer.
      const query = `$ErrorActionPreference = 'Stop'; (Get-CimInstance Win32_Process -Filter "ParentProcessId=${this.pid} AND Name='node.exe'" | Select-Object -First 1).ProcessId`
      const found = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: LOOKUP_MS })
      if (found.error !== undefined || found.status !== 0) throw new Error(`runtimePid: the process query could not answer (${whyNot(found)})`)
      return pidOf(found.stdout, 'the process query')
    }
    const found = spawnSync('pgrep', ['-P', String(this.pid), '-f', 'minidsh.js web'], { encoding: 'utf8', timeout: LOOKUP_MS })
    // pgrep exits 1 when nothing matched: the one failure that is an answer.
    if (found.error === undefined && found.status === 1) return undefined
    if (found.error !== undefined || found.status !== 0) throw new Error(`runtimePid: pgrep could not answer (${whyNot(found)})`)
    return pidOf(found.stdout, 'pgrep')
  }

  /**
   * Close the window as a person does (WM_CLOSE on Windows; SIGTERM elsewhere,
   * which Electron turns into a quit).
   *
   * On Windows the close is CONFIRMED sent. `CloseMainWindow()` answers false
   * when the process has no main window yet, and the app shows its window only
   * once the shell page has loaded: a close issued a moment earlier went
   * nowhere, in silence, and the test that sent it then timed out on an app
   * nobody had asked to quit. So it is asked until the window takes it, to a
   * bound, and a window that never took it is this call's error.
   */
  closeWindow(timeoutMs = 20_000): void {
    if (process.platform !== 'win32') {
      if (!this.child.kill('SIGTERM')) throw new Error(`closeWindow: SIGTERM could not be sent to the app (pid ${this.pid}): it has already exited`)
      return
    }
    // A fresh Process object each time: it caches its main window handle.
    const script = `
$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
  if ((Get-Process -Id ${this.pid}).CloseMainWindow()) { exit 0 }
  Start-Sleep -Milliseconds 100
}
exit 3
`
    const sent = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: timeoutMs + LOOKUP_MS })
    if (sent.error === undefined && sent.status === 0) return
    const why = sent.error === undefined && sent.status === 3 ? `the app showed no main window to close within ${timeoutMs} ms` : whyNot(sent)
    throw new Error(`closeWindow: the close was not sent to pid ${this.pid}: ${why}\nmain.log:\n${this.mainLog()}`)
  }

  /** The app's own log, `main.log` (never holds a token or a cookie). */
  mainLog(): string {
    const file = join(this.launch.userData, 'logs', 'main.log')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  async waitForExit(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`the app did not exit within ${timeoutMs} ms\nmain.log:\n${this.mainLog()}${parkedAt(this.pid)}`)), timeoutMs))),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * macOS only: where a process that would not exit is parked. A stalled wait
 * must say what it was waiting on, and "did not exit" alone cannot tell a
 * quit the app dropped from a system dialog nobody can answer on a runner
 * (which parks the main thread in a modal loop). `sample` reads another
 * process of the same user without any permission; the main thread's stack is
 * the first call graph it prints.
 */
function parkedAt(pid: number): string {
  if (process.platform !== 'darwin') return ''
  const sampled = spawnSync('sample', [String(pid), '1', '-mayDie'], { encoding: 'utf8', timeout: 30_000 })
  const out = String(sampled.stdout ?? '')
  const start = out.indexOf('Call graph:')
  if (start === -1) {
    const said = `${String(sampled.stderr ?? '').trim()} | ${out.trim()}`.slice(0, 400)
    return `\nsample: no call graph (status ${String(sampled.status)}, pid ${alive(pid) ? 'alive' : 'gone'}): ${said}`
  }
  const graph = out.slice(start).split('\n')
  // The main thread is the first block; the next `Thread_` header ends it.
  const next = graph.findIndex((line, index) => index > 1 && /^\s+\d+\s+Thread_/.test(line))
  // Tree marks and addresses say nothing here; a symbol name is what is read.
  const main = (next === -1 ? graph : graph.slice(0, next)).map((line) =>
    line
      .replace(/^[\s+!:|]+/, '')
      .replace(/\s+\[0x[0-9a-f]+\]\s*$/, '')
      .slice(0, 170),
  )
  // The outer frames are the run loop every app sits in. The INNERMOST say
  // what it waits on, and the first version of this cut them off (S22.5: 45
  // lines of a stack whose leaf was the answer).
  const shown = main.length <= 64 ? main : [...main.slice(0, 10), `… ${main.length - 60} frames …`, ...main.slice(-50)]
  return `\nmain thread (sample, innermost frames last):\n${shown.join('\n')}`
}

/** How long a process lookup may take before it is a failure: a stuck query blocks this thread, where a test's own timeout cannot fire. */
const LOOKUP_MS = 60_000

/** Why a `spawnSync` did not answer: the spawn error (a missing tool, the timeout), or its status and what it said. */
function whyNot(result: { error?: Error; status: number | null; signal: NodeJS.Signals | null; stderr?: string | Buffer | null }): string {
  if (result.error !== undefined) return result.error.message
  return `status ${String(result.status)}${result.signal === null ? '' : `, signal ${result.signal}`}: ${String(result.stderr ?? '').trim().slice(0, 400) || 'nothing on stderr'}`
}

/**
 * Whether a process is alive (signal 0).
 *
 * `false` means exactly "no such process" (ESRCH). A pid that is not one — an
 * `undefined` a failed lookup handed on — is the caller's error and throws: it
 * used to make `process.kill` throw a TypeError that was read here as "dead",
 * so `waitUntil(() => !alive(pid))` passed at once on a pid nobody had found.
 * A process this user may not signal (EPERM) exists, and is alive.
 */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`alive: ${String(pid)} is not a pid (a lookup that found nothing was passed on as one)`)
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

/** A MiniDSH install registered for a Windows user: its display name and its uninstaller's command line. */
export interface RegisteredInstall {
  readonly name: string
  readonly uninstaller: string
}

/**
 * The MiniDSH registration in the text `reg query <Uninstall key> /s` prints,
 * or `undefined` when no block of it is MiniDSH's. The installer writes
 * `DisplayName` "MiniDSH <version>" (package.ts, `uninstallDisplayName`), so
 * the name is the test — the key's own name is a GUID derived from the app id.
 */
export function miniDshRegistration(regQueryOutput: string): RegisteredInstall | undefined {
  // One block per registration: the key's own line, then its indented values.
  for (const block of regQueryOutput.split(/\r?\n(?=HKEY_)/)) {
    const name = /^\s+DisplayName\s+REG_SZ\s+(MiniDSH(?:\s.*?)?)\s*$/m.exec(block)?.[1]
    if (name === undefined) continue
    return { name, uninstaller: /^\s+UninstallString\s+REG_SZ\s+(.*?)\s*$/m.exec(block)?.[1] ?? '(no uninstaller recorded)' }
  }
  return undefined
}

/**
 * The MiniDSH install THIS Windows user has, from the per-user uninstall
 * registrations, or `undefined` when there is none (and on any other
 * platform, which has no such registration). A query that could not run
 * throws: "no install" from a failed lookup is how the refusal below would
 * let the installer test through to someone's real one.
 */
export function registeredInstall(): RegisteredInstall | undefined {
  if (process.platform !== 'win32') return undefined
  const query = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], { encoding: 'utf8', timeout: LOOKUP_MS, maxBuffer: 64 * 1024 * 1024 })
  if (query.error !== undefined) throw new Error(`registeredInstall: the registry query could not run: ${query.error.message}`)
  // Status 1 with nothing printed is reg's "no such key": a user with no per-user install of anything.
  if (query.status !== 0 && !(query.status === 1 && query.stdout.trim() === '')) throw new Error(`registeredInstall: the registry query could not answer (${whyNot(query)})`)
  return miniDshRegistration(query.stdout)
}

/**
 * Why the installer test may not run on this machine, or `undefined` when it
 * may. The scratch `userData` and `MINIDSH_HOME` make every LAUNCH hermetic
 * (the header above), and the installer is not a launch: it is a real
 * per-user install under the product's one app id. It first runs the
 * uninstaller of whatever is registered, then registers its own temporary
 * folder, and the test's uninstall removes that registration and the
 * shortcuts — on a machine whose user has MiniDSH installed, the test would
 * take that install away. So it refuses there, and says why.
 */
export function installedBesideUs(): string | undefined {
  const existing = registeredInstall()
  if (existing === undefined) return undefined
  return (
    `this Windows user already has "${existing.name}" installed (its uninstaller: ${existing.uninstaller}). ` +
    'The installer test is a real per-user install under the same app id: it would run that uninstaller, register a temporary folder in its place, and then remove the registration and the shortcuts. ' +
    'Refusing rather than touch it. Run this test where MiniDSH is not installed (CI, another account) or uninstall it first; if the path above is a temporary folder, an earlier run of this test was interrupted and left it.'
  )
}

/**
 * Windows only: answer a native message box the app's process owns by
 * pressing the button named `button`, through UI Automation (Windows
 * PowerShell 5.1 carries the assembly; pwsh 7 does not). Returns the box's
 * text, so a test can assert what the person was told.
 */
export function answerNativeDialog(pid: number, button: string, timeoutMs = 15_000): { clicked: boolean; text: string } {
  // Electron's message box is a Windows task dialog inside the app's window,
  // and its buttons surface as PANES (measured), not Buttons, often without
  // an Invoke pattern: so the button is found by name and the dialog's text,
  // and pressed by Invoke where offered, else by a real click at its centre.
  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace MiniDsh -Name Mouse -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);'
$A = [Windows.Automation.AutomationElement]
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
  $mine = New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})
  foreach ($window in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $mine)) {
    $isText = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Text)
    $texts = @($window.FindAll([Windows.Automation.TreeScope]::Descendants, $isText) | ForEach-Object { $_.Current.Name })
    if ($texts.Count -eq 0) { continue }
    $named = New-Object Windows.Automation.PropertyCondition($A::NameProperty, ${JSON.stringify(button)})
    foreach ($target in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $named)) {
      $type = $target.Current.ControlType
      if ($type -ne [Windows.Automation.ControlType]::Button -and $type -ne [Windows.Automation.ControlType]::Pane) { continue }
      $invoke = $null
      if ($target.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke() }
      else {
        $box = $target.Current.BoundingRectangle
        [MiniDsh.Mouse]::SetCursorPos([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2)) | Out-Null
        [MiniDsh.Mouse]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
        [MiniDsh.Mouse]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
      }
      [Console]::Out.Write('CLICKED ' + ($texts -join ' | '))
      exit 0
    }
  }
  Start-Sleep -Milliseconds 200
}
[Console]::Out.Write('NOT FOUND')
exit 1
`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: timeoutMs + 10_000 })
  const out = String(result.stdout ?? '')
  return { clicked: out.startsWith('CLICKED'), text: out.replace(/^CLICKED /, '') }
}
