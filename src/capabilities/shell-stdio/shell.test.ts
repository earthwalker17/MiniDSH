import { ChildProcess, spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SandboxExecutionPolicy } from '../../core/sandbox/index.ts'
import type { ShellJobExit, ShellRunResult } from '../../core/shell/index.ts'
import { childEnvironment, type Spawner } from '../../core/process.ts'
import { ShellProcess, type ShellDialect } from './process.ts'
import { NO_CONFINEMENT, type Confinement } from './confine/index.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const binary = dialect === 'pwsh' ? 'pwsh' : 'bash'
const available = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0
// The stdin redirect is a bash-dialect fix, so it is tested wherever bash exists
// — not only where bash is the platform default.
const bashAvailable = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0

/**
 * Every case below spawns a REAL shell, and a `pwsh` start alone costs 1.2-2 s
 * on an idle Windows machine: the slowest here measured 7.8 s, which a loaded
 * CI runner turns into a timeout rather than into a defect. Same reasoning and
 * same number as `spill-local/spill.test.ts`, which had to declare it first.
 */
const SHELL_TEST_TIMEOUT_MS = 120_000

/**
 * The same rule confinement gets, for the same reason. Every shell case here
 * self-skips without its dialect's binary, so a host that HAS no `pwsh` would
 * report a green suite having run none of them — and on Windows a missing
 * `pwsh` is not a skipped feature, it is `SHELL_UNAVAILABLE` on every command
 * the model runs. A leg that exists to prove the shell works may not pass
 * having proved nothing, so CI says so and this turns the skip into a failure.
 */
describe.runIf(process.env.MINIDSH_EXPECT_SHELL === '1')('a host that is REQUIRED to have a shell', () => {
  it('has its dialect installed', () => {
    expect(available, `MINIDSH_EXPECT_SHELL=1 but \`${binary} --version\` does not run on ${process.platform}`).toBe(true)
  })
})

let proc: ShellProcess | undefined
let dir: string | undefined
afterEach(async () => {
  await proc?.dispose()
  proc = undefined
  if (dir) await removeWithRetry(dir)
  dir = undefined
})

/**
 * MSYS bash releases its cwd handle ~100ms AFTER its kill has been reaped, and
 * `rmSync`'s own `maxRetries` retries without ever sleeping (measured: it
 * exhausts 10x50ms inside ~10ms) — so the teardown needs a retry loop with
 * real awaits between attempts.
 */
async function removeWithRetry(target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 40) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/** Waits for the world to change, and says what it was waiting for when it does not. */
async function until(what: string, condition: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Brings a dialect's own HOST up before a deadline is put on a command.
 *
 * On a Windows PATH without Git's `usr\bin`, `bash` is the WSL launcher
 * (`WindowsApps\bash.exe`), and its first use after WSL has idled out boots
 * the distribution before bash prints a byte: 11.8 s measured on this
 * project's quiet host (2026-11-21, against 0.8-1.3 s once it is up), and past
 * a 60 s command deadline on a loaded one. That boot was charged to the first
 * bash command after a long run of pwsh cases, which is how "bash: `exit` is
 * the command's" timed out. A command's deadline is about the shell; the
 * machine under it is brought up here, and what each case then gives its
 * ShellProcess is still that shell's FIRST command.
 */
async function hostUp(shellBinary: string): Promise<void> {
  const started = Date.now()
  const args = shellBinary === 'pwsh' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'] : ['--noprofile', '--norc', '-c', 'true']
  const bound = SHELL_TEST_TIMEOUT_MS - 30_000
  await new Promise<void>((resolve, reject) => {
    const child = spawn(shellBinary, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`\`${shellBinary}\` did not run a no-op within ${bound} ms: the host under it never came up (on Windows, \`bash\` may be the WSL launcher booting its distribution)`))
    }, bound)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`\`${shellBinary}\` exited ${code} from a no-op after ${Date.now() - started} ms`))
    })
  })
}

/** This provider confines nothing, so the tests run under the one unconfined mode. */
const unconfined = (root: string): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: root })

const echoCmd = (text: string): string => (dialect === 'pwsh' ? `Write-Output '${text}'` : `echo '${text}'`)
const pwdCmd = (): string => (dialect === 'pwsh' ? '(Get-Location).Path' : 'pwd')
const setVar = (name: string, value: string): string => (dialect === 'pwsh' ? `$env:${name}='${value}'` : `export ${name}='${value}'`)
const readVar = (name: string): string => (dialect === 'pwsh' ? `Write-Output $env:${name}` : `echo $${name}`)
// A native non-zero exit (as `node --test` produces) propagates reliably via $LASTEXITCODE / $?.
const failCmd = (): string => 'node -e "process.exit(3)"'

describe.skipIf(!available)(`persistent ${dialect} shell`, () => {
  it('runs a command and captures its output and exit code', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    const result = await proc.exec({ command: echoCmd('hello world'), policy: unconfined(dir), timeoutMs: 30_000 })
    expect(result.output).toContain('hello world')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  }, SHELL_TEST_TIMEOUT_MS)

  it('persists working directory across calls', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    mkdirSync(join(dir, 'sub'))
    proc = new ShellProcess(dialect, dir)
    await proc.exec({ command: dialect === 'pwsh' ? 'Set-Location sub' : 'cd sub', policy: unconfined(dir), timeoutMs: 30_000 })
    const result = await proc.exec({ command: pwdCmd(), policy: unconfined(dir), timeoutMs: 30_000 })
    expect(result.output.toLowerCase()).toContain('sub')
  }, SHELL_TEST_TIMEOUT_MS)

  it.skipIf(!bashAvailable)('a command that reads stdin gets EOF instead of the next command', async () => {
    await hostUp('bash')
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess('bash', dir)
    // Without the redirect this `cat` would block until the deadline AND eat the
    // next command out of the shared pipe, so the second call would never match.
    const reader = await proc.exec({ command: 'cat', policy: unconfined(dir), timeoutMs: 30_000 })
    expect(reader.timedOut).toBe(false)
    const after = await proc.exec({ command: "echo 'still here'", policy: unconfined(dir), timeoutMs: 30_000 })
    expect(after.output).toContain('still here')
    expect(after.exitCode).toBe(0)
  }, SHELL_TEST_TIMEOUT_MS)

  it('reports a non-zero exit code for a failing command', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    const result = await proc.exec({ command: failCmd(), policy: unconfined(dir), timeoutMs: 30_000 })
    // The command's OWN code. "Not zero" was satisfied by no exit code at all,
    // which is what a reset or a timeout reports.
    expect(result.exitCode).toBe(3)
    expect(result).toMatchObject({ reset: false, timedOut: false })
  }, SHELL_TEST_TIMEOUT_MS)

  /**
   * PowerShell has no single exit code, and the half of the wrapper that is
   * not `$LASTEXITCODE` ran nowhere in this suite: a command that ended in an
   * error the wrapper's own catch printed was reported as a SUCCESS, because
   * the code was read from a `$?` that is always true there (S22.5 audit;
   * `throw`, `1/0` and a parse error all answered 0, measured).
   */
  it.runIf(dialect === 'pwsh')('pwsh: a command that ends in a terminating error fails with code 1, and the shell lives on', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    for (const [command, said] of [
      ["Write-Output before; throw 'boom'; Write-Output unreachable", 'boom'],
      ['if (', 'if'],
      ['Get-Item C:\\minidsh-no-such-path -ErrorAction Stop', 'minidsh-no-such-path'],
    ] as const) {
      const result = await proc.exec({ command, policy: unconfined(dir), timeoutMs: 60_000 })
      expect(result, `${command}: ${result.output}`).toMatchObject({ exitCode: 1, reset: false, timedOut: false })
      expect(result.output).toContain(said)
      expect(result.output).not.toContain('unreachable')
    }
    // A native program's own code still wins over the catch's 1.
    const native = await proc.exec({ command: 'node -e "process.exit(3)"; throw \'after\'', policy: unconfined(dir), timeoutMs: 60_000 })
    expect(native.exitCode).toBe(3)
    const after = await proc.exec({ command: echoCmd('still here'), policy: unconfined(dir), timeoutMs: 60_000 })
    expect(after).toMatchObject({ exitCode: 0, reset: false })
    expect(after.output).toContain('still here')
  }, SHELL_TEST_TIMEOUT_MS)

  // What the wrapper still cannot tell (`wrapper`, process.ts): `$?` after
  // Invoke-Expression is Invoke-Expression's own. Stated, so that it changes
  // only on purpose: the error is in the output, never in the code.
  it.runIf(dialect === 'pwsh')('pwsh: a cmdlet\'s non-terminating error shows in the output and not in the exit code', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    const result = await proc.exec({ command: 'Get-Item C:\\minidsh-no-such-path', policy: unconfined(dir), timeoutMs: 60_000 })
    expect(result.output).toContain('minidsh-no-such-path')
    expect(result).toMatchObject({ exitCode: 0, reset: false })
  }, SHELL_TEST_TIMEOUT_MS)
})

/**
 * Sets variables on the REAL `process.env` and restores each one afterwards,
 * never replacing the object: on win32 `process.env` is the case-insensitive
 * one, and a plain copy assigned back would silently stop being that.
 */
async function withEnv<T>(vars: Record<string, string>, body: () => Promise<T> | T): Promise<T> {
  const previous = new Map(Object.keys(vars).map((name) => [name, process.env[name]] as const))
  for (const [name, value] of Object.entries(vars)) process.env[name] = value
  try {
    return await body()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

describe('the environment a child is given', () => {
  it('withholds what this deployment declared a secret and its own identity, and nothing for merely looking like one', async () => {
    await withEnv(
      {
        CORP_LLM_CRED: 'renamed-by-config',
        SOME_API_KEY: 'looks-like-one',
        GOOGLE_APPLICATION_CREDENTIALS: '/home/me/gcp.json',
        MINIDSH_HOME: '/somewhere',
        ORDINARY_SETTING: 'kept',
      },
      () => {
        // `CORP_LLM_CRED` is the case assembly cannot know: a row renamed its
        // own `apiKeyEnv`, and only the credential seam it declared to can say so.
        const env = childEnvironment(['CORP_LLM_CRED'], undefined)
        expect(env.CORP_LLM_CRED).toBeUndefined()
        expect(env.MINIDSH_HOME).toBeUndefined()
        // Undeclared, so not the harness's: a name is not a reason to withhold,
        // and the path-valued one is exactly what a name pattern got wrong.
        expect(env.SOME_API_KEY).toBe('looks-like-one')
        expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/home/me/gcp.json')
        // And an ordinary child still works: PATH and the rest are untouched.
        expect(env.ORDINARY_SETTING).toBe('kept')
        expect(env.PATH ?? env.Path).toBeDefined()
      },
    )
  })

  it.runIf(process.platform === 'win32')('compares names case-insensitively on Windows, where the environment does', async () => {
    // `credentials-local` resolves `process.env['DEEPSEEK_API_KEY']`, which on
    // win32 finds THIS spelling — so a scrub comparing exact spellings handed
    // the very value the harness consumes to every child.
    await withEnv({ Deepseek_Api_Key: 'mixed-case' }, () => {
      expect(process.env.DEEPSEEK_API_KEY).toBe('mixed-case')
      const env = childEnvironment(['DEEPSEEK_API_KEY'], undefined)
      expect(Object.keys(env).filter((name) => name.toUpperCase() === 'DEEPSEEK_API_KEY')).toEqual([])
    })
  })

  /**
   * The helper being right is not the claim; the claim is that a REAL child
   * gets its result. Three independent one-line reverts — restoring the old
   * wholesale `process.env` spread, dropping `withheld` where the provider
   * builds the process, or dropping a row's `declare` — each put this
   * deployment's API key back into every command the model runs, and every one
   * of them left the pure-function tests above passing.
   */
  it.skipIf(!available)('gives a REAL child the scrubbed environment, and asks what is declared at every spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    dir = root
    await withEnv({ CORP_LLM_CRED: 'renamed-by-config', SOME_API_KEY: 'looks-like-one', LATER_CRED: 'declared-later', ORDINARY_SETTING: 'kept' }, async () => {
      const declared = ['CORP_LLM_CRED']
      proc = new ShellProcess(dialect, root, { withheld: () => declared })
      const read = async (name: string): Promise<string> =>
        (await proc!.exec({ command: readVar(name), policy: unconfined(root), timeoutMs: 30_000 })).output
      expect(await read('CORP_LLM_CRED')).not.toContain('renamed-by-config')
      expect(await read('SOME_API_KEY')).toContain('looks-like-one')
      expect(await read('ORDINARY_SETTING')).toContain('kept')
      expect(await read('LATER_CRED')).toContain('declared-later')
      // A row that mounts after this shell exists (an agent preset's own
      // adapter) declares into the same seam, and the NEXT spawn withholds it.
      declared.push('LATER_CRED')
      await proc.restart()
      expect(await read('LATER_CRED')).not.toContain('declared-later')
      expect(await read('ORDINARY_SETTING')).toContain('kept')
    })
  }, SHELL_TEST_TIMEOUT_MS)

  /**
   * The ONE-SHOT spawn builds its own environment, and nothing read it back:
   * the persistent child and a job each had a real-child case, an approved
   * one-shot had none. On Windows, where nothing confines, every command of a
   * session that has not accepted an unconfined shell IS a one-shot, so a
   * one-line revert there handed the deployment's provider key to every
   * command the model ran with the suite green (S22.5 audit).
   */
  it.skipIf(!available)('gives an approved ONE-SHOT the scrubbed environment too, asked at its own spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    dir = root
    await withEnv({ CORP_LLM_CRED: 'renamed-by-config', LATER_CRED: 'declared-later', MINIDSH_HOME: '/somewhere', ORDINARY_SETTING: 'kept' }, async () => {
      const declared = ['CORP_LLM_CRED']
      proc = new ShellProcess(dialect, root, { withheld: () => declared })
      const read = async (name: string): Promise<string> => {
        const result = await proc!.exec({ command: readVar(name), policy: unconfined(root), oneShot: true, timeoutMs: 60_000 })
        expect(result.exitCode, `reading ${name}: ${result.output}`).toBe(0)
        return result.output
      }
      // The positive control first: this child does read its environment.
      expect(await read('ORDINARY_SETTING')).toContain('kept')
      expect(await read('LATER_CRED')).toContain('declared-later')
      expect(await read('CORP_LLM_CRED')).not.toContain('renamed-by-config')
      expect(await read('MINIDSH_HOME')).not.toContain('/somewhere')
      // Each one-shot is its own spawn, so a name declared since is withheld from the very next one.
      declared.push('LATER_CRED')
      expect(await read('LATER_CRED')).not.toContain('declared-later')
    })
  }, SHELL_TEST_TIMEOUT_MS)

  it('merges the caller overlay AFTER the scrub, so a forwarded value survives', () => {
    // Nothing forwards one today; the ordering is what makes it possible
    // later without reopening the scrub, and it is upstream's ordering too.
    const env = childEnvironment(['SOME_KEY'], { TMPDIR: '/tmp', SOME_KEY: 'on purpose' })
    expect(env.TMPDIR).toBe('/tmp')
    expect(env.SOME_KEY).toBe('on purpose')
  })
})

describe.skipIf(!available)('what enforcement a session accepts, where nothing confines', () => {
  it('refuses a confined mode by default, and runs it in the PERSISTENT shell once the session accepts unconfined', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    const confined: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: dir }

    // The default is the refusal this provider has always made: a host with no
    // backend does not run a confined command.
    await expect(proc.exec({ command: echoCmd('nope'), policy: confined, timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })

    // With the session accepting it, the command runs — and REPORTS what it
    // really got, which is what lands in the effect record and the audit.
    const first = await proc.exec({ command: setVar('S15', 'kept'), policy: confined, accepts: 'none', timeoutMs: 30_000 })
    expect(first.aborted).toBeUndefined()
    expect(first.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'none' })

    // The PERSISTENT child, not a throwaway: an escalation goes to a one-shot
    // child unconditionally, so the only thing that can carry state between two
    // commands is the session's own shell. Reading back what the first command
    // set is the one assertion a throwaway cannot pass.
    const second = await proc.exec({ command: readVar('S15'), policy: confined, accepts: 'none', timeoutMs: 30_000 })
    expect(second.output).toContain('kept')
    expect(second.restarted).toBeUndefined()
  })
})

/**
 * A host whose backend enforces only PARTIALLY. No shipped backend reports it,
 * which is exactly why it needs a test: S15 changed what such a host does —
 * before, `confine()` refused only `none`, so a `partial` command ran and was
 * stamped `partial`; now the session's acceptance decides, and the default
 * `full` refuses it. That is the stronger posture (upstream's own docs say a
 * consumer needing the absolute promise "must reject or surface that
 * distinction", and no shipped consumer of theirs rejects), but it is a
 * deliberate behaviour change, and an untested one would have drifted back.
 */
describe.skipIf(!available)('a host that enforces only partially', () => {
  const PARTIAL: Confinement = { ...NO_CONFINEMENT, id: 'bwrap', enforcement: 'partial' }

  it('refuses a session that requires full enforcement, and runs for one that accepts partial', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-partial-'))
    dir = root
    proc = new ShellProcess(dialect, root, { confinement: PARTIAL })
    const confined: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: root }

    await expect(proc.exec({ command: echoCmd('nope'), policy: confined, timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })

    const ran = await proc.exec({ command: echoCmd('partial ok'), policy: confined, accepts: 'partial', timeoutMs: 30_000 })
    expect(ran.output).toContain('partial ok')
    // And it reports what it really got, not what was asked for.
    expect(ran.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'partial' })
  }, SHELL_TEST_TIMEOUT_MS)
})

/**
 * The two things a one-shot grant promises, on the host where they are
 * EASIEST to get wrong: one that confines nothing.
 *
 * Both of these were live defects. The throwaway child was taken only when the
 * granted policy's world differed from the live child's — and on a host with
 * no backend every world is the same one, so the escalated command ran in the
 * session's own shell and its `cd` persisted, while the tool told the model
 * the opposite. And the throwaway was stored nowhere, so disposing the agent
 * reaped the persistent child and left the escalated one — the command running
 * under the widest authority the session ever granted — alive behind it.
 */
describe.skipIf(!available)('a one-shot grant, where nothing confines', () => {
  it('runs beside the persistent shell and leaves its state alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-oneshot-'))
    mkdirSync(join(dir, 'sub'))
    proc = new ShellProcess(dialect, dir)
    const policy = unconfined(dir)
    const cd = dialect === 'pwsh' ? 'Set-Location sub' : 'cd sub'
    await proc.exec({ command: cd, policy, timeoutMs: 30_000 })

    const granted = await proc.exec({ command: dialect === 'pwsh' ? 'Set-Location ..' : 'cd ..', policy, oneShot: true, timeoutMs: 30_000 })
    expect(granted.exitCode).toBe(0)

    // The grant covered one call, so it moved nothing here.
    const after = await proc.exec({ command: pwdCmd(), policy, timeoutMs: 30_000 })
    expect(after.output.toLowerCase()).toContain('sub')
  }, SHELL_TEST_TIMEOUT_MS)

  // A pwsh one-shot is `pwsh -Command <text>`, and PowerShell ends such a
  // process by `$?`: 0 or 1. A native program that failed with 5 was reported
  // as 1, while the persistent child beside it said 5 (measured, S22.5). On
  // Windows every approved command is a one-shot, so that 1 was what the model
  // usually read. The native program here is the dialect's own shell.
  it('reports a failing native program by its own exit code in a one-shot too', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir)
    const policy = unconfined(dir)
    const native = (code: number): string => (dialect === 'pwsh' ? `pwsh -NoLogo -NoProfile -NonInteractive -Command "exit ${code}"` : `sh -c 'exit ${code}'`)
    const say = dialect === 'pwsh' ? 'Write-Output after' : 'echo after'
    const cases: [name: string, command: string, oneShot: boolean][] = [
      ['one-shot: native 5', native(5), true],
      ['one-shot: native 0', native(0), true],
      ['one-shot: a failure, then a success', `${native(3)}; ${say}`, true],
      ['one-shot: its own exit', 'exit 7', true],
      // The persistent child is the control: the two must agree.
      ['persistent: native 5', native(5), false],
    ]
    const codes: Record<string, number | undefined> = {}
    for (const [name, command, oneShot] of cases) codes[name] = (await proc.exec({ command, policy, ...(oneShot ? { oneShot } : {}), timeoutMs: 60_000 })).exitCode
    expect(codes).toEqual({ 'one-shot: native 5': 5, 'one-shot: native 0': 0, 'one-shot: a failure, then a success': 0, 'one-shot: its own exit': 7, 'persistent: native 5': 5 })
    // A cmdlet's own failure as the last statement has no native code: still 1.
    if (dialect === 'pwsh') expect((await proc.exec({ command: 'Get-Item ./no-such-entry', policy, oneShot: true, timeoutMs: 60_000 })).exitCode).toBe(1)
  }, SHELL_TEST_TIMEOUT_MS)

  it('is reaped by dispose, so nothing outlives the scope that ran it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-oneshot-'))
    dir = root
    const marker = join(root, 'late.txt')
    const pidFile = join(root, 'shell.pid')
    const shell = new ShellProcess(dialect, root)
    proc = shell
    // The command says it is RUNNING (its own pid, in a file) before it waits,
    // so the scope ends under a command, never under a shell still starting:
    // a fixed pause here disposed a pwsh that had not begun (1.2-2 s start).
    // The wait is far longer than the test, so only a kill ends it early.
    const slow =
      dialect === 'pwsh'
        ? 'Set-Content -Path shell.pid -Value $PID; Start-Sleep -Seconds 45; Set-Content -Path late.txt -Value late'
        : 'echo $$ > shell.pid; sleep 45; echo late > late.txt'
    const running = shell.exec({ command: slow, policy: unconfined(root), oneShot: true, timeoutMs: SHELL_TEST_TIMEOUT_MS })
    const settled = running.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await until('the one-shot command to record its pid', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(pid), `the one-shot (pid ${pid}) was not running when the scope ended`).toBe(true)
    await shell.dispose()
    const outcome = await settled
    // It RAN and was cut short: a refusal, or a child that never started,
    // would settle some other way and prove nothing about a reap.
    expect('error' in outcome ? outcome.error : undefined, 'the one-shot was refused instead of run').toBeUndefined()
    const result = (outcome as { result: ShellRunResult }).result
    expect(result.aborted, 'the one-shot was never dispatched').toBeUndefined()
    expect(result.exitCode, `the command ran to its own end: ${JSON.stringify(result)}`).not.toBe(0)
    await until(`the one-shot's process ${pid} to be gone`, () => !alive(pid), 15_000)
    expect(existsSync(marker), 'an escalated command outlived the shell that ran it').toBe(false)
  }, SHELL_TEST_TIMEOUT_MS)

  /**
   * The harder half of the same promise, and the one reaping the child alone
   * does not keep: a command that BACKGROUNDS something exits immediately, so
   * by the time disposal looks there is no child left to kill while its
   * descendant runs on — holding the widest authority the session ever granted.
   * The one-shot leads its own process group for exactly this, and the group
   * outlives its leader (Linux keeps a pid allocated while it is a pgid, so
   * signalling it can never reach an unrelated process). POSIX only: Windows
   * has no process groups here and no confinement backend either.
   */
  it.skipIf(process.platform === 'win32' || !bashAvailable)('reaps what an escalated command left running, not just the command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-oneshot-tree-'))
    dir = root
    const marker = join(root, 'late.txt')
    const pidFile = join(root, 'bg.pid')
    const shell = new ShellProcess('bash', root)
    proc = shell
    // The descendant records its own pid, then waits far longer than the test:
    // only the reap can end it, and its death is watched for directly. (`sh
    // -c` so `$$` is the descendant's own pid in every bash, 3.2 included.)
    const result = await shell.exec({
      command: `sh -c 'echo $$ > bg.pid; sleep 45; echo late > late.txt' > /dev/null 2>&1 & disown; echo started`,
      policy: unconfined(root),
      oneShot: true,
      timeoutMs: 30_000,
    })
    // The call itself is over at once — that is the whole difficulty.
    expect(result.exitCode).toBe(0)
    await until('the backgrounded descendant to record its pid', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    // The positive control: the call has returned and its descendant is still running.
    expect(alive(pid), `the descendant (pid ${pid}) did not outlive the call, so there is nothing for the scope to reap`).toBe(true)
    await shell.dispose()
    await until(`the backgrounded descendant ${pid} to be reaped`, () => !alive(pid), 15_000)
    expect(existsSync(marker), 'a backgrounded descendant of an escalated command outlived the scope that granted it').toBe(false)
  }, SHELL_TEST_TIMEOUT_MS)

  /**
   * The reap's limit is pid reuse: a group that is entirely gone has given its
   * number back, and macOS hands numbers out again after 99,999. So disposal
   * never signals a group it can prove empty — before, every pgid a one-shot
   * ever led got a SIGKILL at disposal, days later, whoever held it by then.
   */
  it.skipIf(process.platform === 'win32' || !bashAvailable)('never signals at disposal a group that had already emptied', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-oneshot-prune-'))
    const shell = new ShellProcess('bash', dir)
    const kills: [number, string | number | undefined][] = []
    const real = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      kills.push([pid, signal])
      return real(pid, signal)
    })
    try {
      for (let i = 0; i < 3; i++) {
        const done = await shell.exec({ command: 'true', policy: unconfined(dir), oneShot: true, timeoutMs: 30_000 })
        expect(done.exitCode).toBe(0)
      }
      await shell.dispose()
    } finally {
      spy.mockRestore()
    }
    const sigkilledGroups = kills.filter(([pid, signal]) => pid < 0 && signal === 'SIGKILL')
    expect(sigkilledGroups, 'disposal signalled groups that were already empty, whose numbers anyone may hold by now').toEqual([])
  }, SHELL_TEST_TIMEOUT_MS)
})

describe('a shell binary that is not there', () => {
  it('refuses with SHELL_UNAVAILABLE naming the binary and the remedy, never a command that printed nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir, { shellPath: 'minidsh-no-such-shell-binary' })
    // A stock Windows has powershell.exe 5.1 and no pwsh: the spawn fails one
    // tick after it returns, and this used to be read as an exited child whose
    // output was empty.
    await expect(proc.exec({ command: echoCmd('hello'), policy: unconfined(dir), timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'SHELL_UNAVAILABLE',
      message: expect.stringContaining('minidsh-no-such-shell-binary'),
    })
  })
})

describe('a shell binary that starts and dies at once', () => {
  it('is the same refusal as a missing one, never a command that printed nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    // node rejects the shell's own flags (--noprofile / -NoLogo) and exits at
    // startup: a spawn that succeeds and a child that never answers.
    proc = new ShellProcess(dialect, dir, { shellPath: process.execPath })
    await expect(proc.exec({ command: echoCmd('hello'), policy: unconfined(dir), timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'SHELL_UNAVAILABLE',
      message: expect.stringContaining('before it answered'),
    })
  })

  /**
   * The same child, handed a command larger than a pipe buffer (its base64 is
   * ~1.3 MB against a 64 KB pipe), so the write is still QUEUED when the child
   * dies. Its stdin then raises EPIPE (POSIX) or `write EOF` (Windows), and
   * with nobody listening that error took the whole host down — this test's
   * worker, before the fix. The same crash met a person cancelling a ~48 KB
   * command while pwsh was still starting.
   */
  it('takes a command larger than the pipe buffer without an error escaping into the host', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-shell-'))
    proc = new ShellProcess(dialect, dir, { shellPath: process.execPath })
    await expect(proc.exec({ command: echoCmd('x'.repeat(1_000_000)), policy: unconfined(dir), timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'SHELL_UNAVAILABLE',
    })
  })
})

/**
 * Node 24's own answer to a spawn when this process is out of descriptors,
 * staged exactly: `spawn` RETURNS a child with no pid and no pipes (Node bails
 * before building `stdio`), and the EMFILE `'error'` follows on the next tick.
 * Never a `stdout: null` stand-in — that is not what Node does, and a fix
 * tested against it was a fix for a case that does not exist. The real
 * exhaustion is `core/process.test.ts`'s, on POSIX.
 */
const outOfDescriptors = (spawned: string[]): Spawner => (command) => {
  spawned.push(command)
  const child = new ChildProcess()
  // As Node does it (onErrorNT, then onexit): the negative errno as the exit
  // code, then 'error', then 'close'.
  process.nextTick(() => {
    ;(child as { exitCode: number | null }).exitCode = -24
    child.emit('error', Object.assign(new Error(`spawn ${command} EMFILE`), { code: 'EMFILE', errno: -24, syscall: `spawn ${command}` }))
    child.emit('close', -24, null)
  })
  return child
}

describe('a host out of descriptors', () => {
  const policyIn = (root: string): SandboxExecutionPolicy => unconfined(root)
  for (const shape of ['the persistent shell', 'a one-shot escalation', 'a job'] as const) {
    it(`refuses ${shape} with a code that says the moment, never "install", and nothing escapes into the host`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'minidsh-emfile-'))
      const spawned: string[] = []
      proc = new ShellProcess(dialect, dir, { spawner: outOfDescriptors(spawned) })
      const run =
        shape === 'a job'
          ? proc.start({ command: echoCmd('hi'), policy: policyIn(dir), output: () => {} })
          : proc.exec({ command: echoCmd('hi'), policy: policyIn(dir), timeoutMs: 30_000, ...(shape === 'a one-shot escalation' ? { oneShot: true } : {}) })
      const refusal = await run.then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(spawned).toHaveLength(1)
      expect(refusal).toMatchObject({ code: 'SHELL_UNAVAILABLE', message: expect.stringContaining('EMFILE') })
      expect((refusal as Error).message).toContain('out of file descriptors or processes')
      expect((refusal as Error).message).not.toMatch(/install/i)
      // And the shell is still usable for what comes after: a later spawn tries again.
      await expect(proc.exec({ command: echoCmd('again'), policy: policyIn(dir), timeoutMs: 30_000 })).rejects.toMatchObject({ code: 'SHELL_UNAVAILABLE' })
      expect(spawned).toHaveLength(2)
    })
  }

  it('keeps the sandbox code under a wrapper, without telling the model to install the backend', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-emfile-'))
    const wrapping: Confinement = { ...NO_CONFINEMENT, id: 'bwrap', enforcement: 'full', wrap: (cmd, args) => ({ cmd: 'bwrap', args: ['--', cmd, ...args] }) }
    proc = new ShellProcess(dialect, dir, { confinement: wrapping, spawner: outOfDescriptors([]) })
    const confined: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: dir }
    const refusal = await proc.exec({ command: echoCmd('hi'), policy: confined, timeoutMs: 30_000 }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refusal).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', message: expect.stringContaining('out of file descriptors or processes') })
    expect((refusal as Error).message).not.toMatch(/install/i)
  })
})

/** A pid no process can have (past every platform's pid range), so a kill aimed at it reaches nobody. */
const UNUSED_PID = 2_147_483_647

/**
 * A persistent bash child the TEST plays: it reads what the harness writes to
 * the child's stdin (the init line, then one wrapper line per command, which
 * is where the markers are learned from) and writes the child's stdout in
 * chunks cut exactly where a case needs them. A real shell cannot be made to
 * split a marker line across two reads, print past a bound on cue, or stay
 * alive while it is being killed; those are the cases this exists for. With
 * no pid (the default) nothing ever waits for it to die.
 */
function stagedShell(options: { pid?: number } = {}) {
  let spawnCount = 0
  let kills = 0
  let answered = 0
  let readyOwed = true
  let written = ''
  let child: (EventEmitter & { exitCode: number | null }) | undefined
  let stdout: PassThrough | undefined
  let stderr: PassThrough | undefined
  const spawner: Spawner = () => {
    spawnCount++
    answered = 0
    readyOwed = true
    written = ''
    const out = new PassThrough()
    const err = new PassThrough()
    const stdin = new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        written += String(chunk)
        done()
      },
    })
    const staged = Object.assign(new EventEmitter(), {
      stdin,
      stdout: out,
      stderr: err,
      stdio: [stdin, out, err],
      pid: options.pid,
      exitCode: null as number | null,
      signalCode: null,
      killed: false,
      kill: (): boolean => {
        kills++
        return true
      },
    })
    child = staged
    stdout = out
    stderr = err
    process.nextTick(() => staged.emit('spawn'))
    return staged as unknown as ChildProcess
  }
  const wrappers = (): string[] => [...written.matchAll(/(__DSH_[0-9a-f]+__[1-9]\d*):%s/g)].map((match) => match[1]!)
  /** The markers of the command in flight, once its wrapper line has been written. `ready` only while the ready line is still owed. */
  const command = async (): Promise<{ ready: string | undefined; marker: string }> => {
    await until(`wrapper line ${answered + 1} to reach the staged child's stdin`, () => wrappers().length > answered, 10_000)
    const ready = /'(__DSH_[0-9a-f]+__0)'/.exec(written)?.[1]
    if (ready === undefined) throw new Error(`no ready marker in the init line: ${written.slice(0, 200)}`)
    const marker = wrappers()[answered]!
    answered++
    const owed = readyOwed
    readyOwed = false
    return { ready: owed ? ready : undefined, marker }
  }
  /** One chunk, delivered as one `'data'` event before the next is written. */
  const write = async (chunk: string | Buffer, stream: 'stdout' | 'stderr' = 'stdout'): Promise<void> => {
    ;(stream === 'stdout' ? stdout : stderr)!.write(chunk)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    spawner,
    spawns: (): number => spawnCount,
    killRequests: (): number => kills,
    /** Whether the harness has begun reading the child's stdout. */
    listening: (): boolean => (stdout?.listenerCount('data') ?? 0) > 0,
    pipesDestroyed: (): boolean => stdout?.destroyed === true && stderr?.destroyed === true,
    command,
    write,
    /** The whole answer in one chunk: the ready line if owed, the output, the end marker line. */
    answer: async (output: string, exitCode: number): Promise<void> => {
      const { ready, marker } = await command()
      await write(`${ready === undefined ? '' : `${ready}\n`}${output}\n${marker}:${exitCode}\n`)
    },
    exit: (code: number): void => {
      child!.exitCode = code
      child!.emit('exit', code, null)
      stdout!.end()
      stderr!.end()
      child!.emit('close', code, null)
    },
  }
}

/** What a ShellProcess holds of its live command's output, read where it is kept: the bound is about memory, which no result shows. */
function retainedChars(shell: ShellProcess): number {
  const capture = (shell as unknown as { capture?: { kept: string; held: string; startup: string } }).capture
  if (capture === undefined) throw new Error('no capture: no command is in flight')
  return capture.kept.length + capture.held.length + capture.startup.length
}

/**
 * The capture bound, WHILE a command runs. It used to be applied when the
 * command ended, to a string that had grown without one: output past V8's
 * string limit (~512 MB) threw inside a stream listener, an uncaught
 * exception that ends the host and every session it serves (S22.5 audit).
 * Bounding on arrival moves the search for the two marker lines onto the
 * arriving chunks too, so every way a chunk boundary can fall is staged here.
 */
describe('what the persistent shell keeps of a command while it runs', () => {
  const start = (max: number): { shell: ShellProcess; staged: ReturnType<typeof stagedShell>; policy: SandboxExecutionPolicy } => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-capture-'))
    dir = root
    const staged = stagedShell()
    proc = new ShellProcess('bash', root, { maxCaptureChars: max, spawner: staged.spawner })
    return { shell: proc, staged, policy: unconfined(root) }
  }

  it('holds at most the bound plus one marker line however much is printed, finds the end marker after it, and says output was cut', async () => {
    const max = 1_000
    const { shell, staged, policy } = start(max)
    const run = shell.exec({ command: 'noisy', policy, timeoutMs: 60_000 })
    const { ready, marker } = await staged.command()
    await staged.write(`${ready}\n`)
    let peak = 0
    // 6.5 MB through a 1,000-character bound, looked at after every chunk.
    for (let i = 0; i < 100; i++) {
      await staged.write(`${String(i).padStart(3, '0')}${'x'.repeat(65_533)}`)
      peak = Math.max(peak, retainedChars(shell))
    }
    expect(peak, `held ${peak} characters at its peak for a bound of ${max}`).toBeLessThanOrEqual(max + marker.length + 16)
    // The marker line itself split across two chunks, after everything that was dropped.
    await staged.write(`\n${marker.slice(0, 10)}`)
    await staged.write(`${marker.slice(10)}:7\n`)
    const result = await run
    expect(result).toMatchObject({ exitCode: 7, truncated: true, reset: false, timedOut: false })
    const [kept, note] = result.output.split('\n[')
    expect(kept).toBe(`000${'x'.repeat(max - 3)}`)
    expect(note).toContain(`output stopped at ${max} captured characters`)
    expect(result.output).not.toContain('__DSH_')
  }, SHELL_TEST_TIMEOUT_MS)

  it('reports nothing cut, and the whole output, for a command that stays inside the bound', async () => {
    const { shell, staged, policy } = start(1_000)
    const run = shell.exec({ command: 'quiet', policy, timeoutMs: 60_000 })
    await staged.answer('a\nb', 0)
    expect(await run).toMatchObject({ exitCode: 0, truncated: false, output: 'a\nb' })
  }, SHELL_TEST_TIMEOUT_MS)

  it('finds a marker line cut at every one of its characters, and never ends a command on half an exit code', async () => {
    const { shell, staged, policy } = start(1_000)
    const first = shell.exec({ command: 'first', policy, timeoutMs: 60_000 })
    const opening = await staged.command()
    // The ready line itself arrives in two pieces.
    await staged.write(`start-up noise\n${opening.ready!.slice(0, 7)}`)
    await staged.write(`${opening.ready!.slice(7)}\nfirst\n${opening.marker}:0\n`)
    expect(await first).toMatchObject({ exitCode: 0, output: 'first' })

    const line = (marker: string): string => `out\n${marker}:127\n`
    const length = line(opening.marker).length
    const wrong: string[] = []
    for (let cutAt = 1; cutAt < length; cutAt++) {
      const run = shell.exec({ command: `cut ${cutAt}`, policy, timeoutMs: 60_000 })
      const { marker } = await staged.command()
      const text = line(marker)
      await staged.write(text.slice(0, cutAt))
      await staged.write(text.slice(cutAt))
      const result = await run
      if (result.exitCode !== 127 || result.output !== 'out') wrong.push(`cut at ${cutAt} (${JSON.stringify(text.slice(cutAt - 3, cutAt))}|${JSON.stringify(text.slice(cutAt, cutAt + 3))}): exit ${result.exitCode}, output ${JSON.stringify(result.output)}`)
    }
    expect(wrong, `${wrong.length} of ${length - 1} cut positions were read wrongly`).toEqual([])
  }, SHELL_TEST_TIMEOUT_MS)

  it('never cuts through the middle of a character at the bound', async () => {
    // An emoji is two UTF-16 units, so an odd bound falls inside a pair.
    const max = 1_001
    const emoji = '\u{1F600}'
    const { shell, staged, policy } = start(max)
    const run = shell.exec({ command: 'emoji', policy, timeoutMs: 60_000 })
    const { ready, marker } = await staged.command()
    await staged.write(`${ready}\n`)
    for (let i = 0; i < 4; i++) await staged.write(emoji.repeat(400))
    await staged.write(`\n${marker}:0\n`)
    const result = await run
    expect(result.truncated).toBe(true)
    const kept = result.output.split('\n[')[0]!
    expect(kept.isWellFormed(), `the kept output ends in ${JSON.stringify(kept.slice(-2))}`).toBe(true)
    // The positive control: the bound did fall inside a pair, and one unit was given up.
    expect(kept).toBe(emoji.repeat(500))
    expect(kept.length).toBe(max - 1)
  }, SHELL_TEST_TIMEOUT_MS)

  it('keeps nothing a backgrounded process prints between two commands', async () => {
    const { shell, staged, policy } = start(1_000)
    const first = shell.exec({ command: 'first', policy, timeoutMs: 60_000 })
    await staged.answer('first', 0)
    expect((await first).output).toBe('first')
    // No command is in flight; megabytes arrive anyway.
    for (let i = 0; i < 20; i++) await staged.write('background '.repeat(6_000))
    expect(retainedChars(shell), 'output that belongs to no command is being held').toBeLessThanOrEqual(1_000)
    const second = shell.exec({ command: 'second', policy, timeoutMs: 60_000 })
    await staged.answer('second', 0)
    expect(await second).toMatchObject({ output: 'second', truncated: false, exitCode: 0 })
  }, SHELL_TEST_TIMEOUT_MS)

  it('heads the first output with the containment warning from the start-up lines, and returns what was printed when the command is cancelled', async () => {
    const { shell, staged, policy } = start(1_000)
    const cancel = new AbortController()
    const run = shell.exec({ command: 'slow', policy, timeoutMs: 60_000, signal: cancel.signal })
    const { ready } = await staged.command()
    await staged.write(`WARNING: minidsh: what this command starts is not contained: staged\n${ready}\n`)
    // No line end and no marker: the last characters printed are still the command's output.
    await staged.write('partial output')
    cancel.abort()
    const result = await run
    expect(result).toMatchObject({ timedOut: false, reset: true, truncated: false })
    expect(result.output).toBe('WARNING: minidsh: what this command starts is not contained: staged\npartial output')
  }, SHELL_TEST_TIMEOUT_MS)
})

/**
 * A one-shot keeps its output in a local, so what it holds while a command
 * prints shows only in the heap: collected and measured around 64 MiB of
 * output, which the unbounded capture kept every byte of.
 */
describe('what a one-shot keeps of a command while it runs', () => {
  const collect = (): number => {
    // `gc` is not exposed to a test worker; V8 will hand it over at run time.
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    gc()
    gc()
    return process.memoryUsage().heapUsed
  }

  it('holds no more than the bound however much is printed, reports the cut and the exit code, and lets go of the pipes when the call ends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-capture-'))
    dir = root
    const staged = stagedShell()
    const max = 1_000
    proc = new ShellProcess('bash', root, { maxCaptureChars: max, spawner: staged.spawner })
    const run = proc.exec({ command: 'noisy', policy: unconfined(root), oneShot: true, timeoutMs: 60_000 })
    await until('the one-shot to read its child', () => staged.listening(), 10_000)
    const megabyte = 'y'.repeat(1024 * 1024)
    const before = collect()
    for (let i = 0; i < 64; i++) await staged.write(megabyte)
    const held = collect() - before
    expect(held, `the heap grew by ${held.toLocaleString('en-US')} bytes across 64 MiB of output and a bound of ${max} characters`).toBeLessThan(16 * 1024 * 1024)
    staged.exit(3)
    const result = await run
    expect(result).toMatchObject({ exitCode: 3, truncated: true, reset: false, timedOut: false })
    const [kept, note] = result.output.split('\n[')
    expect(kept).toBe('y'.repeat(max))
    expect(note).toContain(`output stopped at ${max} captured characters`)
    // A descendant the command backgrounded may hold these for as long as it
    // lives; the call that is over reads none of it.
    expect(staged.pipesDestroyed(), 'the finished one-shot still holds its pipes open').toBe(true)
  }, SHELL_TEST_TIMEOUT_MS)
})

/**
 * The same bound through a REAL shell, on both paths a command takes: the
 * persistent child, and the one-shot an approved escalation runs in (every
 * Windows command, by default). The staged cases above show the bound holds
 * while output arrives; these show a real command that printed far more
 * still ends with its own exit code and a result that says it was cut.
 */
describe.skipIf(!available)('a command that prints more than the shell captures', () => {
  // 200,000 characters and a line end, in one line: no dialect needs a loop for it.
  const flood = dialect === 'pwsh' ? "Write-Output ('x' * 200000)" : "head -c 200000 /dev/zero | tr '\\0' x; echo"
  const exitWith = (code: number): string => `${flood}; exit ${code}`
  const max = 5_000

  for (const shape of ['the persistent shell', 'a one-shot'] as const) {
    it(`${shape}: keeps the first ${max} characters, flags the cut, says so, and still reports how the command ended`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'minidsh-flood-'))
      dir = root
      proc = new ShellProcess(dialect, root, { maxCaptureChars: max })
      const oneShot = shape === 'a one-shot'
      // A one-shot's exit code is its process's, so it can end with one of its
      // own; the persistent shell's command must leave the shell alive.
      const result = await proc.exec({ command: oneShot ? exitWith(3) : flood, policy: unconfined(root), timeoutMs: 60_000, ...(oneShot ? { oneShot: true } : {}) })
      expect(result).toMatchObject({ truncated: true, timedOut: false, reset: false, exitCode: oneShot ? 3 : 0 })
      const [kept, note] = result.output.split('\n[')
      expect(kept, `kept ${kept?.length} characters for a bound of ${max}`).toBe('x'.repeat(max))
      expect(note).toContain(`output stopped at ${max} captured characters`)
      // And the shell is whole afterwards: nothing of the flood is left over for the next command.
      const after = await proc.exec({ command: echoCmd('after the flood'), policy: unconfined(root), timeoutMs: 60_000, ...(oneShot ? { oneShot: true } : {}) })
      expect(after).toMatchObject({ truncated: false, exitCode: 0 })
      expect(after.output.trim()).toBe('after the flood')
    }, SHELL_TEST_TIMEOUT_MS)
  }
})

/**
 * A session whose workspace folder is gone: deleted, renamed, or on a drive
 * that is no longer mounted (the desktop lists such a session and resumes it).
 * Node reports the missing `cwd` as the same ENOENT as a missing binary, so
 * every command answered "install PowerShell 7" or "install bash", and under
 * a wrapper SANDBOX_UNAVAILABLE "install bubblewrap", which the shell tool
 * turns into an offer to escalate: a person was asked to approve a wider mode
 * for a command that then failed the same way (S22.5 audit). No shell binary
 * is needed here: nothing starts.
 */
describe('a workspace folder that no longer exists', () => {
  const gone = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-gone-'))
    rmSync(root, { recursive: true, force: true })
    return root
  }
  const wrapping: Confinement = { ...NO_CONFINEMENT, id: 'bwrap', enforcement: 'full', runnerFailureSignatures: ['bwrap: '], wrap: (cmd, args) => ({ cmd: 'bwrap', args: ['--', cmd, ...args] }) }
  const refusalOf = async (run: Promise<unknown>): Promise<Error & { code?: string }> => {
    const refusal = await run.then(
      () => undefined,
      (error: unknown) => error,
    )
    if (!(refusal instanceof Error)) throw new Error(`the command was not refused: ${JSON.stringify(refusal)}`)
    return refusal
  }

  for (const world of ['an unconfined shell', 'a shell behind a confinement wrapper'] as const) {
    for (const shape of ['the persistent shell', 'a one-shot escalation', 'a job'] as const) {
      it(`${world}, ${shape}: names the folder under the shell's own code, never "install" and never a sandbox refusal`, async () => {
        const root = gone()
        const confined = world === 'a shell behind a confinement wrapper'
        proc = new ShellProcess(dialect, root, confined ? { confinement: wrapping } : {})
        const policy: SandboxExecutionPolicy = confined ? { mode: 'workspace-write', workspaceRoot: root } : unconfined(root)
        const refusal = await refusalOf(
          shape === 'a job'
            ? proc.start({ command: echoCmd('hi'), policy, output: () => {} })
            : proc.exec({ command: echoCmd('hi'), policy, timeoutMs: 30_000, ...(shape === 'a one-shot escalation' ? { oneShot: true } : {}) }),
        )
        expect(refusal.message).toBe(`this session's workspace folder ${root} no longer exists; nothing ran`)
        // SANDBOX_UNAVAILABLE is what the shell tool answers with an escalation offer.
        expect(refusal.code).toBe('SHELL_UNAVAILABLE')
        expect(refusal.message).not.toMatch(/install/i)
      })
    }
  }

  it('says so before the refusal that would offer an escalation, on a host with no backend', async () => {
    const root = gone()
    proc = new ShellProcess(dialect, root)
    const confined: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: root }
    for (const run of [() => proc!.exec({ command: echoCmd('hi'), policy: confined, timeoutMs: 30_000 }), () => proc!.start({ command: echoCmd('hi'), policy: confined, output: () => {} })]) {
      const refusal = await refusalOf(run())
      expect(refusal).toMatchObject({ code: 'SHELL_UNAVAILABLE', message: expect.stringContaining('no longer exists') })
    }
  })

  // The control: with the folder THERE, the same two refusals are the ones they always were.
  it('still names the missing binary, and still refuses a confined mode, when the folder is there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-there-'))
    dir = root
    proc = new ShellProcess(dialect, root, { shellPath: 'minidsh-no-such-shell-binary' })
    expect(await refusalOf(proc.exec({ command: echoCmd('hi'), policy: unconfined(root), timeoutMs: 30_000 }))).toMatchObject({
      code: 'SHELL_UNAVAILABLE',
      message: expect.stringMatching(/minidsh-no-such-shell-binary.*install/),
    })
    expect(await refusalOf(proc.exec({ command: echoCmd('hi'), policy: { mode: 'workspace-write', workspaceRoot: root }, timeoutMs: 30_000 }))).toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      message: expect.stringContaining('no confinement backend'),
    })
  })
})

/**
 * "The wrapper never started" against "the command ran and failed", at the
 * three places that decide it: the persistent shell, a one-shot, a job.
 *
 * The first is a refusal with the sandbox's code and a remedy, and no effect
 * record: nothing ran. It used to be decided from the output's TEXT alone,
 * anywhere in it, so a command that ran, printed `bwrap: ...` and exited
 * non-zero was refused with "install bubblewrap", offered an escalation and
 * left no record of having run (S22.5 audit, reproduced). The stand-in for a
 * wrapper here is a second binary that runs the real shell (as bwrap does) or
 * dies first with a line of its own (as bwrap does when it cannot start).
 */
describe.skipIf(!available)('a confinement wrapper that fails, and a command that only mentions one', () => {
  const policyIn = (root: string): SandboxExecutionPolicy => ({ mode: 'workspace-write', workspaceRoot: root })
  /**
   * A wrapper that works: another process, which runs the shell it was given
   * and exits as it did.
   *
   * `windowsHide`, because the stand-in must start the shell the way the
   * product does: with no console. This wrapper has none itself (the harness
   * spawns it hidden), and Windows gives a console program started from a
   * console-less parent a NEW console unless told otherwise. A pwsh that
   * begins that way and then runs the containment line now and then dies
   * before its command with `Fatal error. Internal CLR error. (0x80131506)`,
   * exit 3221225477: 3 of 550 runs under load, against 0 of 550 with the
   * window hidden and 0 of 750 spawned directly, as the product spawns every
   * pwsh (measured 2026-11-22, PowerShell 7.6). It failed the job test here
   * twice in about seventeen full runs before it was traced.
   */
  const running = (root: string): Confinement => {
    const runner = join(root, 'wrapper.cjs')
    writeFileSync(
      runner,
      "const [cmd, ...args] = process.argv.slice(2); const run = require('node:child_process').spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true }); process.exit(run.status ?? 1)\n",
    )
    return { ...NO_CONFINEMENT, id: 'bwrap', enforcement: 'full', runnerFailureSignatures: ['bwrap: '], wrap: (cmd, args) => ({ cmd: process.execPath, args: [runner, cmd, ...args] }) }
  }
  /** A wrapper that dies before it runs anything, saying `line` on stderr, the way bwrap reports its own failure. */
  const dying = (line: string): Confinement => ({
    ...NO_CONFINEMENT,
    id: 'bwrap',
    enforcement: 'full',
    runnerFailureSignatures: ['bwrap: '],
    wrap: () => ({ cmd: process.execPath, args: ['-e', `process.stderr.write(${JSON.stringify(`${line}\n`)}); process.exit(1)`] }),
  })
  const mention = dialect === 'pwsh' ? "Write-Output 'bwrap: mentioned by the command'; exit 1" : "echo 'bwrap: mentioned by the command'; exit 1"
  const setup = (confinement: (root: string) => Confinement): { shell: ShellProcess; policy: SandboxExecutionPolicy } => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-wrapper-'))
    dir = root
    proc = new ShellProcess(dialect, root, { confinement: confinement(root) })
    return { shell: proc, policy: policyIn(root) }
  }
  const jobExit = async (shell: ShellProcess, policy: SandboxExecutionPolicy, command: string): Promise<{ exit: ShellJobExit; output: string }> => {
    const chunks: string[] = []
    const job = await shell.start({ command, policy, output: (chunk) => chunks.push(chunk) })
    return { exit: await job.exited, output: chunks.join('') }
  }

  it('a ONE-SHOT that ran and printed the wrapper\'s name is a command that failed: its output, its exit code, and no start line in either', async () => {
    const { shell, policy } = setup(running)
    const result = await shell.exec({ command: mention, policy, oneShot: true, timeoutMs: 60_000 })
    expect(result).toMatchObject({ exitCode: 1, timedOut: false, sandbox: { mode: 'workspace-write', enforcement: 'full' } })
    expect(result.output.trim()).toBe('bwrap: mentioned by the command')
  }, SHELL_TEST_TIMEOUT_MS)

  it('a JOB that ran and printed the wrapper\'s name ended on its own: no runner failure, and the start line never reaches its output', async () => {
    const { shell, policy } = setup(running)
    const { exit, output } = await jobExit(shell, policy, mention)
    expect(exit.failure, `a job that ran was recorded as a runner that never started: ${exit.failure}`).toBeUndefined()
    expect(exit.exitCode).toBe(1)
    expect(output.trim()).toBe('bwrap: mentioned by the command')
  }, SHELL_TEST_TIMEOUT_MS)

  it('the PERSISTENT shell that answered and then ran such a command reports the command, not the wrapper', async () => {
    const { shell, policy } = setup(running)
    const result = await shell.exec({ command: dialect === 'pwsh' ? "Write-Output 'bwrap: mentioned by the command'; node -e \"process.exit(1)\"" : "echo 'bwrap: mentioned by the command'; false", policy, timeoutMs: 60_000 })
    expect(result).toMatchObject({ exitCode: 1, reset: false })
    expect(result.output.trim()).toBe('bwrap: mentioned by the command')
  }, SHELL_TEST_TIMEOUT_MS)

  const died = 'bwrap: setting up uid map: Permission denied'
  it('a wrapper that died first is SANDBOX_UNAVAILABLE at all three, with what it said and the remedy', async () => {
    const { shell, policy } = setup(() => dying(died))
    for (const run of [() => shell.exec({ command: echoCmd('never'), policy, timeoutMs: 60_000 }), () => shell.exec({ command: echoCmd('never'), policy, oneShot: true, timeoutMs: 60_000 })]) {
      await expect(run()).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', message: expect.stringMatching(/setting up uid map: Permission denied.*install bubblewrap/s) })
    }
    const { exit } = await jobExit(shell, policy, echoCmd('never'))
    expect(exit.failure).toContain('the confinement runner "bwrap" failed: bwrap: setting up uid map: Permission denied')
  }, SHELL_TEST_TIMEOUT_MS)

  // `bwrap: execvp bash: No such file or directory` is a MISSING SHELL said in
  // bwrap's voice: an escalation would spawn the same missing shell unconfined.
  it('a wrapper reporting that the SHELL is missing is not a sandbox failure at any of the three', async () => {
    const { shell, policy } = setup(() => dying('bwrap: execvp bash: No such file or directory'))
    await expect(shell.exec({ command: echoCmd('never'), policy, timeoutMs: 60_000 })).rejects.toMatchObject({ code: 'SHELL_UNAVAILABLE' })
    const oneShot = await shell.exec({ command: echoCmd('never'), policy, oneShot: true, timeoutMs: 60_000 })
    expect(oneShot).toMatchObject({ exitCode: 1, output: expect.stringContaining('execvp bash') })
    expect((await jobExit(shell, policy, echoCmd('never'))).exit.failure).toBeUndefined()
  }, SHELL_TEST_TIMEOUT_MS)
})

/**
 * A one-shot and a job carry the command as an ARGUMENT, so the OS can refuse
 * the spawn for the command itself: too long for one argv, or a NUL byte Node
 * will not pass.

/**
 * A one-shot and a job carry the command as an ARGUMENT, so the OS can refuse
 * the spawn for the command itself: too long for one argv, or a NUL byte Node
 * will not pass. That was reported as "install bash", or under a wrapper as
 * SANDBOX_UNAVAILABLE, which steers the model to spend a consent on a wider
 * mode that meets the same limit (S20.5 review). A NUL is refused before any
 * binary is looked up, so the real spawner shows it on every host.
 */
// The S20.5 review: a disposal that landed while the shell restarted into
// another world found no child to kill, and the restart then spawned one
// nothing would reap. Windows' tree kill (~0.26 s) is the window this lands in.
describe('a disposal during a restart', () => {
  /**
   * The window is held open by the test, not hoped for: the old child is a
   * staged one whose death the test decides, so the restart is provably in
   * flight when the disposal lands. A pause could not do that (on POSIX a
   * kill returns in milliseconds, so the disposal landed after the restart),
   * and "no child afterwards" could not tell the guard in `runOne` from
   * `ensureChild`'s own, which also spawns nothing but REJECTS: the two
   * differ in what the caller is told, and that is what is asserted.
   */
  it('spawns nothing after it, and the command it interrupted says it never ran', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-restart-'))
    const staged = stagedShell({ pid: UNUSED_PID })
    const identity: Confinement = { ...NO_CONFINEMENT, id: 'bwrap', enforcement: 'full', wrap: (cmd, args) => ({ cmd, args: [...args] }) }
    proc = new ShellProcess('bash', dir, { confinement: identity, spawner: staged.spawner })
    const first = proc.exec({ command: 'first', policy: { mode: 'workspace-write', workspaceRoot: dir }, timeoutMs: 60_000 })
    await staged.answer('first\n', 0)
    expect(await first).toMatchObject({ exitCode: 0, output: 'first' })

    // Another world: the shell lets go of its child and waits for it to die.
    const run = proc.exec({ command: 'second', policy: { mode: 'read-only', workspaceRoot: dir }, timeoutMs: 60_000 })
    await until('the restart to ask the old child to die', () => staged.killRequests() > 0)
    await proc.dispose()
    // Only now does the old child die, and the restart resume: disposed.
    staged.exit(137)
    expect(await run).toMatchObject({ aborted: true, output: '' })
    expect(staged.spawns(), `spawned ${staged.spawns()} children: the restart started one after the disposal`).toBe(1)
  }, SHELL_TEST_TIMEOUT_MS)
})

describe('a command no process can be given', () => {
  for (const wrapped of [false, true]) {
    it(`refuses it as the command's own, never "install"${wrapped ? ', under a wrapper too' : ''}`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'minidsh-argv-'))
      const wrapping: Confinement = { ...NO_CONFINEMENT, id: 'bwrap', enforcement: 'full', wrap: (cmd, args) => ({ cmd: 'bwrap', args: ['--', cmd, ...args] }) }
      proc = new ShellProcess(dialect, dir, wrapped ? { confinement: wrapping } : {})
      const policy: SandboxExecutionPolicy = wrapped ? { mode: 'workspace-write', workspaceRoot: dir } : unconfined(dir)
      const command = echoCmd('a\u0000b')
      for (const run of [() => proc!.exec({ command, policy, timeoutMs: 30_000, oneShot: true }), () => proc!.start({ command, policy, output: () => {} })]) {
        const refusal = await run().then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(refusal).toMatchObject({ code: 'SHELL_COMMAND_INVALID', message: expect.stringContaining('ERR_INVALID_ARG_VALUE') })
        expect((refusal as Error).message).not.toMatch(/install/i)
      }
    })
  }
})

/**
 * SHELL_UNAVAILABLE means the child never answered the HARNESS — never that
 * the model's own command ended it. The init line ends with a ready marker, so
 * a first command that exits the shell (`exit`, or `set -e` meeting a failing
 * step, which models lead with) is the command's: `reset`, with its output.
 * Before the handshake both read as "install bash", and the command that ran
 * got no effect record.
 */
const dialects = (['pwsh', 'bash'] as const).filter((each) => (each === 'pwsh' ? dialect === 'pwsh' && available : bashAvailable))
describe.runIf(dialects.length > 0)('a first command that ends the shell', () => {
  for (const each of dialects) {
    const say = (text: string): string => (each === 'pwsh' ? `Write-Output '${text}'` : `echo '${text}'`)
    const endings = [
      { name: '`exit`', command: `${say('bye')}; exit`, printed: 'bye' },
      each === 'bash'
        ? { name: '`set -e` meeting a failing step', command: `set -e; ${say('testing')}; false; ${say('unreachable')}`, printed: 'testing' }
        : { name: 'a script that exits part-way', command: `${say('testing')}; exit 1; ${say('unreachable')}`, printed: 'testing' },
    ]
    for (const ending of endings) {
      it(`${each}: ${ending.name} is the command's, reported as a reset with its output`, async () => {
        // The host first, outside any command's deadline (`hostUp`): the
        // command below is still the first this ShellProcess is given.
        await hostUp(each)
        dir = mkdtempSync(join(tmpdir(), 'minidsh-first-'))
        proc = new ShellProcess(each, dir)
        const result = await proc.exec({ command: ending.command, policy: unconfined(dir), timeoutMs: 60_000 })
        expect(result.reset).toBe(true)
        expect(result.timedOut).toBe(false)
        expect(result.output).toContain(ending.printed)
        expect(result.output).not.toContain('unreachable')
        // The world is fine: the next command runs in a fresh shell.
        const after = await proc.exec({ command: say('next'), policy: unconfined(dir), timeoutMs: 60_000 })
        expect(after.output).toContain('next')
        expect(after.exitCode).toBe(0)
      }, SHELL_TEST_TIMEOUT_MS)
    }
  }
})
