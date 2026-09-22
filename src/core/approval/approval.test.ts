import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { AGENTS } from '../agent/index.ts'
import { intentKey, type EffectIntent } from '../effects/index.ts'
import { SANDBOX } from '../sandbox/index.ts'
import { TOOL_CALL, type EventEnvelope } from '../session/index.ts'
import { matches } from '../session/index.ts'
import { APPROVAL, APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_GRANT, APPROVAL_REQUEST, openApprovals, type ApprovalOutcome } from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('approval seam', () => {
  it('answerers receive the durable prompt id, which is the asked event seq and pairs with the decision', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let seen: string | undefined
    harness.root.on(APPROVAL_REQUEST, async (prompt): Promise<ApprovalOutcome> => {
      seen = prompt.id
      return 'allowed-once'
    })
    const outcome = await harness.root.get(APPROVAL).request({ agent, toolName: 'upper' })
    expect(outcome).toBe('allowed-once')
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    const decided = agent.session.events.find((event) => matches(event, APPROVAL_DECIDED))!
    expect(seen).toBe(`approval-${asked.seq}`)
    expect((asked.data as { id: string }).id).toBe(seen)
    expect((decided.data as { id: string; outcome: string }).id).toBe(seen)
  })

  /**
   * The shell's `reason` is the MODEL's own `justification`, and it is rendered
   * into the `[y/N]` line a person answers. A terminal executes what it is
   * written, so a `\r` + erase-line in that text repaints the prompt with a
   * milder question above the same keystroke: the grant would be real and its
   * description a forgery. Neutralized before the log, so no surface — and no
   * later requester — can reintroduce it.
   */
  it('neutralizes a reason a terminal would obey, and bounds one no line could hold', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let seen: string | undefined
    harness.root.on(APPROVAL_REQUEST, async (prompt): Promise<ApprovalOutcome> => {
      seen = prompt.reason
      return 'allowed-once'
    })
    // A carriage return and an erase-line, spelled by code point so no editor
    // or diff can quietly normalize the thing under test.
    const CR = String.fromCharCode(13)
    const ESC = String.fromCharCode(27)
    const forged = `read one file${CR}${ESC}[2Kapprove str_replace_editor (view README.md`
    await harness.root.get(APPROVAL).request({ agent, toolName: 'bash', reason: forged })
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    const reason = (asked.data as { reason?: string }).reason!
    // No control character survives, in the log or in what the answerer saw.
    expect([...reason].some((ch) => ch.codePointAt(0)! < 0x20 || (ch.codePointAt(0)! >= 0x7f && ch.codePointAt(0)! <= 0x9f))).toBe(false)
    expect(reason).toBe('read one file [2Kapprove str_replace_editor (view README.md')
    expect(seen).toBe(reason)

    const { agent: second } = await harness.create()
    await harness.root.get(APPROVAL).request({ agent: second, toolName: 'bash', reason: 'x'.repeat(5_000) })
    const long = (second.session.events.find((event) => matches(event, APPROVAL_ASKED))!.data as { reason: string }).reason
    expect(long).toHaveLength(300)
    expect(long.endsWith('…')).toBe(true)
  })

  it('clamps a SUBJECT the same way it clamps a reason, and shows the answerer what the log holds', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let seen: EffectIntent | undefined
    harness.root.on(APPROVAL_REQUEST, async (prompt): Promise<ApprovalOutcome> => {
      seen = prompt.subject
      return 'allowed-once'
    })
    const ESC = String.fromCharCode(27)
    await harness.root.get(APPROVAL).request({
      agent,
      toolName: 'bash',
      // The forgery moved from the reason into the field that replaces it.
      subject: { effect: 'shell-command', command: `ls${ESC}[2Kapprove`, mode: 'workspace-write', enforcement: 'none' },
    })
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    const subject = (asked.data as { subject?: EffectIntent }).subject!
    expect(subject.command).toBe('ls [2Kapprove')
    // The answerer is shown exactly the bytes a reader of the audit would see.
    expect(seen).toEqual(subject)
  })

  it('records that an over-long subject was cut, so it can never key a grant', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'allowed-once')
    await harness.root.get(APPROVAL).request({
      agent,
      toolName: 'bash',
      subject: { effect: 'shell-command', command: 'x'.repeat(5_000), mode: 'workspace-write', enforcement: 'none' },
    })
    const subject = (agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!.data as { subject: EffectIntent }).subject
    expect(subject.command).toHaveLength(4_000)
    expect(subject.truncated).toBe(true)
    expect(intentKey('bash', subject)).toBeUndefined()
  })

  it('omits the subject entirely when a requester has nothing trustworthy to say', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'allowed-once')
    await harness.root.get(APPROVAL).request({ agent, toolName: 'upper' })
    const asked = agent.session.events.find((event) => matches(event, APPROVAL_ASKED))!
    expect('subject' in (asked.data as object)).toBe(false)
  })

  it('records WHO decided, and nobody when nobody did', async () => {
    harness = await coreHarness()
    const approval = harness.root.get(APPROVAL)
    const decided = (agent: { session: { events: readonly { type: string; data: unknown }[] } }): { outcome: string; decidedBy?: string } =>
      agent.session.events.filter((event) => event.type === APPROVAL_DECIDED.type).at(-1)!.data as { outcome: string; decidedBy?: string }

    // An answerer that claims a person.
    const person = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async (prompt) => (prompt.toolName === 'claimed' ? { outcome: 'allowed-once' as const, by: 'user' as const } : 'rejected'))
    await approval.request({ agent: person.agent, toolName: 'claimed' })
    expect(decided(person.agent)).toEqual({ id: expect.any(String), outcome: 'allowed-once', decidedBy: 'user' })

    // One that returns a bare outcome did not claim one, so it is not credited.
    const bare = await harness.create()
    await approval.request({ agent: bare.agent, toolName: 'bare' })
    expect(decided(bare.agent)).toEqual({ id: expect.any(String), outcome: 'rejected', decidedBy: 'auto' })
  })

  it('never credits a decider for an outcome the seam itself rewrote', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const controller = new AbortController()
    // An answerer that claims a person, racing a cancellation that wins.
    harness.root.on(APPROVAL_REQUEST, async () => {
      controller.abort()
      return { outcome: 'allowed-once' as const, by: 'user' as const }
    })
    const outcome = await harness.root.get(APPROVAL).request({ agent, toolName: 'bash', signal: controller.signal })
    expect(outcome).toBe('cancelled')
    const decided = agent.session.events.find((event) => matches(event, APPROVAL_DECIDED))!.data
    // Not `{outcome: 'cancelled', decidedBy: 'user'}`: a person recorded as
    // having cancelled a request the signal killed is a false audit line.
    expect(decided).toEqual({ id: expect.any(String), outcome: 'cancelled' })
  })

  it('credits nobody when nobody answered at all', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    const outcome = await harness.root.get(APPROVAL).request({ agent, toolName: 'bash' })
    expect(outcome).toBe('unavailable')
    expect(agent.session.events.find((event) => matches(event, APPROVAL_DECIDED))!.data).toEqual({ id: expect.any(String), outcome: 'unavailable' })
  })

  it('an answerer that never resolves is settled by the request signal as cancelled', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, () => new Promise<ApprovalOutcome>(() => {}))
    const controller = new AbortController()
    const pending = harness.root.get(APPROVAL).request({ agent, toolName: 'upper', signal: controller.signal })
    controller.abort()
    expect(await pending).toBe('cancelled')
    const decided = agent.session.events.find((event) => matches(event, APPROVAL_DECIDED))!
    expect((decided.data as { outcome: string }).outcome).toBe('cancelled')
  })

  it('an already-cancelled request is decided cancelled without consulting any answerer', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let consulted = false
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => {
      consulted = true
      return 'allowed-once'
    })
    const controller = new AbortController()
    controller.abort()
    expect(await harness.root.get(APPROVAL).request({ agent, toolName: 'upper', signal: controller.signal })).toBe('cancelled')
    expect(consulted).toBe(false)
    const pair = agent.session.events.filter((event) => matches(event, APPROVAL_ASKED) || matches(event, APPROVAL_DECIDED))
    expect(pair.map((event) => event.type)).toEqual(['approval/asked', 'approval/decided'])
    expect((pair[1]!.data as { outcome: string }).outcome).toBe('cancelled')
  })

  it('ids stay unique across a same-id resume in a fresh process (no per-process counter)', async () => {
    const asked = (agent: { session: { events: readonly { type: string; seq: number; data: unknown }[] } }) =>
      agent.session.events.filter((event) => event.type === APPROVAL_ASKED.type).map((event) => ({ seq: event.seq, id: (event.data as { id: string }).id }))

    const first = await coreHarness()
    first.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'rejected')
    const original = await first.create()
    await first.root.get(APPROVAL).request({ agent: original.agent, toolName: 'a' })
    await first.root.get(APPROVAL).request({ agent: original.agent, toolName: 'b' })
    const id = original.agent.id
    const seed = original.agent.session.forkSeed()
    const before = asked(original.agent)
    await first.dispose()

    harness = await coreHarness()
    harness.root.on(APPROVAL_REQUEST, async (): Promise<ApprovalOutcome> => 'rejected')
    const resumed = await harness.root.get(AGENTS).create(harness.root, {
      cwd: process.cwd(),
      sessionId: id,
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
      seed,
    })
    await harness.root.get(APPROVAL).request({ agent: resumed.agent, toolName: 'c' })
    const all = asked(resumed.agent)
    expect(all.slice(0, 2)).toEqual(before)
    expect(new Set(all.map((entry) => entry.id)).size).toBe(3)
    for (const entry of all) expect(entry.id).toBe(`approval-${entry.seq}`)
    await resumed.dispose()
  })
})

describe('standing grants', () => {
  const subject = { effect: 'shell-command' as const, command: 'pnpm check', mode: 'danger-full-access' as const, enforcement: 'none' as const }

  it('offers a scope only where one can be honoured, and mints it from the answer', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async () => ({ outcome: 'allowed-once' as const, by: 'user' as const, grant: true as const }))
    const approval = harness.root.get(APPROVAL)

    expect(await approval.request({ agent, toolName: 'bash', subject })).toBe('allowed-once')
    const grants = approval.grants(agent.session)
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ toolName: 'bash', subject })
    // The grant is written BEFORE the decision it came from, and the decision
    // names it: the log reads in the order the consent was given.
    const kinds = agent.session.facts.map((event) => event.type)
    expect(kinds.indexOf('approval/grant')).toBeLessThan(kinds.lastIndexOf('approval/decided'))
    const decided = agent.session.events.findLast((event) => matches(event, APPROVAL_DECIDED))!.data
    expect(decided).toMatchObject({ outcome: 'allowed-once', decidedBy: 'user', grantId: grants[0]!.id })
  })

  it('answers a repeat with the grant, consulting nobody — and still writes the whole audit pair', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let asked = 0
    harness.root.on(APPROVAL_REQUEST, async () => {
      asked += 1
      return asked === 1 ? { outcome: 'allowed-once' as const, by: 'user' as const, grant: true as const } : { outcome: 'allowed-once' as const }
    })
    const approval = harness.root.get(APPROVAL)
    await approval.request({ agent, toolName: 'bash', subject })
    await approval.request({ agent, toolName: 'bash', subject })
    expect(asked).toBe(1)

    // A granted call is never thinner on the record than an asked one.
    const pairs = agent.session.events.filter((event) => matches(event, APPROVAL_ASKED) || matches(event, APPROVAL_DECIDED))
    expect(pairs).toHaveLength(4)
    const second = agent.session.events.findLast((event) => matches(event, APPROVAL_DECIDED))!.data
    expect(second).toMatchObject({ outcome: 'allowed-once', decidedBy: 'grant', grantId: approval.grants(agent.session)[0]!.id })
  })

  it('does not cover a command that differs at all, which is the whole safety of an exact key', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    let asked = 0
    harness.root.on(APPROVAL_REQUEST, async () => {
      asked += 1
      return { outcome: 'allowed-once' as const, by: 'user' as const, grant: true as const }
    })
    const approval = harness.root.get(APPROVAL)
    await approval.request({ agent, toolName: 'bash', subject })
    // A different command, the same command under a different mode, and the
    // same command through a different tool are three different questions.
    await approval.request({ agent, toolName: 'bash', subject: { ...subject, command: 'pnpm check --fix' } })
    await approval.request({ agent, toolName: 'bash', subject: { ...subject, mode: 'workspace-write' } })
    await approval.request({ agent, toolName: 'pwsh', subject })
    expect(asked).toBe(4)
  })

  it('ends every grant when the authority it was given under moves', async () => {
    // Consent is to the world as it stood. Without this, a grant taken under an
    // escalation to danger-full-access still matches after somebody narrows the
    // session to read-only, and the narrowing changes nothing for exactly the
    // command they were worried about.
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async () => ({ outcome: 'allowed-once' as const, by: 'user' as const, grant: true as const }))
    const approval = harness.root.get(APPROVAL)
    await approval.request({ agent, toolName: 'bash', subject })
    expect(approval.grants(agent.session)).toHaveLength(1)

    harness.root.get(SANDBOX).setMode(agent.session, 'read-only')
    expect(approval.grants(agent.session)).toHaveLength(0)
  })

  it('is revocable, and says so when there is nothing to revoke', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async () => ({ outcome: 'allowed-once' as const, by: 'user' as const, grant: true as const }))
    const approval = harness.root.get(APPROVAL)
    await approval.request({ agent, toolName: 'bash', subject })
    const id = approval.grants(agent.session)[0]!.id

    expect(approval.revoke(agent.session, id)).toBe(true)
    expect(approval.grants(agent.session)).toHaveLength(0)
    expect(approval.revoke(agent.session, id)).toBe(false)
    expect(approval.revoke(agent.session, 'grant-nope')).toBe(false)
  })

  it('never lets a pinned "never" be answered by a grant, however the grant got there', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    harness.root.on(APPROVAL_REQUEST, async () => ({ outcome: 'allowed-once' as const, by: 'user' as const, grant: true as const }))
    const approval = harness.root.get(APPROVAL)
    await approval.request({ agent, toolName: 'bash', subject })
    expect(approval.grants(agent.session)).toHaveLength(1)

    // The policy switch itself ends the grant, AND the policy is checked first
    // — two independent reasons, because this is the one that must not fail.
    approval.setPolicy(agent.session, 'never')
    const decided = await approval.request({ agent, toolName: 'bash', subject })
    expect(decided).toBe('rejected')
    expect(agent.session.events.findLast((event) => matches(event, APPROVAL_DECIDED))!.data).toMatchObject({ decidedBy: 'policy' })
  })

  it('refuses to mint one for a subject nobody was offered a scope for', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    // A truncated subject can never be keyed, so it can never be granted — two
    // 4000-character commands sharing a prefix must not become one consent.
    harness.root.on(APPROVAL_REQUEST, async () => ({ outcome: 'allowed-once' as const, by: 'user' as const, grant: true as const }))
    const approval = harness.root.get(APPROVAL)
    await approval.request({ agent, toolName: 'bash', subject: { ...subject, command: 'x'.repeat(5_000) } })
    expect(approval.grants(agent.session)).toHaveLength(0)

    // And an answerer that claims a grant for an ask with no subject at all
    // gets nothing: there is no identity to hold one to.
    await approval.request({ agent, toolName: 'bash' })
    expect(approval.grants(agent.session)).toHaveLength(0)
  })

  it('refuses a forged grant that names no open matching ask', async () => {
    harness = await coreHarness()
    const { agent } = await harness.create()
    // The provenance rule, pre-commit: a grant is a fact about a consent that
    // provably happened, in THIS log, for THIS subject, still open. Without it
    // `fromApproval` is convention and any mounted row could write a standing
    // consent for a subject nobody was ever asked about.
    expect(() => agent.session.append(APPROVAL_GRANT, { op: 'grant', id: 'grant-x', toolName: 'bash', subject, fromApproval: 'approval-999' })).toThrowError(
      /names no open/,
    )
    expect(() => agent.session.append(APPROVAL_GRANT, { op: 'revoke', id: 'grant-x' })).toThrowError(/never granted/)
  })
})

describe('the open-approval fold', () => {
  const envelope = (seq: number, type: string, data: unknown): EventEnvelope => ({ type, seq, time: 1, data }) as EventEnvelope
  const asked = (seq: number, over: Record<string, unknown> = {}): EventEnvelope =>
    envelope(seq, APPROVAL_ASKED.type, { id: `approval-${seq}`, toolName: 'bash', ...over })

  it('joins the call an approval covers, so an answerer sees what was asked for', () => {
    // A client holding a PAGE cannot do this join: the covered call can sit
    // outside the page, or below it. The host folds it and sends the answer.
    const open = openApprovals([
      envelope(0, TOOL_CALL.type, { turn: 1, step: 1, callId: 'call-7', name: 'bash', arguments: '{"command":"rm -rf /tmp/x"}' }),
      asked(1, { callId: 'call-7' }),
    ])
    expect(open).toHaveLength(1)
    expect(open[0]!.callId).toBe('call-7')
    expect(open[0]!.call).toEqual({ name: 'bash', arguments: '{"command":"rm -rf /tmp/x"}' })
  })

  it('bounds a joined call by SAYING what it left out, and strips what a terminal would obey', () => {
    const ESC = String.fromCharCode(27)
    const args = `${ESC}[2K${'y'.repeat(20_000)}`
    const call = openApprovals([
      envelope(0, TOOL_CALL.type, { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: args }),
      asked(1, { callId: 'c' }),
    ])[0]!.call!
    expect(call.arguments).toHaveLength(16_384)
    expect(call.omittedChars).toBe(args.length - 16_384)
    // Neutralized, not dropped: the escape is a space, so the length a bound
    // measured is the length that was written.
    expect(call.arguments.startsWith(' [2K')).toBe(true)
  })

  it('leaves an approval with no call alone, and costs nothing when none is open', () => {
    expect(openApprovals([asked(0)])[0]!.call).toBeUndefined()
    // A decided pair leaves nothing open, so the second pass never runs.
    expect(
      openApprovals([asked(0, { callId: 'c' }), envelope(1, APPROVAL_DECIDED.type, { id: 'approval-0', outcome: 'rejected' })]),
    ).toEqual([])
  })

  it('carries the subject and the callId a surface renders from', () => {
    const subject = { effect: 'shell-command' as const, command: 'ls', mode: 'workspace-write' as const, enforcement: 'none' as const }
    expect(openApprovals([asked(0, { callId: 'c', reason: 'because', subject })])[0]).toEqual({
      id: 'approval-0',
      toolName: 'bash',
      reason: 'because',
      subject,
      callId: 'c',
    })
  })
})
