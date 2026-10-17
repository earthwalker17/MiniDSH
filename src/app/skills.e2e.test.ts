/**
 * The S19 live arc: skills as data, on the real runtime, the real DeepSeek
 * API, a real workspace outside the repo, over `minidsh serve`'s stdio.
 *
 * The claim: a model can find engineering know-how it was never told about in
 * a prompt or a tool schema — only in the durable skill list a new session
 * enters — read it with the tools it already has, run the skill's own helper
 * from the package directory, and leave a document in the workspace that a
 * reader which is not MiniDSH accepts.
 *
 * The task is non-coding work end to end: read a PDF of requirements (FlateDecode,
 * so `cat` shows nothing useful), aggregate a CSV, and write a Word document
 * with a heading, a table and a closing sentence.
 *
 * What separates "the skill list worked" from "the model knew another way"
 * (ARCHITECTURE §10: ask what a model knowing nothing would answer). This host
 * has Word, Excel, PowerPoint and Python with pip, so a valid report.docx on its
 * own proves nothing about skills. Three facts only a model that read the list
 * can produce, all asserted:
 *   - a non-error read of the listed office SKILL.md, before the first call
 *     that names report.docx;
 *   - the document carries the generator stamp only `office.mjs build` writes;
 *   - the request offered no `skill` tool: the read went through ordinary tools.
 * The asserted prompt says "if a skill listed for this environment fits, use
 * it" — it names no skill, path or script, so the route still runs through the
 * list; the list itself stays optional (the preamble says so). How often a
 * model reaches for a skill UNPROMPTED is a different question, measured by the
 * env-gated neutral leg and reported, never asserted; so is whether the skill
 * still earns its place (the baseline leg, with the skills row disabled).
 *
 * Authority: Windows hosts accept an unconfined shell (`--accept none`), a
 * confining host runs every command under its backend; neither needs consent,
 * so nothing is approved: an ask is rejected and the arc asserts none was made.
 *
 * Then the log replays keylessly with tool bodies RUN, into the same workspace
 * re-seeded: the helper's ZIP is deterministic, so the replayed report.docx is
 * byte-identical to the recorded one.
 *
 * Requires DEEPSEEK_API_KEY and a Python (the independent reader); skipped
 * without the key. Run via `pnpm test:e2e src/app/skills.e2e.test.ts`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import type { EventEnvelope } from '../core/session/index.ts'
import { installLlmReplay } from '../test-support/llm-replay.ts'
import { killSpawnedServes, ServeProcess } from '../test-support/serve-process.ts'
import { runTask } from './headless.ts'
import { skillRootsFor } from './home.ts'

const KEY = process.env.DEEPSEEK_API_KEY
const silent: Logger = { warn: () => {}, error: () => {} }
const win32 = process.platform === 'win32'
let dirs: string[] = []
afterAll(() => {
  killSpawnedServes()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const data = <T>(event: EventEnvelope | undefined): T => (event?.data ?? {}) as T

// ---- the world the arc starts from ------------------------------------------

const SALES: readonly (readonly [string, string, number])[] = [
  ['North', 'Jul', 1200], ['South', 'Jul', 870], ['East', 'Jul', 1500], ['West', 'Jul', 2100],
  ['North', 'Aug', 1350], ['South', 'Aug', 910], ['East', 'Aug', 1420], ['West', 'Aug', 1980],
  ['North', 'Sep', 980], ['South', 'Sep', 1005], ['East', 'Sep', 1610], ['West', 'Sep', 2240],
]
const TITLE = 'Lumen Quarterly Review'

function totals(): Map<string, number> {
  const sums = new Map<string, number>()
  for (const [region, , amount] of SALES) sums.set(region, (sums.get(region) ?? 0) + amount)
  return sums
}

function topRegion(): string {
  return [...totals()].toSorted((a, b) => b[1] - a[1])[0]![0]
}

/**
 * A one-page PDF whose text is in a FlateDecode stream: `cat` and the editor
 * show compressed bytes, so reading it takes a PDF reader. No `/Info` title, so
 * no plaintext dictionary gives the requirements away either.
 */
function requirementsPdf(): Buffer {
  const lines = [
    'Report requirements',
    `1. Title the document: ${TITLE}`,
    '2. Add a table with one row per region and its total sales (the sum of the amount column).',
    '3. End the document with this sentence, naming the region with the highest total:',
    '   Top region: <region>.',
  ]
  const escape = (text: string): string => text.replace(/[\\()]/g, (ch) => `\\${ch}`)
  const content = ['BT', '/F1 12 Tf', '72 740 Td', '16 TL', ...lines.map((line) => `(${escape(line)}) Tj T*`), 'ET'].join('\n')
  const stream = deflateSync(Buffer.from(content, 'latin1'))
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', 'latin1'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'),
  ]
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let length = parts[0]!.length
  objects.forEach((body, index) => {
    offsets.push(length)
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')])
    parts.push(object)
    length += object.length
  })
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('')
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(parts)
}

function seed(workspace: string): void {
  writeFileSync(join(workspace, 'sales.csv'), `region,month,amount\n${SALES.map((row) => row.join(',')).join('\n')}\n`, 'utf8')
  writeFileSync(join(workspace, 'requirements.pdf'), requirementsPdf())
}

/** Everything the run left, removed, then the seeds again: the replay starts from the recording's world. */
function reset(workspace: string): void {
  for (const entry of readdirSync(workspace)) rmSync(join(workspace, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  seed(workspace)
}

// ---- the independent reader -----------------------------------------------------

/** A Python that really runs (`python3` on this host is the Store stub), or undefined. */
function findPython(): readonly string[] | undefined {
  for (const candidate of [['py', '-3'], ['python3'], ['python']]) {
    const probe = spawnSync(candidate[0]!, [...candidate.slice(1), '--version'], { encoding: 'utf8', timeout: 20_000 })
    if (probe.status === 0) return candidate
  }
  return undefined
}

/**
 * Python's own zip and XML readers over the package, then the document's text
 * as Word structures it: each paragraph's `w:t` runs joined, each table row's
 * cells joined. Nothing here is MiniDSH code.
 */
const READER = String.raw`
import json, sys, zipfile
from xml.dom import minidom
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
path = sys.argv[1]
out = {'errors': []}
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    if len(names) != len(set(names)): out['errors'].append('duplicate members')
    bad = z.testzip()
    if bad is not None: out['errors'].append('bad CRC: ' + bad)
    docs = {}
    for name in names:
        if name.endswith('.xml') or name.endswith('.rels'):
            try: docs[name] = minidom.parseString(z.read(name))
            except Exception as error: out['errors'].append('malformed ' + name + ': ' + str(error))
    types = docs.get('[Content_Types].xml')
    main = [o.getAttribute('ContentType') for o in types.getElementsByTagName('Override') if o.getAttribute('PartName') == '/word/document.xml'] if types else []
    out['mainType'] = main[0] if main else None
    rels = docs.get('_rels/.rels')
    out['officeDocument'] = [r.getAttribute('Target') for r in rels.getElementsByTagName('Relationship') if r.getAttribute('Type').endswith('/officeDocument')] if rels else []
    app = docs.get('docProps/app.xml')
    tags = app.getElementsByTagName('Application') if app else []
    out['application'] = tags[0].firstChild.nodeValue if tags and tags[0].firstChild else None
    doc = docs.get('word/document.xml')
    def text(node): return ''.join(t.firstChild.nodeValue for t in node.getElementsByTagNameNS(W, 't') if t.firstChild)
    out['paragraphs'] = [text(p) for p in doc.getElementsByTagNameNS(W, 'p')] if doc else []
    out['rows'] = [' | '.join(text(c) for c in r.getElementsByTagNameNS(W, 'tc')) for r in doc.getElementsByTagNameNS(W, 'tr')] if doc else []
    out['tables'] = len(doc.getElementsByTagNameNS(W, 'tbl')) if doc else 0
print(json.dumps(out))
`

interface ReadBack {
  readonly errors: string[]
  readonly mainType: string | null
  readonly officeDocument: string[]
  readonly application: string | null
  readonly paragraphs: string[]
  readonly rows: string[]
  readonly tables: number
}

function readBack(python: readonly string[], file: string, scratch: string): ReadBack {
  const script = join(scratch, 'read_docx.py')
  writeFileSync(script, READER, 'utf8')
  const run = spawnSync(python[0]!, [...python.slice(1), '-I', script, file], { encoding: 'utf8', timeout: 60_000 })
  if (run.status !== 0) throw new Error(`the independent reader failed (${run.status}): ${run.stderr}`)
  return JSON.parse(run.stdout) as ReadBack
}

/** Numbers as a person writes them: `6,320`, `6320.00`, `$6,320` all mean 6320. */
function numbersIn(text: string): number[] {
  return [...text.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
}

// ---- reading the log --------------------------------------------------------------

/**
 * A path as the model may spell it: separators either way and doubled (a
 * PowerShell string written with `\\` still names the same file), any case on
 * Windows.
 */
function norm(text: string): string {
  const flat = text.replace(/[\\/]+/g, '/')
  return win32 ? flat.toLowerCase() : flat
}

/** Every string inside a call's JSON arguments, joined: a path is found whichever field carries it. */
function argumentText(event: EventEnvelope): string {
  const raw = data<{ arguments: string }>(event).arguments
  const strings: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  try {
    walk(JSON.parse(raw))
  } catch {
    strings.push(raw)
  }
  return norm(strings.join('\n'))
}

interface Shape {
  /** `args`: every string value, normalized; `raw`: the call's JSON as logged, keys included. */
  readonly calls: { readonly seq: number; readonly name: string; readonly args: string; readonly raw: string; readonly isError: boolean }[]
  readonly list?: string
  readonly approvalsAsked: number
  readonly toolNames: readonly string[]
  readonly enforcement?: string
  readonly steps: number
}

function shapeOf(events: readonly EventEnvelope[]): Shape {
  const results = new Map(events.filter((event) => event.type === 'tool/result').map((event) => [data<{ callId: string }>(event).callId, data<{ isError?: boolean }>(event).isError === true]))
  const calls = events
    .filter((event) => event.type === 'tool/call')
    .map((event) => ({
      seq: event.seq,
      name: data<{ name: string }>(event).name,
      args: argumentText(event),
      raw: data<{ arguments: string }>(event).arguments,
      isError: results.get(data<{ callId: string }>(event).callId) ?? true,
    }))
  const list = events.find(
    (event) =>
      event.type === 'user/message' &&
      data<{ message: { source: { kind: string; plugin?: string; form?: string } } }>(event).message.source.plugin === 'skills' &&
      data<{ message: { source: { form?: string } } }>(event).message.source.form === 'list',
  )
  const listText = list ? data<{ message: { content: { type: string; text?: string }[] } }>(list).message.content.map((block) => block.text ?? '').join('') : undefined
  const header = events.find((event) => event.type === 'request/header')
  const stamp = events.find((event) => event.type === 'sandbox/mode')
  return {
    calls,
    ...(listText === undefined ? {} : { list: listText }),
    approvalsAsked: events.filter((event) => event.type === 'approval/asked').length,
    toolNames: data<{ header: { tools: { name: string }[] } }>(header).header?.tools.map((tool) => tool.name) ?? [],
    ...(stamp === undefined ? {} : { enforcement: data<{ enforcement: string }>(stamp).enforcement }),
    steps: events.filter((event) => event.type === 'step/start').length,
  }
}

function describeShape(shape: Shape): string {
  return `${shape.steps} steps; calls ${JSON.stringify(shape.calls.map((call) => [call.name, call.isError ? 'ERR' : 'ok', call.args.slice(0, 140)]))}`
}

// ---- one recorded run ---------------------------------------------------------------

interface Run {
  readonly workspace: string
  readonly home: string
  readonly prompt: string
  readonly sessionId: string
  readonly events: EventEnvelope[]
  readonly model: string
}

async function record(prompt: string, options: { readonly skillsDisabled?: boolean } = {}): Promise<Run> {
  const workspace = tempDir('minidsh-skills-ws-')
  const home = tempDir('minidsh-skills-home-')
  seed(workspace)
  if (options.skillsDisabled) writeFileSync(join(home, 'composition.json'), JSON.stringify({ patches: [{ id: 'skills', disabled: true }] }), 'utf8')
  // A model that reaches for pip would install into this machine's own Python.
  process.env.PIP_REQUIRE_VIRTUALENV = '1'
  const serve = new ServeProcess(workspace, home, { args: ['--accept', 'none'] })
  const stopAnswering = serve.answerApprovals('rejected')
  try {
    await serve.request('initialize')
    const { sessionId } = await serve.request<{ sessionId: string }>('session/prompt', { text: prompt })
    try {
      await serve.waitFor(() => serve.events('turn/end', sessionId).find((event) => data<{ turn: number }>(event).turn === 1), 'turn 1 to end', 480_000)
    } catch (error) {
      const seen = serve.frames.filter((frame) => frame.sessionId === sessionId).map((frame) => frame.event)
      throw new Error(`${error instanceof Error ? error.message : String(error)} — ${describeShape(shapeOf(seen))}`, { cause: error })
    }
    const log = await serve.request<{ events: EventEnvelope[] }>('session/events', { sessionId })
    const model = data<{ header: { model: string } }>(log.events.find((event) => event.type === 'request/header')).header.model
    return { workspace, home, prompt, sessionId, events: log.events, model }
  } finally {
    stopAnswering()
    await serve.shutdown().catch(() => serve.kill())
  }
}

function officeSkillPath(home: string): string {
  const bundled = skillRootsFor(home).find((root) => root.origin === 'bundled')!
  return join(bundled.path, 'office', 'SKILL.md')
}

/** Office processes started during the arc: a model driving Word through COM leaves one behind. */
function strayOffice(since: Date): string[] {
  if (!win32) return []
  const list = spawnSync('pwsh', ['-NoProfile', '-Command', `Get-Process WINWORD,EXCEL,POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt [datetime]'${since.toISOString()}' } | ForEach-Object { $_.ProcessName + ':' + $_.Id }`], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  return list.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

describe.skipIf(!KEY)('S19 live E2E: skills as data', () => {
  it('the model finds the office skill in the list, reads it with ordinary tools, and its helper writes a document Python accepts; the log replays to the same bytes', { timeout: 900_000 }, async () => {
    const python = findPython()
    expect(python, 'the arc needs an independent reader: install Python 3 (py -3, python3 or python)').toBeDefined()
    const started = new Date()
    const prompt = 'Read requirements.pdf in this directory, then create report.docx from sales.csv exactly as it asks. If a skill listed for this environment fits, use it. Reply DONE when report.docx exists.'
    const run = await record(prompt)
    const shape = shapeOf(run.events)
    const why = describeShape(shape)
    console.log(`[skills arc] ${run.model} on ${process.platform}: ${why}`)

    // ---- the WORLD -----------------------------------------------------------
    const report = join(run.workspace, 'report.docx')
    expect(existsSync(report), `no report.docx: ${why}`).toBe(true)
    const read = readBack(python!, report, tempDir('minidsh-skills-py-'))
    expect(read.errors, 'Python reads the package without complaint').toEqual([])
    expect(read.mainType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    expect(read.officeDocument).toHaveLength(1)
    expect(read.paragraphs.some((paragraph) => paragraph.includes(TITLE)), `title missing from ${JSON.stringify(read.paragraphs)}`).toBe(true)
    expect(read.tables, 'the requirements ask for a table').toBeGreaterThanOrEqual(1)
    for (const [region, total] of totals()) {
      const row = read.rows.find((text) => text.includes(region) && numbersIn(text).includes(total))
      expect(row, `no table row gives ${region} = ${total}: ${JSON.stringify(read.rows)}`).toBeDefined()
    }
    const closing = `Top region: ${topRegion()}.`
    expect(read.paragraphs.some((paragraph) => paragraph.includes(closing)), `closing sentence missing from ${JSON.stringify(read.paragraphs.slice(-4))}`).toBe(true)

    // ---- the PREMISE: only a model that read the list could do these ---------
    expect(shape.list, 'the first batch carried the skill list').toBeDefined()
    const skillPath = norm(officeSkillPath(run.home))
    expect(norm(shape.list!)).toContain(skillPath)
    expect(shape.list).toMatch(/^- office: /m)
    expect(shape.list).toMatch(/^- pdf: /m)
    expect(shape.toolNames, 'no skill tool: the list names files, ordinary tools read them').not.toContain('skill')
    const firstReport = shape.calls.find((call) => call.args.includes('report.docx'))
    const readSkill = shape.calls.find((call) => !call.isError && call.args.includes(skillPath))
    expect(readSkill, `the office SKILL.md was never read: ${why}`).toBeDefined()
    expect(readSkill!.seq, 'read before the work that names report.docx').toBeLessThan(firstReport?.seq ?? Number.POSITIVE_INFINITY)
    expect(read.application, 'the document came from the skill helper').toBe('MiniDSH office.mjs')

    // ---- AUTHORITY: nothing needed consent ----------------------------------
    expect(shape.approvalsAsked, `an approval was asked: ${why}`).toBe(0)
    // A KEY of the shell's arguments, so the raw JSON, never the values-only text.
    expect(shape.calls.filter((call) => call.raw.includes('sandbox_permissions')).map((call) => call.raw)).toEqual([])
    if (!win32) console.log(`[skills arc] enforcement on ${process.platform}: ${shape.enforcement}`)
    if (process.platform === 'linux' && process.env.MINIDSH_EXPECT_CONFINEMENT === '1') expect(shape.enforcement, 'the helper ran under bwrap').toBe('full')
    const stray = strayOffice(started)
    if (stray.length > 0) console.log(`[skills arc] Office processes left behind: ${stray.join(', ')}`)
    expect(stray).toEqual([])

    // ---- keyless replay: the same bytes, from the same world -----------------
    const recorded = readFileSync(report)
    reset(run.workspace)
    let replayHandle: ReturnType<typeof installLlmReplay> | undefined
    const replayed = await runTask(
      {
        task: run.prompt,
        cwd: run.workspace,
        model: run.model,
        sessionsRoot: tempDir('minidsh-skills-replay-'),
        skillRoots: skillRootsFor(run.home),
        logger: silent,
        accepts: 'none',
        patches: [{ id: 'llm-deepseek', disabled: true }],
        prepare: (root) => {
          replayHandle = installLlmReplay(root, { events: run.events })
        },
      },
      undefined,
    )
    expect(replayed.exitCode).toBe(0)
    replayHandle!.assertConsumed()
    expect(existsSync(report), 'the replay wrote report.docx again').toBe(true)
    expect(readFileSync(report).equals(recorded), 'the replayed document is byte-identical').toBe(true)
  })

  /**
   * Reported, never asserted: how a model treats the list when nothing in the
   * prompt mentions skills (MINIDSH_SKILLS_NEUTRAL=1), and whether the task
   * still lands with no skills at all (MINIDSH_SKILLS_BASELINE=1). The first is
   * the "optional" half of the design; the second is the evidence a later
   * session needs to decide a skill no longer earns its place.
   */
  const NEUTRAL = 'Read requirements.pdf in this directory, then create report.docx from sales.csv exactly as it asks. Reply DONE when report.docx exists.'
  for (const leg of [
    { name: 'neutral', flag: 'MINIDSH_SKILLS_NEUTRAL', skillsDisabled: false },
    { name: 'baseline', flag: 'MINIDSH_SKILLS_BASELINE', skillsDisabled: true },
  ] as const) {
    it.skipIf(process.env[leg.flag] !== '1')(`${leg.name} leg (reported)`, { timeout: 900_000 }, async () => {
      const python = findPython()
      const started = Date.now()
      const run = await record(NEUTRAL, { skillsDisabled: leg.skillsDisabled })
      const shape = shapeOf(run.events)
      const report = join(run.workspace, 'report.docx')
      let world = 'no report.docx'
      if (existsSync(report) && python) {
        const read = readBack(python, report, tempDir('minidsh-skills-py-'))
        const rows = [...totals()].filter(([region, total]) => read.rows.some((text) => text.includes(region) && numbersIn(text).includes(total))).length
        world = `python errors ${read.errors.length}; title ${read.paragraphs.some((p) => p.includes(TITLE))}; rows ${rows}/4; closing ${read.paragraphs.some((p) => p.includes(`Top region: ${topRegion()}.`))}; app ${read.application}`
      }
      const skillPath = norm(officeSkillPath(run.home))
      const readSkill = shape.calls.some((call) => !call.isError && call.args.includes(skillPath))
      console.log(
        `[skills arc ${leg.name}] ${run.model}: list ${shape.list === undefined ? 'absent' : 'present'}; office skill read ${readSkill}; ${world}; ${Math.round((Date.now() - started) / 1000)} s; ${describeShape(shape)}`,
      )
    })
  }
})
