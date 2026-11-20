/**
 * The INSTALLED desktop app doing real work on a real model (DeepSeek):
 * the gate CLAUDE.md §10 asks of every session, here through the window.
 *
 * Windows, because the installer, the confirm and the Job semantics are
 * Windows', and because the app is the Windows-first surface. It needs
 * DEEPSEEK_API_KEY and either MINIDSH_DESKTOP_INSTALLER (installed silently
 * into a path with a space and a non-ASCII letter, then uninstalled) or
 * MINIDSH_DESKTOP_EXE.
 *
 * The world is asserted, never the model's word: the fixture's tests pass
 * when THIS process runs them; the log holds the person's decisions, the
 * repair a killed runtime left for its resume, and the cancel a quit wrote.
 * The app's PATH carries no node of the person's, so the `node` the agent's
 * shell runs is the app's bundled one (24.22.3), which only running it can
 * report — that is the separating assertion for the bundled-node claim.
 *
 *   1. fix a failing test through the window, approvals clicked;
 *   2. kill the runtime mid-turn: the stopped view, Restart, open the
 *      session, continue — the log shows `interrupted` then `completed`;
 *   3. quit mid-turn: the confirm (UI Automation) names the work, Quit ends
 *      the turn `cancelled` and leaves no lease;
 *   4. a fresh profile with no key in the environment: the welcome view's
 *      form saves one, and a session in the next launch uses it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { answerNativeDialog, killDesktopApps, type DesktopApp, type DesktopLaunch } from '../../src/test-support/desktop-app.ts'
import { APPROVAL_ARMED, type UiPage } from '../../src/test-support/web-ui.ts'
import { launchApp as launchOwned, locksUnder, nsis, scratch as scratchOwned, seed, storedEvents, turnEnds, waitUntil, type Cleanup } from './support.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const INSTALLER = process.env.MINIDSH_DESKTOP_INSTALLER
const EXE = process.env.MINIDSH_DESKTOP_EXE
const SHOTS = process.env.MINIDSH_DESKTOP_SHOTS
const BUNDLED_NODE = 'v24.22.3'

const cleanup: Cleanup = []
afterAll(async () => {
  for (const undo of cleanup.splice(0).toReversed()) await undo()
  killDesktopApps()
})
const scratch = (prefix: string): string => scratchOwned(cleanup, prefix)
const launchApp = (launch: DesktopLaunch): DesktopApp => launchOwned(cleanup, launch)

/** This host's PATH without any directory holding a node: the app must bring its own. */
function pathWithoutNode(): string {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  return (process.env[key] ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0 && !existsSync(join(dir, 'node.exe')) && !existsSync(join(dir, 'node')))
    .join(delimiter)
}

/** A small repository with one failing test (node:test, no dependencies). */
function fixture(dir: string): void {
  writeFileSync(join(dir, 'package.json'), '{ "name": "slug-fixture", "type": "module", "private": true }\n')
  writeFileSync(
    join(dir, 'slug.mjs'),
    "// Turn a title into a URL slug: lowercase, words joined by single hyphens.\nexport function slugify(title) {\n  return title.split(' ').join('-')\n}\n",
  )
  writeFileSync(
    join(dir, 'slug.test.mjs'),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { slugify } from './slug.mjs'\n\ntest('lowercases and joins words with single hyphens', () => {\n  assert.equal(slugify('Hello World'), 'hello-world')\n  assert.equal(slugify('Many   Spaces Here'), 'many-spaces-here')\n})\n",
  )
}

const testsPass = (dir: string): boolean => spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' }).status === 0

/**
 * Answer every armed approval with the primary button (allow once) until
 * `done` holds: the person consenting, click by click, in the real window.
 */
async function consentUntil(web: UiPage, what: string, done: () => boolean, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let clicks = 0
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (${clicks} approvals clicked)`)
    if (await web.evaluate<boolean>(`Boolean(${APPROVAL_ARMED})`).catch(() => false)) {
      await web.click('#approval .btn.primary')
      clicks++
      await new Promise((resolve) => setTimeout(resolve, 400))
    } else await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return clicks
}

describe.runIf(KEY && (INSTALLER || EXE) && process.platform === 'win32')('the installed desktop app, live on DeepSeek', () => {
  it('fixes a test through the window, survives a killed runtime, quits mid-turn with consent, and saves a key', { timeout: 1_500_000 }, async () => {
    // ---- install ---------------------------------------------------------
    let exe = EXE!
    let installDir: string | undefined
    if (INSTALLER) {
      installDir = join(scratch('minidsh-live-install-'), 'Mini DSH ü')
      expect(nsis(INSTALLER, ['/S', `/D=${installDir}`]).status).toBe(0)
      exe = join(installDir, 'MiniDSH.exe')
    }
    const repo = join(scratch('minidsh-live-ws-'), 'slug repo')
    mkdirSync(repo)
    fixture(repo)
    expect(testsPass(repo), 'the fixture must start red').toBe(false)
    const home = scratch('minidsh-live-home-')
    const userData = scratch('minidsh-live-ud-')
    seed(userData, [repo])
    const env = { PATH: pathWithoutNode() }
    const drop = ['DEEPSEEK_BASE_URL', 'Path', 'PATH']

    // ---- 1. a real fix, consented click by click ------------------------
    const app = launchApp({ exe, userData, home, env, drop })
    const web = await app.page('http://127.0.0.1')
    await web.waitFor(`document.querySelector('#hero')?.textContent.includes('slug repo')`, 60_000)
    await web.type(
      '#prompt',
      'The test in this folder fails. Run `node --test` to see why, fix slug.mjs so the test passes (do not change the test), run `node --test` again, then run `node --version` and tell me the exact version it prints.',
    )
    await web.press('Enter')
    const started = Date.now()
    const evidence: string[] = []
    const clicks = await consentUntil(web, 'the first turn to end', () => turnEnds(home).length >= 1, 480_000)
    evidence.push(`1. fix: ${Math.round((Date.now() - started) / 1000)} s, ${clicks} approval(s) clicked`)
    expect(turnEnds(home), `main.log:\n${app.mainLog()}`).toEqual(['completed'])
    expect(testsPass(repo), 'the fix holds when this process runs the tests').toBe(true)
    const events = storedEvents(home)
    const decided = events.filter((event) => event.type === 'approval/decided')
    expect(clicks).toBeGreaterThan(0)
    expect(decided.length).toBeGreaterThan(0)
    expect(decided.every((event) => event.data.decidedBy === 'user'), JSON.stringify(decided.map((event) => event.data))).toBe(true)
    const resultText = events
      .filter((event) => event.type === 'tool/result')
      .map((event) => JSON.stringify(event.data))
      .join('\n')
    expect(resultText, 'the agent\'s `node` is the bundled one').toContain(BUNDLED_NODE)
    if (SHOTS) await web.screenshot(join(SHOTS, 'desktop-live-fixed.png'))

    // ---- 2. the runtime killed mid-turn; Restart; resume ------------------
    await web.type('#prompt', 'Add a second test to slug.test.mjs: slugify(\'  Trim Me  \') must equal \'trim-me\'. Make it pass, then run `node --test`.')
    const before = storedEvents(home).length
    await web.press('Enter')
    await waitUntil('the second turn to dispatch a tool or ask', () => storedEvents(home).slice(before).some((event) => event.type === 'tool/dispatch' || event.type === 'approval/asked'), 240_000)
    const runtime = app.runtimePid()!
    process.kill(runtime, 'SIGKILL')
    const shell = await app.page('minidsh-shell:')
    await shell.waitFor(`document.querySelector('h1')?.textContent.includes('stopped unexpectedly')`, 30_000)
    await shell.click('button.primary')
    const back = await app.page('http://127.0.0.1')
    await back.waitFor(`document.querySelectorAll('#sessions .session-row').length > 0`, 60_000)
    await back.click('#sessions .session-row')
    await back.waitFor(`document.querySelector('#rows')?.textContent.includes('Trim Me')`, 30_000)
    await back.type('#prompt', 'Continue: finish adding that test so it passes, and run `node --test` once more.')
    await back.press('Enter')
    await consentUntil(back, 'the resumed turn to complete', () => turnEnds(home).filter((reason) => reason === 'completed').length >= 2, 480_000)
    const ends = turnEnds(home)
    expect(ends.slice(0, 1)).toEqual(['completed'])
    expect(ends, 'the repair a resume wrote for the killed turn').toContain('interrupted')
    expect(ends.at(-1)).toBe('completed')
    evidence.push(`2. killed runtime ${runtime}, restarted, resumed: turn ends ${ends.join(' → ')}`)
    expect(testsPass(repo)).toBe(true)
    expect(readFileSync(join(repo, 'slug.test.mjs'), 'utf8')).toMatch(/Trim Me/)

    // ---- 3. quit mid-turn: the confirm names the work ---------------------
    // Counted BEFORE the prompt goes: a fast turn starts before the next line runs.
    const turnsBefore = storedEvents(home).filter((event) => event.type === 'turn/start').length
    await back.type('#prompt', 'Run `node --test` one more time and summarize the result in one sentence.')
    await back.press('Enter')
    await waitUntil('the third turn to start', () => storedEvents(home).filter((event) => event.type === 'turn/start').length > turnsBefore, 60_000).catch(async (error: unknown) => {
      const tail = storedEvents(home)
        .slice(-12)
        .map((event) => `${event.seq} ${event.type}`)
        .join('\n')
      const composer = await back.evaluate<string>(`JSON.stringify({ prompt: document.querySelector('#prompt')?.value, disabled: document.querySelector('#prompt')?.disabled, readonly: !document.querySelector('#readonly')?.hidden, approval: !document.querySelector('#approval')?.hidden, working: !document.querySelector('#working')?.hidden, url: location.href })`).catch(() => 'no page')
      if (SHOTS) await back.screenshot(join(SHOTS, 'desktop-live-third.png')).catch(() => undefined)
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nlog tail:\n${tail}\ncomposer: ${composer}\nfiles: ${readdirSync(join(home, 'sessions')).join(', ')}`)
    })
    app.closeWindow()
    const asked = answerNativeDialog(app.pid, 'Quit', 30_000)
    expect(asked.clicked, `no confirm; main.log:\n${app.mainLog()}`).toBe(true)
    expect(asked.text).toMatch(/Work is running/)
    expect((await app.waitForExit(90_000)).code, app.mainLog()).toBe(0)
    expect(app.mainLog()).toMatch(/runtime stop: graceful=true/)
    expect(turnEnds(home).at(-1)).toBe('cancelled')
    evidence.push(`3. quit mid-turn, the confirm said: ${asked.text.slice(0, 160)}`)
    expect(locksUnder(home)).toEqual([])

    // ---- 4. no key in the environment: the welcome view saves one --------
    const home2 = scratch('minidsh-live-home2-')
    const userData2 = scratch('minidsh-live-ud2-')
    const keyless = launchApp({ exe, userData: userData2, home: home2, env, drop: [...drop, 'DEEPSEEK_API_KEY'] })
    const welcome = await keyless.page('minidsh-shell:')
    await welcome.waitFor(`document.body.innerText.includes('DEEPSEEK_API_KEY') && document.body.innerText.includes('not set')`, 60_000)
    await welcome.type('input[aria-label="DEEPSEEK_API_KEY value"]', KEY!)
    await welcome.click('input[aria-label="DEEPSEEK_API_KEY value"] + button')
    await welcome.waitFor(`[...document.querySelectorAll('.row')].some((row) => row.textContent.includes('DEEPSEEK_API_KEY') && row.textContent.includes('saved'))`, 60_000)
    expect(JSON.parse(readFileSync(join(home2, 'credentials.json'), 'utf8'))).toHaveProperty('DEEPSEEK_API_KEY')
    expect(keyless.mainLog()).not.toContain(KEY!)
    keyless.closeWindow()
    expect((await keyless.waitForExit(30_000)).code).toBe(0)
    seed(userData2, [repo])
    const keyed = launchApp({ exe, userData: userData2, home: home2, env, drop: [...drop, 'DEEPSEEK_API_KEY'] })
    const page = await keyed.page('http://127.0.0.1')
    await page.waitFor(`document.querySelector('#hero')?.textContent.includes('works in')`, 60_000)
    await page.type('#prompt', 'Reply with exactly the word READY and nothing else. Do not use any tool.')
    await page.press('Enter')
    await consentUntil(page, 'the keyed turn to end', () => turnEnds(home2).length >= 1, 180_000)
    expect(turnEnds(home2)).toEqual(['completed'])
    const said = storedEvents(home2)
      .filter((event) => event.type === 'assistant/message')
      .map((event) => JSON.stringify(event.data))
      .join(' ')
    expect(said).toContain('READY')
    evidence.push(`4. a key saved in the welcome view (${readFileSync(join(home2, 'credentials.json'), 'utf8').length} bytes on disk), used by the next launch: READY`)
    keyed.closeWindow()
    expect((await keyed.waitForExit(60_000)).code).toBe(0)
    for (const dir of [join(home, 'sessions'), join(home2, 'sessions')]) expect(readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([])

    // ---- uninstall: the home is the person's ----------------------------
    if (installDir) {
      expect(nsis(join(installDir, 'Uninstall MiniDSH.exe'), ['/currentuser', '/S', `_?=${installDir}`]).status).toBe(0)
      expect(existsSync(exe)).toBe(false)
      expect(existsSync(join(home, 'sessions'))).toBe(true)
    }
    // Each decision as outcome:decider. One with no decider is one nobody made: an ask a stop cancelled, or `unavailable`,
    // one the quit left with no page to answer it (the window leaves the Web UI before the runtime stops).
    const decidedBy = storedEvents(home).filter((event) => event.type === 'approval/decided').map((event) => `${String(event.data.outcome)}:${String(event.data.decidedBy ?? 'none')}`)
    const lines = [...evidence, `decisions: ${decidedBy.length} (${[...new Set(decidedBy)].join(', ')}); agent node ${BUNDLED_NODE}; ${installDir ? 'installed and uninstalled' : 'unpacked build'}; ${Math.round((Date.now() - started) / 1000)} s`]
    process.stderr.write(`desktop live:\n  ${lines.join('\n  ')}\n`)
  })
})
