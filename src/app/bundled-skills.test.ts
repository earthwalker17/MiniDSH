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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { crc32, deflateRawSync, deflateSync, inflateRawSync } from 'node:zlib'
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

/** A helper run as a model runs it; `timeout` kills it, leaving `status` null, which is how a hang fails a test. */
function run(script: string, args: readonly string[], cwd: string, timeout = 60_000): Run {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout })
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
  /** Its local header. */
  readonly offset: number
  /** Its central-directory record. */
  readonly central: number
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
    out.push({ name: bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'), offset: bytes.readUInt32LE(at + 42), central: at })
    at += 46 + skip
  }
  return out
}

/** 1980-01-01 in DOS date form, the date office.mjs stamps on every member; its time is 00:00, zero. */
const DOS_1980_01_01 = (1 << 5) | 1

/**
 * Two builds a moment apart can match byte for byte and still carry the clock
 * (a DOS time ticks every two seconds), so the stamps themselves are read:
 * time and date of every local header (offsets 10, 12) and central record (12, 14).
 */
function expectFixedStamps(bytes: Buffer): void {
  for (const m of zipMembers(bytes)) {
    expect([bytes.readUInt16LE(m.offset + 10), bytes.readUInt16LE(m.offset + 12), bytes.readUInt16LE(m.central + 12), bytes.readUInt16LE(m.central + 14)], m.name).toEqual([0, DOS_1980_01_01, 0, DOS_1980_01_01])
  }
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

/** What a stored member may lie about: its CRC, or the size it declares. */
interface Lie {
  readonly crc?: number
  readonly size?: number
}

/** A stored (uncompressed) ZIP with exactly the names given — including names no writer should produce, and members that lie. */
function storedZip(entries: ReadonlyArray<readonly [string, string | Buffer, Lie?]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text, lie] of entries) {
    const data = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = lie?.crc ?? crc32(data) >>> 0
    const size = lie?.size ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  return Buffer.concat([...locals, ...endOfZip(centrals, entries.length, offset)])
}

function endOfZip(centrals: readonly Buffer[], count: number, offset: number): Buffer[] {
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return [directory, end]
}

/** The ZIP bomb shape: `count` directory entries that all point at one deflated body of `size` zero bytes. */
function sharedBodyZip(count: number, size: number): Buffer {
  const data = Buffer.alloc(size)
  const packed = deflateRawSync(data)
  const crc = crc32(data) >>> 0
  const first = Buffer.from('part0.xml')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(packed.length, 18)
  local.writeUInt32LE(size, 22)
  local.writeUInt16LE(first.length, 26)
  const centrals: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const name = Buffer.from(`part${i}.xml`)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    centrals.push(central, name)
  }
  const offset = 30 + first.length + packed.length
  return Buffer.concat([local, first, packed, ...endOfZip(centrals, count, offset)])
}

/** The files of an unpacked package as ZIP entries, `[Content_Types].xml` first. */
function directoryEntries(dir: string): Array<[string, Buffer]> {
  const files: Array<[string, Buffer]> = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push([relative(dir, full).split(sep).join('/'), readFileSync(full)])
    }
  }
  walk(dir)
  return files.toSorted(([a], [b]) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : a.localeCompare(b)))
}

/** A directory as another tool would zip it, unchecked: what `pack` refuses can still reach `read`. */
const zipDirectory = (dir: string): Buffer => storedZip(directoryEntries(dir))

/**
 * A link at `path` to `target`, which does not exist. Windows without the
 * symlink privilege refuses a symbolic link; a junction is the link it allows,
 * and the helpers followed it just the same.
 */
function danglingLink(target: string, path: string, kind: 'file' | 'dir'): void {
  try {
    symlinkSync(target, path, kind)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    symlinkSync(target, path, 'junction')
  }
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
      expectFixedStamps(readFileSync(join(work, `twice-a.${ext}`)))
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
    expectFixedStamps(edited)
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
    // A control character is no path escape, but Windows refuses it in a file name: unpack used to fail halfway.
    for (const name of ['../escaped.xml', '/absolute.xml', 'C:/drive.xml', 'word\\backslash.xml', 'word/../../up.xml', 'word/b\u{1}c.xml', 'word/b\u{85}c.xml']) {
      writeFileSync(join(work, 'slip.docx'), storedZip([['[Content_Types].xml', types], ['a.xml', '<a/>'], [name, '<x/>']]))
      const result = run(OFFICE, ['unpack', 'slip.docx', 'slip-out'], work)
      expect(result.status, JSON.stringify(name)).toBe(4)
      expect(result.stderr).toContain('refusing member')
      expect(existsSync(join(work, 'slip-out'))).toBe(false)
    }
    // A member named like another's directory cannot be written beside it.
    writeFileSync(join(work, 'clash.docx'), storedZip([['[Content_Types].xml', types], ['word', 'x'], ['word/a.xml', '<a/>']]))
    const clash = run(OFFICE, ['unpack', 'clash.docx', 'clash-out'], work)
    expect(clash.status).toBe(4)
    expect(clash.stderr).toContain('is also the directory of')
    expect(existsSync(join(work, 'clash-out'))).toBe(false)
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

  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

  it('refuses a ZIP whose members share one compressed body, declare too much, or are too many, before inflating any', () => {
    writeFileSync(join(work, 'shared.docx'), sharedBodyZip(40, 8 * 1024 * 1024))
    const shared = run(OFFICE, ['read', 'shared.docx'], work)
    expect(shared.status).toBe(4)
    expect(shared.stderr).toContain('share bytes in the file')
    const huge = 200 * 1024 * 1024
    writeFileSync(join(work, 'declared.docx'), storedZip([['a.xml', 'a', { size: huge }], ['b.xml', 'b', { size: huge }], ['c.xml', 'c', { size: huge }]]))
    const declared = run(OFFICE, ['read', 'declared.docx'], work)
    expect(declared.status).toBe(4)
    expect(declared.stderr).toContain(`the members declare ${3 * huge} bytes uncompressed`)
    writeFileSync(join(work, 'many.docx'), storedZip(Array.from({ length: 10001 }, (_, i) => [`p${i}.xml`, '<p/>'] as const)))
    const many = run(OFFICE, ['read', 'many.docx'], work)
    expect(many.status).toBe(4)
    expect(many.stderr).toContain('10001 members; this helper opens packages of at most 10000')
  })

  it('inflates only what read shows: a damaged media member does not stop read, and unpack still refuses it', () => {
    ok(run(OFFICE, ['unpack', 'doc.docx', 'lazy'], work))
    writeFileSync(join(work, 'lazy.docx'), storedZip([...directoryEntries(join(work, 'lazy')), ['word/media/broken.png', Buffer.from('not a png'), { crc: 1 }]]))
    expect(ok(run(OFFICE, ['read', 'lazy.docx'], work))).toContain('[Heading1] Summary')
    const unpacked = run(OFFICE, ['unpack', 'lazy.docx', 'lazy-out'], work)
    expect(unpacked.status).toBe(4)
    expect(unpacked.stderr).toContain('word/media/broken.png fails its CRC or size check')
  })

  it('says an OLE file is password-protected or legacy binary, with the unsupported exit', () => {
    writeFileSync(join(work, 'protected.docx'), Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(504)]))
    const result = run(OFFICE, ['read', 'protected.docx'], work)
    expect(result.status).toBe(6)
    expect(result.stderr).toContain('password-protected or legacy binary (.doc/.xls/.ppt) Office file')
  })

  it('reads a part with thousands of namespace declarations in time linear in its size', () => {
    ok(run(OFFICE, ['unpack', 'doc.docx', 'ns-doc'], work))
    const declarations = Array.from({ length: 5000 }, (_, i) => ` xmlns:p${i}="urn:minidsh:${i}"`).join('')
    writeFileSync(join(work, 'ns-doc', 'word', 'document.xml'), `<w:document xmlns:w="${W}"${declarations}><w:body>${'<w:p/>'.repeat(30000)}</w:body></w:document>`)
    writeFileSync(join(work, 'ns-doc.docx'), zipDirectory(join(work, 'ns-doc')))
    // Every element used to copy its parent's 5,000 bindings: about a minute here, where linear work takes well under a second.
    const result = run(OFFICE, ['read', 'ns-doc.docx'], work, 20_000)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('docx: 30000 paragraphs')
  })

  it('refuses ids inside a part that name no relationship, and read lists them as package problems', () => {
    ok(run(OFFICE, ['unpack', 'book.xlsx', 'rid-book'], work))
    const workbook = join(work, 'rid-book', 'xl', 'workbook.xml')
    writeFileSync(workbook, readFileSync(workbook, 'utf8').replace('r:id="rId1"', 'r:id="rId99"'))
    const book = run(OFFICE, ['pack', 'rid-book', 'rid-book.xlsx'], work)
    expect(book.status).toBe(4)
    expect(book.stderr).toContain('xl/workbook.xml: r:id rId99 has no relationship in xl/_rels/workbook.xml.rels')
    expect(existsSync(join(work, 'rid-book.xlsx'))).toBe(false)
    writeFileSync(join(work, 'rid-book-zipped.xlsx'), zipDirectory(join(work, 'rid-book')))
    const read = ok(run(OFFICE, ['read', 'rid-book-zipped.xlsx'], work))
    expect(read).toMatch(/package problems[^]*r:id rId99 has no relationship/)
    // A slide whose relationship is gone: PowerPoint refuses the file, so pack does.
    ok(run(OFFICE, ['unpack', 'deck.pptx', 'rid-deck'], work))
    const slideId = /<p:sldId id="256" r:id="(rId\d+)"/.exec(readFileSync(join(work, 'rid-deck', 'ppt', 'presentation.xml'), 'utf8'))?.[1]
    expect(slideId).toBeDefined()
    const rels = join(work, 'rid-deck', 'ppt', '_rels', 'presentation.xml.rels')
    writeFileSync(rels, readFileSync(rels, 'utf8').replace(new RegExp(`<Relationship Id="${slideId}"[^>]*/>`), ''))
    const deck = run(OFFICE, ['pack', 'rid-deck', 'rid-deck.pptx'], work)
    expect(deck.status).toBe(4)
    expect(deck.stderr).toContain(`ppt/presentation.xml: r:id ${slideId} has no relationship`)
  })

  it('reads tables through content controls, a text box once, and moved-away text as deleted', () => {
    ok(run(OFFICE, ['unpack', 'doc.docx', 'wrapped'], work))
    const run1 = (text: string): string => `<w:r><w:t>${text}</w:t></w:r>`
    const box = `<w:txbxContent><w:p>${run1('BOX-TEXT')}</w:p></w:txbxContent>`
    const body = [
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>',
      `<w:tr><w:tc><w:p>${run1('A1')}</w:p></w:tc><w:tc><w:sdt><w:sdtPr/><w:sdtContent><w:p>${run1('SDT-PARA')}</w:p></w:sdtContent></w:sdt></w:tc></w:tr>`,
      `<w:sdt><w:sdtPr/><w:sdtContent><w:tr><w:tc><w:p>${run1('SDT-ROW')}</w:p></w:tc><w:customXml w:element="cell"><w:tc><w:p>${run1('CX-CELL')}</w:p></w:tc></w:customXml></w:tr></w:sdtContent></w:sdt>`,
      '</w:tbl>',
      // Word writes a text box twice: DrawingML in the Choice, VML in the Fallback.
      `<w:p>${run1('Anchor')}<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx>${box}</wps:txbx></wps:wsp></w:drawing></mc:Choice>`,
      `<mc:Fallback><w:pict><v:shape><v:textbox>${box}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
      `<w:p><w:moveFrom w:id="1" w:author="a">${run1('MOVED-AWAY')}</w:moveFrom><w:moveTo w:id="2" w:author="a">${run1('MOVED-HERE')}</w:moveTo></w:p>`,
    ].join('')
    const wps = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'
    writeFileSync(join(work, 'wrapped', 'word', 'document.xml'), `<w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:wps="${wps}" xmlns:v="urn:schemas-microsoft-com:vml" mc:Ignorable="wps"><w:body>${body}<w:sectPr/></w:body></w:document>`)
    ok(run(OFFICE, ['pack', 'wrapped', 'wrapped.docx'], work))
    const text = ok(run(OFFICE, ['read', 'wrapped.docx'], work))
    for (const line of ['[table: 2 rows x 2 columns]', '| A1 | SDT-PARA |', '| SDT-ROW | CX-CELL |', '[Normal] Anchor\n[text box] [Normal] BOX-TEXT', '[Normal] ~~MOVED-AWAY~~MOVED-HERE']) expect(text).toContain(line)
    expect(text.split('BOX-TEXT')).toHaveLength(2)
  })

  it('reads a slide shape wrapped in AlternateContent once', () => {
    ok(run(OFFICE, ['unpack', 'deck.pptx', 'alt-deck'], work))
    const slide = join(work, 'alt-deck', 'ppt', 'slides', 'slide1.xml')
    const xml = readFileSync(slide, 'utf8')
    const shape = xml.match(/<p:sp>[^]*?<\/p:sp>/g)?.find((sp) => sp.includes('a point'))
    expect(shape).toBeDefined()
    const p14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
    writeFileSync(slide, xml.replace(shape!, `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${p14}" Requires="p14">${shape}</mc:Choice><mc:Fallback>${shape}</mc:Fallback></mc:AlternateContent>`))
    ok(run(OFFICE, ['pack', 'alt-deck', 'alt-deck.pptx'], work))
    expect(ok(run(OFFICE, ['read', 'alt-deck.pptx'], work)).split('\u{2022} a point')).toHaveLength(2)
  })

  it('reads 1904 dates, _xHHHH_ escapes and phonetic runs as Excel shows them, and escapes a literal _xHHHH_ it writes', () => {
    writeFileSync(join(work, 'escape.json'), JSON.stringify({ sheets: [{ name: 'S', rows: [['A_x0042_B', { formula: '"x"', value: 'C_x0044_D' }]] }] }))
    ok(run(OFFICE, ['build', 'escape.json', 'escape.xlsx'], work))
    const built = readFileSync(join(work, 'escape.xlsx'))
    expect(zipMember(built, 'xl/sharedStrings.xml')).toContain('>A_x005F_x0042_B<')
    expect(zipMember(built, 'xl/worksheets/sheet1.xml')).toContain('<v>C_x005F_x0044_D</v>')
    const back = ok(run(OFFICE, ['read', 'escape.xlsx'], work))
    expect(back).toContain('A1 "A_x0042_B"')
    expect(back).toContain('B1 ="x" [cached "C_x0044_D"]')

    ok(run(OFFICE, ['unpack', 'book.xlsx', 'excel-book'], work))
    const workbook = join(work, 'excel-book', 'xl', 'workbook.xml')
    writeFileSync(workbook, readFileSync(workbook, 'utf8').replace('<bookViews>', '<workbookPr date1904="1"/><bookViews>'))
    const notes = join(work, 'excel-book', 'xl', 'worksheets', 'sheet2.xml')
    const cells = '<c r="B1" t="inlineStr"><is><t>TAB_x0009_HERE</t></is></c><c r="C1" t="inlineStr"><is><r><t>BASE</t></r><rPh sb="0" eb="4"><t>RUBY</t></rPh></is></c>'
    writeFileSync(notes, readFileSync(notes, 'utf8').replace('</row>', `${cells}</row>`))
    ok(run(OFFICE, ['pack', 'excel-book', 'excel-book.xlsx'], work))
    const read = ok(run(OFFICE, ['read', 'excel-book.xlsx'], work))
    for (const line of ['1904 date system', 'C2 46313 (= 2030-10-19)', 'B1 "TAB\\tHERE"', 'C1 "BASE"']) expect(read).toContain(line)
    expect(read).not.toContain('RUBY')
  })

  it('re-indents a part without touching mixed content', () => {
    ok(run(OFFICE, ['unpack', 'doc.docx', 'mixed'], work))
    const mixed = '<root><a>keep<b/><c/>tail</a><d><e/><f/>x</d></root>'
    mkdirSync(join(work, 'mixed', 'customXml'))
    writeFileSync(join(work, 'mixed', 'customXml', 'item1.xml'), mixed)
    ok(run(OFFICE, ['pack', 'mixed', 'mixed.docx'], work))
    ok(run(OFFICE, ['unpack', 'mixed.docx', 'mixed-again'], work))
    const again = readFileSync(join(work, 'mixed-again', 'customXml', 'item1.xml'), 'utf8')
    expect(again).toBe('<root>\n  <a>keep<b/><c/>tail</a>\n  <d><e/><f/>x</d>\n</root>')
  })

  it('refuses a link at the output path, dangling into the skill, with and without --force', () => {
    ok(run(OFFICE, ['build', 'doc.json', 'linked-source.docx'], work))
    ok(run(OFFICE, ['unpack', 'linked-source.docx', 'linked-parts'], work))
    const cases = [
      { link: 'linked-build.docx', kind: 'file', args: (out: string) => ['build', 'doc.json', out] },
      { link: 'linked-pack.docx', kind: 'file', args: (out: string) => ['pack', 'linked-parts', out] },
      { link: 'linked-unpack', kind: 'dir', args: (out: string) => ['unpack', 'linked-source.docx', out] },
    ] as const
    for (const { link, kind, args } of cases) {
      for (const force of [[], ['--force']]) {
        const target = join(officeDir, `planted-${link}`)
        const path = join(work, link)
        danglingLink(target, path, kind)
        try {
          const result = run(OFFICE, [...args(link), ...force], work)
          expect({ status: result.status, link: result.stderr.includes('symbolic link') }, `${link} ${force.join('')}`).toEqual({ status: 5, link: true })
          expect(existsSync(target), target).toBe(false)
        } finally {
          rmSync(target, { recursive: true, force: true })
          if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path)
        }
      }
    }
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
    // Equal bytes from two builds a moment apart would not show a clock reading; its absence does.
    expect(readFileSync(join(work, 'out.pdf')).toString('latin1')).not.toMatch(/\/(CreationDate|ModDate)\b/)
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

  const pdfStream = (dict: string, data: string): string => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`
  const CATALOG = '<< /Type /Catalog /Pages 2 0 R >>'
  const pageObject = (resources: string): string => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents 4 0 R >>`
  const HELVETICA_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  /** A classic-xref PDF from object bodies, numbered from 1 in order. */
  function simplePdf(objects: readonly string[]): Buffer {
    let pdf = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
      offsets.push(pdf.length)
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(pdf, 'latin1')
  }

  /** One page: catalog 1, pages 2, page 3, its content 4, then `rest` from 5. */
  const onePage = (resources: string, content: string, ...rest: string[]): Buffer => simplePdf([CATALOG, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', pageObject(resources), pdfStream('', content), ...rest])

  /**
   * Arrays recurse through `valueFrom`, and the depth check sat one level up
   * in `parseValue`: about 12,000 nested `[` overflowed the stack into a crash
   * (exit 1, a stack trace) instead of the invalid-input refusal (review, S19).
   */
  it('treats objects nested too deeply as unreadable instead of overflowing the stack', () => {
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`
    writeFileSync(join(work, 'deep.pdf'), simplePdf([CATALOG, `<< /Type /Pages /Kids [3 0 R] /Count 1 /Deep ${deep} >>`, pageObject('<< >>'), pdfStream('', 'BT ET')]))
    const info = run(PDF, ['info', 'deep.pdf'], work)
    expect(info.stderr).not.toMatch(/RangeError|Maximum call stack|at valueFrom/)
    // The pages object is refused as nested too deeply, so the reader's own
    // recovery treats it as unreadable: a document with no readable pages.
    expect(info.status, info.stderr).toBe(0)
    expect(JSON.parse(info.stdout)).toMatchObject({ pages: 0 })
  })

  it('lays words out by position: a form matrix with a tiny term, Times without widths, and pdfTeX-tight spaces', () => {
    const resources = '<< /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /X 7 0 R >> >>'
    // Times widths: The = 18.66 pt at 12 pt, minimum = 46.68 pt; each word then a 3 pt (0.25 em) space.
    const times = 'BT /F2 12 Tf 1 0 0 1 72 600 Tm (The) Tj 1 0 0 1 93.66 600 Tm (minimum) Tj 1 0 0 1 143.34 600 Tm (illumination) Tj ET'
    const tight = 'BT /F1 12 Tf 72 560 Td [(The) -190 (quick) -333 (brown) -190 (fox)] TJ ET'
    // 1e-11 printed by JavaScript is "1e-11", which a content stream cannot say.
    const form = pdfStream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Matrix [1 0.00000000001 0 1 0 0] /Resources ${resources}`, 'BT /F1 12 Tf 72 700 Td (LINE-ONE) Tj 0 -20 Td (LINE-TWO) Tj ET')
    writeFileSync(join(work, 'layout.pdf'), onePage(resources, `${times}\n${tight}\n/X Do`, HELVETICA_FONT, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>', form))
    const text = readPages('layout.pdf', work).text[0]?.text ?? ''
    expect(text, 'Times without /Widths').toContain('The minimum illumination')
    expect(text, 'glue shrunk to 0.19 em').toContain('The quick brown fox')
    expect(text, 'the form matrix').toContain('LINE-ONE\nLINE-TWO')
  })

  it('stops a page whose forms draw themselves or each other without end, and says so', () => {
    // 643 bytes: a form drawing itself four times reached 4^12 drawings before the depth limit.
    writeFileSync(join(work, 'self-form.pdf'), onePage('<< /XObject << /X 5 0 R >> >>', '/X Do', pdfStream('/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /X 5 0 R >> >>', '/X Do /X Do /X Do /X Do')))
    const self = run(PDF, ['read', 'self-form.pdf', '--json'], work, 12_000)
    expect(self.status).toBe(0)
    expect((JSON.parse(self.stdout) as { text: PageText[] }).text[0]?.note).toContain('a form XObject draws itself')
    // Eight distinct forms, each drawing the next ten times: 10^8 drawings, none of a form inside itself.
    const forms = Array.from({ length: 8 }, (_, k) => pdfStream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /N ${6 + k} 0 R >> /Font << /F1 13 0 R >> >>`, k < 7 ? '/N Do '.repeat(10) : 'BT /F1 1 Tf (x) Tj ET'))
    writeFileSync(join(work, 'form-chain.pdf'), onePage('<< /XObject << /N 5 0 R >> >>', '/N Do', ...forms, HELVETICA_FONT))
    const chain = run(PDF, ['read', 'form-chain.pdf', '--json'], work, 12_000)
    expect(chain.status).toBe(0)
    expect((JSON.parse(chain.stdout) as { text: PageText[] }).text[0]?.note).toContain('drawing stopped after')
  })

  it('skips a stream that decodes past 64 MiB, and stops decoding at the document budget, with notes', () => {
    const font = '<< /Font << /F1 5 0 R >> >>'
    const bomb = deflateSync(Buffer.concat([Buffer.from('BT /F1 12 Tf 72 700 Td (BOMB) Tj ET\n'), Buffer.alloc(70 * 1024 * 1024, 0x20)]))
    writeFileSync(join(work, 'bomb.pdf'), simplePdf([CATALOG, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', pageObject(font), pdfStream('/Filter /FlateDecode', bomb.toString('latin1')), HELVETICA_FONT]))
    expect(readPages('bomb.pdf', work).text[0]?.note).toBe('a stream decodes to more than 64 MiB; it was skipped')
    // Five pages share one 60 MiB stream; contents are decoded per page, so the fifth finds the 256 MiB spent.
    const big = deflateSync(Buffer.concat([Buffer.from('BT /F1 12 Tf 72 700 Td (BIG) Tj ET\n'), Buffer.alloc(60 * 1024 * 1024, 0x20)]))
    const pages = [3, 6, 7, 8, 9]
    writeFileSync(join(work, 'budget.pdf'), simplePdf([CATALOG, `<< /Type /Pages /Kids [${pages.map((n) => `${n} 0 R`).join(' ')}] /Count 5 >>`, pageObject(font), pdfStream('/Filter /FlateDecode', big.toString('latin1')), HELVETICA_FONT, ...pages.slice(1).map(() => pageObject(font))]))
    const read = readPages('budget.pdf', work)
    expect(read.text.slice(0, 4).map((p) => p.text)).toEqual(['BIG', 'BIG', 'BIG', 'BIG'])
    expect(read.text[4]?.note).toBe("the document's 256 MiB decoding budget is spent; a stream was skipped")
  })

  it('repairs a file of thousands of streams with wrong lengths in time linear in its size', () => {
    let pdf = `%PDF-1.4\n1 0 obj ${CATALOG} endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj ${pageObject('<< /Font << /F1 5 0 R >> >>')} endobj\n`
    pdf += `4 0 obj << /Length 999 >> stream\nBT /F1 12 Tf 72 700 Td (SCAN-OK) Tj ET\nendstream endobj\n5 0 obj ${HELVETICA_FONT} endobj\n`
    // No xref, and 40,000 streams whose /Length is wrong and whose endstream never comes: each used to search to the end, twice.
    for (let i = 6; i < 40000; i++) pdf += `${i} 0 obj << /Length 0 >> stream\n${'x'.repeat(60)}\n`
    writeFileSync(join(work, 'no-endstream.pdf'), pdf, 'latin1')
    const result = run(PDF, ['read', 'no-endstream.pdf', '--json'], work, 15_000)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ repaired: true, text: [{ page: 1, text: 'SCAN-OK' }] })
  })

  it('builds numbered Markdown items with their numbers, drops emphasis markers, and prints a link as text (url)', () => {
    writeFileSync(join(work, 'steps.md'), 'Steps to take:\n1. Open *the* file\n2. Press **Save**\n\nSee [the guide](https://example.com/guide) and _notes_ in snake_case_name.\n\n3) Third, after a gap\n')
    ok(run(PDF, ['build', 'steps.md', 'steps.pdf'], work))
    const text = readPages('steps.pdf', work).text[0]?.text ?? ''
    expect(text).toContain('Steps to take:\n1. Open the file\n2. Press Save')
    expect(text).toContain('See the guide (https://example.com/guide) and notes in snake_case_name.')
    expect(text).toContain('3. Third, after a gap')
  })

  it('refuses a link at the output path, dangling into the skill, with and without --force', () => {
    for (const force of [[], ['--force']]) {
      const target = join(pdfDir, 'planted.pdf')
      const path = join(work, 'linked.pdf')
      danglingLink(target, path, 'file')
      try {
        const result = run(PDF, ['build', 'spec.json', 'linked.pdf', ...force], work)
        expect({ status: result.status, link: result.stderr.includes('symbolic link') }, force.join('')).toEqual({ status: 5, link: true })
        expect(existsSync(target)).toBe(false)
      } finally {
        rmSync(target, { recursive: true, force: true })
        if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path)
      }
    }
  })
})
