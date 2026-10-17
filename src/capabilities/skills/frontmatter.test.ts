/**
 * The front-matter subset. What is pinned: the forms real SKILL.md files use
 * (plain, quoted, folded, literal, continued), that every key but three is
 * skipped whole, and that the two refusals are the only ones — a file with no
 * fence, and a hide flag that is not a boolean.
 */
import { describe, expect, it } from 'vitest'
import { isSkillName, parseSkillFile, type SkillFrontmatter } from './frontmatter.ts'

function fm(text: string): SkillFrontmatter {
  const parsed = parseSkillFile(text)
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.reason}`)
  return parsed.frontmatter
}

describe('the fence', () => {
  it('reads name and description from a plain front-matter block', () => {
    expect(fm('---\nname: pdf\ndescription: Read and create PDF files.\n---\n# Body\n')).toEqual({
      name: 'pdf',
      description: 'Read and create PDF files.',
      disableModelInvocation: false,
    })
  })

  it('tolerates a BOM, CRLF line ends and a YAML document end marker', () => {
    expect(fm('\uFEFF---\r\nname: office\r\ndescription: Word files.\r\n...\r\nbody')).toMatchObject({ name: 'office', description: 'Word files.' })
  })

  it('refuses a file without a fence on its first line, and an unterminated one', () => {
    expect(parseSkillFile('\n---\nname: x\n---\n')).toEqual({ ok: false, reason: expect.stringContaining('no front-matter') })
    expect(parseSkillFile('# Just markdown\n')).toMatchObject({ ok: false })
    expect(parseSkillFile('---\nname: x\ndescription: y\n')).toEqual({ ok: false, reason: expect.stringContaining('unterminated') })
  })

  it('reads an empty block as no name and no description, not as a refusal', () => {
    expect(fm('---\n---\n')).toEqual({ name: undefined, description: undefined, disableModelInvocation: false })
  })
})

describe('scalars', () => {
  it('keeps everything after the first ": " in a plain value, as the open client guide recommends', () => {
    expect(fm('---\ndescription: Use when: the user asks for a report\n---\n').description).toBe('Use when: the user asks for a report')
  })

  it('strips a trailing comment from a plain value but not a # inside a word', () => {
    expect(fm('---\nname: csharp # the C# helper\ndescription: C# tips and tricks\n---\n')).toMatchObject({ name: 'csharp', description: 'C# tips and tricks' })
  })

  it('reads single- and double-quoted values with their escapes', () => {
    expect(fm(`---\nname: 'it''s'\ndescription: "Tab\\tand \\"quotes\\" \\u00e9"\n---\n`)).toMatchObject({ name: "it's", description: 'Tab\tand "quotes" é' })
  })

  it('folds a quoted value that continues over indented lines', () => {
    expect(fm('---\ndescription: "Create documents\n  and check them"\n---\n').description).toBe('Create documents and check them')
  })

  it('joins an escaped line break with nothing between the lines', () => {
    expect(fm('---\ndescription: "abc\\\n  def"\n---\n').description).toBe('abcdef')
  })

  it('reads a folded block scalar as one paragraph', () => {
    expect(fm('---\ndescription: >\n  Create, read and edit\n  spreadsheets.\n\n  Second paragraph.\n---\n').description).toBe('Create, read and edit spreadsheets.\nSecond paragraph.')
  })

  it('reads a literal block scalar with its line breaks, and a chomping indicator', () => {
    expect(fm('---\ndescription: |-\n  line one\n  line two\n---\n').description).toBe('line one\nline two')
  })

  it('folds a plain value that continues on indented lines', () => {
    expect(fm('---\ndescription: Build decks\n  from outlines.\nname: pptx\n---\n')).toMatchObject({ description: 'Build decks from outlines.', name: 'pptx' })
  })

  it('reads a plain value that starts on the next line', () => {
    expect(fm('---\ndescription:\n  Starts below\n  the key.\n---\n').description).toBe('Starts below the key.')
  })

  it('refuses an escape past U+10FFFF or a lone surrogate instead of throwing', () => {
    expect(parseSkillFile('---\ndescription: "\\U00110000"\n---\n')).toMatchObject({ ok: false })
    expect(parseSkillFile('---\ndescription: "\\ud800"\n---\n')).toMatchObject({ ok: false })
    expect(fm('---\ndescription: "\\U0001F600"\n---\n').description).toBe('\u{1F600}')
  })

  it('refuses an unterminated quote rather than guessing where it ends', () => {
    expect(parseSkillFile('---\ndescription: "never closed\n---\n')).toMatchObject({ ok: false })
  })
})

describe('keys the runtime does not read', () => {
  it('skips nested maps, lists and every other key whole', () => {
    const parsed = fm(
      [
        '---',
        'name: office',
        'license: MIT',
        'allowed-tools: Bash(node:*) Read',
        'metadata:',
        '  minidsh-reviewed: "2026-10-18"',
        '  description: not the skill description',
        'compatibility: Node 24',
        'tags:',
        '  - documents',
        'description: The real one.',
        '---',
      ].join('\n'),
    )
    expect(parsed).toEqual({ name: 'office', description: 'The real one.', disableModelInvocation: false })
  })

  it('reads a sequence written at the key indent as that key value, not as a new key', () => {
    expect(fm('---\nallowed-tools:\n- Read\n- Bash\nname: tools\ndescription: d\n---\n')).toMatchObject({ name: 'tools', description: 'd' })
    expect(parseSkillFile('---\ndescription:\n- a\n- b\n---\n')).toEqual({ ok: false, reason: 'description is not a string' })
  })

  it('refuses a description that is a map, rather than listing a skill with nonsense', () => {
    expect(parseSkillFile('---\ndescription:\n  text: no\n---\n')).toEqual({ ok: false, reason: 'description is not a string' })
  })

  it('refuses an unreadable top-level line', () => {
    expect(parseSkillFile('---\nname office\n---\n')).toMatchObject({ ok: false, reason: expect.stringContaining('unreadable') })
  })
})

describe('disable-model-invocation', () => {
  it('reads the boolean spellings authors use', () => {
    for (const yes of ['true', 'True', 'yes', 'on', '1']) expect(fm(`---\ndisable-model-invocation: ${yes}\n---\n`).disableModelInvocation).toBe(true)
    for (const no of ['false', 'no', 'off', '0']) expect(fm(`---\ndisable-model-invocation: ${no}\n---\n`).disableModelInvocation).toBe(false)
  })

  it('refuses a value that is not a boolean: a guess could list what its author hid', () => {
    expect(parseSkillFile('---\ndisable-model-invocation: sometimes\n---\n')).toEqual({ ok: false, reason: 'disable-model-invocation is not a boolean' })
  })
})

describe('isSkillName', () => {
  it('is the open format rule', () => {
    for (const ok of ['pdf', 'office', 'a1-b2', 'x'.repeat(64)]) expect(isSkillName(ok)).toBe(true)
    for (const bad of ['', 'PDF', '-pdf', 'pdf-', 'p--df', 'p_df', 'p df', 'p\ndf', 'x'.repeat(65)]) expect(isSkillName(bad)).toBe(false)
  })
})
