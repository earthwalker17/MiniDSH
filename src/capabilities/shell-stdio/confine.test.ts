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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  it('never drops --unshare-pid, which is what stops a procfs magic link leaving the bind', () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      expect(bwrapArgs(policyFor(mode, '/ws'))).toContain('--unshare-pid')
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

  it('still refuses when the composition pins a host with no backend', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    shell = new ShellProcess('bash', ws, { confinement: NO_CONFINEMENT })
    await expect(shell.exec({ command: 'echo hi', policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    })
  })
})

describe.skipIf(!installed || process.platform !== 'linux')('the bwrap ceiling', () => {
  it('gives the sandbox a PRIVATE /tmp: the write succeeds and the host temp directory is untouched', async () => {
    const ws = tempDir('minidsh-confine-ws-')
    const canary = join(tmpdir(), 'minidsh-confine-tmpfs-canary.txt')
    shell = new ShellProcess('bash', ws, { confinement: selectConfinement('auto') })
    const result = await shell.exec({ command: writeInto(canary), policy: policyFor('workspace-write', ws), timeoutMs: 30_000 })
    // It may well succeed — into a tmpfs that dies with the shell. What the
    // ceiling promises is not that the write fails, but that no HOST file
    // outside it changes, and that is what is asserted.
    expect(result.exitCode).toBe(0)
    expect(existsSync(canary)).toBe(false)
  })
})
