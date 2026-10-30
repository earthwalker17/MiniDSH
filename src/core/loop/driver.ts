import type { Context } from '../../kernel/index.ts'
import {
  AGENT_ERROR,
  AGENT_INBOX_CLAIMED,
  AGENT_INBOX_DISCARDED,
  AGENT_INBOX_INSERTED,
  AGENT_OPTIONS,
  AGENT_PRE_STEP,
  AGENT_REQUEST_ERROR,
  AGENT_STATUS,
  AGENT_TURN_STOPPING,
  canonicalAgentOptions,
  foldInbox,
  Inbox,
  INBOX_SPLICED,
  mergeAgentOptions,
  resolveCallConfig,
  sameAgentOptions,
  type Agent,
  type AgentOptions,
  type AgentStatus,
  type CallConfig,
  type CancelCause,
  type CancelOptions,
  type CreateAgentOptions,
  type InboxTarget,
  type PreStepDecision,
} from '../agent/index.ts'
import { asCallId, type SessionId } from '../ids.ts'
import { isJobNotice } from '../jobs/events.ts'
import type { JsonValue } from '../json.ts'
import { BlockAssembler, LLM, type ContentBlock, type Llm, type LlmRequest, type Message, type ModelModality } from '../llm/index.ts'
import { createAssistantMessage, createToolResultMessage } from '../llm/message.ts'
import { PROMPT, type AssembledPrompt, type Prompt } from '../prompt/index.ts'
import {
  ASSISTANT_CHUNK,
  ASSISTANT_MESSAGE,
  foldRequestContext,
  matches,
  REQUEST_CONTEXT,
  REQUEST_HEADER,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_DISPATCH,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type RequestContextRecord,
  type RequestHeader,
  type Session,
  type TurnEndReason,
} from '../session/index.ts'
import { TOOLS, toolCall, type ToolResult, type Tools } from '../tools/index.ts'
import { markLoopRequest } from './marker.ts'

export interface LoopDeps {
  readonly llm: Llm
  readonly tools: Tools
  readonly prompt: Prompt
}

const DEFAULT_MAX_STEPS = 24
/** Concurrency-safe bodies one step runs at once when the agent's options name no width (§6). */
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4

/**
 * A durability checkpoint failed: a write the persistence provider remembered
 * losing. The driver starts nothing more — no model request, no tool body — on
 * a session whose durable record has already diverged from what it is about to
 * do; a concurrency-safe body already in flight is told (its signal aborts with
 * this cause) and drained, never abandoned.
 */
class DurabilityLost extends Error {
  readonly code = 'DURABILITY_LOST' as const
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DurabilityLost'
  }
}

type StepResult =
  | { kind: 'stop' }
  | { kind: 'continue' }
  | { kind: 'concluded' }
  | { kind: 'max-tokens' }
  | { kind: 'error'; reason: TurnEndReason }

type ToolCallBlock = Extract<ContentBlock, { type: 'tool-call' }>

/** One logged call of a step: its outcome, once it has one, waits here for its turn to commit. */
interface CallSlot {
  readonly call: ToolCallBlock
  readonly callSeq: number
  result?: ToolResult
}

/** An error result for a call no body answered. */
function refusedResult(text: string, name: string, code: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }], error: { message: text, info: { name, code } } }
}

/** The one concrete agent driver: the turn/step state machine over the session log. */
export class ReactLoopAgent implements Agent {
  readonly id: SessionId
  readonly session: Session
  readonly inbox: Inbox
  readonly world: CreateAgentOptions['world']
  /** The base route: the fold of `agent/options`, held live so every step starts from it. */
  private base: AgentOptions
  private _ctx: Context | undefined
  private _status: AgentStatus = 'idle'
  private deps: LoopDeps | undefined
  private maxSteps: number
  private maxParallel: number
  private turnCount = 0
  private firstLiveTurn = 1
  private abort = new AbortController()
  private running = false
  private disposed = false
  private idleWaiters: (() => void)[] = []

  constructor(session: Session, options: AgentOptions, world?: CreateAgentOptions['world']) {
    this.id = session.id
    this.session = session
    this.world = world
    this.base = canonicalAgentOptions(options)
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.maxParallel = options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
    this.inbox = new Inbox(
      (event, message, target) => this.onInbox(event, message, target),
      (splice) => this.session.append(INBOX_SPLICED, splice),
    )
  }

  /** Called by the factory once the scoped context exists (the agent is its scope key). */
  attach(ctx: Context): void {
    this._ctx = ctx
    this.deps = { llm: ctx.get(LLM), tools: ctx.get(TOOLS), prompt: ctx.get(PROMPT) }
    // A seeded (forked/resumed) session already contains turns; numbering must continue, not restart.
    for (const event of this.session.facts) {
      if (matches(event, TURN_START) && event.data.turn > this.turnCount) this.turnCount = event.data.turn
    }
    this.firstLiveTurn = this.turnCount + 1
    // A resumed (or forked) log may carry pending input; restore it silently —
    // the records already in the log are its durable trace.
    this.inbox.restore(foldInbox(this.session.facts))
  }

  /** Post-publication: run restored waking work without new input (the factory calls this). */
  wakeIfPending(): void {
    if (!this.disposed && !this.running && this.inbox.hasWakingPending) this.start()
  }

  get ctx(): Context {
    if (!this._ctx) throw new Error('agent context not attached')
    return this._ctx
  }

  get status(): AgentStatus {
    return this._status
  }

  get options(): AgentOptions {
    return this.base
  }

  configure(options: Partial<AgentOptions>): AgentOptions {
    const merged = mergeAgentOptions(this.base, options)
    if (sameAgentOptions(merged, this.base)) return this.base
    this.base = merged
    this.maxSteps = merged.maxSteps ?? DEFAULT_MAX_STEPS
    this.maxParallel = merged.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
    // The switch IS its event; the next step resolves its route from here.
    this.session.append(AGENT_OPTIONS, { options: merged, reason: 'change' })
    return merged
  }

  private onInbox(event: 'inserted' | 'discarded' | 'claimed', message: Message, target?: InboxTarget): void {
    if (event === 'inserted') this.ctx.emit(AGENT_INBOX_INSERTED, this, message, target ?? 'next-step')
    else if (event === 'claimed') this.ctx.emit(AGENT_INBOX_CLAIMED, this, message)
    else this.ctx.emit(AGENT_INBOX_DISCARDED, this, message)
  }

  send(message: Message, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) {
      // Disposal has begun, so nothing runs here again. Step input that arrives
      // now — a runtime notice, the end of a job this very disposal stopped — is
      // RECORDED for the session's next lifecycle, quiet, rather than dropped:
      // the inbox re-delivers, never loses (§4), and it enters with the next
      // prompt. A PROMPT racing the shutdown is not: a restored next-turn entry
      // wakes a resume, and nobody saw that prompt accepted. Only a session the
      // store has closed takes nothing more.
      if (target === 'next-step' && !this.session.isClosed) this.inbox.append(message, target, false)
      return
    }
    this.inbox.append(message, target, wakeup)
    if (wakeup && !this.running) this.start()
  }

  followup(message: Message): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: Message): void {
    this.send(message, 'next-step', true)
  }

  inject(message: Message): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: CancelCause, options?: CancelOptions): void {
    if (cause.kind === 'disposed') this.disposed = true
    // Graceful teardown must not durably erase the queue the log preserves for
    // the next resume; a user/hook cancel means it, unless the caller says the
    // queue is not theirs alone to discard (several clients on one session).
    if (!options?.keepInbox) this.inbox.clear(cause.kind !== 'disposed')
    if (this.running) this.abort.abort(cause)
  }

  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private setStatus(next: AgentStatus): void {
    if (this._status === next) return
    this._status = next
    // Waiters first: an observer rejecting the status emit must not strand a
    // whenIdle() that was already owed.
    if (next === 'idle') {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
    this.ctx.emit(AGENT_STATUS, this, next)
  }

  /** The driver is fire-and-forget; whatever escapes it is reported, never left as an unhandled rejection. */
  private start(): void {
    this.run().catch((error: unknown) => {
      this.ctx.emit(AGENT_ERROR, this, error)
      this.ctx.logger.error(`agent ${this.id}: driver failure`, error)
    })
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    this.setStatus('running')
    try {
      do {
        try {
          await this.turn()
        } catch (error) {
          // turn() handles its own failures; what reaches here escaped the turn
          // boundary (an append/flush failure in its finally). Contain it — the
          // driver promise is fire-and-forget and must never reject unobserved.
          this.ctx.emit(AGENT_ERROR, this, error)
          this.ctx.logger.error(`agent ${this.id}: turn boundary failure`, error)
          break
        }
      } while (this.inbox.hasWakingPending && !this.disposed)
    } finally {
      this.running = false
      this.setStatus('idle')
    }
  }

  private async turn(): Promise<void> {
    const turn = ++this.turnCount
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.session.append(TURN_START, { turn })
    let reason: TurnEndReason = { kind: 'completed' }
    try {
      let step = 0
      let firstStep = true
      while (true) {
        if (signal.aborted) throw new Error('turn aborted')
        step += 1
        const { messages: claimed } = this.inbox.claim(firstStep)
        // Whatever consumed (or killed) the claim commits it, so durable = live
        // on every exit path — including a pre-step listener throw or a cancel
        // landing inside the pre-step await (whose clear records it first).
        const commitClaim = (): void => this.inbox.commitClaim()
        let decision: PreStepDecision
        let config: CallConfig
        try {
          // The route first: what a pre-step listener measures against (the
          // window a pressure check needs) must be the route THIS step will
          // use, and a listener that rewrites it (a role) is consulted once
          // per step — here, for the step and its context record alike.
          config = await resolveCallConfig(this, { turn, step, signal })
          this.recordRoute(config)
          decision = await this.ctx.waterfall(
            AGENT_PRE_STEP,
            { agent: this, messages: claimed, turn, step, signal },
            async () => ({ kind: 'enter', messages: claimed }) as PreStepDecision,
          )
        } catch (error) {
          commitClaim()
          this.requeueNotices(claimed)
          throw error
        }
        if (signal.aborted) {
          commitClaim()
          this.requeueNotices(claimed)
          throw new Error('turn aborted')
        }
        if (decision.kind === 'reject') {
          commitClaim()
          // A job's end notice has an exactly-once delivery contract: a step
          // that never entered it hands it back, as the throw and cancel
          // paths above do (S20.5 review).
          this.requeueNotices(claimed)
          reason = { kind: 'blocked' }
          break
        }
        const entered = decision.messages
        const dropped = claimed.filter((message) => !entered.includes(message))
        if (firstStep && entered.length === 0) {
          commitClaim()
          this.requeueNotices(dropped)
          break
        }
        // A listener may narrow a batch; a notice it left out is owed, not
        // consumed — owed to a later turn, or it would keep this one stepping.
        for (const message of dropped) if (isJobNotice(message)) this.inbox.hold(message)
        this.session.append(STEP_START, { turn, step })
        let result: StepResult
        try {
          // Inside the try: a message append failure must still close the step.
          for (const message of entered) this.session.append(USER_MESSAGE, { message }, { surfaceOp: { op: 'append' } })
          // The claim record lands AFTER the entered messages: a crash inside the
          // pre-step await re-delivers a prompt on resume rather than losing it
          // (the accepted failure mode is a rare double-delivery, never a loss).
          commitClaim()
          result = await this.step(turn, step, signal, config)
        } finally {
          // step/end must close the step even when the request throws (e.g. cancellation),
          // so the turn stays structurally valid before turn/end.
          this.session.append(STEP_END, { turn, step })
        }
        firstStep = false

        if (result.kind === 'error') {
          reason = result.reason
          break
        }
        if (result.kind === 'max-tokens') {
          reason = { kind: 'max-tokens' }
          break
        }
        if (result.kind === 'concluded') break
        const owesRequest = result.kind === 'continue'
        if (!owesRequest && !this.inbox.hasStepPending) {
          await this.ctx.serial(AGENT_TURN_STOPPING, { agent: this, turn, signal })
          if (!this.inbox.hasStepPending) break
        }
        if (step >= this.maxSteps) {
          reason = { kind: 'max-steps' }
          break
        }
      }
    } catch (error) {
      if (signal.aborted) {
        reason = { kind: 'cancelled' }
      } else {
        const code = error instanceof DurabilityLost ? error.code : 'LOOP_FAILED'
        reason = { kind: 'error', code, message: error instanceof Error ? error.message : String(error) }
        this.ctx.emit(AGENT_ERROR, this, error)
      }
    } finally {
      this.inbox.releaseHeld()
      this.session.append(TURN_END, { turn, reason })
      // A turn that already ended on a lost write reported it once; the
      // provider keeps refusing every flush, and that is not a second failure.
      if (reason.kind === 'error' && reason.code === 'DURABILITY_LOST') await this.session.flush().catch(() => undefined)
      else await this.session.flush()
    }
  }

  private async step(turn: number, step: number, signal: AbortSignal, config: CallConfig): Promise<StepResult> {
    const deps = this.deps!
    const assembled = await deps.prompt.assemble(this)
    const header = this.buildHeader(config, assembled)
    const folded = this.session.foldRequestHeader()
    // Written only when it differs, so each request append-extends its
    // predecessor: what a provider prefix cache rewards.
    if (!folded || JSON.stringify(folded) !== JSON.stringify(header)) {
      // A change surfacing at the first step of a resumed lifecycle is explained
      // by the resume (new composition, new tools) rather than a mid-run switch.
      const resume = this.session.origin === 'resumed' && turn === this.firstLiveTurn && step === 1
      this.session.append(REQUEST_HEADER, { turn, step, header, reason: !folded ? 'initial' : resume ? 'resume' : 'change' })
    }

    /**
     * Built per ATTEMPT, not per step. The header, the system prompt and the
     * tools are fixed for the step, but `messages` is a projection of the log,
     * and a recovery listener may legally have changed the log between
     * attempts — a compaction answering `CONTEXT_WINDOW_EXCEEDED` does exactly
     * that. Re-deriving keeps "model-visible ⟺ logged" true for every attempt;
     * when nothing changed, the second attempt rebuilds an identical request.
     */
    const buildRequest = (): LlmRequest => {
      const request: LlmRequest = Object.freeze({
        provider: config.provider,
        model: config.model,
        system: assembled.system,
        messages: Object.freeze(this.session.deriveMessages()),
        tools: assembled.tools,
        ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        signal,
        sessionId: this.id,
      })
      markLoopRequest(request, this.session)
      return request
    }

    let attempt = 0
    for (;;) {
      attempt += 1
      // Durable before the next action: a paid request never follows a lost write.
      await this.checkpoint()
      const request = buildRequest()
      const assembler = new BlockAssembler()
      for await (const chunk of deps.llm.stream(request)) {
        this.session.append(ASSISTANT_CHUNK, { turn, step, attempt, chunk: chunk as unknown as JsonValue })
        assembler.push(chunk)
      }
      const finish = assembler.finish
      const blocks = assembler.blocks()

      if (finish.kind === 'aborted') {
        // Keep the visible prefix but drop tool-call blocks: an assistant message
        // carrying tool calls with no results would poison every later request.
        const visible = blocks.filter((block) => block.type !== 'tool-call')
        this.session.append(
          ASSISTANT_MESSAGE,
          { turn, step, message: createAssistantMessage(visible, config.provider, config.model), interrupted: true },
          { surfaceOp: { op: 'append' } },
        )
        throw new Error('request aborted')
      }
      if (finish.kind === 'error') {
        const action = await this.ctx.waterfall(
          AGENT_REQUEST_ERROR,
          { agent: this, turn, step, provider: config.provider, failure: finish.failure, signal },
          async () => undefined,
        )
        // A cancellation that lands during recovery (e.g. retry backoff) is a
        // cancellation, not a provider failure.
        if (signal.aborted) throw new Error('request aborted during recovery')
        if (action?.kind === 'retry') continue
        return { kind: 'error', reason: { kind: 'error', code: finish.failure.code, message: finish.failure.message } }
      }

      // The adapter's replay envelope rides on the message's source, pruned to
      // the blocks the message carries; it is the provider's own to read back.
      const message = createAssistantMessage(blocks, config.provider, config.model, assembler.replayState)
      const usage = assembler.usage
      this.session.append(
        ASSISTANT_MESSAGE,
        { turn, step, message, ...(usage === undefined ? {} : { usage }) },
        { surfaceOp: { op: 'append' } },
      )

      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }
      const toolCalls = blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'stop' }
      const concluded = await this.executeTools(turn, step, toolCalls, signal)
      return concluded ? { kind: 'concluded' } : { kind: 'continue' }
    }
  }

  /**
   * A step's tool calls: ONE ordered lane, bodies that may overlap, results in
   * model order (ARCHITECTURE §6, "joined at the step").
   *
   * The lane is each call's durable sequence, in model order: `tool/call` →
   * checkpoint → gate → `tool/dispatch` → checkpoint. A call whose tool declares
   * `concurrencySafe` hands the lane on once its dispatch is durable — or once it
   * settled without one (a refusal, a replay's middleware) — so its BODY
   * overlaps the next call's lane and its siblings' bodies, up to this agent's
   * width. Any other call is a barrier: it waits until every earlier result has
   * COMMITTED, then runs alone, exactly as every call ran before S21; with a
   * width of 1 every call is one.
   *
   * Every outcome resolves its call's slot, and only `commitReady` appends a
   * `tool/result`, strictly in model order, so the surface a later barrier
   * reads, and every request derived from it, are the same whatever order the
   * bodies finished in. The lane waits for a free slot BEFORE it logs the next
   * call, so a crash finds a call still waiting with no `tool/call` at all
   * (`TOOL_NOT_STARTED`), and one at its gate with no `tool/dispatch`.
   *
   * The step never ends with a body running. A cancellation or a lost write
   * stops the lane, drains what runs, and answers every call it never reached;
   * a lost write also aborts the bodies in flight (with its own cause, so the
   * turn still ends `DURABILITY_LOST`, not `cancelled`): nothing STARTS after a
   * lost write, and what had started is told and drained.
   */
  private async executeTools(turn: number, step: number, toolCalls: readonly ToolCallBlock[], signal: AbortSignal): Promise<boolean> {
    const deps = this.deps!
    const width = Math.max(1, this.maxParallel)
    const stepAbort = new AbortController()
    const callSignal = AbortSignal.any([signal, stepAbort.signal])
    const slots: CallSlot[] = []
    const running = new Set<Promise<void>>()
    const seen = new Set<string>()
    let committed = 0
    let concluded = false
    let lost: DurabilityLost | undefined
    let failure: { readonly error: unknown } | undefined

    const markLost = (error: unknown): void => {
      lost ??= error instanceof DurabilityLost ? error : new DurabilityLost(error)
      stepAbort.abort(lost)
    }
    /** Appends every settled result at the head of the step's order; never throws (a failure is the step's, reported once it drained). */
    const commitReady = (): void => {
      while (committed < slots.length && slots[committed]!.result !== undefined) {
        const slot = slots[committed++]!
        try {
          if (this.commitResult(turn, step, slot)) concluded = true
        } catch (error) {
          failure ??= { error }
        }
      }
    }
    const settle = (slot: CallSlot, result: ToolResult): void => {
      if (slot.result !== undefined) return
      slot.result = result
      commitReady()
    }
    const drain = async (): Promise<void> => {
      while (running.size > 0) await Promise.race(running)
    }
    /** Logs a call and gives it its slot in ONE synchronous segment: no result can ever precede its call. */
    const open = (call: ToolCallBlock): CallSlot => {
      const callEvent = this.session.append(TOOL_CALL, { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
      const slot: CallSlot = { call, callSeq: callEvent.seq }
      slots.push(slot)
      return slot
    }

    try {
      for (const call of toolCalls) {
        // A repeated id is a barrier: its first call must be answered before
        // the second is logged, or the step would hold two pending calls the
        // log cannot tell apart.
        const pooled = width > 1 && !seen.has(call.id) && deps.tools.get(call.name, this)?.concurrencySafe === true
        seen.add(call.id)
        if (pooled) {
          while (running.size >= width) await Promise.race(running)
        } else {
          await drain()
        }
        if (signal.aborted || lost || failure) break
        const slot = open(call)
        // Durable before the next effect: the checkpoint sits between the call
        // record and the gate, so a lost write leaves this call answered and
        // no later one run, the same shape as a cancellation.
        try {
          await this.checkpoint()
        } catch (error) {
          markLost(error)
        }
        if (signal.aborted || lost) {
          settle(slot, lost ? this.notDispatched('lost') : this.notDispatched('aborted'))
          break
        }
        /**
         * The second checkpoint of a call, and the one that makes the recovery
         * contract readable: the pipeline runs it once the gate has passed and
         * immediately before the body, so `tool/dispatch` is durable exactly
         * when — and only when — an effect could follow. Without it, absence of
         * the record would not prove absence of the body, and repair would have
         * to read every logged call as outcome-unknown, which is where it
         * started. The flush is a real sync under a `synced` store — milliseconds,
         * inside the call's deadline (`tools/registry.ts`) — and it is what lets a
         * synced lifecycle read a missing dispatch as "never ran" after a power cut.
         *
         * A lost write sets `lost` HERE rather than leaving the pipeline to
         * return an error result on its own, because the turn must end the way
         * every lost write ends it. The result alone would let a last call that
         * concludes the turn, or one that hits `maxSteps`, close it `completed`.
         *
         * Its settling, either way, is also where the lane moves on from a
         * pooled call: the gate is behind it and the dispatch is on the record.
         */
        let release!: () => void
        const released = new Promise<void>((resolve) => (release = resolve))
        const onDispatch = async (): Promise<void> => {
          try {
            this.session.append(TOOL_DISPATCH, { turn, step, callId: call.id })
            try {
              await this.checkpoint()
            } catch (error) {
              markLost(error)
              throw error
            }
          } finally {
            release()
          }
        }
        const outcome = deps.tools.execute(toolCall(call.id, call.name, call.arguments, this, callSignal, onDispatch)).then(
          (result) => settle(slot, result),
          // The pipeline turns a throw into a result; this is the floor under it.
          // A logged call with no result is a history every provider refuses, and
          // no repair heals one inside a closed turn (S20.5 review).
          (error: unknown) => {
            const text = error instanceof Error ? error.message : String(error)
            settle(slot, refusedResult(`Error: ${text}`, 'Error', 'TOOL_FAILED'))
          },
        )
        if (pooled) {
          const tracked: Promise<void> = outcome.then(() => void running.delete(tracked))
          running.add(tracked)
          await Promise.race([released, outcome])
        } else {
          await outcome
        }
        if (lost) break
      }
    } catch (error) {
      // Nothing in the lane is meant to throw; if something does, nothing more
      // starts, what runs is told and drained, and the step still ends with
      // every call answered (S21: `step/end` refuses a pending call).
      failure ??= { error }
      stepAbort.abort(error)
    }
    await drain()
    commitReady()
    // Every call the lane never reached is answered, after every started one
    // has committed, so the step's results stay in model order to the end.
    for (const call of toolCalls.slice(slots.length)) {
      try {
        settle(open(call), lost ? this.notDispatched('lost') : this.notDispatched('aborted'))
      } catch (error) {
        failure ??= { error }
        break
      }
    }
    if (failure !== undefined) throw failure.error
    if (lost) throw lost
    return concluded
  }

  /** A call answered without a body: cancelled before dispatch, or after a lost write. */
  private notDispatched(why: 'lost' | 'aborted'): ToolResult {
    return why === 'lost'
      ? refusedResult('Error: tool call not dispatched: the session lost durability', 'DurabilityLost', 'DURABILITY_LOST')
      : refusedResult('Error: tool call aborted before dispatch', 'AbortError', 'ABORTED_BEFORE_DISPATCH')
  }

  /**
   * One `tool/result`, citing its call, then the call's quiet next-step
   * contexts. Returns whether the call concluded the turn. A result the log
   * refuses (a render it cannot store) is replaced by a minimal text-only
   * failure for the same call, the live twin of repair: a logged call never
   * reaches `step/end` unanswered.
   */
  private commitResult(turn: number, step: number, slot: CallSlot): boolean {
    const { call, callSeq } = slot
    const result = slot.result!
    const options = { surfaceOp: { op: 'append' as const }, sourceEventSeqs: [callSeq] }
    try {
      this.session.append(
        TOOL_RESULT,
        {
          turn,
          step,
          callId: call.id,
          message: createToolResultMessage(call.id, [...result.content], result.isError),
          ...(result.error?.info ? { error: { name: result.error.info.name, code: result.error.info.code } } : {}),
        },
        options,
      )
    } catch (error) {
      const text = `Error: the tool's result could not be recorded: ${error instanceof Error ? error.message : String(error)}`
      this.session.append(
        TOOL_RESULT,
        { turn, step, callId: call.id, message: createToolResultMessage(call.id, [{ type: 'text', text }], true), error: { name: 'Error', code: 'TOOL_FAILED' } },
        options,
      )
      return false
    }
    for (const context of result.additionalContexts ?? []) this.inbox.append(context, 'next-step', false)
    return result.concludesTurn === true
  }

  /**
   * A claim the turn died holding — a cancel or a throw inside the pre-step
   * await, before anything was entered — loses what was queued, as a cancel
   * means to. A job's end notice is not the cancel's to lose (`Inbox.clear`
   * keeps one for the same reason): it goes back, quiet, behind the claim.
   */
  private requeueNotices(claimed: readonly Message[]): void {
    for (const message of claimed) if (isJobNotice(message)) this.inbox.append(message, 'next-step', false)
  }

  /** The durability checkpoint: a provider that remembered losing a write says so here, and the turn stops before its next action. */
  private async checkpoint(): Promise<void> {
    try {
      await this.session.flush()
    } catch (error) {
      throw new DurabilityLost(error instanceof AggregateError && error.errors.length === 1 ? error.errors[0] : error)
    }
  }

  /**
   * `request/context`: the step's route and the window the adapter advertises
   * for it, written only when one of them differs from the last record. It
   * sits outside header equality — the window is not model-visible — so a
   * capacity change never forces a header snapshot, and everything that
   * meters (compaction's trigger, the terminal, `sessions show`) reads the
   * window from the log rather than from a live adapter.
   */
  private recordRoute(config: CallConfig): void {
    let contextWindow: number | undefined
    let inputModalities: readonly ModelModality[] | undefined
    try {
      const resolved = this.deps!.llm.resolveModel(config.provider, config.model)
      contextWindow = resolved.contextWindow
      inputModalities = resolved.inputModalities
    } catch {
      // An unknown provider: the request itself will say so (NO_ADAPTER); the
      // record then carries neither window nor modalities. That matters more for
      // modalities than for the window — the window has a live-adapter fallback
      // and absent modalities MEAN text-only — so the whole-record comparison
      // below is what makes a later successful resolve rewrite the record
      // instead of the first failure latching a route into "text only" forever.
      contextWindow = undefined
      inputModalities = undefined
    }
    const record: RequestContextRecord = {
      provider: config.provider,
      model: config.model,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(inputModalities === undefined ? {} : { inputModalities: [...inputModalities] }),
    }
    // The WHOLE record, not three named fields: a field added to
    // `RequestContextRecord` must be written on the next step of a resumed
    // session whose route never changed, or it would be inherited as absent for
    // the life of that session and the reader would draw the wrong conclusion.
    const last = foldRequestContext(this.session.facts)
    if (last && JSON.stringify(last) === JSON.stringify(record)) return
    this.session.append(REQUEST_CONTEXT, record)
  }

  private buildHeader(config: CallConfig, assembled: AssembledPrompt): RequestHeader {
    return {
      provider: config.provider,
      model: config.model,
      system: assembled.system,
      tools: assembled.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters as JsonValue })),
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    }
  }
}

export { asCallId }
