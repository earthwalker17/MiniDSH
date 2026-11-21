/**
 * Retakes the Web UI pictures under `docs/images/` from a web host that is
 * already running, in a real browser at twice the pixel density, in the
 * themes asked for. What each picture shows, from which recorded session and
 * on which version is `docs/images/README.md`'s to say; this only drives.
 *
 *   minidsh web                      (prints a one-time link; any host, any home)
 *   node scripts/capture-shots.ts --url <that link> --out docs/images --name web \
 *        --session "<part of a session's title>" [--themes light,dark] [--width 1280] [--height 800] [--scale 2]
 *        [--click "<text on a row or group>" ...] [--show "<css selector>"] [--list]
 *
 * A finished turn folds its work into one line. `--click` opens what a person
 * would open (a group, then a row inside it), in the order given; `--show`
 * scrolls the first match to the middle; `--list` prints the transcript's
 * buttons so the next run can name them.
 *
 * The host decides what is on screen. A home seeded with the logs under
 * `docs/images/logs/` shows those recorded sessions with no key and no model
 * call; a host with a key can be driven live (`--prompt`, then `--until
 * approval` to stop at the first armed approval card, or `--until idle`).
 *
 * It uses the test suites' own page driver (`src/test-support/web-ui.ts`) and
 * the browser tool's launcher, so it clicks and types the way the browser
 * tests do, and it fails if the page logged an error while it was pictured.
 * A development tool: nothing here ships (`package.json` `files`).
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { launchBrowser } from '../src/capabilities/tool-browser/launch.ts'
import { testBrowser } from '../src/test-support/browser-fixture.ts'
import { APPROVAL_ARMED, pageOpener, type UiPage } from '../src/test-support/web-ui.ts'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
    name: { type: 'string', default: 'web' },
    session: { type: 'string' },
    prompt: { type: 'string' },
    until: { type: 'string', default: 'idle' },
    themes: { type: 'string', default: 'light,dark' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    scale: { type: 'string', default: '2' },
    'wait-ms': { type: 'string', default: '300000' },
    click: { type: 'string', multiple: true },
    show: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(`capture-shots: ${message}`)
  process.exit(2)
}

if (values.url === undefined || values.out === undefined) fail('usage: node scripts/capture-shots.ts --url <the link minidsh web printed> --out <directory> [--name web] [--session <title part>] [--prompt <text>] [--until idle|approval] [--themes light,dark] [--width 1280] [--height 800] [--scale 2]')
if (testBrowser === undefined) fail('no Chrome, Edge or Chromium found (set MINIDSH_TEST_BROWSER to one)')
const themes = values.themes.split(',').map((theme) => theme.trim())
if (themes.some((theme) => theme !== 'light' && theme !== 'dark')) fail(`--themes takes light and dark, not ${values.themes}`)
if (values.until !== 'idle' && values.until !== 'approval') fail(`--until takes idle or approval, not ${values.until}`)
const [width, height, scale, waitMs] = [values.width, values.height, values.scale, values['wait-ms']].map(Number) as [number, number, number, number]
if (![width, height, scale, waitMs].every((n) => Number.isFinite(n) && n > 0)) fail('--width, --height, --scale and --wait-ms take positive numbers')

const out = resolve(values.out)
mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'minidsh-shots-'))

/** A session is on screen and nothing is running: the empty state is gone, the transcript has blocks, the working line is hidden. */
const SHOWN = `document.querySelector('#hero').hidden && document.querySelector('#log').children.length > 0`
const IDLE = `${SHOWN} && document.querySelector('#working').hidden`

async function settle(page: UiPage): Promise<void> {
  // Fonts and the last layout pass: a picture taken one frame early has a fallback face or a half-open card.
  await page.evaluate('document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))')
}

async function setTheme(page: UiPage, theme: string): Promise<void> {
  await page.evaluate(`localStorage.setItem('minidsh.theme', ${JSON.stringify(theme)}); location.reload()`)
  await page.waitFor(`document.readyState === 'complete' && document.documentElement.dataset.theme === ${JSON.stringify(theme)} && document.querySelector('#sessions') !== null`, 30_000)
}

async function openSession(page: UiPage, part: string): Promise<void> {
  await page.waitFor(`document.querySelectorAll('#sessions .session-row').length > 0`, 30_000)
  const index = await page.evaluate<number>(`[...document.querySelectorAll('#sessions .session-row')].findIndex((row) => row.textContent.toLowerCase().includes(${JSON.stringify(part.toLowerCase())}))`)
  if (index < 0) {
    const titles = await page.evaluate<string[]>(`[...document.querySelectorAll('#sessions .session-row')].map((row) => row.textContent.trim().slice(0, 60))`)
    throw new Error(`no session row contains "${part}"; rows: ${titles.join(' | ')}`)
  }
  await page.evaluate(`document.querySelectorAll('#sessions .session-row')[${index}].setAttribute('data-shot', '1')`)
  await page.click(`#sessions .session-row[data-shot="1"]`)
  await page.waitFor(SHOWN, 30_000)
}

/** Opens what a person would click open: the first button of the transcript whose text holds `part`. */
async function clickText(page: UiPage, part: string): Promise<void> {
  const index = await page.evaluate<number>(`[...document.querySelectorAll('#log button')].findIndex((button) => button.textContent.toLowerCase().includes(${JSON.stringify(part.toLowerCase())}))`)
  if (index < 0) throw new Error(`no button in the transcript contains "${part}" (run with --list)`)
  await page.evaluate(`(() => { for (const marked of document.querySelectorAll('[data-shot-click]')) marked.removeAttribute('data-shot-click'); document.querySelectorAll('#log button')[${index}].setAttribute('data-shot-click', '1') })()`)
  await page.click('#log button[data-shot-click="1"]')
  await settle(page)
}

const browser = await launchBrowser({
  executablePath: testBrowser.path,
  profileRoot: join(scratch, 'profiles'),
  headless: true,
  allowHosts: [],
  declared: [],
  window: { width, height },
})
let failed: unknown
try {
  const { openPage } = pageOpener(browser, values.url)
  const page = await openPage()
  await page.setViewport(width, height, scale)
  let first = true
  for (const theme of themes) {
    await setTheme(page, theme)
    if (values.session !== undefined) await openSession(page, values.session)
    if (first && values.prompt !== undefined) {
      // The composer is disabled until the page is connected, and a key
      // typed at a disabled field goes nowhere. It empties the moment it
      // sends, so Enter is pressed until it has.
      await page.waitFor(`document.querySelector('#prompt') !== null && !document.querySelector('#prompt').disabled`, 30_000)
      await page.type('#prompt', values.prompt)
      for (let presses = 0; presses < 5 && (await page.evaluate<string>(`document.querySelector('#prompt').value`)) !== ''; presses++) {
        await page.press('Enter')
        await page.waitFor(`document.querySelector('#prompt').value === ''`, 3_000).catch(() => undefined)
      }
      await page.waitFor(SHOWN, 60_000)
    }
    await page.waitFor(values.until === 'approval' ? APPROVAL_ARMED : IDLE, waitMs)
    await settle(page)
    for (const part of values.click ?? []) await clickText(page, part)
    if (values.list) console.log((await page.evaluate<string[]>(`[...document.querySelectorAll('#log button')].map((button) => button.className + ' | ' + button.textContent.trim().replace(/\\s+/g, ' ').slice(0, 90))`)).join('\n'))
    if (values.show !== undefined) {
      const found = await page.evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(values.show)}); if (el === null) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
      if (!found) throw new Error(`--show: nothing matches ${values.show}`)
      await settle(page)
    }
    const file = join(out, `${values.name}-${theme}.png`)
    await page.screenshot(file)
    console.log(`${file} (${statSync(file).size} bytes, ${width * scale}x${height * scale})`)
    first = false
  }
  const problems = await page.unexpectedProblems()
  if (problems.length > 0) throw new Error(`the page reported ${problems.length} problem(s) while it was pictured: ${problems.map((problem) => `${problem.source}/${problem.level}: ${problem.text}`).join(' | ').slice(0, 800)}`)
} catch (error) {
  failed = error
} finally {
  await browser.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
if (failed !== undefined) fail(failed instanceof Error ? failed.message : String(failed))
