/**
 * The authority invariant: the durable authority vocabulary is closed, and
 * every approval is decided exactly once.
 *
 * It runs pre-commit (through the kernel `observe` hook), so a forged or
 * malformed authority fact never enters the log — a value outside the closed
 * mode/policy vocabularies would otherwise fold into a boundary nobody chose.
 */
import type { Plugin } from '../../kernel/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_POLICY, isApprovalOutcome, isApprovalPolicy } from '../approval/index.ts'
import { INVARIANTS, type InvariantFailure, type InvariantInstaller } from '../invariants/index.ts'
import { matches, type EventEnvelope } from '../session/index.ts'
import { SESSION_EVENT } from '../session/store.ts'
import type { Session } from '../session/session.ts'
import { isSandboxMode, isWider, SANDBOX_MODE, type SandboxMode } from './index.ts'
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
  ceiling: SandboxMode | undefined
  pin: ApprovalPolicy | undefined
}

function freshTrace(): Trace {
  return { lastSeq: -1, asked: new Set(), decided: new Set(), sandboxStamps: 0, policyStamps: 0, ceiling: undefined, pin: undefined }
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
  if (matches(event, APPROVAL_ASKED)) {
    const id = event.data.id
    if (typeof id !== 'string' || id.length === 0) fail('approval/asked has no id')
    if (trace.asked.has(id)) fail(`approval/asked reuses the id "${id}"`)
    trace.asked.add(id)
    return
  }
  if (matches(event, APPROVAL_DECIDED)) {
    const id = event.data.id
    if (!isApprovalOutcome(event.data.outcome)) fail(`approval/decided carries an unknown outcome ${JSON.stringify(event.data.outcome)}`)
    if (!trace.asked.has(id)) fail(`approval/decided for "${id}" has no matching approval/asked`)
    if (trace.decided.has(id)) fail(`approval/decided for "${id}" was already decided`)
    trace.decided.add(id)
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
