/**
 * `history_read`: bounded recall of the history a compaction shadowed.
 *
 * A summary is one model call that can be wrong, and the log already holds
 * every node it replaced — `compaction/applied.shadowedSeqs` names them and
 * `session.events[seq]` is an O(1) read. What was missing was a way for the
 * model to ask. This is that way, and deliberately nothing more: the admissible
 * set is the union of what applied compactions shadowed IN THIS SESSION, so it
 * is not a log reader, not a session search, and cannot reach another session's
 * events. Reads are never fenced, and there is nothing here to fence: an agent
 * can only see what it was already shown once.
 *
 * **It costs nothing until it can do something.** The tool is registered in the
 * deployment globals — so a summary can name it by tag without knowing which
 * capability provides it — and hidden from every agent by a `TOOLS.restrict` on
 * that agent's own scope, lifted at its first applied compaction. Upstream's
 * comparable `tool-session-query` is opt-in for exactly the cost this avoids:
 * "mounting it adds one concise guidance section and the five schemas to every
 * request". Here a session that never compacts never carries the schema and can
 * never spend a step on a tool with nothing to read.
 *
 * The budgets are the other half. Recalled text re-enters the live surface, so
 * an unbounded recall is a way to undo a compaction one call at a time. A call
 * that would cost more than `maxCallTokens` is refused rather than truncated —
 * so the recorded arguments always describe exactly what came back — and the
 * per-session spend is a FOLD over the log rather than counter state: it
 * survives a resume, replays exactly, and is monotonic, because a recall result
 * that a later compaction shadowed still counts. Recall cannot refill itself by
 * compacting, and a recall result is not itself recallable.
 */
import { z } from 'zod'
import type { Context, Disposer, Plugin } from '../../kernel/index.ts'
import { AGENT_CREATED, AGENTS, type Agent, type Agents } from '../../core/agent/index.ts'
import { COMPACTION_APPLIED } from '../../core/compaction/index.ts'
import { blockText, contentText } from '../../core/llm/content.ts'
import type { Message } from '../../core/llm/types.ts'
import { estimateMessage, estimateTokens } from '../../core/metering/index.ts'
import { deriveEventMessage, matches, SESSION_EVENT, TOOL_CALL, TOOL_RESULT, type Session } from '../../core/session/index.ts'
import { defineTool, RECALL_TOOL, TOOLS, type Tools } from '../../core/tools/index.ts'

const NAME = 'history_read'

const DESCRIPTION = `Read back part of this conversation that a summary replaced.

* Only what a summary replaced is readable — nothing else in the session log is, and no other session is.
* The summary note names the log seqs it replaced. Pass a range inside them.
* Every call spends a budget this session shares, and what you read back re-enters the conversation. Ask for the narrowest range that answers your question, and only when the summary is actually missing a fact you need.`

const InputSchema = z.object({
  fromSeq: z.number().int().nonnegative().describe('First log seq to read back, from the range the summary named.'),
  toSeq: z.number().int().nonnegative().describe('Last log seq to read back, inclusive.'),
})
type Input = z.infer<typeof InputSchema>

const OutputSchema = z.object({
  fromSeq: z.number(),
  toSeq: z.number(),
  /** Exactly the text `render` emits under the header, so measured IS returned. */
  body: z.string(),
  messages: z.array(z.object({ seq: z.number(), role: z.string(), text: z.string() })),
  estimatedTokens: z.number(),
  remainingSessionTokens: z.number(),
})
type Output = z.infer<typeof OutputSchema>

export interface ToolHistoryConfig {
  /** Most estimated tokens one call may return. A wider range is refused, never truncated. */
  readonly maxCallTokens?: number | undefined
  /** Most estimated tokens all recall in one session may return, folded from the log. */
  readonly maxSessionTokens?: number | undefined
}

const configSchema = z
  .strictObject({
    maxCallTokens: z.number().int().positive().optional(),
    maxSessionTokens: z.number().int().positive().optional(),
  })
  .optional()

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * What a recalled message SAYS, unwrapped.
 *
 * `blockText` returns nothing for a tool-result envelope by design — "a tool
 * result's own content is projected by whoever unwraps it" (`core/llm/content.ts`)
 * — and a shadowed span of a working session is mostly tool results. Projecting
 * through `blockText` alone would hand back blanks for exactly the shell output
 * and file reads this tool exists to recover. So this is the unwrapper, and it
 * is exhaustive over the block union for the same reason `blockText` is: the
 * `never` below makes the next variant a compile error here rather than a
 * silence in a recalled transcript.
 */
function recalledText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'image':
        parts.push(blockText(block))
        break
      case 'tool-result':
        parts.push(contentText(block.content))
        break
      case 'tool-call':
        // What the model asked for is part of what the span says; the result
        // alone reads as an answer to a question nobody can see.
        parts.push(`[called ${block.name} ${block.arguments}]`)
        break
      case 'reasoning':
        // Not the answer, and never replayed to a provider that did not sign it.
        break
      default: {
        const exhaustive: never = block
        throw new Error(`recalledText: unhandled content block ${JSON.stringify(exhaustive)}`)
      }
    }
  }
  return parts.filter((part) => part.length > 0).join('\n')
}

interface RecallState {
  /** The seqs this session may read back: shadowed, minus this tool's own results. */
  readonly admissible: ReadonlySet<number>
  /** Estimated tokens already returned by this tool in this session, from the log. */
  readonly spent: number
}

/**
 * One pass over the facts for both halves of the contract. A `tool/call` always
 * precedes its `tool/result`, so the call-id set is complete by the time a
 * result needs it.
 */
export function foldRecall(session: Session, toolName: string = NAME): RecallState {
  const ownCalls = new Set<string>()
  const shadowed = new Set<number>()
  let spent = 0
  for (const event of session.facts) {
    if (matches(event, COMPACTION_APPLIED)) {
      for (const seq of event.data.shadowedSeqs) shadowed.add(seq)
    } else if (matches(event, TOOL_CALL)) {
      if (event.data.name === toolName) ownCalls.add(event.data.callId)
    } else if (matches(event, TOOL_RESULT) && ownCalls.has(event.data.callId)) {
      // Only what was RETURNED is charged. A refusal returned nothing, and the
      // refusal text is itself what tells the model to retry with a narrower
      // range — charging for it made the advice this tool gives drain the
      // budget it is advising about (measured: two refusals, 74 tokens spent,
      // nothing read).
      if (event.data.error) continue
      const message = deriveEventMessage(event)
      if (message) spent += estimateMessage(message)
    }
  }
  // Only what the model CANNOT see. A shadowed seq is normally off the surface
  // by construction, but a fork boundary may fall between `compaction/applied`
  // and the replace that realized it (ARCHITECTURE §13): that child holds the
  // record naming the span while every node of it is still live, and recall
  // would hand back a verbatim second copy and charge for it.
  const live = new Set(session.surfaceSeqs())
  const admissible = new Set<number>()
  for (const seq of shadowed) {
    if (live.has(seq)) continue
    const node = session.events[seq]
    // A recall result is not itself recallable: reading one back would re-inject
    // a copy of a span already paid for, and charge for it twice.
    if (node && matches(node, TOOL_RESULT) && ownCalls.has(node.data.callId)) continue
    admissible.add(seq)
  }
  return { admissible, spent }
}

/**
 * True once this session has something to read back — which is not the same as
 * "has compacted": a fork that kept the applied record but not the replace has
 * the record and nothing shadowed.
 */
export function hasShadowedHistory(session: Session): boolean {
  return foldRecall(session).admissible.size > 0
}

interface Deps {
  readonly maxCallTokens: number
  readonly maxSessionTokens: number
}

function read(args: Input, agent: Agent | undefined, deps: Deps): Output {
  if (!agent) throw coded(`${NAME} requires an owning agent`, 'HISTORY_NO_AGENT')
  const session = agent.session
  const { admissible, spent } = foldRecall(session)
  if (admissible.size === 0) {
    throw coded('nothing in this session has been replaced by a summary, so there is nothing to read back', 'HISTORY_EMPTY')
  }
  const remaining = deps.maxSessionTokens - spent
  if (remaining <= 0) {
    throw coded(
      `this session's recall budget of ${deps.maxSessionTokens} tokens is spent; work from the summary and what is already in view`,
      'HISTORY_BUDGET',
    )
  }

  const from = Math.min(args.fromSeq, args.toSeq)
  const to = Math.max(args.fromSeq, args.toSeq)
  const all = [...admissible].toSorted((a, b) => a - b)
  const picked = all.filter((seq) => seq >= from && seq <= to)
  const entries: Output['messages'] = []
  for (const seq of picked) {
    const node = session.events[seq]
    const message = node ? deriveEventMessage(node) : null
    if (!message) continue
    const text = recalledText(message)
    if (text.length === 0) continue
    entries.push({ seq, role: message.role, text })
  }
  if (entries.length === 0) {
    throw coded(
      `no replaced message lies in [${from}, ${to}]; this session's replaced messages are at log seqs ${all[0]}–${all[all.length - 1]!} (${all.length} of them)`,
      'HISTORY_NOT_SHADOWED',
    )
  }

  // Charged on the BODY this call will actually emit, not on the raw span:
  // measuring the entry texts alone let a call bounded at 1500 return 1814
  // tokens of content, and told the model it had more budget left than it did.
  // Only the header line is outside the count, and it cannot be inside it — it
  // reports the count.
  const body = entries.map((entry) => `#${entry.seq} ${entry.role}\n${entry.text}`).join('\n\n')
  const tokens = estimateTokens(body)
  const cap = Math.min(deps.maxCallTokens, remaining)
  if (tokens > cap) {
    throw coded(
      `reading [${from}, ${to}] back would cost about ${tokens} tokens, over the ${cap} this call may spend; ask for a narrower range`,
      'HISTORY_TOO_LARGE',
    )
  }
  return {
    fromSeq: entries[0]!.seq,
    toSeq: entries[entries.length - 1]!.seq,
    body,
    messages: entries,
    estimatedTokens: tokens,
    // Short of the durable fold's charge by one header line and the message
    // framing — a small constant now, where it used to be a per-message prefix.
    // The next call recomputes from the log rather than from this number.
    remainingSessionTokens: Math.max(0, remaining - tokens),
  }
}

function renderRecall(value: Output): string {
  const head = `[history ${value.fromSeq}–${value.toSeq} · ${value.messages.length} message(s) · ~${value.estimatedTokens} tokens · ~${value.remainingSessionTokens} of this session's recall budget left]`
  // `body` is the string the budget was measured against, carried on the value
  // rather than rebuilt here: measured and emitted can then not drift apart.
  return `${head}\n\n${value.body}`
}

/**
 * Holds each agent's tool back until its first applied compaction.
 *
 * A restriction rather than a late scoped registration, because the summary's
 * footer has to be able to NAME the tool, and it is written before the
 * `compaction/applied` that would trigger such a registration — so the tool has
 * to exist in the globals from boot and be hidden per agent instead.
 */
class RecallGate {
  private readonly hidden = new WeakMap<Agent, Disposer>()
  private readonly tools: Tools
  private readonly agents: Agents

  constructor(tools: Tools, agents: Agents) {
    this.tools = tools
    this.agents = agents
  }

  /** A resumed or forked log that already holds an applied compaction is never hidden from. */
  onCreated(agent: Agent): void {
    if (hasShadowedHistory(agent.session)) return
    this.hidden.set(agent, this.tools.restrict(agent.ctx, { deny: [NAME] }))
  }

  reveal(session: Session): void {
    const agent = this.agents.get(session.id)
    if (!agent) return
    const release = this.hidden.get(agent)
    if (!release) return
    this.hidden.delete(agent)
    // The cleanup's synchronous half — the splice that un-hides the tool and a
    // contained `tools/change` emit — has already run by the time this returns,
    // so the next `prompt.assemble` of this step sees the tool. Nothing here
    // appends to the session: this runs inside a `session/event` delivery, and
    // a nested append would overtake the event that caused it.
    void release().catch(() => undefined)
  }
}

export const toolHistoryPlugin: Plugin<ToolHistoryConfig | undefined> = {
  name: 'tool-history',
  inject: [TOOLS, AGENTS],
  config: configSchema,
  apply(ctx: Context, config) {
    const deps: Deps = {
      maxCallTokens: config?.maxCallTokens ?? 1_500,
      maxSessionTokens: config?.maxSessionTokens ?? 6_000,
    }
    const tools = ctx.get(TOOLS)
    const gate = new RecallGate(tools, ctx.get(AGENTS))

    tools.register(
      ctx,
      defineTool({
        name: NAME,
        description: DESCRIPTION,
        input: InputSchema,
        output: OutputSchema,
        // Not model-facing: the tag is how a summary names this tool without
        // knowing which capability provides it.
        tags: [RECALL_TOOL],
        render: (_args, value) => [{ type: 'text', text: renderRecall(value) }],
        execute: (args: Input, exec) => read(args, exec.agent, deps),
      }),
    )

    ctx.on(AGENT_CREATED, (agent) => gate.onCreated(agent))
    ctx.on(SESSION_EVENT, (session, event) => {
      if (matches(event, COMPACTION_APPLIED)) gate.reveal(session)
    })
  },
}
