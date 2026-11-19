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

  /** The runtime child (the bundled node running `minidsh web --json`), by parentage. */
  runtimePid(): number | undefined {
    if (process.platform === 'win32') {
      const found = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${this.pid} AND Name='node.exe'" | Select-Object -First 1).ProcessId`], { encoding: 'utf8' })
      const pid = Number(found.stdout.trim())
      return Number.isInteger(pid) && pid > 0 ? pid : undefined
    }
    const found = spawnSync('pgrep', ['-P', String(this.pid), '-f', 'minidsh.js web'], { encoding: 'utf8' })
    const pid = Number(found.stdout.trim().split('\n')[0])
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  }

  /** Close the window as a person does (WM_CLOSE on Windows; SIGTERM elsewhere, which Electron turns into a quit). */
  closeWindow(): void {
    if (process.platform === 'win32') {
      spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$null = (Get-Process -Id ${this.pid}).CloseMainWindow()`])
    } else {
      this.child.kill('SIGTERM')
    }
  }

  /** The app's own log, `main.log` (never holds a token or a cookie). */
  mainLog(): string {
    const file = join(this.launch.userData, 'logs', 'main.log')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  async waitForExit(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([this.exited, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`the app did not exit within ${timeoutMs} ms\nmain.log:\n${this.mainLog()}`)), timeoutMs)))])
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Whether a process is alive (signal 0). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
