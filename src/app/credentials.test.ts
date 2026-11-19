/**
 * `minidsh credentials` through the real binary in its own process — the way
 * the desktop's key form and a person at a terminal both reach it: a value on
 * stdin, never on argv, and never anywhere in what comes back.
 *
 * Hermetic: a temporary home, and the child's environment stripped of every
 * reference the default composition declares, so the machine running this
 * (which may well hold real keys) decides nothing.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WEB_BIN } from '../test-support/web-process.ts'

const DECLARED = ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
/** Distinctive, header-safe, and searched for in every byte the process wrote. */
const SECRET = 'sk-minidsh-SENTINEL-7f3a9c'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'minidsh-credentials-cli-'))
  dirs.push(dir)
  return dir
}

interface Run {
  readonly code: number | null
  readonly out: string
  readonly err: string
}

function cli(minidshHome: string, argv: readonly string[], options: { input?: string; env?: Record<string, string> } = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of [...DECLARED, 'TAVILY_API_KEY', 'MINIDSH_MODEL']) delete env[name]
  const run = spawnSync(process.execPath, [WEB_BIN, ...argv], {
    env: { ...env, MINIDSH_HOME: minidshHome, ...options.env },
    input: options.input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: run.status, out: run.stdout, err: run.stderr }
}

function listed(minidshHome: string, env?: Record<string, string>): Record<string, string> {
  const run = cli(minidshHome, ['credentials', 'list', '--json'], env === undefined ? {} : { env })
  expect(run.code, run.err).toBe(0)
  const parsed = JSON.parse(run.out) as { home: string; store: string; refs: { name: string; source: string }[] }
  expect(parsed.store).toBe(join(minidshHome, 'credentials.json'))
  return Object.fromEntries(parsed.refs.map((ref) => [ref.name, ref.source]))
}

describe('minidsh credentials', () => {
  it('lists what the composition declares, saves a value from stdin, and never prints it', { timeout: 120_000 }, () => {
    const dir = home()
    expect(listed(dir)).toEqual(Object.fromEntries(DECLARED.map((name) => [name, 'absent'])))

    // One trailing newline is how `echo` ends a value, and is not part of it.
    const set = cli(dir, ['credentials', 'set', 'DEEPSEEK_API_KEY', '--json'], { input: `${SECRET}\n` })
    expect(set.code, set.err).toBe(0)
    expect(JSON.parse(set.out)).toEqual({ saved: 'DEEPSEEK_API_KEY', store: join(dir, 'credentials.json') })
    expect(set.err).toContain('saved DEEPSEEK_API_KEY to ')
    const store = join(dir, 'credentials.json')
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ DEEPSEEK_API_KEY: SECRET })
    if (process.platform !== 'win32') expect((statSync(store).mode & 0o777).toString(8)).toBe('600')

    expect(listed(dir)).toMatchObject({ DEEPSEEK_API_KEY: 'store', OPENAI_API_KEY: 'absent' })
    // The environment wins over the store, as resolve has it.
    expect(listed(dir, { DEEPSEEK_API_KEY: 'from-the-environment' })).toMatchObject({ DEEPSEEK_API_KEY: 'env' })
    const human = cli(dir, ['credentials', 'list'])
    expect(human.code, human.err).toBe(0)
    expect(human.out).toMatch(/^DEEPSEEK_API_KEY\s+store$/m)
    expect(human.out).toContain(`store: ${store}`)
    for (const run of [set, human]) expect(`${run.out}${run.err}`).not.toContain(SECRET)

    const unset = cli(dir, ['credentials', 'unset', 'DEEPSEEK_API_KEY'])
    expect(unset.code, unset.err).toBe(0)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({})
    // Absent is not an error.
    expect(cli(dir, ['credentials', 'unset', 'DEEPSEEK_API_KEY']).code).toBe(0)
    expect(listed(dir)).toMatchObject({ DEEPSEEK_API_KEY: 'absent' })
  })

  it('refuses a value a request header cannot carry, and an empty one, naming the rule and never the value', { timeout: 120_000 }, () => {
    const dir = home()
    const store = join(dir, 'credentials.json')
    for (const [input, rule] of [
      [`${SECRET}\nsecond-line\n`, /cannot carry/],
      [`sk minidsh ${SECRET}`, /cannot carry/],
      ['\n', /is empty/],
    ] as const) {
      const run = cli(dir, ['credentials', 'set', 'OPENAI_API_KEY'], { input })
      expect(run.code, `${JSON.stringify(input.slice(0, 4))}…: ${run.err}`).toBe(2)
      expect(run.err).toMatch(rule)
      expect(run.err).toContain('nothing was saved')
      expect(`${run.out}${run.err}`).not.toContain(SECRET)
    }
    expect(() => statSync(store)).toThrow()
    // A name that is not an environment-variable name is refused before stdin is read.
    expect(cli(dir, ['credentials', 'set', 'not a name'], { input: SECRET }).code).toBe(2)
  })

  it('refuses to rewrite a store it cannot parse, and leaves it byte for byte', { timeout: 120_000 }, () => {
    const dir = home()
    mkdirSync(dir, { recursive: true })
    const store = join(dir, 'credentials.json')
    // A person's hand edit with a trailing comma — and a value the parser would quote.
    const content = `{\n  "ANTHROPIC_API_KEY": "${SECRET}",\n}\n`
    writeFileSync(store, content)
    const run = cli(dir, ['credentials', 'set', 'DEEPSEEK_API_KEY'], { input: 'sk-new-value' })
    expect(run.code, run.err).toBe(1)
    expect(run.err).toContain(store)
    expect(run.err).toMatch(/is not valid JSON at line 3, column 1; fix or remove it by hand/)
    expect(readFileSync(store, 'utf8')).toBe(content)
    // `list` still answers, says the store is broken, and reports it as absent — as resolve would.
    const list = cli(dir, ['credentials', 'list', '--json'])
    expect(list.code, list.err).toBe(0)
    expect(list.err).toMatch(/credentials store .* is not valid JSON/)
    for (const out of [run, list]) expect(`${out.out}${out.err}`).not.toContain(SECRET)
  })

  it('is in the help, refuses an unknown subcommand and a flag it does not take', () => {
    const dir = home()
    expect(cli(dir, ['--help']).out).toContain('minidsh credentials list | set <NAME> | unset <NAME> [--json]')
    expect(cli(dir, ['credentials']).code).toBe(2)
    expect(cli(dir, ['credentials', 'show']).code).toBe(2)
    expect(cli(dir, ['credentials', 'list', 'EXTRA']).code).toBe(2)
    expect(cli(dir, ['credentials', 'list', '--cwd', dir]).code).toBe(2)
  })
})
