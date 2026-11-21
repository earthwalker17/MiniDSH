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
import { toolEditorPlugin, type EditorConfig } from './index.ts'

let harness: CoreHarness | undefined
let workdir: string | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
  if (workdir) rmSync(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function setup(config?: EditorConfig): Promise<{ agent: Agent; run: (args: object) => Promise<{ isError: boolean; text: string }>; dir: string }> {
  workdir = mkdtempSync(join(tmpdir(), 'minidsh-editor-'))
  harness = await coreHarness()
  harness.root.plugin(fsLocalPlugin)
  harness.root.plugin(fsObservationPolicyPlugin)
  harness.root.plugin(toolEditorPlugin, config)
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

  // S20.5 review: the bounded read decoded with a TextDecoder, which drops a
  // BOM, so every edit rewrote a BOM file without one (a .ps1 then reads as ANSI).
  it('keeps a UTF-8 BOM through a replacement and an insert', async () => {
    const { run, dir } = await setup()
    const file = join(dir, 'build.ps1')
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('$x = 1\n', 'utf8')]))
    await run({ command: 'view', path: file })
    expect((await run({ command: 'str_replace', path: file, old_str: '$x = 1', new_str: '$x = 2' })).isError).toBe(false)
    expect((await run({ command: 'insert', path: file, insert_line: 1, new_str: '$y = 3' })).isError).toBe(false)
    const bytes = readFileSync(file)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe('$x = 2\n$y = 3\n')
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

/**
 * An edit writes the whole file back as UTF-8, so a file that is NOT UTF-8
 * had every byte outside ASCII rewritten as U+FFFD by an edit that touched
 * one ASCII word, and the tool said "Edited" (S22.5 audit, reproduced on a
 * GBK source file). The proof is the bytes on disk, never the tool's word.
 */
describe('str_replace_editor: a file that is not UTF-8', () => {
  // `// 中文` in GBK (CP936), then an ASCII line: what a source file saved as
  // ANSI on a Chinese Windows holds.
  const gbk = Buffer.concat([Buffer.from([0x2f, 0x2f, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]), Buffer.from('const x = 1\n', 'ascii')])

  for (const edit of [
    { command: 'str_replace', old_str: 'x = 1', new_str: 'x = 2' },
    { command: 'insert', insert_line: 1, new_str: 'const y = 3' },
  ]) {
    it(`refuses ${edit.command} and leaves every byte as it was, saying why and what can still edit it`, async () => {
      const { agent, run, dir } = await setup()
      const file = join(dir, 'legacy.js')
      writeFileSync(file, gbk)
      // It can still be LOOKED at: a read changes nothing.
      expect((await run({ command: 'view', path: file })).isError).toBe(false)
      const refused = await run({ ...edit, path: file })
      expect(refused.isError, refused.text).toBe(true)
      expect(refused.text).toContain('not valid UTF-8')
      expect(refused.text).toContain('shell')
      expect([...readFileSync(file)], 'the file on disk changed under a refused edit').toEqual([...gbk])
      expect(agent.session.facts.filter((event) => event.type === 'effect/recorded')).toHaveLength(0)
    })
  }

  it('still edits a UTF-8 file that holds the same characters', async () => {
    const { run, dir } = await setup()
    const file = join(dir, 'modern.js')
    writeFileSync(file, '// 中文\nconst x = 1\n', 'utf8')
    await run({ command: 'view', path: file })
    expect((await run({ command: 'str_replace', path: file, old_str: 'x = 1', new_str: 'x = 2' })).isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('// 中文\nconst x = 2\n')
  })
})

/**
 * A model reads and writes "\n". A Windows checkout with `core.autocrlf` is
 * CRLF throughout, and there an insert landed a bare "\n" among CRLF lines and
 * a multi-line old_str copied from the view matched nothing (S22.5 audit; this
 * project's own tree is LF, so no test had ever met such a file). Each fixture
 * is written by its test, and each assertion is the exact text on disk.
 */
describe('str_replace_editor: line endings', () => {
  it('keeps a CRLF file CRLF: shown without carriage returns, matched and written with them', async () => {
    const { run, dir } = await setup()
    const file = join(dir, 'crlf.txt')
    writeFileSync(file, 'a\r\nb\r\nc\r\n')

    const view = await run({ command: 'view', path: file })
    expect(view.text).toContain('     1  a\n     2  b\n     3  c\n')
    expect(view.text, 'a carriage return reached the model').not.toContain('\r')

    expect((await run({ command: 'insert', path: file, insert_line: 1, new_str: 'x' })).isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('a\r\nx\r\nb\r\nc\r\n')

    // Two lines at once, written the way a model writes them.
    expect((await run({ command: 'insert', path: file, insert_line: 0, new_str: 'y\nz' })).isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('y\r\nz\r\na\r\nx\r\nb\r\nc\r\n')

    // An old_str that spans lines, copied from the view, and a new_str that adds one.
    const edited = await run({ command: 'str_replace', path: file, old_str: 'a\nx\nb', new_str: 'A\nX\nmore\nB' })
    expect(edited.isError, edited.text).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('y\r\nz\r\nA\r\nX\r\nmore\r\nB\r\nc\r\n')
  })

  it('uses an old_str and a new_str that already spell CRLF as given', async () => {
    const { run, dir } = await setup()
    const file = join(dir, 'crlf.txt')
    writeFileSync(file, 'a\r\nb\r\nc\r\n')
    await run({ command: 'view', path: file })
    const edited = await run({ command: 'str_replace', path: file, old_str: 'a\r\nb', new_str: 'p\r\nq' })
    expect(edited.isError, edited.text).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('p\r\nq\r\nc\r\n')
  })

  it('counts a multi-line old_str in a CRLF file as it will be matched, so an ambiguous one is still refused', async () => {
    const { run, dir } = await setup()
    const file = join(dir, 'crlf.txt')
    writeFileSync(file, 'a\r\nb\r\na\r\nb\r\n')
    await run({ command: 'view', path: file })
    const edited = await run({ command: 'str_replace', path: file, old_str: 'a\nb', new_str: 'x' })
    expect(edited.isError).toBe(true)
    expect(edited.text).toContain('appears 2 times')
    expect(readFileSync(file, 'utf8')).toBe('a\r\nb\r\na\r\nb\r\n')
  })

  it('edits an LF file exactly as given, a carriage return in new_str included', async () => {
    const { run, dir } = await setup()
    const file = join(dir, 'lf.txt')
    writeFileSync(file, 'a\nb\nc\n')
    const view = await run({ command: 'view', path: file })
    expect(view.text).toContain('     1  a\n     2  b\n     3  c\n')
    expect((await run({ command: 'insert', path: file, insert_line: 1, new_str: 'x' })).isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('a\nx\nb\nc\n')
    expect((await run({ command: 'str_replace', path: file, old_str: 'x\nb', new_str: 'y\r\nz' })).isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('a\ny\r\nz\nc\n')
  })

  it('edits a file that mixes both byte for byte: nothing is converted, in either direction', async () => {
    const { run, dir } = await setup()
    const file = join(dir, 'mixed.txt')
    writeFileSync(file, 'a\r\nb\nc\r\n')
    // Shown as it is: the carriage returns are part of what an old_str must spell.
    expect((await run({ command: 'view', path: file })).text).toContain('     1  a\r\n     2  b\n     3  c\r\n')
    const missed = await run({ command: 'str_replace', path: file, old_str: 'a\nb', new_str: 'q' })
    expect(missed.isError).toBe(true)
    expect(missed.text).toContain('did not appear')
    expect((await run({ command: 'insert', path: file, insert_line: 1, new_str: 'x' })).isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('a\r\nx\nb\nc\r\n')
    expect((await run({ command: 'str_replace', path: file, old_str: 'b\nc', new_str: 'B\nC' })).isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('a\r\nx\nB\nC\r\n')
  })
})

describe('str_replace_editor: what a view may cost the context', () => {
  /**
   * A clip counts UTF-16 units, and an emoji is two: cut between them, the
   * result ends in half a character, which no provider accepts in a request
   * (core replaces it with U+FFFD on the way to the log, and the character is
   * lost either way). The two files differ by one leading unit, so the clip
   * falls inside a pair in exactly one of them, whatever the header's length.
   */
  it('never clips a view through the middle of a character', async () => {
    const max = 400
    const { run, dir } = await setup({ maxOutputChars: max })
    const emoji = '\u{1F600}'
    const heads: string[] = []
    for (const [name, lead] of [['a.txt', ''], ['b.txt', 'x']] as const) {
      writeFileSync(join(dir, name), lead + emoji.repeat(max), 'utf8')
      const view = await run({ command: 'view', path: join(dir, name) })
      const clipAt = view.text.indexOf('\n<response clipped>')
      expect(clipAt, `${name} was not clipped: ${view.text.length} characters`).toBeGreaterThan(0)
      const head = view.text.slice(0, clipAt)
      expect(head.isWellFormed(), `${name} ends in half a character`).toBe(true)
      expect(head, `${name}: half a character was replaced on its way out`).not.toContain('�')
      expect(head.endsWith(emoji), `${name} ends in ${JSON.stringify(head.slice(-2))}`).toBe(true)
      heads.push(head)
    }
    // The positive control: one clip really did land inside a pair and gave up one unit.
    expect(heads.map((head) => head.length).toSorted(), `clipped lengths ${heads.map((head) => head.length).join(' and ')} for a bound of ${max}`).toEqual([max - 1, max])
  })

  // A cache or dataset directory holds hundreds of thousands of names, and the
  // listing was returned whole: megabytes in one result every later request replays.
  it('clips a directory listing at the same bound, and says how many entries it left out', async () => {
    const max = 400
    const { run, dir } = await setup({ maxOutputChars: max })
    const names = Array.from({ length: 120 }, (_, index) => `chunk-${String(index).padStart(4, '0')}.bin`)
    for (const name of names) writeFileSync(join(dir, name), '')
    const view = await run({ command: 'view', path: dir })
    expect(view.isError).toBe(false)
    const shown = view.text.split('\n').filter((line) => line.startsWith('chunk-'))
    // Whole names only, in order from the first.
    expect(shown).toEqual(names.slice(0, shown.length))
    const counted = `${shown.length} of ${names.length} names shown under a bound of ${max}, in ${view.text.length} characters`
    expect(shown.length, counted).toBeGreaterThan(0)
    expect(shown.length, counted).toBeLessThan(names.length)
    expect(view.text).toContain(`[${names.length - shown.length} more of ${names.length} entries not shown`)
    expect(view.text.length, `a listing of ${view.text.length} characters for a bound of ${max}`).toBeLessThan(max + 200)
  })

  it('lists a small directory whole, with no clip line', async () => {
    const { run, dir } = await setup()
    writeFileSync(join(dir, 'one.txt'), '')
    writeFileSync(join(dir, 'two.txt'), '')
    const view = await run({ command: 'view', path: dir })
    expect(view.text.endsWith(':\none.txt\ntwo.txt'), view.text).toBe(true)
  })
})
