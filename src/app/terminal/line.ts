/**
 * The line view: the terminal for a pipe, a script, a screen reader, or
 * `--plain`. One line at a time, nothing redrawn — what `minidsh chat` was
 * before S22.1, now drawn from the shared controller. Streaming text comes
 * from durable `assistant/chunk` events; every other line from the one
 * plain-text projection (`app/present.ts`, through `render.ts`).
 *
 * Its contract is the WIRE behaviour `terminal.test.ts` holds: lines strictly
 * serialized and none sent before the session is known (a piped second line
 * must not create a second, hidden session); a question asked once, by its
 * durable id, and skipped when already decided; `a` only where the host
 * offered it; the exit codes.
 */
import { createInterface } from 'node:readline'
import type { AuthorityView, InitializeResult, JobSummary } from '../../capabilities/protocol/index.ts'
import { jobStatus } from '../../capabilities/tool-jobs/index.ts'
import { describeIntent } from '../../core/effects/index.ts'
import { formatTokens } from '../../core/metering/index.ts'
import { printableText } from '../../core/text.ts'
import { preview } from '../present.ts'
import type { Ask, ContinueRequest, ControllerHooks, SessionController } from './controller.ts'
import { NotNow } from './controller.ts'
import { renderHistory, TerminalRenderer } from './render.ts'

/**
 * The shell-confinement half of a status line: what this host CAN enforce, and
 * — when it is weaker than the default — what this session has agreed to accept
 * from it. Saying only the first would hide the decision that made an
 * unconfined command possible in the first place.
 */
function confinementLine(view: AuthorityView): string {
  const accepted = view.accepts === 'full' ? '' : `, accepting ${view.accepts}`
  return `shell confinement: ${view.enforcement}${accepted}`
}

/**
 * The one line that tells a person how to stop being asked per call — and it
 * has to name the RIGHT answer for this host: where the shell cannot be
 * sandboxed, accepting that is narrower than dropping the file fence too;
 * where a scope is offered on this very ask, that is narrower still. And no
 * mode or preset stops a network request's prompt. Shown once.
 */
export function firstAskTip(offered: boolean, authority: AuthorityView | undefined): string {
  if (offered) return 'tip: y allows this once; a allows this exact call until this session is resumed or forked (/grants lists them, /revoke takes one back)\n'
  if (authority !== undefined && authority.enforcement === 'none' && authority.accepts === 'full') {
    return 'tip: this host cannot sandbox the shell. /accept none runs shell commands anyway and keeps file edits fenced; /preset danger-full-access drops the fence too; no preset or mode stops a network request\'s prompt\n'
  }
  return 'tip: approvals are one-shot; for shell commands, /preset danger-full-access (or /sandbox danger-full-access) grants the whole session and stops those prompts; no preset or mode stops a network request\'s prompt\n'
}

/** How soon after a question replaced a settled one an answer line is taken as meant for the old one. */
const REPLACED_MS = 600

/** How many sessions `/sessions` prints. A terminal has one screen; the CLI's own listing has all of them. */
const SESSIONS_SHOWN = 20

export interface LineViewOptions {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
  /** A real terminal echoes what is typed; an injected stream and a pipe do not. */
  readonly echoes: boolean
  /** Ctrl+C arrives as the process signal on a TTY (readline with `terminal: false` never emits it). */
  readonly handleSigint: boolean
  readonly continueRequest?: ContinueRequest
  readonly task?: string
  readonly banner: (init: InitializeResult) => string
  readonly exit: (code: number) => Promise<void>
}

/**
 * The line view and the hooks its controller is built with; `run` drives it
 * until `/exit`, the end of input or the host closing.
 */
export function createLineView(options: LineViewOptions): { hooks: ControllerHooks; run: (controller: SessionController) => Promise<void> } {
  const out = options.output
  const renderer = new TerminalRenderer()
  let controller!: SessionController
  let exiting = false
  /** Until the first page is drawn, nothing prompts. */
  let attached = options.continueRequest === undefined
  /** `you> ` is written and LEFT on the line; anything rendered under it breaks the line first. */
  let promptStanding = false
  let pendingAsk: Ask | undefined
  let tipped = false
  let lastInterrupt = 0
  /** When the standing question was printed, and when one was last settled elsewhere under the person's hands. */
  let askedAt = Number.NEGATIVE_INFINITY
  let settledElsewhereAt = Number.NEGATIVE_INFINITY
  /** Resolved whenever the session goes idle (the end of input waits on it). */
  const idleWaiters: (() => void)[] = []
  const untilIdle = (): Promise<void> => new Promise<void>((resolve) => idleWaiters.push(resolve))
  const stillWorking = (): boolean => !exiting && controller.status === 'running' && pendingAsk === undefined

  const prompt = (): void => {
    if (exiting || !attached || promptStanding) return
    out.write('you> ')
    promptStanding = true
  }
  const write = (text: string): void => {
    if (text.length === 0) return
    if (promptStanding) {
      out.write('\n')
      promptStanding = false
    }
    out.write(text)
  }
  const printError = (error: unknown): void => {
    write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  const reprompt = (): void => {
    if (controller.status === 'idle') prompt()
  }

  const hooks: ControllerHooks = {
    onEvent: (sessionId, event) => {
      if (sessionId !== controller.sessionId) return // a child's frames are the full-screen view's
      write(renderer.onEvent(event))
    },
    onStatus: (status) => {
      if (status !== 'idle') return
      for (const wake of idleWaiters.splice(0)) wake()
      if (attached && pendingAsk === undefined) prompt()
    },
    onView: (view) => {
      if (!attached) return
      write(renderer.onView(view))
    },
    onAttached: ({ reason, result, from }) => {
      // The first prompt's own session streamed live from its first frame:
      // its page is already on screen, so only a continuation draws one.
      if (reason === 'created') return
      if (result.damaged) write('warning: the stored log is damaged; what follows is its readable prefix\n')
      if (result.page.hasMore) write('… earlier events remain (/history shows the page before this one)\n')
      write(renderHistory(result.page.events))
      write(reason === 'forked' ? `forked ${from ?? ''} → ${controller.sessionId}\n` : `resumed ${controller.sessionId}\n`)
      write(renderer.onView(result.view))
      attached = true
    },
    onAsk: (ask) => {
      pendingAsk = ask
      if (!tipped) {
        tipped = true
        write(firstAskTip(ask.offered, controller.view?.authority))
      }
      // The runtime's account of the call leads; the model's follows in
      // parentheses, where it reads as the claim it is. With no subject, the
      // joined call is all there is: a bare tool name is not a question.
      const says = ask.subject ? ` — ${describeIntent(ask.subject)}` : ''
      if (says === '' && ask.call !== undefined) {
        const omitted = ask.call.omittedChars === undefined ? '' : `\n  […${ask.call.omittedChars} more characters: approve from \`minidsh sessions show <id> --json\`, or deny]`
        write(`  ${ask.call.name} ${ask.call.arguments}${omitted}\n`)
      }
      write(`approve ${ask.toolName}${says}${ask.reason ? ` (${ask.reason})` : ''}? ${ask.offered ? '[y/N/a] ' : '[y/N] '}`)
      promptStanding = true
      askedAt = Date.now()
    },
    onDecided: (id) => {
      if (pendingAsk?.id !== id) return
      // Settled by someone or something else while it stood: say so, or the
      // next `y` typed would go to the model as a message.
      pendingAsk = undefined
      settledElsewhereAt = Date.now()
      write('(that question was settled elsewhere)\n')
      if (controller.status === 'idle') prompt()
    },
    onHeld: (held) => {
      write(held.length === 1 ? 'a job notice is held; your next message delivers it\n' : `${held.length} job notices are held; your next message delivers them\n`)
      prompt()
    },
    onClosed: () => void exitWith(1),
  }

  async function exitWith(code: number): Promise<void> {
    if (exiting) return
    exiting = true
    if (options.handleSigint) process.removeListener('SIGINT', onSigint)
    rl.close()
    await options.exit(code)
  }

  async function onLine(raw: string): Promise<void> {
    if (exiting) return
    const line = raw.trim()
    if (pendingAsk) {
      const ask = pendingAsk
      // A line that lands just as a question REPLACED one settled elsewhere was
      // typed for the old one: it is not consent to the new one.
      const now = Date.now()
      if (now - askedAt < REPLACED_MS && askedAt - settledElsewhereAt < REPLACED_MS) {
        write('(that answer arrived as the question changed: answer this one)\n')
        askedAt = Number.NEGATIVE_INFINITY
        hooks.onAsk(ask)
        return
      }
      pendingAsk = undefined
      const answer = line.toLowerCase()
      // `a` is a yes that ALSO takes the scope the host offered on this
      // approval; never a third outcome.
      const always = ask.offered && (answer === 'a' || answer === 'always')
      const outcome = always || answer === 'y' || answer === 'yes' ? 'allowed-once' : 'rejected'
      try {
        const result = await controller.answer(ask.id, outcome, always ? 'grant-session' : undefined)
        if (result.outcome === 'not-pending') write(`that approval (${ask.id}) is no longer pending\n`)
      } catch (error) {
        printError(error)
      }
      return
    }
    if (line.length === 0) {
      reprompt()
      return
    }
    if (line === '/exit' || line === '/quit') {
      await exitWith(0)
      return
    }
    // Exact token, never a prefix: `/presets …` once fell through to the
    // SANDBOX setter, durably widening the wrong knob with no error.
    const command = line.split(/\s+/, 1)[0]
    try {
      if (command === '/grants' || command === '/revoke') await grants(line)
      else if (command === '/sandbox' || command === '/ask' || command === '/accept' || command === '/preset') await authority(line)
      else if (command === '/compact') await compact()
      else if (command === '/history') await older()
      else if (command === '/model') await model(line)
      else if (command === '/sessions') await sessions()
      else if (command === '/jobs') await jobs(line)
      else if (command === '/cancel') {
        await controller.cancel(false)
        return
      } else if (command?.startsWith('/')) write(`unknown command ${command}\n`)
      else {
        await controller.submit(line)
        return
      }
    } catch (error) {
      if (error instanceof NotNow) write(`${error.message}\n`)
      else printError(error)
    }
    reprompt()
  }

  async function older(): Promise<void> {
    if (controller.sessionId === undefined || controller.history === undefined) {
      write('nothing attached to page back through\n')
      return
    }
    if (!controller.history.hasMore) {
      write('that is the whole session\n')
      return
    }
    const page = await controller.older()
    if (page === undefined) return
    if (page.hasMore) write('… earlier events remain (/history again)\n')
    write(renderHistory(page.events))
  }

  async function sessions(): Promise<void> {
    const list = await controller.sessions()
    if (list.length === 0) write('no sessions yet\n')
    const shown = list.slice(0, SESSIONS_SHOWN)
    // A resumed session keeps its original `createdAt`, so the one you are in
    // can sit below the cut — and it is the last row this command may drop.
    const open = list.find((session) => session.id === controller.sessionId)
    if (open && !shown.includes(open)) shown.push(open)
    for (const session of shown) {
      const marks = [session.id === controller.sessionId ? 'this one' : undefined, session.live ? 'live' : undefined, session.delegatedBy ? 'child' : undefined].filter(Boolean).join(', ')
      write(`${session.id}  ${new Date(session.createdAt).toISOString()}  ${session.title ?? '(unnamed)'}${marks ? `  [${marks}]` : ''}\n`)
    }
    if (list.length > SESSIONS_SHOWN) write(`… and ${list.length - SESSIONS_SHOWN} older (minidsh sessions list shows them all)\n`)
    if (list.length > 0) write('open one with: minidsh resume <id>\n')
  }

  async function compact(): Promise<void> {
    const result = await controller.compact()
    if (result.kind === 'compacted') write(`compacted ${result.shadowedNodes} messages (~${formatTokens(result.surfaceTokensBefore)} → ~${formatTokens(result.surfaceTokensAfter)})\n`)
    else if (result.kind === 'scheduled') write('the turn is still running; compaction will run before its next step\n')
    else write('nothing worth compacting yet\n')
  }

  async function model(line: string): Promise<void> {
    const [, target, effort] = line.split(/\s+/, 3)
    const route = await controller.model(target, effort)
    write(`model: ${route.provider}/${route.model}${route.reasoningEffort ? ` · effort ${route.reasoningEffort}` : ''}\n`)
  }

  async function grants(line: string): Promise<void> {
    const [command, value] = line.split(/\s+/, 2)
    if (command === '/revoke') {
      if (!value) {
        if (controller.sessionId === undefined) throw new NotNow('no session yet - send a prompt first')
        write('usage: /revoke <grant-id>   (/grants lists them)\n')
        return
      }
      const { revoked } = await controller.revoke(value)
      write(revoked ? `revoked ${value}\n` : `no live grant "${value}" in this session\n`)
      return
    }
    const view = await controller.grants()
    if (view.grants.length === 0) write('no standing grants in this session\n')
    for (const grant of view.grants) write(`${grant.id}  ${grant.toolName}  ${describeIntent(grant.subject)}\n`)
  }

  async function jobs(line: string): Promise<void> {
    const [, sub, value] = line.split(/\s+/, 3)
    if (controller.sessionId === undefined) throw new NotNow('no session yet - send a prompt first')
    if (sub === 'cancel') {
      if (!value) {
        write('usage: /jobs cancel <job-id>   (/jobs lists them)\n')
        return
      }
      const result = await controller.cancelJob(value)
      const said = result.state === 'ended' ? jobStatus({ state: 'ended', ...(result.end === undefined ? {} : { end: result.end }) }) : 'a stop was requested, but it has not ended yet'
      write(`${printableText(`job ${result.jobId}: ${said}`)}\n`)
    } else if (sub !== undefined) {
      write('usage: /jobs  |  /jobs cancel <job-id>\n')
    } else {
      const list: readonly JobSummary[] = controller.view?.jobs ?? []
      if (list.length === 0) write('no background jobs in this session\n')
      // The label is the model's command and a failure's detail a producer's words: neutralized.
      for (const job of list) write(`${printableText(`${jobStatus(job).padEnd(10)}  ${preview(job.label, 80)}  ${job.jobId}${job.held === true ? '  (notice held)' : ''}`)}\n`)
    }
  }

  async function authority(line: string): Promise<void> {
    const [command, value] = line.split(/\s+/, 2)
    if (controller.sessionId === undefined) throw new NotNow('no session yet - send a prompt first')
    if (!value) {
      write(
        command === '/ask'
          ? 'usage: /ask <ask|never>\n'
          : command === '/accept'
            ? 'usage: /accept <full|none>   (none: run shell commands this host cannot sandbox)\n'
            : command === '/preset'
              ? 'usage: /preset <name>\n'
              : 'usage: /sandbox <read-only|workspace-write|danger-full-access>\n',
      )
      return
    }
    const key = command === '/ask' ? 'approval' : command === '/accept' ? 'accepts' : command === '/preset' ? 'preset' : 'sandbox'
    const view = await controller.authority({ [key]: value })
    const preset = view.preset === undefined ? '' : ` · preset: ${view.preset}`
    write(`sandbox: ${view.sandbox} (${confinementLine(view)}) · approvals: ${view.approval}${preset}\n`)
  }

  const onSigint = (): void => void onInterrupt()
  async function onInterrupt(): Promise<void> {
    const now = Date.now()
    const again = now - lastInterrupt < 2000
    lastInterrupt = now
    if (controller.status === 'running' && controller.sessionId !== undefined && !again) {
      write('\n(cancelling — Ctrl+C again to exit)\n')
      await controller.cancel(false).catch(() => {})
      return
    }
    await exitWith(0)
  }

  // Lines are strictly serialized, and none runs before the terminal knows
  // WHICH session it is in: a line a piped script had waiting before a resume
  // attached once went out with no session id and became a hidden, paid session.
  let ready!: () => void
  let chain: Promise<void> = new Promise<void>((resolve) => (ready = resolve))
  const enqueue = (raw: string): void => {
    // A TTY echoed the keystrokes and the Enter, so the cursor already left the prompt.
    if (options.echoes) promptStanding = false
    chain = chain.then(() => onLine(raw)).catch(printError)
  }
  const rl = createInterface({ input: options.input, terminal: false })

  return {
    hooks,
    run: async (bound) => {
      controller = bound
      rl.on('line', enqueue)
      // The end of input: the lines already read still run, and the turn they
      // start finishes, before the terminal exits (a piped task was dropped
      // before S22.1's review). A question nobody can answer ends it.
      rl.on('close', () => {
        void chain.then(async () => {
          while (stillWorking()) await untilIdle()
          await exitWith(0)
        })
      })
      if (options.handleSigint) process.on('SIGINT', onSigint)
      try {
        out.write(options.banner(await controller.start()))
        if (options.continueRequest !== undefined) await controller.continueSession(options.continueRequest)
        attached = true
        ready()
        if (options.task !== undefined && options.task.length > 0) enqueue(options.task)
        else if (controller.status === 'idle' && controller.asked === undefined) prompt()
      } catch (error) {
        printError(error)
        await exitWith(1)
      }
    },
  }
}
