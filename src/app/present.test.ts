/**
 * The shared projection reads payloads through typed kinds, so these tests
 * build events through the real kinds and assert the lines — a renamed field
 * fails here at typecheck, which is the whole point.
 */
import { describe, expect, it } from 'vitest'
import { createRoot, type Logger } from '../kernel/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_POLICY } from '../core/approval/index.ts'
import { COMPACTION_APPLIED } from '../core/compaction/index.ts'
import { invariantsPlugin } from '../core/invariants/index.ts'
import { createToolResultMessage, createUserMessage } from '../core/llm/message.ts'
import { asCallId } from '../core/ids.ts'
import { SANDBOX_MODE } from '../core/sandbox/index.ts'
import { SESSIONS, sessionPlugin, STEP_END, STEP_START, TOOL_CALL, TOOL_RESULT, TURN_END, TURN_START, USER_MESSAGE } from '../core/session/index.ts'
import { auditLines, describeEvent, transcriptLines } from './present.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

describe('present: one projection for every plain-text surface', () => {
  it('renders a compaction record from its real fields, never NaN', async () => {
    const root = createRoot({ logger: silent })
    root.plugin(invariantsPlugin, {})
    root.plugin(sessionPlugin)
    await root.settle()
    const session = root.get(SESSIONS).create({ cwd: '/w' })
    const applied = session.append(COMPACTION_APPLIED, {
      trigger: 'pressure',
      budgetTokens: 8000,
      projectedTokens: 6500,
      surfaceTokensBefore: 6100,
      surfaceTokensAfter: 1900,
      shadowedSeqs: [2, 3, 4, 5, 6],
      startSeq: 1,
      retainedNodes: 3,
      auxCallSeq: 7,
    })
    expect(describeEvent(applied)).toBe('[compacted 5 messages · pressure · ~6.1k → ~1.9k]')
    expect(describeEvent(applied)).not.toContain('NaN')
    await root.dispose()
  })

  it('projects the authority plane and the tool pipeline as short, greppable lines', async () => {
    const root = createRoot({ logger: silent })
    root.plugin(invariantsPlugin, {})
    root.plugin(sessionPlugin)
    await root.settle()
    const session = root.get(SESSIONS).create({ cwd: '/w' })
    const stamp = session.append(SANDBOX_MODE, { mode: 'workspace-write', enforcement: 'none', reason: 'initial' })
    const open = session.append(SANDBOX_MODE, { mode: 'danger-full-access', enforcement: 'none', reason: 'change' })
    const policy = session.append(APPROVAL_POLICY, { policy: 'never', reason: 'change' })
    session.append(TURN_START, { turn: 1 })
    session.append(STEP_START, { turn: 1, step: 1 })
    const prompt = session.append(USER_MESSAGE, { message: createUserMessage('hello there') }, { surfaceOp: { op: 'append' } })
    const call = session.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' })
    const asked = session.append(APPROVAL_ASKED, { id: 'approval-7', toolName: 'bash', callId: 'c1', reason: 'run under "danger-full-access": need it' })
    const decided = session.append(APPROVAL_DECIDED, { id: 'approval-7', outcome: 'rejected' })
    const denied = session.append(
      TOOL_RESULT,
      { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'Error: no' }], true), error: { name: 'SandboxError', code: 'SANDBOX_ESCALATION_DENIED' } },
      { surfaceOp: { op: 'append' }, sourceEventSeqs: [call.seq] },
    )
    session.append(STEP_END, { turn: 1, step: 1 })
    const end = session.append(TURN_END, { turn: 1, reason: { kind: 'completed' } })

    expect(describeEvent(stamp)).toBe('[sandbox: workspace-write (initial; shell confinement none)]')
    expect(describeEvent(open)).toBe('[sandbox: danger-full-access (change; unconfined)]')
    expect(describeEvent(policy)).toBe('[approvals: never]')
    expect(describeEvent(prompt)).toBeUndefined() // the user's own words are not echoed
    expect(describeEvent(call)).toBe('→ bash {"command":"ls -la"}')
    expect(describeEvent(asked)).toBe('? approval-7 bash: run under "danger-full-access": need it')
    expect(describeEvent(decided)).toBe('! approval-7 rejected')
    expect(describeEvent(denied)).toBe('✗ SANDBOX_ESCALATION_DENIED')
    expect(describeEvent(end)).toBe('[turn completed]')

    const audit = auditLines(session.events)
    expect(audit).toContain('   0  sandbox     workspace-write (initial; shell confinement none)')
    expect(audit).toContain('   2  approvals   never (change)')
    expect(audit.some((line) => line.includes('asked       approval-7 bash') )).toBe(true)
    expect(audit).toContain('                    for: bash {"command":"ls -la"}')
    expect(audit.some((line) => line.includes('denied      SANDBOX_ESCALATION_DENIED (bash'))).toBe(true)
    // History shows what watching would have shown. It used to render three
    // kinds and hide nine, so paging back over an authority switch, an approval
    // or a denial showed none of them — which of two things you saw depended on
    // when you looked. The only differences left are deliberate: conversation
    // gets more room, and a completed turn needs no line.
    expect(transcriptLines(session.events)).toEqual([
      '[sandbox: workspace-write (initial; shell confinement none)]',
      '[sandbox: danger-full-access (change; unconfined)]',
      '[approvals: never]',
      'you> hello there',
      '→ bash {"command":"ls -la"}',
      '? approval-7 bash: run under "danger-full-access": need it',
      '! approval-7 rejected',
      '✗ SANDBOX_ESCALATION_DENIED',
    ])
    expect(transcriptLines([end])).toEqual([])
    await root.dispose()
  })
})

/**
 * One log, one answer. A durable fact no projection renders reaches only
 * whichever client happened to be holding the RPC that produced it — and an
 * AUTOMATIC compaction decline has no RPC at all.
 */
describe('what S8 added to the projection', () => {
  const ref = { id: 'sha256:' + 'ab'.repeat(32), mediaType: 'image/png', bytes: 12_700, width: 96, height: 96, name: 'quad.png' }

  it('shows an image in a tool result, which is where every image MiniDSH produces lives', async () => {
    const { asCallId } = await import('../core/ids.ts')
    const { createToolResultMessage } = await import('../core/llm/message.ts')
    const { imageDescriptor } = await import('../core/llm/content.ts')
    const message = createToolResultMessage(asCallId('c1'), [{ type: 'image', attachment: ref as never, text: imageDescriptor(ref as never) }], false)
    const event = { type: 'tool/result', seq: 9, time: 0, data: { turn: 1, step: 1, callId: 'c1', message }, surfaceOp: { op: 'append' as const } }
    const line = describeEvent(event)
    expect(line).toBe('✓ ' + imageDescriptor(ref as never))
    // Live and history say the same thing: one projection, not two.
    expect(transcriptLines([event])).toEqual([line])
  })

  it('renders a plain tool result exactly as it always did', async () => {
    const { asCallId } = await import('../core/ids.ts')
    const { createToolResultMessage } = await import('../core/llm/message.ts')
    const message = createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'output' }], false)
    expect(describeEvent({ type: 'tool/result', seq: 9, time: 0, data: { turn: 1, step: 1, callId: 'c1', message }, surfaceOp: { op: 'append' as const } })).toBe('✓')
  })

  it('names a compaction decline, which had no line on any surface before', () => {
    const start = { type: 'compaction/start', seq: 4, time: 0, data: { trigger: 'pressure', budgetTokens: 8000, projectedTokens: 7000, plannedStart: 1, plannedEnd: 3, plannedNodes: 3 } }
    expect(describeEvent(start)).toBe('[compacting 3 messages · pressure · budget 8k]')
    const declined = { type: 'compaction/end', seq: 5, time: 0, data: { startSeq: 4, outcome: { kind: 'declined', reason: 'summary-not-smaller' } } }
    expect(describeEvent(declined)).toBe('[compaction declined: summary-not-smaller]')
    // The applied path already has `compaction/applied`, which says what it cost.
    expect(describeEvent({ type: 'compaction/end', seq: 6, time: 0, data: { startSeq: 4, outcome: { kind: 'applied' } } })).toBeUndefined()
  })
})
