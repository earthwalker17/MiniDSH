/**
 * The browser client in a real browser, against the real web host
 * (`test-support/web-ui.ts`): it loads under its content security policy with
 * nothing on the console, a prompt typed and sent the way a person does it
 * reaches the model and its answer the transcript, and a streamed answer shows
 * while its message is not yet durable.
 *
 * The selectors are few on purpose: `#prompt`, `#log`, and the hero's version
 * pill as the sign that `initialize` has answered.
 *
 * Time. A step waits for the HOST to do something (a turn, a card, a paint),
 * and the host shares this machine with the rest of a run, so every wait has
 * one generous bound (`STEP_MS`) and every test one above a few of them
 * (`TEST_MS`). Neither hides a hang: a wait that never comes true fails as
 * itself, naming the condition, long before the test's own bound. Where the
 * rule under test IS a duration (an arming delay), the page's own timer is
 * taken out of the clock's hands instead of being raced.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AGENTS } from '../../core/agent/index.ts'
import { asAttachmentId, ATTACHMENTS, type ImageMediaType } from '../../core/attachments/index.ts'
import { imageDescriptor } from '../../core/llm/content.ts'
import { ASSISTANT_MESSAGE, matches } from '../../core/session/index.ts'
import { expectBrowserSuite, testBrowser } from '../../test-support/browser-fixture.ts'
import { quadPng } from '../../test-support/images.ts'
import { assistantMessage, assistantText, type MessagePart, assistantTextPaused, assistantToolCall, gate } from '../../test-support/scripted-adapter.ts'
import type { LlmRequest } from '../../core/llm/types.ts'
import type { EventEnvelope } from '../../core/session/index.ts'
import { defineTool, TOOLS } from '../../core/tools/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { APPROVAL_ARMED, startWebUi, type UiPage, type WebUi } from '../../test-support/web-ui.ts'

expectBrowserSuite('web UI')

/** How long one step may take on a loaded host before it is a failure that names what never happened. */
const STEP_MS = 60_000
/** A whole test: several steps, so a stuck one fails as itself and not as this. */
const TEST_MS = 300_000

/** The page has connected and `initialize` has answered: the version it names is shown. */
const READY = `document.querySelector('.version-pill') !== null`
const logHas = (text: string): string => `document.querySelector('#log').textContent.includes(${JSON.stringify(text)})`
const ROWS_TEXT = "document.querySelector('#rows').textContent"
const ERROR_TOAST = "document.querySelector('#toasts .toast.error')"
/** The sidebar's row for a session: its tooltip names the id. */
const rowOf = (sessionId: string): string => `[...document.querySelectorAll('.session-row')].find((row) => row.title.includes(${JSON.stringify(sessionId)}))`

/**
 * A tap on the page's own socket, for the moments a real host never produces
 * on request: it records every method the page sends, can REFUSE the next
 * frame of one method (rewritten to a method the host does not know, so the
 * request is answered with an error over the real wire), can HOLD the next
 * frame of a set of methods until the test lets it go, and keeps the socket so
 * a test can drop the connection.
 */
const WIRE_TAP = `(() => {
  if (window.__tap) return
  const send = WebSocket.prototype.send
  const tap = (window.__tap = { sent: [], refuse: undefined, hold: undefined, release: undefined, socket: undefined })
  WebSocket.prototype.send = function (data) {
    tap.socket = this
    let frame
    try { frame = JSON.parse(data) } catch { return send.call(this, data) }
    tap.sent.push(frame.method)
    if (tap.refuse !== undefined && frame.method === tap.refuse) {
      tap.refuse = undefined
      return send.call(this, JSON.stringify({ ...frame, method: 'test/refused' }))
    }
    if (tap.hold !== undefined && tap.hold.includes(frame.method)) {
      tap.hold = undefined
      tap.release = () => { tap.release = undefined; send.call(this, data) }
      return
    }
    return send.call(this, data)
  }
})()`
const sentCount = (method: string): string => `window.__tap.sent.filter((sent) => sent === ${JSON.stringify(method)}).length`

/**
 * The page's arming timers (600 ms, `composer.js` and `approval.js`), taken
 * out of the clock's hands: held until the test fires them. A test of "not
 * yet armed" then cannot be overtaken by a slow host, nor "armed" be waited
 * for.
 */
const HOLD_ARMING = `(() => {
  if (window.__arming) return
  const real = window.setTimeout
  window.__arming = []
  // A negative id: clearing it clears nothing of the page's own.
  window.setTimeout = (callback, ms, ...rest) => (ms === 600 ? -window.__arming.push(callback) : real(callback, ms, ...rest))
})()`
const FIRE_ARMING = `window.__arming.splice(0).forEach((callback) => callback())`

describe.runIf(testBrowser)('the web UI in a real browser', { timeout: TEST_MS }, () => {
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

  /** A fresh page whose waits take the suite's step bound unless a call names its own. */
  const openPage = async (): Promise<UiPage> => {
    const page = await ui!.page()
    const wait = page.waitFor.bind(page)
    page.waitFor = (predicate, timeoutMs = STEP_MS) => wait(predicate, timeoutMs)
    await page.waitFor(READY)
    return page
  }

  /** Waits for a fact on the HOST's side of the wire, and says which one never came. */
  const untilHost = async (predicate: () => boolean, what: () => string): Promise<void> => {
    const deadline = Date.now() + STEP_MS
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out after ${STEP_MS} ms waiting on the host for ${what()}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('loads under its content security policy with no console error, policy violation or exception', async () => {
    const page = await openPage()
    // The session list is fetched after the picker is filled: let it land.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await page.unexpectedProblems()).toEqual([])

    // The positive control, after the assertion it controls: the policy is
    // live (no HTML-string sink may run), and a violation is exactly what the
    // tripwire catches.
    const sink = await page.evaluate<string>(`(() => { try { document.createElement('div').innerHTML = '<b>x</b>'; return 'assigned' } catch (error) { return error.name } })()`)
    expect(sink).toBe('TypeError')
    // The browser's own report arrives as a log entry, a moment after the throw.
    const deadline = Date.now() + STEP_MS
    while (!page.problems.some((problem) => /TrustedHTML/.test(problem.text)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(page.problems.map((problem) => problem.text).join('\n')).toMatch(/TrustedHTML/)
  })

  it('sends a prompt typed into the box on Enter, and shows the answer in the transcript', async () => {
    const marker = `marker-${randomUUID()}`
    ui!.adapter.script(assistantText(`the answer is ${marker}`))
    const page = await openPage()
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
    const page = await openPage()
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
  const openSessionId = (page: UiPage): Promise<string> => page.evaluate<string>("document.querySelector('.crumb.current')?.dataset.session ?? ''")
  const factsOf = (sessionId: string): readonly EventEnvelope[] => ui!.host.root.get(AGENTS).get(asSessionId(sessionId))?.session.facts ?? []
  /** How each of a session's turns ended, in order. */
  const turnEnds = (sessionId: string): string[] => factsOf(sessionId).flatMap((event) => (event.type === 'turn/end' ? [(event.data as { reason: { kind: string } }).reason.kind] : []))
  /** Clicks the open menu's item whose own label is exactly the one given. */
  const choose = (label: string): string => "[...document.querySelectorAll('.menu .menu-item')].find((item) => item.querySelector('.text > span')?.textContent === " + JSON.stringify(label) + ').click()'
  const toolNamed = (card: string): string | undefined => ui!.host.root.get(TOOLS).list().find((tool) => tool.display?.card === card)?.name
  const OPEN_MENU = "document.querySelector('.menu') !== null"
  const DIALOG_OK = "dialog.modal[open] .btn.primary"

  /**
   * One message sent and answered in the page: a new session, or one more turn
   * of the open one. `reply` is the model's whole answer; its first line is
   * what the page is watched for (markdown keeps no line breaks as text).
   */
  const exchange = async (page: UiPage, prompt: string, reply: string): Promise<string> => {
    const turnsBefore = (await openSessionId(page)) === '' ? 0 : turnEnds(await openSessionId(page)).length
    ui!.adapter.script(assistantText(reply))
    await page.type('#prompt', prompt)
    await page.press('Enter')
    await page.waitFor(logHas(reply.split('\n')[0]!))
    const sessionId = await openSessionId(page)
    await untilHost(() => turnEnds(sessionId).length === turnsBefore + 1 && ui!.host.root.get(AGENTS).get(asSessionId(sessionId))?.status === 'idle', () => `the turn that answered "${prompt}" to end (${turnEnds(sessionId).join(', ')})`)
    return sessionId
  }

  it('opens a new session under the permission chosen before its first message', async () => {
    const page = await openPage()
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
    const page = await openPage()
    ui!.adapter.script(assistantText('first answer'))
    await page.type('#prompt', 'hello')
    await page.press('Enter')
    await page.waitFor(logHas('first answer'))
    await page.click('#composer-bar [aria-label^="Model"]')
    await page.waitFor(OPEN_MENU)
    await page.evaluate(choose('low'))
    await page.waitFor(logHas('Model set to scripted/scripted-model · effort low'))
    const change = factsOf(await openSessionId(page)).find((event) => event.type === 'agent/options' && (event.data as { reason: string }).reason === 'change')
    expect((change?.data as { options: { reasoningEffort?: string } } | undefined)?.options.reasoningEffort).toBe('low')
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('revokes a session grant and stops a background job from the session panel', async () => {
    const shell = toolNamed('terminal')!
    const page = await openPage()
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
    await page.waitFor(APPROVAL_ARMED)
    expect(await page.evaluate<boolean | undefined>('window.armedAtFirstSight')).toBe(false)
    // A double click's second press answers nothing: the card is still asking.
    await page.evaluate("document.querySelector('#approval .btn.primary').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await page.evaluate<boolean>("!document.querySelector('#approval').hidden")).toBe(true)
    await page.evaluate("[...document.querySelectorAll('#approval .btn')].find((b) => b.textContent === 'Allow for this session').click()")
    await page.waitFor(logHas('granted and started'))
    const sessionId = await openSessionId(page)
    await page.click('#topbar [aria-label="Session details"]')
    await page.waitFor("document.querySelector('#panel [aria-label^=\"Revoke grant\"]') !== null && document.querySelector('#panel [aria-label^=\"Stop job\"]') !== null")
    await page.click('#panel [aria-label^="Revoke grant"]')
    await page.waitFor("document.querySelector('#panel [aria-label^=\"Revoke grant\"]') === null")
    expect(factsOf(sessionId).some((event) => event.type === 'approval/grant' && (event.data as { op: string }).op === 'revoke')).toBe(true)
    await page.click('#panel [aria-label^="Stop job"]')
    await untilHost(() => factsOf(sessionId).some((event) => event.type === 'job/end'), () => 'the stopped job to end')
    const end = factsOf(sessionId).find((event) => event.type === 'job/end')?.data as { cause: string; by?: string } | undefined
    expect(end).toMatchObject({ cause: 'cancelled', by: 'user' })
    expect(await page.unexpectedProblems()).toEqual([])
  })

  /**
   * The card's own rules, on the module the page runs (imported again from
   * the host, so it is the same instance): a new card is unanswerable for
   * longer than a double-click, a double click's second press never answers on
   * ANY of its buttons, and an earlier answer coming back does not enable a
   * card that took its place meanwhile. Sampled by timers of the page's own
   * clock, set before and after the card's: their order does not depend on how
   * loaded the host is.
   */
  it('arms an approval card only after a beat, never answers a double click, and keeps a card that replaced an answered one unarmed', async () => {
    const page = await openPage()
    const seen = await page.evaluate<{
      labels: string[]
      atFirstSight: boolean[]
      at300: boolean[]
      at900: boolean[]
      afterDoubleClicks: number
      answered: unknown[]
      whileAnswering: boolean[]
      nextAtFirstSight: boolean[]
      nextAfterTheReply: boolean[]
      nextArmed: boolean[]
    }>(`(async () => {
      const { createApproval } = await import('/approval.js')
      const host = document.createElement('div')
      document.body.append(host)
      const answers = []
      let settle
      const card = createApproval({ host, onAnswer: (open, outcome, offer) => { answers.push([open.id, outcome, offer ?? null]); return new Promise((resolve) => (settle = resolve)) } })
      const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const buttons = () => [...host.querySelectorAll('button')]
      const disabled = () => buttons().map((button) => button.disabled)
      const ask = (id) => ({ id, toolName: 'risky', subject: { effect: 'shell-command', command: 'make test', mode: 'danger-full-access', enforcement: 'none' }, offers: ['grant-session'] })
      const out = {}
      card.render([ask('a')])
      out.labels = buttons().map((button) => button.textContent)
      out.atFirstSight = disabled()
      await after(300)
      out.at300 = disabled()
      await after(600)
      out.at900 = disabled()
      for (const button of buttons()) button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
      out.afterDoubleClicks = answers.length
      buttons().find((button) => button.textContent === 'Allow once').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      out.answered = answers.slice()
      out.whileAnswering = disabled()
      card.render([ask('b')])
      out.nextAtFirstSight = disabled()
      settle()
      await after(50)
      out.nextAfterTheReply = disabled()
      await after(900)
      out.nextArmed = disabled()
      host.remove()
      return out
    })()`)
    const all = (value: boolean): boolean[] => [value, value, value]
    expect(seen.labels).toEqual(['Reject', 'Allow for this session', 'Allow once'])
    // Unanswerable at first sight and still at 300 ms; answerable past 600.
    expect(seen.atFirstSight, 'disabled when drawn').toEqual(all(true))
    expect(seen.at300, 'disabled 300 ms after it was drawn').toEqual(all(true))
    expect(seen.at900, 'enabled 900 ms after it was drawn').toEqual(all(false))
    // The second press of a double click, on each of the three: nothing.
    expect(seen.afterDoubleClicks, 'answers after a detail-2 click on every button').toBe(0)
    expect(seen.answered).toEqual([['a', 'allowed-once', null]])
    expect(seen.whileAnswering).toEqual(all(true))
    // The card for the NEXT question, drawn while that answer was in flight:
    // the reply to the old one leaves it as its own timer has it.
    expect(seen.nextAtFirstSight).toEqual(all(true))
    expect(seen.nextAfterTheReply, 'the replacing card, 50 ms after the earlier answer came back').toEqual(all(true))
    expect(seen.nextArmed, 'the replacing card, once its own delay passed').toEqual(all(false))
    expect(await page.unexpectedProblems()).toEqual([])
  })

  /**
   * An error names a remedy as often as not (a lock file to remove, a command
   * that salvages a log): it stays until the person dismisses it. Every timer
   * the toasts set is fired by hand, so "stays" is not a wait.
   */
  it('keeps an error on screen until it is dismissed, where a notice goes by itself', async () => {
    const page = await openPage()
    const seen = await page.evaluate<{ atOnce: string[]; afterTimers: string[]; afterDismiss: string[]; dismissLabels: (string | null)[] }>(`(async () => {
      const { toast } = await import('/ui.js')
      const real = window.setTimeout
      const timers = []
      window.setTimeout = (callback) => -timers.push(callback)
      try {
        toast('a notice that goes', 'notice')
        for (let at = 0; at < 5; at++) toast('error ' + at + ': if that process is gone, remove /sessions/s.jsonl.lock', 'error')
      } finally {
        window.setTimeout = real
      }
      const host = document.querySelector('#toasts')
      const shown = () => [...host.querySelectorAll('.toast')].map((node) => node.textContent)
      const out = { atOnce: shown() }
      for (const callback of timers) callback()
      out.afterTimers = shown()
      out.dismissLabels = [...host.querySelectorAll('.toast.error button')].map((button) => button.getAttribute('aria-label'))
      host.querySelector('.toast.error button')?.click()
      out.afterDismiss = shown()
      for (const node of host.querySelectorAll('.toast')) node.remove()
      return out
    })()`)
    const error = (at: number): string => `error ${at}: if that process is gone, remove /sessions/s.jsonl.lock`
    // The three newest errors are kept; older ones make room.
    expect(seen.atOnce).toEqual(['a notice that goes', error(2), error(3), error(4)])
    // Every timer has fired: the notice went, no error did.
    expect(seen.afterTimers, 'toasts left once every timer they set had fired').toEqual([error(2), error(3), error(4)])
    expect(seen.dismissLabels).toEqual(['Dismiss', 'Dismiss', 'Dismiss'])
    expect(seen.afterDismiss).toEqual([error(3), error(4)])
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
    const page = await openPage()
    const gap = "(() => { const s = document.querySelector('#log'); return s.scrollHeight - s.scrollTop - s.clientHeight })()"
    await page.type('#prompt', 'run two checks')
    await page.press('Enter')
    // The card replaces the composer and goes again, twice: a transient
    // layout clamps the scroll, which is not the reader leaving (S22's live run).
    for (const round of [1, 2]) {
      await page.waitFor(APPROVAL_ARMED)
      expect(await page.evaluate<number>(gap), `approval ${round} shown`).toBeLessThanOrEqual(40)
      // The second by keyboard, an arrow first: keys outside the log never leave the bottom.
      if (round === 1) await page.click('#approval .btn.primary')
      else {
        await page.evaluate("document.querySelector('#approval .btn.primary').focus()")
        await page.press('ArrowUp')
        await page.press('Enter')
      }
      await page.waitFor("document.querySelector('#approval').hidden || document.querySelectorAll('#rows .system').length >= " + round)
    }
    await page.waitFor(logHas('Followed to the end.'))
    await page.waitFor(`${gap} <= 40`)

    // A reader who scrolls up stays there while the next answer lands.
    ui!.adapter.script(assistantText(`${long}\n\nA reply the reader was not following.`))
    await page.evaluate("(() => { const s = document.querySelector('#log'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true })); s.scrollTop = 0 })()")
    await page.type('#prompt', 'once more')
    await page.press('Enter')
    // A person's own send takes them to the bottom; scrolling up after it is theirs.
    await page.waitFor(`${gap} <= 40`)
    await page.evaluate("(() => { const s = document.querySelector('#log'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true })); s.scrollTop = 0 })()")
    await page.waitFor(logHas('A reply the reader was not following.'))
    expect(await page.evaluate<number>("document.querySelector('#log').scrollTop")).toBe(0)
    expect(await page.evaluate<boolean>("!document.querySelector('#to-bottom').hidden")).toBe(true)
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('opens a child mid-delegation read-only, from the card that started it', async () => {
    const delegate = toolNamed('delegate')
    // Not a reason to pass: without it nothing below checks that a child is read-only.
    expect(delegate, 'the web composition mounts a tool that declares the delegate card').toBeDefined()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const isChild = (request: LlmRequest) => JSON.stringify(request.messages).includes('hold the review')
    ui!.adapter.scriptWhen(isChild, [gate(held), ...assistantText('the review, done')])
    ui!.adapter.script(assistantMessage([{ call: ['d1', delegate!, { description: 'Held review', prompt: 'hold the review' }] }]), assistantText('the parent resumed'))
    const page = await openPage()
    await page.type('#prompt', 'delegate something')
    await page.press('Enter')
    await page.waitFor("document.querySelector('.child-link') !== null")
    await page.click('.child-link')
    await page.waitFor("!document.querySelector('#readonly').hidden")
    expect(await page.evaluate<boolean>("document.querySelector('#composer').hidden")).toBe(true)
    expect(await page.evaluate<string>("document.querySelector('#readonly').textContent")).toMatch(/read-only/)
    release()
    // The child answers and the delegation ends: the host disposes it and says so in a view —
    // the page can drive it now, without being re-opened (`protocol/host.ts` onAgentDisposed).
    await page.waitFor(logHas('the review, done'))
    await page.waitFor("document.querySelector('#readonly').hidden && !document.querySelector('#composer').hidden")
    expect(await page.unexpectedProblems()).toEqual([])
  })

  // ---- the moments between two states ---------------------------------------------

  /**
   * Send becomes Stop on the same button, as soon as the host says the turn
   * runs: inside a double-click. For a beat after a send, Stop is drawn and
   * takes no click; after it, it stops.
   */
  it('does not let the click that sent also stop the turn, and stops it once Stop has armed', async () => {
    const marker = randomUUID()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const page = await openPage()
    const sessionId = await exchange(page, 'open a session', `opened ${marker}`)
    ui!.adapter.script(
      assistantTextPaused(`head-${marker} `, `tail-${marker}`, held),
      // Streams its head, then holds until the cancel aborts it.
      (request: LlmRequest) => assistantTextPaused(`busy-${marker} `, 'never shown', new Promise((resolve) => request.signal?.addEventListener('abort', () => resolve(undefined)))),
    )
    const SEND = "document.querySelector('#composer-bar .send')"
    const STOP_SHOWN = `${SEND}.getAttribute('aria-label') === 'Stop the turn'`
    await page.evaluate(WIRE_TAP)
    await page.evaluate(HOLD_ARMING)
    try {
      await page.type('#prompt', 'now stream')
      await page.click('#composer-bar .send')
      await page.waitFor(logHas(`head-${marker}`))
      // The turn runs and the button says Stop, however long that took to arrive: it takes no click yet.
      await page.waitFor(STOP_SHOWN)
      await page.click('#composer-bar .send')
      expect(await page.evaluate<string[]>('window.__tap.sent'), 'frames the page sent after the second click').not.toContain('session/cancel')
      expect(await page.evaluate<boolean>(`${SEND}.disabled`), 'Stop, a moment after the click that sent').toBe(true)
      // The beat passes: Stop is live, and the turn it did not stop finishes.
      await page.evaluate(FIRE_ARMING)
      await page.waitFor(`${STOP_SHOWN} && !${SEND}.disabled`)
    } finally {
      // Whatever happened above, the held turn is let go: a host with a turn nobody releases is slow to close.
      release()
    }
    await page.waitFor(logHas(`head-${marker} tail-${marker}`))
    await untilHost(() => turnEnds(sessionId).length === 2, () => `the held turn to end (${turnEnds(sessionId).join(', ')})`)
    expect(turnEnds(sessionId)).toEqual(['completed', 'completed'])
    // And an armed Stop stops.
    await page.type('#prompt', 'run until stopped')
    await page.press('Enter')
    await page.waitFor(logHas(`busy-${marker}`))
    await page.evaluate(FIRE_ARMING)
    await page.waitFor(`${STOP_SHOWN} && !${SEND}.disabled`)
    await page.click('#composer-bar .send')
    await untilHost(() => turnEnds(sessionId).length === 3, () => `the stopped turn to end (${turnEnds(sessionId).join(', ')})`)
    expect(turnEnds(sessionId).at(-1)).toBe('cancelled')
    expect(await page.evaluate<number>(sentCount('session/cancel'))).toBe(1)
    expect(await page.unexpectedProblems()).toEqual([])
  })

  /**
   * A connection that has just opened watches everything, so a question asked
   * then is parked for it. The handshake narrows it; done before it
   * subscribes, that narrowing settled the question `unavailable` a moment
   * before the page would have shown it. And what a reconnect replaces is the
   * window, never what the person had opened in it.
   */
  it('keeps a question asked while it reconnects, and the card a person had opened', async () => {
    const shell = toolNamed('terminal')!
    const marker = randomUUID()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    ui!.adapter.script(
      assistantMessage([{ call: ['e1', 'str_replace_editor', { command: 'create', path: `note-${marker}.txt`, file_text: `kept open ${marker}` }] }]),
      assistantText(`opened ${marker}`),
      [gate(held), ...assistantMessage([{ call: ['r1', shell, { command: 'node --version', sandbox_permissions: 'danger-full-access', justification: 'checking the runtime' }] }])],
      assistantText(`answered after the reconnect ${marker}`),
    )
    const page = await openPage()
    await page.type('#prompt', 'make a note')
    await page.press('Enter')
    await page.waitFor(logHas(`opened ${marker}`))
    const sessionId = await openSessionId(page)
    await untilHost(() => turnEnds(sessionId).length === 1, () => 'the first turn to end')
    // The card of the call that wrote the file, opened by the person.
    const OPENED_CARD = `[...document.querySelectorAll('#rows .process .card')].some((card) => card.textContent.includes(${JSON.stringify(`kept open ${marker}`)}))`
    await page.click('#rows .process button.row')
    await page.waitFor(OPENED_CARD)

    await page.evaluate(WIRE_TAP)
    let lists = 0
    try {
      await page.type('#prompt', 'check the runtime')
      await page.press('Enter')
      await untilHost(() => factsOf(sessionId).filter((event) => event.type === 'turn/start').length === 2, () => 'the second turn to start')
      // The connection drops, and the next one is stopped between `initialize`
      // and whichever of its next two steps comes first.
      lists = await page.evaluate<number>(sentCount('sessions/list'))
      await page.evaluate("window.__tap.hold = ['session/detach', 'control/subscribe']; window.__tap.socket.close()")
      await page.waitFor('window.__tap.release !== undefined')
    } finally {
      // Connected, neither narrowed nor subscribed: the model asks now. (Let go on any path: a held turn keeps the host from closing.)
      release()
    }
    await untilHost(() => factsOf(sessionId).some((event) => event.type === 'approval/asked'), () => 'the question asked during the handshake')
    await page.evaluate('window.__tap.release()')
    // The handshake ends with the list it refreshes.
    await page.waitFor(`${sentCount('sessions/list')} > ${lists}`)
    expect(
      factsOf(sessionId).filter((event) => event.type === 'approval/decided').map((event) => event.data),
      'decisions made while the page was reconnecting',
    ).toEqual([])
    // It is the page's to answer, and it is on the page.
    await page.waitFor(APPROVAL_ARMED)
    expect(await page.evaluate<boolean>(OPENED_CARD), 'the card opened before the reconnect is still open').toBe(true)
    await page.click('#approval .btn.primary')
    await page.waitFor(logHas(`answered after the reconnect ${marker}`))
    expect(await page.unexpectedProblems()).toEqual([])
  })

  /** Two sessions made in one page, the second left open: `[first, second]` with a marker each holds. */
  const twoSessions = async (page: UiPage): Promise<{ alpha: string; beta: string; inAlpha: string; inBeta: string }> => {
    const inAlpha = `alpha ${randomUUID()}`
    const inBeta = `beta ${randomUUID()}`
    const alpha = await exchange(page, 'the first session', inAlpha)
    await page.click('#new')
    await page.waitFor("!document.querySelector('#hero').hidden")
    const beta = await exchange(page, 'the second session', inBeta)
    expect(beta).not.toBe(alpha)
    await page.waitFor(`${rowOf(alpha)} !== undefined && ${rowOf(beta)} !== undefined`)
    return { alpha, beta, inAlpha, inBeta }
  }

  it('never shows the session it left under the name of the one being opened, nor of one it could not open', async () => {
    const page = await openPage()
    const { alpha, beta, inAlpha, inBeta } = await twoSessions(page)
    await page.evaluate(WIRE_TAP)
    // Opening the first again, its page held on the way: the name changes at
    // once, and the transcript of the session being left goes with it.
    await page.evaluate("window.__tap.hold = ['session/attach']")
    await page.evaluate(`${rowOf(alpha)}.click()`)
    await page.waitFor('window.__tap.release !== undefined')
    expect(await openSessionId(page)).toBe(alpha)
    expect(await page.evaluate<string>(ROWS_TEXT), 'the transcript under the new name, before its page arrived').toBe('')
    await page.evaluate('window.__tap.release()')
    await page.waitFor(logHas(inAlpha))
    expect(await page.evaluate<boolean>(logHas(inBeta))).toBe(false)

    // Back to the second, then to the first with its attach REFUSED.
    await page.evaluate(`${rowOf(beta)}.click()`)
    await page.waitFor(logHas(inBeta))
    await page.evaluate("window.__tap.refuse = 'session/attach'")
    await page.evaluate(`${rowOf(alpha)}.click()`)
    await page.waitFor(`${ERROR_TOAST} !== null`)
    // Nothing is open: not the second's transcript under the first's name, and
    // no composer addressed to a session the page does not show.
    expect(await page.evaluate<string>(ROWS_TEXT), 'the transcript after the refused open').toBe('')
    expect(await openSessionId(page), 'the session the page says is open').toBe('')
    expect(await page.evaluate<string>('document.title')).toBe('MiniDSH')
    expect(await page.evaluate<boolean>("document.querySelector('.session-row[aria-current=\"page\"]') === null"), 'no row is marked current').toBe(true)
    expect(await page.evaluate<boolean>("!document.querySelector('#hero').hidden"), 'the new-session page is what is left').toBe(true)
    // The session is still there to open.
    await page.evaluate(`${rowOf(alpha)}.click()`)
    await page.waitFor(logHas(inAlpha))
    expect(await openSessionId(page)).toBe(alpha)
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('paints nothing from a session the person has already left', async () => {
    const page = await openPage()
    const { alpha, beta, inAlpha, inBeta } = await twoSessions(page)
    await page.evaluate(WIRE_TAP)
    // A click on the first, whose page is slow; a second click back before it arrives.
    await page.evaluate("window.__tap.hold = ['session/attach']")
    await page.evaluate(`${rowOf(alpha)}.click()`)
    await page.waitFor('window.__tap.release !== undefined')
    const detaches = await page.evaluate<number>(sentCount('session/detach'))
    await page.evaluate(`${rowOf(beta)}.click()`)
    await page.waitFor(logHas(inBeta))
    // The slow page arrives now, for a window nobody shows. The client says
    // so by detaching it again: that frame is the sign the late answer ran.
    const before = await page.evaluate<number>(sentCount('session/detach'))
    expect(before).toBeGreaterThan(detaches)
    await page.evaluate('window.__tap.release()')
    await page.waitFor(`${sentCount('session/detach')} > ${before}`)
    expect(await openSessionId(page)).toBe(beta)
    expect(await page.evaluate<boolean>(logHas(inBeta)), 'the open session is still shown').toBe(true)
    expect(await page.evaluate<boolean>(logHas(inAlpha)), 'the session left behind painted into it').toBe(false)
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it('does not hand a first message back as failed when only opening its session failed', async () => {
    const marker = randomUUID()
    const message = `a first message ${marker}`
    ui!.adapter.script(assistantText(`delivered ${marker}`))
    const page = await openPage()
    await page.evaluate(WIRE_TAP)
    // The prompt is accepted; the attach that would show its session is refused.
    await page.evaluate("window.__tap.refuse = 'session/attach'")
    await page.type('#prompt', message)
    await page.press('Enter')
    await page.waitFor(`${ERROR_TOAST} !== null`)
    // Not handed back: a second Enter would deliver the same message again.
    expect(await page.evaluate<string>("document.querySelector('#prompt').value"), 'the composer after the failed open').toBe('')
    // And the failure is said as what it was.
    expect(await page.evaluate<string>(`${ERROR_TOAST}.textContent`)).toMatch(/^Your message was sent, but its session could not be shown: /)
    const delivered = () => ui!.host.root.get(AGENTS).list().filter((agent) => agent.session.facts.some((event) => event.type === 'user/message' && JSON.stringify(event.data).includes(marker)))
    await untilHost(() => delivered().length === 1 && turnEnds(delivered()[0]!.id).length === 1, () => `the message to be delivered once and answered (${delivered().length} sessions hold it)`)
    expect(delivered(), 'sessions holding the message').toHaveLength(1)
    // The list names its session, and opening it shows the message once and its answer.
    const sessionId = delivered()[0]!.id
    await page.waitFor(`${rowOf(sessionId)} !== undefined`)
    await page.evaluate(`${rowOf(sessionId)}.click()`)
    await page.waitFor(logHas(`delivered ${marker}`))
    expect(await page.evaluate<number>(`document.querySelector('#log').textContent.split(${JSON.stringify(message)}).length - 1`), 'times the message is on the page').toBe(1)
    expect(await page.unexpectedProblems()).toEqual([])
  })

  /**
   * An image a call produced: its reference is in the log, its bytes come
   * through the host (`attachment/read`) and are shown from a blob URL, which
   * the page's policy must allow (`img-src blob:`). The tool is registered
   * here, with the shape `view_image` has: this host mounts no producer of
   * images, and the path under test starts at the result's image block.
   */
  it('draws an image a call produced, read through the host and shown under the page policy', async () => {
    const marker = randomUUID()
    const root = ui!.host.root
    const attachments = root.get(ATTACHMENTS)
    const tool = `draw_${marker.slice(0, 8)}`
    root.get(TOOLS).register(
      root,
      defineTool({
        name: tool,
        description: 'draws a square of four colours',
        input: z.object({}),
        output: z.object({ attachment: z.object({ id: z.string(), mediaType: z.string(), bytes: z.number(), width: z.number(), height: z.number() }), text: z.string() }),
        display: { card: 'image', title: 'View image' },
        render: (_args, value) => [
          {
            type: 'image',
            attachment: { id: asAttachmentId(value.attachment.id), mediaType: value.attachment.mediaType as ImageMediaType, bytes: value.attachment.bytes, width: value.attachment.width, height: value.attachment.height },
            text: value.text,
          },
        ],
        execute: async () => {
          const ref = await attachments.saveImage({ data: quadPng(96) })
          return { attachment: { id: ref.id, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }, text: imageDescriptor(ref) }
        },
      }),
    )
    ui!.adapter.script(assistantToolCall('i1', tool, {}), assistantText(`drawn ${marker}`))
    const page = await openPage()
    await page.type('#prompt', 'draw it')
    await page.press('Enter')
    await page.waitFor(logHas(`drawn ${marker}`))
    const IMG = "document.querySelector('#rows .thumb img')"
    await page.waitFor(`${IMG} !== null`)
    // Fetched from the host, not linked: a blob of this page's own, and it decodes to the picture that was drawn.
    await page.waitFor(`${IMG}.src.startsWith('blob:')`)
    await page.waitFor(`${IMG}.complete && ${IMG}.naturalWidth === 96 && ${IMG}.naturalHeight === 96`)
    // No policy report: a refused `img-src` would be one.
    expect(await page.unexpectedProblems()).toEqual([])
  })

  it("loads an older page above what is shown, in the log's order, and keeps the reader's place", async () => {
    const marker = randomUUID()
    // Past the host's page of fifty messages, each turn tall enough that the start is far above the fold.
    const turns = 28
    const body = Array.from({ length: 8 }, (_unused, at) => `Paragraph ${at} of a reply long enough to fill the page.`).join('\n\n')
    const writer = await openPage()
    let sessionId = ''
    for (let at = 0; at < turns; at++) sessionId = await exchange(writer, `ask-${at}-${marker}`, `reply-${at}-${marker}\n\n${body}`)

    // A second page opens it cold: the newest page of the log, and more above.
    const reader = await openPage()
    await reader.waitFor(`${rowOf(sessionId)} !== undefined`)
    await reader.evaluate(`${rowOf(sessionId)}.click()`)
    await reader.waitFor(logHas(`reply-${turns - 1}-${marker}`))
    expect(await reader.evaluate<boolean>("document.querySelector('#more').hidden"), 'more history is offered').toBe(false)
    expect(await reader.evaluate<boolean>(logHas(`ask-0-${marker}`)), 'the first turn is not loaded yet').toBe(false)
    // The reader goes to the top; what they see there is their place.
    const PLACE = `(() => {
      const scroller = document.querySelector('#log')
      const edge = scroller.getBoundingClientRect().top
      const first = [...document.querySelector('#rows').children].find((node) => node.getBoundingClientRect().bottom > edge)
      return { key: first.dataset.key, top: Math.round(first.getBoundingClientRect().top - edge) }
    })()`
    const before = await reader.evaluate<{ key: string; top: number }>(`(() => {
      const scroller = document.querySelector('#log')
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }))
      scroller.scrollTop = 0
      return ${PLACE}
    })()`)
    await reader.waitFor(logHas(`ask-0-${marker}`))
    await reader.waitFor("document.querySelector('#more').hidden && !document.querySelector('#history-start').hidden")
    // Every turn once, oldest first: the older page went in at the head.
    const order = await reader.evaluate<number[]>(`[...${ROWS_TEXT}.matchAll(/ask-(\\d+)-${marker}/g)].map((match) => Number(match[1]))`)
    expect(order, 'the turns on the page, top to bottom').toEqual(Array.from({ length: turns }, (_unused, at) => at))
    // And the block the reader was looking at is where it was.
    const after = await reader.evaluate<{ key: string; top: number } | null>(`(() => {
      const scroller = document.querySelector('#log')
      const node = [...document.querySelector('#rows').children].find((one) => one.dataset.key === ${JSON.stringify(before.key)})
      return node ? { key: node.dataset.key, top: Math.round(node.getBoundingClientRect().top - scroller.getBoundingClientRect().top) } : null
    })()`)
    expect(after, `the block the reader was on (${before.key}) is still on the page`).not.toBeNull()
    expect(Math.abs(after!.top - before.top), `that block moved from ${before.top}px to ${after!.top}px below the top`).toBeLessThanOrEqual(2)
    expect(await reader.unexpectedProblems()).toEqual([])
  })

  // The settings dialog's two rules for the host's defaults (settings.js): a
  // save names the revision the page was SHOWN, and it replaces the user layer
  // with what the fields hold, so a field a person cleared clears its override
  // instead of leaving the old one standing. Read off the frames the page
  // sends and off what the host then shows a page that asks again.
  it('saves a default for new sessions under the revision it was shown, and a cleared field clears the override', async () => {
    const page = await openPage()
    await page.evaluate(`(() => {
      const send = WebSocket.prototype.send
      window.__settingsSet = []
      WebSocket.prototype.send = function (data) {
        window.__socket = this
        try {
          const frame = JSON.parse(data)
          if (frame.method === 'settings/set') window.__settingsSet.push(frame.params)
        } catch {}
        return send.call(this, data)
      }
    })()`)
    const FIELD = `document.querySelector('#settings input[data-key="maxSteps"]')`
    const SAVE = `[...document.querySelectorAll('#settings .modal-actions .btn.primary')].find((button) => button.textContent === 'Save')`
    interface Shown {
      readonly ns: string
      readonly value: string
      readonly revision: number
    }
    /** Opens Settings on the host's defaults, read fresh from the host, and says what the field shows. */
    const openDefaults = async (): Promise<Shown> => {
      await page.click('#sidebar-foot .foot-btn[aria-label="Settings"]')
      await page.waitFor("document.querySelector('#settings').open")
      await page.evaluate(`[...document.querySelectorAll('#settings .nav-item')].find((item) => item.textContent === 'New sessions').click()`)
      await page.waitFor(`${FIELD} !== null`)
      return JSON.parse(await page.evaluate<string>(`JSON.stringify({ ns: ${FIELD}.dataset.ns, value: ${FIELD}.value, revision: Number(${FIELD}.dataset.revision) })`)) as Shown
    }
    /**
     * Saves, and returns the frame sent for `ns` once the save has closed the
     * dialog AND the page has heard everything it was waiting for: a request of
     * the test's own goes out on the page's socket behind whatever the page had
     * in flight, and answers come back in order, so when it is home every
     * earlier answer has been handled. No sleep stands in for "nothing more is
     * coming", which is what a refresh that reopens the dialog would need.
     */
    const save = async (ns: string): Promise<{ ns: string; patch: Record<string, unknown>; expectedRevision: number; replace: boolean }> => {
      await page.evaluate('window.__settingsSet.length = 0; window.__dialog.length = 0; window.__home = false')
      await page.evaluate(`${SAVE}.click()`)
      await page.waitFor(`window.__dialog.includes('close') || ${ERROR_TOAST} !== null`)
      expect(await page.evaluate<string>(`${ERROR_TOAST}?.innerText ?? ''`), 'the save was refused').toBe('')
      await page.evaluate('window.__roundTrip()')
      await page.waitFor('window.__home === true')
      expect(
        JSON.parse(await page.evaluate<string>(`JSON.stringify({ dialog: window.__dialog, open: document.querySelector('#settings').open })`)),
        'a saved dialog closes and stays closed: nothing the save itself set off may bring it back',
      ).toEqual({ dialog: ['close'], open: false })
      const frames = JSON.parse(await page.evaluate<string>('JSON.stringify(window.__settingsSet)')) as { ns: string; patch: Record<string, unknown>; expectedRevision: number; replace: boolean }[]
      const sent = frames.filter((frame) => frame.ns === ns)
      expect(sent, `settings/set frames for ${ns}: ${JSON.stringify(frames)}`).toHaveLength(1)
      return sent[0]!
    }

    const first = await openDefaults()
    // What the dialog is told to do, in order (a save that closes it and a
    // refresh that reopens it look the same a moment later), and a round trip
    // of the test's own on the socket the page uses.
    await page.evaluate(`(() => {
      const dialog = document.querySelector('#settings')
      const calls = (window.__dialog = [])
      const close = dialog.close.bind(dialog)
      const showModal = dialog.showModal.bind(dialog)
      dialog.close = () => { calls.push('close'); close() }
      dialog.showModal = () => { calls.push('showModal'); showModal() }
      let next = 9_000_000
      window.__roundTrip = () => {
        const id = ++next
        const socket = window.__socket
        const heard = (event) => {
          if (JSON.parse(event.data).id !== id) return
          socket.removeEventListener('message', heard)
          window.__home = true
        }
        socket.addEventListener('message', heard)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'settings/describe' }))
      }
    })()`)
    expect(first.value, 'this host starts with no override of its own').toBe('')
    await page.type('#settings input[data-key="maxSteps"]', '41')
    const written = await save(first.ns)
    expect({ expectedRevision: written.expectedRevision, replace: written.replace, maxSteps: written.patch.maxSteps }, 'a number, under the revision the page read').toEqual({ expectedRevision: first.revision, replace: true, maxSteps: 41 })

    // Asked again, the host shows what was saved, under its next revision.
    const second = await openDefaults()
    expect(second).toEqual({ ns: first.ns, value: '41', revision: first.revision + 1 })
    // The field cleared: the save carries no value for it, and the override is gone.
    await page.evaluate(`${FIELD}.value = ''`)
    const cleared = await save(first.ns)
    expect({ expectedRevision: cleared.expectedRevision, replace: cleared.replace, hasMaxSteps: 'maxSteps' in cleared.patch }).toEqual({ expectedRevision: second.revision, replace: true, hasMaxSteps: false })
    const third = await openDefaults()
    expect(third, 'the override a person cleared is still standing').toEqual({ ns: first.ns, value: '', revision: second.revision + 1 })
    await page.evaluate("document.querySelector('#settings').close()")
    expect(await page.unexpectedProblems()).toEqual([])
  })
})
