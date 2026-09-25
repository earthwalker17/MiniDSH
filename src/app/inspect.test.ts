/**
 * The cold readers (`app/inspect.ts`, `sessions verify|inspect`): every
 * judgement is an owner's own, the store is read and never written, and what
 * `inspect` says a resume would append is what a resume then appends.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { persistenceJsonlPlugin } from '../capabilities/persistence-jsonl/index.ts'
import { AGENTS, SUBAGENT_START } from '../core/agent/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED } from '../core/approval/index.ts'
import { EFFECT_RECORDED } from '../core/effects/index.ts'
import { asCallId, asSessionId } from '../core/ids.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../core/llm/message.ts'
import type { StoredSession } from '../core/persistence/index.ts'
import { SANDBOX_ACCEPTANCE, SANDBOX_MODE } from '../core/sandbox/index.ts'
import {
  ASSISTANT_MESSAGE,
  SESSION_LIFECYCLE,
  SESSIONS,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_DISPATCH,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type EventEnvelope,
} from '../core/session/index.ts'
import { coreHarness, type CoreHarness } from '../test-support/harness.ts'
import { main } from './cli.ts'
import { inspectLines, inspectStored, verdictExitCode, verifyAttachments, verifyLines, verifyStored } from './inspect.ts'
import { auditLines } from './present.ts'

let dirs: string[] = []
let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const call = (id: string) => ({ type: 'tool-call' as const, id: asCallId(id), name: 'bash', arguments: '{"command":"make"}' })

/** A log built event by event, the way a writer would have written it. */
function log(build: (add: <D>(type: string, data: D, surface?: boolean) => void) => void): EventEnvelope[] {
  const events: EventEnvelope[] = []
  build((type, data, surface = false) => {
    events.push({ type, seq: events.length, time: 1000 + events.length, data, ...(surface ? { surfaceOp: { op: 'append' as const } } : {}) })
  })
  return events
}

const stored = (events: EventEnvelope[], extra: Partial<StoredSession> = {}): StoredSession => ({
  header: { version: 0, id: asSessionId('s'), createdAt: 1, cwd: '/w' },
  events,
  integrity: { bytes: 100, readableBytes: 100, tail: 'none' },
  ...extra,
})

const opening = (add: <D>(type: string, data: D, surface?: boolean) => void): void => {
  add(SESSION_LIFECYCLE.type, { origin: 'new', dispatch: true, durability: 'synced' })
  add(SANDBOX_MODE.type, { mode: 'workspace-write', enforcement: 'full', reason: 'initial' })
}

/** A turn that ran one call to completion. */
const completedTurn = (add: <D>(type: string, data: D, surface?: boolean) => void): void => {
  add(TURN_START.type, { turn: 1 })
  add(STEP_START.type, { turn: 1, step: 1 })
  add(USER_MESSAGE.type, { message: createUserMessage('build it') }, true)
  add(ASSISTANT_MESSAGE.type, { turn: 1, step: 1, message: createAssistantMessage([call('c0')], 'p', 'm') }, true)
  add(TOOL_CALL.type, { turn: 1, step: 1, callId: 'c0', name: 'bash', arguments: '{"command":"make"}' })
  add(TOOL_DISPATCH.type, { turn: 1, step: 1, callId: 'c0' })
  add(EFFECT_RECORDED.type, { callId: 'c0', effect: 'shell-command', exitCode: 2, durationMs: 40, mode: 'workspace-write', enforcement: 'full' })
  add(TOOL_RESULT.type, { turn: 1, step: 1, callId: 'c0', message: createToolResultMessage(asCallId('c0'), [{ type: 'text', text: 'Read-only file system' }], false) }, true)
  add(STEP_END.type, { turn: 1, step: 1 })
  add(TURN_END.type, { turn: 1, reason: { kind: 'completed' } })
}

describe('verify: the verdict', () => {
  it('is ok for a balanced log, with nothing a resume would add', () => {
    const verification = verifyStored(stored(log((add) => (opening(add), completedTurn(add)))))
    expect({ verdict: verification.verdict, closers: verification.closers.length, findings: verification.findings }).toEqual({ verdict: 'ok', closers: 0, findings: [] })
    expect(verdictExitCode(verification.verdict)).toBe(0)
  })

  it('is interrupted for an open turn, and names the closers a resume appends', () => {
    const events = log((add) => {
      opening(add)
      add(TURN_START.type, { turn: 1 })
      add(STEP_START.type, { turn: 1, step: 1 })
      add(USER_MESSAGE.type, { message: createUserMessage('go') }, true)
      add(ASSISTANT_MESSAGE.type, { turn: 1, step: 1, message: createAssistantMessage([call('c1')], 'p', 'm') }, true)
      add(TOOL_CALL.type, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
    })
    const verification = verifyStored(stored(events))
    expect(verification.verdict).toBe('interrupted')
    expect(verdictExitCode(verification.verdict)).toBe(0)
    // A synced lifecycle that claims dispatch: the missing dispatch proves the gate never passed.
    expect(verification.closers.map((event) => [event.type, (event.data as { error?: { code: string } }).error?.code])).toEqual([
      ['tool/result', 'TOOL_NOT_STARTED'],
      ['step/end', undefined],
      ['turn/end', undefined],
    ])
    // And a live writer holding the lease turns "a crash" into "maybe running":
    // the closers are the ones a fork taken now appends, and none says "not started".
    const held = verifyStored(stored(events, { lease: { pid: process.pid, host: hostname(), alive: true } }))
    expect(held.inFlux).toBe(true)
    expect(held.findings.find((finding) => finding.check === 'tail')?.message).toMatch(/live writer holds this log/)
    expect(held.closers.map((event) => (event.data as { error?: { name: string; code: string } }).error).filter(Boolean)).toEqual([{ name: 'InFluxError', code: 'TOOL_OUTCOME_UNKNOWN' }])
    expect(verifyLines('s', held)[0]).toMatch(/interrupted — intact, in flux/)
    // A holder provably dead is a crash after all.
    expect(verifyStored(stored(events, { lease: { pid: 1, host: hostname(), alive: false } })).inFlux).toBe(false)
  })

  it('is torn for an unterminated final line, and damaged — exit 1 — past a readable prefix', () => {
    const events = log((add) => (opening(add), completedTurn(add)))
    expect(verifyStored(stored(events, { integrity: { bytes: 120, readableBytes: 100, tail: 'torn' } })).verdict).toBe('torn')
    const damaged = verifyStored(
      stored(events, { damaged: true, integrity: { bytes: 180, readableBytes: 100, tail: 'damaged', stop: { line: 14, byte: 100, reason: 'not JSON' } } }),
    )
    expect(damaged.verdict).toBe('damaged')
    expect(verdictExitCode(damaged.verdict)).toBe(1)
    expect(damaged.findings[0]).toMatchObject({ severity: 'error', check: 'integrity', message: expect.stringMatching(/line 14 \(byte 100\): not JSON; 100 of 180 bytes .*fork --salvage/) })
  })

  it('is invalid when the log breaks a rule the runtime holds appends to, at the seq it breaks it', () => {
    const forged = log((add) => {
      opening(add)
      add(SANDBOX_MODE.type, { mode: 'unfenced', enforcement: 'full', reason: 'change' })
    })
    const verification = verifyStored(stored(forged))
    expect(verification.verdict).toBe('invalid')
    expect(verification.findings).toEqual([expect.objectContaining({ severity: 'error', check: 'authority', seq: 2, message: expect.stringMatching(/unknown mode "unfenced"/) })])
  })

  it('reports a payload it cannot even read as malformed, never by throwing', () => {
    const events = log((add) => {
      opening(add)
      add(TURN_START.type, null)
    })
    const verification = verifyStored(stored(events))
    expect(verification.verdict).toBe('invalid')
    expect(verification.findings).toContainEqual(expect.objectContaining({ check: 'session', seq: 2, message: expect.stringMatching(/^malformed payload/) }))
    // And the report still stands: inspect reads what parses and stops at it.
    expect(inspectStored(stored(events), verification).lifecycles).toEqual([{ startSeq: 0, record: { origin: 'new', dispatch: true, durability: 'synced' } }])
  })

  it('calls a log invalid when a message a projection reads has the wrong shape, where it used to say intact', () => {
    const events = log((add) => {
      opening(add)
      add(TURN_START.type, { turn: 1 })
      add(STEP_START.type, { turn: 1, step: 1 })
      add(USER_MESSAGE.type, { message: null }, true)
    })
    const verification = verifyStored(stored(events))
    expect(verification.verdict).toBe('invalid')
    expect(verification.findings).toContainEqual(expect.objectContaining({ check: 'session', seq: 4, malformed: true, message: 'malformed payload: no message' }))
  })

  it('runs the report\'s folds too, so a log it calls sound is one inspect can read', () => {
    // No rule reads a turn's ending reason; the report does.
    const events = log((add) => {
      opening(add)
      add(TURN_START.type, { turn: 1 })
      add(TURN_END.type, { turn: 1, reason: null })
    })
    const verification = verifyStored(stored(events))
    expect(verification.verdict).toBe('invalid')
    expect(verification.findings).toContainEqual(expect.objectContaining({ check: 'fold', seq: 3, malformed: true }))
    // And the report stands, stopped before the payload it cannot read.
    expect(inspectStored(stored(events), verification).turns).toMatchObject({ total: 1, open: { turn: 1 } })
  })

  it('warns about what only the header can reveal: a child with no delegation opening, an ask nothing will close', () => {
    const child = verifyStored(stored(log((add) => (opening(add), completedTurn(add))), { header: { version: 0, id: asSessionId('c'), createdAt: 1, cwd: '/w', delegatedBy: asSessionId('p') } }))
    expect(child.findings).toEqual([expect.objectContaining({ severity: 'warning', check: 'delegation' })])
    const stranded = verifyStored(
      stored(
        log((add) => {
          opening(add)
          add(TURN_START.type, { turn: 1 })
          add(APPROVAL_ASKED.type, { id: 'approval-3', toolName: 'bash' })
          add(TURN_END.type, { turn: 1, reason: { kind: 'completed' } })
        }),
      ),
    )
    expect(stranded.findings).toEqual([expect.objectContaining({ severity: 'warning', check: 'approvals', message: expect.stringMatching(/approval-3 .* no repair closes it/) })])
  })
})

describe('verify: attachments', () => {
  it('reports a message it cannot read instead of throwing', async () => {
    const events = log((add) => {
      opening(add)
      add(USER_MESSAGE.type, { message: { id: 'm', role: 'user', content: null, source: { kind: 'user' } } }, true)
    })
    const attachments = { readImage: async () => new Uint8Array() } as unknown as Parameters<typeof verifyAttachments>[1]
    const findings = await verifyAttachments(events, attachments)
    expect(findings).toEqual([expect.objectContaining({ check: 'attachments', seq: 2, malformed: true })])
  })
})

describe('inspect: what the log alone says', () => {
  it('folds authority from the last RECORDED stamp, labels what resume closes, and names each lifecycle', () => {
    const events = log((add) => {
      opening(add)
      add(SANDBOX_ACCEPTANCE.type, { accepts: 'none', forMode: 'workspace-write', reason: 'initial' })
      completedTurn(add)
      add(SUBAGENT_START.type, { callId: 'c0', childId: 'child-1', depth: 1, provider: 'p', model: 'm', sandbox: 'read-only', approval: 'never' })
      add(TURN_START.type, { turn: 2 })
      add(APPROVAL_ASKED.type, { id: 'approval-9', toolName: 'bash', callId: 'c9' })
    })
    const verification = verifyStored(stored(events))
    const inspection = inspectStored(stored(events), verification)
    expect(inspection.authority).toEqual({ mode: 'workspace-write', enforcement: 'full', accepts: 'none', grants: [] })
    expect(inspection.lifecycles).toEqual([{ startSeq: 0, record: { origin: 'new', dispatch: true, durability: 'synced' } }])
    expect(inspection.undecidedApprovals).toEqual([{ id: 'approval-9', toolName: 'bash', seq: events.length - 1, closedOnResume: true }])
    expect(inspection.children).toEqual([{ childId: 'child-1', callId: 'c0', seq: expect.any(Number) }])
    expect(inspection.turns).toMatchObject({ total: 2, open: { turn: 2 } })
    // Innermost first: the delegation, then the session's own approval and turn.
    expect(verification.closers.map((event) => event.type)).toEqual(['subagent/end', APPROVAL_DECIDED.type, TURN_END.type])
  })

  it('names each segment by the build that wrote it, and none for one whose record names none', () => {
    // An S16 log resumed by 1.0.0: its composition record names no build, and
    // must not inherit the one before it.
    const events = log((add) => {
      opening(add)
      add('composition/applied', { hash: 'aaaa', writer: 'minidsh 1.1.0-dev', rows: [] })
      add('session/end-seed', {})
      add('composition/applied', { hash: 'bbbb', rows: [] })
    })
    const inspection = inspectStored(stored(events), verifyStored(stored(events)))
    expect(inspection.lifecycles.map((view) => view.writer)).toEqual(['minidsh 1.1.0-dev', undefined])
    expect(inspectLines(inspection).find((line) => line.startsWith('      4'))).toBe('      4  no record (a build before S16)')
  })

  it('shows, in the audit, what a call DID and what a resume would say about the one in flight', () => {
    const events = log((add) => {
      opening(add)
      completedTurn(add)
      add(TURN_START.type, { turn: 2 })
      add(STEP_START.type, { turn: 2, step: 1 })
      add(ASSISTANT_MESSAGE.type, { turn: 2, step: 1, message: createAssistantMessage([call('c7')], 'p', 'm') }, true)
      add(TOOL_CALL.type, { turn: 2, step: 1, callId: 'c7', name: 'bash', arguments: '{"command":"deploy"}' })
      add(TOOL_DISPATCH.type, { turn: 2, step: 1, callId: 'c7' })
    })
    const lines = auditLines(events, verifyStored(stored(events)).closers)
    expect(lines.some((line) => /effect {6}ran a shell command under workspace-write\/full \(exit 2, 40ms\) \(bash /.test(line))).toBe(true)
    expect(lines.some((line) => /unknown {5}bash \{"command":"deploy"\} — its outcome was lost with the process \(on resume\)$/.test(line))).toBe(true)
  })
})

describe('sessions verify | inspect: cold reads through the CLI', () => {
  async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = []
    const err: string[] = []
    const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) }
    process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write
    try {
      return { code: await main(argv), out: out.join(''), err: err.join('') }
    } finally {
      process.stdout.write = write.out
      process.stderr.write = write.err
    }
  }

  it('reads a crashed log without a lease or a write, and predicts exactly the closers a resume appends', async () => {
    const home = tempDir('minidsh-home-')
    const previous = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    try {
      harness = await coreHarness()
      harness.root.plugin(persistenceJsonlPlugin, { root: join(home, 'sessions') })
      await harness.root.settle()
      const sessions = harness.root.get(SESSIONS)
      const crashed = sessions.create({ cwd: process.cwd(), id: asSessionId('crashed') })
      crashed.append(SESSION_LIFECYCLE, { origin: 'new', dispatch: true, durability: 'synced' })
      crashed.append(TURN_START, { turn: 1 })
      crashed.append(STEP_START, { turn: 1, step: 1 })
      crashed.append(USER_MESSAGE, { message: createUserMessage('go') }, { surfaceOp: { op: 'append' } })
      crashed.append(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([call('c1'), call('c2')], 'scripted', 'scripted-model') }, { surfaceOp: { op: 'append' } })
      crashed.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
      crashed.append(APPROVAL_ASKED, { id: 'approval-6', toolName: 'bash', callId: 'c1' })
      await sessions.detach(crashed)
      const file = join(home, 'sessions', 'crashed.jsonl')
      const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs }

      const verified = await capture(['sessions', 'verify', 'crashed', '--json'])
      expect(verified.code).toBe(0)
      const verdict = JSON.parse(verified.out) as { verdict: string; closers: EventEnvelope[] }
      expect(verdict.verdict).toBe('interrupted')
      const inspected = await capture(['sessions', 'inspect', 'crashed'])
      expect(inspected.code).toBe(0)
      expect(inspected.out).toMatch(/a resume would append:/)
      // Cold: the source is byte-identical, untouched, unleased, and no sidecar appeared.
      expect(readFileSync(file).equals(before.bytes)).toBe(true)
      expect(statSync(file).mtimeMs).toBe(before.mtime)
      expect(existsSync(`${file}.lock`)).toBe(false)
      expect(existsSync(`${file}.torn`)).toBe(false)

      // And the prediction is exact: what the resume appended is, byte for byte, what verify said it would.
      const resumed = await harness.root.get(AGENTS).resume(harness.root, asSessionId('crashed'), { agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      const appended = resumed.agent.session.events.slice(before.bytes.toString('utf8').trim().split('\n').length - 1, resumed.agent.session.liveStart)
      expect(appended.map((event) => JSON.stringify(event))).toEqual(verdict.closers.map((event) => JSON.stringify(event)))
      await resumed.dispose()
    } finally {
      if (previous === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previous
    }
  })

  it('reads a log a live writer holds as in flux, leaves its lease alone, and audits no crash that has not happened', async () => {
    const home = tempDir('minidsh-home-')
    const previous = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    try {
      harness = await coreHarness()
      harness.root.plugin(persistenceJsonlPlugin, { root: join(home, 'sessions') })
      await harness.root.settle()
      const sessions = harness.root.get(SESSIONS)
      // Held by THIS process: the lock names process.pid on this host, which probes alive.
      const live = sessions.create({ cwd: process.cwd(), id: asSessionId('running') })
      live.append(SESSION_LIFECYCLE, { origin: 'new', dispatch: true, durability: 'synced' })
      live.append(TURN_START, { turn: 1 })
      live.append(STEP_START, { turn: 1, step: 1 })
      live.append(USER_MESSAGE, { message: createUserMessage('go') }, { surfaceOp: { op: 'append' } })
      live.append(ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([call('c1')], 'scripted', 'scripted-model') }, { surfaceOp: { op: 'append' } })
      live.append(TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"make"}' })
      const lock = `${join(home, 'sessions', 'running.jsonl')}.lock`
      const lockBefore = readFileSync(lock)

      const verified = await capture(['sessions', 'verify', 'running', '--json'])
      expect(JSON.parse(verified.out)).toMatchObject({ verdict: 'interrupted', inFlux: true })
      const inspected = await capture(['sessions', 'inspect', 'running'])
      expect(inspected.out).toMatch(/a fork taken now would close it with/)
      expect(inspected.out).toMatch(/lease: held by pid \d+ on .* \(alive\)/)
      const audited = await capture(['sessions', 'show', 'running', '--audit'])
      expect(audited.out).not.toMatch(/on resume/)
      // The lease is read, never taken, reclaimed or rewritten.
      expect(readFileSync(lock).equals(lockBefore)).toBe(true)
      await sessions.detach(live)
    } finally {
      if (previous === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previous
    }
  })

  it('says a newer format is unsupported, distinct from damage, and refuses a flag a reader does not take', async () => {
    const home = tempDir('minidsh-home-')
    const previous = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(home, 'sessions'), { recursive: true })
      writeFileSync(join(home, 'sessions', 'future.jsonl'), `${JSON.stringify({ kind: 'session', version: 7, id: 'future', createdAt: 1, cwd: '/w' })}\n`)
      const future = await capture(['sessions', 'verify', 'future', '--json'])
      expect(future.code).toBe(1)
      expect(JSON.parse(future.out)).toMatchObject({ verdict: 'unsupported', message: expect.stringMatching(/format 7, and this MiniDSH reads format 0/) })
      const missing = await capture(['sessions', 'verify', 'nobody'])
      expect({ code: missing.code, err: missing.err.trim() }).toEqual({ code: 1, err: 'no session "nobody"' })
      const wrongFlag = await capture(['sessions', 'verify', 'future', '--audit'])
      expect({ code: wrongFlag.code, err: wrongFlag.err.trim() }).toEqual({ code: 2, err: '--audit is not a flag of "sessions verify"' })
      const both = await capture(['sessions', 'show', 'future', '--json', '--audit'])
      expect({ code: both.code, err: both.err.trim() }).toEqual({ code: 2, err: '"sessions show" takes --json or --audit, not both' })

      // A file whose header a power cut zero-filled is damage, not absence.
      writeFileSync(join(home, 'sessions', 'zeroed.jsonl'), Buffer.alloc(4096))
      const zeroed = await capture(['sessions', 'verify', 'zeroed', '--json'])
      expect(zeroed.code).toBe(1)
      expect(JSON.parse(zeroed.out)).toMatchObject({ verdict: 'damaged', message: expect.stringMatching(/cannot be read at all: NUL bytes where the header line should be/) })
    } finally {
      if (previous === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previous
    }
  })
})
