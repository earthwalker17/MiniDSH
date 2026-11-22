/**
 * The installer's running-app check (`desktop/installer.nsh`), run the way
 * NSIS runs it: the two command lines are read out of the hook, NSIS's own
 * escapes are undone, and each is handed to Windows as it stands. Windows
 * only: the hook is Windows's, and so are the programs it calls.
 *
 * The check replaces electron-builder's, so it is the only one there is, and
 * it was wrong in both directions when it could not be made: any failure of
 * PowerShell read as "not running" (the installer went on over a live app),
 * and under Constrained Language Mode the script answered "running" with
 * nothing running (the installer and the uninstaller refused for ever). What
 * is pinned here is what each command ANSWERS in each state; the branch
 * between the answers is NSIS's, which the packaged E2E installs for real.
 *
 * "Running" is a real process: a copy of a small system program started from
 * a scratch folder, which reads a stdin that the test holds open.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK = readFileSync(join(import.meta.dirname, '..', 'installer.nsh'), 'utf8')
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
/** What puts Windows PowerShell into Constrained Language Mode for the rest of a command: the mode a locked-down PC starts it in. */
const CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; "

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const undo of cleanup.splice(0).toReversed()) await undo()
})

/** The command lines the hook runs, in order, as Windows receives them for an app whose executable is `image`. */
function commands(image: string): string[] {
  // `/TIMEOUT=<ms>` is nsExec's own switch, read by NSIS and never part of the command line.
  const lines = [...HOOK.matchAll(/^\s*nsExec::ExecToStack\s+(?:\/TIMEOUT=\d+\s+)?(["'`])(.*)\1\s*$/gm)].map((match) => match[2]!)
  return lines.map((line) => line.replaceAll('$SYSDIR', SYSTEM32).replaceAll('${APP_EXECUTABLE_FILENAME}', image).replaceAll('$$', '$'))
}

/** Runs one of them verbatim, as `nsExec` does, with the two variables the hook sets; the exit code is the answer. */
function answer(commandLine: string, env: { readonly dir: string; readonly self?: number }): number | null {
  const parts = /^"([^"]+)"\s+(.*)$/s.exec(commandLine)
  if (parts === null) throw new Error(`not a quoted program and its arguments: ${commandLine}`)
  const result = spawnSync(parts[1]!, [parts[2]!], { windowsVerbatimArguments: true, env: { ...process.env, MINIDSH_INSTDIR: env.dir, MINIDSH_INSTALLER_PID: String(env.self ?? 0) }, encoding: 'utf8', timeout: 120_000 })
  if (result.error !== undefined) throw result.error
  return result.status
}

const scratch = (): string => {
  // The long spelling: a runner's temp folder is often an 8.3 name, and a process's own path is not.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'minidsh-installer-')))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  return dir
}

/** A process running from `dir` under the image name `image`, until its stdin ends. */
async function running(dir: string, image: string): Promise<ChildProcess> {
  copyFileSync(join(SYSTEM32, 'findstr.exe'), join(dir, image))
  const child = spawn(join(dir, image), ['never-matches'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  cleanup.push(async () => {
    child.stdin?.end()
    await gone
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return child
}

describe.runIf(process.platform === 'win32')("the installer's running-app check", { timeout: 300_000 }, () => {
  it('runs exactly two commands: the exact check in PowerShell, then the plain image check', () => {
    const [exact, plain, ...more] = commands('MiniDSH.exe')
    expect(more).toEqual([])
    expect(exact).toMatch(/^"[^"]+\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoProfile -NonInteractive -Command "/)
    expect(plain).toMatch(/^"[^"]+\\cmd\.exe" \/C tasklist .*"IMAGENAME eq MiniDSH\.exe".*findstr\.exe" \/B \/I \/C:"\\"MiniDSH\.exe\\""$/)
    // Nothing of NSIS's is left for Windows to misread.
    for (const line of [exact, plain]) expect(line).not.toMatch(/\$\{|\$SYSDIR|\$INSTDIR/)
    // The codes the script answers with are the ones the hook branches on, and 0 is not among them.
    expect([...exact!.matchAll(/exit (\d+)/g)].map((match) => Number(match[1])).toSorted((a, b) => a - b)).toEqual([3, 4, 4, 10])
    expect(HOOK).toMatch(/\$\{if\} \$0 != 3\r?\n\s*\$\{andIf\} \$0 != 10\r?\n\s*nsExec::ExecToStack/)
    // The exact check is bounded: a WMI that hangs answers "timeout", which is
    // neither 3 nor 10, so the plain check decides instead of nobody.
    expect(HOOK).toMatch(/^\s*nsExec::ExecToStack \/TIMEOUT=30000 `"\$SYSDIR\\WindowsPowerShell/m)
    expect(HOOK.match(/\/TIMEOUT=/g)).toHaveLength(1)
  })

  it('the exact check answers 10 with nothing running there, 3 with a process from that folder, and leaves the installer itself out', async () => {
    const [exact] = commands('MiniDSH.exe')
    const dir = scratch()
    expect(answer(exact!, { dir })).toBe(10)
    const child = await running(dir, 'app.exe')
    expect(answer(exact!, { dir })).toBe(3)
    // An uninstaller run in place lives in that folder: it is not what "running" means.
    expect(answer(exact!, { dir, self: child.pid! })).toBe(10)
    // A folder whose name only begins the same is another folder.
    expect(answer(exact!, { dir: dir.slice(0, -1) })).toBe(10)
  })

  it('under Constrained Language Mode it answers 4, "could not check", whether or not anything runs: never 3, never 10', async () => {
    const [exact] = commands('MiniDSH.exe')
    const constrained = exact!.replace('-Command "', `-Command "${CONSTRAINED}`)
    expect(constrained).not.toBe(exact)
    const dir = scratch()
    expect(answer(constrained, { dir })).toBe(4)
    await running(dir, 'app.exe')
    expect(answer(constrained, { dir })).toBe(4)
  })

  it('the plain check finds a process by its exact image name, wherever it runs from, and nothing else', async () => {
    const image = `minidsh-probe-${process.pid}.exe`
    const [, plain] = commands(image)
    const [, other] = commands(`probe-${process.pid}.exe`)
    expect(answer(plain!, { dir: scratch() })).toBe(1)
    const child = await running(scratch(), image)
    expect(answer(plain!, { dir: scratch() })).toBe(0)
    expect(answer(other!, { dir: scratch() })).toBe(1)
    child.stdin?.end()
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    expect(answer(plain!, { dir: scratch() })).toBe(1)
  })
})
