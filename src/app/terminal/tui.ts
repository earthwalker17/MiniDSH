/**
 * The full-screen terminal view: Codewhale's interaction model (an owned
 * screen with its own scrollback, a bordered composer, two footer rows, an
 * approval band that takes the composer's place) over MiniDSH's runtime and
 * the browser's presentation model. Everything it says to the host goes
 * through the shared controller; everything it draws comes from the log the
 * host streams, folded by `conversation.js`.
 *
 * **Consent at the keyboard.** The keyboard is also the composer's, so a key
 * a person was typing must never become an answer: the band ARMS only once it
 * has been on screen for 600 ms and no input has arrived for 600 ms (any byte
 * restarts the clock), and only a LONE `y`, `a` (where the host offered that
 * scope) or `n` — one key in its own chunk, outside a paste — answers.
 * Enter and Esc never do; anything else typed meanwhile goes to the draft
 * underneath. It never arms while the question and its keys do not fit on
 * screen. (The browser's card arms after 600 ms for the same reason: the next
 * card lands where the last answer's click was.)
 *
 * **Children.** A delegated child is attached READ-ONLY while it runs, so its
 * card can show what it is doing; nothing here ever drives one.
 */
import type { AgentOptions } from '../../core/agent/index.ts'
import { matches, USER_MESSAGE, type EventEnvelope } from '../../core/session/index.ts'
import { SUBAGENT_END, SUBAGENT_START } from '../../core/agent/index.ts'
import type { ToolDisplay } from '../../core/tools/types.ts'
import { jobStatus } from '../../capabilities/tool-jobs/index.ts'
import type { InitializeResult, SessionSummary } from '../../capabilities/protocol/index.ts'
import { createConversation, fold, prepend, step, type Block, type Model, type Op } from '../web/conversation.js'
import { compactAgo, humanSandbox, shortId } from '../web/format.js'
import { subjectParts } from '../web/rows.js'
import type { CardContext } from '../web/cards.js'
import { gapBetween, renderBlock, renderLive, settledProcesses, type BlockContext } from './blocks.ts'
import type { ProtocolClient } from './client.ts'
import { commandNamed, COMMANDS, KEYS, type OptionSource } from './commands.ts'
import { NotNow, SessionController, type Ask, type ContinueRequest } from './controller.ts'
import { Editor } from './editor.ts'
import { KeyDecoder, type Key } from './keys.ts'
import { drawScreen, MIN_HEIGHT, MIN_WIDTH, panelLines, type PanelState, type Segment } from './layout.ts'
import { Palette, type PaletteOption } from './palette.ts'
import { Frame, renderFrame } from './screen.ts'
import { glyphsFor, lineText, span, wrapLine, type Depth, type Line, type Span, type Style, type Theme } from './style.ts'
import { Tty } from './tty.ts'
import { cleanKeepingLines, cleanText, displayLines, truncateStart, truncateText } from './width.ts'

export interface FullScreenOptions {
  readonly client: ProtocolClient
  readonly overrides: Partial<AgentOptions>
  readonly cwd: string
  readonly continueRequest?: ContinueRequest
  readonly task?: string
  readonly exit: (code: number) => Promise<void>
  /** A scripted terminal (tests): streams, a size and a colour depth instead of the process's. */
  readonly io?: {
    readonly input: NodeJS.ReadableStream
    readonly output: NodeJS.WritableStream
    readonly fullScreen?: { readonly columns: number; readonly rows: number; readonly depth?: Depth }
  }
  /** Injected clock (tests). */
  readonly now?: () => number
}

/** How long a new question stays unanswerable, and how long the keyboard must have been quiet. */
export const ARM_MS = 600
/** A lone ESC is a key once nothing has followed it for this long. */
const ESCAPE_MS = 30
/** How long an open bracketed paste may pause between chunks before it is closed as it stands. */
const PASTE_HOLD_MS = 3000
const FRAME_MS = 16
const TICK_MS = 100
const NOTICE_MS = 5000
/** The largest paste the composer takes (the decoder's own bound is 4 MB). */
const MAX_PASTE = 256 * 1024

const FAINT: Style = { faint: true }

interface ChildState {
  model: Model | undefined
  readonly held: EventEnvelope[]
  cursor: number
}

interface BandAsk extends Ask {
  /** When the band was first DRAWN at a size it fits (Infinity until then, and again after a resize). */
  shownAt: number
  /** The first body row the band shows (↑↓). */
  scroll: number
  /** Body rows the person has had on screen; it arms only once every one has been. */
  readonly seen: Set<number>
  /** The body's length when last drawn. */
  bodyRows: number
  rang: boolean
}

type PanelKind = 'help' | 'sessions' | 'jobs' | 'grants'

export function runFullScreen(options: FullScreenOptions): { controller: SessionController; run: () => Promise<void> } {
  const view = new FullScreenView(options)
  return { controller: view.controller, run: () => view.run() }
}

class FullScreenView {
  readonly controller: SessionController
  private readonly options: FullScreenOptions
  private readonly now: () => number
  private readonly tty: Tty
  private readonly theme: Theme
  private readonly decoder: KeyDecoder
  private readonly editor = new Editor()
  private readonly palette: Palette
  private init: InitializeResult | undefined

  private model: Model = createConversation()
  private readonly children = new Map<string, ChildState>()
  private sessionTools = new Map<string, ToolDisplay>()
  private readonly versions = new Map<string, number>()
  private readonly cache = new Map<string, { stamp: string; lines: Line[] }>()

  private details = false
  private following = true
  private anchor: { key: string; offset: number } | undefined
  private rowKeys: string[] = []
  private blockStarts = new Map<string, number>()
  private lastMaxTop = 0
  private lastTop = 0
  private lastRows = 0
  private loadingOlder = false

  private ask: BandAsk | undefined
  private lastInputAt = Number.NEGATIVE_INFINITY
  private panel: { kind: PanelKind; selected: number; sessions?: readonly SessionSummary[]; confirm?: string } | undefined
  private notice: { text: string; style?: Style; until: number } | undefined
  private readonly pendingBubbles = new Map<string, string>()
  private runningSince: number | undefined
  private quitArmedAt = Number.NEGATIVE_INFINITY
  private sessionOptions: readonly PaletteOption[] = []

  private previous: Frame | undefined
  private paintTimer: ReturnType<typeof setTimeout> | undefined
  private lastPaint = 0
  private ticker: ReturnType<typeof setInterval> | undefined
  private spinnerIndex = 0
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private resizeTimer: ReturnType<typeof setTimeout> | undefined
  private exiting = false
  private ready = false
  /** Submissions and switches, strictly in order, none before the session is known. */
  private chain: Promise<void> = Promise.resolve()

  constructor(options: FullScreenOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    const input = (options.io?.input ?? process.stdin) as NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown }
    const output = (options.io?.output ?? process.stdout) as NodeJS.WritableStream & { columns?: number; rows?: number; fd?: number }
    if (options.io?.fullScreen !== undefined) {
      Object.assign(output, { columns: options.io.fullScreen.columns, rows: options.io.fullScreen.rows })
    }
    this.tty = new Tty({ input, output }, options.io === undefined)
    const depth: Depth = options.io?.fullScreen?.depth ?? ((process.stdout.getColorDepth?.() ?? 8) as Depth)
    this.theme = { depth, glyphs: glyphsFor(process.env) }
    this.decoder = new KeyDecoder({ now: this.now })
    this.palette = new Palette(COMMANDS, (command) => this.optionsFor(command))
    this.controller = new SessionController(
      options.client,
      {
        onEvent: (sessionId, event) => this.onEvent(sessionId, event),
        onStatus: (status) => {
          if (status === 'running') this.runningSince ??= this.now()
          else this.runningSince = undefined
          this.syncTicker()
          this.schedule()
        },
        onView: () => this.schedule(),
        onAttached: ({ reason, result, from }) => {
          if (result.tools !== undefined) this.sessionTools = new Map(result.tools.flatMap((tool) => (tool.display === undefined ? [] : [[tool.name, tool.display] as const])))
          if (reason === 'created') return this.schedule()
          this.resetModel(fold(result.page.events, { seedLength: result.header.seedLength ?? 0 }))
          this.editor.seedHistory(this.model.blocks.flatMap((block) => (block.kind === 'bubble' && block.text.trim().length > 0 ? [block.text] : [])))
          if (result.damaged) this.say('the stored log is damaged: this is its readable prefix', { ink: 'warn' })
          // A session is written at its first event: a fork nobody messages leaves no file.
          else if (reason === 'forked') this.say(`forked ${shortId(from ?? '')} into ${shortId(result.header.id)}: it is saved once you send it a message`)
          else this.say(`${reason === 'switched' ? 'opened' : 'resumed'} ${shortId(result.header.id)}`)
          this.runningSince = result.view.status === 'running' ? this.now() : undefined
          this.syncTicker()
          this.schedule()
        },
        onAsk: (ask) => {
          // Arming counts from the first paint that draws it, not from its
          // arrival: on a screen too small to show it, it has not been shown.
          this.ask = { ...ask, shownAt: Number.POSITIVE_INFINITY, scroll: 0, rang: false, seen: new Set(), bodyRows: 0 }
          this.syncTicker()
          this.schedule()
        },
        onDecided: (id) => {
          if (this.ask?.id === id) this.ask = undefined
          this.schedule()
        },
        onHeld: (jobs) => this.say(jobs.length === 1 ? 'a job notice is held: your next message delivers it' : `${jobs.length} job notices are held: your next message delivers them`, { ink: 'warn' }),
        onClosed: () => void this.exit(1),
      },
      options.overrides,
    )
  }

  // ---- lifecycle ---------------------------------------------------------------

  async run(): Promise<void> {
    const input = (this.options.io?.input ?? process.stdin) as NodeJS.ReadableStream
    const output = (this.options.io?.output ?? process.stdout) as NodeJS.WritableStream
    this.tty.onCaptured = (text) => {
      const line = text.trim().split('\n').at(-1)
      if (line) this.say(cleanText(line), { ink: 'warn' })
    }
    this.tty.enter()
    input.on('data', (chunk: Buffer | string) => this.onData(chunk))
    output.on('resize', () => this.onResize())
    this.paint()
    try {
      this.init = await this.controller.start()
      if (this.options.continueRequest !== undefined) await this.controller.continueSession(this.options.continueRequest)
    } catch (error) {
      await this.exit(1, error instanceof Error ? error.message : String(error))
      return
    }
    this.ready = true
    this.schedule()
    if (this.options.task !== undefined && this.options.task.trim().length > 0) this.enqueue(() => this.send(this.options.task!))
  }

  private async exit(code: number, error?: string): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    clearTimeout(this.paintTimer)
    clearTimeout(this.escapeTimer)
    clearTimeout(this.resizeTimer)
    if (this.ticker !== undefined) clearInterval(this.ticker)
    this.tty.leave()
    // On the main screen again: what to come back to.
    const id = this.controller.sessionId
    const out = this.options.io?.output ?? process.stdout
    if (error !== undefined) out.write(`error: ${cleanKeepingLines(error)}\n`)
    if (id !== undefined) out.write(`session ${id}\nresume it with: minidsh resume ${id}\n`)
    await this.options.exit(code)
  }

  // ---- input --------------------------------------------------------------------

  private onData(chunk: Buffer | string): void {
    if (this.exiting) return
    // How long the keyboard had been quiet BEFORE this chunk: the answer test
    // reads it, never the stamp this chunk is about to leave.
    const quietSince = this.lastInputAt
    this.lastInputAt = this.now()
    clearTimeout(this.escapeTimer)
    const keys = this.decoder.feed(chunk)
    this.handleKeys(keys, quietSince)
    if (this.decoder.pending) {
      // A held ESC is a key once nothing follows it for a moment; an open
      // bracketed paste is still arriving and must not be cut by that timer
      // (a gap between its chunks would close it, and its tail would submit).
      const wait = this.decoder.pasting ? PASTE_HOLD_MS : ESCAPE_MS
      this.escapeTimer = setTimeout(() => this.handleKeys(this.decoder.flush(), this.lastInputAt), wait)
    }
  }

  private handleKeys(keys: readonly Key[], quietSince: number): void {
    if (keys.length === 0) return
    // A lone key in its own chunk is the only thing that may answer a question.
    const lone = keys.length === 1 ? keys[0] : undefined
    for (const key of keys) this.handleKey(key, key === lone, quietSince)
    this.schedule()
  }

  private handleKey(key: Key, lone: boolean, quietSince: number): void {
    if (this.ask !== undefined) return this.bandKey(key, lone, quietSince)
    if (this.panel !== undefined) return this.panelKey(key)
    this.composeKey(key)
  }

  /** Whether the band can be answered now (for drawing it): long enough on screen, the keyboard quiet, and room to show it. */
  private armed(): boolean {
    const ask = this.ask
    if (ask === undefined) return false
    const now = this.now()
    return now - ask.shownAt >= ARM_MS && now - this.lastInputAt >= ARM_MS && this.bandFits() && this.readAll(ask)
  }

  /**
   * Keys while a question waits. A lone `y`, `n` or (where offered) `a`
   * answers only if the band has been on screen for `ARM_MS` AND the keyboard
   * was quiet for `ARM_MS` before it: a key in the middle of typing never
   * does (the S22.1 review found one that did, once the band had armed).
   * The same key pressed too EARLY on a quiet keyboard is an impatient answer,
   * not text: it is swallowed and the person told to wait. Everything else
   * typed goes to the draft underneath, which the editing keys still edit.
   */
  private bandKey(key: Key, lone: boolean, quietSince: number): void {
    const ask = this.ask!
    const now = this.now()
    if (key.kind === 'text') {
      const answer = key.paste === undefined && lone ? key.text : undefined
      const isAnswer = answer === 'y' || answer === 'n' || (answer === 'a' && ask.offered)
      const typing = now - quietSince < ARM_MS
      if (isAnswer && !typing) {
        if (now - ask.shownAt >= ARM_MS && this.bandFits() && this.readAll(ask)) this.answer(ask, answer!)
        else this.say(!this.bandFits() ? 'enlarge the terminal to answer' : !this.readAll(ask) ? 'scroll through the whole question (↑↓) before answering' : 'the answer keys arm in a moment: read it first', { ink: 'warn' })
        return
      }
      // The same bound as the composer's: the draft under a band is a draft.
      if (key.text.length > MAX_PASTE) {
        this.say(`that paste is ${Math.round(key.text.length / 1024)} KB: save it to a file in the workspace and name the file instead`, { ink: 'error' })
        return
      }
      this.editor.insert(key.text)
      return this.afterEdit()
    }
    if (key.ctrl && key.name === 'c') {
      void this.controller.cancel(true).catch((error: unknown) => this.fail(error))
      return
    }
    // Every edit of the draft under a band goes through `afterEdit`, as the
    // composer's do: the palette follows the draft, or the menu a person
    // opened before the question would still be highlighted when the band
    // goes, and the next Enter would run it in place of what they then typed.
    if (key.ctrl && key.name === 'u') {
      this.editor.clear()
      return this.afterEdit()
    }
    if (key.ctrl && key.name === 'w') {
      this.editor.deleteWordBack()
      return this.afterEdit()
    }
    switch (key.name) {
      case 'backspace':
        if (key.ctrl || key.alt) this.editor.deleteWordBack()
        else this.editor.backspace()
        return this.afterEdit()
      case 'up':
        ask.scroll = Math.max(0, ask.scroll - 1)
        return
      case 'down':
        ask.scroll = Math.min(this.bandScrollMax, ask.scroll + 1)
        return
      case 'pageup':
        return this.scrollBy(-Math.max(1, this.lastRows - 2))
      case 'pagedown':
        return this.scrollBy(Math.max(1, this.lastRows - 2))
      default:
        return
    }
  }

  private answer(ask: BandAsk, key: string): void {
    const outcome = key === 'n' ? 'rejected' : 'allowed-once'
    const offer = key === 'a' ? 'grant-session' : undefined
    this.ask = undefined
    void this.controller.answer(ask.id, outcome, offer).then(
      (result) => {
        if (result.outcome === 'not-pending') this.say('that question was already settled')
        this.schedule()
      },
      (error: unknown) => {
        this.fail(error)
        // Refused (an offer the fold withdrew): the question still stands, so
        // it comes back, armed afresh and without the offer, never lost.
        if (this.controller.asked === ask.id && this.ask === undefined) {
          this.ask = { ...ask, offered: offer === undefined ? ask.offered : false, shownAt: Number.POSITIVE_INFINITY, scroll: 0, seen: new Set() }
          this.syncTicker()
          this.schedule()
        }
      },
    )
  }

  private panelKey(key: Key): void {
    const panel = this.panel!
    const rows = this.panelRows(panel.kind)
    if (key.kind === 'key' && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
      this.panel = undefined
      return
    }
    if (key.kind === 'text' && key.text === 'q') {
      this.panel = undefined
      return
    }
    if (key.kind !== 'key') return
    if (key.name === 'up') panel.selected = Math.max(0, panel.selected - 1)
    else if (key.name === 'down') panel.selected = Math.min(panel.kind === 'help' ? this.panelScrollMax : Math.max(0, rows - 1), panel.selected + 1)
    else if (key.name === 'enter') void this.panelAct(panel)
  }

  private composeKey(key: Key): void {
    const width = this.composerWidth()
    if (key.kind === 'text') {
      // A paste this size is a file, not a message to type into: the composer
      // lays every row out, and the model would get it whole anyway.
      if (key.text.length > MAX_PASTE) {
        this.say(`that paste is ${Math.round(key.text.length / 1024)} KB: save it to a file in the workspace and name the file instead`, { ink: 'error' })
        return
      }
      this.editor.insert(key.text)
      this.afterEdit()
      return
    }
    const name = key.name
    if (key.ctrl) {
      switch (name) {
        case 'c':
          return this.interrupt()
        case 'd':
          if (this.editor.isEmpty && this.controller.status === 'idle') void this.exit(0)
          else this.say('Ctrl+D quits when the draft is empty and nothing is running')
          return
        case 'o':
          this.details = !this.details
          return
        case 'l':
          this.previous = undefined
          return
        case 'z':
          this.say('suspending is not supported here: Ctrl+D quits')
          return
        case 'a':
          this.editor.lineStart()
          return
        case 'e':
          this.editor.lineEnd()
          return
        case 'w':
          this.editor.deleteWordBack()
          return this.afterEdit()
        case 'u': {
          const cleared = this.editor.clear()
          if (cleared.trim().length > 0) this.editor.pushHistory(cleared)
          return this.afterEdit()
        }
        case 'k':
          this.editor.killToLineEnd()
          return this.afterEdit()
        case 'p':
          this.editor.historyPrev()
          return this.afterEdit()
        case 'n':
          this.editor.historyNext()
          return this.afterEdit()
        case 'j':
          this.editor.newline()
          return this.afterEdit()
        default:
          break
      }
    }
    switch (name) {
      case 'linefeed':
        this.editor.newline()
        return this.afterEdit()
      case 'enter':
        if (key.shift || key.alt) {
          this.editor.newline()
          return this.afterEdit()
        }
        return this.enter()
      case 'tab': {
        const completed = this.palette.complete()
        if (completed !== undefined) {
          this.editor.set(completed)
          this.afterEdit()
        }
        return
      }
      case 'escape':
        if (this.palette.open) this.palette.dismiss()
        else if (this.controller.status === 'running') this.cancelTurn()
        return
      case 'backspace':
        if (key.ctrl || key.alt) this.editor.deleteWordBack()
        else this.editor.backspace()
        return this.afterEdit()
      case 'delete':
        this.editor.deleteForward()
        return this.afterEdit()
      case 'left':
        if (key.ctrl || key.alt) this.editor.wordLeft()
        else this.editor.left()
        return
      case 'right':
        if (key.ctrl || key.alt) this.editor.wordRight()
        else this.editor.right()
        return
      case 'home':
        if (key.ctrl) this.scrollTo(0)
        else this.editor.lineStart()
        return
      case 'end':
        if (key.ctrl) this.follow()
        else this.editor.lineEnd()
        return
      case 'pageup':
        return this.scrollBy(-Math.max(1, this.lastRows - 2))
      case 'pagedown':
        return this.scrollBy(Math.max(1, this.lastRows - 2))
      case 'up':
      case 'down': {
        const up = name === 'up'
        if (key.shift) return this.scrollBy(up ? -3 : 3)
        if (this.palette.open) return this.palette.move(up ? -1 : 1)
        // An empty draft scrolls: the terminal turns the mouse wheel into
        // arrows on this screen, so this is also how the wheel scrolls.
        if (this.editor.isEmpty && !this.editor.browsingHistory) return this.scrollBy(up ? -3 : 3)
        const moved = up ? this.editor.up(width) : this.editor.down(width)
        if (!moved) {
          if (up) this.editor.historyPrev()
          else this.editor.historyNext()
          this.afterEdit()
        }
        return
      }
      default:
        return
    }
  }

  private afterEdit(): void {
    this.palette.update(this.editor.text)
    if (this.editor.text.startsWith('/resume ') && this.sessionOptions.length === 0) void this.refreshSessions().catch((error: unknown) => this.fail(error))
  }

  private enter(): void {
    if (this.palette.open) {
      const item = this.palette.accept()
      if (item !== undefined) {
        if (!item.run) {
          this.editor.set(item.insert)
          this.afterEdit()
          return
        }
        this.editor.set(item.insert)
      }
    }
    const text = this.editor.text
    // A trailing backslash asks for a new line, on every terminal.
    if (text.endsWith('\\')) {
      this.editor.set(text.slice(0, -1))
      this.editor.bufferEnd()
      this.editor.newline()
      this.afterEdit()
      return
    }
    if (text.trim().length === 0) return
    const submitted = this.editor.submit()
    this.palette.update('')
    if (submitted.trimStart().startsWith('/') && !submitted.includes('\n')) this.enqueue(() => this.command(submitted.trim()))
    else this.enqueue(() => this.send(submitted))
  }

  private interrupt(): void {
    if (!this.editor.isEmpty) {
      const cleared = this.editor.clear()
      this.editor.pushHistory(cleared)
      this.afterEdit()
      return
    }
    if (this.controller.status === 'running') return this.cancelTurn()
    const now = this.now()
    if (now - this.quitArmedAt < 2000) {
      void this.exit(0)
      return
    }
    this.quitArmedAt = now
    this.say('press Ctrl+C again to quit')
  }

  private cancelTurn(): void {
    void this.controller.cancel(true).catch((error: unknown) => this.fail(error))
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      while (!this.ready && !this.exiting) await new Promise((resolve) => setTimeout(resolve, 10))
      if (!this.exiting) await work()
    }).catch((error: unknown) => this.fail(error))
  }

  private async send(text: string): Promise<void> {
    const result = await this.controller.submit(text)
    // Shown dimmed until its own `user/message` lands (a steer waits for the next step).
    if (!this.model.blocksByKey.has(`msg:${result.messageId}`)) this.pendingBubbles.set(result.messageId, text)
    this.following = true
    this.schedule()
  }

  // ---- commands -----------------------------------------------------------------

  private async command(line: string): Promise<void> {
    const [head = '', ...rest] = line.split(/\s+/)
    const name = head.slice(1)
    const arg = rest.join(' ')
    const spec = commandNamed(name)
    if (spec === undefined) {
      // Kept, not lost: a path that starts with a slash, or a typo, is the person's to fix.
      this.editor.set(line)
      return this.say(`unknown command /${name}: /help lists them (a message that starts with / needs a space first)`, { ink: 'error' })
    }
    try {
      switch (name) {
        case 'help':
          this.openPanel('help')
          return
        case 'exit':
          return void (await this.exit(0))
        case 'details':
          this.details = !this.details
          return this.say(this.details ? 'every fold open (Ctrl+O closes them)' : 'folds closed')
        case 'cancel':
          if (!(await this.controller.cancel(true))) this.say('nothing is running')
          return
        case 'compact': {
          const result = await this.controller.compact()
          return this.say(result.kind === 'compacted' ? `compacted ${result.shadowedNodes} messages` : result.kind === 'scheduled' ? 'compaction runs before the next step' : 'nothing worth compacting yet')
        }
        case 'model': {
          const [target, effort] = rest
          // Before the first message there is no session to switch: the route is
          // the one that message will create it on.
          if (this.controller.sessionId === undefined) {
            if (target === undefined) return this.say(`the session will start on ${this.route()?.provider}/${this.route()?.model}`)
            const slash = target.indexOf('/')
            const chosen = slash > 0 ? { provider: target.slice(0, slash), model: target.slice(slash + 1) } : { model: target }
            this.controller.overrides = { ...this.controller.overrides, ...chosen, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
            return this.say(`the session will start on ${this.route()?.provider}/${this.route()?.model}${effort ? ` ${this.theme.glyphs.dot} ${effort}` : ''} when you send the first message`)
          }
          const route = await this.controller.model(target, effort)
          return this.say(`model: ${route.provider}/${route.model}${route.reasoningEffort ? ` ${this.theme.glyphs.dot} ${route.reasoningEffort}` : ''}`)
        }
        case 'sandbox':
        case 'ask':
        case 'accept':
        case 'preset': {
          if (arg.length === 0) return this.say(`usage: /${name} ${spec.args ?? ''}`)
          const key = name === 'ask' ? 'approval' : name === 'accept' ? 'accepts' : name
          // Before the first message, the switch rides on the prompt that creates
          // the session, as its opening (the host refuses it there if it must).
          if (this.controller.sessionId === undefined) {
            // Checked now, against the same closed lists the palette offers, so a
            // typo fails here and not on the prompt that carries it.
            const allowed = (this.optionsFor(name) ?? []).map((option) => option.value)
            if (!allowed.includes(arg)) return this.say(`/${name} takes ${allowed.length === 0 ? 'no value on this host' : allowed.join(' | ')}`, { ink: 'error' })
            // A preset REPLACES the sandbox/approval pair (the wire refuses both at once).
            const { preset: pendingPreset, ...pair } = this.controller.pendingAuthority
            const { sandbox: _sandbox, approval: _approval, ...unpaired } = this.controller.pendingAuthority
            // A knob set after a pending preset overrides ONE half of the pair that
            // preset selects, as the same two commands do on a live session: dropping
            // the preset alone would open the session with the other half back at the
            // host's default, which can be wider than the preset just chosen.
            const chosen = pendingPreset === undefined ? undefined : this.init?.presets.find((entry) => entry.name === pendingPreset)
            const fromPreset = chosen === undefined ? {} : { sandbox: chosen.sandbox, approval: chosen.approval }
            this.controller.pendingAuthority = key === 'preset' ? { ...unpaired, preset: arg } : key === 'accepts' ? { ...this.controller.pendingAuthority, accepts: arg } : { ...pair, ...fromPreset, [key]: arg }
            return this.say(`${name} ${arg} applies when the session starts with your first message`)
          }
          const view = await this.controller.authority({ [key]: arg })
          return this.say(`${humanSandbox(view.sandbox)} ${this.theme.glyphs.dot} approvals ${view.approval}${view.accepts === 'full' ? '' : ` ${this.theme.glyphs.dot} accepts ${view.accepts}`}${view.preset ? ` ${this.theme.glyphs.dot} ${view.preset}` : ''}`)
        }
        case 'grants':
          this.openPanel('grants')
          return
        case 'revoke': {
          if (arg.length === 0) return this.say('usage: /revoke <grant-id> (/grants lists them)')
          const { revoked } = await this.controller.revoke(arg)
          return this.say(revoked ? `revoked ${arg}` : `no live grant "${arg}" in this session`)
        }
        case 'jobs': {
          if (rest[0] === 'cancel') {
            if (rest[1] === undefined) return this.say('usage: /jobs cancel <job-id>')
            const result = await this.controller.cancelJob(rest[1])
            return this.say(cleanText(`job ${result.jobId}: ${result.state === 'ended' ? jobStatus({ state: 'ended', ...(result.end === undefined ? {} : { end: result.end }) }) : 'a stop was requested'}`))
          }
          this.openPanel('jobs')
          return
        }
        case 'sessions':
          await this.openSessions()
          return
        case 'resume':
          if (arg.length === 0) return void (await this.openSessions())
          await this.switchTo({ kind: 'resume', sessionId: arg })
          return
        case 'new':
          await this.switchTo({ kind: 'new' })
          return
        case 'fork':
          await this.switchTo({ kind: 'fork' })
          return
        case 'copy':
          return this.copyLastReply()
        default:
          return this.say(`/${name} is not available here`)
      }
    } catch (error) {
      this.fail(error)
    }
  }

  private async switchTo(target: Parameters<SessionController['switchTo']>[0]): Promise<void> {
    // Refused before anything changes: a running delegation keeps its live cards.
    const refusal = this.controller.switchRefusal()
    if (refusal !== undefined) throw new NotNow(refusal)
    this.children.clear()
    const result = await this.controller.switchTo(target)
    if (result === undefined) {
      this.resetModel(createConversation())
      this.say('a fresh session starts with your next message')
    }
  }

  private copyLastReply(): void {
    const reply = this.model.blocks.findLast((block): block is Extract<Block, { kind: 'reply' }> => block.kind === 'reply')
    if (reply === undefined) return this.say('no reply to copy yet')
    // OSC 52: the terminal puts it on the clipboard (Windows Terminal, iTerm2,
    // kitty, WezTerm; tmux with set-clipboard on). Our own sequence, never text.
    // What the screen showed, not the model's raw bytes: a CR or a bracketed-
    // paste end on the clipboard could run something nobody saw.
    this.tty.write(`\x1b]52;c;${Buffer.from(cleanKeepingLines(reply.text), 'utf8').toString('base64')}\x07`)
    this.say(`sent the last reply to the clipboard (${reply.text.length} characters; the terminal must allow OSC 52)`)
  }

  private async refreshSessions(): Promise<readonly SessionSummary[]> {
    const sessions = await this.controller.sessions()
    this.sessionOptions = sessions
      .filter((session) => session.delegatedBy === undefined && session.id !== this.controller.sessionId)
      .slice(0, 50)
      .map((session) => ({ value: session.id, description: `${session.title ?? '(unnamed)'} ${this.theme.glyphs.dot} ${compactAgo(session.updatedAt ?? session.createdAt, this.now())}` }))
    this.palette.update(this.editor.text)
    this.schedule()
    return sessions
  }

  private async openSessions(): Promise<void> {
    const sessions = (await this.refreshSessions()).filter((session) => session.delegatedBy === undefined)
    this.panel = { kind: 'sessions', selected: 0, sessions }
  }

  private openPanel(kind: PanelKind): void {
    this.panel = { kind, selected: 0 }
    if (kind === 'grants') void this.controller.grants().then(() => this.schedule(), (error: unknown) => this.fail(error))
  }

  private async panelAct(panel: NonNullable<FullScreenView['panel']>): Promise<void> {
    try {
      if (panel.kind === 'sessions') {
        const chosen = panel.sessions?.[panel.selected]
        if (chosen === undefined) return
        this.panel = undefined
        this.enqueue(() => this.switchTo({ kind: 'resume', sessionId: chosen.id }))
      } else if (panel.kind === 'jobs') {
        const job = (this.controller.view?.jobs ?? [])[panel.selected]
        if (job === undefined || job.state !== 'running') return
        // Two steps: an Enter meant to close the list must not stop a job.
        if (panel.confirm !== job.jobId) {
          panel.confirm = job.jobId
          this.say(`press Enter again to stop ${job.jobId}`, { ink: 'warn' })
          return
        }
        delete panel.confirm
        const result = await this.controller.cancelJob(job.jobId)
        this.say(cleanText(`job ${result.jobId}: ${result.state === 'ended' ? 'stopped' : 'a stop was requested'}`))
      } else if (panel.kind === 'grants') {
        const grant = (this.controller.view?.authority.grants ?? [])[panel.selected]
        if (grant === undefined) return
        const { revoked } = await this.controller.revoke(grant.id)
        this.say(revoked ? `revoked ${grant.id}` : `${grant.id} was no longer live`)
      } else this.panel = undefined
    } catch (error) {
      this.fail(error)
    }
    this.schedule()
  }

  private optionsFor(command: string): readonly PaletteOption[] | undefined {
    const source: OptionSource | undefined = commandNamed(command)?.options
    switch (source) {
      case 'models':
        return (this.init?.providers ?? []).flatMap((provider) => provider.models.map((model) => ({ value: `${provider.id}/${model.id}` })))
      case 'sessions':
        return this.sessionOptions
      case 'sandbox':
        return [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access', description: 'no file fence, no shell sandbox' }]
      case 'ask':
        return [{ value: 'ask' }, { value: 'never' }]
      case 'accept':
        return [{ value: 'full' }, { value: 'none', description: 'run shell commands this host cannot sandbox' }]
      case 'presets':
        return (this.init?.presets ?? []).map((preset) => ({ value: preset.name, ...(preset.description === undefined ? {} : { description: preset.description }) }))
      default:
        return undefined
    }
  }

  private say(text: string, style?: Style): void {
    // An error stays long enough to read.
    this.notice = { text, ...(style === undefined ? {} : { style }), until: this.now() + (style?.ink === 'error' ? NOTICE_MS * 3 : NOTICE_MS) }
    this.syncTicker()
    this.schedule()
  }

  private fail(error: unknown): void {
    this.say(error instanceof NotNow ? error.message : `error: ${error instanceof Error ? error.message : String(error)}`, error instanceof NotNow ? { ink: 'warn' } : { ink: 'error' })
  }

  // ---- the conversation -----------------------------------------------------------

  private resetModel(model: Model): void {
    this.model = model
    this.versions.clear()
    this.cache.clear()
    this.pendingBubbles.clear()
    this.following = true
    this.anchor = undefined
  }

  private onEvent(sessionId: string, event: EventEnvelope): void {
    if (sessionId !== this.controller.sessionId) {
      const child = this.children.get(sessionId)
      if (child === undefined) return
      if (child.model === undefined) child.held.push(event)
      else if (event.seq > child.cursor) step(child.model, event)
      this.schedule()
      return
    }
    this.applyOps(step(this.model, event))
    if (matches(event, USER_MESSAGE)) this.pendingBubbles.delete(String(event.data.message.id))
    if (matches(event, SUBAGENT_START)) void this.watchChild(event.data.childId)
    else if (matches(event, SUBAGENT_END)) {
      this.children.delete(event.data.childId)
      void this.controller.unwatchChild(event.data.childId)
    }
    this.schedule()
  }

  private async watchChild(childId: string): Promise<void> {
    if (this.children.has(childId)) return
    const state: ChildState = { model: undefined, held: [], cursor: -1 }
    this.children.set(childId, state)
    const attached = await this.controller.watchChild(childId)
    if (attached === undefined || this.children.get(childId) !== state) return
    state.model = fold(attached.page.events, { seedLength: attached.header.seedLength ?? 0 })
    state.cursor = attached.cursor
    for (const event of state.held.splice(0)) if (event.seq > state.cursor) step(state.model, event)
    this.schedule()
  }

  private applyOps(ops: readonly Op[]): void {
    for (const op of ops) {
      if (op.op === 'append') this.bump(op.block.key)
      else if (op.op === 'update') this.bump(op.key)
      else if (op.op === 'remove') {
        this.versions.delete(op.key)
        this.cache.delete(op.key)
      } else if (op.op === 'prepend') for (const block of op.blocks) this.bump(block.key)
    }
  }

  private bump(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
  }

  private async loadOlder(): Promise<void> {
    if (this.loadingOlder) return
    this.loadingOlder = true
    try {
      const page = await this.controller.older()
      if (page !== undefined) this.applyOps(prepend(this.model, page.events))
    } catch (error) {
      this.fail(error)
    } finally {
      this.loadingOlder = false
      this.schedule()
    }
  }

  // ---- scrolling ----------------------------------------------------------------

  private scrollBy(delta: number): void {
    const top = this.following ? this.lastMaxTop : this.lastTop
    this.scrollTo(top + delta)
  }

  private scrollTo(row: number): void {
    const top = Math.max(0, Math.min(row, this.lastMaxTop))
    this.following = top >= this.lastMaxTop
    this.anchor = this.following ? undefined : this.anchorAt(top)
    this.lastTop = top
    if (top === 0 && this.controller.history?.hasMore === true) void this.loadOlder()
  }

  private follow(): void {
    this.following = true
    this.anchor = undefined
  }

  private anchorAt(row: number): { key: string; offset: number } | undefined {
    const key = this.rowKeys[row]
    if (key === undefined) return undefined
    return { key, offset: row - (this.blockStarts.get(key) ?? row) }
  }

  // ---- drawing ------------------------------------------------------------------

  private composerCache: { text: string; cursor: number; width: number; rows: ReturnType<Editor['rows']> } | undefined
  /** The draft's rows, laid out again only when the draft, the cursor or the width changed (a 4 MB paste took 0.7 s a paint). */
  private composerLayout(): ReturnType<Editor['rows']> {
    const width = this.composerWidth()
    const hit = this.composerCache
    if (hit !== undefined && hit.text === this.editor.text && hit.cursor === this.editor.cursor && hit.width === width) return hit.rows
    const rows = this.editor.rows(width)
    this.composerCache = { text: this.editor.text, cursor: this.editor.cursor, width, rows }
    return rows
  }

  private composerWidth(): number {
    return Math.max(10, this.tty.size.columns - 4 - (this.theme.glyphs.prompt.length + 1))
  }

  private display(name: string): ToolDisplay | undefined {
    return this.sessionTools.get(name) ?? this.init?.tools.find((tool) => tool.name === name)?.display
  }

  private blockContext(width: number): BlockContext {
    const view = this.controller.view
    const cards: CardContext = {
      cwd: this.options.cwd,
      running: view?.status === 'running',
      pendingCallIds: new Set((view?.pendingApprovals ?? []).flatMap((ask) => (typeof ask.callId === 'string' ? [ask.callId] : []))),
      asked: this.model.asked,
      decided: this.model.decided,
    }
    const g = this.theme.glyphs
    return {
      theme: this.theme,
      width,
      cwd: this.options.cwd,
      details: this.details,
      cards,
      display: (name) => this.display(name),
      now: this.now(),
      spinner: g.spinner[this.spinnerIndex % g.spinner.length]!,
      child: (childId) => this.children.get(childId)?.model,
    }
  }

  /** Every transcript row, with the block each belongs to (for the scroll anchor). */
  private transcript(width: number): Line[] {
    const ctx = this.blockContext(width)
    const lines: Line[] = []
    const keys: string[] = []
    const starts = new Map<string, number>()
    const blocks = this.model.blocks
    const settled = settledProcesses(blocks)
    let previousKind: string | undefined
    for (const block of blocks) {
      const rows = this.linesFor(block, settled.has(block.key), ctx)
      if (rows.length === 0) continue
      if (gapBetween(previousKind, block.kind)) {
        lines.push([])
        keys.push(block.key)
      }
      starts.set(block.key, lines.length)
      for (const row of rows) {
        lines.push(row)
        keys.push(block.key)
      }
      previousKind = block.kind
    }
    const tail = (key: string, rows: readonly Line[]): void => {
      if (rows.length === 0) return
      if (lines.length > 0) {
        lines.push([])
        keys.push(key)
      }
      starts.set(key, lines.length)
      for (const row of rows) {
        lines.push(row)
        keys.push(key)
      }
    }
    const g = this.theme.glyphs
    for (const [id, text] of this.pendingBubbles) {
      // Laid out per line, as the settled bubble is (`blocks.ts`): a line feed or
      // a tab left in the text measures no cells and is drawn as one, so a
      // multi-line message wrapped whole runs together and loses each row's tail.
      const bar: Line = [span(`${g.userBar} `, FAINT)]
      const rows = displayLines(text.trim(), { tabSize: 4 }).flatMap((line) => wrapLine([span(line, FAINT)], width, { first: bar, rest: bar }))
      tail(`pending:${id}`, [...rows, [span(`  queued ${g.dot} it lands at the next step`, FAINT)]])
    }
    if (this.model.live) tail('live', renderLive(this.model.live, ctx))
    else if (this.controller.status === 'running' && !this.anyRunningCard()) {
      const ran = this.runningSince === undefined ? 0 : this.now() - this.runningSince
      tail('working', [[span(`${ctx.spinner} `, { ink: 'accent' }), span(`Working${ran >= 1000 ? ` ${g.dot} ${Math.floor(ran / 1000)}s` : ''}`, FAINT)]])
    }
    if (lines.length === 0) tail('welcome', this.welcome(width))
    this.rowKeys = keys
    this.blockStarts = starts
    return lines
  }

  private anyRunningCard(): boolean {
    for (const item of this.model.items.values()) if (item.called && !item.result && this.controller.view?.status === 'running') return true
    return false
  }

  /** A block's rows, cached unless they move with the clock (a running group). */
  private linesFor(block: Block, settled: boolean, ctx: BlockContext): Line[] {
    const live = block.kind === 'process' && !settled
    const stamp = `${this.versions.get(block.key) ?? 0}|${ctx.width}|${this.details ? 1 : 0}|${settled ? 1 : 0}`
    if (!live) {
      const hit = this.cache.get(block.key)
      if (hit !== undefined && hit.stamp === stamp) return hit.lines
    }
    const lines = renderBlock(block, settled, this.model, ctx)
    if (!live) this.cache.set(block.key, { stamp, lines })
    return lines
  }

  private welcome(width: number): Line[] {
    const g = this.theme.glyphs
    const init = this.init
    const options = this.route()
    const route = options === undefined ? '' : `${options.provider}/${options.model}`
    const window = init?.providers.find((p) => p.id === options?.provider)?.models.find((m) => m.id === options?.model)?.contextWindow
    const rows: Line[] = [
      [span(`${g.reply} `, { ink: 'accent', bold: true }), span('minidsh', { bold: true }), span(init ? ` ${init.serverInfo.version}` : '', FAINT)],
      [span('  '), span(truncateStart(this.options.cwd, width - 4), FAINT)],
      [span('  '), span(route), span(window ? ` ${g.dot} ${Math.round(window / 1000)}k context` : '', FAINT)],
      [],
      [span('  '), span('Ask for anything, or type '), span('/', { ink: 'accent', bold: true }), span(' for commands.')],
      [span('  '), span(`Enter sends ${g.dot} Ctrl+J new line ${g.dot} Esc stops a turn ${g.dot} Ctrl+O details ${g.dot} Ctrl+D quits`, FAINT)],
    ]
    return rows.flatMap((row) => wrapLine(row, width, { rest: [span('  ')] }))
  }

  private bandLines(width: number): BandLines | undefined {
    const ask = this.ask
    if (ask === undefined) return undefined
    return bandLines(ask, { width, theme: this.theme, count: this.controller.askCount, armed: this.armed(), fits: this.bandFits() })
  }

  /**
   * Whether every row of the question has been on screen. A long subject or
   * call scrolls rather than making the band unanswerable, and a model could
   * size its tokens to push the end of a command below the fold, so consent
   * needs the whole of it seen — as drawn, not as measured (the S22.1 review
   * armed a band whose tail the wrap had pushed out of sight).
   */
  private readAll(ask: BandAsk): boolean {
    for (let row = 0; row < ask.bodyRows; row++) if (!ask.seen.has(row)) return false
    return true
  }

  /** Whether a question can be answered at this size (its body scrolls; only a terminal under the minimum cannot). */
  private bandFits(): boolean {
    const { columns, rows } = this.tty.size
    return columns >= MIN_WIDTH && rows >= MIN_HEIGHT
  }

  /** How far the band's body can scroll, as the last paint laid it out. */
  private bandScrollMax = 0
  /** How far the help panel can scroll, as the last paint laid it out. */
  private panelScrollMax = 0

  private panelRows(kind: PanelKind): number {
    if (kind === 'sessions') return this.panel?.sessions?.length ?? 0
    if (kind === 'jobs') return this.controller.view?.jobs.length ?? 0
    if (kind === 'grants') return this.controller.view?.authority.grants.length ?? 0
    return 0
  }

  private panelState(width: number): PanelState | undefined {
    const g = this.theme.glyphs
    if (this.palette.open) {
      const view = this.palette.view(8)
      return {
        title: [span('commands', FAINT)],
        rows: (() => {
          const pad = Math.min(30, Math.max(0, ...view.items.map((item) => item.label.length)))
          return view.items.map((item) => [span(item.label.padEnd(pad), { ink: 'accent' }), span(`  ${truncateText(item.description, Math.max(10, width - pad - 10))}`, FAINT)])
        })(),
        selected: view.selected,
        hint: `↑↓ choose ${g.dot} Tab complete ${g.dot} Enter run ${g.dot} Esc hide`,
      }
    }
    const panel = this.panel
    if (panel === undefined) return undefined
    if (panel.kind === 'help') {
      const rows: Line[] = [
        ...KEYS.map(([keys, what]) => [span(keys.padEnd(18), { ink: 'accent' }), span(what)]),
        [],
        ...COMMANDS.map((command) => [span(`/${command.name}${command.args ? ` ${command.args}` : ''}`.padEnd(30), { ink: 'accent' }), span(command.description, FAINT)]),
      ]
      const lines = panelLines(rows, width)
      return { title: [span('keys and commands', { bold: true })], rows: lines, scroll: panel.selected, hint: `↑↓ scroll ${g.dot} Esc closes` }
    }
    if (panel.kind === 'sessions') {
      const sessions = panel.sessions ?? []
      return {
        title: [span('sessions', { bold: true }), span(`  ${sessions.length}`, FAINT)],
        rows: sessions.map((session) => [
          span(truncateText(cleanText(session.title ?? '(unnamed)'), Math.max(10, width - 34))),
          span(`  ${compactAgo(session.updatedAt ?? session.createdAt, this.now())}`, FAINT),
          span(session.id === this.controller.sessionId ? `  ${g.dot} this one` : session.live ? `  ${g.dot} live` : '', { ink: 'accent' }),
          span(`  ${shortId(session.id)}`, FAINT),
        ]),
        selected: panel.selected,
        hint: `Enter opens it here ${g.dot} Esc closes`,
      }
    }
    if (panel.kind === 'jobs') {
      const jobs = this.controller.view?.jobs ?? []
      return {
        title: [span('background jobs', { bold: true })],
        rows: jobs.length === 0 ? [[span('no background jobs in this session', FAINT)]] : jobs.map((job) => [span(jobStatus(job).padEnd(10), job.state === 'running' ? { ink: 'accent' } : FAINT), span(truncateText(cleanText(job.label), Math.max(10, width - 32))), span(`  ${job.jobId}${job.held === true ? ' (notice held)' : ''}`, FAINT)]),
        selected: panel.selected,
        hint: `Enter stops the selected job ${g.dot} Esc closes`,
      }
    }
    const grants = this.controller.view?.authority.grants ?? []
    return {
      title: [span('standing approvals', { bold: true })],
      rows: grants.length === 0 ? [[span('no standing grants in this session', FAINT)]] : grants.map((grant) => [span(`${grant.id}  `, FAINT), ...subjectParts(grant.subject).map((part) => ('code' in part ? span(part.code, { ink: 'accent' }) : span(part.text)))]),
      selected: panel.selected,
      hint: `Enter revokes the selected grant ${g.dot} Esc closes`,
    }
  }

  private footer(): { posture: Segment[]; info: Segment[] } {
    const g = this.theme.glyphs
    const view = this.controller.view
    const pending = this.controller.sessionId === undefined ? this.controller.pendingAuthority : {}
    // A pending preset is drawn as the pair it selects, so its ink is right too.
    const preset = pending.preset === undefined ? undefined : this.init?.presets.find((entry) => entry.name === pending.preset)
    const base = view?.authority ?? this.init?.defaultAuthority
    // What the first message will open the session under, once asked for.
    const authority =
      base === undefined
        ? undefined
        : {
            ...base,
            ...(pending.sandbox === undefined ? {} : { sandbox: pending.sandbox as typeof base.sandbox }),
            ...(pending.approval === undefined ? {} : { approval: pending.approval as typeof base.approval }),
            ...(pending.accepts === undefined ? {} : { accepts: pending.accepts as typeof base.accepts }),
            ...(preset === undefined ? {} : { sandbox: preset.sandbox, approval: preset.approval, preset: preset.name }),
          }
    const posture: Segment[] = []
    if (authority !== undefined) {
      const ink = authority.sandbox === 'danger-full-access' ? 'error' : authority.sandbox === 'read-only' ? 'accent' : 'ok'
      const line: Span[] = [span(`${g.reply} `, { ink }), span(humanSandbox(authority.sandbox), { bold: true }), span(` ${g.dot} ${authority.approval}`)]
      if (authority.accepts !== 'full') line.push(span(` ${g.dot} accepts ${authority.accepts}`, { ink: 'warn', bold: true }))
      if (authority.preset !== undefined && authority.preset !== authority.sandbox) line.push(span(` ${g.dot} ${authority.preset}`, FAINT))
      posture.push({ line, priority: 100 })
    }
    if (this.ask !== undefined) posture.push({ line: [span('waiting on you', { ink: 'warn', bold: true })], priority: 90 })
    else if (this.controller.status === 'running') {
      const ran = this.runningSince === undefined ? 0 : this.now() - this.runningSince
      posture.push({ line: [span(`working ${elapsed(ran)}`, { ink: 'accent' })], priority: 60 })
    } else if (this.controller.sessionId !== undefined) posture.push({ line: [span('ready', FAINT)], priority: 30 })
    const runningChildren = this.runningChildren()
    if (runningChildren > 0) posture.push({ line: [span(`${runningChildren} subagent${runningChildren === 1 ? '' : 's'}`, { ink: 'accent' })], priority: 50 })
    const held = (view?.jobs ?? []).filter((job) => job.held === true).length
    if (held > 0) posture.push({ line: [span(`${held} notice${held === 1 ? '' : 's'} held`, { ink: 'warn' })], priority: 45 })
    const hint =
      this.ask !== undefined
        ? this.ask.offered ? 'y / a / n answer' : 'y / n answer'
        : this.now() - this.quitArmedAt < 2000
          ? 'Ctrl+C again to quit'
          : this.controller.status === 'running'
            ? 'esc to interrupt'
            : this.details
              ? 'ctrl+o closes folds'
              : 'ctrl+o details'
    posture.push({ line: [span(hint, FAINT)], priority: 20, right: true })

    const info: Segment[] = []
    const options = this.route()
    if (options !== undefined) info.push({ line: [span(`${options.provider}/`, FAINT), span(options.model), span(options.reasoningEffort ? ` ${g.dot} ${options.reasoningEffort}` : '', FAINT)], priority: 100 })
    const context = view?.context
    if (context !== undefined && context.budgetTokens > 0 && context.projectedTokens > 0) {
      const percent = Math.round(context.ratio * 100)
      info.push({ line: [span('ctx ', FAINT), span(`${percent}%`, percent >= 80 ? { ink: 'warn', bold: true } : undefined), span(` ${tokens(context.projectedTokens)}/${tokens(context.budgetTokens)}`, FAINT)], priority: 80 })
    }
    const jobs = (view?.jobs ?? []).filter((job) => job.state === 'running').length
    if (jobs > 0) info.push({ line: [span(`${jobs} job${jobs === 1 ? '' : 's'} running`, { ink: 'accent' })], priority: 50 })
    info.push({ line: [span('/help', FAINT)], priority: 15, right: true })
    return { posture, info }
  }

  /** The route on screen: the session's own once there is one, else what this launch asked for over the defaults. */
  private route(): AgentOptions | undefined {
    const live = this.controller.view?.options
    if (live !== undefined) return live
    const defaults = this.init?.defaultAgentOptions
    return defaults === undefined ? undefined : { ...defaults, ...this.controller.overrides }
  }

  private runningChildren(): number {
    if (this.controller.view?.status !== 'running') return 0
    let count = 0
    for (const item of this.model.items.values()) if (item.subagent?.start && !item.subagent.end) count++
    return count
  }

  // ---- painting -----------------------------------------------------------------

  private schedule(): void {
    if (this.exiting || this.paintTimer !== undefined) return
    const wait = Math.max(0, FRAME_MS - (this.now() - this.lastPaint))
    this.paintTimer = setTimeout(() => {
      this.paintTimer = undefined
      this.paint()
    }, wait)
  }

  private syncTicker(): void {
    if (this.exiting) return
    const animate = this.controller.status === 'running' || this.ask !== undefined || this.notice !== undefined
    if (animate && this.ticker === undefined) {
      this.ticker = setInterval(() => {
        this.spinnerIndex++
        if (this.notice !== undefined && this.now() >= this.notice.until) this.notice = undefined
        this.syncTicker()
        this.schedule()
      }, TICK_MS)
    } else if (!animate && this.ticker !== undefined) {
      clearInterval(this.ticker)
      this.ticker = undefined
    }
  }

  private onResize(): void {
    clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      const { columns, rows } = this.tty.size
      if (columns === 0 || rows === 0) return
      this.previous = undefined
      this.cache.clear()
      // The question re-wraps at the new width: what was seen must be seen
      // again, from its top, and the arming time starts over.
      if (this.ask !== undefined) {
        this.ask.seen.clear()
        this.ask.scroll = 0
        this.ask.shownAt = Number.POSITIVE_INFINITY
      }
      this.schedule()
    }, 30)
  }

  private paint(): void {
    if (this.exiting) return
    this.lastPaint = this.now()
    const { columns, rows } = this.tty.size
    const width = Math.max(10, columns - 3)
    const band = this.bandLines(columns - 2)
    const composerRows = this.composerLayout()
    const pastLast = this.notice !== undefined && this.now() >= this.notice.until
    if (pastLast) this.notice = undefined
    const transcript = this.transcript(width)
    let top: number | undefined
    if (!this.following && this.anchor !== undefined) {
      const start = this.blockStarts.get(this.anchor.key)
      top = start === undefined ? this.lastTop : start + this.anchor.offset
    }
    const panel = this.panelState(columns - 4)
    const { posture, info } = this.footer()
    const running = this.controller.status === 'running'
    const drawn = drawScreen({
      width: columns,
      height: rows,
      theme: this.theme,
      transcript,
      top: this.following ? undefined : top,
      composer: {
        rows: composerRows.rows.map((row) => this.editor.text.slice(row.start, row.end)),
        cursorRow: composerRows.cursorRow,
        cursorCol: composerRows.cursorCol,
        placeholder: running ? 'Type to steer the running turn' : this.controller.sessionId === undefined ? 'Ask for anything, or / for commands' : 'Reply, or / for commands',
        empty: this.editor.isEmpty,
        ...(this.editor.isEmpty ? {} : { hint: running ? 'enter steers' : 'enter sends' }),
      },
      ...(band === undefined ? {} : { band: { ...band, armed: this.armed(), scroll: this.ask?.scroll ?? 0, ...(this.editor.isEmpty ? {} : { draft: this.editor.text.replace(/\n/g, ' ') }) } }),
      ...(panel === undefined ? {} : { panel }),
      ...(this.notice === undefined ? {} : { notice: { text: this.notice.text, ...(this.notice.style === undefined ? {} : { style: this.notice.style }) } }),
      posture,
      info,
    })
    this.lastMaxTop = drawn.maxTop
    this.bandScrollMax = drawn.bandScrollMax
    this.panelScrollMax = drawn.panelScrollMax
    if (this.ask !== undefined && band !== undefined) {
      if (this.ask.shownAt === Number.POSITIVE_INFINITY && this.bandFits()) this.ask.shownAt = this.now()
      this.ask.bodyRows = band.body.length
      for (let row = drawn.bandShown[0]; row < drawn.bandShown[1]; row++) this.ask.seen.add(row)
    }
    this.lastTop = drawn.top
    this.lastRows = drawn.transcriptRows
    if (drawn.top >= drawn.maxTop) {
      this.following = true
      this.anchor = undefined
    } else if (!this.following) this.anchor = this.anchorAt(drawn.top)
    if (this.ask !== undefined && !this.ask.rang && this.armed()) {
      // One bell per question, once it can be answered.
      this.ask.rang = true
      this.tty.write('\x07')
    }
    const bytes = renderFrame(this.previous, drawn.frame, this.theme.depth)
    this.previous = drawn.frame
    this.tty.write(bytes)
  }
}

export interface BandLines {
  readonly title: Line
  readonly body: Line[]
  readonly keys: Line[]
}

/**
 * What the approval band says about one question, as lines: a pure function
 * of the question and the view's state, so the screens a person answers on
 * are drawn in a test from the view's own words (`layout.test.ts`).
 *
 * The runtime's account of the call (`subject`) leads and the model's claim
 * follows. The CALL as the log recorded it is shown whenever the subject does
 * not say all of it: when there is none, and when the seam cut it (a command
 * past the intent bound). An answer to a command whose tail is out of sight is
 * not consent, and the body scrolls so that all of it can be read.
 */
export function bandLines(ask: Ask, at: { readonly width: number; readonly theme: Theme; readonly count: number; readonly armed: boolean; readonly fits: boolean }): BandLines {
  const { width, armed } = at
  const g = at.theme.glyphs
  const title: Line = [span(`${g.attention} `, { ink: 'warn', bold: true }), span('Approval needed', { bold: true }), span(` ${g.dot} ${cleanText(ask.toolName)}`), span(at.count > 1 ? `   1 of ${at.count}` : '', FAINT)]
  const body: Line[] = []
  if (ask.subject !== undefined) {
    const parts = subjectParts(ask.subject).map((part, index) =>
      'code' in part ? span(part.code, { ink: 'accent' }) : span(index === 0 ? part.text.charAt(0).toUpperCase() + part.text.slice(1) : part.text),
    )
    body.push(...wrapLine(parts, width - 2, { first: [span('  ')], rest: [span('  ')] }))
  }
  if (ask.reason !== undefined && ask.reason.trim().length > 0) {
    // The model's claim, clamped to two rows: a clamp says so, or a cut
    // sentence reads as the whole one.
    const said = wrapLine([span(`model says: ${cleanText(ask.reason)}`, { faint: true, italic: true })], width - 2, { first: [span('  ')] })
    if (said.length > 2) said[1] = [span(truncateText(`${lineText(said[1]!).trimEnd()} …`, width - 2), { faint: true, italic: true })]
    body.push(...said.slice(0, 2))
  }
  const cut = ask.subject?.truncated === true
  if ((ask.subject === undefined || cut) && ask.call !== undefined) {
    if (cut) body.push([span('  the whole call, as the log recorded it:', FAINT)])
    const callLines = displayLines(`${ask.call.name} ${ask.call.arguments}`)
    body.push(...callLines.flatMap((line, index) => wrapLine([span(line)], width - 4, { first: [span(index === 0 ? '  $ ' : '    ', FAINT)], rest: [span('    ')] })))
    if (ask.call.omittedChars !== undefined) body.push(...wrapLine([span(`… ${ask.call.omittedChars} more characters: read the whole call with minidsh sessions show --json, or deny`, { ink: 'warn' })], width - 2, { first: [span('  ')], rest: [span('  ')] }))
  } else if (cut) {
    body.push(...wrapLine([span('… the rest was not recorded with this question: read the whole call with minidsh sessions show --json, or deny', { ink: 'warn' })], width - 2, { first: [span('  ')], rest: [span('  ')] }))
  }
  const key = (letter: string): Span => span(letter, armed ? { ink: 'accent', bold: true } : FAINT)
  const word = (text: string): Span => span(text, armed ? undefined : FAINT)
  const row = (parts: Span[]): Line[] => wrapLine(parts, width - 2, { first: [span('  ')], rest: [span('     ')] })
  // The browser's words: Allow once, Allow for this session, Reject.
  const keys: Line[] = [
    ...row([key('y'), word('  allow once')]),
    ...(ask.offered ? row([key('a'), word('  allow for this session'), span(' (this exact action, until the session ends or its authority changes)', FAINT)]) : []),
    ...row([key('n'), word('  reject'), ...(armed ? [] : [span(at.fits ? '   the answer keys arm in a moment' : '   enlarge the terminal to answer', { ink: 'warn' })])]),
  ]
  return { title, body, keys }
}

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function tokens(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(count < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`
}
