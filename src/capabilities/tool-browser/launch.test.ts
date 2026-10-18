/**
 * A real browser, launched as `tool-browser` launches it: the pipe, the
 * profile, the fence and the ways a browser goes away. Raw CDP drives the page
 * here, so these hold without the page model above them.
 *
 * Self-skips where no Chrome, Edge or Chromium is installed; under
 * `MINIDSH_EXPECT_BROWSER=1` that is a failure (`expectBrowserSuite`).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { browsersUsing, everyTestBrowser, expectBrowserSuite, fixtureServer, testBrowser, type FixtureServer } from '../../test-support/browser-fixture.ts'
import type { CdpConnection } from './cdp.ts'
import { CANARY_HOST, FENCE_HEADER } from './fence.ts'
import { launchBrowser, sweepProfiles, type LaunchedBrowser } from './launch.ts'
import { candidates, locateBrowser } from './locate.ts'

expectBrowserSuite('tool-browser launch')

const LONG = { timeout: 120_000 }
const dirs: string[] = []
const browsers: LaunchedBrowser[] = []
afterAll(async () => {
  for (const browser of browsers) await browser.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}, 120_000)

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

  it('refuses the launch when the fence cannot be proved, leaving nothing running', LONG, async () => {
    // The canary host on the allow list goes DIRECT, so it never reaches the
    // fence: exactly what a proxy policy or a fence that is not in force looks like.
    const root = tempDir('minidsh-profiles-')
    const error = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: root, headless: true, allowHosts: [CANARY_HOST], declared: [], window: { width: 800, height: 600 } }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ code: 'BROWSER_FENCE_UNAVAILABLE', hostFault: true })
    expect(readdirSync(root)).toEqual([])
    // "Nothing running": no process anywhere still uses a profile under this root.
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

  it('resolves no name a page hands it: a WebRTC TURN host meets the fence, never a DNS server', LONG, async () => {
    const tag = `turnt-${process.pid}-${Date.now() % 100_000}.example.com`
    const site = await fixtureServer({
      '/': `<title>turn</title><script>(async()=>{const pc=new RTCPeerConnection({iceServers:[{urls:'turn:${tag}:3478?transport=tcp',username:'u',credential:'c'}]});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer())})()</script>`,
    })
    const netLogPath = join(tempDir('minidsh-netlog-'), 'net.json')
    const browser = await launchBrowser({ executablePath: testBrowser!.path, profileRoot: tempDir('minidsh-profiles-'), headless: true, allowHosts: [], declared: [], window: { width: 800, height: 600 }, netLogPath })
    try {
      await browser.cdp.send('Target.createTarget', { url: `${site.origin}/` })
      await new Promise((resolve) => setTimeout(resolve, 4_000))
    } finally {
      await browser.close()
      await site.close()
    }
    const raw = readFileSync(netLogPath, 'utf8')
    const log = JSON.parse(raw.trimEnd().endsWith('}') ? raw : raw.replace(/,?\s*$/, ']}')) as { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: unknown }[] }
    const names = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]))
    const naming = log.events.filter((event) => JSON.stringify(event.params ?? {}).includes(tag)).map((event) => names.get(event.type) ?? '')
    // The test means something only if the page really tried to reach the host…
    expect(naming.length, 'the page never tried its TURN host, so this proves nothing').toBeGreaterThan(0)
    // …and the attempt met the proxy, never a resolver (measured: without
    // --host-resolver-rules a DNS transaction carries this name off the machine).
    expect(naming.filter((name) => /DNS|HOST_RESOLVER_.*TASK/.test(name)), `the TURN host reached a resolver: ${[...new Set(naming)].join(', ')}`).toEqual([])
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
  let fixture127b: FixtureServer | undefined

  for (const browser of everyTestBrowser()) {
    it(`${browser.kind}: loopback in, everything else to the fence, an allowed host direct`, LONG, async () => {
      fixture ??= await fixtureServer({ '/': '<title>loopback</title><p>here</p>' })
      // Optional listeners: macOS has no 127.0.0.2, and a host may lack IPv6.
      if (fixtureV6 === undefined) fixtureV6 = await fixtureServer({ '/': '<p>v6</p>' }, { host: '::1' }).catch(() => undefined)
      if (fixture127b === undefined) fixture127b = await fixtureServer({ '/': '<p>b</p>' }, { host: '127.0.0.2' }).catch(() => undefined)
      const launched = await launch(browser.path, ['allowed.invalid'])
      const sessionId = await page(launched.cdp)
      const at = (url: string): Promise<Landing> => land(launched.cdp, sessionId, url)

      // In: every spelling of loopback.
      for (const url of [`${fixture.origin}/`, `http://localhost:${fixture.port}/`, `http://app.localhost:${fixture.port}/`]) {
        expect(await at(url), url).toMatchObject({ status: 200, fenced: false })
      }
      if (fixtureV6) expect(await at(`http://[::1]:${fixtureV6.port}/`)).toMatchObject({ status: 200, fenced: false })
      if (fixture127b) expect(await at(`http://127.0.0.2:${fixture127b.port}/`)).toMatchObject({ status: 200, fenced: false })

      // Out: answered by the fence, not by a network. Link-local and private
      // addresses included: `<-loopback>` removed Chrome's implicit bypass.
      for (const url of ['http://denied.invalid/', 'http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://10.255.255.1/', 'http://192.168.0.1/']) {
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
    await fixture127b?.close()
  })
})
