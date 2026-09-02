/**
 * Replay-from-the-log adapter. The model script is DERIVED from a recorded
 * session's `assistant/chunk` events (grouped by turn/step), so recording is
 * free: run the real agent once, harvest its JSONL, replay it keylessly.
 * `assertConsumed()` fails if any recorded step was not replayed.
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
 */
import type { Context, Disposer } from '../kernel/index.ts'
import { AGENT_OPTIONS } from '../core/agent/index.ts'
import { LLM, type LlmAdapter, type LlmRequest, type ModelInfo, type ModelModality, type ResolvedModel, type StreamChunk } from '../core/llm/index.ts'
import { foldAuxCalls, LLM_AUX_CALL, type AuxCallRecord } from '../core/llm/aux-call.ts'
import { ASSISTANT_CHUNK, ASSISTANT_MESSAGE, matches, REQUEST_CONTEXT, REQUEST_HEADER, type EventEnvelope } from '../core/session/index.ts'

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
  for (const key of order) {
    const list = groups.get(key)!
    const chosen = attempts === 'every' ? list : list.slice(-1)
    for (const entry of chosen) {
      // A group with no terminal finish is a crash artifact: the runtime always
      // normalizes to a terminal finish, so its absence means the process died
      // mid-stream and the agent never acted on it. In a resumed log the
      // artifact sits MID-log (completed turns follow it), so every finish-less
      // group is dropped — replaying one would silently desynchronize the script.
      if (entry.chunks.some((chunk) => chunk.type === 'finish')) script.push(entry.chunks)
    }
  }
  return script
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
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
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

/** The window the log recorded per route, so a replay meters what the recording metered. */
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

/** A recorded out-of-loop call: its purpose travels with its chunks, so a replay can refuse to serve one purpose's record to another's request. */
interface AuxGroup {
  readonly purpose: string
  readonly chunks: StreamChunk[]
}

/** One recorded log's script: log order is the cursor, whatever route a call took. */
class ReplayScript {
  private readonly script: StreamChunk[][]
  private readonly auxScript: AuxGroup[]
  private cursor = 0
  private auxCursor = 0
  constructor(script: StreamChunk[][], auxScript: AuxGroup[]) {
    this.script = script
    this.auxScript = auxScript
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
    this.cursor += 1
    for (const chunk of group) yield chunk
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
 * Sessions are matched to logs in FIRST-REQUEST order — a replayed child gets a
 * fresh id, so nothing can be keyed on the recorded one, but the order in which
 * agents first ask is exactly the order the recording delegated in. A session
 * that asks with no log left is a loud failure, not a silent reassignment.
 */
class ReplayDispatch {
  private readonly sources: readonly ReplayScript[]
  private readonly bySession = new Map<string, ReplayScript>()
  private assigned = 0
  constructor(sources: readonly ReplayScript[]) {
    this.sources = sources
  }

  for(request: LlmRequest): ReplayScript {
    const key = request.sessionId ?? '<no session>'
    const known = this.bySession.get(key)
    if (known) return known
    const source = this.sources[this.assigned]
    if (!source) {
      throw new Error(
        `llm-replay: ${this.assigned + 1} sessions have asked for a model, but only ${this.sources.length} recorded log(s) were installed — ` +
          `session "${key}" has none, and a delegated child makes its own calls and needs its own log`,
      )
    }
    this.assigned += 1
    this.bySession.set(key, source)
    return source
  }

  stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    return this.for(request).stream(request)
  }

  assertConsumed(): void {
    this.sources.forEach((source, index) => {
      const which = this.sources.length === 1 ? '' : ` (log ${index})`
      if (source.consumed() !== source.total()) {
        throw new Error(`llm-replay: replayed ${source.consumed()} of ${source.total()} recorded steps${which}`)
      }
      if (source.auxConsumed() !== source.auxTotal()) {
        throw new Error(`llm-replay: replayed ${source.auxConsumed()} of ${source.auxTotal()} recorded out-of-loop calls${which}`)
      }
    })
  }
}

class ReplayAdapter implements LlmAdapter {
  readonly provider: string
  private readonly shared: ReplayDispatch
  private readonly windows: ReadonlyMap<string, number>
  private readonly modalities: ReadonlyMap<string, readonly ModelModality[]>
  private readonly fallbackWindow: number
  constructor(
    provider: string,
    shared: ReplayDispatch,
    windows: ReadonlyMap<string, number>,
    modalities: ReadonlyMap<string, readonly ModelModality[]>,
    fallbackWindow: number,
  ) {
    this.provider = provider
    this.shared = shared
    this.windows = windows
    this.modalities = modalities
    this.fallbackWindow = fallbackWindow
  }

  stream(request: LlmRequest): AsyncIterable<StreamChunk> {
    return this.shared.stream(request)
  }

  resolveModel(model: string): ResolvedModel {
    // The window and the modalities the log recorded for this route; a log from
    // before `request/context` existed falls back to the caller's number and to
    // text only, which is what an absent field has always meant.
    const route = `${this.provider}/${model}`
    const contextWindow = this.windows.get(route) ?? this.fallbackWindow
    const inputModalities = this.modalities.get(route)
    return {
      contextWindow,
      defaultMaxTokens: 8192,
      reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
      ...(inputModalities === undefined ? {} : { inputModalities }),
    }
  }

  listModels(): readonly ModelInfo[] {
    return [{ id: 'replay', name: 'Replay' }]
  }
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
     * The logs of the sessions this one DELEGATED to, in the order it started
     * them — a child makes its own model calls, and without its own log it
     * would eat its parent's next recorded step.
     */
    children?: readonly (readonly EventEnvelope[])[]
    provider?: string
    providers?: readonly string[]
    contextWindow?: number
    attempts?: ReplayAttempts
  },
): ReplayHandle {
  const logs = [options.events, ...(options.children ?? [])]
  const sources = logs.map(
    (events) =>
      new ReplayScript(
        deriveReplayScript(events, options.attempts),
        foldAuxCalls(events).map((record) => ({ purpose: record.purpose, chunks: auxCallChunks(record) })),
      ),
  )
  const shared = new ReplayDispatch(sources)
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
  const disposers = providers.map((provider) => llm.registerAdapter(owner, new ReplayAdapter(provider, shared, windows, modalities, options.contextWindow ?? 1_000_000)))
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
