import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { TOOLS, toolCall } from '../../core/tools/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { canonicalPath } from '../../core/sandbox/index.ts'
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

/**
 * The effect, on the record. Written by the PROVIDER after the write lands,
 * from what it wrote — so a resumed session can read the file back and tell a
 * landed write from a lost one without trusting any tool's account of itself.
 */
describe('str_replace_editor: what the log says actually happened', () => {
  const effects = (agent: Agent): { callId: string; effect: string; path: string; bytes: number; sha256: string }[] =>
    agent.session.facts
      .filter((event) => event.type === 'effect/recorded')
      .map((event) => event.data as { callId: string; effect: string; path: string; bytes: number; sha256: string })

  it('records the canonical path, the byte count and a hash of exactly what was written', async () => {
    const { agent, run, dir } = await setup()
    const text = 'hello\n'
    await run({ command: 'create', path: join(dir, 'a.txt'), file_text: text })

    const [record, ...rest] = effects(agent)
    expect(rest).toHaveLength(0)
    expect(record).toMatchObject({ callId: 'c', effect: 'fs-write', bytes: Buffer.byteLength(text, 'utf8') })
    // The hash is of the bytes on disk, checkable from outside the runtime.
    expect(record!.sha256).toBe(createHash('sha256').update(readFileSync(record!.path)).digest('hex'))
    // The CANONICAL path the fence approved, never the model's spelling.
    expect(record!.path).toBe(canonicalPath(join(dir, 'a.txt')))
  })

  it('records nothing for a write the fence refused, because nothing happened', async () => {
    const { agent, run } = await setup()
    const outside = mkdtempSync(join(tmpdir(), 'minidsh-editor-outside-'))
    try {
      const refused = await run({ command: 'create', path: join(outside, 'escape.txt'), file_text: 'x' })
      expect(refused.isError).toBe(true)
      expect(effects(agent)).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // `String.prototype.replace` reads `$$`, `$&`, `$'` and `` $` `` in a STRING
  // replacement as patterns, so a shell script's `$$` landed as `$` and
  // `$'\n'` pulled in the rest of the file, while the tool said "Edited"
  // (S20.5 audit, A6-05).
  it('writes new_str exactly as given, dollar patterns included', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'run.sh'), 'echo start\nPLACEHOLDER\necho end\n')
    await run({ command: 'view', path: join(dir, 'run.sh') })
    const newStr = 'echo "pid $$"; IFS=$\'\\n\'; cost="$&"; before="$`"'
    const edited = await run({ command: 'str_replace', path: join(dir, 'run.sh'), old_str: 'PLACEHOLDER', new_str: newStr })
    expect(edited.isError).toBe(false)
    expect(readFileSync(join(dir, 'run.sh'), 'utf8')).toBe(`echo start\n${newStr}\necho end\n`)
  })

  // One view of a ~130 MiB file aborted the host on V8's heap and ~100 MiB
  // blocked its loop for ~30 s: the whole file was read, split and numbered
  // before 16,000 characters were shown (S20.5 audit, A6-02). The cost of a
  // view is now bounded by what it reads, and it says what it left out.
  it('views a file far larger than it will show by reading a bounded prefix, and says so', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'huge.log'), 'a log line\n'.repeat(2_000_000))
    const view = await run({ command: 'view', path: join(dir, 'huge.log') })
    expect(view.isError).toBe(false)
    expect(view.text).toContain('     1  a log line')
    expect(view.text).toMatch(/the first [\d,]+ bytes of [\d,]+/)
    expect(view.text.length).toBeLessThan(20_000)
    const edit = await run({ command: 'str_replace', path: join(dir, 'huge.log'), old_str: 'nothing', new_str: 'x' })
    expect(edit.isError).toBe(true)
    expect(edit.text).toContain('larger than')
  })

  // A refused edit's own read used to OBSERVE the new content, so the same
  // call repeated was accepted against content the model was never shown
  // (S20.5 audit, A6-11): an observation is a licence to overwrite.
  it('does not let a stale refusal license the retry', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'd.txt'), 'one two\n')
    await run({ command: 'view', path: join(dir, 'd.txt') })
    writeFileSync(join(dir, 'd.txt'), 'one two three, changed by someone else\n')
    const first = await run({ command: 'str_replace', path: join(dir, 'd.txt'), old_str: 'two', new_str: '2' })
    expect(first.text).toContain('changed since it was read')
    const retry = await run({ command: 'str_replace', path: join(dir, 'd.txt'), old_str: 'two', new_str: '2' })
    expect(retry.text).toContain('changed since it was read')
    expect(readFileSync(join(dir, 'd.txt'), 'utf8')).toBe('one two three, changed by someone else\n')
  })

  it('refuses an empty old_str, which matches everywhere or nowhere', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'e.txt'), '')
    await run({ command: 'view', path: join(dir, 'e.txt') })
    const edited = await run({ command: 'str_replace', path: join(dir, 'e.txt'), old_str: '', new_str: 'x' })
    expect(edited.isError).toBe(true)
    expect(readFileSync(join(dir, 'e.txt'), 'utf8')).toBe('')
  })
})
