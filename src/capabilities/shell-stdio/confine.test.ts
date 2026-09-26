/**
 * The confinement backend, against the kernel that enforces it.
 *
 * Every assertion here is about the WORLD, never an exit code: a denied write
 * must leave nothing on the host. An exit code says a command failed, which is
 * what a typo does too — only the absent file says the sandbox refused it, and
 * that difference is the whole distance between a `none` and a `full` stamp.
 *
 * The gate is deliberately NOT this project's own probe. It asks the platform
 * whether the mechanism is installed (a version check, a different question),
 * and the assertions then hold the provider's functional probe to it. A host
 * where the binary exists and cannot enforce therefore FAILS here rather than
 * skipping quietly, which is the case worth catching: `bwrap` inside a
 * container that forbids user namespaces reports itself perfectly well.
 *
 * `MINIDSH_EXPECT_CONFINEMENT=1` turns a skip into a failure, for the CI legs
 * that exist to prove this and must never pass having proved nothing.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, type SandboxExecutionPolicy, type SandboxMode } from '../../core/sandbox/index.ts'
import { bwrapArgs } from './confine/bwrap.ts'
import { seatbeltArgs } from './confine/seatbelt.ts'
import { NO_CONFINEMENT, selectConfinement } from './confine/index.ts'
import { ShellProcess } from './process.ts'

// ---- the profiles, everywhere ---------------------------------------------
// Pure builders: these run on every platform, including the one that ships no
// backend at all, because a profile is a claim about what will be enforced and
// a silently weakened one is the failure this file exists to prevent.

const policyFor = (mode: SandboxMode, workspaceRoot: string): SandboxExecutionPolicy => ({ mode, workspaceRoot })

describe('the bwrap profile', () => {
  it('binds the host root read-only and unshares the PID namespace, in that order', () => {
    expect(bwrapArgs(policyFor('read-only', '/ws'))).toEqual([
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--unshare-pid',
      '--proc',
      '/proc',
      '--die-with-parent',
      '--new-session',
    ])
  })

  it('carves exactly the ceiling out of it under workspace-write, tmpfs BEFORE the bind', () => {
    const args = bwrapArgs(policyFor('workspace-write', '/tmp/ws'))
    expect(args.slice(-5)).toEqual(['--tmpfs', '/tmp', '--bind', '/tmp/ws', '/tmp/ws'])
    // The order is load-bearing: the tmpfs masks the host temp directory and
    // the bind then re-exposes the one root the ceiling names. Reversed, the
    // tmpfs would bury the workspace this session works in.
    expect(args.indexOf('--tmpfs')).toBeLessThan(args.indexOf('--bind'))
  })

  it('never drops the two flags that close an escape needing no write at all', () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      // A procfs magic link out of the read-only bind...
      expect(bwrapArgs(policyFor(mode, '/ws'))).toContain('--unshare-pid')
      // ...and TIOCSTI into the terminal that started the harness.
      expect(bwrapArgs(policyFor(mode, '/ws'))).toContain('--new-session')
    }
  })

  it('grants nothing at all under read-only', () => {
    expect(bwrapArgs(policyFor('read-only', '/ws'))).not.toContain('--bind')
    expect(bwrapArgs(policyFor('read-only', '/ws'))).not.toContain('--tmpfs')
  })
})

describe('the seatbelt profile', () => {
  it('denies writes and re-allows only the ceiling, leaving reads and network alone', () => {
    const args = seatbeltArgs(policyFor('workspace-write', '/Users/x/ws'))
    const profile = args[args.indexOf('-p') + 1]!
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(subpath (param "WRITABLE_ROOT_0"))')
    expect(args).toContain('-DWRITABLE_ROOT_0=/Users/x/ws')
  })

  it('grants no root under read-only, so the profile carries no parameter at all', () => {
    const args = seatbeltArgs(policyFor('read-only', '/Users/x/ws'))
    expect(args.some((arg) => arg.startsWith('-D'))).toBe(false)
    expect(args[args.indexOf('-p') + 1]!).not.toContain('subpath')
  })

  it('passes a hostile path as a PARAMETER, so it can never close the profile string', () => {
    const nasty = String.raw`/Users/x/ws" (subpath "/`
    const args = seatbeltArgs(policyFor('workspace-write', nasty))
    const profile = args[args.indexOf('-p') + 1]!
    // The path appears in the argv, never in the profile text — so there is no
    // escaper to get wrong, and no spelling of a workspace that widens a grant.
    expect(profile).not.toContain(nasty)
    expect(args).toContain(`-DWRITABLE_ROOT_0=${nasty}`)
  })
})

// ---- the mechanism, where it exists ---------------------------------------

/** Is the mechanism INSTALLED? A different question from "does it enforce", asked a different way. */
function mechanismInstalled(): boolean {
  if (process.platform === 'linux') return spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0
  if (process.platform === 'darwin') return spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '--', 'true'], { stdio: 'ignore' }).status === 0
  return false
}

const installed = mechanismInstalled()
const required = process.env.MINIDSH_EXPECT_CONFINEMENT === '1'

/**
 * What ARCHITECTURE §13 says about hard links, per platform: `true` = the
 * write reaches the outside inode (an escape the document states), `false` =
 * nothing on the host changes, `unmeasured` = print, assert nothing, and pin
 * from the CI log. Linux was measured under bwrap 0.9.0 on WSL 2 (2026-09-24
 * for the pre-existing link, 2026-09-26 for the rest).
 */
const HARD_LINK_ESCAPES: Readonly<Record<string, Readonly<Record<'preExisting' | 'created' | 'outsidePath', boolean | 'unmeasured'>>>> = {
  linux: { preExisting: true, created: false, outsidePath: false },
  darwin: { preExisting: 'unmeasured', created: 'unmeasured', outsidePath: 'unmeasured' },
}

/**
 * A measurement must reach the log of a PASSING run, and vitest shows a
 * passing test's console output only on a TTY. So it goes to the process's
 * own stderr, unintercepted, and to the GitHub job summary where one exists.
 */
function reportMeasurement(text: string): void {
  process.stderr.write(`${text}\n`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, `\`\`\`\n${text}\n\`\`\`\n`)
}

// A CI leg that exists to prove confinement may not go green having skipped it.
describe.runIf(required)('a host that is REQUIRED to confine', () => {
  it('has the mechanism installed', () => {
    expect(installed, `MINIDSH_EXPECT_CONFINEMENT=1 but no confinement mechanism is installed on ${process.platform}`).toBe(true)
  })
})

const dirs: string[] = []
let shell: ShellProcess | undefined
afterEach(async () => {
  await shell?.dispose()
  shell = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  // Canonical, because that is the identity the sandbox grants and the shell
  // stands in — on darwin os.tmpdir() is /var/folders/… behind a symlink to
  // /private/var, and an as-spelled grant would match nothing.
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

/** One spelling of a line break, so no escape has to survive a code edit. */
const NEWLINE = String.fromCharCode(10)

const writeInto = (path: string): string => `echo confined > ${JSON.stringify(path)}`

describe.skipIf(!installed)(`OS confinement on ${process.platform}`, () => {
  it('reports what it can actually deliver, and nothing for the mode that asks for nothing', () => {
    const confinement = selectConfinement('auto')
    // The gate said the mechanism is installed; the provider's FUNCTIONAL probe
    // is what may say it works. A disagreement here is the case this file
    // exists for — a backend that is present and cannot enforce.
    expect(confinement.enforcement).toBe('full')
    expect(confinement.id).toBe(process.platform === 'linux' ? 'bwrap' : 'seatbelt')
    expect(confinement.denialSignatures.length).toBeGreaterThan(0)
    // Not confined at all, so nothing is claimed: the mode is the statement.
    expect(confinement.wrap('bash', [], policyFor('danger-full-access', '/ws')).cmd).toBe('bash')
  })

  it('lets a command write inside the workspace, and the file is on the HOST', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const result = await shell.exec({ command: writeInto(join(ws, 'inside.txt')), policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })
    expect(result.exitCode).toBe(0)
    expect(result.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'full' })
    expect(readFileSync(join(ws, 'inside.txt'), 'utf8').trim()).toBe('confined')
  })

  it('refuses a write outside the workspace — and the proof is that nothing reached the host', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    const outside = tempDir('minidsh-confine-out-')
    const escape = join(outside, 'owned.txt')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const result = await shell.exec({ command: writeInto(escape), policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(escape)).toBe(false)
  })

  it('refuses a write to an ordinary system path the same way', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const home = join(process.env.HOME ?? '/tmp', '.minidsh-confine-canary')
    const result = await shell.exec({ command: writeInto(home), policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(home)).toBe(false)
    // The backend's own words for it, which is what lets the tool offer the
    // same escalation a refusal offers.
    const lower = result.output.toLowerCase()
    expect(selectConfinement('auto').denialSignatures.some((signature) => lower.includes(signature))).toBe(true)
  })

  it('refuses a write INSIDE the workspace under read-only', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const target = join(ws, 'nope.txt')
    const result = await shell.exec({ command: writeInto(target), policy: policyFor('read-only', ws), timeoutMs: 30_000 })
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('still confines when the session accepts less: acceptance relaxes a REFUSAL, never a boundary', async () => {
    // The invariant that keeps the acceptance knob from being a back door, and
    // the only host that can prove it. `ensureChild` wraps unconditionally and
    // `NO_CONFINEMENT.wrap` is the identity, so where a backend exists the
    // command is confined whatever anyone accepted — a session that says it
    // would tolerate an unconfined shell does not thereby get one.
    const ws = tempDir('minidsh-confine-ws-')
    const outside = tempDir('minidsh-confine-out-')
    const escape = join(outside, 'accepted.txt')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const result = await shell.exec({
      command: writeInto(escape),
      policy: policyFor('workspace-write', ws),
      accepts: 'none',
      timeoutMs: 30_000,
    })
    expect(result.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'full' })
    expect(existsSync(escape)).toBe(false)
  })

  it('does not wrap danger-full-access at all, and the write outside lands', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    const outside = tempDir('minidsh-confine-out-')
    const target = join(outside, 'allowed.txt')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const result = await shell.exec({ command: writeInto(target), policy: policyFor('danger-full-access', ws), timeoutMs: 30_000 })
    expect(result.exitCode).toBe(0)
    // A wrapper silently left in place would have refused this, and the mode
    // would then mean something other than what it says.
    expect(readFileSync(target, 'utf8').trim()).toBe('confined')
    expect(result.sandbox.enforcement).toBe('none')
  })

  it('keeps shell state across calls under one policy', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    mkdirSync(join(ws, 'sub'))
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const policy = policyFor('workspace-write', ws)
    await shell.exec({ command: 'cd sub', policy, timeoutMs: 30_000 })
    const result = await shell.exec({ command: 'pwd', policy, timeoutMs: 30_000 })
    expect(result.output).toContain('sub')
    expect(result.restarted).toBeUndefined()
  })

  it('replaces the child on a durable policy change, and says so as `restarted` rather than `reset`', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    mkdirSync(join(ws, 'sub'))
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    await shell.exec({ command: 'cd sub', policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })
    const result = await shell.exec({ command: 'pwd', policy: policyFor('read-only', ws), timeoutMs: 30_000 })
    expect(result.restarted).toBe(true)
    // `reset` means "your command killed the shell", and nothing went wrong here.
    expect(result.reset).toBe(false)
    expect(result.output.trim()).toBe(ws)
  })

  it('runs a ONE-SHOT grant beside the persistent shell, leaving its state alone', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    const outside = tempDir('minidsh-confine-out-')
    mkdirSync(join(ws, 'sub'))
    const target = join(outside, 'granted.txt')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const session = policyFor('workspace-write', ws)
    await shell.exec({ command: 'cd sub', policy: session, timeoutMs: 30_000 })

    const granted = await shell.exec({ command: writeInto(target), policy: policyFor('danger-full-access', ws), oneShot: true, timeoutMs: 30_000 })
    expect(granted.exitCode).toBe(0)
    expect(readFileSync(target, 'utf8').trim()).toBe('confined')
    // The grant covered one call: it neither moved the session's shell nor
    // restarted it, so the next ordinary command is still where it was.
    expect(granted.restarted).toBeUndefined()
    const after = await shell.exec({ command: 'pwd', policy: session, timeoutMs: 30_000 })
    expect(after.output).toContain('sub')
    expect(after.restarted).toBeUndefined()
  })

  /**
   * HARD LINKS, measured rather than assumed. Both backends confine by PATH,
   * and a hard link gives one inode two paths, so three questions decide what
   * "no host file outside the ceiling changes" is worth on a backend:
   *   (1) a link that already sits in the workspace, pointing at an outside inode;
   *   (2) a link the confined command CREATES from an outside file into the workspace;
   *   (3) an outside file written by its OUTSIDE path while it also has a
   *       workspace name — Seatbelt resolves policy through the vnode's cached
   *       name, so the inverse escape is as plausible as the direct one.
   *
   * The outside files live under $HOME, never under os.tmpdir(): bwrap masks
   * /tmp with a tmpfs, so an outside file there is invisible and a confined
   * `ln` would fail ENOENT before the link syscall — the wrong measurement.
   * Under bwrap $HOME is inside the read-only bind and the workspace a
   * separate bind, so a cross-boundary link(2) is the real EXDEV; on macOS
   * /Users and /private/var/folders share the Data volume, so `ln` can succeed
   * and the Seatbelt question is actually asked.
   *
   * Every assertion is about the WORLD — the bytes of the outside file — never
   * an exit code, and every case prints what it measured, so the CI log of a
   * platform this project has no machine for answers the question. A platform
   * whose row says `unmeasured` prints and asserts nothing: the documentation
   * (ARCHITECTURE §13) is pinned from the log, not guessed.
   */
  it('writes through, or not, a hard link: measured per backend, asserted on the outside file', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    const outside = canonicalPath(mkdtempSync(join(homedir(), '.minidsh-confine-link-')))
    dirs.push(outside)
    const confinement = selectConfinement('auto')
    shell = new ShellProcess('bash', ws, { confinement })
    const policy = policyFor('workspace-write', ws)
    const run = (command: string): Promise<{ exitCode?: number; output: string }> => shell!.exec({ command, policy, timeoutMs: 30_000 })
    const changed = (name: string): boolean => readFileSync(join(outside, name), 'utf8').includes('escaped')
    const plant = (name: string, link: string): void => {
      writeFileSync(join(outside, name), 'original\n')
      try {
        linkSync(join(outside, name), join(ws, link))
      } catch (error) {
        throw new Error(`this host cannot hard-link ${outside} into ${ws} (${(error as NodeJS.ErrnoException).code}); the measurement needs one filesystem`, { cause: error })
      }
    }

    // (1) a pre-existing link, made unconfined, written through by the confined shell.
    plant('t1', 'link1')
    const one = await run(`echo escaped >> ${JSON.stringify(join(ws, 'link1'))}`)
    // (2) the confined shell creates the link itself, then writes through it.
    writeFileSync(join(outside, 't2'), 'original\n')
    const two = await run(`ln ${JSON.stringify(join(outside, 't2'))} ${JSON.stringify(join(ws, 'link2'))} 2>&1 && echo escaped >> ${JSON.stringify(join(ws, 'link2'))}`)
    // (3) the outside path of a file that also has a workspace name.
    plant('t3', 'alias3')
    const three = await run(`echo escaped >> ${JSON.stringify(join(outside, 't3'))} 2>&1`)

    const measured = { preExisting: changed('t1'), created: changed('t2'), outsidePath: changed('t3') }
    const detail = (result: { exitCode?: number; output: string }): string =>
      `exit ${result.exitCode ?? 'none'}${result.output.trim().length > 0 ? `: ${result.output.trim().slice(0, 160)}` : ''}`
    const version = process.platform === 'darwin' ? spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim() : release()
    const label = `${process.platform}/${confinement.id} (${version})`
    const report =
      `[confine] hard links on ${label}\n` +
      `  (1) write through a pre-existing link: outside file ${measured.preExisting ? 'CHANGED' : 'unchanged'}; ${detail(one)}\n` +
      `  (2) link created by the confined command, then written: outside file ${measured.created ? 'CHANGED' : 'unchanged'}; ${detail(two)}\n` +
      `  (3) outside path of a file that also has a workspace name: outside file ${measured.outsidePath ? 'CHANGED' : 'unchanged'}; ${detail(three)}`
    reportMeasurement(report)

    const expected = HARD_LINK_ESCAPES[process.platform]
    for (const key of ['preExisting', 'created', 'outsidePath'] as const) {
      const claim = expected?.[key]
      if (claim === undefined || claim === 'unmeasured') continue
      expect(measured[key], `${key} on ${label}: ARCHITECTURE §13 says ${claim ? 'the write reaches the outside inode' : 'no host file changes'}\n${report}`).toBe(claim)
    }
  })

  it('still refuses when the composition pins a host with no backend', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    shell = new ShellProcess('bash', ws, { confinement: NO_CONFINEMENT })
    await expect(shell.exec({ command: 'echo hi', policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
  })
})

describe.skipIf(!installed || process.platform !== 'linux')('the bwrap ceiling', () => {
  it('points TMPDIR at the writable temp the profile actually granted', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    // A host whose TMPDIR is outside the ceiling (pam_tmpdir, TMPDIR=$HOME/tmp)
    // would otherwise send every mktemp and every spooled here-document at a
    // path the sandbox correctly refuses, while the private tmpfs it was given
    // went unused. Nothing is widened: this is the mount the profile made.
    const result = await shell.exec({
      command: 'echo "$TMPDIR"; f=$(mktemp) && echo "$f" && echo ok > "$f" && cat "$f"',
      policy: policyFor('workspace-write', ws),
      timeoutMs: 30_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('/tmp')
    expect(result.output).toContain('ok')
    // And it went nowhere on the host: the ceiling still describes every host
    // file that can change.
    const leaked = result.output
      .split(NEWLINE)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/tmp/'))
    for (const path of leaked) expect(existsSync(path), `${path} reached the host`).toBe(false)
  })

  it('grants no writable temp under read-only, because read-only means none', () => {
    const confinement = selectConfinement('auto')
    expect(confinement.envFor(policyFor('read-only', '/ws'))).toBeUndefined()
    expect(confinement.envFor(policyFor('workspace-write', '/ws'))).toEqual({ TMPDIR: '/tmp' })
    // Not confined at all: the caller's own environment, untouched.
    expect(confinement.envFor(policyFor('danger-full-access', '/ws'))).toBeUndefined()
  })

  it('gives the sandbox a PRIVATE /tmp: the write succeeds and the host temp directory is untouched', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    // `/tmp` literally, NOT os.tmpdir(): the mount the profile makes is
    // `--tmpfs /tmp`, and on a host whose TMPDIR points elsewhere
    // (TMPDIR=$HOME/tmp) the canary would land in the read-only bind instead —
    // the write would be refused, the ceiling would have held, and this test
    // would fail for saying the wrong thing about where the tmpfs is.
    const canary = join('/tmp', 'minidsh-confine-tmpfs-canary.txt')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const result = await shell.exec({ command: writeInto(canary), policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })
    // It may well succeed — into a tmpfs that dies with the shell. What the
    // ceiling promises is not that the write fails, but that no HOST file
    // outside it changes, and that is what is asserted.
    expect(result.exitCode).toBe(0)
    expect(existsSync(canary)).toBe(false)
  })
})
