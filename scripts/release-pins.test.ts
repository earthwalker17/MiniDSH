/**
 * Pins that live in more than one file and must agree. Each is a place where
 * a release could otherwise go out with two answers to one question, and each
 * was found by reading, never by a failure (S22.5): the workflows named one
 * Node and `.nvmrc` another; an installer's name was spelled in the packer, in
 * two workflows' globs and in the README.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FUSES_THAT_MUST_BE_OFF } from '../desktop/scripts/check-fuses.ts'

const ROOT = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const workflows = readdirSync(join(ROOT, '.github', 'workflows')).filter((name) => /\.ya?ml$/.test(name))

describe('release pins', () => {
  const nvmrc = read('.nvmrc').trim()

  it('every workflow, and the action they share, sets up the Node .nvmrc names', () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/)
    const actions = readdirSync(join(ROOT, '.github', 'actions')).map((name) => `.github/actions/${name}/action.yml`)
    const files = [...workflows.map((name) => `.github/workflows/${name}`), ...actions]
    const pins = files.flatMap((file) => [...read(file).matchAll(/runtime:\s*node@(\S+)/g)].map((match) => ({ file, version: match[1] })))
    // Every one of them sets a runtime up at least once, or this would compare nothing.
    expect(new Set(pins.map((pin) => pin.file)).size, `files with a runtime pin: ${pins.map((pin) => pin.file).join(', ')}`).toBe(files.length)
    expect(pins.filter((pin) => pin.version !== nvmrc)).toEqual([])
    // setup-node, where it is used, reads the file itself: never a second literal.
    for (const file of files) expect(read(file), file).not.toMatch(/node-version:\s*['"]?\d/)
  })

  it('the gate runs on the Node the desktop app bundles, and the live desktop test expects that one', () => {
    const packer = read('desktop/scripts/package.ts')
    const bundled = /const NODE_VERSION = '([^']+)'/.exec(packer)?.[1]
    expect(bundled).toBe(nvmrc)
    expect(/const BUNDLED_NODE = 'v([^']+)'/.exec(read('desktop/e2e/live.e2e.test.ts'))?.[1]).toBe(bundled)
  })

  it('the installers have one name each, with no version in it, and a pinned Node for each platform', () => {
    const installers = (JSON.parse(read('desktop/release-assets.json')) as { installers: Record<string, string> }).installers
    const names = Object.values(installers)
    expect(names.length).toBeGreaterThanOrEqual(4)
    expect(new Set(names).size).toBe(names.length)
    // `releases/latest/download/<name>` needs a name that survives a release.
    for (const name of names) expect(name, name).not.toMatch(/\d+\.\d+\.\d+/)
    const packer = read('desktop/scripts/package.ts')
    const pinned = [...packer.matchAll(/'((?:win32|linux|darwin)-(?:x64|arm64))': '[0-9a-f]{64}'/g)].map((match) => match[1])
    expect(pinned.toSorted()).toEqual(Object.keys(installers).toSorted())
  })

  it('every desktop platform in the list is a leg of both workflows that build it', () => {
    const installers = (JSON.parse(read('desktop/release-assets.json')) as { installers: Record<string, string> }).installers
    // One runner label per platform key; the Intel label is an image GitHub will retire (ARCHITECTURE §13).
    const runner: Record<string, string> = { 'win32-x64': 'windows-latest', 'linux-x64': 'ubuntu-latest', 'darwin-arm64': 'macos-latest', 'darwin-x64': 'macos-15-intel' }
    expect(Object.keys(runner).toSorted()).toEqual(Object.keys(installers).toSorted())
    for (const name of ['check.yml', 'release.yml']) {
      const text = read(`.github/workflows/${name}`)
      // The desktop job's matrix, the one that names the Intel image.
      const matrix = /os: \[([^\]]*macos-15-intel[^\]]*)\]/.exec(text)?.[1]
      expect(matrix, `${name} has no desktop matrix naming every platform`).toBeDefined()
      for (const label of Object.values(runner)) expect(matrix, `${name}: ${label}`).toContain(label)
      expect(text, `${name} must run the shared desktop leg`).toContain('uses: ./.github/actions/desktop-leg')
    }
  })

  // release.yml publishes only for a commit an UNFILTERED live.yml run passed,
  // and tells one by its title. The title is made in live.yml and matched in
  // release.yml: renamed on one side only, no run could ever satisfy the
  // guard (the first tag would stop in the gate); matched loosely, a run
  // filtered down to one arc would satisfy it.
  it('the release guard matches exactly the title live.yml gives an unfiltered run', () => {
    const name = /^run-name: "live: \$\{\{ inputs\.filter == '' && '([^']+)' \|\| format\('filter \{0\}', inputs\.filter\) \}\}"$/m.exec(read('.github/workflows/live.yml'))
    expect(name, 'live.yml no longer names its runs "live: <unfiltered name>" or "live: filter <text>"').not.toBeNull()
    const unfiltered = `live: ${name![1]}`
    // A filtered run's name starts with "filter" whatever was typed, so no filter can spell the unfiltered one.
    expect(unfiltered.startsWith('live: filter')).toBe(false)
    const selects = [...read('.github/workflows/release.yml').matchAll(/select\(\.display_title ([^)]*)\)/g)].map((match) => match[1])
    expect(selects, 'how release.yml picks the live.yml runs that count').toEqual([`== "${unfiltered}"`])
  })

  // "check.yml passed" stands for every platform, and "live.yml passed" for
  // both hosts that can confine a shell: a leg dropped from either matrix
  // keeps the release guard green and the claim false.
  it('check.yml gates the three platforms and live.yml the two that can confine, with the whole gate and the install smoke', () => {
    const gate = job(read('.github/workflows/check.yml'), 'check')
    expect(osMatrix(gate).toSorted()).toEqual(['macos-latest', 'ubuntu-latest', 'windows-latest'])
    expect(gate).toMatch(/^\s+- run: pnpm check$/m)
    expect(gate).toContain('scripts/smoke-installed.sh')
    const arcs = job(read('.github/workflows/live.yml'), 'arcs')
    expect(osMatrix(arcs).toSorted()).toEqual(['macos-latest', 'ubuntu-latest'])
    expect(arcs).toMatch(/^\s+- run: pnpm test:e2e \$FILTER$/m)
  })

  // A MINIDSH_EXPECT_* flag is the only thing that turns a suite's self-skip
  // into a failure, and a skip and a pass look the same in a summary. So what
  // each workflow sets is pinned, value included ('0' would read as set).
  it('every workflow sets the MINIDSH_EXPECT_* flags its suites need, and no flag a suite reads is set nowhere', () => {
    const one = "'1'"
    const expected: Record<string, Record<string, string>> = {
      // Windows ships no confining backend and is not asked to prove one (ARCHITECTURE §13).
      '.github/workflows/check.yml': { MINIDSH_EXPECT_CONFINEMENT: "${{ (runner.os == 'Linux' || runner.os == 'macOS') && '1' || '' }}", MINIDSH_EXPECT_SHELL: one, MINIDSH_EXPECT_PYTHON: one, MINIDSH_EXPECT_BROWSER: one },
      '.github/workflows/release.yml': { MINIDSH_EXPECT_CONFINEMENT: one, MINIDSH_EXPECT_SHELL: one, MINIDSH_EXPECT_PYTHON: one, MINIDSH_EXPECT_BROWSER: one },
      '.github/workflows/live.yml': { MINIDSH_EXPECT_CONFINEMENT: one, MINIDSH_EXPECT_BROWSER: one, MINIDSH_EXPECT_KEYS: "'DEEPSEEK_API_KEY,ANTHROPIC_API_KEY'" },
      '.github/actions/desktop-leg/action.yml': { MINIDSH_EXPECT_DESKTOP: one },
    }
    const set = Object.fromEntries(Object.keys(expected).map((file) => [file, Object.fromEntries([...read(file).matchAll(/^\s+(MINIDSH_EXPECT_[A-Z_]+): (.+)$/gm)].map((match) => [match[1]!, match[2]!]))]))
    expect(set).toEqual(expected)
    // The other direction: a flag some suite reads, which no workflow sets, fails no skip anywhere.
    const named = new Set<string>()
    for (const root of ['src', 'desktop/src', 'desktop/e2e', 'scripts', 'skills']) {
      for (const file of sources(join(ROOT, root))) {
        if (file === import.meta.filename) continue
        for (const match of readFileSync(file, 'utf8').matchAll(/MINIDSH_EXPECT_[A-Z]+(?:_[A-Z]+)*/g)) named.add(match[0])
      }
    }
    const everywhere = new Set(Object.values(expected).flatMap((flags) => Object.keys(flags)))
    expect([...named].toSorted(), 'the flags the suites name, against the flags the workflows set').toEqual([...everywhere].toSorted())
  })

  // The release notes are the CHANGELOG section for the version, cut out by
  // release.yml's assemble job, which runs after the gate and four desktop
  // legs on a pushed tag: a missing section is found here instead.
  it('the CHANGELOG has a section for the version package.json names', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version
    const sections = [...read('CHANGELOG.md').matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1])
    expect(sections, `CHANGELOG.md sections, looking for ${version}`).toContain(version)
  })

  // What `npm pack` ships is this list and nothing else decides it: NOTICE is
  // the attribution the licence asks to travel with the code, and the smoke
  // of the installed package looks for both files too.
  it('the package ships its licence and its notice beside the code, and the install smoke looks for both', () => {
    const files = (JSON.parse(read('package.json')) as { files: string[] }).files
    expect(files.toSorted()).toEqual(['LICENSE', 'NOTICE', 'README.md', 'bin', 'dist', 'skills'])
    for (const shipped of ['LICENSE', 'NOTICE', 'README.md', 'bin/minidsh.js']) expect(existsSync(join(ROOT, shipped)), shipped).toBe(true)
    const smoke = read('scripts/smoke-installed.sh')
    for (const file of ['LICENSE', 'NOTICE']) expect(smoke, file).toContain(`test -s "$PKG/${file}"`)
  })

  // The one step that proves the INSTALLED package does real work lets a
  // model loose in a workspace with --approve and then judges what it left.
  // The judge must be a test the model could not edit: run from the
  // workspace's own copy, a model that rewrote the test passed the step.
  it('the installed-package live step judges the agent with a test kept outside its workspace', () => {
    const step = read('.github/workflows/live.yml').split('- name: Do real work through the INSTALLED package, not the checkout')[1]
    expect(step, 'live.yml has no installed-package step').toBeDefined()
    const lines = step!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    const agent = lines.findIndex((line) => line.includes('minidsh.js run '))
    const judgeMade = lines.findIndex((line) => line.endsWith('> ../judge/slug.test.mjs'))
    expect({ judgeMadeBeforeTheAgentRuns: judgeMade >= 0 && judgeMade < agent, agentWorksIn: /--cwd (\S+)/.exec(lines[agent] ?? '')?.[1] }).toEqual({ judgeMadeBeforeTheAgentRuns: true, agentWorksIn: '../ws' })
    expect(lines).toContain('judge() { (cd ../judge && node --test slug.test.mjs); }')
    // After the agent, the judge and nothing else decides: no test run from the workspace's copy.
    expect(lines.slice(agent + 1)).toEqual(['judge'])
    // And the same judge is what must fail before the agent runs.
    expect(lines.slice(0, agent)).toContain('if judge > /dev/null 2>&1; then')
  })

  // "Electron main runs no user code" is these fuses (ARCHITECTURE §9): asked
  // for in the packer, read back from the packed binary on every desktop leg.
  it('the packer turns off every fuse the desktop leg then reads back as off', () => {
    const block = /electronFuses: \{([\s\S]*?)\n {4}\},/.exec(read('desktop/scripts/package.ts'))?.[1]
    expect(block, 'package.ts has no electronFuses block').toBeDefined()
    const asked = Object.fromEntries([...block!.matchAll(/^\s+(\w+): (true|false),$/gm)].map((match) => [match[1]!, match[2]!]))
    expect(Object.fromEntries(FUSES_THAT_MUST_BE_OFF.map((name) => [name, asked[name]]))).toEqual(Object.fromEntries(FUSES_THAT_MUST_BE_OFF.map((name) => [name, 'false'])))
    const leg = read('.github/actions/desktop-leg/action.yml')
    const smoked = leg.indexOf('node desktop/scripts/smoke-runtime.ts "$RESOURCES"')
    const fused = leg.indexOf('run: node desktop/scripts/check-fuses.ts "$MINIDSH_DESKTOP_EXE"')
    expect({ smoked: smoked >= 0, fused: fused > smoked }, 'the leg smokes the runtime, then reads the fuses').toEqual({ smoked: true, fused: true })
  })
})

/** One job of a workflow: from its key to the next job's. */
function job(text: string, name: string): string {
  const start = text.search(new RegExp(`^  ${name}:$`, 'm'))
  if (start < 0) throw new Error(`no job named ${name}`)
  const rest = text.slice(start + 1)
  const next = rest.search(/^  [a-z][\w-]*:$/m)
  return next < 0 ? rest : rest.slice(0, next)
}

/** The runner labels of a job's `os` matrix. */
function osMatrix(block: string): string[] {
  const list = /^\s+os: \[([^\]]*)\]$/m.exec(block)?.[1]
  if (list === undefined) throw new Error('the job has no os matrix')
  return list.split(',').map((label) => label.trim())
}

/** Every source file under a directory, dependencies left out. */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(ts|js|mjs|cjs|sh)$/.test(entry.name)) out.push(full)
  }
  return out
}
