/**
 * The command line as a script meets it: argv in, an exit code and two streams
 * out, and the home directory afterwards. Everything here goes through `main`
 * with nothing injected — the model is a from-disk scripted plugin, the way a
 * deployment adds one — so a refusal that boots something, an answer on the
 * wrong stream or an exit code that never varies fails here and nowhere else.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDialect } from './compose.ts'
import { main } from './cli.ts'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const NL = String.fromCharCode(10)

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** One command through `main` under `home`, with both streams captured and no ambient model choice: `MINIDSH_MODEL` is `env.model` or unset. */
async function cli(home: string, argv: readonly string[], env: { readonly model?: string } = {}): Promise<Ran> {
  const saved = { home: process.env.MINIDSH_HOME, model: process.env.MINIDSH_MODEL }
  process.env.MINIDSH_HOME = home
  if (env.model === undefined) delete process.env.MINIDSH_MODEL
  else process.env.MINIDSH_MODEL = env.model
  const out: string[] = []
  const err: string[] = []
  const writeOut = process.stdout.write.bind(process.stdout)
  const writeErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write
  let code: number
  try {
    code = await main(argv)
  } finally {
    process.stdout.write = writeOut
    process.stderr.write = writeErr
    if (saved.home === undefined) delete process.env.MINIDSH_HOME
    else process.env.MINIDSH_HOME = saved.home
    if (saved.model === undefined) delete process.env.MINIDSH_MODEL
    else process.env.MINIDSH_MODEL = saved.model
  }
  return { code, out: out.join(''), err: err.join('') }
}

const source = (path: string): string => pathToFileURL(join(import.meta.dirname, '..', path)).href

/**
 * A home whose composition swaps DeepSeek for a scripted model under provider
 * `scripted`. `script` is the SOURCE of the adapter's `.script(...)` arguments:
 * the plugin is a module on disk, so its answers are written into it. One home
 * is one module instance for the life of this process, so a second command
 * under the same home continues the same queue.
 */
function scriptedHome(script: string, options: { patches?: readonly unknown[]; file?: Record<string, unknown> } = {}): string {
  const home = tempDir('minidsh-cli-home-')
  writeFileSync(
    join(home, 'scripted-model.ts'),
    [
      `import { LLM } from '${source('core/llm/index.ts')}'`,
      `import { ScriptedAdapter, assistantText, assistantToolCall } from '${source('test-support/scripted-adapter.ts')}'`,
      `const adapter = new ScriptedAdapter().script(${script})`,
      `export default { name: 'scripted-model', inject: [LLM], apply(ctx) { ctx.get(LLM).registerAdapter(ctx, adapter) } }`,
      '',
    ].join(NL),
  )
  writeFileSync(
    join(home, 'composition.json'),
    JSON.stringify({ patches: [{ id: 'llm-deepseek', disabled: true }, ...(options.patches ?? []), { insert: [{ id: 'scripted-model', plugin: './scripted-model.ts' }] }], ...options.file }),
  )
  return home
}

/** The flags that route a command to the scripted model, in a workspace of its own. */
const routed = (cwd: string): string[] => ['--provider', 'scripted', '--model', 'scripted-model', '--cwd', cwd]

const sessionFiles = (home: string): string[] => (existsSync(join(home, 'sessions')) ? readdirSync(join(home, 'sessions')) : [])

function storedEvents(home: string, id: string): { type: string; seq: number; data: Record<string, unknown> }[] {
  return readFileSync(join(home, 'sessions', `${encodeURIComponent(id)}.jsonl`), 'utf8')
    .trim()
    .split(NL)
    .slice(1)
    .map((line) => JSON.parse(line) as { type: string; seq: number; data: Record<string, unknown> })
}

/** The id a headless command printed on its `session:` line. */
function sessionOf(ran: Ran): string {
  const id = /^session: (.+)$/m.exec(ran.err)?.[1]
  expect(id, `no session line in:${NL}${ran.err}`).toBeDefined()
  return id!
}

describe('a headless run: what a script reads', () => {
  it('prints the answer on stdout with its lines kept and every control character neutralized', async () => {
    // The model writes the answer; a prompt-injected one could otherwise erase
    // the effect lines above it or forge the `session:` line below.
    const hostile = `'first line' + String.fromCharCode(10) + 'second' + String.fromCharCode(27) + '[2J' + String.fromCharCode(27) + ']0;owned' + String.fromCharCode(7)`
    const home = scriptedHome(`assistantText(${hostile})`)
    const ran = await cli(home, ['run', 'say it', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toBe(`first line${NL}second [2J ]0;owned ${NL}`)
    expect(ran.out.includes(ESC) || ran.out.includes(BEL), JSON.stringify(ran.out)).toBe(false)
  })

  it('exits 1 and says how the turn ended when it did not complete', async () => {
    // No scripted answer: the model call fails, so the turn ends in error.
    const home = scriptedHome('')
    const ran = await cli(home, ['run', 'anything', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(ran.code, ran.err).toBe(1)
    expect(ran.err).toContain('turn ended: error')
    expect(ran.err).toMatch(/^session: session-/m)
    // And a completed one is 0, so the code is the turn's and not a constant.
    const ok = await cli(scriptedHome(`assistantText('fine')`), ['run', 'anything', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(ok.code, ok.err).toBe(0)
    expect(ok.err).not.toContain('turn ended')
  })

  it('run --json puts one {sessionId, event} frame per line on stdout, and nothing else there', async () => {
    const home = scriptedHome(`assistantText('the answer in prose')`)
    const ran = await cli(home, ['run', 'go', '--json', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out, 'stdout carried no frame at all').not.toBe('')
    const lines = ran.out.trimEnd().split(NL)
    const frames = lines.map((line) => JSON.parse(line) as { sessionId?: string; event?: { type?: string } })
    const id = sessionOf(ran)
    expect(frames.length, ran.out).toBeGreaterThan(3)
    for (const [index, frame] of frames.entries()) {
      expect(frame.sessionId, `line ${index}: ${lines[index]}`).toBe(id)
      expect(typeof frame.event?.type, `line ${index}: ${lines[index]}`).toBe('string')
    }
    const kinds = frames.map((frame) => frame.event!.type)
    expect(kinds).toContain('turn/start')
    expect(kinds.at(-1), kinds.join(' ')).not.toBeUndefined()
    expect(kinds).toContain('turn/end')
    // The answer is in a frame, never a bare line of its own.
    expect(lines).not.toContain('the answer in prose')
    expect(ran.err).not.toContain('"sessionId"')
  })

  it('resume --headless prints the answer of the turn it ran, or nothing: never an earlier turn\'s', async () => {
    // One scripted answer for two commands under one home: the resumed turn
    // has none left, fails before it says anything, and must print nothing.
    const home = scriptedHome(`assistantText('the first answer')`)
    const cwd = tempDir('minidsh-cli-cwd-')
    const first = await cli(home, ['run', 'one', ...routed(cwd)])
    expect(first.code, first.err).toBe(0)
    expect(first.out).toBe(`the first answer${NL}`)
    const id = sessionOf(first)
    const resumed = await cli(home, ['resume', id, 'two', '--headless'])
    expect(resumed.code, resumed.err).toBe(1)
    expect(resumed.err).toContain('turn ended: error')
    expect(resumed.out, 'stdout held an answer to a different question').toBe(NL)
    const forked = await cli(home, ['fork', id, 'three', '--headless'])
    expect(forked.code, forked.err).toBe(1)
    expect(forked.out, 'stdout held the parent\'s answer').toBe(NL)
  })
})

describe('refused before anything boots', () => {
  it('refuses a --cwd that is no directory, a --max-steps that is no count, an --at that is no seq and an empty id, storing nothing', async () => {
    // An answer is scripted, so a refusal that is missing shows as a run that worked.
    const home = scriptedHome(`assistantText('ran'), assistantText('ran'), assistantText('ran'), assistantText('ran'), assistantText('ran'), assistantText('ran')`)
    const cwd = tempDir('minidsh-cli-cwd-')
    const cases: readonly (readonly [argv: string[], says: RegExp])[] = [
      [['run', 'x', '--provider', 'scripted', '--model', 'scripted-model', '--cwd', join(cwd, 'missing')], /--cwd is not an existing directory: /],
      [['run', 'x', '--provider', 'scripted', '--model', 'scripted-model', '--cwd', ''], /--cwd takes a directory/],
      [['run', 'x', ...routed(cwd), '--max-steps', 'abc'], /--max-steps expects a positive integer, got "abc"/],
      [['run', 'x', ...routed(cwd), '--max-steps', '0'], /--max-steps expects a positive integer, got "0"/],
      [['fork', 'session-x', 'task', '--headless', '--at', 'abc'], /--at expects an integer event seq, got "abc"/],
      [['run', 'x', '--cwd', cwd, '--provider', 'scripted', '--model'], /--model expects a model id/],
      [['run', 'x', '--cwd', cwd, '--model', 'scripted-model', '--provider', ''], /--provider expects a provider id/],
      [['run', 'x', ...routed(cwd), '--effort', ' '], /--effort expects an effort id/],
    ]
    for (const [argv, says] of cases) {
      const ran = await cli(home, argv)
      expect(ran.code, `${argv.join(' ')}: ${ran.err}`).toBe(2)
      expect(ran.err, argv.join(' ')).toMatch(says)
      expect(ran.out, argv.join(' ')).toBe('')
    }
    expect(sessionFiles(home), 'a refused command stored a session').toEqual([])
  })

  it('refuses a flag the command does not list, for every command the help prints', async () => {
    const home = tempDir('minidsh-cli-home-')
    // The table itself, as a person reads it: a command added to it is covered here without being named.
    const help = await cli(home, ['--help'])
    const commands = [...help.out.matchAll(/^ {2}minidsh ([a-z]+)\b/gm)].map((match) => match[1]!)
    expect(commands, help.out).toEqual(expect.arrayContaining(['run', 'chat', 'resume', 'fork', 'serve', 'web', 'config', 'sessions', 'skills', 'credentials']))
    // What each needs to get as far as its flags: a task, an id, a subcommand.
    const before: Readonly<Record<string, readonly string[]>> = { run: ['a task'], resume: ['session-x'], fork: ['session-x'], sessions: ['list'], credentials: ['list'] }
    for (const command of commands) {
      const ran = await cli(home, [command, ...(before[command] ?? []), '--frobnicate'])
      expect(ran.code, `${command}: ${ran.err}`).toBe(2)
      // Closed quote and all: `sessions` has a second, per-subcommand refusal that words it differently.
      expect(ran.err, command).toContain(`--frobnicate is not a flag of "${command}"`)
    }
    expect(sessionFiles(home)).toEqual([])
  })

  it('names an unknown command on stderr, and leaves stdout to help that was asked for', async () => {
    const home = tempDir('minidsh-cli-home-')
    const typo = await cli(home, ['runn', 'hi'])
    expect(typo.code).toBe(2)
    expect(typo.err.split(NL)[0]).toBe('minidsh: unknown command "runn"')
    expect(typo.err).toContain('minidsh run "<task>"')
    expect(typo.out).toBe('')
    const asked = await cli(home, ['--help'])
    expect(asked.code).toBe(0)
    expect(asked.err).toBe('')
    expect(asked.out).toContain('minidsh run "<task>"')
    expect(asked.out).toContain('MINIDSH_MODEL')
  })

  it('refuses web --host with no address and a --port outside 0..65535 as usage errors, binding nothing', async () => {
    const home = tempDir('minidsh-cli-home-')
    const cwd = tempDir('minidsh-cli-cwd-')
    for (const [argv, says, record] of [
      // The parser stores '' for a value flag with nothing after it, and `listen('')` is every interface.
      [['web', '--cwd', cwd, '--json', '--host'], '--host takes an address', 'USAGE'],
      [['web', '--cwd', cwd, '--json', '--host', '  '], '--host takes an address', 'USAGE'],
      [['web', '--cwd', cwd, '--json', '--port', '99999'], '--port takes a number from 0 to 65535', 'USAGE'],
      [['web', '--cwd', cwd, '--json', '--port', '-1'], '--port takes a number from 0 to 65535', 'USAGE'],
    ] as const) {
      const ran = await cli(home, argv)
      expect(ran.code, `${argv.join(' ')}: ${ran.err}`).toBe(2)
      expect(ran.err, argv.join(' ')).toContain(says)
      expect(JSON.parse(ran.out), argv.join(' ')).toMatchObject({ type: 'error', code: record })
    }
  })
})

describe('a route nothing can be sent on is refused before a session exists', () => {
  it('refuses --provider without --model when the model in use is another provider\'s, naming that provider\'s models', async () => {
    const home = scriptedHome(`assistantText('ran'), assistantText('ran')`)
    const cwd = tempDir('minidsh-cli-cwd-')
    // The settings route is deepseek/deepseek-flash: `--provider anthropic` alone used to run `anthropic/deepseek-flash`.
    const alone = await cli(home, ['run', 'x', '--cwd', cwd, '--provider', 'anthropic'])
    expect(alone.code, alone.err).toBe(2)
    expect(alone.err).toMatch(/^--provider anthropic needs --model: the model in use \(deepseek-flash\) is deepseek's\. anthropic lists: \S+/m)
    const scripted = await cli(home, ['run', 'x', '--cwd', cwd, '--provider', 'scripted'])
    expect(scripted.code, scripted.err).toBe(2)
    expect(scripted.err).toContain('scripted lists: scripted-model')
    expect(sessionFiles(home), 'a refused route stored a session').toEqual([])
  })

  // The documented order is flags, then MINIDSH_MODEL, then settings.json: a
  // model the environment names is named, and `--provider X` beside it used
  // to be refused as if the model were the settings provider's.
  it('takes a model MINIDSH_MODEL names as named: --provider beside it is a whole route', async () => {
    const home = scriptedHome(`assistantText('ran')`)
    const cwd = tempDir('minidsh-cli-cwd-')
    const ran = await cli(home, ['run', 'x', '--cwd', cwd, '--provider', 'scripted'], { model: 'scripted-model' })
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toBe(`ran${NL}`)
    const [options] = storedEvents(home, sessionOf(ran)).filter((event) => event.type === 'agent/options')
    expect(options?.data.options).toMatchObject({ provider: 'scripted', model: 'scripted-model' })
    // A model the provider being LEFT lists, and the one named does not, is
    // still the mistake: exported as a default beside the settings' provider,
    // it would run anthropic/scripted-model and fail at the first paid step.
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ agent: { provider: 'scripted', model: 'scripted-model' } }))
    const before = sessionFiles(home).length
    const left = await cli(home, ['run', 'x', '--cwd', cwd, '--provider', 'anthropic'], { model: 'scripted-model' })
    expect(left.code, left.err).toBe(2)
    expect(left.err).toMatch(/^--provider anthropic needs --model: the model in use \(scripted-model\) is scripted's\. anthropic lists: \S+/m)
    expect(sessionFiles(home).length, 'a refused route stored a session').toBe(before)
  })

  it('refuses a provider no row mounts, naming the mounted ones, whether a flag or the settings named it', async () => {
    const home = scriptedHome(`assistantText('ran'), assistantText('ran')`)
    const cwd = tempDir('minidsh-cli-cwd-')
    const unknown = await cli(home, ['run', 'x', '--cwd', cwd, '--provider', 'nopeai', '--model', 'any'])
    expect(unknown.code, unknown.err).toBe(2)
    expect(unknown.err).toMatch(/^no provider "nopeai" is mounted; the mounted providers are: .*\bscripted\b/m)
    expect(unknown.err).toMatch(/the mounted providers are: .*\banthropic\b/)
    // This home disables the deepseek row, and its settings still name deepseek.
    const fromSettings = await cli(home, ['run', 'x', '--cwd', cwd])
    expect(fromSettings.code, fromSettings.err).toBe(2)
    expect(fromSettings.err).toContain('no provider "deepseek" is mounted')
    // The terminal too, for what its flags name, before it reads a line.
    const chat = await cli(home, ['chat', '--plain', '--cwd', cwd, '--provider', 'nopeai', '--model', 'any'])
    expect(chat.code, chat.err).toBe(2)
    expect(chat.err).toContain('no provider "nopeai" is mounted')
    expect(sessionFiles(home), 'a refused route stored a session').toEqual([])
  })

  it('holds a continuation to the route its log recorded: --provider alone is refused unless it is that provider', async () => {
    const home = scriptedHome(`assistantText('one'), assistantText('two')`)
    const first = await cli(home, ['run', 'x', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(first.code, first.err).toBe(0)
    const id = sessionOf(first)
    const turns = (): number => storedEvents(home, id).filter((event) => event.type === 'turn/start').length
    const switched = await cli(home, ['resume', id, 'again', '--headless', '--provider', 'anthropic'])
    expect(switched.code, switched.err).toBe(2)
    expect(switched.err).toMatch(/^--provider anthropic needs --model: the model in use \(scripted-model\) is scripted's\. anthropic lists: \S+/m)
    expect(turns(), 'the refused resume ran a turn').toBe(1)
    // Naming the provider it already has changes nothing, and runs.
    const same = await cli(home, ['resume', id, 'again', '--headless', '--provider', 'scripted'])
    expect(same.code, same.err).toBe(0)
    expect(same.out).toBe(`two${NL}`)
    expect(turns()).toBe(2)
  })

  it('answers a model the provider refused with the models that provider lists', async () => {
    const refusal = `[{ type: 'finish', reason: { kind: 'error', failure: { message: 'model: no-such-model', code: 'UNKNOWN_MODEL' } } }]`
    const home = scriptedHome(refusal)
    const ran = await cli(home, ['run', 'x', '--cwd', tempDir('minidsh-cli-cwd-'), '--provider', 'scripted', '--model', 'no-such-model'])
    expect(ran.code, ran.err).toBe(1)
    expect(ran.err).toContain('UNKNOWN_MODEL')
    expect(ran.err.split(NL).filter((line) => line.startsWith('minidsh: '))).toEqual(['minidsh: scripted refused the model "no-such-model"; the models it lists are: scripted-model'])
  })
})

describe('a headless run that needed an approval nobody could give', () => {
  // An escalation is asked on every host, before anything runs: no shell is started.
  const escalation = `assistantToolCall('c1', '${defaultDialect()}', { command: 'echo hi', sandbox_permissions: 'danger-full-access', justification: 'it must' }), assistantText('I could not run it')`
  // `confinement: none` is the host with no backend, on every machine this runs on.
  const unconfined = { patches: [{ id: 'shell', config: { dialect: defaultDialect(), confinement: 'none' } }] }
  const notes = (ran: Ran): string[] => ran.err.split(NL).filter((line) => line.startsWith('minidsh: an approval'))

  it('says once on stderr which flag would have let the call through, and still exits with the turn\'s own code', async () => {
    const ran = await cli(scriptedHome(escalation, unconfined), ['run', 'go', ...routed(tempDir('minidsh-cli-cwd-'))])
    // The turn completed (the model answered the refusal), so the code is 0: the line is how a person learns of it.
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out).toBe(`I could not run it${NL}`)
    expect(ran.err).toContain('unavailable')
    expect(notes(ran)).toEqual([
      'minidsh: an approval was needed and nobody could answer it (a headless run asks no one), so the call was refused. To allow it, rerun with --approve (answers every request yes); this host cannot confine the shell, and --accept none runs shell commands unconfined without asking while the file tools stay fenced',
    ])
  })

  it('does not offer --accept none to a run that already has it, and says nothing when nothing was refused', async () => {
    const accepted = await cli(scriptedHome(escalation, unconfined), ['run', 'go', ...routed(tempDir('minidsh-cli-cwd-')), '--accept', 'none'])
    expect(accepted.code, accepted.err).toBe(0)
    expect(notes(accepted)).toEqual(['minidsh: an approval was needed and nobody could answer it (a headless run asks no one), so the call was refused. To allow it, rerun with --approve (answers every request yes)'])
    const quiet = await cli(scriptedHome(`assistantText('nothing needed')`), ['run', 'go', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(quiet.code, quiet.err).toBe(0)
    expect(quiet.err.split(NL).filter((line) => line.startsWith('minidsh: '))).toEqual([])
  })
})

describe('authority presets and agent presets, from the command line', () => {
  it('applies --preset as a recorded switch, and refuses an unknown one, one beside --sandbox, and one on a command that cannot apply it', async () => {
    const home = scriptedHome(`assistantText('done')`)
    const cwd = tempDir('minidsh-cli-cwd-')
    for (const [argv, says] of [
      [['run', 'x', ...routed(cwd), '--preset', 'nope'], /unknown preset "nope" \(known: workspace-write, danger-full-access\)/],
      [['run', 'x', ...routed(cwd), '--preset', 'workspace-write', '--sandbox', 'read-only'], /--preset replaces --sandbox\/--ask; give one or the other/],
      [['run', 'x', ...routed(cwd), '--preset', ''], /--preset expects a preset name/],
      [['resume', 'session-x', '--preset', 'workspace-write'], /--preset works with --headless; in the interactive terminal use \/preset/],
      [['serve', '--preset', 'workspace-write'], /--preset is not a flag of "serve"/],
    ] as const) {
      const ran = await cli(home, argv)
      expect(ran.code, `${argv.join(' ')}: ${ran.err}`).toBe(2)
      expect(ran.err, argv.join(' ')).toMatch(says)
    }
    expect(sessionFiles(home), 'a refused preset stored a session').toEqual([])
    const ran = await cli(home, ['run', 'x', ...routed(cwd), '--preset', 'danger-full-access'])
    expect(ran.code, ran.err).toBe(0)
    const events = storedEvents(home, sessionOf(ran))
    expect(events.filter((event) => event.type === 'authority/preset').map((event) => event.data)).toEqual([{ name: 'danger-full-access' }])
    expect(events.findLast((event) => event.type === 'sandbox/mode')?.data).toMatchObject({ mode: 'danger-full-access', reason: 'change' })
    expect(events.findLast((event) => event.type === 'approval/policy')?.data).toMatchObject({ policy: 'never', reason: 'change' })
  })

  it('composes a session from a named agent preset in the composition file, records the name, and `config` flags what the preset mounts', async () => {
    const options = {
      // A sensitive built-in row disabled by the layer, for the DISABLED verb.
      patches: [{ id: 'tool-subagent', disabled: true }],
      file: { agentPresets: { reviewer: [{ id: 'approve-all', plugin: 'approval-headless', config: { approve: true } }] } },
    }
    const home = scriptedHome(`assistantText('reviewed')`, options)
    const cwd = tempDir('minidsh-cli-cwd-')
    const unknown = await cli(home, ['run', 'x', ...routed(cwd), '--agent-preset', 'nope'])
    expect(unknown.code, unknown.err).toBe(2)
    expect(unknown.err).toContain('unknown agent preset "nope" (known: reviewer)')
    expect(sessionFiles(home)).toEqual([])

    const ran = await cli(home, ['run', 'x', ...routed(cwd), '--agent-preset', 'reviewer'])
    expect(ran.code, ran.err).toBe(0)
    const header = JSON.parse(readFileSync(join(home, 'sessions', `${encodeURIComponent(sessionOf(ran))}.jsonl`), 'utf8').split(NL)[0]!) as { agentPreset?: string }
    expect(header.agentPreset).toBe('reviewer')

    const config = await cli(home, ['config'])
    expect(config.code, config.err).toBe(0)
    expect(config.out).toMatch(/^ {2}reviewer\s+approve-all\(approval-headless\) {2}\[!\]$/m)
    const warnings = config.err.split(NL).filter((line) => line.startsWith('warn: '))
    expect(warnings).toContain('warn: agent preset "reviewer" mounts authority-sensitive row "approve-all" (approval-headless) into every agent it composes')
    expect(warnings).toContain('warn: layer "home" DISABLED authority-sensitive row "tool-subagent" (tool-subagent)')
    expect(warnings).toContain('warn: layer "home" added authority-sensitive row "scripted-model" (scripted-model)')
  })
})

describe('minidsh config --json', () => {
  it('marks the authority-sensitive rows a layer touched, and warns of them, exactly as the text view does', async () => {
    const home = tempDir('minidsh-cli-home-')
    writeFileSync(
      join(home, 'composition.json'),
      JSON.stringify({
        // An invariant disabled, an answerer told to approve everything, and a row no check cares about.
        patches: [{ id: 'jobs-invariant', disabled: true }, { id: 'approval-headless', config: { approve: true } }, { id: 'llm-retry', disabled: true }],
        agentPresets: { reviewer: [{ id: 'approve-all', plugin: 'approval-headless', config: { approve: true } }], quiet: [{ id: 'title', plugin: 'session-title' }] },
      }),
    )
    const expected = [
      'warn: layer "home" modified authority-sensitive row "approval-headless" (approval-headless)',
      'warn: layer "home" DISABLED authority-sensitive row "jobs-invariant" (core-jobs-invariant)',
      'warn: agent preset "reviewer" mounts authority-sensitive row "approve-all" (approval-headless) into every agent it composes',
    ]
    const warned = (ran: Ran): string[] => ran.err.split(NL).filter((line) => line.startsWith('warn: '))
    const text = await cli(home, ['config'])
    expect(text.code, text.err).toBe(0)
    expect(warned(text)).toEqual(expected)
    const json = await cli(home, ['config', '--json'])
    expect(json.code, json.err).toBe(0)
    expect(warned(json)).toEqual(expected)
    const parsed = JSON.parse(json.out) as { rows: { id: string; layer: string; sensitive?: boolean; disabled?: boolean }[]; agentPresets: { name: string; sensitive?: string[] }[] }
    // Every row a layer touched, with its mark: the two sensitive ones, and the one that is not.
    expect(parsed.rows.filter((row) => row.layer !== 'built-in').map((row) => [row.id, row.sensitive ?? false])).toEqual([
      ['llm-retry', false],
      ['approval-headless', true],
      ['jobs-invariant', true],
    ])
    expect(parsed.rows.filter((row) => row.sensitive === true && row.layer === 'built-in'), 'a row no layer touched is never marked').toEqual([])
    expect(parsed.agentPresets.map((preset) => [preset.name, preset.sensitive ?? []])).toEqual([
      ['reviewer', ['approve-all']],
      ['quiet', []],
    ])
  })
})

describe('a layer and a flag on the same row', () => {
  it('says which layer an explicit authority flag overrode, once, and says nothing without the flag', async () => {
    const home = tempDir('minidsh-cli-home-')
    writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ id: 'sandbox', config: { mode: 'danger-full-access' } }, { id: 'approval', config: { policy: 'never' } }] }))
    const flagged = await cli(home, ['config', '--sandbox', 'read-only', '--ask', 'ask'])
    expect(flagged.code, flagged.err).toBe(0)
    // In row order, one line per key a flag took.
    expect(flagged.err.split(NL).filter((line) => line.includes('wins over'))).toEqual([
      'warn: --ask ask wins over layer "home", which sets policy: "never" on row "approval"',
      'warn: --sandbox read-only wins over layer "home", which sets mode: "danger-full-access" on row "sandbox"',
    ])
    const plain = await cli(home, ['config'])
    expect(plain.code, plain.err).toBe(0)
    expect(plain.err).not.toContain('wins over')
    // The flag changes the rows a boot would mount, so it changes the hash `config` prints.
    expect(/^composition (\w+)/.exec(flagged.out)?.[1]).not.toBe(/^composition (\w+)/.exec(plain.out)?.[1])
  })

  it('opens a session under --sandbox though a layer replaced the sandbox row\'s config, and `config` prints the hash that session records', async () => {
    // Three rows the app fills or a flag sets, each patched by the layer for ANOTHER key.
    const patches = [
      { id: 'sandbox', config: { accepts: 'none' } },
      { id: 'workspace-instructions', config: { maxBytes: 64_000 } },
      { id: 'shell', config: { dialect: defaultDialect(), confinement: 'none' } },
    ]
    const home = scriptedHome(`assistantText('ran')`, { patches })
    const ran = await cli(home, ['run', 'x', ...routed(tempDir('minidsh-cli-cwd-')), '--sandbox', 'read-only'])
    expect(ran.code, ran.err).toBe(0)
    const events = storedEvents(home, sessionOf(ran))
    // The OPENING stamp: the row's default, which is all a session that `web`,
    // `serve` or `chat` creates ever gets. (`run` adds a durable switch, and
    // finds nothing to change.)
    expect(events.filter((event) => event.type === 'sandbox/mode').map((event) => [event.data.mode, event.data.reason])).toEqual([['read-only', 'initial']])
    // And the layer's own key on that row stood.
    expect(events.filter((event) => event.type === 'sandbox/acceptance').map((event) => [event.data.accepts, event.data.forMode])).toContainEqual(['none', 'read-only'])
    const config = await cli(home, ['config', '--json', '--sandbox', 'read-only'])
    expect(config.code, config.err).toBe(0)
    expect((JSON.parse(config.out) as { hash: string }).hash).toBe(events.find((event) => event.type === 'composition/applied')!.data.hash)
  })

  it('prints a layer warning once on a command that reads a log before it boots', async () => {
    const home = scriptedHome(`assistantText('one'), assistantText('two')`, { patches: [{ id: 'ghost', disabled: true }] })
    const ghosts = (ran: Ran): string[] => ran.err.split(NL).filter((line) => line.includes('"ghost"'))
    const first = await cli(home, ['run', 'x', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(first.code, first.err).toBe(0)
    expect(ghosts(first)).toEqual(['warn: home: patch targets unknown row id "ghost"'])
    const id = sessionOf(first)
    const end = storedEvents(home, id).find((event) => event.type === 'turn/end')!.seq
    // `--at` is checked against the stored log before the boot: two readers of one layer.
    const forked = await cli(home, ['fork', id, 'again', '--headless', '--at', String(end), '--approve'])
    expect(forked.code, forked.err).toBe(0)
    expect(ghosts(forked)).toEqual(['warn: home: patch targets unknown row id "ghost"'])
    // `--approve` over the built-in row's own `approve: false` overrides no layer, so nothing says it did.
    expect(forked.err).not.toContain('wins over')
  })

  it('stops on a home composition.json that is there and cannot be read, naming the path, instead of booting without it', async () => {
    const home = tempDir('minidsh-cli-home-')
    // A directory where the file should be: it exists, and no read of it succeeds.
    mkdirSync(join(home, 'composition.json'))
    const ran = await cli(home, ['config'])
    expect(ran.code, ran.err).toBe(2)
    expect(ran.err).toContain(`composition file ${join(home, 'composition.json')} is unreadable: `)
    expect(ran.out).toBe('')
  })

  it('reads an empty settings.json as no settings and says so once, also on a command that boots the store', async () => {
    const empties = (ran: Ran): string[] => ran.err.split(NL).filter((line) => line.includes('is empty'))
    const home = scriptedHome(`assistantText('ran')`)
    writeFileSync(join(home, 'settings.json'), '')
    const said = `warn: settings file ${join(home, 'settings.json')} is empty; it is read as no settings, and the next change saved replaces it`
    const config = await cli(home, ['config'])
    expect(config.code, config.err).toBe(0)
    expect(empties(config)).toEqual([said])
    expect(config.out).toContain('agent defaults: deepseek/deepseek-flash')
    const ran = await cli(home, ['run', 'x', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(ran.code, ran.err).toBe(0)
    expect(empties(ran), 'the boot-time read and the runtime store each said it').toEqual([said])
  })
})

describe('stored logs this runtime did not write', () => {
  /** A real stored session, and its id. */
  async function recorded(script = `assistantText('done')`): Promise<{ home: string; id: string; file: string }> {
    const home = scriptedHome(script)
    const ran = await cli(home, ['run', 'record something', ...routed(tempDir('minidsh-cli-cwd-'))])
    expect(ran.code, ran.err).toBe(0)
    const id = sessionOf(ran)
    return { home, id, file: join(home, 'sessions', `${encodeURIComponent(id)}.jsonl`) }
  }

  it('lists every session when one stored header lacks a cwd and another names a time no date holds', async () => {
    const { home, id } = await recorded()
    writeFileSync(join(home, 'sessions', 'no-cwd.jsonl'), `{"kind":"session","id":"no-cwd","createdAt":1}${NL}`)
    writeFileSync(join(home, 'sessions', 'no-date.jsonl'), `{"kind":"session","id":"no-date","createdAt":9e15,"cwd":"/w"}${NL}`)
    const ran = await cli(home, ['sessions', 'list'])
    expect(ran.code, ran.err).toBe(0)
    // Not trimmed: an empty last column is a trailing tab.
    const rows = ran.out.split(NL).filter((row) => row.length > 0).map((row) => row.split(String.fromCharCode(9)))
    expect(rows.map((row) => row[0]).toSorted(), ran.out).toEqual([id, 'no-cwd', 'no-date'].toSorted())
    expect(rows.find((row) => row[0] === 'no-cwd')).toEqual(['no-cwd', '1970-01-01T00:00:00.001Z', '', ''])
    expect(rows.find((row) => row[0] === 'no-date')).toEqual(['no-date', '9000000000000000', '/w', ''])
  })

  it('shows and audits a log holding a known kind with the wrong payload, naming that event and printing the rest', async () => {
    const { home, id, file } = await recorded()
    const seq = storedEvents(home, id).length
    // One for each reader of the view: the line projection (a turn end with no
    // reason), the audit (a grant), the meter (an assistant message), the
    // title (a user message) and the image listing (a tool result).
    // Each is a well-formed ENVELOPE (the store reads it; a surface kind carries
    // its surface operation), with a payload that is not its kind's.
    const append = { surfaceOp: { op: 'append' } }
    const unreadable = [
      ['turn/end', {}, {}],
      ['approval/grant', null, {}],
      ['assistant/message', null, append],
      ['user/message', null, append],
      ['tool/result', null, append],
    ] as const
    const last = seq + unreadable.length
    const bad = [
      ...unreadable.map(([type, data, surface], index) => ({ type, seq: seq + index, time: 1, data, ...surface })),
      { type: 'sandbox/mode', seq: last, time: 1, data: { mode: 'read-only', enforcement: 'full', reason: 'change' } },
    ]
    writeFileSync(file, `${readFileSync(file, 'utf8')}${bad.map((event) => JSON.stringify(event)).join(NL)}${NL}`)
    const shown = await cli(home, ['sessions', 'show', id])
    expect(shown.code, shown.err).toBe(0)
    const rows = shown.out.split(NL)
    for (const [index, [type]] of unreadable.entries()) expect(rows, `${type} in:${NL}${shown.out}`).toContain(`${String(seq + index).padStart(4)}  ${type} (unreadable payload)`)
    // What came before them and what came after are both still there: a fold
    // that cannot read the log costs its own summary line, never the rows.
    expect(rows.some((row) => row.endsWith('turn/end [turn completed]')), shown.out).toBe(true)
    expect(rows).toContain(`${String(last).padStart(4)}  sandbox/mode [sandbox: read-only (change; shell confinement full)]`)

    const audit = await cli(home, ['sessions', 'show', id, '--audit'])
    expect(audit.code, audit.err).toBe(0)
    expect(audit.out.split(NL)).toContain(`${String(seq + 1).padStart(4)}  unreadable  approval/grant (unreadable payload)`)
    expect(audit.out.split(NL)).toContain(`${String(last).padStart(4)}  sandbox     read-only (change; shell confinement full)`)
  })

  it('ends the audit of a damaged log by saying where reading stopped, and calls an unreadable header what it is', async () => {
    const { home, id, file } = await recorded()
    const lines = readFileSync(file, 'utf8').trimEnd().split(NL)
    const cut = lines.length - 3
    // One line in the middle destroyed: everything after it is beyond a readable prefix.
    writeFileSync(file, [...lines.slice(0, cut), 'not json at all', ...lines.slice(cut + 1), ''].join(NL))
    const audit = await cli(home, ['sessions', 'show', id, '--audit'])
    expect(audit.code, audit.err).toBe(0)
    expect(audit.out.trimEnd().split(NL).at(-1)).toMatch(new RegExp(`^ +${cut - 1}  damaged     the log stops being readable here at line ${cut + 1} \\(.+\\): whatever it recorded after this is not in this audit$`))
    expect(audit.err).toContain('warning: the stored log is damaged beyond this point')

    writeFileSync(join(home, 'sessions', 'zeroed.jsonl'), Buffer.alloc(4096))
    const zeroed = await cli(home, ['sessions', 'show', 'zeroed'])
    expect(zeroed.code).toBe(1)
    expect(zeroed.err).toBe(`session "zeroed": its log exists and cannot be read at all: NUL bytes where the header line should be${NL}`)
    const absent = await cli(home, ['sessions', 'show', 'never-was'])
    expect(absent.code).toBe(1)
    expect(absent.err).toBe(`no session "never-was"${NL}`)
  })

  it('names the turn a refused --at falls inside and the seqs a fork may be taken at, which `sessions inspect` lists', async () => {
    const { home, id } = await recorded(`assistantText('one'), assistantText('forked')`)
    const events = storedEvents(home, id)
    const start = events.find((event) => event.type === 'turn/start')!.seq
    const end = events.find((event) => event.type === 'turn/end')!.seq
    const inside = await cli(home, ['fork', id, 'go on', '--headless', '--at', String(end - 1)])
    expect(inside.code, inside.err).toBe(2)
    expect(inside.err).toBe(
      `--at ${end - 1} is inside the turn that starts at seq ${start} and ends at ${end}, and a fork needs a point where no turn is open: the nearest turn end is seq ${end} (after) (\`minidsh sessions inspect ${id}\` lists every one)${NL}`,
    )
    expect(sessionFiles(home).filter((name) => name.endsWith('.jsonl')), 'the refused fork stored a session').toHaveLength(1)

    const inspected = await cli(home, ['sessions', 'inspect', id])
    expect(inspected.code, inspected.err).toBe(0)
    expect(inspected.out.split(NL)).toContain(`  each ends at seq: ${end} (a point \`fork --at\` accepts)`)
    const asJson = await cli(home, ['sessions', 'inspect', id, '--json'])
    expect((JSON.parse(asJson.out) as { forkPoints: number[] }).forkPoints).toEqual([end])

    // And the point it named is one the fork takes.
    const forked = await cli(home, ['fork', id, 'go on', '--headless', '--at', String(end)])
    expect(forked.code, forked.err).toBe(0)
    expect(forked.out).toBe(`forked${NL}`)
  })
})

describe('credentials list', () => {
  it('shows a stored name no mounted row declares, as stored and unread, and never its value', async () => {
    const home = tempDir('minidsh-cli-home-')
    const secret = 'tvly-SENTINEL-93ab'
    // A byte-order mark too: the store's owner reads past one, so this reader must.
    writeFileSync(join(home, 'credentials.json'), `${String.fromCharCode(0xfeff)}${JSON.stringify({ TAVILY_API_KEY: secret, OPENAI_API_KEY: 'sk-stored', EMPTY_ONE: '  ' })}`)
    const json = await cli(home, ['credentials', 'list', '--json'])
    expect(json.code, json.err).toBe(0)
    const parsed = JSON.parse(json.out) as { refs: { name: string }[]; unused: string[] }
    expect(parsed.unused).toEqual(['TAVILY_API_KEY'])
    expect(parsed.refs.map((ref) => ref.name).toSorted()).toEqual(['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])
    const human = await cli(home, ['credentials', 'list'])
    expect(human.code, human.err).toBe(0)
    expect(human.out).toMatch(/^TAVILY_API_KEY\s+stored, and read by no mounted row$/m)
    for (const ran of [json, human]) expect(`${ran.out}${ran.err}`).not.toContain(secret)
  })
})
