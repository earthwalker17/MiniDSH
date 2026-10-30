/**
 * Replay-from-the-log adapter. The model script is DERIVED from a recorded
 * session's `assistant/chunk` events (grouped by turn/step), so recording is
 * free: run the real agent once, harvest its JSONL, replay it keylessly.
 * `assertConsumed()` fails if any recorded step was not replayed. A log that
 * holds a REPAIRED interruption is not an oracle: replay runs the interrupted
 * call to completion, which the recording never did.
 *
 * There are TWO scripts, because there are two kinds of call. Loop steps come
 * from `assistant/chunk`; out-of-loop calls (a compaction summary) come from
 * the `llm/aux-call` records their caller wrote, and are told apart by the
 * request's `purpose` — a loop-built request never carries one. Both cursors
 * are asserted, so a compacted log replays its compaction at the same point,
 * with the same summary, or the oracle fails.
 *
 * A log may name more than one provider (a mid-session route switch, a role
 * that sent the summary elsewhere): one shared script serves every provider
 * the log names, and each provider's window is answered from the log's own
 * `request/context` records — so a replay meters exactly what the recording
 * metered without a key for either provider.
 *
 * **Effects.** By default (`run`) tool bodies run for real, so a replay
 * reproduces the WORLD as well as the decisions, and the arcs assert it. With
 * `recorded` a `tools/execute` around-middleware answers every call that
 * reaches a body with the result the recording logged for the same
 * (turn, step, callId), never calling `next()` — so nothing touches the disk,
 * no `tool/dispatch` is written (S14 put that fact inside the terminal
 * continuation exactly so a middleware answering here cannot claim a body ran)
 * and a recording replays on any machine, whatever its paths. A background job's
 * completion is answered the same way: no process runs, so the recorded
 * notice is re-delivered where the recording CLAIMED it — after the previous
 * turn ended, for a notice that woke a turn; at the end of the previous step's
 * model call, for one a busy turn took at its next step — with the recorded
 * waking flag. Arrival is ordered by the log, never by a clock (and `run`
 * refuses a log with jobs, whose real timing IS the clock's). What it
 * provably does NOT reproduce: every fact a body or provider writes (effects,
 * approvals asked inside a body, subagent brackets, spill, attachments), a
 * tool's `concludesTurn` or deferred context (unlogged; no shipped tool sets
 * them), and a gate that needs an answerer (no shipped gate asks). A log that
 * holds a repaired interruption is refused, and so are `children`: no child
 * ever runs when the delegating call's result is served.
 */
import type { Context, Disposer } from '../kernel/index.ts'
import { AGENT_OPTIONS, AGENTS, INBOX_SPLICED, SUBAGENT_END, SUBAGENT_START, type Agent } from '../core/agent/index.ts'
import { COMPACTION_END } from '../core/compaction/events.ts'
import type { SessionId } from '../core/ids.ts'
import { JOB_END, JOB_START, noticeJobId } from '../core/jobs/events.ts'
import { restoreMessage } from '../core/llm/message.ts'
import type { Message } from '../core/llm/types.ts'
import { LLM, type LlmAdapter, type LlmRequest, type ModelInfo, type ModelModality, type ResolvedModel, type StreamChunk } from '../core/llm/index.ts'
import { foldAuxCalls, LLM_AUX_CALL, type AuxCallRecord } from '../core/llm/aux-call.ts'
import {
  ASSISTANT_CHUNK,
  ASSISTANT_MESSAGE,
  CONSERVATIVE_ERROR_NAMES,
  END_SEED,
  matches,
  REQUEST_CONTEXT,
  REQUEST_HEADER,
  SESSION_EVENT,
  SESSION_LIFECYCLE,
  STEP_START,
  TOOL_CALL,
  TOOL_DISPATCH,
  TOOL_RESULT,
  TURN_END,
  USER_MESSAGE,
  type EventEnvelope,
} from '../core/session/index.ts'
import { TOOLS_EXECUTE, type ToolExecution, type ToolResult } from '../core/tools/index.ts'

/**
 * How a retried step replays.
 *
 * `every` (the default) replays each recorded attempt, failures included, so a
 * recovery the log describes actually happens again. This is the faithful
 * oracle, and it is required whenever recovery CHANGED THE LOG — a compaction
 * answering `CONTEXT_WINDOW_EXCEEDED` writes a surface replace, and eliding the
 * failure would leave the replayed session with a history the recording never
 * had. The cost is that the replaying composition must carry the same recovery
 * capabilities; every real one does.
 *
 * `acted-on` replays only the attempt whose result the agent used, so a log can
 * replay under a composition with no recovery listeners at all.
 */
export type ReplayAttempts = 'every' | 'acted-on'

/**
 * Groups recorded `assistant/chunk` payloads into chunk lists per (turn, step),
 * in order. Logs written before `attempt` existed count as a single attempt.
 */
export function deriveReplayScript(events: readonly EventEnvelope[], attempts: ReplayAttempts = 'every'): StreamChunk[][] {
  return keyedReplayScript(events, attempts).script
}

/** The same script, each group with the (turn, step) it was recorded at — what a notice is anchored to. */
function keyedReplayScript(events: readonly EventEnvelope[], attempts: ReplayAttempts): { script: StreamChunk[][]; keys: string[] } {
  const groups = new Map<string, { attempt: number; chunks: StreamChunk[] }[]>()
  const order: string[] = []
  for (const event of events) {
    if (!matches(event, ASSISTANT_CHUNK)) continue
    const key = `${event.data.turn}:${event.data.step}`
    let list = groups.get(key)
    if (!list) {
      list = []
      groups.set(key, list)
      order.push(key)
    }
    const open = list.at(-1)
    let attempt = event.data.attempt as number | undefined
    if (attempt === undefined) {
      // Exactly one finish ends an attempt, so a chunk arriving after a finish
      // belongs to the next one.
      attempt = !open ? 1 : open.chunks.at(-1)?.type === 'finish' ? open.attempt + 1 : open.attempt
    }
    if (!open || attempt > open.attempt) list.push({ attempt, chunks: [event.data.chunk as unknown as StreamChunk] })
    else if (attempt === open.attempt) open.chunks.push(event.data.chunk as unknown as StreamChunk)
    // A lower attempt after a higher one cannot happen; ignore it rather than reorder.
  }
  const script: StreamChunk[][] = []
  const keys: string[] = []
  for (const key of order) {
    const list = groups.get(key)!
    const chosen = attempts === 'every' ? list : list.slice(-1)
    for (const entry of chosen) {
      // A group with no terminal finish is a crash artifact: the runtime always
      // normalizes to a terminal finish, so its absence means the process died
      // mid-stream and the agent never acted on it. In a resumed log the
      // artifact sits MID-log (completed turns follow it), so every finish-less
      // group is dropped — replaying one would silently desynchronize the script.
      if (entry.chunks.some((chunk) => chunk.type === 'finish')) {
        script.push(entry.chunks)
        keys.push(key)
      }
    }
  }
  return { script, keys }
}

/** A job's completion notice as the recording delivered it: the message, its waking flag, and the step that took it. */
export interface RecordedNotice {
  readonly message: Message
  readonly waking: boolean
  readonly turn: number
  readonly step: number
}

/**
 * Every job notice a recording's model was shown, anchored to the step whose
 * claim entered it. The anchor is the CLAIM, not the insert: the insert follows
 * its `job/end`, which an effect-free replay never writes, while the claim is
 * a step the replay reproduces.
 */
export function recordedNotices(events: readonly EventEnvelope[]): RecordedNotice[] {
  const waking = new Map<string, boolean>()
  const notices: RecordedNotice[] = []
  let at = { turn: 0, step: 0 }
  for (const event of events) {
    if (matches(event, STEP_START)) at = { turn: event.data.turn, step: event.data.step }
    else if (matches(event, INBOX_SPLICED) && event.data.op === 'insert' && noticeJobId(event.data.message) !== undefined) {
      waking.set(event.data.message.id, event.data.waking === true)
    } else if (matches(event, USER_MESSAGE) && noticeJobId(event.data.message) !== undefined) {
      notices.push({ message: event.data.message, waking: waking.get(event.data.message.id) ?? false, ...at })
    }
  }
  return notices
}

/**
 * Rebuilds a recorded auxiliary call as a chunk stream. Only the finished text
 * and usage were recorded — that is what the call's consumer read, so it is
 * exactly what a replay owes it.
 */
export function auxCallChunks(record: AuxCallRecord): StreamChunk[] {
  if (record.outcome.kind === 'error') {
    return [{ type: 'finish', reason: { kind: 'error', failure: record.outcome.failure } }]
  }
  const text = record.outcome.text
  const chunks: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  if (text.length > 0) chunks.push({ type: 'text-delta', index: 0, text })
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  if (record.usage) chunks.push({ type: 'usage', usage: record.usage })
  // A cut answer replays as one, so its consumer declines it again.
  chunks.push({ type: 'finish', reason: record.outcome.truncated ? { kind: 'max-tokens' } : { kind: 'stop' } })
  return chunks
}

/** Every provider a log names: its routes, its summaries, and the messages it produced. */
export function providersIn(events: readonly EventEnvelope[]): string[] {
  const providers = new Set<string>()
  for (const event of events) {
    if (matches(event, REQUEST_CONTEXT)) providers.add(event.data.provider)
    // The header too: a step whose every attempt FAILED writes a header and
    // its chunks but no assistant message, and a log from before the base
    // route was recorded has neither of the other two.
    else if (matches(event, REQUEST_HEADER)) providers.add(event.data.header.provider)
    else if (matches(event, AGENT_OPTIONS)) providers.add(event.data.options.provider)
    else if (matches(event, LLM_AUX_CALL)) providers.add(event.data.provider)
    else if (matches(event, ASSISTANT_MESSAGE) && event.data.message.source.kind === 'assistant') providers.add(event.data.message.source.provider)
  }
  return [...providers]
}

/**
 * The window the log recorded per route, so a replay meters what the recording
 * metered. LAST record wins per route: a log whose route kept its name while
 * its facts moved — a 1.1.0 `deepseek-v4-flash` segment (text, 1M) resumed
 * under S18's catalog (text and image, 1,048,576) — replays every step with
 * the later facts (the modality fold below likewise). Exact for every log
 * recorded under one catalog, which is every arc's.
 */
export function windowsIn(events: readonly EventEnvelope[]): Map<string, number> {
  const windows = new Map<string, number>()
  for (const event of events) {
    if (matches(event, REQUEST_CONTEXT) && event.data.contextWindow !== undefined) {
      windows.set(`${event.data.provider}/${event.data.model}`, event.data.contextWindow)
    }
  }
  return windows
}

/**
 * The modalities the log recorded per route.
 *
 * Load-bearing, not tidy: a producer of non-text content refuses when the
 * route's `inputModalities` lacks its kind, and absent means text only. Without
 * this a replayed vision session would refuse its own recorded image — the tool
 * would return an error, the attachment would never be written, and the
 * recorded answer would replay anyway, so `assertConsumed()` would pass on
 * arithmetic while nothing under test had run.
 */
export function modalitiesIn(events: readonly EventEnvelope[]): Map<string, readonly ModelModality[]> {
  const modalities = new Map<string, readonly ModelModality[]>()
  for (const event of events) {
    if (matches(event, REQUEST_CONTEXT) && event.data.inputModalities !== undefined) {
      modalities.set(`${event.data.provider}/${event.data.model}`, event.data.inputModalities)
    }
  }
  return modalities
}

/** The adapters' common vocabulary, always advertised: what a replay serves when the log names no effort. */
const BASE_EFFORTS = ['off', 'low', 'high', 'max'] as const

/**
 * Every effort the log ran at, after the common ones. A fixed set could not
 * advertise a recording made at `medium`, `xhigh` or `minimal` (the OpenAI and
 * Anthropic vocabularies), so a replay would describe a route the recording
 * never had.
 */
export function effortsIn(events: readonly EventEnvelope[]): readonly string[] {
  const efforts = new Set<string>(BASE_EFFORTS)
  for (const event of events) {
    if (matches(event, REQUEST_HEADER) && event.data.header.reasoningEffort !== undefined) efforts.add(event.data.header.reasoningEffort)
    else if (matches(event, AGENT_OPTIONS) && event.data.options.reasoningEffort !== undefined) efforts.add(event.data.options.reasoningEffort)
  }
  return [...efforts]
}

/**
 * The route a recorded session OPENED on — its first `request/context` — for
 * a replay to open on the same one. A literal in its place drifted: six arcs
 * replayed on the retired `deepseek-v4-flash` alias what serve had recorded on
 * `deepseek-flash`, so every route fact fell back to a text-only, 1,000,000
 * window default. For a one-route log it is `foldRequestContext`'s answer.
 */
export function recordedRoute(events: readonly EventEnvelope[]): { readonly provider: string; readonly model: string } {
  const first = events.find((event) => matches(event, REQUEST_CONTEXT))
  if (first === undefined || !matches(first, REQUEST_CONTEXT)) throw new Error('llm-replay: the log recorded no request/context, so it names no route to replay on')
  return { provider: first.data.provider, model: first.data.model }
}

/** The same facts keyed by model alone, for a replay whose provider was renamed. */
function byModel<T>(routed: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  const out = new Map<string, T>()
  for (const [route, value] of routed) out.set(route.slice(route.indexOf('/') + 1), value)
  return out
}

/** How a replayed call reaches the world: its body runs, or the recording answers for it. */
export type ReplayEffects = 'run' | 'recorded'

/** One recorded tool call's answer, as the driver logged it. */
interface RecordedAnswer {
  readonly name: string
  readonly result: ToolResult
  /**
   * Whether a body answered it. A log that records dispatches says (`yes` or
   * `no`); a log from before the fact existed says only that a SUCCESS came
   * from a body (the gate answers with errors alone), so its errors are
   * `unknown` — `FS_NOT_OBSERVED`, say, is refused inside the body.
   */
  readonly bodied: 'yes' | 'no' | 'unknown'
}

const answerKey = (turn: number, step: number, callId: string): string => `${turn}:${step}:${callId}`

/**
 * Every recorded tool result, by (turn, step, callId) — a call id is unique
 * only within a step, and a replay that drives the same prompts reproduces the
 * recording's turn and step numbering.
 *
 * Whether a missing dispatch means "no body ran" is a property of the WRITER,
 * so it is decided per lifecycle segment (between `session/end-seed`s) from
 * the segment's own `session/lifecycle` CLAIM, never from the presence of a
 * `tool/dispatch` in it (§4: readers use its claims, never its presence): a
 * 1.0.0 segment of a log a later build resumed claims nothing, and so does an
 * unreleased S14–S15 log, which then reads conservatively rather than as proof.
 */
export function recordedAnswers(events: readonly EventEnvelope[]): Map<string, RecordedAnswer> {
  const names = new Map<string, string>()
  const dispatched = new Set<string>()
  /** Per event index, the segment it lies in; per segment, whether its writer records dispatches. */
  const segmentOf: number[] = []
  const recordsDispatch: boolean[] = [false]
  events.forEach((event, index) => {
    if (matches(event, END_SEED)) recordsDispatch.push(false)
    const segment = recordsDispatch.length - 1
    segmentOf[index] = segment
    if (matches(event, SESSION_LIFECYCLE) && event.data.dispatch === true) recordsDispatch[segment] = true
    else if (matches(event, TOOL_CALL)) names.set(answerKey(event.data.turn, event.data.step, event.data.callId), event.data.name)
    else if (matches(event, TOOL_DISPATCH)) dispatched.add(answerKey(event.data.turn, event.data.step, event.data.callId))
  })
  const answers = new Map<string, RecordedAnswer>()
  for (const [index, event] of events.entries()) {
    if (!matches(event, TOOL_RESULT)) continue
    const key = answerKey(event.data.turn, event.data.step, event.data.callId)
    const block = event.data.message.content[0]
    const content = block?.type === 'tool-result' ? block.content : event.data.message.content
    const isError = block?.type === 'tool-result' && block.isError === true
    const result: ToolResult = {
      isError,
      content,
      ...(event.data.error === undefined ? {} : { error: { message: event.data.error.code, info: event.data.error } }),
    }
    const bodied = recordsDispatch[segmentOf[index]!] === true ? (dispatched.has(key) ? 'yes' : 'no') : event.data.error === undefined ? 'yes' : 'unknown'
    answers.set(key, { name: names.get(key) ?? '', result, bodied })
  }
  return answers
}

/**
 * Every delegation a log recorded: the child ids its `subagent/start`s name,
 * by the (turn, step, callId) of the delegating call. The step is the
 * ENCLOSING one — the last `step/start` before the record, which the
 * delegation tool appends inside its call's body — because a call id is unique
 * only within a step. A list, so a key two records share is refused as
 * ambiguous rather than settled by position.
 */
function recordedDelegations(events: readonly EventEnvelope[]): Map<string, string[]> {
  const delegations = new Map<string, string[]>()
  let at = { turn: 0, step: 0 }
  for (const event of events) {
    if (matches(event, STEP_START)) at = { turn: event.data.turn, step: event.data.step }
    else if (matches(event, SUBAGENT_START)) {
      const key = answerKey(at.turn, at.step, event.data.callId)
      delegations.set(key, [...(delegations.get(key) ?? []), event.data.childId])
    }
  }
  return delegations
}

/**
 * A log that repair answered is not an oracle: its synthetic results say what
 * nobody's body did. Every closer repair (or a fork of a held log) writes
 * counts — a conservative tool result, `turn/end{interrupted}`, and the three
 * brackets it closes beside them, `job/end{lost}`, `subagent/end{interrupted}`
 * and `compaction/end{unclosed}`. The header promised all of them and the
 * check once read only the first two.
 */
function repairedInterruption(events: readonly EventEnvelope[]): boolean {
  return events.some(
    (event) =>
      (matches(event, TOOL_RESULT) && (event.data.error?.name === 'InterruptedError' || CONSERVATIVE_ERROR_NAMES.has(event.data.error?.name ?? ''))) ||
      (matches(event, TURN_END) && event.data.reason.kind === 'interrupted') ||
      (matches(event, JOB_END) && event.data.cause === 'lost') ||
      (matches(event, SUBAGENT_END) && event.data.reason.kind === 'interrupted') ||
      (matches(event, COMPACTION_END) && event.data.outcome.kind === 'declined' && event.data.outcome.reason === 'unclosed'),
  )
}

/** A recorded out-of-loop call: its purpose travels with its chunks, so a replay can refuse to serve one purpose's record to another's request. */
interface AuxGroup {
  readonly purpose: string
  readonly chunks: StreamChunk[]
}

/** One recorded log's script: log order is the cursor, whatever route a call took. */
class ReplayScript {
  private readonly script: StreamChunk[][]
  private readonly keys: string[]
  private readonly auxScript: AuxGroup[]
  private cursor = 0
  private auxCursor = 0
  /** The session id a child's log was recorded under; the root's is never needed, because the root is bound by having no parent. */
  readonly id: string | undefined
  /** The recording's tool answers, and which of them the effect-free middleware has served. */
  readonly answers: Map<string, RecordedAnswer>
  readonly served = new Set<string>()
  /** The children this log delegated to, by the delegating call's (turn, step, callId). */
  readonly delegations: ReadonlyMap<string, readonly string[]>
  /** The recording's job notices still owed to the replayed session. */
  readonly notices: RecordedNotice[]
  /** Hands a notice to the replayed session bound to this script. */
  deliver: (sessionId: string, notice: RecordedNotice) => void = () => {}
  constructor(
    id: string | undefined,
    keyed: { script: StreamChunk[][]; keys: string[] },
    auxScript: AuxGroup[],
    answers: Map<string, RecordedAnswer>,
    delegations: ReadonlyMap<string, readonly string[]>,
    notices: RecordedNotice[] = [],
  ) {
    this.id = id
    this.script = keyed.script
    this.keys = keyed.keys
    this.auxScript = auxScript
    this.answers = answers
    this.delegations = delegations
    this.notices = notices
  }

  get label(): string {
    return this.id === undefined ? 'the root log' : `child log "${this.id}"`
  }

  /** The notices a step after the first took: owed once the previous step's model call is served, before that step's claim. */
  private dueAfterStep(index: number): RecordedNotice[] {
    const key = this.keys[index]!
    if (this.keys[index + 1] === key) return [] // a retried attempt follows: not this step's last call
    const [turn, step] = key.split(':').map(Number) as [number, number]
    return this.take((notice) => notice.turn === turn && notice.step === step + 1)
  }

  /** The notices that woke a turn: owed once the previous turn has ended. */
  dueAfterTurn(turn: number): RecordedNotice[] {
    return this.take((notice) => notice.step === 1 && notice.turn === turn + 1)
  }

  private take(due: (notice: RecordedNotice) => boolean): RecordedNotice[] {
    const taken = this.notices.filter(due)
    for (const notice of taken) this.notices.splice(this.notices.indexOf(notice), 1)
    return taken
  }

  async *stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    // `purpose` is the whole discriminator: the loop never sets one.
    if (request.purpose !== undefined) {
      const group = this.auxScript[this.auxCursor]
      if (!group) throw new Error(`llm-replay: no recorded "${request.purpose}" call ${this.auxCursor} to replay`)
      // Log order is the cursor, but the purpose must agree: once a session
      // records more than one kind of out-of-loop call, a drift in ordering
      // would otherwise hand a compaction summary to a verifier's request.
      if (group.purpose !== request.purpose) {
        throw new Error(`llm-replay: out-of-loop call ${this.auxCursor} was recorded as "${group.purpose}" but the request asks for "${request.purpose}"`)
      }
      this.auxCursor += 1
      for (const chunk of group.chunks) yield chunk
      return
    }
    const group = this.script[this.cursor]
    if (!group) throw new Error(`llm-replay: no recorded step ${this.cursor} to replay`)
    const index = this.cursor
    this.cursor += 1
    for (const chunk of group) yield chunk
    // Synchronously, here: a step that owes a request claims its next step's
    // input with no await after its last tool result, so a notice delivered
    // any later than the end of this call would miss the claim the recording made.
    for (const notice of this.dueAfterStep(index)) this.deliver(request.sessionId ?? '', notice)
  }

  consumed(): number {
    return this.cursor
  }

  total(): number {
    return this.script.length
  }

  auxConsumed(): number {
    return this.auxCursor
  }

  auxTotal(): number {
    return this.auxScript.length
  }
}

/**
 * Which recorded log answers which live session.
 *
 * A session log is its own oracle only for the agent that wrote it. A
 * delegated child is a DIFFERENT session making its own model calls through
 * the same seam, and one shared cursor served it the parent's next recorded
 * step: from the delegation onward every assistant message in the replayed
 * parent was a different message, and `assertConsumed` still passed because it
 * only compares a cursor to a length. The delegation arc's own comment recorded
 * that as intent.
 *
 * A session is bound to a log by its DELEGATION, never by the order it first
 * asks in. First-request order was the rule until S21, and it held only while
 * one child ran at a time: once a step's children run concurrently, which of
 * them asks first is a race, a child served its sibling's log replays another
 * conversation, and `assertConsumed` passes on arithmetic, because the cursors
 * still add up. The key is the join both sides already write durably (§4): the
 * live child's header names its parent (`delegatedBy`) and the call
 * (`delegatedByCallId`); the live parent's `tool/call` for that call gives its
 * (turn, step), which a replayed parent reproduces; and the parent's RECORDED
 * `subagent/start` at that (turn, step, callId) — a call id is unique only
 * within a step — names the recorded child, whose log was installed under that
 * id. A replayed child gets a fresh id, so its recorded one is reachable only
 * through its parent; a grandchild is found the same way, through its own
 * parent's log. The one session with no `delegatedBy` is the root, and binds to
 * the replay's own log.
 *
 * Every way the key can fail is a loud refusal naming the session and the key,
 * never a fallback to order. The seam turns the throw into a failed step, which
 * a replay could survive, so the refusal is also kept for `assertConsumed`.
 */
class ReplayDispatch {
  private readonly root: ReplayScript
  /** The installed child logs, by the session id each was recorded under. */
  private readonly children: ReadonlyMap<string, ReplayScript>
  private readonly live: (id: SessionId) => Agent | undefined
  private readonly bySession = new Map<string, ReplayScript>()
  /** The session each bound log answers: a log is one session's oracle, so it is bound once. */
  private readonly holders = new Map<ReplayScript, string>()
  /** Every child id some installed log's `subagent/start` names, to say why a log was never bound. */
  private readonly delegated: ReadonlySet<string>
  constructor(root: ReplayScript, children: ReadonlyMap<string, ReplayScript>, live: (id: SessionId) => Agent | undefined) {
    this.root = root
    this.children = children
    this.live = live
    this.delegated = new Set([root, ...children.values()].flatMap((script) => [...script.delegations.values()].flat()))
  }

  for(request: LlmRequest): ReplayScript {
    // A request with no session (a direct seam call) can only be the root's.
    const key = request.sessionId ?? '<no session>'
    const known = this.bySession.get(key)
    if (known) return known
    const script = request.sessionId === undefined ? this.rootFor(key) : this.resolve(request.sessionId)
    this.bySession.set(key, script)
    this.holders.set(script, key)
    return script
  }

  private resolve(sessionId: SessionId): ReplayScript {
    const agent = this.live(sessionId)
    if (!agent) return this.refuse(`session "${sessionId}" asked for a model and is not a live agent, so its lineage cannot be read`)
    const { delegatedBy, delegatedByCallId } = agent.session.header
    if (delegatedBy === undefined) return this.rootFor(sessionId)
    const parent = this.bySession.get(delegatedBy)
    if (!parent) return this.refuse(`child session "${sessionId}" was delegated by "${delegatedBy}", which never asked for a model here, so no recording holds its delegation`)
    if (delegatedByCallId === undefined) return this.refuse(`child session "${sessionId}" names no delegating call (delegatedByCallId), so its delegation cannot be keyed`)
    const delegator = this.live(delegatedBy)
    if (!delegator) return this.refuse(`child session "${sessionId}" was delegated by call ${delegatedByCallId} of "${delegatedBy}", which is not live`)
    // The parent's own record of the call, as `answerFromRecording` finds one.
    let at: { turn: number; step: number } | undefined
    const facts = delegator.session.facts
    for (let i = facts.length - 1; i >= 0 && at === undefined; i--) {
      const event = facts[i]!
      if (matches(event, TOOL_CALL) && event.data.callId === delegatedByCallId) at = { turn: event.data.turn, step: event.data.step }
    }
    if (!at) return this.refuse(`child session "${sessionId}" was delegated by call ${delegatedByCallId}, which its parent "${delegatedBy}" has no tool/call for`)
    const key = answerKey(at.turn, at.step, delegatedByCallId)
    const recorded = parent.delegations.get(key) ?? []
    if (recorded.length !== 1) {
      const found = recorded.length === 0 ? 'no subagent/start' : `${recorded.length} subagent/starts (${recorded.join(', ')})`
      return this.refuse(`child session "${sessionId}" was delegated by call ${key}, and ${parent.label} records ${found} for that call`)
    }
    const childId = recorded[0]!
    const script = this.children.get(childId)
    if (!script) return this.refuse(`child session "${sessionId}" was delegated by call ${key}, which the recording delegated to "${childId}", and no child log with that id was installed`)
    const holder = this.holders.get(script)
    if (holder !== undefined) return this.refuse(`child session "${sessionId}" (call ${key}) keys to ${script.label}, which already answers session "${holder}"`)
    return script
  }

  private rootFor(key: string): ReplayScript {
    const holder = this.holders.get(this.root)
    if (holder !== undefined) {
      return this.refuse(`session "${key}" is a second top-level session asking for a model, and the root log already answers "${holder}"; only a delegated child can have a log of its own`)
    }
    return this.root
  }

  private refuse(why: string): never {
    this.mismatch ??= why
    throw new Error(`llm-replay: ${why}`)
  }

  stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    return this.for(request).stream(request)
  }

  /** The recording a session was bound to at its first model request, if it has made one. */
  bound(sessionId: string): ReplayScript | undefined {
    return this.bySession.get(sessionId)
  }

  /**
   * The first way the replay left its recording, kept until `assertConsumed`:
   * a throw inside `tools/execute` becomes an ordinary error RESULT, so the
   * middleware cannot fail the replay by throwing — it records why instead.
   */
  mismatch: string | undefined

  effects: ReplayEffects = 'run'

  assertConsumed(): void {
    if (this.mismatch !== undefined) throw new Error(`llm-replay: the replay left its recording: ${this.mismatch}`)
    for (const source of [this.root, ...this.children.values()]) {
      const which = this.children.size === 0 ? '' : ` (${source.label})`
      // A child log no replayed delegation reached. One with no steps owes
      // nothing: a delegation whose call was cancelled before its child started
      // records the bracket, and the child never asks (`tool-subagent`).
      if (source !== this.root && !this.holders.has(source) && (source.total() > 0 || source.auxTotal() > 0)) {
        const why = this.delegated.has(source.id!) ? 'the recording delegated to it, and no replayed child was delegated by that call' : 'no installed log records a subagent/start for it'
        throw new Error(`llm-replay: ${source.label} was never bound to a session — ${why} — and holds ${source.total()} recorded step(s)`)
      }
      if (source.consumed() !== source.total()) {
        throw new Error(`llm-replay: replayed ${source.consumed()} of ${source.total()} recorded steps${which}`)
      }
      if (source.auxConsumed() !== source.auxTotal()) {
        throw new Error(`llm-replay: replayed ${source.auxConsumed()} of ${source.auxTotal()} recorded out-of-loop calls${which}`)
      }
      if (this.effects === 'recorded' && source.notices.length > 0) {
        throw new Error(`llm-replay: ${source.notices.length} recorded job notice(s) were never re-delivered${which}: ${source.notices.map((notice) => `${notice.message.id} at ${notice.turn}:${notice.step}`).join(', ')}`)
      }
      if (this.effects === 'recorded') {
        const owed = [...source.answers].filter(([key, answer]) => answer.bodied === 'yes' && !source.served.has(key)).map(([key]) => key)
        if (owed.length > 0) throw new Error(`llm-replay: ${owed.length} recorded tool answer(s) were never asked for${which}: ${owed.join(', ')}`)
      }
    }
  }
}

class ReplayAdapter implements LlmAdapter {
  readonly provider: string
  private readonly shared: ReplayDispatch
  private readonly windows: ReadonlyMap<string, number>
  private readonly modalities: ReadonlyMap<string, readonly ModelModality[]>
  private readonly windowsByModel: ReadonlyMap<string, number>
  private readonly modalitiesByModel: ReadonlyMap<string, readonly ModelModality[]>
  private readonly fallbackWindow: number
  private readonly efforts: readonly string[]
  constructor(
    provider: string,
    shared: ReplayDispatch,
    windows: ReadonlyMap<string, number>,
    modalities: ReadonlyMap<string, readonly ModelModality[]>,
    fallbackWindow: number,
    efforts: readonly string[] = BASE_EFFORTS,
  ) {
    this.provider = provider
    this.shared = shared
    this.windows = windows
    this.modalities = modalities
    this.windowsByModel = byModel(windows)
    this.modalitiesByModel = byModel(modalities)
    this.fallbackWindow = fallbackWindow
    this.efforts = efforts
  }

  stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    return this.shared.stream(request)
  }

  resolveModel(model: string): ResolvedModel {
    // The window and the modalities the log recorded for this route — and when
    // the caller RENAMED the provider (`installLlmReplay({provider})`), by model
    // alone, because renaming the seam does not rename the recording. Without
    // that fallback a renamed replay silently loses both: the window becomes a
    // default that moves where compaction fires relative to the recording, and
    // absent modalities read as text-only, so a recorded vision session refuses
    // its own image, writes no attachment, replays its recorded answer anyway,
    // and `assertConsumed()` passes on arithmetic.
    const route = `${this.provider}/${model}`
    const contextWindow = this.windows.get(route) ?? this.windowsByModel.get(model) ?? this.fallbackWindow
    const inputModalities = this.modalities.get(route) ?? this.modalitiesByModel.get(model)
    return {
      contextWindow,
      defaultMaxTokens: 8192,
      reasoning: { efforts: this.efforts, defaultEffort: 'high' },
      ...(inputModalities === undefined ? {} : { inputModalities }),
    }
  }

  listModels(): readonly ModelInfo[] {
    return [{ id: 'replay', name: 'Replay' }]
  }
}

/**
 * The effect-free middleware: the recording's answer for the call that just
 * reached its body, found by the (turn, step) of the replayed session's own
 * `tool/call` for it — which the driver appended moments before. `next` is
 * never called: the body does not run, and no `tool/dispatch` is written.
 */
async function answerFromRecording(shared: ReplayDispatch, execution: ToolExecution, _next: () => Promise<ToolResult>): Promise<ToolResult> {
  const refuse = (why: string): ToolResult => {
    shared.mismatch ??= why
    return { isError: true, content: [{ type: 'text', text: `Error: llm-replay: ${why}` }], error: { message: why, info: { name: 'ReplayMismatch', code: 'REPLAY_MISMATCH' } } }
  }
  const session = execution.agent?.session
  if (!session) return refuse(`call ${execution.callId} (${execution.name}) has no agent session to replay for`)
  const script = shared.bound(session.id)
  if (!script) return refuse(`session ${session.id} called a tool before it ever asked for a model`)
  let call: { turn: number; step: number } | undefined
  for (let i = session.facts.length - 1; i >= 0 && call === undefined; i--) {
    const event = session.facts[i]!
    if (matches(event, TOOL_CALL) && event.data.callId === execution.callId) call = { turn: event.data.turn, step: event.data.step }
  }
  if (!call) return refuse(`call ${execution.callId} (${execution.name}) reached a body with no tool/call on the record`)
  const key = answerKey(call.turn, call.step, execution.callId)
  const answer = script.answers.get(key)
  if (!answer) return refuse(`call ${key} (${execution.name}) reached a body, and the recording answered no such call`)
  if (answer.name !== execution.name) return refuse(`call ${key} is "${execution.name}" here and "${answer.name}" in the recording`)
  if (answer.bodied === 'no') return refuse(`call ${key} (${execution.name}) reached a body here, and the recording refused it before one`)
  script.served.add(key)
  return answer.result
}

export interface ReplayHandle {
  dispose: Disposer
  assertConsumed(): void
  readonly steps: number
  /** Recorded out-of-loop calls (compaction summaries) available to replay. */
  readonly auxCalls: number
  /** The providers the replay answers for. */
  readonly providers: readonly string[]
}

/**
 * Registers a replay adapter derived from `events` on `owner.llm`, under every
 * provider the log names (or the given ones). `contextWindow` is the fallback
 * for a route the log recorded no window for.
 */
export function installLlmReplay(
  owner: Context,
  options: {
    events: readonly EventEnvelope[]
    /**
     * The logs of the sessions this one DELEGATED to, and theirs to theirs,
     * each under the session id it was recorded with: a set, in no order. A
     * child makes its own model calls, and without its own log it would eat its
     * parent's next recorded step; it is bound to that log by the call that
     * delegated it (`ReplayDispatch`), never by when it first asks.
     */
    children?: readonly { readonly id: string; readonly events: readonly EventEnvelope[] }[]
    provider?: string
    providers?: readonly string[]
    contextWindow?: number
    attempts?: ReplayAttempts
    /** `run` (default): bodies run for real. `recorded`: the recording answers every call; nothing touches the world. */
    effects?: ReplayEffects
  },
): ReplayHandle {
  const effects = options.effects ?? 'run'
  const children = options.children ?? []
  if (effects === 'recorded') {
    if (children.length > 0) {
      throw new Error("llm-replay: an effect-free replay never runs a child — the delegating call's recorded result answers for it; pass no children")
    }
    if (repairedInterruption(options.events)) {
      throw new Error("llm-replay: this log holds a repaired interruption, so its recorded results are not all a body's; it is no oracle")
    }
  }
  const logs = [options.events, ...children.map((child) => child.events)]
  if (effects === 'run' && logs.some((events) => events.some((event) => matches(event, JOB_START)))) {
    throw new Error("llm-replay: this log ran background jobs, whose completions arrived when the clock said; replay it with effects: 'recorded', which re-delivers them where the recording took them")
  }
  const scriptOf = (id: string | undefined, events: readonly EventEnvelope[]): ReplayScript =>
    new ReplayScript(
      id,
      keyedReplayScript(events, options.attempts ?? 'every'),
      foldAuxCalls(events).map((record) => ({ purpose: record.purpose, chunks: auxCallChunks(record) })),
      recordedAnswers(events),
      recordedDelegations(events),
      effects === 'recorded' ? recordedNotices(events) : [],
    )
  const root = scriptOf(undefined, options.events)
  const byId = new Map<string, ReplayScript>()
  for (const child of children) {
    if (byId.has(child.id)) throw new Error(`llm-replay: two child logs were installed under the session id "${child.id}"`)
    byId.set(child.id, scriptOf(child.id, child.events))
  }
  const sources = [root, ...byId.values()]
  const shared = new ReplayDispatch(root, byId, (id) => owner.tryGet(AGENTS)?.get(id))
  shared.effects = effects
  // A re-delivered notice goes through the replayed agent's own inbox, with
  // the recorded waking flag: the one queue, exactly as a registry delivers.
  const deliver = (sessionId: string, notice: RecordedNotice): void => {
    const agent = owner.get(AGENTS).get(sessionId as never)
    if (!agent) {
      shared.mismatch ??= `job notice ${notice.message.id} is owed to session "${sessionId}", which is not live`
      return
    }
    agent.send(restoreMessage(notice.message), 'next-step', notice.waking)
  }
  for (const source of sources) source.deliver = deliver
  // Every log's routes, windows and modalities: a child may take a route its
  // parent never did — which is exactly what a vision verifier does.
  const windows = new Map<string, number>()
  const modalities = new Map<string, readonly ModelModality[]>()
  for (const events of logs) {
    for (const [route, window] of windowsIn(events)) windows.set(route, window)
    for (const [route, kinds] of modalitiesIn(events)) modalities.set(route, kinds)
  }
  const named = options.providers ?? (options.provider === undefined ? [...new Set(logs.flatMap((events) => providersIn(events)))] : [options.provider])
  const providers = named.length > 0 ? named : ['deepseek']
  const llm = owner.get(LLM)
  const efforts = [...new Set(logs.flatMap((events) => effortsIn(events)))]
  const disposers = providers.map((provider) => llm.registerAdapter(owner, new ReplayAdapter(provider, shared, windows, modalities, options.contextWindow ?? 1_000_000, efforts)))
  if (effects === 'recorded') {
    disposers.push(owner.on(TOOLS_EXECUTE, (execution, next) => answerFromRecording(shared, execution, next)))
    // A notice that woke a turn is owed once the turn before it ends — on a
    // microtask (a session/event listener may not append synchronously, §4),
    // which still lands while the driver awaits that turn's flush, so it is the
    // driver's own re-check of the inbox that opens the next turn, as live.
    disposers.push(
      owner.on(SESSION_EVENT, (session, event) => {
        if (!matches(event, TURN_END)) return
        const script = shared.bound(session.id)
        if (!script) return
        for (const notice of script.dueAfterTurn(event.data.turn)) queueMicrotask(() => deliver(session.id, notice))
      }),
    )
  }
  return {
    dispose: async () => {
      for (const dispose of disposers) await dispose()
    },
    steps: sources.reduce((count, one) => count + one.total(), 0),
    auxCalls: sources.reduce((count, one) => count + one.auxTotal(), 0),
    providers,
    assertConsumed: () => shared.assertConsumed(),
  }
}
