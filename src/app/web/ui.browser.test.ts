/**
 * The browser client in a real browser, against the real web host
 * (`test-support/web-ui.ts`): it loads under its content security policy with
 * nothing on the console, a prompt typed and sent the way a person does it
 * reaches the model and its answer the transcript, and a streamed answer shows
 * while its message is not yet durable.
 *
 * The selectors are few on purpose: `#prompt`, `#log`, and the hero's version
 * pill as the sign that `initialize` has answered.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AGENTS } from '../../core/agent/index.ts'
import { ASSISTANT_MESSAGE, matches } from '../../core/session/index.ts'
import { expectBrowserSuite, testBrowser } from '../../test-support/browser-fixture.ts'
import { assistantMessage, assistantText, type MessagePart, assistantTextPaused, gate } from '../../test-support/scripted-adapter.ts'
import type { LlmRequest } from '../../core/llm/types.ts'
import type { EventEnvelope } from '../../core/session/index.ts'
import { TOOLS } from '../../core/tools/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { APPROVAL_ARMED, startWebUi, type WebUi } from '../../test-support/web-ui.ts'

expectBrowserSuite('web UI')

/** The page has connected and `initialize` has answered: the version it names is shown. */
const READY = `document.querySelector('.version-pill') !== null`
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

  // ---- the controls, held to the durable fact each click must produce --------

  /** The open session's id: the current crumb names it. */
  const openSessionId = (page: Awaited<ReturnType<WebUi['page']>>): Promise<string> => page.evaluate<string>("document.querySelector('.crumb.current')?.dataset.session ?? ''")
  const factsOf = (sessionId: string): readonly EventEnvelope[] => ui!.host.root.get(AGENTS).get(asSessionId(sessionId))?.session.facts ?? []
  /** Clicks the open menu's item whose own label is exactly the one given. */
  const choose = (label: string): string => "[...document.querySelectorAll('.menu .menu-item')].find((item) => item.querySelector('.text > span')?.textContent === " + JSON.stringify(label) + ').click()'
  const toolNamed = (card: string): string | undefined => ui!.host.root.get(TOOLS).list().find((tool) => tool.display?.card === card)?.name
  const OPEN_MENU = "document.querySelector('.menu') !== null"
  const DIALOG_OK = "dialog.modal[open] .btn.primary"

  it('opens a new session under the permission chosen before its first message', async () => {
    const page = await ui!.page()
    await page.waitFor(READY)
    await page.click('#composer-bar .chip')
    await page.waitFor(OPEN_MENU)
    await page.evaluate(choose('Read only'))
    await page.waitFor("document.querySelector('#composer-bar .chip').textContent.includes('Read only')")
    ui!.adapter.script(assistantText('read-only and ready'))
    await page.type('#prompt', 'look around')
    await page.press('Enter')
    await page.waitFor(logHas('read-only and ready'))
    const facts = factsOf(await openSessionId(page))
    const switched = facts.findIndex((event) => event.type === 'sandbox/mode' && (event.data as { mode: string }).mode === 'read-only')
    const firstTurn = facts.findIndex((event) => event.type === 'turn/start')
    expect(switched, 'the chosen mode is a durable switch').toBeGreaterThan(-1)
    expect(switched).toBeLessThan(firstTurn)
    // In sight, as a decision.
    expect(await page.evaluate<boolean>(logHas('Sandbox set to read-only'))).toBe(true)
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it("switches a live session's reasoning effort from the model chip, as one durable change", async () => {
    const page = await ui!.page()
    await page.waitFor(READY)
    ui!.adapter.script(assistantText('first answer'))
    await page.type('#prompt', 'hello')
    await page.press('Enter')
    await page.waitFor(logHas('first answer'))
    await page.click('#composer-bar [aria-label^="Model"]')
    await page.waitFor(OPEN_MENU)
    await page.evaluate(choose('low'))
    await page.waitFor(logHas('Model set to scripted/scripted-model · low'))
    const change = factsOf(await openSessionId(page)).find((event) => event.type === 'agent/options' && (event.data as { reason: string }).reason === 'change')
    expect((change?.data as { options: { reasoningEffort?: string } } | undefined)?.options.reasoningEffort).toBe('low')
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('revokes a session grant and stops a background job from the session panel', async () => {
    const shell = toolNamed('terminal')!
    const page = await ui!.page()
    await page.waitFor(READY)
    // A host that cannot confine the shell starts no job until the session accepts that.
    await page.click('#composer-bar .chip')
    await page.waitFor(OPEN_MENU)
    await page.evaluate(choose('Accept an unconfined shell'))
    await page.waitFor("document.querySelector('" + DIALOG_OK + "') !== null")
    await page.click(DIALOG_OK)
    // The choice is the page's until the first message carries it: wait until the chip shows it.
    await page.waitFor("document.querySelector('#composer-bar .chip').textContent.includes('shell none')")
    ui!.adapter.script(
      assistantMessage([{ call: ['g1', shell, { command: 'node --version', sandbox_permissions: 'danger-full-access', justification: 'checking the runtime outside the sandbox' }] }]),
      assistantMessage([{ call: ['g2', 'job_start', { command: 'node -e "setInterval(() => {}, 1000)"' }] }]),
      assistantText('granted and started'),
    )
    // What the card's answer button was the moment it was inserted, seen by
    // the page itself: the first sight of a card is never a live button.
    await page.evaluate(
      "window.armedAtFirstSight = undefined; new MutationObserver((records, observer) => { const button = document.querySelector('#approval .btn.primary'); if (button) { window.armedAtFirstSight = !button.disabled; observer.disconnect() } }).observe(document.querySelector('#approval'), { childList: true, subtree: true })",
    )
    await page.type('#prompt', 'check node and start a watcher')
    await page.press('Enter')
    await page.waitFor(APPROVAL_ARMED, 20_000)
    expect(await page.evaluate<boolean | undefined>('window.armedAtFirstSight')).toBe(false)
    // A double click's second press answers nothing: the card is still asking.
    await page.evaluate("document.querySelector('#approval .btn.primary').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await page.evaluate<boolean>("!document.querySelector('#approval').hidden")).toBe(true)
    await page.evaluate("[...document.querySelectorAll('#approval .btn')].find((b) => b.textContent === 'Allow for this session').click()")
    await page.waitFor(logHas('granted and started'), 30_000)
    const sessionId = await openSessionId(page)
    await page.click('#topbar [aria-label="Session details"]')
    await page.waitFor("document.querySelector('#panel [aria-label^=\"Revoke grant\"]') !== null && document.querySelector('#panel [aria-label^=\"Stop job\"]') !== null")
    await page.click('#panel [aria-label^="Revoke grant"]')
    await page.waitFor("document.querySelector('#panel [aria-label^=\"Revoke grant\"]') === null")
    expect(factsOf(sessionId).some((event) => event.type === 'approval/grant' && (event.data as { op: string }).op === 'revoke')).toBe(true)
    await page.click('#panel [aria-label^="Stop job"]')
    const deadline = Date.now() + 15_000
    while (!factsOf(sessionId).some((event) => event.type === 'job/end') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    const end = factsOf(sessionId).find((event) => event.type === 'job/end')?.data as { cause: string; by?: string } | undefined
    expect(end).toMatchObject({ cause: 'cancelled', by: 'user' })
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('follows the bottom across approvals answered mid-turn, and leaves a reader who scrolled up where they are', async () => {
    const shell = toolNamed('terminal')!
    const long = Array.from({ length: 40 }, (_, at) => `Line ${at}: what the agent is about to do next.`).join('\n\n')
    const widen = (callId: string, command: string): MessagePart => ({ call: [callId, shell, { command, sandbox_permissions: 'danger-full-access', justification: 'checking the runtime' }] })
    ui!.adapter.script(
      assistantMessage([{ text: long }, widen('f1', 'node --version')]),
      assistantMessage([{ text: 'A second check.' }, widen('f2', 'node -e "1"')]),
      assistantText(`${long}\n\nFollowed to the end.`),
    )
    const page = await ui!.page()
    await page.waitFor(READY)
    const gap = "(() => { const s = document.querySelector('#log'); return s.scrollHeight - s.scrollTop - s.clientHeight })()"
    await page.type('#prompt', 'run two checks')
    await page.press('Enter')
    // The card replaces the composer and goes again, twice: a transient
    // layout clamps the scroll, which is not the reader leaving (S22's live run).
    for (const round of [1, 2]) {
      await page.waitFor(APPROVAL_ARMED, 20_000)
      expect(await page.evaluate<number>(gap), `approval ${round} shown`).toBeLessThanOrEqual(40)
      await page.click('#approval .btn.primary')
      await page.waitFor("document.querySelector('#approval').hidden || document.querySelectorAll('#rows .system').length >= " + round, 20_000)
    }
    await page.waitFor(logHas('Followed to the end.'), 20_000)
    await page.waitFor(`${gap} <= 40`, 5_000)

    // A reader who scrolls up stays there while the next answer lands.
    ui!.adapter.script(assistantText(`${long}\n\nA reply the reader was not following.`))
    await page.evaluate("(() => { const s = document.querySelector('#log'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true })); s.scrollTop = 0 })()")
    await page.type('#prompt', 'once more')
    await page.press('Enter')
    // A person's own send takes them to the bottom; scrolling up after it is theirs.
    await page.waitFor(`${gap} <= 40`, 5_000)
    await page.evaluate("(() => { const s = document.querySelector('#log'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true })); s.scrollTop = 0 })()")
    await page.waitFor(logHas('A reply the reader was not following.'), 20_000)
    expect(await page.evaluate<number>("document.querySelector('#log').scrollTop")).toBe(0)
    expect(await page.evaluate<boolean>("!document.querySelector('#to-bottom').hidden")).toBe(true)
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('opens a child mid-delegation read-only, from the card that started it', async () => {
    const delegate = toolNamed('delegate')
    if (delegate === undefined) return
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const isChild = (request: LlmRequest) => JSON.stringify(request.messages).includes('hold the review')
    ui!.adapter.scriptWhen(isChild, [gate(held), ...assistantText('the review, done')])
    ui!.adapter.script(assistantMessage([{ call: ['d1', delegate, { description: 'Held review', prompt: 'hold the review' }] }]), assistantText('the parent resumed'))
    const page = await ui!.page()
    await page.waitFor(READY)
    await page.type('#prompt', 'delegate something')
    await page.press('Enter')
    await page.waitFor("document.querySelector('.child-link') !== null", 20_000)
    await page.click('.child-link')
    await page.waitFor("!document.querySelector('#readonly').hidden")
    expect(await page.evaluate<boolean>("document.querySelector('#composer').hidden")).toBe(true)
    expect(await page.evaluate<string>("document.querySelector('#readonly').textContent")).toMatch(/read-only/)
    release()
    // The child answers and the delegation ends: the host disposes it and says so in a view —
    // the page can drive it now, without being re-opened (`protocol/host.ts` onAgentDisposed).
    await page.waitFor(logHas('the review, done'), 20_000)
    await page.waitFor("document.querySelector('#readonly').hidden && !document.querySelector('#composer').hidden", 20_000)
    expect(await page.unexpectedProblems()).toEqual([])
  })
})
