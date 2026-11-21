/**
 * The line view against a SCRIPTED host: the real view, controller and
 * protocol client over a stream pair whose far end the test plays, frame by
 * frame. `terminal.test.ts` runs the real host, where an answer is never
 * refused and nothing else decides a question; the rules held here are the
 * ones that only show when the host says no, or says something at a moment of
 * its choosing:
 *
 * - a refused answer leaves the question standing, so it is asked again;
 * - a consent is a line of its OWN: one a person typed before the question was
 *   printed, or as it replaced one settled elsewhere, answers nothing. A pipe's
 *   lines are a script's, read at once by design, and do answer.
 *
 * The clock is the test's (`Date` alone is faked): the type-ahead rules compare
 * when a line was read with when a question was printed.
 */
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '../../capabilities/protocol/index.ts'
import { ProtocolClient } from './client.ts'
import { SessionController } from './controller.ts'
import { createLineView } from './line.ts'

interface Request {
  readonly id: number
  readonly method: string
  readonly params: Record<string, unknown> | undefined
}

const SUBJECT = { effect: 'shell-command', command: 'make test', mode: 'danger-full-access', enforcement: 'none' } as const
const AUTHORITY = { sandbox: 'workspace-write', approval: 'ask', enforcement: 'none', accepts: 'full', grants: [] } as const
const view = (pending: readonly { id: string; offers?: readonly 'grant-session'[] }[], status: 'idle' | 'running' = 'running'): SessionView => ({
  status,
  pendingApprovals: pending.map((entry) => ({ id: entry.id, toolName: 'risky', subject: SUBJECT, ...(entry.offers === undefined ? {} : { offers: entry.offers }) })),
  authority: AUTHORITY,
  jobs: [],
})

/** Not `Date`: that one is the test's to move. */
async function waitFor(predicate: () => boolean, what: () => string, timeoutMs = 4000): Promise<void> {
  const start = performance.now()
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what()}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** The line view over a host the test plays. */
function scripted(options: { echoes: boolean }) {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const input = new PassThrough()
  const output = new PassThrough()
  const requests: Request[] = []
  let taken = 0
  let unread = ''
  toHost.on('data', (chunk: Buffer) => {
    unread += String(chunk)
    for (let at = unread.indexOf('\n'); at !== -1; at = unread.indexOf('\n')) {
      requests.push(JSON.parse(unread.slice(0, at)) as Request)
      unread = unread.slice(at + 1)
    }
  })
  let text = ''
  output.on('data', (chunk: Buffer) => {
    text += String(chunk)
  })
  let exited: number | undefined
  const lineView = createLineView({ input, output, echoes: options.echoes, handleSigint: false, banner: () => 'scripted host\n', exit: async (code) => void (exited = code) })
  let route: (method: string, params: unknown) => void = () => {}
  const client = new ProtocolClient(fromHost, toHost, { onNotification: (method, params) => route(method, params) })
  const controller = new SessionController(client, lineView.hooks)
  route = (method, params) => controller.onNotification(method, params)
  void lineView.run(controller)

  const send = (frames: readonly unknown[]): void => void fromHost.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''))
  let seq = 0
  const event = (type: string, data: unknown): unknown => ({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 's1', event: { type, seq: ++seq, time: 1, data } } })
  const host = {
    requests,
    /** The next request the test has not answered yet; it must be of this method. */
    next: async (method: string): Promise<Request> => {
      await waitFor(() => requests.length > taken, () => `a "${method}" request; the view shows:\n${text}`)
      const request = requests[taken++]!
      expect(request.method, `the request after ${taken - 1} others: ${JSON.stringify(request)}`).toBe(method)
      return request
    },
    reply: (request: Request, result: unknown): void => send([{ jsonrpc: '2.0', id: request.id, result }]),
    refuse: (request: Request, message: string): void => send([{ jsonrpc: '2.0', id: request.id, error: { code: -32602, message } }]),
    /** A question asked, with the view the host publishes in the same tick: one chunk, as one tick writes them. */
    ask: (id: string, offers?: readonly 'grant-session'[]): void =>
      send([event('approval/asked', { id, toolName: 'risky', subject: SUBJECT }), { jsonrpc: '2.0', method: 'session.view', params: { sessionId: 's1', view: view([{ id, ...(offers === undefined ? {} : { offers }) }]) } }]),
    /** A decision and the view after it, optionally with the next question right behind (one chunk). */
    decide: (id: string, decidedBy: string, then?: string): void =>
      send([
        event('approval/decided', { id, outcome: 'allowed-once', decidedBy }),
        { jsonrpc: '2.0', method: 'session.view', params: { sessionId: 's1', view: view([]) } },
        ...(then === undefined ? [] : [event('approval/asked', { id: then, toolName: 'risky', subject: SUBJECT }), { jsonrpc: '2.0', method: 'session.view', params: { sessionId: 's1', view: view([{ id: then }]) } }]),
      ]),
    /** Answers the handshake, a first message and its attach: the session `s1`, running, with `pending` open. */
    open: async (pending: readonly { id: string; offers?: readonly 'grant-session'[] }[] = []): Promise<void> => {
      host.reply(await host.next('session/prompt'), { sessionId: 's1', messageId: 'm1' })
      host.reply(await host.next('session/attach'), { header: { id: 's1' }, cursor: seq, page: { events: [], from: 0, to: -1, hasMore: false }, view: view(pending) })
    },
  }
  return {
    host,
    text: () => text,
    type: (line: string): void => void input.write(`${line}\n`),
    end: (): void => void input.end(),
    see: (needle: string): Promise<void> => waitFor(() => text.includes(needle), () => `"${needle}" in:\n${text}`),
    count: (needle: string): number => text.split(needle).length - 1,
    exited: () => exited,
    ready: async (): Promise<void> => {
      host.reply(await host.next('initialize'), {})
      host.reply(await host.next('control/subscribe'), { sessions: [] })
      await waitFor(() => text.includes('you> '), () => `the first prompt in:\n${text}`)
    },
  }
}

const QUESTION = 'approve risky — run `make test` under danger-full-access/none? '

afterEach(() => {
  vi.useRealTimers()
})

describe('the line view, when the host refuses an answer', () => {
  it('asks the question again, without the offer that was refused, and the next y answers it', async () => {
    const term = scripted({ echoes: false })
    await term.ready()
    term.type('go')
    await term.host.open()
    term.host.ask('approval-1', ['grant-session'])
    await term.see(`${QUESTION}[y/N/a] `)
    term.type('a')
    const first = await term.host.next('approval/answer')
    expect(first.params).toMatchObject({ sessionId: 's1', id: 'approval-1', outcome: 'allowed-once', offer: 'grant-session' })
    // The fold withdrew the offer after the prompt was printed: the host says no.
    term.host.refuse(first, 'approval/answer: "grant-session" is not offered on approval "approval-1"')
    await term.see('error: approval/answer: "grant-session" is not offered on approval "approval-1"')
    // The question still stands with the host, so it is on screen again, offering what is left.
    await term.see(`${QUESTION}[y/N] `)
    expect(term.count(QUESTION), term.text()).toBe(2)
    // And the next line is its answer: an `approval/answer`, never a message to the model.
    term.type('y')
    const second = await term.host.next('approval/answer')
    expect(second.params).toMatchObject({ id: 'approval-1', outcome: 'allowed-once' })
    expect(second.params).not.toHaveProperty('offer')
    term.host.reply(second, { outcome: 'accepted' })
    term.host.decide('approval-1', 'user')
    await term.see('! approval-1 allowed-once (by user)')
    expect(term.host.requests.filter((request) => request.method === 'session/prompt'), 'messages sent to the model').toHaveLength(1)
  })

  it('exits a piped run on the question that came back, instead of waiting on a turn nothing can move', async () => {
    const term = scripted({ echoes: false })
    await term.ready()
    term.type('go')
    await term.host.open()
    term.host.ask('approval-1', ['grant-session'])
    await term.see(`${QUESTION}[y/N/a] `)
    term.type('a')
    term.end()
    term.host.refuse(await term.host.next('approval/answer'), 'approval/answer: "grant-session" is not offered on approval "approval-1"')
    await waitFor(() => term.exited() !== undefined, () => `the exit; the view shows:\n${term.text()}`)
    // Stopped on a question nobody answered: not a finished task.
    expect(term.exited()).toBe(1)
    expect(term.text()).toContain(`${QUESTION}[y/N] `)
    expect(term.text()).toContain('(input ended with this question open; it stays unanswered)')
  })
})

describe('the line view: a consent is a line of its own', () => {
  it('does not take a line a person typed before the question was printed as its answer; a pipe\'s line is one', async () => {
    for (const echoes of [true, false]) {
      vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
      const term = scripted({ echoes })
      await term.ready()
      term.type('go')
      const prompt = await term.host.next('session/prompt')
      // Typed while the first message is still on its way: there is no question yet.
      term.type('y')
      // Read by the view (it stamps a line as it reads it) before the clock moves.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      vi.setSystemTime(1_005_000)
      term.host.reply(prompt, { sessionId: 's1', messageId: 'm1' })
      // The session opens already asking: the question is printed now, after that line was read.
      term.host.reply(await term.host.next('session/attach'), { header: { id: 's1' }, cursor: 0, page: { events: [], from: 0, to: -1, hasMore: false }, view: view([{ id: 'approval-1' }]) })
      await term.see(`${QUESTION}[y/N] `)
      if (echoes) {
        await term.see('(that answer was typed before this question appeared: answer this one)')
        // Asked again, and nothing was answered.
        await waitFor(() => term.count(QUESTION) === 2, () => `the question asked again:\n${term.text()}`)
        expect(term.host.requests.map((request) => request.method), 'no answer was sent').not.toContain('approval/answer')
        // A line typed AFTER it is its answer.
        vi.setSystemTime(1_010_000)
        term.type('y')
      }
      const answer = await term.host.next('approval/answer')
      expect(answer.params, `echoes ${echoes}`).toMatchObject({ id: 'approval-1', outcome: 'allowed-once' })
      expect(term.count('typed before this question appeared'), `echoes ${echoes}:\n${term.text()}`).toBe(echoes ? 1 : 0)
      vi.useRealTimers()
    }
  })

  it('says when a question was settled elsewhere, and does not take a line typed as the next one replaced it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 2_000_000 })
    const term = scripted({ echoes: true })
    await term.ready()
    term.type('go')
    await term.host.open()
    term.host.ask('approval-1')
    await term.see(`${QUESTION}[y/N] `)
    // Another client answers it, and the next question arrives in the same breath.
    vi.setSystemTime(2_010_000)
    term.host.decide('approval-1', 'user', 'approval-2')
    await term.see('(that question was settled elsewhere)')
    await waitFor(() => term.count(QUESTION) === 2, () => `the second question:\n${term.text()}`)
    // A `y` that lands 100 ms later was typed for the question that just went.
    vi.setSystemTime(2_010_100)
    term.type('y')
    await term.see('(that answer was typed as the question changed: answer this one)')
    await waitFor(() => term.count(QUESTION) === 3, () => `the question asked again:\n${term.text()}`)
    expect(term.host.requests.map((request) => request.method), 'no answer was sent').not.toContain('approval/answer')
    // Typed again, for this one: it answers it.
    vi.setSystemTime(2_011_000)
    term.type('y')
    expect((await term.host.next('approval/answer')).params).toMatchObject({ id: 'approval-2', outcome: 'allowed-once' })
  })
})
