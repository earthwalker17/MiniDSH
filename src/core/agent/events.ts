/**
 * The agent VOCABULARY: the `agent/*` kernel events, the delegation records
 * and the base-route record with its fold. Split from the service (`index.ts`)
 * exactly as `approval/events.ts` and `sandbox/events.ts` are, so a module
 * below the registry — the sandbox and approval services opening their stamps
 * at `agent/created`, the invariant — can name an agent event without
 * importing the seam that owns the registry, which imports those services'
 * vocabularies back. `check-deps` pins the result: core is acyclic at file level.
 */
import { emitEvent, serialEvent, waterfallEvent } from '../../kernel/index.ts'
import { restoreMessage } from '../llm/message.ts'
import type { Message, TokenUsage } from '../llm/types.ts'
import type { SandboxMode } from '../sandbox/events.ts'
import { eventKind, matches, type EventEnvelope, type TurnEndReason } from '../session/types.ts'
import type {
  Agent,
  AgentNarrowing,
  AgentOptions,
  AgentOptionsReason,
  AgentStatus,
  InboxTarget,
  PreStepContext,
  PreStepDecision,
  RequestContext,
  RequestErrorAction,
  RequestErrorContext,
  TurnStoppingContext,
} from './types.ts'

// ---- kernel events ----------------------------------------------------------

export const AGENT_CREATED = emitEvent<[agent: Agent]>('agent/created')
export const AGENT_DISPOSED = emitEvent<[agent: Agent]>('agent/disposed')
export const AGENT_STATUS = emitEvent<[agent: Agent, status: AgentStatus]>('agent/status')
export const AGENT_ERROR = emitEvent<[agent: Agent, error: unknown]>('agent/error')
export const AGENT_INBOX_INSERTED = emitEvent<[agent: Agent, message: Message, target: InboxTarget]>('agent/inbox/inserted')
export const AGENT_INBOX_CLAIMED = emitEvent<[agent: Agent, message: Message]>('agent/inbox/claimed')
export const AGENT_INBOX_DISCARDED = emitEvent<[agent: Agent, message: Message]>('agent/inbox/discarded')

/**
 * A listener may ADD to a batch, never create one: the driver ends a turn when
 * its first step enters nothing, so filling an empty batch revives a turn that
 * should have closed (ARCHITECTURE §6).
 */
export const AGENT_PRE_STEP = waterfallEvent<[context: PreStepContext], Promise<PreStepDecision>>('agent/pre-step')
export const AGENT_REQUEST = waterfallEvent<[context: RequestContext], Promise<RequestContext['config']>>('agent/request')
export const AGENT_REQUEST_ERROR = waterfallEvent<[context: RequestErrorContext], Promise<RequestErrorAction>>('agent/request-error')
export const AGENT_TURN_STOPPING = serialEvent<[context: TurnStoppingContext]>('agent/turn-stopping')

// ---- the durable inbox -------------------------------------------------------

/**
 * The durable inbox record: op-shaped mutations, not positional splices —
 * `claim` drains counts from the FRONT, which keeps the fold correct even for
 * the one real reorder (an insert landing during the pre-step await is logged
 * before the deferred claim record but appends to the back either way).
 */
export type InboxSplice =
  | { readonly op: 'insert'; readonly queue: InboxTarget; readonly message: Message; readonly waking?: boolean }
  | { readonly op: 'claim'; readonly steps: number; readonly turns: number }
  | { readonly op: 'clear' }

/** Log-only; a resumed session folds these to reconstruct its pending input. */
export const INBOX_SPLICED = eventKind<InboxSplice>('inbox/spliced')

export interface InboxState {
  readonly turnQueue: Message[]
  readonly stepQueue: { message: Message; waking: boolean }[]
}

/** Reconstructs the pending inbox from a session log's `inbox/spliced` records. */
export function foldInbox(events: readonly EventEnvelope[]): InboxState {
  const turnQueue: Message[] = []
  const stepQueue: { message: Message; waking: boolean }[] = []
  for (const event of events) {
    if (!matches(event, INBOX_SPLICED)) continue
    const splice = event.data
    if (splice.op === 'insert') {
      const message = restoreMessage(splice.message as Parameters<typeof restoreMessage>[0])
      if (splice.queue === 'next-turn') turnQueue.push(message)
      else stepQueue.push({ message, waking: splice.waking === true })
    } else if (splice.op === 'claim') {
      stepQueue.splice(0, splice.steps)
      turnQueue.splice(0, splice.turns)
    } else {
      turnQueue.length = 0
      stepQueue.length = 0
    }
  }
  return { turnQueue, stepQueue }
}

// ---- delegation -------------------------------------------------------------

/**
 * The two log-only records a parent writes about a child it started, in the
 * PARENT's session; the child's own steps live in the child's own log, where
 * `sessions show <child>` reads them.
 *
 * They live here rather than in the tool that writes them because delegation is
 * a runtime concept the log records, not one tool's private bookkeeping: the
 * lineage half is already here (`SessionHeader.delegatedBy`/`delegationDepth`,
 * and `agents.fork` refusing a boundary below a child's opening stamps), and a
 * capability may not import another (`scripts/check-deps.ts`).
 */
export const SUBAGENT_START = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly depth: number
  readonly provider: string
  readonly model: string
  readonly sandbox: SandboxMode
  readonly approval: 'never'
}>('subagent/start')

/** How the child's turn ended, and what it cost. */
export const SUBAGENT_END = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly reason: TurnEndReason
  readonly usage?: TokenUsage
}>('subagent/end')

/**
 * One `subagent/end{interrupted}` per `subagent/start` the log never paired.
 *
 * `interrupted` is the honest word here, and it is NOT the word the compaction
 * closer uses. The delegation tool owes its end record on every exit path it
 * has — a depth refusal, a cancelled call, a child that lost durability, a
 * throw — so an unpaired start is not an ordinary shape this runtime can
 * reach. A host death leaves one, and the turn closer beside this one says
 * `interrupted` about the same death. So does a fork of a log another writer
 * still holds, or of a salvaged prefix: there `interrupted` is a placeholder
 * like the turn closer's (`session/repair.ts`), not a claim the child stopped.
 *
 * It carries no `usage`: the child's cost is summed in its own log, and a
 * closer that invented a total would be stating a number nobody measured.
 * NOT scoped to the tail turn — a delegation can outlive the turn that
 * started it, and the surface closers stop at the open one.
 *
 * Pure: the caller supplies the next seq and the shared timestamp, so a cold
 * read and a durable repair produce identical bytes.
 */
export function closeUnpairedSubagents(events: readonly EventEnvelope[], nextSeq: number, time: number): EventEnvelope[] {
  const open = new Map<string, { callId: string; childId: string }>()
  for (const event of events) {
    if (matches(event, SUBAGENT_START)) open.set(event.data.childId, { callId: event.data.callId, childId: event.data.childId })
    else if (matches(event, SUBAGENT_END)) open.delete(event.data.childId)
  }
  let seq = nextSeq
  return [...open.values()].map((child) => ({
    type: SUBAGENT_END.type,
    seq: seq++,
    time,
    data: { callId: child.callId, childId: child.childId, reason: { kind: 'interrupted' as const } },
  }))
}

// ---- the base route ---------------------------------------------------------

/**
 * Log-only, folded by `findLast`: the BASE route and limits an agent runs
 * from. Written at creation (`initial`), by `Agent.configure` (`change`), and
 * by an override at resume (`resume`) — the same discipline as the authority
 * knobs. The effective per-request route lives in `request/header` and
 * `request/context`; this record is what a resume rebuilds from, so a role
 * that rewrote the last request can never become the base.
 */
export const AGENT_OPTIONS = eventKind<{ options: AgentOptions; reason: AgentOptionsReason }>('agent/options')

export function foldAgentOptions(events: readonly EventEnvelope[]): AgentOptions | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, AGENT_OPTIONS)) return event.data.options
  }
  return undefined
}

// ---- the narrowing -----------------------------------------------------------

/**
 * Log-only, an OPENING fact: what this agent's creator narrowed its world to
 * (`AgentNarrowing`). Written once, by the factory, before any authority
 * stamp; re-applied by every lifecycle, so a continued child is exactly as
 * narrow as the child that was delegated (`core/loop/factory.ts`). Held to one
 * per log, in its first lifecycle, by `core-agent` (`./invariant.ts`).
 */
export const AGENT_NARROWING = eventKind<AgentNarrowing>('agent/narrowing')

/** A narrowing a reader cannot believe; a continuation over it is refused, never composed wider. */
export class NarrowingError extends Error {
  readonly code = 'NARROWING_MALFORMED' as const
  constructor(message: string) {
    super(message)
    this.name = 'NarrowingError'
  }
}

const RESTRICTION_TERMS = new Set(['allow', 'deny', 'allowTags', 'denyTags'])

function stringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

/**
 * What is wrong with a stored narrowing, or `undefined`. Strict on purpose —
 * an unknown key is a fault, not something to skip: a term this reader does
 * not know is a narrowing it cannot apply, and composing without it would be
 * composing wider than the record says.
 */
export function narrowingFault(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'agent/narrowing carries no record'
  for (const key of Object.keys(data)) if (key !== 'tools' && key !== 'sections') return `agent/narrowing has an unknown field "${key}"`
  const { tools, sections } = data as { tools?: unknown; sections?: unknown }
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return 'agent/narrowing tools is not a list'
    for (const restriction of tools) {
      if (typeof restriction !== 'object' || restriction === null || Array.isArray(restriction)) return 'agent/narrowing has a tool restriction that is not a record'
      for (const [key, value] of Object.entries(restriction)) {
        if (!RESTRICTION_TERMS.has(key)) return `agent/narrowing has an unknown tool restriction term "${key}"`
        if (!stringList(value)) return `agent/narrowing tool restriction "${key}" is not a list of names`
      }
    }
  }
  if (sections !== undefined) {
    if (!Array.isArray(sections)) return 'agent/narrowing sections is not a list'
    for (const section of sections) {
      const { name, order, text, ...rest } = (section ?? {}) as { name?: unknown; order?: unknown; text?: unknown }
      if (typeof name !== 'string' || name.length === 0) return 'agent/narrowing has a section with no name'
      if (typeof order !== 'number' || !Number.isFinite(order)) return `agent/narrowing section "${name}" has no finite order`
      if (typeof text !== 'string') return `agent/narrowing section "${name}" has no text`
      if (Object.keys(rest).length > 0) return `agent/narrowing section "${name}" has an unknown field`
    }
  }
  return undefined
}

/**
 * A narrowing in a reader's words, one clause per term — what `sessions show`,
 * `inspect` and the browser (`app/web/rows.js`, which cannot import this) say
 * of it. Section TEXT is never quoted: a persona can be long, and the clause
 * that matters is that the agent does not run under the deployment's.
 */
export function describeNarrowing(narrowing: AgentNarrowing): string {
  const parts: string[] = []
  for (const restriction of narrowing.tools ?? []) {
    const only = [...(restriction.allow ?? []), ...(restriction.allowTags ?? []).map((tag) => `${tag} tools`)]
    if (only.length > 0) parts.push(`only ${only.join(', ')}`)
    const no = [...(restriction.deny ?? []), ...(restriction.denyTags ?? []).map((tag) => `${tag} tools`)]
    if (no.length > 0) parts.push(`no ${no.join(', ')}`)
  }
  for (const section of narrowing.sections ?? []) parts.push(`its own ${section.name}`)
  return parts.length === 0 ? 'nothing' : parts.join(' · ')
}

/**
 * The agent's narrowing: the FIRST record, or `undefined` for an agent nobody
 * narrowed. First, not last: a later record could only be a forgery or a bug,
 * and last-wins would let one widen a child even where the invariant that
 * refuses it is not mounted. A malformed first record THROWS, and so does a
 * second one that disagrees with it: either way the continuation is refused
 * rather than composed wider (`core/loop/factory.ts`).
 */
export function foldNarrowing(events: readonly EventEnvelope[]): AgentNarrowing | undefined {
  let first: AgentNarrowing | undefined
  for (const event of events) {
    if (!matches(event, AGENT_NARROWING)) continue
    const fault = narrowingFault(event.data)
    if (fault !== undefined) throw new NarrowingError(`${fault} (seq ${event.seq})`)
    if (first === undefined) first = event.data
    else if (JSON.stringify(first) !== JSON.stringify(event.data)) throw new NarrowingError(`agent/narrowing at seq ${event.seq} is a second, different narrowing`)
  }
  return first
}
