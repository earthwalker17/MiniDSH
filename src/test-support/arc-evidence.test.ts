/**
 * The readings the live arcs share, checked on real records without a model:
 * each case here is one an arc got wrong while every run stayed green.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AGENTS } from '../core/agent/index.ts'
import { createUserMessage } from '../core/llm/message.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { defineTool, TOOLS } from '../core/tools/index.ts'
import { assertReplayed, compactionRecords, namesPath, resultFailed, resultText, surfaceWalk } from './arc-evidence.ts'
import { coreHarness, type CoreHarness } from './harness.ts'
import { installLlmReplay, type ReplayHandle } from './llm-replay.ts'
import { assistantMessage, assistantText } from './scripted-adapter.ts'

let harnesses: CoreHarness[] = []
/** Where this file's deliberate failures keep their evidence; an arc leaves the default, which nothing deletes. */
const keepIn = mkdtempSync(join(tmpdir(), 'minidsh-arc-evidence-test-'))
afterAll(() => rmSync(keepIn, { recursive: true, force: true }))
afterEach(async () => {
  const owned = harnesses.toReversed()
  harnesses = []
  const failures: unknown[] = []
  for (const harness of owned) await harness.dispose().catch((error: unknown) => void failures.push(error))
  if (failures.length > 0) throw failures[0]
})

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  execute: (args) => {
    if (args.text === 'fail') throw new Error('the body refused')
    return { echoed: args.text }
  },
  render: (_args, value) => [{ type: 'text', text: value.echoed }],
})

/** One real turn: a call that succeeds, one whose body throws, one for a tool nobody registered; then an answer. */
async function record(): Promise<EventEnvelope[]> {
  const harness = await coreHarness()
  harnesses.push(harness)
  harness.root.get(TOOLS).register(harness.root, echo)
  harness.adapter.script(assistantMessage([{ call: ['ok', 'echo', { text: 'pong' }] }, { call: ['threw', 'echo', { text: 'fail' }] }, { call: ['unknown', 'no_such_tool', {}] }]), assistantText('recorded answer'))
  const { agent } = await harness.create()
  agent.followup(createUserMessage('run it'))
  await agent.whenIdle()
  return agent.session.events.map((event) => ({ ...event }))
}

const resultOf = (events: readonly EventEnvelope[], callId: string): EventEnvelope => events.find((event) => event.type === 'tool/result' && (event.data as { callId: string }).callId === callId)!

describe('resultFailed', () => {
  it('reads a failed call as failed, from the record a driver really writes', async () => {
    const events = await record()
    expect(resultFailed(resultOf(events, 'ok'))).toBe(false)
    expect(resultText(resultOf(events, 'ok'))).toBe('pong')
    expect(resultFailed(resultOf(events, 'threw')), JSON.stringify(resultOf(events, 'threw').data)).toBe(true)
    expect(resultText(resultOf(events, 'threw'))).toContain('the body refused')
    expect(resultFailed(resultOf(events, 'unknown'))).toBe(true)
    // The reading it replaces: the record has no such field, so nothing ever failed.
    for (const callId of ['ok', 'threw', 'unknown']) expect((resultOf(events, callId).data as { isError?: boolean }).isError, callId).toBeUndefined()
  })

  it('refuses an event that is not a tool/result, rather than calling it a success', async () => {
    const events = await record()
    expect(() => resultFailed(events.find((event) => event.type === 'tool/call')!)).toThrowError(/is not a tool\/result/)
  })
})

describe('namesPath', () => {
  const windows = 'C:\\Users\\Jo\\AppData\\Local\\Temp\\ws-1\\done.txt'

  it('finds a Windows path in JSON arguments, where its backslashes are doubled', () => {
    const args = JSON.stringify({ command: 'create', path: windows })
    expect(args.includes(windows), 'the reading it replaces never matched').toBe(false)
    expect(namesPath(args, windows, 'win32')).toBe(true)
  })

  it('finds the forward-slash spelling and another letter case on Windows, and neither on a case-sensitive host', () => {
    const args = JSON.stringify({ command: `Set-Content c:/users/jo/appdata/local/temp/ws-1/done.txt ok` })
    expect(namesPath(args, windows, 'win32')).toBe(true)
    expect(namesPath(args, windows, 'linux')).toBe(false)
    expect(namesPath(JSON.stringify({ path: '/tmp/ws-1/done.txt' }), '/tmp/ws-1/done.txt', 'linux')).toBe(true)
    expect(namesPath(JSON.stringify({ path: '/tmp/WS-1/done.txt' }), '/tmp/ws-1/done.txt', 'linux')).toBe(false)
  })

  it('does not find a path the arguments do not name', () => {
    expect(namesPath(JSON.stringify({ path: 'done.txt' }), windows, 'win32')).toBe(false)
    expect(namesPath(JSON.stringify({ path: 'C:\\Users\\Jo\\other\\done.txt' }), windows, 'win32')).toBe(false)
  })
})

/** A log-only or surface event as a stored log holds one. */
const at = (seq: number, type: string, data: unknown, surface?: EventEnvelope['surfaceOp']): EventEnvelope => ({ type, seq, time: 0, data, ...(surface === undefined ? {} : { surfaceOp: surface }) })
const user = (seq: number, form?: string): EventEnvelope => at(seq, 'user/message', { message: { source: form === undefined ? { kind: 'user' } : { kind: 'plugin', form } } }, { op: 'append' })

/** A session that compacted once: two notes read, the first replaced by a summary at the next step. `shift` adds log-only facts in front. */
function compacted(shift: number, declined = false): EventEnvelope[] {
  const lead = Array.from({ length: shift }, (_unused, index) => at(index, 'sandbox/mode', { mode: 'workspace-write', reason: 'initial' }))
  const s = shift
  return [
    ...lead,
    user(s),
    at(s + 1, 'step/start', { turn: 1, step: 1 }),
    at(s + 2, 'assistant/message', { message: { source: { kind: 'assistant' } } }, { op: 'append' }),
    at(s + 3, 'tool/result', { turn: 1, step: 1, callId: 'c1', message: { source: { kind: 'tool' }, content: [] } }, { op: 'append' }),
    at(s + 4, 'compaction/start', { trigger: 'pressure', budgetTokens: 16_000, projectedTokens: 9_250, plannedStart: s, plannedEnd: s + 3, plannedNodes: 3 }),
    ...(declined
      ? [at(s + 5, 'compaction/end', { startSeq: s + 4, outcome: { kind: 'declined', reason: 'summary-not-smaller' } })]
      : [
          at(s + 5, 'compaction/applied', { trigger: 'pressure', budgetTokens: 16_000, projectedTokens: 9_250, surfaceTokensBefore: 9_000, surfaceTokensAfter: 2_100, shadowedSeqs: [s, s + 2, s + 3], retainedNodes: 0, auxCallSeq: s + 4, startSeq: s + 4 }),
          at(s + 6, 'user/message', { message: { source: { kind: 'plugin', form: 'compaction-summary' } } }, { op: 'replace', start: s, end: s + 3 }),
          at(s + 7, 'compaction/end', { startSeq: s + 4, outcome: { kind: 'applied' } }),
        ]),
    at(s + 8, 'step/start', { turn: 1, step: 2 }),
    at(s + 9, 'assistant/message', { message: { source: { kind: 'assistant' } } }, { op: 'append' }),
  ]
}

describe('surfaceWalk', () => {
  it('reads the same walk off two logs whose seqs differ by facts that are not on the surface', () => {
    const walk = surfaceWalk(compacted(0))
    expect(walk).toEqual([
      '#0 append user/message (user)',
      '#1 append assistant/message (assistant)',
      '#2 append tool/result (tool)',
      '#3 replace #0..#2 by user/message (compaction-summary)',
      'compaction (pressure) after step 1:1, planned #0..#2 (3 nodes): applied',
      '#4 append assistant/message (assistant)',
    ])
    expect(surfaceWalk(compacted(3)), 'three log-only facts in front move every seq and no position').toEqual(walk)
  })

  it('tells a compaction that was declined from one that was applied at the same point', () => {
    expect(surfaceWalk(compacted(0, true))).toEqual([
      '#0 append user/message (user)',
      '#1 append assistant/message (assistant)',
      '#2 append tool/result (tool)',
      'compaction (pressure) after step 1:1, planned #0..#2 (3 nodes): declined (summary-not-smaller)',
      '#3 append assistant/message (assistant)',
    ])
    expect(compactionRecords(compacted(2))).toEqual([
      '6 start   pressure: projected 9250 of 16000, planned seqs 2..5 (3 nodes)',
      '7 applied surface 9000 -> 2100, shadowed 2,4,5, kept 0, summary at 6',
      '9 end     of 6: applied',
    ])
  })
})

describe('assertReplayed', () => {
  /** A handle whose own verdict is "yes": what is left is the walk. */
  const agreeing: ReplayHandle = { dispose: async () => {}, assertConsumed: () => {}, cursors: () => ({ logs: [] }), steps: 0, auxCalls: 0, providers: [] }
  /** The file a failure says it kept its evidence in, which must be in the directory this file asked for. */
  const keptAt = (error: unknown): string => {
    const file = /are kept at (.+\.json)$/m.exec((error as Error).message)?.[1] ?? ''
    expect(dirname(file), 'the evidence went somewhere else').toBe(keepIn)
    return file
  }

  it('passes a replay that drained its recording and walked its surface', async () => {
    const recorded = await record()
    const harness = await coreHarness()
    harnesses.push(harness)
    const handle = installLlmReplay(harness.root, { events: recorded, provider: 'replay' })
    harness.root.get(TOOLS).register(harness.root, echo)
    const replayed = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay' } })
    replayed.agent.followup(createUserMessage('run it'))
    await replayed.agent.whenIdle()
    expect(surfaceWalk(replayed.agent.session.events)).toEqual(surfaceWalk(recorded))
    assertReplayed({ arc: 'arc-evidence test', handle, recorded, replayed: replayed.agent.session.events, sameWalk: true, keepIn })
    expect(readdirSync(keepIn), 'a replay that passed keeps nothing').toEqual([])
    await replayed.dispose()
  })

  it('fails a replay the oracle refused, and keeps both logs and the cursors in a file the failure names', async () => {
    const recorded = await record()
    const harness = await coreHarness()
    harnesses.push(harness)
    const handle = installLlmReplay(harness.root, { events: recorded, provider: 'replay' })
    harness.root.get(TOOLS).register(harness.root, echo)
    // One step allowed: the recorded answer is never asked for.
    const replayed = await harness.root.get(AGENTS).create(harness.root, { cwd: process.cwd(), agentOptions: { provider: 'replay', model: 'replay', maxSteps: 1 } })
    replayed.agent.followup(createUserMessage('run it'))
    await replayed.agent.whenIdle()
    const error = (() => {
      try {
        assertReplayed({ arc: 'arc-evidence test', handle, recorded, replayed: replayed.agent.session.events, keepIn })
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    await replayed.dispose()
    expect((error as Error).message).toMatch(/replayed 1 of 2 recorded steps\ncursors: the root log: steps 1\/2 \(next recorded at 1:2\), out-of-loop 0\/0, asked past the end 0/)
    const file = keptAt(error)
    expect(existsSync(file), `the failure named ${file}`).toBe(true)
    const dump = JSON.parse(readFileSync(file, 'utf8')) as { failures: string[]; cursors: { logs: { steps: unknown }[] }; recorded: unknown[]; replayed: unknown[]; walk: { recorded: string[]; replayed: string[] } }
    expect(dump.failures).toEqual([expect.stringContaining('replayed 1 of 2 recorded steps')])
    expect(dump.cursors.logs[0]!.steps).toEqual({ replayed: 1, recorded: 2, next: '1:2' })
    expect(dump.recorded).toHaveLength(recorded.length)
    expect(dump.replayed).toHaveLength(replayed.agent.session.events.length)
    expect(dump.walk.recorded.length).toBeGreaterThan(dump.walk.replayed.length)
  })

  it('fails a replay whose counts agree and whose compaction came at another point, saying where the walks part', () => {
    // The same number of summary calls, one applied and one declined: all a count could compare is equal.
    const error = (() => {
      try {
        assertReplayed({ arc: 'arc-evidence walk', handle: agreeing, recorded: compacted(0), replayed: compacted(0, true), sameWalk: true, keepIn })
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect((error as Error | undefined)?.message).toMatch(
      /the replay left the recording's walk at entry 3 of 6 \(the replay made 5\):\n {2}recorded: #3 replace #0\.\.#2 by user\/message \(compaction-summary\)\n {2}replayed: compaction \(pressure\) after step 1:1, planned #0\.\.#2 \(3 nodes\): declined \(summary-not-smaller\)/,
    )
    expect((error as Error).message).toContain('compactions recorded:\n  4 start   pressure: projected 9250 of 16000')
    expect(existsSync(keptAt(error))).toBe(true)
    // Without `sameWalk` the same pair passes: the walk is a claim an arc makes, not a default.
    assertReplayed({ arc: 'arc-evidence walk', handle: agreeing, recorded: compacted(0), replayed: compacted(0, true), keepIn })
  })

  it('fails a replay that walked further than its recording', () => {
    const longer = [...compacted(0), user(10)]
    expect(() => assertReplayed({ arc: 'arc-evidence walk', handle: agreeing, recorded: compacted(0), replayed: longer, sameWalk: true, keepIn })).toThrowError(
      /left the recording's walk at entry 6 of 6 \(the replay made 7\):\n {2}recorded: \(nothing more\)\n {2}replayed: #5 append user\/message \(user\)/,
    )
  })
})
