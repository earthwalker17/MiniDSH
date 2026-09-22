/**
 * The authority invariant: the durable authority vocabulary is closed, and
 * every approval is decided exactly once.
 *
 * It runs pre-commit (through the kernel `observe` hook), so a forged or
 * malformed authority fact never enters the log — a value outside the closed
 * mode/policy vocabularies would otherwise fold into a boundary nobody chose.
 */
import type { Plugin } from '../../kernel/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_GRANT, APPROVAL_POLICY, isApprovalOutcome, isApprovalPolicy } from '../approval/index.ts'
import { intentKey, type EffectIntent } from '../effects/events.ts'
import { INVARIANTS, type InvariantFailure, type InvariantInstaller } from '../invariants/index.ts'
import { matches, type EventEnvelope } from '../session/index.ts'
import { SESSION_EVENT } from '../session/store.ts'
import type { Session } from '../session/session.ts'
import { isSandboxMode, isWider, SANDBOX_ACCEPTANCE, SANDBOX_MODE, type SandboxMode } from './index.ts'
import type { ApprovalPolicy } from '../approval/index.ts'

const ENFORCEMENTS: ReadonlySet<string> = new Set(['full', 'partial', 'none'])
const SANDBOX_REASONS: ReadonlySet<string> = new Set(['initial', 'change', 'resume', 'delegation'])
const POLICY_REASONS: ReadonlySet<string> = new Set(['initial', 'change', 'delegation'])

/**
 * A `delegation` opening is a ceiling the whole session is held under: no
 * later `sandbox/mode` may be wider than it, and no later `approval/policy`
 * may differ from the pin. Pre-commit, so a forged widening never enters the
 * log — the setters refuse first, and this refuses whatever gets past them.
 */
interface Trace {
  lastSeq: number
  asked: Set<string>
  decided: Set<string>
  sandboxStamps: number
  policyStamps: number
  acceptanceStamps: number
  /** A delegated child's acceptance cannot be renegotiated from inside the session. */
  acceptancePinned: boolean
  /** Every open ask's subject key, so a grant can be held to one that provably happened. */
  openSubjects: Map<string, string>
  grantIds: Set<string>
  ceiling: SandboxMode | undefined
  pin: ApprovalPolicy | undefined
}

function freshTrace(): Trace {
  return {
    lastSeq: -1,
    asked: new Set(),
    decided: new Set(),
    sandboxStamps: 0,
    policyStamps: 0,
    acceptanceStamps: 0,
    acceptancePinned: false,
    openSubjects: new Map(),
    grantIds: new Set(),
    ceiling: undefined,
    pin: undefined,
  }
}

/**
 * What is wrong with a would-be `EffectIntent`, or `undefined` when nothing is.
 *
 * Read as `unknown` because the payload may be forged: an invariant that
 * trusted the type would check nothing. One family today, closed like the
 * effect record it sits beside.
 */
function subjectFault(subject: unknown): string | undefined {
  if (typeof subject !== 'object' || subject === null) return 'not an object'
  const { effect, command, mode, enforcement, truncated } = subject as Record<string, unknown>
  if (effect !== 'shell-command') return `unknown effect ${JSON.stringify(effect)}`
  if (typeof command !== 'string') return 'command is not a string'
  if (!isSandboxMode(mode)) return `unknown mode ${JSON.stringify(mode)}`
  if (typeof enforcement !== 'string' || !ENFORCEMENTS.has(enforcement)) return `unknown enforcement ${JSON.stringify(enforcement)}`
  if (truncated !== undefined && truncated !== true) return 'truncated is neither absent nor true'
  return undefined
}

function validate(trace: Trace, event: EventEnvelope, fail: InvariantFailure): void {
  trace.lastSeq = event.seq

  if (matches(event, SANDBOX_MODE)) {
    const { mode, enforcement, reason } = event.data
    if (!isSandboxMode(mode)) fail(`sandbox/mode carries an unknown mode ${JSON.stringify(mode)}`)
    if (!ENFORCEMENTS.has(enforcement)) fail(`sandbox/mode carries an unknown enforcement ${JSON.stringify(enforcement)}`)
    if (!SANDBOX_REASONS.has(reason)) fail(`sandbox/mode carries an unknown reason ${JSON.stringify(reason)}`)
    if (reason === 'delegation') {
      if (trace.sandboxStamps > 0) fail('a delegation opening must be the first sandbox/mode of its session')
      if (isSandboxMode(mode)) trace.ceiling = mode
    } else if (trace.ceiling !== undefined && isSandboxMode(mode) && isWider(mode, trace.ceiling)) {
      fail(`sandbox/mode "${mode}" widens past the delegation ceiling "${trace.ceiling}"`)
    }
    trace.sandboxStamps += 1
    return
  }
  if (matches(event, APPROVAL_POLICY)) {
    const { policy, reason } = event.data
    if (!isApprovalPolicy(policy)) fail(`approval/policy carries an unknown policy ${JSON.stringify(policy)}`)
    if (!POLICY_REASONS.has(reason)) fail(`approval/policy carries an unknown reason ${JSON.stringify(reason)}`)
    if (reason === 'delegation') {
      if (trace.policyStamps > 0) fail('a delegation opening must be the first approval/policy of its session')
      if (isApprovalPolicy(policy)) trace.pin = policy
    } else if (trace.pin !== undefined && policy !== trace.pin) {
      fail(`approval/policy "${String(policy)}" leaves the delegation pin "${trace.pin}"`)
    }
    trace.policyStamps += 1
    return
  }
  if (matches(event, SANDBOX_ACCEPTANCE)) {
    const { accepts, forMode, reason } = event.data
    if (typeof accepts !== 'string' || !ENFORCEMENTS.has(accepts)) fail(`sandbox/acceptance carries an unknown enforcement ${JSON.stringify(accepts)}`)
    if (!isSandboxMode(forMode)) fail(`sandbox/acceptance carries an unknown mode ${JSON.stringify(forMode)}`)
    if (typeof reason !== 'string' || !SANDBOX_REASONS.has(reason)) fail(`sandbox/acceptance carries an unknown reason ${JSON.stringify(reason)}`)
    if (reason === 'delegation') {
      if (trace.acceptanceStamps > 0) fail('a delegation opening must be the first sandbox/acceptance of its session')
      trace.acceptancePinned = true
    } else if (trace.acceptancePinned) {
      // A pin, not a ceiling: a child that cannot ask anyone anything has no
      // actor with standing to renegotiate what it was started accepting.
      fail('sandbox/acceptance changes what a delegated session was started accepting')
    }
    trace.acceptanceStamps += 1
    return
  }
  if (matches(event, APPROVAL_ASKED)) {
    const id = event.data.id
    if (typeof id !== 'string' || id.length === 0) fail('approval/asked has no id')
    if (trace.asked.has(id)) fail(`approval/asked reuses the id "${id}"`)
    // A subject is what a person consents to and what a grant is keyed on, so a
    // malformed one is worse than none: it would render as authority the runtime
    // never resolved. The closed families and the closed authority vocabularies
    // are checked here for the same reason the mode vocabulary is.
    // Typed by `matches`, read as `unknown` because a forged payload does not
    // honour the type — the same reason `isApprovalOutcome` runs below.
    const subject: unknown = event.data.subject
    if (subject !== undefined) {
      const bad = subjectFault(subject)
      if (bad !== undefined) fail(`approval/asked for "${id}" carries a malformed subject: ${bad}`)
    }
    trace.asked.add(id)
    // Remembered only while OPEN: a grant must name the ask it came from, and
    // an ask already decided is not one anybody is consenting to now.
    if (subject !== undefined && subjectFault(subject) === undefined) {
      const key = intentKey(event.data.toolName, subject as EffectIntent)
      if (key !== undefined) trace.openSubjects.set(id, key)
    }
    return
  }
  if (matches(event, APPROVAL_DECIDED)) {
    const id = event.data.id
    if (!isApprovalOutcome(event.data.outcome)) fail(`approval/decided carries an unknown outcome ${JSON.stringify(event.data.outcome)}`)
    if (!trace.asked.has(id)) fail(`approval/decided for "${id}" has no matching approval/asked`)
    if (trace.decided.has(id)) fail(`approval/decided for "${id}" was already decided`)
    trace.decided.add(id)
    trace.openSubjects.delete(id)
    return
  }
  if (matches(event, APPROVAL_GRANT)) {
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) fail('approval/grant is not an object')
    const op = (data as { op?: unknown }).op
    if (op === 'revoke') {
      const id = (data as { id?: unknown }).id
      if (typeof id !== 'string' || !trace.grantIds.has(id)) fail(`approval/grant revokes "${String(id)}", which this session never granted`)
      return
    }
    if (op !== 'grant') fail(`approval/grant carries an unknown op ${JSON.stringify(op)}`)
    const { id, toolName, subject, fromApproval } = data as { id?: unknown; toolName?: unknown; subject?: unknown; fromApproval?: unknown }
    if (typeof id !== 'string' || id.length === 0) fail('approval/grant has no id')
    if (typeof toolName !== 'string' || toolName.length === 0) fail('approval/grant has no toolName')
    // A grant in a delegated session would extend an authority that session was
    // never given, and its pin means nobody in it can be asked for one.
    if (trace.pin !== undefined) fail('approval/grant in a delegated session, whose authority is not its own to extend')
    const bad = subject === undefined ? 'missing' : subjectFault(subject)
    if (bad !== undefined) fail(`approval/grant carries a malformed subject: ${bad}`)
    const key = subject === undefined ? undefined : intentKey(String(toolName), subject as EffectIntent)
    // A truncated subject has no key, so it could only ever match by prefix.
    if (key === undefined) fail('approval/grant carries a subject that cannot be keyed (it was truncated)')
    // The provenance rule: a grant is a fact about a consent that provably
    // happened, in THIS log, for THIS exact subject, and is still open.
    // Without it, `fromApproval` is convention and any mounted row could mint
    // a standing consent for a subject nobody was ever asked about.
    if (typeof fromApproval !== 'string' || trace.openSubjects.get(fromApproval) !== key) {
      fail(`approval/grant names no open approval/asked with an identical subject ("${String(fromApproval)}")`)
    }
    if (typeof id === 'string') trace.grantIds.add(id)
  }
}

const NAME = 'core-authority'

const installAuthorityInvariant: InvariantInstaller = (ctx, fail) => {
  const traces = new WeakMap<Session, Trace>()
  const staged = new WeakMap<Session, Trace>()
  ctx.observe((info) => {
    if (info.name !== SESSION_EVENT.name) return
    const session = info.args[0] as Session
    const event = info.args[1] as EventEnvelope
    let trace = traces.get(session)
    if (!trace) {
      trace = freshTrace()
      // Fold any prior (seed) facts so a resumed session keeps its pairing.
      for (const prior of session.facts) {
        if (prior.seq >= event.seq) break
        validate(trace, prior, fail)
      }
      traces.set(session, trace)
    }
    // Observation is pre-commit and any observer may still reject this event, so
    // the advanced trace is only staged here and committed once the event lands.
    const next: Trace = { ...trace, asked: new Set(trace.asked), decided: new Set(trace.decided) }
    validate(next, event, fail)
    staged.set(session, next)
  })
  ctx.on(SESSION_EVENT, (session, event) => {
    const next = staged.get(session)
    staged.delete(session)
    if (next && next.lastSeq === event.seq) traces.set(session, next)
  })
}

/** Registers the authority invariant. Mount only where invariants run. */
export const authorityInvariantPlugin: Plugin = {
  name: 'core-authority-invariant',
  inject: [INVARIANTS],
  apply(ctx) {
    ctx.get(INVARIANTS).register(ctx, NAME, installAuthorityInvariant)
  },
}
