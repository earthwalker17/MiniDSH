/**
 * The desktop E2E's process helpers, held to one rule without needing the
 * app: a lookup that FAILED is an error, never an answer. Each of them used to
 * turn its own failure into the value its callers read as success — a pid
 * nobody found was "dead", a query that could not run was "no runtime", a
 * close that reached no window was a close.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterAll, describe, expect, it } from 'vitest'
import { alive, DesktopApp, installedBesideUs, miniDshRegistration, registeredInstall } from './desktop-app.ts'

const started: ChildProcess[] = []
afterAll(() => {
  for (const child of started) child.kill('SIGKILL')
})

const IDLE = 'setInterval(() => {}, 1000)'

/** A process that stays up, optionally with a `minidsh.js web`-shaped child whose pid it prints. */
async function running(withRuntime: boolean): Promise<{ parent: ChildProcess; runtime?: number }> {
  const script = withRuntime
    ? `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}, '--', 'minidsh.js', 'web'], { stdio: 'ignore' }); child.once('spawn', () => console.log(child.pid)); ${IDLE}`
    : IDLE
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  started.push(parent)
  await once(parent, 'spawn')
  if (!withRuntime) return { parent }
  const [line] = (await once(parent.stdout!, 'data')) as [Buffer]
  const runtime = Number(String(line).trim())
  // The grandchild is this file's to end: killing its parent does not.
  started.push({ kill: () => process.kill(runtime, 'SIGKILL') } as unknown as ChildProcess)
  return { parent, runtime }
}

/** The helpers of a DesktopApp over a process this test started; no app is launched. */
function appOver(child: ChildProcess): DesktopApp {
  const app = Object.create(DesktopApp.prototype) as DesktopApp
  Object.assign(app, { child, launch: { exe: '', userData: 'no-such-user-data', home: '' } })
  return app
}

/** Runs `body` with no PATH, which is what a host without the query tool looks like. */
function withoutPath<T>(body: () => T): T {
  const saved = process.env.PATH
  process.env.PATH = ''
  try {
    return body()
  } finally {
    process.env.PATH = saved
  }
}

describe('alive', () => {
  it('is true for a running process and false once it has exited', async () => {
    const { parent } = await running(false)
    expect(alive(parent.pid!)).toBe(true)
    parent.kill('SIGKILL')
    await once(parent, 'exit')
    const deadline = Date.now() + 10_000
    while (alive(parent.pid!) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(alive(parent.pid!)).toBe(false)
  })

  it('throws on a pid that is not one, instead of calling a lookup that found nothing dead', () => {
    for (const notAPid of [undefined, Number.NaN, 0, -1, 1.5]) {
      expect(() => alive(notAPid as number), String(notAPid)).toThrowError(/is not a pid/)
    }
  })
})

describe('DesktopApp.runtimePid', () => {
  it('finds the runtime child by parentage, and answers undefined for an app that has none', { timeout: 120_000 }, async () => {
    const withOne = await running(true)
    expect(appOver(withOne.parent).runtimePid(), 'the control: a child that IS there is found').toBe(withOne.runtime)
    const withNone = await running(false)
    expect(appOver(withNone.parent).runtimePid()).toBeUndefined()
  })

  it('throws when its query cannot run, rather than answering that there is no runtime', async () => {
    const { parent } = await running(true)
    expect(() => withoutPath(() => appOver(parent).runtimePid())).toThrowError(/runtimePid: .* could not answer \(.*ENOENT/)
  })
})

describe('the installer test refuses to run beside a real install', () => {
  /** What `reg query …\Uninstall /s` prints: a block per registration. */
  const block = (key: string, values: Record<string, string>): string =>
    [`HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`, ...Object.entries(values).map(([name, value]) => `    ${name}    REG_SZ    ${value}`), ''].join('\r\n')
  const python = block('{0ef3959c-4dd0-4cd2-9d49-307eaf0a2bff}', { DisplayName: 'Python 3.14.2 (64-bit)', Publisher: 'Python Software Foundation' })
  const ours = block('6f1c2a9e-0000-5000-8000-0123456789ab', { DisplayName: 'MiniDSH 2.0.0', UninstallString: '"C:\\Users\\Jo\\AppData\\Local\\Programs\\MiniDSH\\Uninstall MiniDSH.exe" /currentuser', DisplayVersion: '2.0.0' })

  it('finds the MiniDSH registration among a user’s others, with the uninstaller it would have run', () => {
    expect(miniDshRegistration(`\r\n${python}\r\n${ours}`)).toEqual({ name: 'MiniDSH 2.0.0', uninstaller: '"C:\\Users\\Jo\\AppData\\Local\\Programs\\MiniDSH\\Uninstall MiniDSH.exe" /currentuser' })
  })

  it('finds none where there is none, and does not take another product whose name only begins the same way', () => {
    expect(miniDshRegistration('')).toBeUndefined()
    expect(miniDshRegistration(python)).toBeUndefined()
    expect(miniDshRegistration(block('other', { DisplayName: 'MiniDSHelper 1.0' }))).toBeUndefined()
    // A value of another name that merely mentions it is not a registration either.
    expect(miniDshRegistration(block('other', { Comments: 'DisplayName    REG_SZ    MiniDSH 2.0.0', DisplayName: 'Something Else' }))).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('reads this user’s own registrations without failing, and its refusal says what it would have touched', () => {
    const found = registeredInstall()
    const refusal = installedBesideUs()
    // Whichever this machine is, the two agree: a refusal exactly when an install is registered, naming it.
    if (found === undefined) expect(refusal).toBeUndefined()
    else expect(refusal).toContain(`"${found.name}"`)
  })

  it('throws when the registry cannot be asked, rather than answering that nothing is installed', () => {
    if (process.platform !== 'win32') return void expect(registeredInstall(), 'no such registration off Windows').toBeUndefined()
    expect(() => withoutPath(() => registeredInstall())).toThrowError(/registeredInstall: the registry query could not run: .*ENOENT/)
  })
})

describe('DesktopApp.closeWindow', () => {
  it('throws when the close reached nothing: no window on Windows, no process elsewhere', { timeout: 120_000 }, async () => {
    const { parent } = await running(false)
    if (process.platform === 'win32') {
      // A console child has no main window: the close has nowhere to go, and says so at its bound.
      expect(() => appOver(parent).closeWindow(1_500)).toThrowError(/closeWindow: the close was not sent to pid \d+: the app showed no main window to close within 1500 ms/)
      expect(alive(parent.pid!), 'and nothing was closed').toBe(true)
    } else {
      parent.kill('SIGKILL')
      await once(parent, 'exit')
      expect(() => appOver(parent).closeWindow()).toThrowError(/closeWindow: SIGTERM could not be sent to the app/)
    }
  })
})
