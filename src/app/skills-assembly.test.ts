/**
 * Skills in app assembly: the row, the deployment's roots filled AFTER
 * layering, the order that puts the list after AGENTS.md, a delegated child's
 * list, and `minidsh skills` — against the full composition and the real CLI.
 *
 * Nothing here names a bundled skill: the package's `skills/` is data another
 * file tests (`bundled-skills.test.ts`), and the runtime must not depend on
 * what it holds. Every listed skill below is a fixture in a temp root.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, Logger } from '../kernel/index.ts'
import { AGENTS, SUBAGENT_START } from '../core/agent/index.ts'
import { LLM } from '../core/llm/index.ts'
import { createUserMessage, messageText } from '../core/llm/message.ts'
import { canonicalPath } from '../core/sandbox/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { renderSkillList, skillsPlugin, type SkillDiscovery } from '../capabilities/skills/index.ts'
import { assistantText, assistantToolCall, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { main } from './cli.ts'
import { builtinPlugins, compose, defaultDialect, fillSkillRoots, type Row } from './compose.ts'
import { applyLayers, withSkillRoots } from './config.ts'
import { bootComposition, forkTask, resumeTask, runTask } from './headless.ts'
import { homeLayout, skillRootsFor } from './home.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

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
  return realpathSync.native(dir)
}

function writeSkill(rootDir: string, dir: string, description: string): string {
  mkdirSync(join(rootDir, dir), { recursive: true })
  writeFileSync(join(rootDir, dir, 'SKILL.md'), `---\nname: ${dir}\ndescription: ${description}\n---\nBody.\n`, 'utf8')
  return realpathSync.native(join(rootDir, dir, 'SKILL.md'))
}

/** A git-marked workspace, so its skill dirs are found and nothing above it is read. */
function workspace(): string {
  const dir = tempDir('minidsh-skills-app-ws-')
  mkdirSync(join(dir, '.git'))
  return dir
}

function skillsRow(rows: readonly Row[]): Row {
  return rows.find((row) => row.id === 'skills')!
}

function base(): Row[] {
  return compose({ sessionsRoot: 'unused', dialect: defaultDialect() })
}

const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

function storedEvents(sessionsRoot: string, id: string): EventEnvelope[] {
  return readFileSync(join(sessionsRoot, `${encodeURIComponent(id)}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

/** The skill-list texts in a stored log, live or not. */
function storedLists(events: readonly EventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'user/message')
    .map((event) => (event.data as { message: { source: { kind: string; plugin?: string; form?: string }; content: { type: string; text?: string }[] } }).message)
    .filter((message) => message.source.kind === 'plugin' && message.source.plugin === 'skills' && message.source.form === 'list')
    .map((message) => message.content.map((block) => block.text ?? '').join(''))
}

describe('the row', () => {
  it('ships a skills row with a budget and no roots, outside workspace-instructions and compaction', () => {
    const rows = base()
    const row = skillsRow(rows)
    expect(row.plugin).toBe(skillsPlugin)
    expect(row.config).toEqual({ maxBytes: 8_000 })
    const at = (id: string): number => rows.findIndex((entry) => entry.id === id)
    // Registered first is the OUTER pre-step layer: its check runs after the inner ones.
    expect(at('skills')).toBeLessThan(at('workspace-instructions'))
    expect(at('workspace-instructions')).toBeLessThan(at('compaction'))
    expect(builtinPlugins.get('skills')).toBe(skillsPlugin)
  })

  it('names the home and the package as the deployment roots, the same path from src/ and dist/', () => {
    const home = tempDir('minidsh-skills-home-')
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
    // Canonical: the host's own spelling (macOS /var is /private/var), so the
    // recorded composition does not change with how the binary was launched.
    expect(skillRootsFor(home)).toEqual([
      { path: join(realpathSync.native(home), 'skills'), origin: 'user' },
      { path: realpathSync.native(resolve(packageRoot, 'skills')), origin: 'bundled' },
    ])
    const previous = process.env.MINIDSH_HOME
    process.env.MINIDSH_HOME = home
    try {
      expect(homeLayout().skillRoots).toEqual(skillRootsFor(home))
    } finally {
      if (previous === undefined) delete process.env.MINIDSH_HOME
      else process.env.MINIDSH_HOME = previous
    }
  })

  /**
   * `MINIDSH_HOME=../home` is how check.yml's tarball step runs the installed
   * binary. `join` kept the home relative, the row refuses a relative root, and
   * every boot failed: `config`, `run`, `serve`, `skills` (review, S19).
   */
  it('makes a relative home absolute, because the skills row refuses a relative root', () => {
    const relativeRoots = skillRootsFor(join('..', 'a-relative-home'))
    for (const root of relativeRoots) expect(isAbsolute(root.path), root.path).toBe(true)
    expect(relativeRoots[0]!.path.endsWith(join('a-relative-home', 'skills'))).toBe(true)
    expect(() => skillsPlugin.config!.parse({ maxBytes: 8_000, roots: relativeRoots })).not.toThrow()
  })
})

describe('roots filled after layering', () => {
  const deployment = [
    { path: resolve('/deploy/home/skills'), origin: 'user' as const },
    { path: resolve('/deploy/package/skills'), origin: 'bundled' as const },
  ]

  it('keeps the deployment roots under a patch that only meant to exclude one skill', () => {
    const layered = applyLayers(base(), [{ name: 'home', patches: [{ id: 'skills', config: { maxBytes: 8_000, exclude: ['office'] } }] }], () => {})
    const filled = withSkillRoots(layered, deployment)
    expect(skillsRow(filled.rows).config).toEqual({ maxBytes: 8_000, exclude: ['office'], roots: deployment })
    // Filling a default is not a layer's change.
    expect(filled.provenance.get('skills')).toBe('home')
    // The record names the roots a session was offered from.
    expect(filled.descriptor.hash).not.toBe(layered.descriptor.hash)
    expect(filled.descriptor.layers).toEqual(['built-in', 'home'])
  })

  it('keeps an explicit roots value, [] included, and leaves every other row alone', () => {
    const none = applyLayers(base(), [{ name: 'patch', patches: [{ id: 'skills', config: { maxBytes: 8_000, roots: [] } }] }], () => {})
    expect(skillsRow(withSkillRoots(none, deployment).rows).config).toEqual({ maxBytes: 8_000, roots: [] })
    const rows = base()
    const filled = fillSkillRoots(rows, deployment)
    for (const [i, row] of rows.entries()) if (row.id !== 'skills') expect(filled[i]).toBe(row)
    // Matched by capability: a layer may insert the plugin under its own id.
    const inserted = fillSkillRoots([{ id: 'my-skills', plugin: skillsPlugin, config: { maxBytes: 100 } }], deployment)
    expect(inserted[0]!.config).toEqual({ maxBytes: 100, roots: deployment })
    // Omitted roots (a hermetic boot) leave the composition exactly as layered.
    const layered = applyLayers(base(), [], () => {})
    expect(withSkillRoots(layered, undefined)).toBe(layered)
  })
})

describe('through the full composition', () => {
  it('reaches the model after the prompt and after AGENTS.md, in the first batch', async () => {
    const cwd = workspace()
    const user = tempDir('minidsh-skills-user-')
    const path = writeSkill(user, 'fixture-alpha', 'Use for alpha fixtures.')
    writeFileSync(join(cwd, 'AGENTS.md'), 'house rule: be brief', 'utf8')
    const adapter = new ScriptedAdapter().script(assistantText('done'))
    const result = await runTask({
      task: 'do the thing',
      cwd,
      model: 'scripted-model',
      provider: 'scripted',
      sessionsRoot: tempDir('minidsh-skills-sessions-'),
      confinement: 'none',
      skillRoots: [{ path: user, origin: 'user' }],
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root) => void root.get(LLM).registerAdapter(root, adapter),
    })
    expect(result.exitCode).toBe(0)
    const texts = adapter.calls[0]!.messages.map((message) => messageText(message))
    expect(texts).toHaveLength(3)
    expect(texts[0]).toBe('do the thing')
    expect(texts[1]).toContain('house rule: be brief')
    expect(texts[2]).toContain(`- fixture-alpha: Use for alpha fixtures. (user: ${path})`)
  })

  it('honours an exclude-only disk layer without losing the roots it did not name', async () => {
    const cwd = workspace()
    const user = tempDir('minidsh-skills-user-')
    writeSkill(user, 'fixture-alpha', 'Use for alpha fixtures.')
    writeSkill(user, 'fixture-beta', 'Use for beta fixtures.')
    const adapter = new ScriptedAdapter().script(assistantText('done'))
    await runTask({
      task: 'go',
      cwd,
      model: 'scripted-model',
      provider: 'scripted',
      sessionsRoot: tempDir('minidsh-skills-sessions-'),
      confinement: 'none',
      skillRoots: [{ path: user, origin: 'user' }],
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      configLayers: [{ name: 'home', patches: [{ id: 'skills', config: { maxBytes: 8_000, exclude: ['fixture-beta'] } }] }],
      prepare: (root) => void root.get(LLM).registerAdapter(root, adapter),
    })
    const list = messageText(adapter.calls[0]!.messages.at(-1)!)
    expect(list).toContain('- fixture-alpha:')
    expect(list).not.toContain('fixture-beta')
  })

  it('gives a delegated child the list too: the root listener hears every agent', async () => {
    const cwd = workspace()
    const user = tempDir('minidsh-skills-user-')
    writeSkill(user, 'fixture-alpha', 'Use for alpha fixtures.')
    const sessionsRoot = tempDir('minidsh-skills-sessions-')
    const adapter = new ScriptedAdapter().script(
      assistantToolCall('call-1', 'subagent', { description: 'a bounded task', prompt: 'Find it.' }),
      assistantText('found'),
      assistantText('done'),
    )
    const root = await bootComposition({
      sessionsRoot,
      confinement: 'none',
      skillRoots: [{ path: user, origin: 'user' }],
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (context) => void context.get(LLM).registerAdapter(context, adapter),
    })
    roots.push(root)
    const handle = await root.get(AGENTS).create(root, { cwd, agentOptions: SCRIPTED })
    handle.agent.followup(createUserMessage('delegate this'))
    await handle.agent.whenIdle()
    const start = handle.agent.session.events.find((event) => event.type === SUBAGENT_START.type)
    expect(start, 'the scripted delegation did not run').toBeDefined()
    const child = storedEvents(sessionsRoot, (start!.data as { childId: string }).childId)
    expect(storedLists(child)).toEqual([expect.stringContaining('- fixture-alpha:')])
    // The child's first request carried its prompt and the list, together.
    expect(adapter.calls[1]!.messages.map((message) => messageText(message))).toEqual(['Find it.', storedLists(child)[0]])
    await handle.dispose()
  })

  it('appends nothing to a resumed or a forked session whose skills did not change', async () => {
    const cwd = workspace()
    const user = tempDir('minidsh-skills-user-')
    writeSkill(user, 'fixture-alpha', 'Use for alpha fixtures.')
    const sessionsRoot = tempDir('minidsh-skills-sessions-')
    const adapter = new ScriptedAdapter().script(assistantText('one'), assistantText('two'), assistantText('three'))
    const boot = {
      sessionsRoot,
      confinement: 'none' as const,
      skillRoots: [{ path: user, origin: 'user' as const }],
      logger: silent,
      patches: [{ id: 'llm-deepseek', disabled: true }],
      prepare: (root: Context) => void root.get(LLM).registerAdapter(root, adapter),
    }
    const first = await runTask({ ...boot, task: 'start', cwd, model: 'scripted-model', provider: 'scripted' })
    const resumed = await resumeTask({ ...boot, id: first.sessionId, task: 'carry on' })
    expect(resumed.exitCode).toBe(0)
    expect(storedLists(storedEvents(sessionsRoot, first.sessionId))).toHaveLength(1)
    const forked = await forkTask({ ...boot, id: first.sessionId, task: 'branch' })
    expect(forked.exitCode).toBe(0)
    expect(storedLists(storedEvents(sessionsRoot, forked.sessionId))).toHaveLength(1)
  })
})

// ---- `minidsh skills` -----------------------------------------------------------

interface CliRun {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function cli(home: string, argv: readonly string[]): Promise<CliRun> {
  const previous = process.env.MINIDSH_HOME
  process.env.MINIDSH_HOME = home
  const out: string[] = []
  const err: string[] = []
  const writeOut = process.stdout.write.bind(process.stdout)
  const writeErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write
  try {
    const code = await main(argv)
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = writeOut
    process.stderr.write = writeErr
    if (previous === undefined) delete process.env.MINIDSH_HOME
    else process.env.MINIDSH_HOME = previous
  }
}

/** A home with one user skill, and a workspace that shadows it and adds one of its own. */
function fixture(): { home: string; cwd: string; userSkill: string; repoShadow: string; repoSkill: string } {
  const home = tempDir('minidsh-skills-cli-home-')
  const cwd = workspace()
  const userSkill = writeSkill(join(home, 'skills'), 'fixture-alpha', 'Use for alpha fixtures.')
  const repoShadow = writeSkill(join(cwd, '.agents', 'skills'), 'fixture-alpha', 'A repository claims alpha.')
  const repoSkill = writeSkill(join(cwd, '.claude', 'skills'), 'fixture-repo', 'Use for this repository.')
  return { home, cwd, userSkill, repoShadow, repoSkill }
}

function patchFile(patches: unknown[]): string {
  const path = join(tempDir('minidsh-skills-patch-'), 'patch.json')
  writeFileSync(path, JSON.stringify({ patches }), 'utf8')
  return path
}

describe('minidsh skills', () => {
  it('prints what a session in the cwd is offered, what was not listed and why, and the roots', async () => {
    const { home, cwd, userSkill, repoShadow, repoSkill } = fixture()
    const json = await cli(home, ['skills', '--json', '--cwd', cwd])
    expect(json.code, json.err).toBe(0)
    const found = JSON.parse(json.out) as SkillDiscovery
    expect(found.complete).toBe(true)
    const mine = found.listed.filter((skill) => skill.name.startsWith('fixture-'))
    expect(mine).toEqual([
      { name: 'fixture-alpha', description: 'Use for alpha fixtures.', path: userSkill, origin: 'user' },
      { name: 'fixture-repo', description: 'Use for this repository.', path: repoSkill, origin: 'workspace' },
    ])
    expect(found.skipped).toContainEqual({ path: repoShadow, reason: `name "fixture-alpha" held by user skill ${userSkill}` })
    // The deployment's roots, filled from the home, in precedence order.
    const [user, bundled] = skillRootsFor(home)
    expect(found.roots.slice(0, 2)).toEqual([
      { path: canonicalPath(user!.path), origin: 'user', present: true },
      expect.objectContaining({ path: canonicalPath(bundled!.path), origin: 'bundled' }),
    ])

    const human = await cli(home, ['skills', '--cwd', cwd])
    expect(human.code, human.err).toBe(0)
    expect(human.out).toContain(`skills offered to a session in ${cwd}:`)
    expect(human.out).toMatch(/fixture-alpha\s+user\s+/)
    expect(human.out).toContain('not listed:')
    expect(human.out).toContain(repoShadow)
    expect(human.out).toContain('roots, in precedence order:')
  })

  it('reads the effective row: an exclude-only patch keeps the home root, and an explicit [] drops it', async () => {
    const { home, cwd, userSkill, repoShadow } = fixture()
    const exclude = await cli(home, ['skills', '--json', '--cwd', cwd, '--patch', patchFile([{ id: 'skills', config: { maxBytes: 8_000, exclude: ['fixture-repo'] } }])])
    expect(exclude.code, exclude.err).toBe(0)
    const excluded = JSON.parse(exclude.out) as SkillDiscovery
    expect(excluded.listed.find((skill) => skill.name === 'fixture-alpha')?.path).toBe(userSkill)
    expect(excluded.listed.some((skill) => skill.name === 'fixture-repo')).toBe(false)
    expect(excluded.skipped.some((skip) => skip.reason === '"fixture-repo" is excluded by the skills row')).toBe(true)

    const none = await cli(home, ['skills', '--json', '--cwd', cwd, '--patch', patchFile([{ id: 'skills', config: { maxBytes: 8_000, roots: [] } }])])
    const workspaceOnly = JSON.parse(none.out) as SkillDiscovery
    expect(workspaceOnly.roots.every((root) => root.origin === 'workspace')).toBe(true)
    // With no user root, the repository's own alpha is no longer shadowed.
    expect(workspaceOnly.listed.find((skill) => skill.name === 'fixture-alpha')?.path).toBe(repoShadow)
  })

  it('calls offered only what fits the row\'s byte budget, and reports the dropped tail', async () => {
    const { home, cwd } = fixture()
    const roomy = JSON.parse((await cli(home, ['skills', '--json', '--cwd', cwd, '--patch', patchFile([{ id: 'skills', config: { maxBytes: 8_000, roots: [] } }])])).out) as SkillDiscovery
    expect(roomy.listed).toHaveLength(2)
    // One byte short of the whole list: the session's render must drop one.
    const budget = Buffer.byteLength(renderSkillList(roomy.listed, 1_000_000)!, 'utf8') - 1
    const tight = await cli(home, ['skills', '--json', '--cwd', cwd, '--patch', patchFile([{ id: 'skills', config: { maxBytes: budget, roots: [] } }])])
    expect(tight.code, tight.err).toBe(0)
    const found = JSON.parse(tight.out) as SkillDiscovery
    expect(found.listed).toHaveLength(1)
    expect(found.skipped.filter((skip) => skip.reason.startsWith(`over the skills row's maxBytes (${budget})`))).toHaveLength(1)
  })

  /**
   * The real binary in its own process, run from a directory that holds a
   * RELATIVE `MINIDSH_HOME`, exactly as check.yml's tarball step runs it. A
   * path made relative to the test's own cwd is no test on a runner whose
   * checkout and temp directory sit on different drives (windows-latest: D:
   * and C:), where `relative()` answers an absolute path.
   */
  it('works under a RELATIVE home, as check.yml runs the installed binary', () => {
    const parent = tempDir('minidsh-skills-relhome-')
    const cwd = workspace()
    const userSkill = writeSkill(join(parent, 'home', 'skills'), 'fixture-alpha', 'Use for alpha fixtures.')
    const bin = fileURLToPath(new URL('../../bin/minidsh.js', import.meta.url))
    const run = spawnSync(process.execPath, [bin, 'skills', '--json', '--cwd', cwd], {
      cwd: parent,
      env: { ...process.env, MINIDSH_HOME: 'home' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(run.status, run.stderr).toBe(0)
    expect((JSON.parse(run.stdout) as SkillDiscovery).listed.find((skill) => skill.name === 'fixture-alpha')?.path).toBe(userSkill)
  })

  it('says so when the row is disabled, refuses a bad row config and an unknown flag, and is in the help', async () => {
    const { home, cwd } = fixture()
    const disabled = await cli(home, ['skills', '--cwd', cwd, '--patch', patchFile([{ id: 'skills', disabled: true }])])
    expect(disabled.code).toBe(0)
    expect(disabled.out).toContain('no skills are offered: the composition disables row "skills"')
    const disabledJson = await cli(home, ['skills', '--json', '--cwd', cwd, '--patch', patchFile([{ id: 'skills', disabled: true }])])
    expect(JSON.parse(disabledJson.out)).toMatchObject({ disabled: true, listed: [] })

    const invalid = await cli(home, ['skills', '--cwd', cwd, '--patch', patchFile([{ id: 'skills', config: { exclude: ['x'] } }])])
    expect(invalid.code).toBe(1)
    expect(invalid.err).toContain('invalid config')

    expect((await cli(home, ['skills', '--frobnicate'])).code).toBe(2)
    expect((await cli(home, ['skills', '--sandbox', 'read-only'])).code).toBe(2)
    const help = await cli(home, ['--help'])
    expect(help.out).toContain('minidsh skills [--cwd dir] [--json]')
  })
})
