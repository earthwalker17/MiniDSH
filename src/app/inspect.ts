/**
 * The cold readers: `minidsh sessions verify` and `sessions inspect`.
 *
 * A stored log read by something other than the runtime that wrote it (§4):
 * no lease is taken, nothing is repaired or written, and every judgement is
 * one its OWNER already makes — `checkSessionLog` and `checkAuthorityLog` are
 * the live invariants' own steps, `repairTail` is the resume's own closer
 * list, the folds are the ones the runtime reads. This file only composes
 * them into a verdict and a report; it states no rule of its own beyond the
 * two header-versus-log checks that only a reader holding the header can make.
 *
 * Its one consumer is the CLI; a wire method would move it below the surfaces.
 */
import { foldInbox, repairTail, SUBAGENT_END, SUBAGENT_START } from '../core/agent/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, delegationPin, effectiveApprovalPolicy, liveGrants, undecidedApprovals, type ApprovalGrant, type ApprovalPolicy } from '../core/approval/index.ts'
import type { Attachments } from '../core/attachments/index.ts'
import { collectImageRefs } from '../core/llm/content.ts'
import { messageText, restoreMessage } from '../core/llm/message.ts'
import { formatTokens, meterSession } from '../core/metering/index.ts'
import type { StoredIntegrity, StoredSession } from '../core/persistence/index.ts'
import { delegationAcceptance, delegationCeiling, lastSandboxStamp, recordedAcceptance, type SandboxEnforcement, type SandboxMode } from '../core/sandbox/index.ts'
import { checkAuthorityLog } from '../core/sandbox/invariant.ts'
import {
  checkSessionLog,
  END_SEED,
  matches,
  SESSION_LIFECYCLE,
  TOOL_RESULT,
  TRACE_TYPES,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type EventEnvelope,
  type SalvageRecord,
  type SessionHeader,
} from '../core/session/index.ts'
import { COMPOSITION_APPLIED } from '../capabilities/composition-record/index.ts'
import type { LeaseStatus } from '../capabilities/persistence-jsonl/index.ts'
import { describeEvent, preview } from './present.ts'

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  readonly severity: Severity
  /** Which judgement found it: `integrity`, `session`, `authority`, `repair`, `delegation`, `approvals`, `attachments`, `tail`. */
  readonly check: string
  readonly seq?: number
  readonly message: string
}

/**
 * `ok`, `interrupted` (an open last turn a resume closes) and `torn` (a crash
 * artifact a resume sidecars) are the shapes a healthy runtime leaves and exit
 * 0; `damaged` (bytes past a readable prefix), `invalid` (a rule broken inside
 * it), `unsupported` (a newer format) and `not-found` exit 1.
 */
export type Verdict = 'ok' | 'interrupted' | 'torn' | 'damaged' | 'invalid' | 'unsupported' | 'not-found'

export interface Verification {
  readonly verdict: Verdict
  readonly findings: readonly Finding[]
  /** What a resume would append — or, for a damaged log, what a salvaging fork would: conservative placeholders. */
  readonly closers: readonly EventEnvelope[]
  /** A live (or unprobeable) writer holds the lease: an open turn or unterminated line may just be in progress. */
  readonly inFlux: boolean
}

/** A fold over untrusted payloads, or `fallback` when one cannot be read: the checks report WHERE, this only keeps a report possible. */
function safely<T>(fold: () => T, fallback: T): T {
  try {
    return fold()
  } catch {
    return fallback
  }
}

export function verdictExitCode(verdict: Verdict): number {
  return verdict === 'ok' || verdict === 'interrupted' || verdict === 'torn' ? 0 : 1
}

/** Every judgement over one stored log, pure: the log alone, plus the lease if the store could name one. */
export function verifyStored(stored: StoredSession, lease?: LeaseStatus): Verification {
  const events = stored.events
  const damaged = stored.damaged === true
  const inFlux = lease !== undefined && lease.alive !== false
  const findings: Finding[] = []
  const integrity = stored.integrity

  if (damaged) {
    const stop = integrity?.stop
    const where = stop === undefined ? 'past its readable prefix' : `at line ${stop.line} (byte ${stop.byte}): ${stop.reason}`
    const readable = integrity === undefined ? '' : `; ${integrity.readableBytes} of ${integrity.bytes} bytes are readable`
    findings.push({
      severity: 'error',
      check: 'integrity',
      seq: events.length,
      message: `damaged ${where}${readable} — a resume is refused; \`fork --salvage\` forks the readable prefix`,
    })
  } else if (integrity?.tail === 'torn') {
    const bytes = integrity.bytes - integrity.readableBytes
    findings.push({
      severity: 'info',
      check: 'integrity',
      message: inFlux
        ? `an unterminated final line (${bytes} bytes): a live writer holds this log, so it is likely an append in flight`
        : `a torn final line (${bytes} bytes): a crash artifact a resume moves to its .torn sidecar`,
    })
  }

  // One pass over the log a resume would continue: the stored events, then
  // the closers it would append. Both checks are left folds, so the first
  // violation below the stored length is the log's own fault, at or past it a
  // fault of the closers — which would be a repair bug.
  let closers: EventEnvelope[] = []
  try {
    closers = repairTail(events, { salvage: damaged })
  } catch (error) {
    // Repair folds payloads too, so a malformed one stops it; the structural
    // checks below name the event, and there is nothing a resume could append.
    findings.push({ severity: 'error', check: 'repair', message: `a resume could not close this log: ${error instanceof Error ? error.message : String(error)}` })
  }
  const continued = [...events, ...closers]
  for (const [check, run] of [
    ['session', checkSessionLog],
    ['authority', checkAuthorityLog],
  ] as const) {
    const violation = run(continued)
    if (violation === undefined) continue
    const own = violation.seq < events.length
    findings.push({
      severity: 'error',
      check: own ? check : 'repair',
      seq: violation.seq,
      message: own ? violation.message : `the closers a resume would append break a ${check} rule: ${violation.message}`,
    })
  }

  // What only a reader holding the header can compare — over folds that read
  // payloads, so a malformed one (already reported above) yields no opinion.
  const ceiling = safely(() => delegationCeiling(events), undefined)
  const pin = safely(() => delegationPin(events), undefined)
  if (stored.header.delegatedBy !== undefined && (ceiling === undefined || pin === undefined)) {
    findings.push({
      severity: 'warning',
      check: 'delegation',
      message: `the header says ${stored.header.delegatedBy} delegated this session, but the log records no delegation opening — a fork is refused, and a resume would re-open its authority at a deployment default`,
    })
  } else if (stored.header.delegatedBy === undefined && (ceiling !== undefined || pin !== undefined)) {
    findings.push({ severity: 'warning', check: 'delegation', message: 'the log opens under a delegation ceiling, but its header names no delegating session' })
  }
  const closedOnResume = new Set(closers.flatMap((event) => (matches(event, APPROVAL_DECIDED) ? [event.data.id] : [])))
  for (const id of safely(() => undecidedApprovals(events), [])) {
    if (closedOnResume.has(id)) continue
    findings.push({ severity: 'warning', check: 'approvals', message: `approval ${id} was asked and never decided, outside the open turn — no repair closes it` })
  }

  if (closers.length > 0 && !damaged) {
    findings.push({
      severity: 'info',
      check: 'tail',
      message: inFlux
        ? `the last turn is open, and a live writer holds this log: it may simply be running`
        : `the last turn is open (a crash or a kill): a resume appends ${closers.length} closer(s)`,
    })
  }

  const broken = findings.some((finding) => finding.severity === 'error' && finding.check !== 'integrity')
  const verdict: Verdict = broken ? 'invalid' : damaged ? 'damaged' : integrity?.tail === 'torn' ? 'torn' : closers.length > 0 ? 'interrupted' : 'ok'
  return { verdict, findings, closers, inFlux }
}

/**
 * Every image the surface still carries must be readable, or the next request
 * that projects it fails `ATTACHMENT_UNREADABLE` (§5). Read through the store's
 * own `readImage`, which re-verifies the bytes against the reference.
 */
export async function verifyAttachments(events: readonly EventEnvelope[], attachments: Attachments | undefined): Promise<Finding[]> {
  if (!attachments) return []
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const message = matches(event, TOOL_RESULT) ? event.data.message : matches(event, USER_MESSAGE) ? event.data.message : undefined
    if (!message) continue
    for (const ref of collectImageRefs(message.content).values()) {
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      try {
        await attachments.readImage(ref)
      } catch (error) {
        const code = (error as { code?: unknown }).code
        findings.push({
          severity: 'warning',
          check: 'attachments',
          seq: event.seq,
          message: `image ${ref.id.slice(0, 19)}… is unreadable (${typeof code === 'string' ? code : 'error'}): a request that projects it will fail`,
        })
      }
    }
  }
  return findings
}

// ---- inspect ------------------------------------------------------------------

export interface LifecycleView {
  /** Where the segment starts: 0, or just after a `session/end-seed`. */
  readonly startSeq: number
  /** Absent for a segment written before S16, which carries no record. */
  readonly record?: { readonly origin: string; readonly dispatch?: true; readonly durability?: 'synced'; readonly salvage?: SalvageRecord }
  /** The build named by the last `composition/applied` at or before the segment's end. */
  readonly writer?: string
}

export interface Inspection {
  readonly id: string
  readonly header: SessionHeader
  readonly verdict: Verdict
  readonly findings: readonly Finding[]
  readonly integrity?: StoredIntegrity
  readonly lease?: LeaseStatus
  readonly counts: { readonly events: number; readonly trace: number }
  readonly lifecycles: readonly LifecycleView[]
  readonly turns: {
    readonly total: number
    /** Every turn that did not end `completed`, and where. */
    readonly notCompleted: readonly { readonly turn: number; readonly seq: number; readonly reason: string }[]
    readonly open?: { readonly turn: number; readonly seq: number }
  }
  /** What a resume would append (a salvaging fork, for a damaged log). */
  readonly closers: readonly EventEnvelope[]
  /** Folded from the log alone, as it stands at its end — the enforcement is the one the LAST stamp recorded, never this host's. */
  readonly authority: {
    readonly mode?: SandboxMode
    readonly enforcement?: SandboxEnforcement
    readonly approval?: ApprovalPolicy
    /** The acceptance the log records for `mode`; absent when it records none (a pre-S16 log under a deployment default says nothing). */
    readonly accepts?: SandboxEnforcement
    readonly grants: readonly ApprovalGrant[]
    readonly delegation?: { readonly ceiling?: SandboxMode; readonly pin?: ApprovalPolicy; readonly accepts?: { readonly accepts: SandboxEnforcement; readonly forMode: SandboxMode } }
  }
  readonly undecidedApprovals: readonly { readonly id: string; readonly toolName: string; readonly seq: number; readonly closedOnResume: boolean }[]
  readonly inbox: { readonly nextTurn: readonly string[]; readonly nextStep: readonly string[] }
  readonly children: readonly { readonly childId: string; readonly callId: string; readonly seq: number; readonly ended?: string }[]
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly childInput: number; readonly childOutput: number }
}

export function inspectStored(stored: StoredSession, verification: Verification, lease?: LeaseStatus): Inspection {
  // A payload a check already named as malformed would stop these folds; the
  // report then stops at the last event that reads, and says so in its findings.
  const events = readablePrefix(stored.events, verification)
  const facts = events.filter((event) => !TRACE_TYPES.has(event.type))

  const lifecycles: LifecycleView[] = []
  let writer: string | undefined
  let current: { startSeq: number; record?: LifecycleView['record']; writer?: string } = { startSeq: 0 }
  const close = (): void => {
    lifecycles.push({ startSeq: current.startSeq, ...(current.record === undefined ? {} : { record: current.record }), ...(writer === undefined ? {} : { writer }) })
  }
  let total = 0
  let open: { turn: number; seq: number } | undefined
  const notCompleted: { turn: number; seq: number; reason: string }[] = []
  const children = new Map<string, { childId: string; callId: string; seq: number; ended?: string }>()
  let childInput = 0
  let childOutput = 0
  for (const event of facts) {
    if (matches(event, END_SEED)) {
      close()
      current = { startSeq: event.seq + 1 }
    } else if (matches(event, SESSION_LIFECYCLE)) {
      current.record ??= event.data
    } else if (matches(event, COMPOSITION_APPLIED)) {
      if (event.data.writer !== undefined) writer = event.data.writer
    } else if (matches(event, TURN_START)) {
      total += 1
      open = { turn: event.data.turn, seq: event.seq }
    } else if (matches(event, TURN_END)) {
      open = undefined
      const reason = event.data.reason
      if (reason.kind !== 'completed') notCompleted.push({ turn: event.data.turn, seq: event.seq, reason: reason.kind === 'error' ? `error ${reason.code}` : reason.kind })
    } else if (matches(event, SUBAGENT_START)) {
      children.set(event.data.childId, { childId: event.data.childId, callId: event.data.callId, seq: event.seq })
    } else if (matches(event, SUBAGENT_END)) {
      const child = children.get(event.data.childId)
      if (child) child.ended = event.data.reason.kind
      childInput += (event.data.usage?.inputTokens ?? 0) + (event.data.usage?.cacheReadTokens ?? 0)
      childOutput += event.data.usage?.outputTokens ?? 0
    }
  }
  close()

  const stamp = lastSandboxStamp(facts)
  const accepts = stamp === undefined ? undefined : recordedAcceptance(facts, stamp.mode)
  const ceiling = delegationCeiling(facts)
  const pin = delegationPin(facts)
  const delegatedAccepts = delegationAcceptance(facts)
  const approval = effectiveApprovalPolicy(facts)
  const closedOnResume = new Set(verification.closers.flatMap((event) => (matches(event, APPROVAL_DECIDED) ? [event.data.id] : [])))
  const undecided = new Set(undecidedApprovals(facts))
  const asked = facts.flatMap((event) =>
    matches(event, APPROVAL_ASKED) && undecided.has(event.data.id)
      ? [{ id: event.data.id, toolName: event.data.toolName, seq: event.seq, closedOnResume: closedOnResume.has(event.data.id) }]
      : [],
  )
  const inbox = foldInbox(facts)
  const metrics = meterSession(facts, 0)

  return {
    id: stored.header.id,
    header: stored.header,
    verdict: verification.verdict,
    findings: verification.findings,
    ...(stored.integrity === undefined ? {} : { integrity: stored.integrity }),
    ...(lease === undefined ? {} : { lease }),
    counts: { events: events.length, trace: events.length - facts.length },
    lifecycles,
    turns: { total, notCompleted, ...(open === undefined ? {} : { open }) },
    closers: verification.closers,
    authority: {
      ...(stamp === undefined ? {} : { mode: stamp.mode, enforcement: stamp.enforcement }),
      ...(approval === undefined ? {} : { approval }),
      ...(accepts === undefined ? {} : { accepts }),
      grants: [...liveGrants(facts).values()],
      ...(ceiling === undefined && pin === undefined && delegatedAccepts === undefined
        ? {}
        : {
            delegation: {
              ...(ceiling === undefined ? {} : { ceiling }),
              ...(pin === undefined ? {} : { pin }),
              ...(delegatedAccepts === undefined ? {} : { accepts: delegatedAccepts }),
            },
          }),
    },
    undecidedApprovals: asked,
    inbox: {
      nextTurn: inbox.turnQueue.map((message) => preview(messageText(restoreMessage(message)), 60)),
      nextStep: inbox.stepQueue.map((entry) => preview(messageText(restoreMessage(entry.message)), 60)),
    },
    children: [...children.values()],
    cost: { input: metrics.sessionInput, output: metrics.sessionOutput, cacheRead: metrics.sessionCacheRead, childInput, childOutput },
  }
}

/** The events before the first MALFORMED one a check reported, so the folds below only read payloads that parse as their kinds. */
function readablePrefix(events: readonly EventEnvelope[], verification: Verification): readonly EventEnvelope[] {
  const malformed = verification.findings.find((finding) => finding.message.startsWith('malformed payload') && finding.seq !== undefined)
  return malformed === undefined ? events : events.slice(0, malformed.seq)
}

// ---- lines ------------------------------------------------------------------

function findingLine(finding: Finding): string {
  return `  ${finding.severity.padEnd(7)} ${finding.check.padEnd(11)} ${finding.seq === undefined ? '' : `seq ${finding.seq}: `}${finding.message}`
}

const VERDICT_WORDS: Readonly<Record<Verdict, string>> = {
  ok: 'intact: every rule holds and every bracket is closed',
  interrupted: 'intact, interrupted: its last turn is open, and a resume closes it',
  torn: 'intact, with a torn final line a resume sidecars',
  damaged: 'DAMAGED: readable only up to a point, so a resume is refused',
  invalid: 'INVALID: the log breaks a rule the runtime holds every append to',
  unsupported: 'not readable by this MiniDSH: a newer format',
  'not-found': 'no such session',
}

export function verifyLines(id: string, verification: Verification): string[] {
  const lines = [`session ${id}: ${verification.verdict} — ${VERDICT_WORDS[verification.verdict]}`]
  for (const finding of verification.findings) lines.push(findingLine(finding))
  return lines
}

export function inspectLines(inspection: Inspection): string[] {
  const { header } = inspection
  const lines = [`session ${inspection.id} (cwd ${header.cwd})`, `verdict: ${inspection.verdict} — ${VERDICT_WORDS[inspection.verdict]}`]
  const integrity = inspection.integrity
  const bytes = integrity === undefined ? '' : ` · ${integrity.bytes} bytes${integrity.readableBytes === integrity.bytes ? '' : `, ${integrity.readableBytes} readable`}`
  lines.push(`format ${header.version} · ${inspection.counts.events} events (${inspection.counts.trace} trace)${bytes}`)
  if (inspection.lease !== undefined) {
    const { pid, host, alive } = inspection.lease
    lines.push(`lease: held by pid ${pid} on ${host} (${alive === 'unknown' ? 'another host: cannot probe' : alive ? 'alive' : 'dead: a resume reclaims it'})`)
  }
  const lineage = [
    ...(header.parentId === undefined ? [] : [`forked from ${header.parentId} (${header.seedLength ?? '?'} events)`]),
    ...(header.delegatedBy === undefined ? [] : [`delegated by ${header.delegatedBy} (depth ${header.delegationDepth ?? 1}${header.delegatedByCallId === undefined ? '' : `, call ${header.delegatedByCallId}`})`]),
    ...(header.agentPreset === undefined ? [] : [`agent preset ${header.agentPreset}`]),
  ]
  if (lineage.length > 0) lines.push(`lineage: ${lineage.join(' · ')}`)
  lines.push('lifecycles:')
  for (const lifecycle of inspection.lifecycles) {
    const record = lifecycle.record
    const claims = record === undefined ? 'no record (written before S16)' : [record.origin, ...(record.dispatch ? ['dispatch'] : []), record.durability ?? 'unsynced'].join(' · ')
    const salvage = record?.salvage === undefined ? '' : ` · salvaged: its source stopped at line ${record.salvage.stop.line} (${record.salvage.stop.reason})`
    lines.push(`  ${String(lifecycle.startSeq).padStart(5)}  ${claims}${lifecycle.writer === undefined ? '' : ` · ${lifecycle.writer}`}${salvage}`)
  }
  const { turns } = inspection
  const ended = turns.notCompleted.map((entry) => `${entry.turn} ${entry.reason} at ${entry.seq}`)
  lines.push(`turns: ${turns.total}${ended.length > 0 ? ` (${ended.join('; ')})` : ''}${turns.open === undefined ? '' : ` · open: ${turns.open.turn} since ${turns.open.seq}`}`)
  const { authority } = inspection
  const accepts = authority.accepts === undefined ? 'no acceptance recorded for it' : `accepts ${authority.accepts} for it`
  lines.push(
    `authority at the log's end: ${authority.mode ?? 'no mode recorded'}${authority.enforcement === undefined ? '' : ` (recorded enforcement ${authority.enforcement})`} · approvals ${authority.approval ?? 'not recorded'} · ${accepts}`,
  )
  for (const grant of authority.grants) lines.push(`  grant standing: ${grant.id} ${grant.toolName} \`${preview(grant.subject.command, 80)}\` under ${grant.subject.mode}/${grant.subject.enforcement}`)
  if (authority.delegation !== undefined) {
    const { ceiling, pin, accepts: pinned } = authority.delegation
    lines.push(`  delegation: ceiling ${ceiling ?? 'none'} · approvals pinned ${pin ?? 'none'}${pinned === undefined ? '' : ` · accepts pinned ${pinned.accepts} for ${pinned.forMode}`}`)
  }
  for (const ask of inspection.undecidedApprovals) {
    lines.push(`undecided approval: ${ask.id} ${ask.toolName} at ${ask.seq}${ask.closedOnResume ? ' — closed `cancelled` on resume' : ' — outside the open turn, closed by nothing'}`)
  }
  const { nextTurn, nextStep } = inspection.inbox
  if (nextTurn.length + nextStep.length > 0) {
    lines.push(`queued inbox: ${nextTurn.length} next-turn, ${nextStep.length} next-step${nextTurn[0] === undefined ? '' : ` · first: "${nextTurn[0]}"`}`)
  }
  for (const child of inspection.children) lines.push(`child: ${child.childId} (call ${child.callId}, at ${child.seq}) ${child.ended ?? 'never ended'}`)
  const { cost } = inspection
  const childCost = cost.childInput + cost.childOutput > 0 ? ` · children ${formatTokens(cost.childInput)} in / ${formatTokens(cost.childOutput)} out` : ''
  lines.push(`cost: ${formatTokens(cost.input)} in · ${formatTokens(cost.cacheRead)} cached · ${formatTokens(cost.output)} out${childCost}`)
  if (inspection.closers.length > 0) {
    lines.push(inspection.verdict === 'damaged' ? 'a salvaging fork would close its prefix with:' : 'a resume would append:')
    for (const closer of inspection.closers) {
      const line = describeEvent(closer)
      lines.push(`  ${String(closer.seq).padStart(5)}  ${closer.type}${line === undefined ? '' : ` ${line}`}`)
    }
  }
  if (inspection.findings.length > 0) lines.push('findings:', ...inspection.findings.map(findingLine))
  return lines
}
