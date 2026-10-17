/**
 * The bundled skills under the package's `skills/` — data the runtime never
 * names, so they are tested here, from app assembly, and nowhere below it.
 *
 * Two kinds of check. FORMAT: each skill parses through the runtime's own
 * front-matter reader, is named for its directory, fits the size a model's
 * file reader shows without cutting (8,192 characters rendered with line
 * numbers, the rule DSH's pruner taught), names only files that exist, and
 * keeps its helpers to `node:` imports and its own directory. BEHAVIOUR: the
 * helpers run as a model would run them — `node <helper>` from a workspace —
 * and what they write is reopened: by the helper's own `read`, by a ZIP and
 * XML reader written here, and by Python's `zipfile` and `xml.dom.minidom`, a
 * reader that shares no code with the writer. Two PDFs that real software
 * wrote on this host (Edge's print-to-PDF and Word's Save as PDF, checked in
 * under `test-support/fixtures/pdf`) pin the reader to files nobody here
 * shaped.
 *
 * Python is optional on a developer machine and required in CI:
 * `MINIDSH_EXPECT_PYTHON=1` turns its absence into a failure.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { crc32, deflateSync, inflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isSkillName, parseSkillFile } from '../capabilities/skills/frontmatter.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const SKILLS = join(ROOT, 'skills')
const OFFICE = join(SKILLS, 'office', 'scripts', 'office.mjs')
const PDF = join(SKILLS, 'pdf', 'scripts', 'pdf.mjs')
const FIXTURES = join(ROOT, 'src', 'test-support', 'fixtures', 'pdf')
/** What a model's file reader shows before it starts cutting: the bound every SKILL.md and reference keeps. */
const RENDERED_LIMIT = 8192

const skillDirs = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .toSorted()

interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function run(script: string, args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 60_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function ok(result: Run): string {
  if (result.status !== 0) throw new Error(`helper exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

const json = (result: Run): Record<string, unknown> => JSON.parse(ok(result)) as Record<string, unknown>

// ---------------------------------------------------------------------------
// A ZIP reader and writer of our own, sharing nothing with the helpers.

interface Member {
  readonly name: string
  readonly offset: number
}

function zipMembers(bytes: Buffer): Member[] {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('no end of central directory')
  const count = bytes.readUInt16LE(eocd + 10)
  let at = bytes.readUInt32LE(eocd + 16)
  const out: Member[] = []
  for (let i = 0; i < count; i++) {
    const nameLength = bytes.readUInt16LE(at + 28)
    const skip = nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
    out.push({ name: bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'), offset: bytes.readUInt32LE(at + 42) })
    at += 46 + skip
  }
  return out
}

function zipMember(bytes: Buffer, name: string): string {
  const member = zipMembers(bytes).find((m) => m.name === name)
  if (!member) throw new Error(`no member ${name}`)
  const at = member.offset
  const method = bytes.readUInt16LE(at + 8)
  const size = bytes.readUInt32LE(at + 18)
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28)
  const raw = bytes.subarray(start, start + size)
  return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8')
}

/** A stored (uncompressed) ZIP with exactly the names given — including names no writer should produce. */
function storedZip(entries: ReadonlyArray<readonly [string, string]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

// ---------------------------------------------------------------------------
// The independent reader: Python's zipfile and minidom.

const PYTHON_CHECK = `
import sys, zipfile, xml.dom.minidom as minidom
path, kind = sys.argv[1], sys.argv[2]
MAIN = {
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
}
OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
z = zipfile.ZipFile(path)
bad = z.testzip()
if bad is not None:
    sys.exit('CRC failure in ' + bad)
names = z.namelist()
if len(names) != len(set(names)):
    sys.exit('duplicate member names')
for name in names:
    if name.endswith('.xml') or name.endswith('.rels'):
        minidom.parseString(z.read(name))
types = minidom.parseString(z.read('[Content_Types].xml'))
overrides = dict((o.getAttribute('PartName'), o.getAttribute('ContentType')) for o in types.getElementsByTagName('Override'))
rels = minidom.parseString(z.read('_rels/.rels')).getElementsByTagName('Relationship')
main = [r.getAttribute('Target') for r in rels if r.getAttribute('Type') == OFFICE_DOCUMENT]
if len(main) != 1:
    sys.exit('expected one officeDocument relationship, found ' + str(len(main)))
part = main[0].lstrip('/')
if part not in names:
    sys.exit('main part missing: ' + part)
if overrides.get('/' + part) != MAIN[kind]:
    sys.exit('main content type is ' + str(overrides.get('/' + part)))
print('ok')
`

let python: readonly string[] | null | undefined

function findPython(): readonly string[] | null {
  if (python !== undefined) return python
  for (const candidate of [['py', '-3'], ['python3'], ['python']] as const) {
    const probe = spawnSync(candidate[0], [...candidate.slice(1), '--version'], { encoding: 'utf8', timeout: 20_000 })
    if (probe.status === 0) return (python = candidate)
  }
  if (process.env.MINIDSH_EXPECT_PYTHON === '1') throw new Error('MINIDSH_EXPECT_PYTHON=1 but no Python was found (tried py -3, python3, python)')
  process.stderr.write('bundled-skills.test: no Python found; the independent zipfile/minidom check is skipped (set MINIDSH_EXPECT_PYTHON=1 to require it)\n')
  return (python = null)
}

function independentCheck(file: string, kind: 'docx' | 'xlsx' | 'pptx'): void {
  const command = findPython()
  if (command === null) return
  const result = spawnSync(command[0]!, [...command.slice(1), '-I', '-c', PYTHON_CHECK, file, kind], { encoding: 'utf8', timeout: 60_000 })
  expect({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }).toEqual({ status: 0, stdout: 'ok', stderr: '' })
}

// ---------------------------------------------------------------------------

describe('the bundled skills, as data', () => {
  it('ship office and pdf, and the package publishes the directory', () => {
    expect(skillDirs).toEqual(['office', 'pdf'])
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files?: string[] }
    expect(pkg.files).toContain('skills')
  })

  describe.each(skillDirs)('%s', (dir) => {
    const skillDir = join(SKILLS, dir)
    const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    const docs = readdirSync(skillDir).filter((f) => f.endsWith('.md'))
    const scripts = existsSync(join(skillDir, 'scripts')) ? readdirSync(join(skillDir, 'scripts')).filter((f) => f.endsWith('.mjs')) : []

    it('parses through the runtime reader, is named for its directory, and describes itself in 500 characters or fewer', () => {
      const parsed = parseSkillFile(text)
      if (!parsed.ok) throw new Error(parsed.reason)
      expect(parsed.frontmatter.name).toBe(dir)
      expect(isSkillName(dir)).toBe(true)
      expect(parsed.frontmatter.disableModelInvocation).toBe(false)
      expect(parsed.frontmatter.description?.length ?? 0).toBeGreaterThan(80)
      expect(parsed.frontmatter.description!.length).toBeLessThanOrEqual(500)
    })

    it('carries its provenance keys and license', () => {
      const front = text.split(/\r?\n---\r?\n/)[0]!
      expect(front).toMatch(/^license: MIT$/m)
      expect(front).toMatch(/^metadata:$/m)
      expect(front).toMatch(/^ {2}minidsh-reviewed: "\d{4}-\d{2}-\d{2}"$/m)
      expect(front).toMatch(/^ {2}minidsh-verified-with: ".+"$/m)
    })

    it.each(docs)('%s fits a file reader uncut (8,192 characters with line numbers)', (doc) => {
      const lines = readFileSync(join(skillDir, doc), 'utf8').split('\n')
      const rendered = lines.map((line, i) => `${String(i + 1).padStart(6)}  ${line}`).join('\n')
      expect(rendered.length).toBeLessThanOrEqual(RENDERED_LIMIT)
    })

    it('names only files that exist in the skill', () => {
      const named = new Set<string>()
      for (const doc of docs) {
        const body = readFileSync(join(skillDir, doc), 'utf8')
        for (const m of body.matchAll(/\bscripts\/[\w.-]+\.\w+/g)) named.add(m[0])
        for (const m of body.matchAll(/[`"]([\w-]+\.(?:md|mjs))[`"]/g)) named.add(m[1]!)
      }
      expect(named.size).toBeGreaterThan(0)
      for (const file of named) expect(existsSync(join(skillDir, file)), `${dir}: ${file}`).toBe(true)
      // The format references a router names are its own.
      if (dir === 'office') expect([...named]).toEqual(expect.arrayContaining(['docx.md', 'xlsx.md', 'pptx.md', 'scripts/office.mjs']))
    })

    it('keeps its helpers to node: modules and its own scripts directory', () => {
      expect(scripts.length).toBeGreaterThan(0)
      for (const script of scripts) {
        const source = readFileSync(join(skillDir, 'scripts', script), 'utf8')
        const specifiers = [...source.matchAll(/\bimport\s[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')
        expect(specifiers.length, script).toBeGreaterThan(0)
        for (const spec of specifiers) {
          if (spec.startsWith('node:')) continue
          expect(spec, `${dir}/scripts/${script} imports ${spec}`).toMatch(/^\.\/[\w-]+\.mjs$/)
          expect(existsSync(join(skillDir, 'scripts', spec))).toBe(true)
        }
      }
    })
  })
})

describe('office.mjs', () => {
  let work: string
  const officeDir = dirname(dirname(OFFICE))

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'minidsh-office-'))
  })
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  const spec = (name: string, value: unknown): string => {
    const path = join(work, name)
    writeFileSync(path, JSON.stringify(value))
    return path
  }

  const DOCX = {
    title: 'Quarterly Report',
    body: [
      { heading: 'Summary', level: 1 },
      { paragraph: [{ text: 'Sales rose ' }, { text: '12%', bold: true }, { text: ' in the north.', italic: true }] },
      { bullets: ['alpha', 'beta'] },
      { numbered: ['first', 'second'] },
      { numbered: ['again'] },
      { table: { header: ['Region', 'Total'], rows: [['North', 1200], ['South', 800]] } },
      { pageBreak: true },
      { paragraph: 'The closing sentence & <markup> stays text.' },
    ],
  }
  const XLSX = {
    sheets: [
      {
        name: 'Sales',
        boldHeader: true,
        freezeHeader: true,
        columnWidths: [20, 12],
        rows: [
          ['Region', 'Total', 'When'],
          ['North', 1200, { date: '2026-10-18' }],
          ['South', { value: 800.5, format: '0.00' }, true],
          ['Sum', { formula: 'SUM(B2:B3)', value: 2000.5 }, null],
          ['Twice', { formula: '=B2*2' }],
        ],
      },
      { name: 'Notes', rows: [[' padded ']] },
    ],
  }
  const PPTX = { slides: [{ title: 'Hello', bullets: ['a point', 'another'], notes: 'Say hi' }, { title: 'Second', text: 'Plain text.\n\nMore.' }] }

  it('builds each format, and its own read finds the requested content', () => {
    ok(run(OFFICE, ['build', spec('doc.json', DOCX), 'doc.docx'], work))
    const doc = ok(run(OFFICE, ['read', 'doc.docx'], work))
    for (const line of ['[Title] Quarterly Report', '[Heading1] Summary', '[Normal] Sales rose **12%** *in the north.*', '[ListParagraph, list 1 level 0] alpha', '[ListParagraph, list 2 level 0] first', '[ListParagraph, list 3 level 0] again', '| **Region** | **Total** |', '| North | 1200 |', '[page break]', '[Normal] The closing sentence & <markup> stays text.']) {
      expect(doc).toContain(line)
    }
    ok(run(OFFICE, ['build', spec('book.json', XLSX), 'book.xlsx'], work))
    const book = ok(run(OFFICE, ['read', 'book.xlsx'], work))
    for (const line of ['== sheet 1: Sales', 'frozen at A2', 'A1 "Region"  {bold}', 'B2 1200', 'C2 46313 (= 2026-10-18)  {format yyyy-mm-dd}', 'B3 800.5  {format 0.00}', 'C3 TRUE', 'B4 =SUM(B2:B3) [cached 2000.5]', 'B5 =B2*2 (no cached value)', '== sheet 2: Notes', 'A1 " padded "']) {
      expect(book).toContain(line)
    }
    ok(run(OFFICE, ['build', spec('deck.json', PPTX), 'deck.pptx'], work))
    const deck = ok(run(OFFICE, ['read', 'deck.pptx'], work))
    for (const line of ['pptx: 2 slide(s), 16:9 (12192000x6858000 EMU)', 'title: Hello', '\u{2022} a point', 'notes: Say hi', 'title: Second', '  Plain text.']) expect(deck).toContain(line)
    expect(deck).not.toContain('package problems')
  })

  it('writes the parts each format needs, stamps its generator, and passes an independent reader', () => {
    const doc = readFileSync(join(work, 'doc.docx'))
    const document = zipMember(doc, 'word/document.xml')
    expect(document).toContain('<w:tblGrid>')
    for (const cell of document.match(/<w:tc>.*?<\/w:tc>/g) ?? []) expect(cell).toMatch(/<w:p[ >/]/)
    expect(zipMember(doc, 'word/numbering.xml')).toContain('<w:startOverride w:val="1"/>')
    expect(zipMember(doc, 'word/styles.xml')).toMatch(/w:styleId="Heading3"[^]*w:styleId="ListParagraph"/)
    const book = readFileSync(join(work, 'book.xlsx'))
    expect(zipMember(book, 'xl/styles.xml')).toContain('<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>')
    expect(zipMember(book, 'xl/worksheets/sheet1.xml')).toMatch(/<dimension [^>]*\/><sheetViews>.*<\/sheetViews><sheetFormatPr [^>]*\/><cols>.*<\/cols><sheetData>/)
    const deck = readFileSync(join(work, 'deck.pptx'))
    const presentation = zipMember(deck, 'ppt/presentation.xml')
    expect(presentation).toMatch(/<p:sldMasterId id="2147483648"/)
    expect(presentation).toMatch(/<p:notesMasterIdLst>.*<p:sldIdLst><p:sldId id="256"/)
    expect(presentation).toContain('<p:notesSz cx="6858000" cy="9144000"/>')
    expect(zipMember(deck, 'ppt/theme/theme1.xml').match(/<a:effectStyle>/g)).toHaveLength(3)
    for (const [file, kind] of [['doc.docx', 'docx'], ['book.xlsx', 'xlsx'], ['deck.pptx', 'pptx']] as const) {
      const bytes = readFileSync(join(work, file))
      const names = zipMembers(bytes).map((m) => m.name)
      expect(names[0]).toBe('[Content_Types].xml')
      expect(new Set(names).size).toBe(names.length)
      expect(zipMember(bytes, 'docProps/app.xml')).toContain('<Application>MiniDSH office.mjs</Application>')
      expect(zipMember(bytes, 'docProps/core.xml')).not.toMatch(/dcterms:(created|modified)/)
      independentCheck(join(work, file), kind)
    }
  })

  it('builds byte-identical files from one spec', () => {
    for (const [name, value, ext] of [['doc.json', DOCX, 'docx'], ['book.json', XLSX, 'xlsx'], ['deck.json', PPTX, 'pptx']] as const) {
      ok(run(OFFICE, ['build', spec(name, value), `twice-a.${ext}`], work))
      ok(run(OFFICE, ['build', spec(name, value), `twice-b.${ext}`], work))
      expect(readFileSync(join(work, `twice-a.${ext}`)).equals(readFileSync(join(work, `twice-b.${ext}`))), ext).toBe(true)
    }
  })

  it('builds the example spec of every format reference', () => {
    for (const kind of ['docx', 'xlsx', 'pptx'] as const) {
      const reference = readFileSync(join(officeDir, `${kind}.md`), 'utf8')
      const example = /```json\n([^]*?)\n```/.exec(reference)?.[1]
      expect(example, kind).toBeDefined()
      writeFileSync(join(work, `example-${kind}.json`), example!)
      ok(run(OFFICE, ['build', `example-${kind}.json`, `example.${kind}`], work))
      independentCheck(join(work, `example.${kind}`), kind)
    }
  })

  it('unpacks, packs an edit into a new package with each member once, and refuses broken parts', () => {
    const dir = join(work, 'unpacked')
    ok(run(OFFICE, ['unpack', 'doc.docx', 'unpacked'], work))
    const documentPath = join(dir, 'word', 'document.xml')
    const original = readFileSync(documentPath, 'utf8')
    expect(original.split('\n').length).toBeGreaterThan(20)
    writeFileSync(documentPath, original.replace('>alpha<', '>alpha edited<'))
    ok(run(OFFICE, ['pack', 'unpacked', 'edited.docx'], work))
    const edited = readFileSync(join(work, 'edited.docx'))
    const names = zipMembers(edited).map((m) => m.name)
    expect(names[0]).toBe('[Content_Types].xml')
    expect(new Set(names).size).toBe(names.length)
    expect(names.toSorted()).toEqual(zipMembers(readFileSync(join(work, 'doc.docx'))).map((m) => m.name).toSorted())
    expect(ok(run(OFFICE, ['read', 'edited.docx'], work))).toContain('[ListParagraph, list 1 level 0] alpha edited')
    independentCheck(join(work, 'edited.docx'), 'docx')

    // Malformed XML: refused with the part, line and column; nothing written.
    writeFileSync(documentPath, original.replace('>first<', '>first & second<'))
    const malformed = run(OFFICE, ['pack', 'unpacked', 'malformed.docx'], work)
    expect(malformed.status).toBe(4)
    expect(malformed.stderr).toMatch(/word\/document\.xml: line \d+, column \d+: unescaped '&'/)
    expect(existsSync(join(work, 'malformed.docx'))).toBe(false)

    // A relationship whose target is gone.
    writeFileSync(documentPath, original)
    rmSync(join(dir, 'word', 'numbering.xml'))
    const missing = run(OFFICE, ['pack', 'unpacked', 'missing.docx'], work)
    expect(missing.status).toBe(4)
    expect(missing.stderr).toContain('word/_rels/document.xml.rels: rId3 target numbering.xml (word/numbering.xml) does not exist')
    expect(existsSync(join(work, 'missing.docx'))).toBe(false)

    // The main part's content type must be the exact one for the extension.
    writeFileSync(join(dir, 'word', 'numbering.xml'), zipMember(readFileSync(join(work, 'doc.docx')), 'word/numbering.xml'))
    const types = join(dir, '[Content_Types].xml')
    writeFileSync(types, readFileSync(types, 'utf8').replace('document.main+xml', 'template.main+xml'))
    const wrongType = run(OFFICE, ['pack', 'unpacked', 'wrong-type.docx'], work)
    expect(wrongType.status).toBe(4)
    expect(wrongType.stderr).toContain('must have content type application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
  })

  it('refuses zip-slip members and duplicate members before writing anything', () => {
    const types = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
    for (const name of ['../escaped.xml', '/absolute.xml', 'C:/drive.xml', 'word\\backslash.xml', 'word/../../up.xml']) {
      writeFileSync(join(work, 'slip.docx'), storedZip([['[Content_Types].xml', types], [name, '<x/>']]))
      const result = run(OFFICE, ['unpack', 'slip.docx', 'slip-out'], work)
      expect(result.status, name).toBe(4)
      expect(result.stderr).toContain('refusing member')
      expect(existsSync(join(work, 'slip-out'))).toBe(false)
    }
    expect(existsSync(join(dirname(work), 'escaped.xml'))).toBe(false)
    writeFileSync(join(work, 'dup.docx'), storedZip([['[Content_Types].xml', types], ['a.xml', '<a/>'], ['a.xml', '<b/>']]))
    const duplicate = run(OFFICE, ['unpack', 'dup.docx', 'dup-out'], work)
    expect(duplicate.status).toBe(4)
    expect(duplicate.stderr).toContain('more than once')
    mkdirSync(join(work, 'occupied'))
    writeFileSync(join(work, 'occupied', 'keep.txt'), 'mine')
    expect(run(OFFICE, ['unpack', 'doc.docx', 'occupied'], work).status).toBe(5)
  })

  it('refuses an output inside its own skill directory and an overwrite without --force', () => {
    const inside = join(officeDir, 'refused.docx')
    const refused = run(OFFICE, ['build', join(work, 'doc.json'), inside], work)
    expect(refused.status).toBe(5)
    expect(refused.stderr).toContain("this skill's directory")
    expect(existsSync(inside)).toBe(false)
    expect(run(OFFICE, ['unpack', 'doc.docx', join(officeDir, 'unpacked-here')], work).status).toBe(5)
    expect(existsSync(join(officeDir, 'unpacked-here'))).toBe(false)
    const before = statSync(join(work, 'doc.docx')).mtimeMs
    const again = run(OFFICE, ['build', 'doc.json', 'doc.docx'], work)
    expect(again.status).toBe(5)
    expect(again.stderr).toContain('--force')
    expect(statSync(join(work, 'doc.docx')).mtimeMs).toBe(before)
    ok(run(OFFICE, ['build', 'doc.json', 'doc.docx', '--force'], work))
  })

  it('answers --help and probe, and refuses unknown commands and options with a usage exit', () => {
    expect(ok(run(OFFICE, ['--help'], work))).toContain('unpack <file> <dir>')
    expect(ok(run(OFFICE, ['build', '--help'], work))).toContain('"numbered"')
    expect(json(run(OFFICE, ['probe'], work))).toHaveProperty('renderer')
    expect(run(OFFICE, ['frobnicate'], work).status).toBe(2)
    expect(run(OFFICE, ['read', 'doc.docx', '--verbose'], work).status).toBe(2)
    expect(run(OFFICE, ['read', 'no-such.docx'], work).status).toBe(3)
    writeFileSync(join(work, 'bad-spec.json'), JSON.stringify({ body: [{ table: { rows: [[{}]] } }] }))
    const badSpec = run(OFFICE, ['build', 'bad-spec.json', 'bad.docx'], work)
    expect(badSpec.status).toBe(4)
    expect(badSpec.stderr).toContain('spec.body[0].table.rows[0][0]')
  })
})

describe('pdf.mjs', () => {
  let work: string
  const pdfDir = dirname(dirname(PDF))

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'minidsh-pdf-'))
  })
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  interface PageText {
    readonly page: number
    readonly text: string
    readonly note?: string
  }
  const readPages = (file: string, cwd: string): { pages: number; text: PageText[]; repaired: boolean } => json(run(PDF, ['read', file, '--json'], cwd)) as unknown as { pages: number; text: PageText[]; repaired: boolean }

  it('reads the Edge print-to-PDF fixture: classic xref, Type0 Identity-H fonts, text split across operators', () => {
    const file = join(FIXTURES, 'edge-print.pdf')
    expect(json(run(PDF, ['info', file], work))).toMatchObject({ pages: 2, version: '1.4', encrypted: false, xref: 'table', repaired: false })
    const read = readPages(file, work)
    expect(read.pages).toBe(2)
    expect(read.repaired).toBe(false)
    const [one, two] = read.text
    for (const needle of ['Fixture Heading Alpha', 'EDGE-PRINT-7731', 'café', 'North', '1200']) expect(one?.text).toContain(needle)
    expect(two?.page).toBe(2)
    expect(two?.text).toContain('PAGE-TWO-OK')
    expect(one?.text).not.toContain('PAGE-TWO-OK')
  })

  it('reads the Word Save-as-PDF fixture: PDF 1.7, object streams, an xref stream, Type0 and TrueType fonts', () => {
    const file = join(FIXTURES, 'word-save.pdf')
    expect(json(run(PDF, ['info', file], work))).toMatchObject({ pages: 2, version: '1.7', encrypted: false, xref: 'hybrid', repaired: false })
    const read = readPages(file, work)
    const [one, two] = read.text
    for (const needle of ['Word Fixture Heading', 'WORD-SAVE-4410', 'été']) expect(one?.text).toContain(needle)
    expect(two?.text).toContain('WORD-PAGE-TWO')
    expect(json(run(PDF, ['read', file, '--pages', '2', '--json'], work))).toMatchObject({ shown: [2] })
  })

  it('finds an object whose recorded offset is wrong by scanning for it', () => {
    const source = readFileSync(join(FIXTURES, 'edge-print.pdf'))
    const text = source.toString('latin1')
    // Corrupt one xref entry (the content stream of page 1, object 10) without changing the file's length.
    const xref = text.lastIndexOf('\nxref')
    const line = text.indexOf('0000000343 00000 n', xref)
    expect(line).toBeGreaterThan(0)
    const broken = Buffer.from(text.slice(0, line) + '0000000099 00000 n' + text.slice(line + 18), 'latin1')
    writeFileSync(join(work, 'broken-offset.pdf'), broken)
    const read = readPages('broken-offset.pdf', work)
    expect(read.text[0]?.text).toContain('EDGE-PRINT-7731')
    expect(read).toMatchObject({ repaired: true })
  })

  it('builds a Latin PDF whose curly quotes, dashes and euro sign read back, page-numbered', () => {
    const title = 'Report \u{201C}Q3\u{201D} \u{2013} Final'
    const spec = { title, blocks: [{ heading: 'Summary' }, { paragraph: 'It\u{2019}s done \u{2014} mostly\u{2026} costs \u{20AC}12 and caf\u{E9}.' }, { bullets: ['one', 'two'] }, ...Array.from({ length: 10 }, () => ({ paragraph: 'Filler sentence for pagination. '.repeat(40) }))] }
    writeFileSync(join(work, 'spec.json'), JSON.stringify(spec))
    const built = json(run(PDF, ['build', 'spec.json', 'out.pdf'], work))
    expect(built.pages).toBeGreaterThan(1)
    const read = readPages('out.pdf', work)
    const first = read.text[0]?.text ?? ''
    expect(first).toContain(title)
    expect(first).toContain('It\u{2019}s done \u{2014} mostly\u{2026} costs \u{20AC}12 and caf\u{E9}.')
    expect(first).toContain('\u{2022} one')
    expect(first).toContain(`Page 1 of ${read.pages}`)
    expect(json(run(PDF, ['info', 'out.pdf'], work))).toMatchObject({ title, producer: 'MiniDSH pdf.mjs' })
    ok(run(PDF, ['build', 'spec.json', 'again.pdf'], work))
    expect(readFileSync(join(work, 'again.pdf')).equals(readFileSync(join(work, 'out.pdf')))).toBe(true)
  })

  it('reads a Markdown spec with a BOM, and refuses text outside WinAnsi with the browser route named', () => {
    writeFileSync(join(work, 'notes.md'), '\u{FEFF}# Notes\n\nA paragraph\nover two lines.\n\n- first\n- second\n')
    ok(run(PDF, ['build', 'notes.md', 'notes.pdf'], work))
    const text = readPages('notes.pdf', work).text[0]?.text ?? ''
    expect(text).toContain('Notes\nA paragraph over two lines.')
    expect(text).toContain('\u{2022} second')
    writeFileSync(join(work, 'cjk.json'), JSON.stringify({ blocks: [{ paragraph: '\u{4E2D}\u{6587}' }] }))
    const refused = run(PDF, ['build', 'cjk.json', 'cjk.pdf'], work)
    expect(refused.status).toBe(4)
    expect(refused.stderr).toContain('U+4E2D')
    expect(refused.stderr).toMatch(/HTML.*Chrome or Edge/)
    expect(existsSync(join(work, 'cjk.pdf'))).toBe(false)
  })

  it('bounds its output and says so, and refuses unsafe outputs', () => {
    const cut = ok(run(PDF, ['read', join(FIXTURES, 'edge-print.pdf'), '--max-chars', '40'], work))
    expect(cut).toContain('[truncated at 40 characters')
    expect(run(PDF, ['build', 'spec.json', join(pdfDir, 'refused.pdf')], work).status).toBe(5)
    expect(existsSync(join(pdfDir, 'refused.pdf'))).toBe(false)
    expect(run(PDF, ['build', 'spec.json', 'out.pdf'], work).status).toBe(5)
    ok(run(PDF, ['build', 'spec.json', 'out.pdf', '--force'], work))
    expect(run(PDF, ['read', 'out.pdf', '--pages', '99'], work).status).toBe(2)
    expect(ok(run(PDF, ['--help'], work))).toContain('build <spec.json|spec.md> <out.pdf>')
    const probe = json(run(PDF, ['probe'], work))
    expect(Object.keys(probe.tools as object).toSorted()).toEqual(['chrome', 'chromium', 'edge', 'pdftotext', 'soffice'])
  })

  it('reads pages and fonts packed in an object stream behind a PNG-predicted xref stream, with every show operator', () => {
    // Catalog, pages, page and fonts live inside object stream 6; xref stream 7 uses /Predictor 12.
    const toUnicode = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfrange <41> <43> [<0058> <0059> <005A>] endbfrange\nendcmap end end'
    const content = deflateSync(
      Buffer.from(
        ['BT /F1 12 Tf 14 TL 72 700 Td (OBJSTM-PREDICTOR-OK) Tj', "(Line \\(two\\) caf\\351) '", '2 0 (third \\101BC) "', 'ET', 'BT /F2 12 Tf 72 600 Td <414243> Tj ET', 'BT /F3 12 Tf 72 580 Td [(A) -50 (B)] TJ ET'].join('\n'),
        'latin1',
      ),
    )
    const packed: Array<readonly [number, string]> = [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 8 0 R /F3 9 0 R >> >> /Contents 5 0 R >>'],
      [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
      [8, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 10 0 R >>'],
      [9, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /eacute /germandbls] >> >>'],
    ]
    let header = ''
    let bodies = ''
    for (const [num, body] of packed) {
      header += `${num} ${bodies.length} `
      bodies += `${body}\n`
    }
    const objectStream = deflateSync(Buffer.from(header + bodies, 'latin1'))
    const offsets = new Map<number, number>()
    let pdf = '%PDF-1.5\n'
    const top = (num: number, dict: string, data: Buffer): void => {
      offsets.set(num, pdf.length)
      pdf += `${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream\nendobj\n`
    }
    top(5, '/Filter /FlateDecode', content)
    top(10, '', Buffer.from(toUnicode, 'latin1'))
    top(6, `/Type /ObjStm /N ${packed.length} /First ${header.length} /Filter /FlateDecode`, objectStream)
    offsets.set(7, pdf.length)
    const rows: number[][] = [[0, 0, 0, 255]]
    for (let num = 1; num <= 10; num++) {
      const index = packed.findIndex(([n]) => n === num)
      const offset = offsets.get(num) ?? 0
      rows.push(index >= 0 ? [2, 0, 6, index] : [1, offset >> 8, offset & 0xff, 0])
    }
    let previous = [0, 0, 0, 0]
    const predicted = Buffer.from(
      rows.flatMap((row) => {
        const up = [2, ...row.map((b, i) => (b - previous[i]! + 256) & 0xff)]
        previous = row
        return up
      }),
    )
    const xrefData = deflateSync(predicted)
    pdf += `7 0 obj\n<< /Type /XRef /Size 11 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >> /Length ${xrefData.length} >>\nstream\n${xrefData.toString('latin1')}\nendstream\nendobj\nstartxref\n${offsets.get(7)}\n%%EOF\n`
    writeFileSync(join(work, 'objstm.pdf'), Buffer.from(pdf, 'latin1'))
    // Read through the index, not the scan: a repair would hide a broken predictor.
    expect(json(run(PDF, ['info', 'objstm.pdf'], work))).toMatchObject({ pages: 1, version: '1.5', xref: 'stream', repaired: false })
    const text = readPages('objstm.pdf', work).text[0]?.text
    expect(text).toContain('OBJSTM-PREDICTOR-OK\nLine (two) caf\u{E9}\nthird ABC')
    expect(text).toContain('XYZ\n\u{E9}\u{DF}')
  })

  it('says when a page has no extractable text', () => {
    // One page whose content draws a rectangle and shows no text.
    const content = '0 0 100 100 re f'
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]
    let pdf = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
      offsets.push(pdf.length)
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    writeFileSync(join(work, 'blank.pdf'), pdf, 'latin1')
    expect(readPages('blank.pdf', work).text[0]).toMatchObject({ page: 1, text: '', note: expect.stringContaining('no extractable text') })
  })

  /**
   * Word draws a space on the empty page that follows a page break (measured on
   * this project's Office check, S19). Such a page has glyphs and every one is
   * mapped, so "no Unicode map, OCR would be needed" was a false diagnosis that
   * would send a reader looking for text that does not exist.
   */
  it('says a page of blank glyphs is blank, not unreadable', () => {
    const content = 'BT /F1 12 Tf 20 100 Td (   ) Tj ET'
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ]
    let pdf = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
      offsets.push(pdf.length)
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    writeFileSync(join(work, 'spaces.pdf'), pdf, 'latin1')
    const page = readPages('spaces.pdf', work).text[0]
    expect(page?.note).toBe('only blank characters on this page')
  })
})
