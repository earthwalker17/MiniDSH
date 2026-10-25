import { ChildProcess, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SandboxExecutionPolicy } from '../../core/sandbox/index.ts'
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
    expect(result.exitCode).not.toBe(0)
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

  it('is reaped by dispose, so nothing outlives the scope that ran it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-oneshot-'))
    const marker = join(dir, 'late.txt')
    const shell = new ShellProcess(dialect, dir)
    // A backslash is not an escape inside a PowerShell double-quoted string, and
    // a temp path holds no quote, so one spelling serves both dialects.
    const slow =
      dialect === 'pwsh'
        ? `Start-Sleep -Seconds 3; Set-Content -Path ${JSON.stringify(marker)} -Value late`
        : `sleep 3; echo late > ${JSON.stringify(marker)}`
    const running = shell.exec({ command: slow, policy: unconfined(dir), oneShot: true, timeoutMs: 30_000 }).catch(() => undefined)
    // Let the child get going, then end the scope under it.
    await new Promise((resolve) => setTimeout(resolve, 400))
    await shell.dispose()
    await running
    await new Promise((resolve) => setTimeout(resolve, 3_500))
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
    dir = mkdtempSync(join(tmpdir(), 'minidsh-oneshot-tree-'))
    const marker = join(dir, 'late.txt')
    const shell = new ShellProcess('bash', dir)
    const result = await shell.exec({
      command: `( sleep 3; echo late > ${JSON.stringify(marker)} ) & disown; echo started`,
      policy: unconfined(dir),
      oneShot: true,
      timeoutMs: 30_000,
    })
    // The call itself is over at once — that is the whole difficulty.
    expect(result.exitCode).toBe(0)
    await shell.dispose()
    await new Promise((resolve) => setTimeout(resolve, 4_500))
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
  process.nextTick(() => child.emit('error', Object.assign(new Error(`spawn ${command} EMFILE`), { code: 'EMFILE', errno: -24, syscall: `spawn ${command}` })))
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

/**
 * A one-shot and a job carry the command as an ARGUMENT, so the OS can refuse
 * the spawn for the command itself: too long for one argv, or a NUL byte Node
 * will not pass. That was reported as "install bash", or under a wrapper as
 * SANDBOX_UNAVAILABLE, which steers the model to spend a consent on a wider
 * mode that meets the same limit (S20.5 review). A NUL is refused before any
 * binary is looked up, so the real spawner shows it on every host.
 */
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
