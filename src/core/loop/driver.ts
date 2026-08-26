import type { Context } from '../../kernel/index.ts'
import {
  AGENT_ERROR,
  AGENT_INBOX_CLAIMED,
  AGENT_INBOX_DISCARDED,
  AGENT_INBOX_INSERTED,
  AGENT_PRE_STEP,
  AGENT_REQUEST,
  AGENT_REQUEST_ERROR,
  AGENT_STATUS,
  AGENT_TURN_STOPPING,
  foldInbox,
  Inbox,
  INBOX_SPLICED,
  type Agent,
  type AgentOptions,
  type AgentStatus,
  type CallConfig,
  type CancelCause,
  type InboxTarget,
  type PreStepDecision,
} from '../agent/index.ts'
import { asCallId, type SessionId } from '../ids.ts'
import type { JsonValue } from '../json.ts'
import { BlockAssembler, LLM, type ContentBlock, type Llm, type LlmRequest, type Message } from '../llm/index.ts'
import { createAssistantMessage, createToolResultMessage } from '../llm/message.ts'
import { PROMPT, type AssembledPrompt, type Prompt } from '../prompt/index.ts'
import {
  ASSISTANT_CHUNK,
  ASSISTANT_MESSAGE,
  REQUEST_HEADER,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type RequestHeader,
  type Session,
  type TurnEndReason,
} from '../session/index.ts'
import { TOOLS, toolCall, type Tools } from '../tools/index.ts'
import { markLoopRequest } from './marker.ts'

export interface LoopDeps {
  readonly llm: Llm
  readonly tools: Tools
  readonly prompt: Prompt
}

const DEFAULT_MAX_STEPS = 24

type StepResult =
  | { kind: 'stop' }
  | { kind: 'continue' }
  | { kind: 'concluded' }
  | { kind: 'max-tokens' }
  | { kind: 'error'; reason: TurnEndReason }

/** The one concrete agent driver: the turn/step state machine over the session log. */
export class ReactLoopAgent implements Agent {
  readonly id: SessionId
  readonly session: Session
  readonly options: AgentOptions
  readonly inbox: Inbox
  private _ctx: Context | undefined
  private _status: AgentStatus = 'idle'
  private deps: LoopDeps | undefined
  private readonly maxSteps: number
  private turnCount = 0
  private firstLiveTurn = 1
  private abort = new AbortController()
  private running = false
  private disposed = false
  private idleWaiters: (() => void)[] = []

  constructor(session: Session, options: AgentOptions) {
    this.id = session.id
    this.session = session
    this.options = options
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
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
    for (const event of this.session.events) {
      if (event.type === TURN_START.type) {
        const turn = (event.data as { turn: number }).turn
        if (turn > this.turnCount) this.turnCount = turn
      }
    }
    this.firstLiveTurn = this.turnCount + 1
    // A resumed (or forked) log may carry pending input; restore it silently —
    // the records already in the log are its durable trace.
    this.inbox.restore(foldInbox(this.session.events))
  }

  /** Post-publication: run restored waking work without new input (the factory calls this). */
  wakeIfPending(): void {
    if (!this.disposed && !this.running && this.inbox.hasWakingPending) void this.run()
  }

  get ctx(): Context {
    if (!this._ctx) throw new Error('agent context not attached')
    return this._ctx
  }

  get status(): AgentStatus {
    return this._status
  }

  private onInbox(event: 'inserted' | 'discarded' | 'claimed', message: Message, target?: InboxTarget): void {
    if (event === 'inserted') this.ctx.emit(AGENT_INBOX_INSERTED, this, message, target ?? 'next-step')
    else if (event === 'claimed') this.ctx.emit(AGENT_INBOX_CLAIMED, this, message)
    else this.ctx.emit(AGENT_INBOX_DISCARDED, this, message)
  }

  send(message: Message, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) return
    this.inbox.append(message, target, wakeup)
    if (wakeup && !this.running) void this.run()
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

  cancel(cause: CancelCause): void {
    if (cause.kind === 'disposed') this.disposed = true
    // Graceful teardown must not durably erase the queue the log preserves for
    // the next resume; a user/hook cancel means it.
    this.inbox.clear(cause.kind !== 'disposed')
    if (this.running) this.abort.abort(cause)
  }

  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private setStatus(next: AgentStatus): void {
    if (this._status === next) return
    this._status = next
    this.ctx.emit(AGENT_STATUS, this, next)
    if (next === 'idle') {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
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
    let naturalStop = false
    try {
      let step = 0
      let firstStep = true
      while (true) {
        if (signal.aborted) throw new Error('turn aborted')
        step += 1
        const { messages: claimed, splice: claimSplice } = this.inbox.claim(firstStep)
        // Whatever consumed (or killed) the claim commits it, so durable = live
        // on every exit path — including a pre-step listener throw or a cancel
        // landing inside the pre-step await.
        const commitClaim = (): void => {
          if (claimSplice) this.session.append(INBOX_SPLICED, claimSplice)
        }
        let decision: PreStepDecision
        try {
          decision = await this.ctx.waterfall(
            AGENT_PRE_STEP,
            { agent: this, messages: claimed, turn, step, signal },
            async () => ({ kind: 'enter', messages: claimed }) as PreStepDecision,
          )
        } catch (error) {
          commitClaim()
          throw error
        }
        if (signal.aborted) {
          commitClaim()
          throw new Error('turn aborted')
        }
        if (decision.kind === 'reject') {
          commitClaim()
          reason = { kind: 'blocked' }
          break
        }
        const entered = decision.messages
        if (firstStep && entered.length === 0) {
          commitClaim()
          naturalStop = true
          break
        }
        this.session.append(STEP_START, { turn, step })
        let result: StepResult
        try {
          // Inside the try: a message append failure must still close the step.
          for (const message of entered) this.session.append(USER_MESSAGE, { message }, { surfaceOp: { op: 'append' } })
          // The claim record lands AFTER the entered messages: a crash inside the
          // pre-step await re-delivers a prompt on resume rather than losing it
          // (the accepted failure mode is a rare double-delivery, never a loss).
          commitClaim()
          result = await this.step(turn, step, signal)
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
        if (result.kind === 'concluded') {
          naturalStop = true
          break
        }
        const owesRequest = result.kind === 'continue'
        if (!owesRequest && !this.inbox.hasStepPending) {
          await this.ctx.serial(AGENT_TURN_STOPPING, { agent: this, turn, signal })
          if (!this.inbox.hasStepPending) {
            naturalStop = true
            break
          }
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
        reason = { kind: 'error', code: 'LOOP_FAILED', message: error instanceof Error ? error.message : String(error) }
        this.ctx.emit(AGENT_ERROR, this, error)
      }
    } finally {
      void naturalStop
      this.session.append(TURN_END, { turn, reason })
      await this.session.flush()
    }
  }

  private async step(turn: number, step: number, signal: AbortSignal): Promise<StepResult> {
    const deps = this.deps!
    const assembled = await deps.prompt.assemble(this)
    const baseConfig: CallConfig = {
      provider: this.options.provider,
      model: this.options.model,
      ...(this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }),
      ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
    }
    const config = await this.ctx.waterfall(AGENT_REQUEST, { agent: this, turn, step, config: baseConfig, signal }, async () => baseConfig)

    const header = this.buildHeader(config, assembled)
    const folded = this.session.foldRequestHeader()
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

      const message = createAssistantMessage(blocks, config.provider, config.model)
      const usage = assembler.usage
      this.session.append(
        ASSISTANT_MESSAGE,
        { turn, step, message, ...(usage === undefined ? {} : { usage }) },
        { surfaceOp: { op: 'append' } },
      )

      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }
      const toolCalls = blocks.filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'stop' }
      const concluded = await this.executeTools(turn, step, toolCalls, signal)
      return concluded ? { kind: 'concluded' } : { kind: 'continue' }
    }
  }

  private async executeTools(
    turn: number,
    step: number,
    toolCalls: readonly Extract<ContentBlock, { type: 'tool-call' }>[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const deps = this.deps!
    let concluded = false
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!
      const callEvent = this.session.append(TOOL_CALL, { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
      if (signal.aborted) {
        const aborted = createToolResultMessage(call.id, [{ type: 'text', text: 'Error: tool call aborted before dispatch' }], true)
        this.session.append(
          TOOL_RESULT,
          { turn, step, callId: call.id, message: aborted, error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
          { surfaceOp: { op: 'append' }, sourceEventSeqs: [callEvent.seq] },
        )
        continue
      }
      const result = await deps.tools.execute(toolCall(call.id, call.name, call.arguments, this, signal))
      const message = createToolResultMessage(call.id, [...result.content], result.isError)
      this.session.append(
        TOOL_RESULT,
        {
          turn,
          step,
          callId: call.id,
          message,
          ...(result.error?.info ? { error: { name: result.error.info.name, code: result.error.info.code } } : {}),
        },
        { surfaceOp: { op: 'append' }, sourceEventSeqs: [callEvent.seq] },
      )
      for (const context of result.additionalContexts ?? []) this.inbox.append(context, 'next-step', false)
      if (result.concludesTurn) concluded = true
    }
    return concluded
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
