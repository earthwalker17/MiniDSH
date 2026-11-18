/**
 * The browser client in a real browser, against the real web host
 * (`test-support/web-ui.ts`): it loads under its content security policy with
 * nothing on the console, a prompt typed and sent the way a person does it
 * reaches the model and its answer the transcript, and a streamed answer shows
 * while its message is not yet durable.
 *
 * The selectors are TODAY's page (`#prompt`, `#log`, the workspace picker as
 * the sign that `initialize` has answered); a redesign of the page updates
 * them here, and should keep them few.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AGENTS } from '../../core/agent/index.ts'
import { ASSISTANT_MESSAGE, matches } from '../../core/session/index.ts'
import { expectBrowserSuite, testBrowser } from '../../test-support/browser-fixture.ts'
import { assistantText, assistantTextPaused } from '../../test-support/scripted-adapter.ts'
import { startWebUi, type WebUi } from '../../test-support/web-ui.ts'

expectBrowserSuite('web UI')

/** The page has connected and `initialize` has answered: the picker it fills exists. */
const READY = `document.querySelector('#workspace option') !== null`
const logHas = (text: string): string => `document.querySelector('#log').textContent.includes(${JSON.stringify(text)})`

describe.runIf(testBrowser)('the web UI in a real browser', () => {
  let ui: WebUi | undefined

  beforeAll(async () => {
    ui = await startWebUi()
  }, 120_000)

  afterEach(async () => {
    await ui?.closePages()
  })

  afterAll(async () => {
    await ui?.close()
  }, 60_000)

  it('loads under its content security policy with no console error, policy violation or exception', async () => {
    const page = await ui!.page()
    await page.waitFor(READY)
    // The session list is fetched after the picker is filled: let it land.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await page.unexpectedProblems()).toEqual([])

    // The positive control, after the assertion it controls: the policy is
    // live (no HTML-string sink may run), and a violation is exactly what the
    // tripwire catches.
    const sink = await page.evaluate<string>(`(() => { try { document.createElement('div').innerHTML = '<b>x</b>'; return 'assigned' } catch (error) { return error.name } })()`)
    expect(sink).toBe('TypeError')
    // The browser's own report arrives as a log entry, a moment after the throw.
    const deadline = Date.now() + 5000
    while (!page.problems.some((problem) => /TrustedHTML/.test(problem.text)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(page.problems.map((problem) => problem.text).join('\n')).toMatch(/TrustedHTML/)
  })

  it('sends a prompt typed into the box on Enter, and shows the answer in the transcript', async () => {
    const marker = `marker-${randomUUID()}`
    ui!.adapter.script(assistantText(`the answer is ${marker}`))
    const page = await ui!.page()
    await page.waitFor(READY)
    await page.type('#prompt', 'say the marker')
    await page.press('Enter')
    await page.waitFor(logHas(marker))
    expect(await page.evaluate<string>(`document.querySelector('#prompt').value`)).toBe('')
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('shows the head of a streamed answer while its message is not yet durable, then the whole of it', async () => {
    const marker = randomUUID()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    // The first answer opens the session in the page; only the open session's
    // stream is drawn, so the held one is the SECOND turn.
    ui!.adapter.script(assistantText(`opened ${marker}`), assistantTextPaused(`head-${marker} `, `tail-${marker}`, held))
    const page = await ui!.page()
    await page.waitFor(READY)
    await page.type('#prompt', 'open a session')
    await page.press('Enter')
    await page.waitFor(logHas(`opened ${marker}`))

    await page.type('#prompt', 'now stream')
    await page.press('Enter')
    await page.waitFor(logHas(`head-${marker}`))
    expect(await page.evaluate<boolean>(logHas(`tail-${marker}`))).toBe(false)
    // Mid-stream on the host too: the session's log holds no message carrying the head.
    const running = ui!.host.root
      .get(AGENTS)
      .list()
      .find((agent) => agent.status === 'running')
    expect(running, 'no agent is running the held turn').toBeDefined()
    const durable = running!.session.facts.filter((event) => matches(event, ASSISTANT_MESSAGE) && JSON.stringify(event.data).includes(`head-${marker}`))
    expect(durable).toEqual([])

    release()
    await page.waitFor(logHas(`head-${marker} tail-${marker}`))
    expect(await page.unexpectedProblems()).toEqual([])
  })
})
