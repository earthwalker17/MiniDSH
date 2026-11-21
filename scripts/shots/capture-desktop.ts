/**
 * Takes the desktop app's picture. Starts an installed (or unpacked) MiniDSH
 * with a data folder and a home of its own, gives it one real task in the
 * folder named, clicks each approval as a person would, and when the turn is
 * over captures the app's own window, native frame and menu included, with
 * `Capture-Window.ps1`. Windows only (`PrintWindow`).
 *
 *   node scripts/shots/capture-desktop.ts --exe <MiniDSH.exe> --folder <project> \
 *        --home <dir> --data <dir> --out <file.png> --prompt "<task>" [--click "<text>" ...] [--wait-ms 600000]
 *
 * The folder, the home and the data folder are the caller's, on neutral
 * paths: the session records the folder and the page shows it. The provider
 * key comes from the environment and is never printed. The app is driven
 * over the debugging PIPE the desktop tests use (`src/test-support/desktop-app.ts`),
 * which only this process holds. A development tool: nothing here ships.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DesktopApp } from '../../src/test-support/desktop-app.ts'
import { APPROVAL_ARMED, type UiPage } from '../../src/test-support/web-ui.ts'

const { values } = parseArgs({
  options: {
    exe: { type: 'string' },
    folder: { type: 'string' },
    home: { type: 'string' },
    data: { type: 'string' },
    out: { type: 'string' },
    prompt: { type: 'string' },
    click: { type: 'string', multiple: true },
    'wait-ms': { type: 'string', default: '600000' },
  },
})

function fail(message: string): never {
  console.error(`capture-desktop: ${message}`)
  process.exit(2)
}

if (process.platform !== 'win32') fail('Windows only: the window is captured with PrintWindow')
const { exe, folder, home, data, out, prompt } = values
if (exe === undefined || folder === undefined || home === undefined || data === undefined || out === undefined || prompt === undefined) {
  fail('usage: node scripts/shots/capture-desktop.ts --exe <MiniDSH.exe> --folder <project> --home <dir> --data <dir> --out <file.png> --prompt "<task>"')
}
const waitMs = Number(values['wait-ms'])
if (!Number.isFinite(waitMs) || waitMs <= 0) fail('--wait-ms takes a positive number')

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
const SHOWN = `document.querySelector('#hero').hidden && document.querySelector('#log').children.length > 0`
const WORKING = `!document.querySelector('#working').hidden`

/** Opens what a person would click open: the first button of the transcript whose text holds `part`. */
async function clickText(page: UiPage, part: string): Promise<void> {
  const index = await page.evaluate<number>(`[...document.querySelectorAll('#log button')].findIndex((button) => button.textContent.toLowerCase().includes(${JSON.stringify(part.toLowerCase())}))`)
  if (index < 0) throw new Error(`no button in the transcript contains "${part}"`)
  await page.evaluate(`(() => { for (const marked of document.querySelectorAll('[data-shot-click]')) marked.removeAttribute('data-shot-click'); document.querySelectorAll('#log button')[${index}].setAttribute('data-shot-click', '1') })()`)
  await page.click('#log button[data-shot-click="1"]')
}

// The folder the app opens with: its own remembered list, as File > Open Folder leaves it.
mkdirSync(resolve(data), { recursive: true })
mkdirSync(resolve(home), { recursive: true })
writeFileSync(join(resolve(data), 'settings.json'), `${JSON.stringify({ version: 1, folders: [resolve(folder)] })}\n`)
mkdirSync(dirname(resolve(out)), { recursive: true })

const app = new DesktopApp({ exe: resolve(exe), userData: resolve(data), home: resolve(home) })
let failed: unknown
try {
  const page = await app.page('http://127.0.0.1', 120_000)
  // The composer is disabled until the page is connected, and it empties the
  // moment it sends, so Enter is pressed until it has (a key over this pipe
  // can be dropped while the window takes focus).
  // Ready as a person sees it: the empty page names the folder it works in.
  await page.waitFor(`document.querySelector('#hero')?.textContent.includes('works in') && document.querySelector('#prompt') !== null && !document.querySelector('#prompt').disabled`, 120_000)
  await page.type('#prompt', prompt)
  for (let presses = 0; presses < 5 && (await page.evaluate<string>(`document.querySelector('#prompt').value`)) !== ''; presses++) {
    // Focus first, each time: in a window that is not the foreground one the
    // page gave focus back to the body, and Enter then went nowhere.
    await page.evaluate(`document.querySelector('#prompt').focus()`)
    await page.press('Enter')
    await page.waitFor(`document.querySelector('#prompt').value === ''`, 3_000).catch(() => undefined)
  }
  // The turn has begun: a session is on screen and it is working, asking, or
  // already answered. On a timeout, say where the prompt stopped.
  const BEGUN = `${SHOWN} && (${WORKING} || !document.querySelector('#approval').hidden || document.querySelectorAll('#log .assistant, #log .process').length > 0)`
  await page.waitFor(BEGUN, 90_000).catch(async (error: unknown) => {
    const state = await page
      .evaluate<string>(
        `JSON.stringify({ draft: document.querySelector('#prompt')?.value, disabled: document.querySelector('#prompt')?.disabled, focus: document.activeElement?.id || document.activeElement?.tagName, hero: document.querySelector('#hero')?.hidden, log: document.querySelector('#log')?.children.length, working: document.querySelector('#working')?.hidden, toast: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent.slice(0, 200)), text: document.querySelector('#log')?.innerText.slice(0, 300) })`,
      )
      .catch(() => 'the page did not answer')
    throw new Error(`${error instanceof Error ? error.message.slice(0, 120) : String(error)}\npage: ${state}`)
  })
  // Each approval is answered with the primary button (allow once), as a
  // person consenting click by click, until nothing is running.
  const deadline = Date.now() + waitMs
  let clicks = 0
  for (;;) {
    if (await page.evaluate<boolean>(`Boolean(${APPROVAL_ARMED})`).catch(() => false)) {
      await page.click('#approval .btn.primary')
      clicks++
      await pause(500)
    } else if (!(await page.evaluate<boolean>(`Boolean(${WORKING})`))) {
      // Not working and nothing to answer: over, unless a question is about to arm.
      await pause(1_500)
      if (!(await page.evaluate<boolean>(`Boolean(${WORKING}) || !document.querySelector('#approval').hidden`))) break
    } else await pause(300)
    if (Date.now() > deadline) throw new Error(`the turn was not over after ${waitMs} ms (${clicks} approvals clicked)`)
  }
  for (const part of values.click ?? []) await clickText(page, part)
  // Fonts and the last layout pass.
  await page.evaluate('document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))')
  await pause(500)
  const captured = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', join(import.meta.dirname, 'Capture-Window.ps1'), '-ProcessId', String(app.pid), '-Out', resolve(out)], { encoding: 'utf8', timeout: 60_000 })
  if (captured.status !== 0) throw new Error(`the window was not captured: ${captured.stderr || captured.stdout}`)
  console.log(`${captured.stdout.trim()} (${statSync(resolve(out)).size} bytes, ${clicks} approvals clicked)`)
} catch (error) {
  failed = error
  // What the window looked like when it went wrong, beside the picture it was asked for.
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', join(import.meta.dirname, 'Capture-Window.ps1'), '-ProcessId', String(app.pid), '-Out', `${resolve(out)}.failed.png`], { encoding: 'utf8', timeout: 60_000 })
} finally {
  // Asked to close as a person closes it; forced only if it will not go.
  try {
    app.closeWindow()
    await app.waitForExit(30_000)
  } catch {
    app.child.kill('SIGKILL')
  }
}
if (failed !== undefined) {
  console.error(failed instanceof Error ? failed.message : String(failed))
  process.exit(1)
}
