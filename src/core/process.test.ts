/**
 * The rules every harness spawner shares. The environment rule's own cases
 * are pinned beside the shell that first needed them (`shell.test.ts`,
 * `composition.test.ts`); here, what a second spawner relies on: a refused
 * spawn is an answer and never a crash, the tree dies with its root, and the
 * wait returns only once it has.
 */
import { ChildProcess, spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ShellProcess } from '../capabilities/shell-stdio/process.ts'
import { launchBrowser } from '../capabilities/tool-browser/launch.ts'
import { childEnvironment, killAndWait, spawnChild, spawnRefusal, type Spawner } from './process.ts'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('core/process', () => {
  it('withholds the declared names and MINIDSH_*, and lets the caller overlay win', () => {
    process.env.MINIDSH_PROCESS_TEST = 'harness-own'
    process.env.PROCESS_TEST_DECLARED = 'secret'
    try {
      const env = childEnvironment(['PROCESS_TEST_DECLARED'], { EXTRA: 'added' })
      expect(env.MINIDSH_PROCESS_TEST).toBeUndefined()
      expect(env.PROCESS_TEST_DECLARED).toBeUndefined()
      expect(env.EXTRA).toBe('added')
      expect(env.PATH ?? env.Path).toBeDefined()
    } finally {
      delete process.env.MINIDSH_PROCESS_TEST
      delete process.env.PROCESS_TEST_DECLARED
    }
  })

  it('kills a child AND the process it started, waiting for the root and its killer', { timeout: 60_000 }, async () => {
    // The root prints its grandchild's pid, then idles. On POSIX it leads its
    // own group (`detached`), which is what lets one signal reach the tree.
    const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)`
    const root = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true })
    const grandchild = await new Promise<number>((resolve, reject) => {
      let out = ''
      root.stdout!.on('data', (chunk) => {
        out += chunk
        const match = out.match(/(\d+)\s/)
        if (match) resolve(Number(match[1]))
      })
      root.once('exit', () => reject(new Error(`root exited before reporting its child; it printed ${JSON.stringify(out)}`)))
    })
    expect(alive(grandchild)).toBe(true)
    await killAndWait(root)
    expect(root.exitCode !== null || root.signalCode !== null).toBe(true)
    // The grandchild's death is asynchronous to the root's on every platform:
    // poll briefly, and say what it was waiting on if it never came.
    const deadline = Date.now() + 10_000
    while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(alive(grandchild), `grandchild ${grandchild} outlived its root's tree kill`).toBe(false)
  })
})

describe('starting a child (spawnChild)', () => {
  /** Node 24 out of descriptors, exactly: a returned child with no pid and no pipes, and EMFILE a tick later. */
  const outOfDescriptors: Spawner = (command) => {
    const child = new ChildProcess()
    process.nextTick(() => child.emit('error', Object.assign(new Error(`spawn ${command} EMFILE`), { code: 'EMFILE', errno: -24, syscall: `spawn ${command}` })))
    return child
  }

  it('treats a child with no pipes as never spawned, and rejects with the error that follows it', async () => {
    const { child, spawned } = spawnChild('anything', [], { stdio: 'pipe' }, outOfDescriptors)
    expect(child.pid).toBeUndefined()
    const error = await spawned.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: 'EMFILE' })
    expect(spawnRefusal(error)).toBe('transient')
    // Nothing to wait for: a child with no pid never became a process.
    const started = Date.now()
    await killAndWait(child)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('gives a spawn Node refuses synchronously the same shape: no pid, no pipes, a rejection', async () => {
    const { child, spawned } = spawnChild(process.execPath, ['a\0b'], { stdio: 'pipe' })
    expect(child.pid).toBeUndefined()
    expect(child.stdio).toBeUndefined()
    await expect(spawned).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('tells a moment from a missing binary', async () => {
    const missing = spawnChild(join(tmpdir(), 'minidsh-no-such-binary'), [], { stdio: 'pipe' })
    const error = await missing.spawned.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(spawnRefusal(error)).toBe('missing')
    for (const code of ['EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM']) expect(spawnRefusal({ code })).toBe('transient')
    expect(spawnRefusal({ code: 'EACCES' })).toBe('missing')
    expect(spawnRefusal(new Error('no code'))).toBe('other')
  })

  /**
   * The pipe half: a write still queued when the child dies raises EPIPE on
   * POSIX and `write EOF` on Windows. Without a listener it crashed the host
   * (the persistent shell's stdin, cancelled while pwsh was starting).
   */
  it('hears what a dying child does to its pipes, so nothing escapes into the host', async () => {
    const { child, spawned } = spawnChild(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'pipe', windowsHide: true })
    await spawned
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stdin!.write('x'.repeat(4 * 1024 * 1024))
    await exited
    // Long enough for the failed write to have surfaced, had it been unheard.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(child.exitCode).toBe(0)
  })
})

/**
 * The real thing, where the platform lets a test do it: this process opens
 * `/dev/null` until the kernel says EMFILE, then asks for every kind of child
 * the harness starts. Each must be a coded refusal, and the process must
 * survive — an unheard 'error' here is an uncaught exception that fails this
 * file. Windows has no per-process descriptor limit to reach; the staged
 * shape (above, `shell.test.ts`, `launch.test.ts`) runs everywhere.
 */
describe.runIf(process.platform !== 'win32')('a host really out of descriptors', () => {
  /**
   * Node raises its soft descriptor limit to the hard one at start, which is
   * 1,048,576 under WSL 2: opening that many took 10 s and a quarter-gigabyte
   * of kernel memory (measured). Where Linux's `prlimit` can lower a running
   * process's soft limit, the test lowers its own first and restores it after;
   * elsewhere (macOS) it exhausts what it has. The kernel's answer is the same.
   */
  function lowerDescriptorLimit(to: number): () => void {
    const pid = String(process.pid)
    const read = spawnSync('prlimit', ['--pid', pid, '--nofile', '--output=SOFT', '--noheadings'], { encoding: 'utf8' })
    const soft = read.status === 0 ? read.stdout.trim() : ''
    if (!/^\d+$/.test(soft) || Number(soft) <= to) return () => {}
    if (spawnSync('prlimit', ['--pid', pid, `--nofile=${to}:`]).status !== 0) return () => {}
    return () => void spawnSync('prlimit', ['--pid', pid, `--nofile=${soft}:`])
  }

  it('refuses the shell, a one-shot, a job and the browser with a code, and lives on', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minidsh-emfile-'))
    const profileRoot = mkdtempSync(join(tmpdir(), 'minidsh-emfile-profiles-'))
    const shell = new ShellProcess('bash', dir)
    const policy = { mode: 'danger-full-access', workspaceRoot: dir } as const
    const held: number[] = []
    let exhausted: unknown
    let shellRefusals: unknown[] = []
    let browserRefusal: unknown
    const restoreLimit = lowerDescriptorLimit(4_096)
    try {
      try {
        for (;;) held.push(openSync('/dev/null', 'r'))
      } catch (error) {
        exhausted = error
      }
      const attempt = (work: Promise<unknown>): Promise<unknown> => work.then(() => 'it ran', (error: unknown) => error)
      shellRefusals = await Promise.all([
        attempt(shell.exec({ command: 'echo hi', policy, timeoutMs: 30_000 })),
        attempt(shell.exec({ command: 'echo hi', policy, oneShot: true, timeoutMs: 30_000 })),
        attempt(shell.start({ command: 'echo hi', policy, output: () => {} })),
      ])
      // The launch writes its profile and opens the fence's listener before it
      // spawns: room for those, never for the browser's three pipes.
      for (let i = 0; i < 3; i++) closeSync(held.pop()!)
      browserRefusal = await attempt(
        launchBrowser({ executablePath: process.execPath, profileRoot, headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 }, startTimeoutMs: 5_000 }),
      )
    } finally {
      for (const fd of held) closeSync(fd)
      restoreLimit()
    }
    expect((exhausted as NodeJS.ErrnoException).code).toMatch(/^E[MN]FILE$/)
    for (const refusal of shellRefusals) {
      expect(refusal).toMatchObject({ code: 'SHELL_UNAVAILABLE', message: expect.stringMatching(/E[MN]FILE/) })
      expect((refusal as Error).message).not.toMatch(/install/i)
    }
    expect(browserRefusal).toMatchObject({ code: 'BROWSER_UNAVAILABLE', hostFault: false, message: expect.stringMatching(/E[MN]FILE/) })
    expect(readdirSync(profileRoot), 'the refused launch left its profile').toEqual([])
    // The moment passed, and nothing remembered it: the same shell runs now.
    const ran = await shell.exec({ command: 'echo back', policy, timeoutMs: 30_000 })
    expect(ran.output).toContain('back')
    await shell.dispose()
    rmSync(dir, { recursive: true, force: true })
    rmSync(profileRoot, { recursive: true, force: true })
  })
})
