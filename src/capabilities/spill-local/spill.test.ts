/**
 * Large-output spill, asserted against the WORLD: the file exists, it holds the
 * whole output, and the model can read it back through the tool it already has.
 *
 * The rule under test is that spill is for output with NO OTHER HOME. Shell
 * output vanishes when the process exits, so it is saved; a file the model
 * asked to view is already on disk, so nothing is copied there.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { SANDBOX_MODE, type SandboxMode } from '../../core/sandbox/index.ts'
import { SPILL } from '../../core/spill/index.ts'
import { TOOLS, toolCall } from '../../core/tools/index.ts'
import { fsLocalPlugin } from '../fs-local/index.ts'
import { shellStdioPlugin, type ShellDialect } from '../shell-stdio/index.ts'
import { toolEditorPlugin } from '../tool-editor/index.ts'
import { toolShellPlugin } from '../tool-shell/index.ts'
import { spillLocalPlugin } from './index.ts'

const dialect: ShellDialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const toolName = dialect === 'pwsh' ? 'pwsh' : 'bash'
const binary = dialect === 'pwsh' ? 'pwsh' : 'bash'
const shellAvailable = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0

let harness: CoreHarness | undefined
const dirs: string[] = []
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Fixture {
  workspace: string
  spillRoot: string
  sessionId: string
  run(name: string, args: object): Promise<{ isError: boolean; text: string }>
  setMode(mode: SandboxMode): void
}

async function setup(options: { withSpill?: boolean; maxOutputChars?: number } = {}): Promise<Fixture> {
  const workspace = tempDir('minidsh-spill-ws-')
  const spillRoot = tempDir('minidsh-spill-root-')
  harness = await coreHarness()
  if (options.withSpill !== false) harness.root.plugin(spillLocalPlugin, { root: spillRoot })
  harness.root.plugin(fsLocalPlugin)
  harness.root.plugin(shellStdioPlugin, { dialect })
  harness.root.plugin(toolShellPlugin, { maxOutputChars: options.maxOutputChars ?? 400, tailChars: 100 })
  harness.root.plugin(toolEditorPlugin, {})
  await harness.root.settle()
  const { agent } = await harness.create({ cwd: workspace })
  const tools = harness.root.get(TOOLS)
  return {
    workspace,
    spillRoot,
    sessionId: agent.id,
    setMode: (mode) => void agent.session.append(SANDBOX_MODE, { mode, enforcement: 'none', reason: 'change' }),
    run: async (name, args) => {
      const result = await tools.execute(toolCall(`call-${Math.random().toString(36).slice(2, 8)}`, name, JSON.stringify(args), agent, new AbortController().signal))
      return { isError: result.isError, text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join('') }
    },
  }
}

describe('the spill store', () => {
  it('keeps a path inside it apart from one outside it', async () => {
    const fixture = await setup()
    const spill = harness!.root.get(SPILL)
    const ref = spill.save({ sessionId: fixture.sessionId, callId: 'c1', label: 'shell', text: 'hello' })
    expect(readFileSync(ref.path, 'utf8')).toBe('hello')
    expect(spill.contains(ref.path)).toBe(true)
    expect(spill.contains(join(fixture.workspace, 'anything.txt'))).toBe(false)
  })

  it('never lets a session id or label escape its directory', async () => {
    const fixture = await setup()
    const ref = harness!.root.get(SPILL).save({ sessionId: '../../escape', callId: '../../also', label: 'a/b\\c', text: 'x' })
    expect(ref.path.startsWith(fixture.spillRoot)).toBe(true)
    expect(ref.path).not.toContain('..')
  })
})

describe.skipIf(!shellAvailable)('the shell tool under a spill store', () => {
  it('shows a bounded excerpt and saves the whole output where the model can read it', async () => {
    const fixture = await setup()
    fixture.setMode('danger-full-access')
    // 600 numbered lines: far past the inline bound, and every line identifiable.
    const command = dialect === 'pwsh' ? '1..600 | ForEach-Object { "line-$_" }' : 'for i in $(seq 1 600); do echo "line-$i"; done'
    const result = await fixture.run(toolName, { command })

    expect(result.isError).toBe(false)
    // Head and tail both survive: the first lines say what ran, the last say how it ended.
    expect(result.text).toMatch(/(^|\r?\n)line-1\r?\n/)
    expect(result.text).toContain('line-600')
    // The middle is gone from the transcript, and says where it went.
    expect(result.text).not.toContain('line-300')
    expect(result.text).toContain('characters omitted')

    // The WORLD: one file, under the store, holding the whole thing.
    const sessionDirs = readdirSync(fixture.spillRoot)
    expect(sessionDirs).toHaveLength(1)
    const files = readdirSync(join(fixture.spillRoot, sessionDirs[0]!))
    expect(files).toHaveLength(1)
    const saved = readFileSync(join(fixture.spillRoot, sessionDirs[0]!, files[0]!), 'utf8')
    expect(saved).toContain('line-300')
    expect(saved.split('\n').filter((line) => line.startsWith('line-')).length).toBe(600)

    // The excerpt names that exact file.
    const match = /saved at (.+?) —/.exec(result.text)
    expect(match).not.toBeNull()
    expect(readFileSync(match![1]!.trim(), 'utf8')).toBe(saved)
  })

  it('lets the model read the spilled output back with the file viewer it already has, in every mode', async () => {
    const fixture = await setup()
    fixture.setMode('danger-full-access')
    const command = dialect === 'pwsh' ? '1..600 | ForEach-Object { "line-$_" }' : 'for i in $(seq 1 600); do echo "line-$i"; done'
    const spilled = await fixture.run(toolName, { command })
    const path = /saved at (.+?) —/.exec(spilled.text)![1]!.trim()

    // A spill file lives OUTSIDE the workspace. Reads are never fenced, so no
    // mode has to be widened and no new tool has to exist.
    for (const mode of ['workspace-write', 'read-only'] as const) {
      fixture.setMode(mode)
      const viewed = await fixture.run('str_replace_editor', { command: 'view', path, view_range: [295, 305] })
      expect(viewed.isError).toBe(false)
      expect(viewed.text).toContain('line-300')
    }
  })

  it('says what it dropped when no store is mounted, rather than pretending', async () => {
    const fixture = await setup({ withSpill: false })
    fixture.setMode('danger-full-access')
    const command = dialect === 'pwsh' ? '1..600 | ForEach-Object { "line-$_" }' : 'for i in $(seq 1 600); do echo "line-$i"; done'
    const result = await fixture.run(toolName, { command })
    expect(result.text).toContain('not retained')
    expect(result.text).not.toContain('saved at')
  })

  it('leaves output that fits exactly as it was', async () => {
    const fixture = await setup()
    fixture.setMode('danger-full-access')
    const command = dialect === 'pwsh' ? "Write-Output 'small output'" : "echo 'small output'"
    const result = await fixture.run(toolName, { command })
    expect(result.text.trim()).toBe('small output')
    expect(readdirSync(fixture.spillRoot)).toHaveLength(0)
  })
})

describe('the file viewer', () => {
  it('does not spill a file, because the file is already the retrieval path', async () => {
    const fixture = await setup()
    const big = join(fixture.workspace, 'big.txt')
    writeFileSync(big, Array.from({ length: 4000 }, (_unused, index) => `row-${index}`).join('\n'), 'utf8')

    const result = await fixture.run('str_replace_editor', { command: 'view', path: big })
    expect(result.isError).toBe(false)
    // Clipped with the range guidance it has always had — and nothing copied.
    expect(result.text).toContain('response clipped')
    expect(readdirSync(fixture.spillRoot)).toHaveLength(0)
  })
})
