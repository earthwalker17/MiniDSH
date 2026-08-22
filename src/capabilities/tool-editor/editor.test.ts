import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { TOOLS, toolCall } from '../../core/tools/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { fsLocalPlugin } from '../fs-local/index.ts'
import { fsObservationPolicyPlugin } from '../fs-observation-policy/index.ts'
import { toolEditorPlugin } from './index.ts'

let harness: CoreHarness | undefined
let workdir: string | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  if (workdir) rmSync(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function setup(): Promise<{ agent: Agent; run: (args: object) => Promise<{ isError: boolean; text: string }>; dir: string }> {
  workdir = mkdtempSync(join(tmpdir(), 'minidsh-editor-'))
  harness = await coreHarness()
  harness.root.plugin(fsLocalPlugin)
  harness.root.plugin(fsObservationPolicyPlugin)
  harness.root.plugin(toolEditorPlugin)
  await harness.root.settle()
  const { agent } = await harness.create({ cwd: workdir })
  const tools = harness.root.get(TOOLS)
  const run = async (args: object) => {
    const result = await tools.execute(toolCall('c', 'str_replace_editor', JSON.stringify(args), agent, new AbortController().signal))
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    return { isError: result.isError, text }
  }
  return { agent, run, dir: workdir }
}

describe('str_replace_editor', () => {
  it('creates a file and refuses to overwrite it', async () => {
    const { run, dir } = await setup()
    const created = await run({ command: 'create', path: join(dir, 'a.txt'), file_text: 'hello\n' })
    expect(created.isError).toBe(false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello\n')
    const again = await run({ command: 'create', path: join(dir, 'a.txt'), file_text: 'x' })
    expect(again.isError).toBe(true)
  })

  it('views a file with line numbers', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'b.txt'), 'one\ntwo\nthree\n')
    const view = await run({ command: 'view', path: join(dir, 'b.txt') })
    expect(view.text).toContain('     1  one')
    expect(view.text).toContain('     3  three')
  })

  it('enforces read-before-edit, then performs a unique replacement', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'c.txt'), 'alpha beta\n')
    const blind = await run({ command: 'str_replace', path: join(dir, 'c.txt'), old_str: 'beta', new_str: 'gamma' })
    expect(blind.isError).toBe(true)
    expect(blind.text).toContain('reading')
    await run({ command: 'view', path: join(dir, 'c.txt') })
    const edit = await run({ command: 'str_replace', path: join(dir, 'c.txt'), old_str: 'beta', new_str: 'gamma' })
    expect(edit.isError).toBe(false)
    expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('alpha gamma\n')
  })

  it('rejects an ambiguous replacement', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'd.txt'), 'x x x\n')
    await run({ command: 'view', path: join(dir, 'd.txt') })
    const edit = await run({ command: 'str_replace', path: join(dir, 'd.txt'), old_str: 'x', new_str: 'y' })
    expect(edit.isError).toBe(true)
    expect(edit.text.toLowerCase()).toContain('unique')
  })
})
