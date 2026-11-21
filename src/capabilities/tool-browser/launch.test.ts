/**
 * A real browser, launched as `tool-browser` launches it: the pipe, the
 * profile, the fence and the ways a browser goes away. Raw CDP drives the page
 * here, so these hold without the page model above them.
 *
 * Self-skips where no Chrome, Edge or Chromium is installed; under
 * `MINIDSH_EXPECT_BROWSER=1` that is a failure (`expectBrowserSuite`).
 */
import { ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Spawner } from '../../core/process.ts'
import { browsersUsing, everyTestBrowser, expectBrowserSuite, fixtureServer, testBrowser, type FixtureServer } from '../../test-support/browser-fixture.ts'
import { CdpConnection } from './cdp.ts'
import { BrowserError } from './errors.ts'
import { CANARY_HOST, CANARY_TLS_HOST, Fence, FENCE_HEADER } from './fence.ts'
import { launchBrowser, proveFence, remedy, sweepProfiles, type LaunchedBrowser } from './launch.ts'
import { candidates, locateBrowser } from './locate.ts'

expectBrowserSuite('tool-browser launch')

/** Above the launch's own 120 s bound, so a start that fails says why instead of timing the test out. */
const LONG = { timeout: 240_000 }
const dirs: string[] = []
const browsers: LaunchedBrowser[] = []
afterAll(async () => {
  for (const browser of browsers) await browser.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}, 240_000)

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  return test()
}

async function launch(executablePath: string, allowHosts: readonly string[] = []): Promise<LaunchedBrowser> {
  const browser = await launchBrowser({ executablePath, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts, declared: [], window: { width: 1280, height: 800 } })
  browsers.push(browser)
  return browser
}

/** One page, attached flat, with the domains a navigation report needs. */
async function page(cdp: CdpConnection): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, { sessionId })
  await cdp.send('Network.enable', {}, { sessionId })
  return sessionId
}

interface Landing {
  readonly errorText?: string
  readonly status?: number
  readonly fenced: boolean
}

/** Navigate and report how the main document came back: the browser's own error, or a response and whether the fence wrote it. */
async function land(cdp: CdpConnection, sessionId: string, url: string): Promise<Landing> {
  let response: { status: number; headers: Record<string, string> } | undefined
  let loaded!: () => void
  const load = new Promise<void>((resolve) => (loaded = resolve))
  const off = cdp.onEvent((event) => {
    if (event.sessionId !== sessionId) return
    if (event.method === 'Network.responseReceived' && (event.params as { type?: string }).type === 'Document') {
      response = (event.params as { response: { status: number; headers: Record<string, string> } }).response
    }
    if (event.method === 'Page.loadEventFired') loaded()
  })
  try {
    const result = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, { sessionId })
    if (result.errorText !== undefined) return { errorText: result.errorText, fenced: false }
    await Promise.race([load, new Promise((resolve) => setTimeout(resolve, 15_000))])
    const headers = Object.fromEntries(Object.entries(response?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
    return { ...(response === undefined ? {} : { status: response.status }), fenced: headers[FENCE_HEADER] === 'denied' }
  } finally {
    off()
  }
}

describe('locating a browser', () => {
  it('knows each platform’s install places, Chrome first, and never a snap', () => {
    const windows = candidates('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, 'C:\\Users\\u')
    expect(windows[0]!.kind).toBe('chrome')
    expect(windows.map((candidate) => candidate.kind)).toEqual(['chrome', 'chrome', 'edge', 'edge', 'chromium', 'chromium'])
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(candidates(platform, {}, '/home/u').some((candidate) => candidate.path.includes('snap'))).toBe(false)
    }
  })

  it('takes a configured path only when it exists, and never falls back past it', () => {
    expect(locateBrowser('/nowhere/chrome', { exists: () => false })).toBeUndefined()
    expect(locateBrowser('/opt/x/msedge', { exists: () => true })).toEqual({ path: '/opt/x/msedge', kind: 'edge' })
  })

  it('names a sandbox the host cannot give as the host’s fault, in both of the forms Chromium says it', () => {
    // As ubuntu-latest's Edge said it, with namespaces restricted and its helper not setuid.
    const suid = "[2211:2211:1018/191257.510711:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:172] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now."
    for (const stderr of [suid, '[1:1:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel']) {
      expect(remedy(stderr)).toEqual({ text: expect.stringContaining('never run it with --no-sandbox'), hostFault: true })
    }
    expect(remedy('[1:1:ERROR:bus.cc] Failed to connect to the bus')).toMatchObject({ hostFault: false })
  })

  it('quotes a failed start’s last words cut between characters, never through one', () => {
    // 'x' then pairs: the 600th unit kept would be the first half of a pair.
    const said = remedy(`x${'😀'.repeat(400)}`).text
    expect(said.isWellFormed(), `the quote ends in ${JSON.stringify(said.slice(-3))}`).toBe(true)
    expect(said.endsWith(`x${'😀'.repeat(299)}`), `the quote ends in ${JSON.stringify(said.slice(-6))}`).toBe(true)
  })
})

/**
 * The other end of the same quote: only the last 16 KB of what a starting
 * browser said is kept, and that cut is by length too. Staged, because the
 * line must be longer than the bound and end the start: a child whose pipes
 * are this test's, which says its piece and exits.
 */
describe('a browser that dies while starting', () => {
  it('keeps the end of what it said from a whole character on', async () => {
    // Pairs then one unit: an odd length, so the last 16,384 units begin on a second half.
    const said = `${'😀'.repeat(9_000)}z`
    const dying: Spawner = () => {
      const child = new ChildProcess()
      const errors = new PassThrough()
      ;(child as { stdio: unknown }).stdio = [null, null, errors, new PassThrough(), new PassThrough()]
      process.nextTick(() => {
        child.emit('spawn')
        // After the launch has started listening (it does on 'spawn'), and
        // the exit only once the launch has read what was said.
        setImmediate(() => {
          errors.once('data', () => setImmediate(() => child.emit('exit', 1, null)))
          errors.write(said)
        })
      })
      return child
    }
    const root = tempDir('minidsh-profiles-')
    const error = await launchBrowser({ executablePath: process.execPath, profileRoot: root, headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 }, spawner: dying }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: 'BROWSER_UNAVAILABLE', hostFault: false, message: expect.stringContaining('Its last words: 😀') })
    const message = (error as Error).message
    expect(message.isWellFormed(), `the quote begins ${JSON.stringify(message.slice(message.indexOf('Its last words: ') + 16, message.indexOf('Its last words: ') + 19))}`).toBe(true)
    expect(readdirSync(root)).toEqual([])
  })
})

/**
 * Node 24's own answer to a spawn when this process is out of descriptors,
 * staged exactly (no browser needed): `spawn` RETURNS a child whose pid and
 * stdio are undefined, and the EMFILE `'error'` follows on the next tick. The
 * launch read `child.stdio[3]` first and threw an uncoded TypeError past the
 * guard meant for this, leaking the fence's listener — another descriptor —
 * and the profile, on every later call. The real exhaustion is
 * `core/process.test.ts`'s, on POSIX.
 */
/** The child Node hands back when a spawn meets EMFILE: no pid, no pipes, and the refusal on the next tick. */
function refusedChild(command: string): ChildProcess {
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

describe('a launch on a host out of descriptors', () => {
  it('refuses with a code, as a moment and never a host fault, leaving no profile and no listener behind', async () => {
    const root = tempDir('minidsh-profiles-')
    let fencePort: number | undefined
    const outOfDescriptors: Spawner = (command, args) => {
      fencePort = Number(/--proxy-server=http:\/\/127\.0\.0\.1:(\d+)/.exec(args.join(' '))?.[1])
      return refusedChild(command)
    }
    const error = await launchBrowser({ executablePath: process.execPath, profileRoot: root, headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 }, spawner: outOfDescriptors }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BrowserError)
    // Not remembered (`index.ts` keeps only a host fault), so the next call tries again.
    expect(error).toMatchObject({ code: 'BROWSER_UNAVAILABLE', hostFault: false, message: expect.stringContaining('out of file descriptors or processes') })
    expect(readdirSync(root)).toEqual([])
    expect(fencePort, 'the staged spawn never saw the fence port').toBeGreaterThan(0)
    const refused = await new Promise<boolean>((resolve) => {
      const probe = connect(fencePort!, '127.0.0.1')
      probe.once('connect', () => {
        probe.destroy()
        resolve(false)
      })
      probe.once('error', () => resolve(true))
    })
    expect(refused, "the fence's listener outlived the refused launch").toBe(true)
  })
})

/**
 * Guarantee 3 of a launch, for THIS spawner: the shell's use of the shared
 * rule is tested where the shell is, and that says nothing about what the
 * browser's process tree is handed. Read off the spawn itself (no browser
 * needed): a launch that passed `process.env` on would hand every provider
 * key to Chrome and whatever a page makes it start.
 */
describe('the environment a launch hands the browser', () => {
  it('is built, never inherited: a declared credential and every MINIDSH_ variable are withheld, an ordinary variable is the user’s', async () => {
    const declared = 'BROWSER_ENV_TEST_DECLARED_KEY'
    const internal = 'MINIDSH_BROWSER_ENV_TEST'
    const ordinary = 'BROWSER_ENV_TEST_ORDINARY'
    const saved = [declared, internal, ordinary].map((name) => [name, process.env[name]] as const)
    process.env[declared] = 'declared-secret-value'
    process.env[internal] = 'harness-internal-value'
    process.env[ordinary] = 'ordinary-value'
    let handed: NodeJS.ProcessEnv | undefined
    const capturing: Spawner = (command, _args, options) => {
      // A copy, taken now: an inherited environment IS `process.env`, and
      // would read clean again once this test has put the variables back.
      handed = { ...options.env }
      return refusedChild(command)
    }
    try {
      await launchBrowser({ executablePath: process.execPath, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [], declared: [declared], window: { width: 800, height: 600 }, spawner: capturing }).catch(
        () => undefined,
      )
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    expect(handed, 'the staged spawn was never asked, so nothing was checked').toBeDefined()
    const withheld = Object.entries(handed!).filter(([name]) => name.toUpperCase() === declared || name.toUpperCase().startsWith('MINIDSH_'))
    expect(withheld.map(([name]) => name), 'names the browser must not be handed').toEqual([])
    expect(Object.values(handed!), 'a withheld value reached the browser under another name').not.toEqual(expect.arrayContaining(['declared-secret-value']))
    expect(handed![ordinary]).toBe('ordinary-value')
  })
})

/** A browser that is only its answers: the proof's commands over the pipe's own framing, `Page.navigate` answered as the test says (`undefined`: never). */
function stagedBrowser(navigate: (url: string) => Record<string, unknown> | undefined | Promise<Record<string, unknown>>): CdpConnection {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  let unread = ''
  let targets = 0
  toBrowser.on('data', (chunk: Buffer) => {
    const parts = (unread + chunk.toString('utf8')).split('\0')
    unread = parts.pop() ?? ''
    for (const part of parts) {
      const message = JSON.parse(part) as { id: number; method: string; params: { url?: string; targetId?: string } }
      const answer = (result: Record<string, unknown>): void => void fromBrowser.write(`${JSON.stringify({ id: message.id, result })}\0`)
      if (message.method === 'Target.createTarget') answer({ targetId: `T${++targets}` })
      else if (message.method === 'Target.attachToTarget') answer({ sessionId: `S-${message.params.targetId}` })
      else if (message.method === 'Page.navigate') {
        void Promise.resolve(navigate(message.params.url ?? '')).then((result) => {
          if (result !== undefined) answer(result)
        })
      } else answer({})
    }
  })
  return new CdpConnection(toBrowser, fromBrowser)
}

/**
 * What the proof concludes from what a canary's navigation said. Staged,
 * because the moments it must not remember cannot be ordered from a real
 * browser (a network that changes mid-launch); the two real outcomes — a
 * canary gone direct, one unfinished at the bound — are the real browser's
 * below.
 */
describe('the fence proof, judged by what each canary showed', () => {
  const judge = async (navigate: Parameters<typeof stagedBrowser>[0], timeoutMs = 5_000): Promise<unknown> => {
    const fence = await Fence.start()
    try {
      return await proveFence(stagedBrowser(navigate), fence, timeoutMs).then(
        () => 'proved',
        (error: unknown) => error,
      )
    } finally {
      await fence.close()
    }
  }

  it('is proved when both canaries reached this process’s listener: the control for the staging', async () => {
    const fence = await Fence.start()
    // What a fenced browser does with each canary: it asks the proxy, which records the host and refuses.
    const throughFence = (url: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const tls = url.startsWith('https:')
        const socket = connect(fence.port, '127.0.0.1', () => socket.write(tls ? `CONNECT ${new URL(url).hostname}:443 HTTP/1.1\r\n\r\n` : `GET ${url} HTTP/1.1\r\n\r\n`))
        socket.on('data', () => {})
        socket.once('error', reject)
        socket.once('close', () => resolve(tls ? { errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' } : {}))
      })
    try {
      await expect(proveFence(stagedBrowser(throughFence), fence, 5_000)).resolves.toBeUndefined()
      expect([CANARY_HOST, CANARY_TLS_HOST].map((host) => fence.saw(host))).toEqual([true, true])
    } finally {
      await fence.close()
    }
  })

  it('remembers a canary that went somewhere else: a document came back, or the browser asked a resolver or another proxy answered', async () => {
    for (const answer of [{}, { errorText: 'net::ERR_NAME_NOT_RESOLVED' }, { errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, { errorText: 'net::ERR_PROXY_AUTH_REQUESTED' }]) {
      expect(await judge(() => answer), JSON.stringify(answer)).toMatchObject({ code: 'BROWSER_FENCE_UNAVAILABLE', hostFault: true })
    }
  })

  it('does not remember a canary that ended early for a reason of the moment, and says to try again', async () => {
    // The last is deliberately a moment: a proxy that could not be REACHED is
    // this process's own on a host out of sockets as much as another's.
    for (const errorText of ['net::ERR_NETWORK_CHANGED', 'net::ERR_ABORTED', 'net::ERR_INSUFFICIENT_RESOURCES', 'net::ERR_PROXY_CONNECTION_FAILED']) {
      const error = await judge(() => ({ errorText }))
      expect(error, errorText).toMatchObject({ code: 'BROWSER_FENCE_UNAVAILABLE', hostFault: false, message: expect.stringContaining('the next call tries again') })
      expect((error as Error).message, 'the reason is said, so a person can see what interrupted it').toContain(errorText)
    }
  })

  it('lets evidence about the host outweigh a moment, and never remembers a canary that only ran out of time', async () => {
    const mixed = await judge((url) => (url.startsWith('https:') ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : { errorText: 'net::ERR_NETWORK_CHANGED' }))
    expect(mixed).toMatchObject({ code: 'BROWSER_FENCE_UNAVAILABLE', hostFault: true })
    const unfinished = await judge(() => undefined, 50)
    expect(unfinished).toMatchObject({ code: 'BROWSER_FENCE_UNAVAILABLE', hostFault: false, message: expect.stringContaining('the next call tries again') })
  })
})

describe.runIf(testBrowser !== undefined)('a launched browser', () => {
  it('speaks over the pipe: no port file, a private owned profile, gone with its profile at close', LONG, async () => {
    const browser = await launch(testBrowser!.path)
    expect(browser.product).toMatch(/^(Chrome|Edg|HeadlessChrome|Chromium)\//)
    expect(existsSync(join(browser.profileDir, 'DevToolsActivePort'))).toBe(false)
    expect(existsSync(join(browser.profileDir, 'owner.json'))).toBe(true)
    const pid = browser.pid!
    await browser.close()
    expect(await until(() => browser.exited, 10_000), 'close returned with the browser still running').toBe(true)
    expect(await until(() => !alive(pid), 10_000), `browser ${pid} outlived its close`).toBe(true)
    expect(existsSync(browser.profileDir)).toBe(false)
    // Idempotent, and quiet after the fact.
    await browser.close()
    await expect(browser.cdp.send('Browser.getVersion')).rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
  })

  // Each canary alone: plain HTTP and TLS are the two roads a proxy setting
  // can treat differently, and a proof that sent only one of them would pass a
  // browser whose other road goes direct.
  it.each([
    ['plain HTTP', CANARY_HOST],
    ['TLS', CANARY_TLS_HOST],
  ])('refuses the launch when the fence cannot be proved for %s, leaving nothing running', LONG, async (road, direct) => {
    // The canary host on the allow list goes DIRECT, so it never reaches the
    // fence: exactly what a proxy policy or a fence that is not in force looks like.
    const root = tempDir('minidsh-profiles-')
    const started = Date.now()
    const error = await launchBrowser({
      executablePath: testBrowser!.path,
      profileRoot: root,
      headless: true,
      allowHosts: [direct],
      declared: [],
      window: { width: 800, height: 600 },
      canaryTimeoutMs: 60_000,
    }).then(
      // A launch that was NOT refused is this test's failure, and a browser to close.
      (launched) => (browsers.push(launched), `launched ${launched.product} although its ${road} canary never reached the fence`),
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: 'BROWSER_FENCE_UNAVAILABLE', hostFault: true })
    // Known from where the canary went, not from waiting out the bound.
    expect(Date.now() - started, 'the refusal waited for the canary bound').toBeLessThan(30_000)
    expect(readdirSync(root)).toEqual([])
    // "Nothing running": no process anywhere still uses a profile under this root.
    expect(await until(() => browsersUsing(root).length === 0, 10_000), `a refused launch left ${browsersUsing(root).join(', ')} running`).toBe(true)
  })

  it('refuses a fence still unproved at the bound as a moment, never as a fact about the host', LONG, async () => {
    // A canary that has not finished proves nothing either way: windows-latest
    // once took over 10 s mid-suite, and remembering that would have switched
    // the browser off for the life of the process.
    const root = tempDir('minidsh-profiles-')
    const error = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: root, headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 }, canaryTimeoutMs: 1 }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: 'BROWSER_FENCE_UNAVAILABLE', hostFault: false, message: expect.stringContaining('the next call tries again') })
    expect(readdirSync(root)).toEqual([])
    expect(await until(() => browsersUsing(root).length === 0, 10_000), `a refused launch left ${browsersUsing(root).join(', ')} running`).toBe(true)
  })

  it('tells a host fault from a moment: no executable is the host, a start that died is not', LONG, async () => {
    const options = { profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 } }
    const missing = await launchBrowser({ ...options, executablePath: join(tempDir('minidsh-nobrowser-'), 'chrome') }).catch((caught: unknown) => caught)
    expect(missing).toMatchObject({ code: 'BROWSER_UNAVAILABLE', hostFault: true })
    // Node is not a browser: it refuses the switches and exits while "starting".
    const died = await launchBrowser({ ...options, executablePath: process.execPath, startTimeoutMs: 15_000 }).catch((caught: unknown) => caught)
    expect(died).toMatchObject({ code: 'BROWSER_UNAVAILABLE', hostFault: false })
    expect(readdirSync(options.profileRoot)).toEqual([])
  })

  it('resolves no name a page hands it: a WebRTC TURN host meets the fence, never a DNS server, however much the name looks like loopback', LONG, async () => {
    const run = `${process.pid}-${Date.now() % 100_000}`
    // Three names, none a substring of another. The last two begin as a
    // loopback ADDRESS does: a resolver rule that is a glob over the host's
    // text (`EXCLUDE 127.*`, which the rules once carried) exempts them with
    // the addresses, and each then reached a DNS transaction (measured).
    const hosts = [`turnt-${run}.example.com`, `127.turnp-${run}.example.com`, `127.0.0.1.turnq-${run}.example.com`]
    const site = await fixtureServer({
      '/': `<title>turn</title><script>(async()=>{for(const host of ${JSON.stringify(hosts)}){const pc=new RTCPeerConnection({iceServers:[{urls:'turn:'+host+':3478?transport=tcp',username:'u',credential:'c'}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer())}})()</script>`,
    })
    const netLogPath = join(tempDir('minidsh-netlog-'), 'net.json')
    const browser = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 }, netLogPath })
    try {
      await browser.cdp.send('Target.createTarget', { url: `${site.origin}/` })
      // Until every attempt is in the log (a fixed 4 s missed it under a full
      // suite's load), then long enough for a resolver to have followed it.
      const tried = (): boolean => {
        try {
          const written = readFileSync(netLogPath, 'utf8')
          return hosts.every((host) => written.includes(host))
        } catch {
          return false
        }
      }
      await until(tried, 20_000)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    } finally {
      await browser.close()
      await site.close()
    }
    const raw = readFileSync(netLogPath, 'utf8')
    const log = JSON.parse(raw.trimEnd().endsWith('}') ? raw : raw.replace(/,?\s*$/, ']}')) as { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: unknown }[] }
    const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
    for (const host of hosts) {
      const naming = log.events.filter((event) => JSON.stringify(event.params ?? {}).includes(host)).map((event) => names.get(event.type) ?? '')
      // The test means something only if the page really tried to reach the host…
      expect(naming.length, `the page never tried ${host} as its TURN host, so this proves nothing about it`).toBeGreaterThan(0)
      // …and the attempt met the proxy, never a resolver (measured: without
      // --host-resolver-rules a DNS transaction carries this name off the machine).
      expect(naming.filter((name) => /DNS|HOST_RESOLVER_.*TASK/.test(name)), `${host} reached a resolver: ${[...new Set(naming)].join(', ')}`).toEqual([])
    }
  })

  /**
   * The other half of the resolver rules: an allowed host goes DIRECT, so it
   * must get a real answer — and a `*.` entry is a glob Chrome has to honour
   * in `EXCLUDE`, or every subdomain it allows resolves to nothing. Measured on
   * Chrome 155 and Edge 156 (Windows, 2026-10-26) by navigation and by TURN:
   * honoured. A TURN host is the clean A/B, because it never meets the proxy:
   * the subdomain the wildcard covers is looked up, its sibling is not.
   */
  it('honours a `*.` allowHosts entry in the resolver rules: the subdomain it covers is looked up, a sibling is not', LONG, async () => {
    const tag = `wild-${process.pid}-${Date.now() % 100_000}`
    const covered = `turn.${tag}.invalid`
    const sibling = `turn.not-${tag}.invalid`
    const site = await fixtureServer({
      '/': `<title>turn</title><script>(async()=>{for(const host of ['${covered}','${sibling}']){const pc=new RTCPeerConnection({iceServers:[{urls:'turn:'+host+':3478?transport=tcp',username:'u',credential:'c'}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer())}})()</script>`,
    })
    const netLogPath = join(tempDir('minidsh-netlog-'), 'net.json')
    const browser = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [`*.${tag}.invalid`], declared: [], window: { width: 800, height: 600 }, netLogPath })
    const tried = (host: string) => (): boolean => {
      try {
        return readFileSync(netLogPath, 'utf8').includes(host)
      } catch {
        return false
      }
    }
    try {
      await browser.cdp.send('Target.createTarget', { url: `${site.origin}/` })
      await until(() => tried(covered)() && tried(sibling)(), 20_000)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    } finally {
      await browser.close()
      await site.close()
    }
    const raw = readFileSync(netLogPath, 'utf8')
    const log = JSON.parse(raw.trimEnd().endsWith('}') ? raw : raw.replace(/,?\s*$/, ']}')) as { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: unknown }[] }
    const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
    const lookups = (host: string): string[] =>
      log.events
        .filter((event) => JSON.stringify(event.params ?? {}).includes(host))
        .map((event) => names.get(event.type) ?? '')
        .filter((name) => /DNS|HOST_RESOLVER_.*TASK/.test(name))
    expect(log.events.some((event) => JSON.stringify(event.params ?? {}).includes(sibling)), 'the page never tried the sibling, so this proves nothing').toBe(true)
    expect(lookups(covered).length, `the subdomain a "*." entry allows was never looked up: Chrome ignored the wildcard in EXCLUDE`).toBeGreaterThan(0)
    expect(lookups(sibling), 'a host no entry allows reached a resolver').toEqual([])
  })

  it('rejects a pending call when the browser is killed out of band, and the host lives on', LONG, async () => {
    const browser = await launch(testBrowser!.path)
    const sessionId = await page(browser.cdp)
    await browser.cdp.send('Runtime.enable', {}, { sessionId })
    const pending = browser.cdp.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, { sessionId, timeoutMs: 60_000 })
    process.kill(browser.pid!, 'SIGKILL')
    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    // The pipe ends before Node reports the exit: the connection is the first
    // to know, and the process record follows.
    expect(browser.cdp.closed).toBeDefined()
    expect(await until(() => browser.exited, 10_000)).toBe(true)
    // A later write must be refused, not raise EPIPE into this process.
    await expect(browser.cdp.send('Browser.getVersion')).rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    await browser.close()
    expect(existsSync(browser.profileDir)).toBe(false)
  })

  it('takes its browser down with it when the host is killed, and the next launch sweeps the profile', LONG, async () => {
    const root = tempDir('minidsh-profiles-')
    const host = join(tempDir('minidsh-host-'), 'host.ts')
    const launchUrl = pathToFileURL(join(import.meta.dirname, 'launch.ts')).href
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      host,
      `import { launchBrowser } from ${JSON.stringify(launchUrl)}\n` +
        `const browser = await launchBrowser({ executablePath: ${JSON.stringify(testBrowser!.path)}, profileRoot: ${JSON.stringify(root)}, headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 } })\n` +
        `console.log('BROWSER ' + browser.pid)\nsetInterval(() => {}, 1000)\n`,
    )
    const child = spawn(process.execPath, [host], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = await new Promise<number>((resolve, reject) => {
      let out = ''
      child.stdout!.on('data', (chunk) => {
        out += chunk
        const match = /BROWSER (\d+)/.exec(out)
        if (match) resolve(Number(match[1]))
      })
      child.once('exit', (code) => reject(new Error(`the host exited (${code}) before its browser started: ${out}`)))
    })
    child.kill('SIGKILL')
    expect(await until(() => !alive(pid), 15_000), `browser ${pid} outlived its killed host`).toBe(true)
    // The killed host could not remove its profile; its owner is provably dead.
    expect(readdirSync(root)).toHaveLength(1)
    await sweepProfiles(root)
    expect(readdirSync(root)).toEqual([])
  })
})

describe.runIf(testBrowser !== undefined)('the network fence, for every browser this host has', () => {
  let fixture: FixtureServer
  let fixtureV6: FixtureServer | undefined
  // Whether `[::1]` is exercised is a fact read off the host, never a listener
  // that failed to bind and was forgiven: where the address exists, a bind
  // that fails is this test's failure.
  const hasV6Loopback = Object.values(networkInterfaces()).some((addresses) => addresses?.some((address) => address.address === '::1') === true)

  for (const browser of everyTestBrowser()) {
    it(`${browser.kind}: loopback in, everything else to the fence, an allowed host direct`, LONG, async () => {
      fixture ??= await fixtureServer({ '/': '<title>loopback</title><p>here</p>' })
      if (hasV6Loopback) fixtureV6 ??= await fixtureServer({ '/': '<p>v6</p>' }, { host: '::1' })
      else process.stderr.write(`[launch.test] ${browser.kind}: this host has no ::1 address, so the [::1] spelling of loopback was not exercised\n`)
      const launched = await launch(browser.path, ['allowed.invalid'])
      // The measurement a CI log must carry (stderr: vitest hides a passing
      // test's console): this is each browser's first start on a fresh runner,
      // the one that has taken up to 64 s for Edge against the 60 s bound.
      const { spawnedMs, firstOutputMs, answeredMs, fencedMs } = launched.startup
      process.stderr.write(`[launch.test] ${browser.kind} ${launched.product}: spawned ${spawnedMs} ms, first output ${firstOutputMs ?? 'none'} ms, answered ${answeredMs} ms, fenced ${fencedMs} ms\n`)
      const sessionId = await page(launched.cdp)
      const at = (url: string): Promise<Landing> => land(launched.cdp, sessionId, url)

      // In: every spelling of loopback the fence names.
      const loopback = [`${fixture.origin}/`, `http://localhost:${fixture.port}/`, `http://app.localhost:${fixture.port}/`, ...(fixtureV6 === undefined ? [] : [`http://[::1]:${fixtureV6.port}/`])]
      expect(loopback.length, `the loopback spellings tried: ${loopback.join(', ')}`).toBe(hasV6Loopback ? 4 : 3)
      for (const url of loopback) expect(await at(url), url).toMatchObject({ status: 200, fenced: false })

      // Out: answered by the fence, not by a network. Link-local and private
      // addresses included: `<-loopback>` removed Chrome's implicit bypass.
      // And the rest of 127/8: only `127.0.0.1` is loopback here (`fence.ts`
      // says why), so another address in the range meets the fence too,
      // whatever listens there, and is never a name that did not resolve.
      for (const url of ['http://denied.invalid/', 'http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://10.255.255.1/', 'http://192.168.0.1/', `http://127.0.0.2:${fixture.port}/`, 'http://127.1.2.3/']) {
        expect(await at(url), url).toMatchObject({ status: 403, fenced: true })
      }
      expect((await at('https://denied.invalid/')).errorText).toBe('net::ERR_TUNNEL_CONNECTION_FAILED')
      // The allowed host went DIRECT, so `.invalid` fails to resolve rather than meeting the fence.
      expect(await at('http://allowed.invalid/')).toMatchObject({ errorText: 'net::ERR_NAME_NOT_RESOLVED' })

      // WebRTC's UDP never meets a proxy: the profile's policy must leave it no candidate.
      await launched.cdp.send('Runtime.enable', {}, { sessionId })
      const rtc = await launched.cdp.send<{ result: { value: string[] } }>(
        'Runtime.evaluate',
        {
          expression:
            "(async()=>{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:192.0.2.1:3478'}]});pc.createDataChannel('x');const c=[];pc.onicecandidate=e=>{if(e.candidate)c.push(e.candidate.candidate)};await pc.setLocalDescription(await pc.createOffer());await new Promise(r=>setTimeout(r,2500));pc.close();return c})()",
          awaitPromise: true,
          returnByValue: true,
        },
        { sessionId },
      )
      expect(rtc.result.value, 'ICE candidates leave outside the fence').toEqual([])
      await launched.close()
    })
  }

  afterAll(async () => {
    await fixture?.close()
    await fixtureV6?.close()
  })
})
