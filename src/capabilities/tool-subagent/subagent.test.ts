/**
 * Delegation against the FULL composition: what a child may do is decided by
 * several capabilities acting together (the factory, both authority knobs,
 * the tool registry, persistence), and a claim about their interplay is only
 * true where they all act — the S5.5 lesson, applied.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../../kernel/index.ts'
import { AGENTS, type AgentHandle } from '../../core/agent/index.ts'
import { asSessionId } from '../../core/ids.ts'
import { LLM } from '../../core/llm/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import type { ContentBlock, Message } from '../../core/llm/index.ts'
import { SANDBOX } from '../../core/sandbox/index.ts'
import { matches, TOOL_RESULT, type EventEnvelope, type Session } from '../../core/session/index.ts'
import { TOOLS } from '../../core/tools/index.ts'
import { bootComposition } from '../../app/headless.ts'
import { auditLines, describeEvent } from '../../app/present.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../../test-support/scripted-adapter.ts'
import { SUBAGENT_END, SUBAGENT_START } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

let dirs: string[] = []
let roots: Context[] = []
afterEach(async () => {
  for (const root of roots.toReversed()) await root.dispose()
  roots = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface World {
  readonly root: Context
  readonly cwd: string
  readonly sessionsRoot: string
  readonly adapter: ScriptedAdapter
  create(): Promise<AgentHandle>
}

async function world(patches: { id: string; config?: unknown; disabled?: boolean }[] = []): Promise<World> {
  const cwd = tempDir('minidsh-sub-cwd-')
  const sessionsRoot = tempDir('minidsh-sub-sessions-')
  const adapter = new ScriptedAdapter()
  const root = await bootComposition({
    sessionsRoot,
    // Everything a real run has except the network: the fs fence, the shell,
    // the approval seam, the invariants — and the subagent tool.
    patches: [{ id: 'llm-deepseek', disabled: true }, ...patches],
    logger: silent,
    prepare: (context) => void context.get(LLM).registerAdapter(context, adapter),
  })
  roots.push(root)
  return { root, cwd, sessionsRoot, adapter, create: () => root.get(AGENTS).create(root, { cwd, agentOptions: SCRIPTED }) }
}

/** The parent delegates once, then reports; the child answers with `childReply`. */
function scriptDelegation(adapter: ScriptedAdapter, prompt: string, childReply: string, parentReply = 'done'): void {
  adapter.script(assistantToolCall('call-1', 'subagent', { description: 'a bounded task', prompt }), assistantText(childReply), assistantText(parentReply))
}

function eventsOf(session: Session, type: string): EventEnvelope[] {
  return session.events.filter((event) => event.type === type)
}

/** The text the model sees in a tool result: it lives inside the `tool-result` block, not beside it. */
function resultText(message: Message): string {
  const flatten = (blocks: readonly ContentBlock[]): string =>
    blocks.map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? flatten(block.content) : '')).join('')
  return flatten(message.content)
}

function storedEvents(sessionsRoot: string, id: string): EventEnvelope[] {
  return readFileSync(join(sessionsRoot, `${encodeURIComponent(id)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

describe('delegation through the full composition', () => {
  it('runs a child in its own session under a delegation opening, and hands its answer back as the tool result', async () => {
    const w = await world()
    scriptDelegation(w.adapter, 'Count the files.', 'there are three files')
    const handle = await w.create()
    handle.agent.followup(createUserMessage('delegate this'))
    await handle.agent.whenIdle()

    // The parent's log: the call, the two delegation facts, and the result carrying the child's answer.
    const start = eventsOf(handle.agent.session, SUBAGENT_START.type)[0]!.data as { childId: string; depth: number; sandbox: string; approval: string; provider: string }
    expect(start).toMatchObject({ depth: 1, sandbox: 'workspace-write', approval: 'never', provider: 'scripted' })
    const end = eventsOf(handle.agent.session, SUBAGENT_END.type)[0]!.data as { childId: string; reason: { kind: string }; usage?: { outputTokens: number } }
    expect(end.childId).toBe(start.childId)
    expect(end.reason.kind).toBe('completed')
    expect(end.usage!.outputTokens).toBeGreaterThan(0)
    const result = handle.agent.session.events.find((event) => matches(event, TOOL_RESULT))!
    expect(resultText(result.data.message)).toContain('there are three files')
    expect(result.data.error).toBeUndefined()

    // The child ran in its OWN session, stored beside its parent, opening under a delegation stamp.
    const child = storedEvents(w.sessionsRoot, start.childId)
    expect(child.filter((event) => event.type === 'sandbox/mode').map((event) => event.data)).toEqual([{ mode: 'workspace-write', enforcement: 'none', reason: 'delegation' }])
    expect(child.filter((event) => event.type === 'approval/policy').map((event) => event.data)).toEqual([{ policy: 'never', reason: 'delegation' }])
    expect(child.some((event) => event.type === 'user/message' && JSON.stringify(event.data).includes('Count the files.'))).toBe(true)
    // The child's STEPS are the child's own log, never the parent's: the
    // parent ran one turn (delegate, then report), the child ran its own.
    expect(eventsOf(handle.agent.session, 'turn/start')).toHaveLength(1)
    expect(child.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    expect(eventsOf(handle.agent.session, 'assistant/message')).toHaveLength(2)
    // The child's answer reaches the parent exactly once, as the tool result.
    expect(handle.agent.session.events.filter((event) => JSON.stringify(event.data).includes('there are three files'))).toHaveLength(1)
    // Its header carries the lineage, and the parent's does not.
    const stored = w.root.get(AGENTS).get(asSessionId(start.childId))
    expect(stored).toBeUndefined() // disposed with the call
    const header = JSON.parse(readFileSync(join(w.sessionsRoot, `${encodeURIComponent(start.childId)}.jsonl`), 'utf8').split('\n')[0]!) as Record<string, unknown>
    expect(header).toMatchObject({ delegatedBy: handle.agent.id, delegationDepth: 1 })

    // The human-facing projections say what happened, and the audit calls it an authority act.
    expect(describeEvent(eventsOf(handle.agent.session, SUBAGENT_START.type)[0]!)).toContain('approvals never')
    expect(auditLines(handle.agent.session.events).some((line) => line.includes('delegated') && line.includes('workspace-write'))).toBe(true)
    await handle.dispose()
  })

  it('never lets a child widen: an approval-gated action is refused inside its own session, and the refusal is recorded', async () => {
    const w = await world()
    // The child asks the shell for something this host cannot confine, then escalates.
    w.adapter.script(
      assistantToolCall('call-1', 'subagent', { description: 'run a command', prompt: 'Run `echo hi` in the shell.' }),
      assistantToolCall('call-2', process.platform === 'win32' ? 'pwsh' : 'bash', { command: 'echo hi', sandbox_permissions: 'danger-full-access', justification: 'the command cannot be confined' }),
      assistantText('I could not run it: my scope is fixed.'),
      assistantText('the subagent could not run the command'),
    )
    const handle = await w.create()
    handle.agent.followup(createUserMessage('delegate a command'))
    await handle.agent.whenIdle()

    const start = eventsOf(handle.agent.session, SUBAGENT_START.type)[0]!.data as { childId: string }
    const child = storedEvents(w.sessionsRoot, start.childId)
    // The ask was recorded and refused by the pin — inside the service, before any answerer.
    const decided = child.filter((event) => event.type === 'approval/decided').map((event) => (event.data as { outcome: string }).outcome)
    expect(decided).toEqual(['rejected'])
    expect(child.some((event) => event.type === 'tool/result' && (event.data as { error?: { code: string } }).error?.code === 'SANDBOX_ESCALATION_DENIED')).toBe(true)
    // Its authority never moved: one stamp, the delegation opening.
    expect(child.filter((event) => event.type === 'sandbox/mode')).toHaveLength(1)
    // And the audit of the CHILD reads the whole story.
    const audit = auditLines(child)
    expect(audit[0]).toContain('workspace-write (delegation')
    expect(audit.some((line) => line.includes('rejected'))).toBe(true)
    await handle.dispose()
  })

  it('hides the delegation tool from the child and refuses a call to it, so depth cannot be evaded', async () => {
    const w = await world()
    let childSaw: string[] = []
    w.adapter.script(
      assistantToolCall('call-1', 'subagent', { description: 'nested', prompt: 'Delegate again.' }),
      (request) => {
        childSaw = (request.tools ?? []).map((tool) => tool.name)
        return assistantToolCall('call-2', 'subagent', { description: 'deeper', prompt: 'And again.' })
      },
      assistantText('I cannot delegate further.'),
      assistantText('reported'),
    )
    const handle = await w.create()
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()
    // The child never saw the tool…
    expect(childSaw).not.toContain('subagent')
    expect(childSaw).toContain('str_replace_editor')
    const start = eventsOf(handle.agent.session, SUBAGENT_START.type)[0]!.data as { childId: string }
    // …and calling it anyway is refused, not executed.
    const child = storedEvents(w.sessionsRoot, start.childId)
    const refused = child.find((event) => event.type === 'tool/result' && (event.data as { error?: { code: string } }).error?.code === 'UNKNOWN_TOOL')
    expect(refused).toBeDefined()
    expect(eventsOf(handle.agent.session, SUBAGENT_START.type)).toHaveLength(1)
    await handle.dispose()
  })

  it('refuses at the depth cap before creating anything, and the parent is told', async () => {
    const w = await world([{ id: 'tool-subagent', config: { maxDepth: 0 } }])
    scriptDelegation(w.adapter, 'anything', 'never runs', 'I could not delegate')
    const handle = await w.create()
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()
    const result = handle.agent.session.events.find((event) => matches(event, TOOL_RESULT))!
    expect(result.data.error?.code).toBe('SUBAGENT_DEPTH')
    expect(resultText(result.data.message)).toContain('exceeds the limit of 0')
    // Nothing was created: no start record, no second session file.
    expect(eventsOf(handle.agent.session, SUBAGENT_START.type)).toHaveLength(0)
    await handle.dispose()
    expect(readdirSync(w.sessionsRoot).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1)
  })

  it('reports an unfinished child as an error result carrying whatever it managed to say', async () => {
    const w = await world([{ id: 'tool-subagent', config: { maxSteps: 1 } }])
    w.adapter.script(
      assistantToolCall('call-1', 'subagent', { description: 'too big', prompt: 'Read every file.' }),
      // The child's one allowed step calls a tool, so its turn ends `max-steps`.
      assistantToolCall('call-2', 'str_replace_editor', { command: 'view', path: 'nothing.txt' }),
      assistantText('the subagent did not finish'),
    )
    const handle = await w.create()
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()
    const result = handle.agent.session.events.find((event) => matches(event, TOOL_RESULT))!
    expect(result.data.error?.code).toBe('SUBAGENT_INCOMPLETE')
    expect(resultText(result.data.message)).toContain('max-steps')
    const end = eventsOf(handle.agent.session, SUBAGENT_END.type)[0]!.data as { reason: { kind: string } }
    expect(end.reason.kind).toBe('max-steps')
    await handle.dispose()
  })

  it('a cancelled parent call cancels the child, and the child keeps its own balanced log', async () => {
    const w = await world()
    const cwdFile = join((await world()).cwd, 'unused.txt')
    writeFileSync(cwdFile, 'x', 'utf8')
    let cancel!: () => void
    const started = new Promise<void>((resolve) => {
      cancel = resolve
    })
    w.adapter.script(
      assistantToolCall('call-1', 'subagent', { description: 'slow work', prompt: 'Take your time.' }),
      async () => {
        // The child is mid-request when the parent turn is cancelled.
        cancel()
        await new Promise((resolve) => setTimeout(resolve, 200))
        return assistantText('too late')
      },
    )
    const handle = await w.create()
    handle.agent.followup(createUserMessage('go'))
    await started
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
    const start = eventsOf(handle.agent.session, SUBAGENT_START.type)[0]!.data as { childId: string }
    const child = storedEvents(w.sessionsRoot, start.childId)
    const turnEnd = child.filter((event) => event.type === 'turn/end').at(-1)!.data as { reason: { kind: string } }
    expect(turnEnd.reason.kind).toBe('cancelled')
    // Balanced: every step that opened, closed.
    expect(child.filter((event) => event.type === 'step/start')).toHaveLength(child.filter((event) => event.type === 'step/end').length)
    await handle.dispose()
  })

  it('a resumed child keeps its depth and its ceiling', async () => {
    const w = await world()
    scriptDelegation(w.adapter, 'a task', 'an answer')
    const handle = await w.create()
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()
    const start = eventsOf(handle.agent.session, SUBAGENT_START.type)[0]!.data as { childId: string }
    await handle.dispose()

    const resumed = await w.root.get(AGENTS).resume(w.root, asSessionId(start.childId))
    expect(resumed.agent.session.header).toMatchObject({ delegatedBy: handle.agent.id, delegationDepth: 1 })
    // The ceiling came back with the seed: the resumed child still cannot widen.
    expect(() => w.root.get(SANDBOX).setMode(resumed.agent.session, 'danger-full-access')).toThrowError(expect.objectContaining({ code: 'SANDBOX_CEILING' }))
    // And its own delegation would count from depth 1, not from zero.
    expect(w.root.get(TOOLS).get('subagent', resumed.agent)).toBeDefined()
    await resumed.dispose()
  })
})
