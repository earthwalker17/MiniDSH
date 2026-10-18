/**
 * Starting one browser for one agent: a private profile, the fence, the pipe.
 *
 * What a launch guarantees before it returns, or it returns nothing:
 *
 *   1. **A private, fresh profile.** A new directory under the deployment's
 *      `profileRoot` (`app/home.ts`), with an `owner.json` naming this host
 *      and process, so a later launch can sweep the profiles a killed host
 *      left behind (`sweepProfiles`: the lease rule — same host, provably
 *      dead pid). Chrome 136+ honours the debugging pipe only with a
 *      non-default `--user-data-dir`, which this always is.
 *   2. **The pipe, never a port.** `--remote-debugging-pipe` on fds 3 and 4;
 *      no `--remote-debugging-port` is ever passed and none can be configured.
 *      Measured: no `DevToolsActivePort` file is written, and the browser
 *      closes itself ~0.1 s after its parent dies (pipe EOF), on Windows and
 *      Linux.
 *   3. **The environment rule** every harness spawner shares
 *      (`core/process.ts`): declared credentials and `MINIDSH_*` withheld.
 *   4. **Downloads denied** browser-wide (`Browser.setDownloadBehavior`):
 *      measured, a download is cancelled and lands neither in the profile nor
 *      in `~/Downloads`.
 *   5. **The fence, proved.** The canary request must reach this process's
 *      own listener (`fence.ts`); otherwise the browser is killed and the
 *      launch refused `BROWSER_FENCE_UNAVAILABLE`.
 *
 * Chrome's own renderer sandbox stays on: `--no-sandbox` is never passed. A
 * host whose sandbox cannot start fails here, and says why.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { childEnvironment, killAndWait } from '../../core/process.ts'
import { CdpConnection } from './cdp.ts'
import { BrowserError } from './errors.ts'
import { bypassList, CANARY_HOST, CANARY_TLS_HOST, Fence, hostResolverRules } from './fence.ts'

export interface LaunchOptions {
  readonly executablePath: string
  /** Where profiles live; one fresh directory per launch beneath it. */
  readonly profileRoot: string
  readonly headless: boolean
  readonly allowHosts: readonly string[]
  /** The credential names to withhold from the browser's environment (`ctx.credentials`). */
  readonly declared: readonly string[]
  readonly window: { readonly width: number; readonly height: number }
  /** How long the browser may take to answer its first command. Default 30 s. */
  readonly startTimeoutMs?: number
  /**
   * A diagnostic for TESTS: Chrome's own network log, which is how a DNS lookup
   * can be seen at all. Never reachable from row config (`index.ts` does not
   * pass it), and it adds a file, not a reach.
   */
  readonly netLogPath?: string
}

export interface LaunchedBrowser {
  readonly cdp: CdpConnection
  readonly pid: number | undefined
  readonly profileDir: string
  readonly fence: Fence
  /** Product and version, as the browser reports them (`Chrome/155.0…`). */
  readonly product: string
  /** True once the process is gone, for whatever reason. */
  readonly exited: boolean
  /** Graceful close, then a tree kill, then the profile removed. Idempotent; never rejects. */
  close(): Promise<void>
}

/**
 * The switches, beyond the pipe, profile and fence. Each is one Playwright and
 * Puppeteer both pass for an automation profile: isolation (no sync, no
 * extensions, no first-run or default-browser prompts, a mock keychain),
 * quiet (no background networking, component updates, crash uploads), and
 * determinism (no background throttling, one colour profile, a fixed language).
 */
const SWITCHES = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-search-engine-choice-screen',
  '--no-service-autorun',
  '--edge-skip-compat-layer-relaunch',
  '--disable-features=Translate,MediaRouter,OptimizationHints,LensOverlay,AcceptCHFrame',
  '--force-color-profile=srgb',
  '--mute-audio',
  '--lang=en-US',
]

/**
 * Bounds a browser that never answers (a session bus that accepts and never
 * replies wedges any Chromium's start, measured), not a slow one: Edge's cold
 * first start on a fresh ubuntu-latest VM took 19–32 s, working throughout
 * (its verbose log has no silence over 2.5 s; 2026-10-19). 30 s cut it off.
 */
const START_TIMEOUT_MS = 60_000
const CANARY_TIMEOUT_MS = 10_000

export async function launchBrowser(options: LaunchOptions): Promise<LaunchedBrowser> {
  mkdirSync(options.profileRoot, { recursive: true })
  await sweepProfiles(options.profileRoot)
  let profileDir: string | undefined
  try {
    profileDir = mkdtempSync(join(options.profileRoot, 'p-'))
    writeFileSync(join(profileDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() }))
    // The WebRTC rule lives in the profile because Chrome reads it only there:
    // the matching command-line switch was measured to change nothing.
    mkdirSync(join(profileDir, 'Default'), { recursive: true })
    writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({ webrtc: { ip_handling_policy: 'disable_non_proxied_udp' } }))
  } catch (error) {
    if (profileDir !== undefined) await removeProfile(profileDir)
    throw new BrowserError('BROWSER_UNAVAILABLE', `the browser's profile could not be made under ${options.profileRoot}: ${messageOf(error)}`)
  }
  const profile = profileDir

  let fence: Fence
  try {
    fence = await Fence.start()
  } catch (error) {
    await removeProfile(profile)
    throw new BrowserError('BROWSER_UNAVAILABLE', `the browser's network fence could not listen: ${messageOf(error)}`)
  }

  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    `--proxy-server=http://127.0.0.1:${fence.port}`,
    `--proxy-bypass-list=${bypassList(options.allowHosts)}`,
    `--host-resolver-rules=${hostResolverRules(options.allowHosts)}`,
    `--window-size=${options.window.width},${options.window.height}`,
    ...SWITCHES,
    ...(options.headless ? ['--headless', '--hide-scrollbars'] : []),
    ...(options.netLogPath === undefined ? [] : [`--log-net-log=${options.netLogPath}`, '--net-log-capture-mode=Everything']),
    'about:blank',
  ]
  let child: ChildProcess
  try {
    child = spawn(options.executablePath, args, {
      // stdout is ignored, never inherited: a `minidsh serve` speaks JSON-RPC
      // on its own stdout, and a browser line there would corrupt the wire.
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: childEnvironment(options.declared, undefined),
      // POSIX: its own process group, so a tree kill reaches its children.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  } catch (error) {
    await fence.close()
    await removeProfile(profile)
    throw new BrowserError('BROWSER_UNAVAILABLE', `could not start ${options.executablePath}: ${messageOf(error)}`, { hostFault: isMissing(error) })
  }
  // FIRST, before anything reads the child: a spawn the OS refused (ENOENT,
  // EACCES, and EMFILE when this process is out of descriptors) returns a child
  // with no pipes and emits 'error' on the next tick, and an unheard 'error'
  // takes the whole host down (measured under `ulimit -n`, the review).
  let spawnError: Error | undefined
  child.on('error', (error) => {
    spawnError ??= error
  })
  const toBrowser = child.stdio[3]
  const fromBrowser = child.stdio[4]
  if (toBrowser === null || toBrowser === undefined || fromBrowser === null || fromBrowser === undefined) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await fence.close()
    await removeProfile(profile)
    throw new BrowserError('BROWSER_UNAVAILABLE', `could not start ${options.executablePath}: ${spawnError?.message ?? 'the process has no pipes'}`, { hostFault: isMissing(spawnError) })
  }

  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-16_384)
  })
  child.stderr?.on('error', () => {})
  const cdp = new CdpConnection(toBrowser as Writable, fromBrowser as Readable)
  let exited = false
  const gone = new Promise<void>((resolve) => {
    const done = (reason: string): void => {
      exited = true
      cdp.close(reason)
      resolve()
    }
    child.once('exit', (code, signal) => done(`the browser exited (${signal ?? `code ${code}`})`))
    child.once('error', (error) => done(`the browser could not run: ${error.message}`))
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (!exited) {
        await cdp.send('Browser.close', {}, { timeoutMs: 2_000 }).catch(() => undefined)
        await Promise.race([gone, sleep(3_000)])
      }
      // A browser that would not close politely: the tree kill, bounded
      // (`core/process.ts`), then the exit itself, bounded again — on a loaded
      // Windows host the process record can trail the kill by seconds, and the
      // profile cannot go while the browser still holds it. Worst case ~25 s
      // (the removal retries included); an ordinary close is a few hundred
      // milliseconds. The waits never hold the event loop open: a `minidsh
      // run` that is done exits without waiting out a timer.
      if (!exited) {
        await killAndWait(child)
        await Promise.race([gone, sleep(5_000)])
      }
      cdp.close('closed by its owner')
      await fence.close()
      await removeProfile(profile)
    })()
    return closing
  }

  try {
    const version = await cdp.send<{ product: string }>('Browser.getVersion', {}, { timeoutMs: options.startTimeoutMs ?? START_TIMEOUT_MS })
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true })
    await proveFence(cdp, fence)
    return {
      cdp,
      pid: child.pid,
      profileDir: profile,
      fence,
      product: version.product,
      get exited() {
        return exited
      },
      close,
    }
  } catch (error) {
    const tail = stderr
    await close()
    if (error instanceof BrowserError && error.code === 'BROWSER_FENCE_UNAVAILABLE') throw error
    const known = remedy(tail)
    // On Windows a missing executable still gets its pipes, and the spawn's
    // 'error' arrives while the first command waits: that error is the cause.
    throw new BrowserError('BROWSER_UNAVAILABLE', `${options.executablePath} did not start: ${spawnError?.message ?? messageOf(error)}${known.text}`, {
      hostFault: known.hostFault || isMissing(spawnError),
    })
  }
}

/**
 * The canary: pages asked to load two `.invalid` hosts — one over plain HTTP,
 * one over TLS, the two paths a proxy setting can treat differently — must
 * both reach THIS process's listener. If either does not, something replaced
 * the proxy (an enterprise policy, a PAC script) or the browser went direct,
 * and the fence is not in force. A fact about the host, so remembered.
 */
async function proveFence(cdp: CdpConnection, fence: Fence): Promise<void> {
  const targets: string[] = []
  for (const url of [`http://${CANARY_HOST}/`, `https://${CANARY_TLS_HOST}/`]) {
    targets.push((await cdp.send<{ targetId: string }>('Target.createTarget', { url })).targetId)
  }
  const held = (await Promise.all([fence.waitFor(CANARY_HOST, CANARY_TIMEOUT_MS), fence.waitFor(CANARY_TLS_HOST, CANARY_TIMEOUT_MS)])).every(Boolean)
  for (const targetId of targets) await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  if (!held) {
    throw new BrowserError(
      'BROWSER_FENCE_UNAVAILABLE',
      `this browser's traffic does not go through MiniDSH's network fence (a proxy policy on this machine may override it), so it is not used`,
      { hostFault: true },
    )
  }
}

/** What a failed start's stderr says, turned into the remedy a person can act on, and whether it is the host's. */
export function remedy(stderr: string): { readonly text: string; readonly hostFault: boolean } {
  // The second form is Edge on a stock Ubuntu 24.04 (ubuntu-latest, measured
  // 2026-10-19): user namespaces restricted, and its setuid helper not setuid.
  if (/no usable sandbox|SUID sandbox helper binary was found, but is not configured correctly/i.test(stderr)) {
    return { text: `. Chrome's sandbox could not start on this host (unprivileged user namespaces are restricted); fix the host, never run it with --no-sandbox`, hostFault: true }
  }
  if (/running as root without --no-sandbox/i.test(stderr)) return { text: '. Chrome refuses to run as root with its sandbox on; run MiniDSH as an ordinary user', hostFault: true }
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
  return { text: lines.length === 0 ? '' : `. Its last words: ${lines.slice(-3).join(' | ').slice(0, 600)}`, hostFault: false }
}

/** A spawn refused because the executable is not there or not runnable: the host's, every time. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC' || code === 'EPERM'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Remove the profiles a dead harness on THIS host left behind: the lease rule
 * (`persistence-jsonl`), never a guess. A profile without an owner file is one
 * whose launch died between creating it and writing the file; it goes once a
 * day old. Every removal swallows its own error: a profile some live browser
 * still holds open on Windows is busy, and that is not this launch's problem.
 */
export async function sweepProfiles(root: string): Promise<void> {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  const here = hostname()
  for (const entry of entries) {
    if (!entry.startsWith('p-')) continue
    const dir = join(root, entry)
    let stale = false
    try {
      const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as { pid?: unknown; host?: unknown }
      stale = owner.host === here && typeof owner.pid === 'number' && !alive(owner.pid)
    } catch {
      try {
        stale = Date.now() - statSync(dir).mtimeMs > 24 * 60 * 60 * 1000
      } catch {
        stale = false
      }
    }
    if (stale) await removeProfile(dir)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, and someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function removeProfile(dir: string): Promise<void> {
  // Windows: a browser's child processes can hold profile files for a moment
  // after the root exits, so the removal retries before giving up quietly.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined)
}

/** A wait that never keeps the process alive by itself (`close` races these against the exit). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref())
