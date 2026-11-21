/**
 * Workspace instructions. The claims worth pinning: they reach the model as
 * DURABLE context (so a resume does not lose them and does not double them),
 * the nearest file wins when the budget is tight, and a repository can tell the
 * model how it likes its code without telling the harness what it may do.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as absolute } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { AGENT_PRE_STEP, AGENTS, agentPlugin, type Agent, type PreStepDecision } from '../../core/agent/index.ts'
import { agentInvariantPlugin } from '../../core/agent/invariant.ts'
import { approvalPlugin } from '../../core/approval/index.ts'
import { COMPACTION_APPLIED } from '../../core/compaction/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { invariantsPlugin } from '../../core/invariants/index.ts'
import { LLM, llmPlugin, type Message } from '../../core/llm/index.ts'
import { createUserMessage, messageText, restoreMessage } from '../../core/llm/message.ts'
import { loopInvariantPlugin, loopPlugin } from '../../core/loop/index.ts'
import { PROMPT, promptPlugin } from '../../core/prompt/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { authorityInvariantPlugin } from '../../core/sandbox/invariant.ts'
import { matches, sessionInvariantPlugin, sessionPlugin, USER_MESSAGE } from '../../core/session/index.ts'
import { defineTool, TOOLS, toolsPlugin } from '../../core/tools/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter, type ScriptedResponse } from '../../test-support/scripted-adapter.ts'
import { compactionBasicPlugin } from '../compaction-basic/index.ts'
import { fsLocalPlugin } from '../fs-local/index.ts'
import { skillsPlugin } from '../skills/index.ts'
import { collectInstructions, renderInstructions, workspaceInstructionsPlugin, type WorkspaceInstructionsConfig } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

const dirs: string[] = []
let root: Context | undefined
afterEach(async () => {
  await root?.dispose()
  root = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix = 'minidsh-instr-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * `around` mounts rows on either side of this one, in compose()'s order: what
 * it mounts is registered BEFORE the instructions row and so is the outer
 * pre-step layer, and what its returned function mounts comes after and is inner.
 */
async function mount(config: WorkspaceInstructionsConfig, around?: (owner: Context) => () => void): Promise<{ adapter: ScriptedAdapter; create(cwd: string): Promise<Agent> }> {
  root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, {})
  root.plugin(sessionPlugin)
  root.plugin(sessionInvariantPlugin)
  root.plugin(llmPlugin)
  root.plugin(toolsPlugin, {})
  root.plugin(promptPlugin)
  root.plugin(approvalPlugin)
  root.plugin(sandboxPlugin, {})
  root.plugin(authorityInvariantPlugin)
  root.plugin(fsLocalPlugin)
  root.plugin(agentPlugin)
  root.plugin(agentInvariantPlugin)
  root.plugin(loopPlugin)
  root.plugin(loopInvariantPlugin)
  const inner = around?.(root)
  root.plugin(workspaceInstructionsPlugin, config)
  inner?.()
  await root.settle()
  const adapter = new ScriptedAdapter()
  root.get(LLM).registerAdapter(root, adapter)
  root.get(PROMPT).section(root, { name: 'persona', order: 0, text: 'You are a test agent.' })
  const owner = root
  return {
    adapter,
    async create(cwd: string) {
      const handle = await owner.get(AGENTS).create(owner, { cwd, agentOptions: { provider: 'scripted', model: 'scripted-model' } })
      return handle.agent
    },
  }
}

function entered(agent: Agent): string[] {
  return agent.session.events
    .filter((event) => matches(event, USER_MESSAGE))
    .map((event) => restoreMessage(event.data.message))
    .filter((message) => message.source.kind === 'plugin' && message.source.form === 'workspace-instructions')
    .map((message) => messageText(message))
}

/** A workspace with a git marker, so the root walk stops where a project would. */
function workspaceWithRoot(): string {
  const dir = tempDir()
  mkdirSync(join(dir, '.git'))
  return dir
}

describe('discovery', () => {
  it('reads the global file, then each directory from the project root down to the cwd', async () => {
    const workspace = workspaceWithRoot()
    const home = tempDir('minidsh-home-')
    const nested = join(workspace, 'packages', 'api')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(home, 'AGENTS.md'), 'global rule', 'utf8')
    writeFileSync(join(workspace, 'AGENTS.md'), 'project rule', 'utf8')
    writeFileSync(join(nested, 'AGENTS.md'), 'api rule', 'utf8')

    const mounted = await mount({ maxBytes: 32_000, globalPath: join(home, 'AGENTS.md') })
    const fs = root!.get(FS)
    const sources = await collectInstructions(fs, nested, { maxBytes: 32_000, globalPath: join(home, 'AGENTS.md') })
    expect(sources.map((source) => source.text)).toEqual(['global rule', 'project rule', 'api rule'])
    void mounted
  })

  it('renders a duplicate sibling once', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'the same words', 'utf8')
    writeFileSync(join(workspace, 'CLAUDE.md'), '  the same words  ', 'utf8')
    await mount({ maxBytes: 32_000 })
    const sources = await collectInstructions(root!.get(FS), workspace, { maxBytes: 32_000 })
    expect(sources).toHaveLength(1)
    expect(sources[0]!.path).toContain('AGENTS.md')
  })

  it('stops at the cwd when no project root marker is found', async () => {
    const parent = tempDir()
    const child = join(parent, 'child')
    mkdirSync(child)
    writeFileSync(join(parent, 'AGENTS.md'), 'parent rule', 'utf8')
    writeFileSync(join(child, 'AGENTS.md'), 'child rule', 'utf8')
    await mount({ maxBytes: 32_000 })
    const sources = await collectInstructions(root!.get(FS), child, { maxBytes: 32_000 })
    expect(sources.map((source) => source.text)).toEqual(['child rule'])
  })

  // The S20.5 audit: a `.git` another user planted in a shared /tmp made the
  // AGENTS.md beside it enter every session below — that user's instructions,
  // read as this user's repository rules.
  it('trusts no project root above the cwd that another user owns', async () => {
    const parent = tempDir()
    const child = join(parent, 'child')
    mkdirSync(child)
    mkdirSync(join(parent, '.git'))
    writeFileSync(join(parent, 'AGENTS.md'), 'a stranger\'s rule', 'utf8')
    writeFileSync(join(child, 'AGENTS.md'), 'child rule', 'utf8')
    await mount({ maxBytes: 32_000 })
    const real = root!.get(FS)
    const marker = real.resolve(join(parent, '.git'), parent).path
    const strangers: typeof real = {
      resolve: (path, cwd) => real.resolve(path, cwd),
      stat: async (target) => {
        const info = await real.stat(target)
        return info !== undefined && target.path === marker ? { ...info, ownedByMe: false } : info
      },
      readText: (target, actor, options) => real.readText(target, actor, options),
      readBytes: (target, actor, options) => real.readBytes(target, actor, options),
      writeText: (target, text, intent, actor) => real.writeText(target, text, intent, actor),
      listDir: (target) => real.listDir(target),
    }
    expect((await collectInstructions(strangers, child, { maxBytes: 32_000 })).map((source) => source.text)).toEqual(['child rule'])
    expect((await collectInstructions(real, child, { maxBytes: 32_000 })).map((source) => source.text)).toEqual(['a stranger\'s rule', 'child rule'])
  })

  // The S20.5 review: the marker was judged through its links, so a `.git`
  // planted as a link into the victim's own home passed. The directory that
  // holds it must be this user's as well, and the operator is told.
  it('trusts no marker whose directory another user owns, and says so', async () => {
    const parent = tempDir()
    const child = join(parent, 'child')
    mkdirSync(child)
    mkdirSync(join(parent, '.git'))
    writeFileSync(join(parent, 'AGENTS.md'), 'a stranger\'s rule', 'utf8')
    writeFileSync(join(child, 'AGENTS.md'), 'child rule', 'utf8')
    await mount({ maxBytes: 32_000 })
    const real = root!.get(FS)
    const holder = real.resolve(parent, parent).path
    const strangers: typeof real = {
      resolve: (path, cwd) => real.resolve(path, cwd),
      stat: async (target) => {
        const info = await real.stat(target)
        return info !== undefined && target.path === holder ? { ...info, ownedByMe: false } : info
      },
      readText: (target, actor, options) => real.readText(target, actor, options),
      readBytes: (target, actor, options) => real.readBytes(target, actor, options),
      writeText: (target, text, intent, actor) => real.writeText(target, text, intent, actor),
      listDir: (target) => real.listDir(target),
    }
    const warned: string[] = []
    expect((await collectInstructions(strangers, child, { maxBytes: 32_000 }, (message) => warned.push(message))).map((source) => source.text)).toEqual(['child rule'])
    expect(warned).toEqual([expect.stringContaining('is not this user\'s project marker')])
  })

  // Windows reports no owner at all, so there this rule alone keeps a
  // `C:\.git` beside a `C:\AGENTS.md`, which any local user may create, out of
  // every session started below them. Staged, because no test may write to a
  // real filesystem root.
  it('trusts no marker in a filesystem root, and says so', async () => {
    /** Directories and files that exist; nothing reports an owner, as on win32. */
    const staged = (folders: readonly string[], files: Readonly<Record<string, string>>): Fs => ({
      resolve: (path, cwd) => ({ path: absolute(cwd, path), displayPath: path }),
      stat: async (target) => {
        const text = files[target.path]
        if (text !== undefined) return { type: 'file', version: '1', size: Buffer.byteLength(text, 'utf8') }
        return folders.includes(target.path) ? { type: 'directory', version: '1', size: 0 } : undefined
      },
      readText: async (target) => ({ text: files[target.path]!, version: '1', complete: true }),
      readBytes: async () => Promise.reject(new Error('not used')),
      writeText: async () => Promise.reject(new Error('not used')),
      listDir: async () => Promise.reject(new Error('not used')),
    })
    const top = absolute('/')
    const cwd = join(top, 'work')
    const planted = staged([top, cwd, join(top, '.git')], { [join(top, 'AGENTS.md')]: 'a stranger\'s rule', [join(cwd, 'AGENTS.md')]: 'child rule' })
    const warned: string[] = []
    expect((await collectInstructions(planted, cwd, { maxBytes: 32_000 }, (message) => warned.push(message))).map((source) => source.text)).toEqual(['child rule'])
    expect(warned).toEqual([expect.stringContaining('filesystem root')])
    // The control: the same layout one directory down is an ordinary project
    // root, so it was the root, not the staging, that refused the one above.
    const project = join(top, 'project')
    const inner = join(project, 'work')
    const ordinary = staged([top, project, inner, join(project, '.git')], { [join(project, 'AGENTS.md')]: 'project rule', [join(inner, 'AGENTS.md')]: 'child rule' })
    expect((await collectInstructions(ordinary, inner, { maxBytes: 32_000 }, (message) => warned.push(message))).map((source) => source.text)).toEqual(['project rule', 'child rule'])
    expect(warned).toHaveLength(1)
  })
})

describe('the budget', () => {
  it('drops broad files whole before truncating the nearest one', () => {
    const broad = { path: '/w/AGENTS.md', text: 'B'.repeat(500) }
    const near = { path: '/w/pkg/AGENTS.md', text: 'N'.repeat(500) }
    const rendered = renderInstructions([broad, near], 900)!
    expect(rendered).toContain('N'.repeat(400))
    expect(rendered).not.toContain('B'.repeat(400))
  })

  it('truncates the nearest file rather than dropping it, and says so', () => {
    const near = { path: '/w/pkg/AGENTS.md', text: 'N'.repeat(5000) }
    const rendered = renderInstructions([near], 800)!
    expect(rendered).toContain('truncated to fit')
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(800)
  })

  // The cut is by bytes, and a byte cut inside a character decodes as U+FFFD:
  // three bytes where one or two were counted, so the batch ended in a
  // replacement character and could pass its own cap. ASCII never showed it.
  it('truncates on a character, never inside one, at every budget and width of character', () => {
    const over: string[] = []
    for (const char of ['é', '中', '😀']) {
      for (let maxBytes = 800; maxBytes < 808; maxBytes++) {
        const rendered = renderInstructions([{ path: '/w/pkg/AGENTS.md', text: char.repeat(5000) }], maxBytes)!
        const body = rendered.slice(rendered.indexOf('--- /w/pkg/AGENTS.md ---\n') + '--- /w/pkg/AGENTS.md ---\n'.length, rendered.indexOf('\n[truncated to fit'))
        const bytes = Buffer.byteLength(rendered, 'utf8')
        // Whole characters only, as many as fit: within the cap, and less than one more character short of it.
        if (bytes > maxBytes || maxBytes - bytes >= Buffer.byteLength(char, 'utf8') || body !== char.repeat([...body].length) || body.length === 0) {
          over.push(`${char} at ${maxBytes}: ${bytes} bytes, body ends ${JSON.stringify(body.slice(-4))}`)
        }
      }
    }
    expect(over).toEqual([])
  })

  it('renders nothing at all rather than a header with no content', () => {
    expect(renderInstructions([{ path: '/w/AGENTS.md', text: 'x' }], 10)).toBeUndefined()
    expect(renderInstructions([], 32_000)).toBeUndefined()
  })
})

describe('entering the conversation', () => {
  it('enters once, as a durable message, alongside the first real prompt', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'always end with DONE', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    mounted.adapter.script(assistantText('first'), assistantText('second'))

    agent.followup(createUserMessage('do the thing'))
    await agent.whenIdle()
    agent.followup(createUserMessage('and again'))
    await agent.whenIdle()

    const found = entered(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('always end with DONE')
    expect(found[0]).toContain('<system-reminder>')
    // It reached the model in the same request as the prompt it joined.
    const first = mounted.adapter.calls[0]!
    expect(first.messages).toHaveLength(2)
    expect(messageText(first.messages[0]!)).toBe('do the thing')
    expect(messageText(first.messages[1]!)).toContain('always end with DONE')
  })

  it('does not enter again on a resumed session, because the log already has it', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'house style', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    mounted.adapter.script(assistantText('one'))
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    const seed = agent.session.events.map((event) => ({ ...event }))

    // A second lifecycle over the same log: the instructions are already in it.
    const resumed = await root!.get(AGENTS).create(root!, {
      cwd: workspace,
      seed,
      origin: 'resumed',
      agentOptions: { provider: 'scripted', model: 'scripted-model' },
    })
    mounted.adapter.script(assistantText('two'))
    resumed.agent.followup(createUserMessage('carry on'))
    await resumed.agent.whenIdle()
    expect(entered(resumed.agent)).toHaveLength(1)
    await resumed.dispose()
  })

  /**
   * The guard folds the LIVE surface, not the log. Shadowed events stay in the
   * log forever, so a log-based guard would keep the house rules suppressed at
   * exactly the moment a session got long enough to forget them.
   */
  it('re-enters the instructions when a compaction has shadowed them', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'house style', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    mounted.adapter.script(assistantText('one'), assistantText('two'))
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    expect(entered(agent)).toHaveLength(1)

    // A compaction shadows everything so far, including the instructions.
    const nodes = agent.session.surfaceSeqs()
    agent.session.append(
      USER_MESSAGE,
      { message: createUserMessage('summary of the work so far') },
      { surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: [...nodes] },
    )

    agent.followup(createUserMessage('carry on'))
    await agent.whenIdle()
    // Entered twice in the log; exactly one copy is live, which is what the
    // model actually sees.
    expect(entered(agent)).toHaveLength(2)
    const live = new Set(agent.session.surfaceSeqs())
    const liveInstructions = agent.session.events.filter(
      (event) => live.has(event.seq) && matches(event, USER_MESSAGE) && restoreMessage(event.data.message).source.kind === 'plugin',
    )
    expect(liveInstructions).toHaveLength(1)
  })

  /**
   * `fs.resolve` throws BY DESIGN on a path whose identity the host will not
   * disclose. A throw out of `agent/pre-step` reaches the driver AFTER the
   * claim was committed, so the prompt would be durably consumed and never
   * entered — and because the condition is a property of the cwd, every later
   * prompt would die the same way. The session would be bricked.
   */
  it('degrades to no instructions when the filesystem refuses to name a path', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'house style', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    // Exactly what `canonicalPath` does on a symlink cycle or a dead mount.
    const fs = root!.get(FS)
    const resolve = fs.resolve.bind(fs)
    fs.resolve = () => {
      throw new Error('too many symbolic links while resolving')
    }
    mounted.adapter.script(assistantText('answered anyway'))
    agent.followup(createUserMessage('do the thing'))
    await agent.whenIdle()
    fs.resolve = resolve

    const ends = agent.session.events.filter((event) => event.type === 'turn/end')
    expect((ends.at(-1)!.data as { reason: { kind: string } }).reason.kind).toBe('completed')
    // The prompt was entered, not eaten.
    expect(messageText(agent.session.deriveMessages()[0]!)).toBe('do the thing')
    expect(entered(agent)).toHaveLength(0)
  })

  it('refuses to mount without a usable byte budget, instead of entering nothing', async () => {
    // `applyPatches` replaces a row's WHOLE config, so a disk patch meaning to
    // set `globalPath` can drop `maxBytes`. That used to produce NaN arithmetic
    // and an EMPTY instructions message that suppressed the real ones forever.
    expect(renderInstructions([{ path: '/w/AGENTS.md', text: 'rules' }], undefined as unknown as number)).toBeUndefined()
    root = createRoot({ logger: silent })
    // `settled()` is what `Composition.insert` awaits, so this is exactly how a
    // bad disk row fails: loudly, at mount, rather than quietly at every step.
    const handle = root.plugin(workspaceInstructionsPlugin, {} as WorkspaceInstructionsConfig)
    const failure = await handle.settled().then(
      () => undefined,
      (error: unknown) => error as Error & { cause?: unknown },
    )
    expect(failure?.message).toContain('workspace-instructions')
    expect(String(failure?.cause ?? '')).toContain('maxBytes')
  })

  /**
   * One prompt, a long tool loop, and a pressure compaction at a step boundary
   * inside it: compose()'s own row order, skills outermost, compaction
   * innermost. Every step after a turn's first has an empty batch, and both
   * listeners used to leave EVERY empty batch alone, so the house rules and
   * the skill list were gone from that step to the end of the turn, which in a
   * one-prompt headless run is the end of the run.
   */
  it('re-enters the instructions and the skill list at the step whose compaction shadowed them, inside one turn', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'always end with DONE', 'utf8')
    const skills = tempDir('minidsh-instr-skills-')
    mkdirSync(join(skills, 'alpha'))
    writeFileSync(join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Use for alpha work.\n---\nDo the thing carefully.\n', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 }, (owner) => {
      owner.plugin(skillsPlugin, { maxBytes: 8_000, roots: [{ path: realpathSync.native(skills), origin: 'user' }] })
      return () => owner.plugin(compactionBasicPlugin, { budgetTokens: 3_000, retainRatio: 0.2, thresholdRatio: 0.5 })
    })
    root!.get(TOOLS).register(
      root!,
      defineTool({ name: 'echo', description: 'Echo text back.', input: z.object({ text: z.string() }), output: z.object({ text: z.string() }), render: (_args, value) => [{ type: 'text', text: value.text }], execute: (args: { text: string }) => ({ text: args.text }) }),
    )
    const agent = await mounted.create(workspace)
    // Ten tool steps and an answer. The reported prompt is the request's own
    // size, so pressure rises with the loop and falls when a compaction lands.
    let steps = 0
    const respond: ScriptedResponse = (request) => {
      if (request.purpose === 'compaction') return assistantText('## Primary Request\n- keep echoing')
      steps += 1
      const usage = { inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4), outputTokens: 6 }
      return steps <= 10 ? assistantToolCall(`c${steps}`, 'echo', { text: `${steps} ${'y'.repeat(600)}` }, usage) : assistantText('all echoed', usage)
    }
    mounted.adapter.script(...Array.from({ length: 30 }, () => respond))
    agent.followup(createUserMessage('echo ten times'))
    await agent.whenIdle()

    // One turn, completed, with at least one pressure compaction strictly inside it.
    const kinds = (type: string) => agent.session.events.filter((event) => event.type === type)
    expect(kinds('turn/end').map((event) => (event.data as { reason: { kind: string } }).reason.kind)).toEqual(['completed'])
    const applied = kinds(COMPACTION_APPLIED.type)
    const stepStarts = kinds('step/start').map((event) => event.seq)
    expect(applied.map((event) => (event.data as { trigger: string }).trigger).slice(0, 1)).toEqual(['pressure'])
    expect([stepStarts[0]! < applied[0]!.seq, applied[0]!.seq < stepStarts.at(-1)!]).toEqual([true, true])

    // What each loop request showed the model: how many instruction messages, how many skill lists.
    const shown = mounted.adapter.calls
      .filter((call) => call.purpose === undefined)
      .map((call) => {
        const forms = call.messages.flatMap((message) => (message.source.kind === 'plugin' ? [`${message.source.plugin}/${message.source.form}`] : []))
        return `${forms.filter((form) => form === 'workspace-instructions/workspace-instructions').length} instructions, ${forms.filter((form) => form === 'skills/list').length} list`
      })
    expect(shown).toHaveLength(11)
    expect(shown).toEqual(shown.map(() => '1 instructions, 1 list'))
    // And they came back INSIDE the turn: entered again in the log, with one prompt only.
    expect(entered(agent).length, `instruction messages in the log: ${entered(agent).length}`).toBeGreaterThanOrEqual(2)
    // After the tool results of the step before, in the order a prompt's batch has: AGENTS.md, then the list.
    const reentry = agent.session.events.filter((event) => event.seq > applied[0]!.seq && matches(event, USER_MESSAGE) && event.surfaceOp?.op === 'append').slice(0, 2)
    expect(reentry.map((event) => (matches(event, USER_MESSAGE) && event.data.message.source.kind === 'plugin' ? event.data.message.source.plugin : 'other'))).toEqual(['workspace-instructions', 'skills'])
  })

  /**
   * Straight at the seam, as the skills twin is: the driver ends a turn as a
   * natural stop when its FIRST step enters nothing, so that empty batch must
   * stay empty. (The earlier version of this test sent a quiet message and
   * cancelled: no turn ever started, the listener never ran, and the status it
   * asserted had never been anything else.) The second call is the control
   * that proves the guard, not a missing file, kept the first batch empty.
   *
   * Then the two empty batches a listener can meet, each in the state where
   * only its own rule decides: a LATER step of a session that never had
   * instructions is every tool-loop step of one and is not filled; and once
   * instructions were entered and a compaction shadowed them, the first step
   * is still left alone while a later one gets them back.
   */
  it('never revives a turn that had nothing to say', async () => {
    const workspace = workspaceWithRoot()
    writeFileSync(join(workspace, 'AGENTS.md'), 'house style', 'utf8')
    const mounted = await mount({ maxBytes: 32_000 })
    const agent = await mounted.create(workspace)
    const signal = new AbortController().signal
    const ask = async (messages: Message[], step: number): Promise<string[]> => {
      const decision = await root!.waterfall(AGENT_PRE_STEP, { agent, messages, turn: 1, step, signal }, async () => ({ kind: 'enter', messages }) as PreStepDecision)
      return decision.kind === 'enter' ? decision.messages.map((message) => (message.source.kind === 'plugin' ? `plugin:${message.source.form}` : messageText(message))) : [decision.kind]
    }
    expect(await ask([], 1)).toEqual([])
    expect(await ask([createUserMessage('hello')], 1)).toEqual(['hello', 'plugin:workspace-instructions'])
    expect(await ask([], 2)).toEqual([])

    // Entered for real, then shadowed, as a compaction leaves them.
    mounted.adapter.script(assistantText('one'))
    agent.followup(createUserMessage('go'))
    await agent.whenIdle()
    expect(entered(agent)).toHaveLength(1)
    const nodes = agent.session.surfaceSeqs()
    agent.session.append(USER_MESSAGE, { message: createUserMessage('summary of the work so far') }, { surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: [...nodes] })
    expect(await ask([], 1)).toEqual([])
    expect(await ask([], 2)).toEqual(['plugin:workspace-instructions'])
  })

  it('is a no-op with no filesystem provider, instead of failing the turn', async () => {
    root = createRoot({ logger: silent })
    root.plugin(invariantsPlugin, {})
    root.plugin(sessionPlugin)
    root.plugin(llmPlugin)
    root.plugin(toolsPlugin, {})
    root.plugin(promptPlugin)
    root.plugin(approvalPlugin)
    root.plugin(sandboxPlugin, {})
    root.plugin(agentPlugin)
    root.plugin(loopPlugin)
    root.plugin(workspaceInstructionsPlugin, { maxBytes: 32_000 })
    await root.settle()
    const adapter = new ScriptedAdapter().script(assistantText('fine'))
    root.get(LLM).registerAdapter(root, adapter)
    root.get(PROMPT).section(root, { name: 'persona', order: 0, text: 'persona' })
    const handle = await root.get(AGENTS).create(root, { cwd: process.cwd(), agentOptions: { provider: 'scripted', model: 'scripted-model' } })
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()
    expect(messageText(handle.agent.session.deriveMessages().at(-1)!)).toBe('fine')
    expect(entered(handle.agent)).toHaveLength(0)
    await handle.dispose()
  })
})
