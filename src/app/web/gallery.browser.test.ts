/**
 * The redesigned client walked through a real session, in a real browser —
 * the visual matrix S22 is held to, as structure rather than pixels (system
 * font stacks differ per OS, so a pixel diff would be noise).
 *
 * One scripted model drives real tools in a temp workspace: it reads a file,
 * asks to run the tests outside the sandbox (an approval the page answers),
 * edits the bug away, runs them again under a session grant, and answers in
 * markdown; then it delegates a review to a subagent and starts a background
 * job. At each state the page is held to what a person must see, at four
 * widths (wide, the rail, the drawer's edge, a phone) in both themes, with
 * no console error, no CSP violation and nothing wider than the window.
 *
 * Set `MINIDSH_UI_SHOTS=<dir>` to keep a screenshot of every state: review
 * material for a person, never an assertion.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LlmRequest, StreamChunk } from '../../core/llm/types.ts'
import { TOOLS } from '../../core/tools/index.ts'
import { expectBrowserSuite, testBrowser } from '../../test-support/browser-fixture.ts'
import { assistantMessage, assistantText, type MessagePart } from '../../test-support/scripted-adapter.ts'
import { APPROVAL_ARMED, startWebUi, type UiPage, type WebUi } from '../../test-support/web-ui.ts'

expectBrowserSuite('web UI gallery')

const SHOTS = process.env.MINIDSH_UI_SHOTS
const WIDTHS = [1440, 1024, 768, 390] as const

const message = (...parts: MessagePart[]): StreamChunk[] => assistantMessage(parts, { inputTokens: 2400, outputTokens: 180, cacheReadTokens: 1800 })

const FINAL_ANSWER = `## What was wrong

\`slugify\` used \`String.replace(' ', '-')\`, which replaces **only the first** space, so \`Hello Big World\` became \`hello-big world\`.

| File | Change | Tests |
| --- | --- | --- |
| \`slug.js\` | a global regex | 1 of 1 pass |

\`\`\`js
export function slugify(title) {
  return title.toLowerCase().replace(/ /g, '-')
}
\`\`\`

- The test file needed no change.
- Leading and trailing spaces still become dashes; say if you want them trimmed.`

describe.runIf(testBrowser)('the web UI, walked through a session', () => {
  let ui: WebUi | undefined
  let page: UiPage | undefined

  beforeAll(async () => {
    ui = await startWebUi({ window: { width: 1440, height: 900 } })
    writeFileSync(join(ui.workspace, 'slug.js'), "export function slugify(title) {\n  return title.toLowerCase().replace(' ', '-')\n}\n")
    writeFileSync(join(ui.workspace, 'slug.test.js'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { slugify } from './slug.js'\n\ntest('slugifies every space', () => {\n  assert.equal(slugify('Hello Big World'), 'hello-big-world')\n})\n")
    writeFileSync(join(ui.workspace, 'package.json'), '{ "type": "module" }\n')
    if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    await ui?.close()
  }, 60_000)

  /**
   * Every state, at every width, in both themes: structure, and a shot when
   * asked. A menu closes when the window resizes (as it should), so a state
   * with one open is checked at the width it was opened at.
   */
  async function check(state: string, must: readonly string[], widths: readonly number[] = WIDTHS): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
      await page!.evaluate(`window.minidshTheme.set(${JSON.stringify(theme)})`)
      for (const width of widths) {
        await page!.setViewport(width, width === 390 ? 844 : 900)
        await new Promise((resolve) => setTimeout(resolve, 120))
        const overflow = await page!.evaluate<number>(`document.documentElement.scrollWidth - window.innerWidth`)
        expect(overflow, `${state} at ${width}px (${theme}) is wider than the window`).toBeLessThanOrEqual(0)
        for (const selector of must) expect(await page!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`), `${state}: ${selector}`).toBe(true)
        if (SHOTS) await page!.screenshot(join(SHOTS, `${state}-${theme}-${width}.png`))
      }
    }
    await page!.evaluate(`window.minidshTheme.set('light')`)
    if (widths.at(-1) !== 1440) await page!.setViewport(1440, 900)
    // Let the layout settle before the next click is aimed at it.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await page!.unexpectedProblems(), state).toEqual([])
  }

  it('walks a session from the empty state to a delegated review and a background job', async () => {
    const tools = ui!.host.root.get(TOOLS).list()
    const shell = tools.find((tool) => tool.display?.card === 'terminal')!.name
    const delegate = tools.find((tool) => tool.display?.card === 'delegate')?.name
    const job = tools.find((tool) => tool.name === 'job_start')?.name
    const widen = (command: string) => ({ command, sandbox_permissions: 'danger-full-access', justification: 'node --test starts a child process for each test file' })

    page = await ui!.page()
    await page.waitFor(`document.querySelector('.version-pill') !== null`)
    await check('01-empty', ['.hero-title', '#prompt', '.composer .chip'])

    // A child's requests carry its own task; key its answer by that.
    const isChild = (request: LlmRequest) => JSON.stringify(request.messages).includes('Review slug.js for edge cases')
    ui!.adapter.scriptWhen(isChild, assistantText('No other bugs. Two edge cases to consider: leading spaces and repeated spaces both become dashes.'))
    ui!.adapter.script(
      message(
        { reasoning: 'The test expects every space replaced. I should read slug.js and run the tests to see the real failure.' },
        { text: "I'll read the implementation and run the tests first." },
        { call: ['c1', 'str_replace_editor', { command: 'view', path: 'slug.js' }] },
        { call: ['c2', shell, widen('node --test')] },
      ),
      message({ text: 'The test fails because `replace` swaps only the first space. Fixing it with a global regex:' }, { call: ['c3', 'str_replace_editor', { command: 'str_replace', path: 'slug.js', old_str: "replace(' ', '-')", new_str: "replace(/ /g, '-')" }] }),
      message({ call: ['c4', shell, widen('node --test')] }),
      message({ text: FINAL_ANSWER }),
    )
    await page.type('#prompt', 'The slug tests fail. Find out why and fix slug.js.')
    await page.press('Enter')

    // The model asks to run the tests outside the sandbox: the approval takes the composer's place.
    await page.waitFor(APPROVAL_ARMED, 20_000)
    await check('02-approval', ['#approval .approval-head code', '#approval .btn.primary', '.process .row', '.bubble'])
    expect(await page.evaluate<boolean>(`document.querySelector('#composer').hidden`)).toBe(true)
    await page.click('#approval .btn.primary')

    // The edit lands, the second run asks again: allowed for the session this time.
    await page.waitFor(`${APPROVAL_ARMED} && document.querySelectorAll('.system').length >= 1`, 30_000)
    const sessionButton = await page.evaluate<boolean>(`[...document.querySelectorAll('#approval .btn')].some((b) => b.textContent === 'Allow for this session')`)
    expect(sessionButton, 'the host offered a session grant').toBe(true)
    await page.evaluate(`[...document.querySelectorAll('#approval .btn')].find((b) => b.textContent === 'Allow for this session').click()`)
    await page.waitFor(`document.querySelector('#rows').textContent.includes('What was wrong')`, 30_000)
    await page.waitFor(`document.querySelector('.tail') !== null`, 10_000)
    await check('03-answered', ['.reply h2', '.reply table', '.codeblock', '.system .receipt', '.tail .took'])

    // Open every card the finished turn holds: the diff, the run with its exit code, the receipts.
    await page.evaluate(`document.querySelectorAll('.group-head').forEach((head) => head.click())`)
    await page.evaluate(`document.querySelectorAll('.process button.row').forEach((row) => row.click())`)
    await page.waitFor(`document.querySelector('.diff .add') !== null`)
    await check('04-cards-open', ['.diff .del', '.diff .add', '.card .receipt', '.row .capsule', '.row-title'])
    const texts = await page.evaluate<string>(`document.querySelector('#rows').textContent`)
    expect(texts).toContain('Run command')
    expect(texts).toContain('Edit file')
    expect(texts).toContain('Read file')
    // The failing run's exit code comes from the effect record.
    expect(texts).toMatch(/exit 1/)

    // A person widens what the shell may do, through the permission chip: a
    // risky switch asks first, and lands as a receipt in the conversation.
    await page.click('#composer-bar .chip')
    await page.waitFor(`document.querySelector('.menu') !== null`)
    await check('05-permission-menu', ['.menu .menu-item[aria-checked="true"]', '.menu .menu-label'], [1440])
    await page.evaluate(`[...document.querySelectorAll('.menu .menu-item')].find((item) => item.textContent.includes('Accept an unconfined shell')).click()`)
    await page.waitFor(`document.querySelector('dialog.modal[open] .btn.primary') !== null`)
    await page.click('dialog.modal[open] .btn.primary')
    await page.waitFor(`document.querySelector('#rows').textContent.includes('Shell enforcement accepted: none')`, 10_000)

    // A delegated review and a background job, in a second turn. Both tools are
    // the web composition's: one going missing (a renamed card, a dropped row)
    // is a failure here, not a state this gallery quietly leaves out.
    expect(delegate, 'the web composition mounts a tool that declares the delegate card').toBeDefined()
    expect(job, 'the web composition mounts job_start').toBeDefined()
    if (delegate !== undefined && job !== undefined) {
      ui!.adapter.script(
        message({ text: 'Asking a subagent for a review, and starting a watcher.' }, { call: ['c5', delegate, { description: 'Review slug.js', prompt: 'Review slug.js for edge cases.' }] }, { call: ['c6', job, { command: 'node -e "setInterval(() => {}, 1000)"' }] }),
        message({ text: 'The review found no other bugs; the watcher runs in the background.' }),
      )
      await page.type('#prompt', 'Have a subagent review it, and start a background watcher.')
      await page.press('Enter')
      await page.waitFor(`document.querySelector('#rows').textContent.includes('the watcher runs in the background')`, 30_000)
      await page.waitFor(`document.querySelector('.status-chip') !== null`, 10_000)
      await page.click('#topbar [aria-label="Session details"]')
      await page.waitFor(`!document.querySelector('#panel').hidden`)
      // The child the delegation made, named from the listing.
      await page.waitFor(`document.querySelector('#panel').textContent.includes('Review slug.js')`, 10_000)
      await check('06-panel', ['#panel .panel-section', '#panel .btn.sm', '.child-link'])
      expect(await page.evaluate<string>(`document.querySelector('#panel').textContent`)).toMatch(/node -e/)
    }

    // The phone's drawer: the whole sidebar (never the rail's icons), each row
    // the drawer's width, and the page behind it out of reach.
    await page.click('#topbar [aria-label="Session details"]')
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(`window.minidshTheme.set(${JSON.stringify(theme)})`)
      await page.setViewport(390, 844)
      await new Promise((resolve) => setTimeout(resolve, 150))
      await page.click('.drawer-opener')
      await page.waitFor(`document.querySelector('#app').dataset.drawer === 'open'`)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const shape = await page.evaluate<{ mode: string; list: string; rowWidth: number; listWidth: number; inert: boolean; label: string; newWidth: number }>(
        `(() => { const row = document.querySelector('.session-row'); const list = document.querySelector('#sessions'); return { mode: document.querySelector('#app').dataset.sidebar, list: getComputedStyle(list).display, rowWidth: row.getBoundingClientRect().width, listWidth: list.getBoundingClientRect().width, inert: document.querySelector('#main').inert, label: document.querySelector('#brand .icon-btn').getAttribute('aria-label'), newWidth: document.querySelector('#new').getBoundingClientRect().width } })()`,
      )
      expect(shape.mode).toBe('full')
      expect(shape.list).toBe('flex')
      expect(shape.rowWidth).toBeGreaterThanOrEqual(shape.listWidth - 24)
      expect(shape.newWidth).toBeGreaterThan(120)
      expect(shape.inert).toBe(true)
      expect(shape.label).toBe('Close sessions')
      if (SHOTS) await page.screenshot(join(SHOTS, `07-drawer-${theme}-390.png`))
      await page.press('Escape')
      await page.waitFor(`document.querySelector('#app').dataset.drawer === undefined && !document.querySelector('#main').inert`)
      // Focus returns to the control that opened the drawer.
      expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.drawer-opener')`)).toBe(true)
    }
    await page.evaluate(`window.minidshTheme.set('light')`)
    await page.setViewport(1440, 900)
    expect(await page.unexpectedProblems(), '07-drawer').toEqual([])
  }, 240_000)
})
