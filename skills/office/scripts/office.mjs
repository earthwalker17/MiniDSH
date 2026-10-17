#!/usr/bin/env node
/**
 * office.mjs: make, read and edit .docx, .xlsx and .pptx with Node alone.
 *
 * The helper of the bundled `office` skill. A model reaches it through an
 * ordinary shell command, under the same sandbox, acceptance and approvals as
 * any command it runs, so the helper keeps the habits a careful tool keeps in
 * a stranger's workspace: it writes only the output path it is given, never
 * into its own skill directory, never over an existing file without --force,
 * prompts for nothing, starts no process, opens no network, and makes no temp
 * directory. Errors go to stderr with an exit code per class (see --help).
 *
 * Commands live here; the ZIP/XML/package layer is `ooxml.mjs`, the builders
 * `build.mjs`, the readers `read.mjs`.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { buildDocx, buildPptx, buildXlsx, GENERATOR } from './build.mjs'
import { checkPackage, CliError, EXIT, fail, familyOf, indentXml, MAIN_TYPES, PackageMembers, parseXml, readZip, unsafeMemberName, writeZip } from './ooxml.mjs'
import { readPackage } from './read.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const SKILL_DIR = resolve(dirname(SCRIPT), '..')
const SELF = `node "${SCRIPT}"`
const DEFAULT_MAX_CHARS = 20000

const HELP = `office.mjs: create, read and edit Office files with Node alone (no Office, Python or LibreOffice).

  probe                            JSON: is a renderer (LibreOffice soffice) available here?
  build <spec.json> <out>          create a .docx, .xlsx or .pptx from a JSON spec (format from <out>'s extension)
  read <file> [--max-chars N]      text dump: docx paragraphs/styles/marks/tables, xlsx cells/formulas, pptx slides/notes
  unpack <file> <dir> [--raw]      extract the parts into a new or empty <dir>, XML re-indented for editing (--raw keeps bytes)
  pack <dir> <out>                 validate the parts and write a NEW package; refuses broken XML, missing content types,
                                   a missing main part or relationship target, and names the part, line and column

  --force       overwrite an existing <out>
  --max-chars   read: maximum characters printed (default ${DEFAULT_MAX_CHARS}); the output says when it was cut
  --help        this text; "<command> --help" prints the spec for build

Writes only the output path given, never inside this skill's directory. Exit codes: 0 ok, 1 internal error,
2 usage, 3 input not found, 4 invalid input (spec, XML or package), 5 refused output, 6 unsupported file.`

const BUILD_HELP = `build <spec.json> <out.docx|out.xlsx|out.pptx> [--force]

docx: {"title"?, "pageSize"?: "A4"|"Letter", "body": [
         {"heading": "text", "level": 1|2|3} | {"paragraph": "text" | Run[]} | {"bullets": [item...]} |
         {"numbered": [item...]} | {"table": {"header"?: [..], "rows": [[string|number,...],...]}} | {"pageBreak": true} ]}
      Run = {"text", "bold"?, "italic"?, "underline"?}; an item is a string or Run[]; each numbered list restarts at 1.
xlsx: {"sheets": [{"name", "rows": [[Cell,...],...], "columnWidths"?: [chars|null,...], "freezeHeader"?, "boldHeader"?}]}
      Cell = string | number | boolean | null | {"formula": "SUM(B2:B4)", "value"?: cached} |
             {"value": number|string, "format"?: "0.00"} | {"date": "YYYY-MM-DD", "format"?}
      Formulas are not calculated here: give "value" when you know it; Excel recalculates on open.
pptx: {"title"?, "slides": [{"title", "bullets"?: [..], "text"?: "paragraphs\\n\\nseparated", "notes"?}]}  16:9`

// ---------------------------------------------------------------------------
// Arguments and output guards

const FLAGS = { force: 'switch', raw: 'switch', help: 'switch', 'max-chars': 'value' }

function parseArgs(argv) {
  const positional = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h') {
      flags.set('help', true)
      continue
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq < 0 ? undefined : eq)
    if (!Object.hasOwn(FLAGS, name)) throw fail(EXIT.usage, `unknown option --${name} (see --help)`)
    if (FLAGS[name] === 'switch') {
      if (eq >= 0) throw fail(EXIT.usage, `--${name} takes no value`)
      flags.set(name, true)
    } else {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i]
      if (value === undefined) throw fail(EXIT.usage, `--${name} needs a value`)
      flags.set(name, value)
    }
  }
  return { positional, flags }
}

const forCompare = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)

function inside(child, parent) {
  const c = forCompare(child)
  const p = forCompare(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** The real path of the nearest existing ancestor, with the rest re-attached: catches a symlink into the skill. */
function realish(path) {
  const rest = []
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return path
    rest.unshift(basename(current))
    current = parent
  }
  try {
    return join(realpathSync.native(current), ...rest)
  } catch {
    return path
  }
}

/** The entry at a path itself, a link included; undefined when nothing is there. */
function entryAt(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

const linkRefusal = (out) => fail(EXIT.refused, `${out} is a symbolic link; refusing to write through it (name a new path)`)

function guardOutput(out, { force, directory = false }) {
  const abs = resolve(out)
  const skill = [SKILL_DIR, realish(SKILL_DIR)]
  for (const candidate of [abs, realish(abs)]) {
    if (skill.some((dir) => inside(candidate, dir) || inside(dir, candidate))) throw fail(EXIT.refused, `refusing to write ${out}: it is inside (or contains) this skill's directory ${SKILL_DIR}; write outputs in your workspace`)
  }
  if (!existsSync(dirname(abs))) throw fail(EXIT.refused, `the directory ${dirname(abs)} does not exist; create it first`)
  // A link is refused whatever it points at: writing through a dangling one creates its target, wherever that is.
  const existing = entryAt(abs)
  if (existing?.isSymbolicLink()) throw linkRefusal(out)
  if (directory) {
    if (existing && (!existing.isDirectory() || readdirSync(abs).length > 0)) throw fail(EXIT.refused, `${out} exists and is not an empty directory; unpack into a new directory`)
    return abs
  }
  if (existing) {
    if (existing.isDirectory()) throw fail(EXIT.refused, `${out} is a directory`)
    if (!force) throw fail(EXIT.refused, `${out} already exists; pass --force to overwrite it`)
  }
  return abs
}

function readInput(path, what) {
  try {
    return readFileSync(path)
  } catch (error) {
    throw fail(EXIT.input, `cannot read ${what} ${path}: ${error.code ?? error.message}`)
  }
}

const extOf = (path) => extname(path).slice(1).toLowerCase()

/**
 * Creates the output, never opening an existing path: --force removes the old
 * file first, and 'wx' then refuses anything that appeared in between, a link
 * included, instead of following it.
 */
function write(abs, out, bytes, force) {
  try {
    if (force) {
      const existing = entryAt(abs)
      if (existing?.isSymbolicLink()) throw linkRefusal(out)
      if (existing?.isFile()) unlinkSync(abs)
    }
    writeFileSync(abs, bytes, { flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') throw fail(EXIT.refused, `${out} already exists; pass --force to overwrite it`)
    throw error
  }
}

const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)

// ---------------------------------------------------------------------------
// probe

/** PATH lookup without running anything: honours PATHEXT on Windows. */
function onPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + ext)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return undefined
}

function findSoffice() {
  const env = process.env
  const known = []
  if (process.platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) if (root) known.push(join(root, 'LibreOffice', 'program', 'soffice.exe'))
  } else if (process.platform === 'darwin') known.push('/Applications/LibreOffice.app/Contents/MacOS/soffice')
  else {
    known.push('/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice')
    try {
      for (const entry of readdirSync('/opt')) if (/^libreoffice/i.test(entry)) known.push(join('/opt', entry, 'program', 'soffice'))
    } catch {
      // no /opt
    }
  }
  return onPath('soffice') ?? onPath('libreoffice') ?? known.find((path) => existsSync(path))
}

function probe() {
  const soffice = findSoffice()
  print({
    platform: process.platform,
    node: process.version,
    soffice: soffice ?? null,
    renderer: soffice !== undefined,
    advice: soffice
      ? 'build/read/unpack/pack work here. For a visual check, convert with soffice (see the skill) and look at the result.'
      : 'build/read/unpack/pack work here. No renderer was found: verify content with read, and say that the visual appearance was not checked.',
  })
}

// ---------------------------------------------------------------------------
// build, read, unpack, pack

function build(specPath, out, force) {
  const ext = extOf(out)
  const builder = { docx: buildDocx, xlsx: buildXlsx, pptx: buildPptx }[ext]
  if (!builder) throw fail(EXIT.usage, `build writes .docx, .xlsx or .pptx; got "${out}"`)
  const raw = readInput(specPath, 'spec').toString('utf8').replace(/^\u{FEFF}/u, '')
  let spec
  try {
    spec = JSON.parse(raw)
  } catch (error) {
    throw fail(EXIT.invalid, `${specPath} is not valid JSON: ${error.message}`)
  }
  const abs = guardOutput(out, { force })
  const entries = builder(spec)
  const { problems } = checkPackage(new Map(entries.map((e) => [e.name, e.data])), ext)
  if (problems.length > 0) throw fail(EXIT.internal, `internal error: the built package fails its own checks:\n${problems.join('\n')}`)
  const bytes = writeZip(entries)
  write(abs, out, bytes, force)
  print({ wrote: abs, format: ext, parts: entries.length, bytes: bytes.length, generator: GENERATOR, warnings: entries.warnings ?? [], next: `${SELF} read "${out}"` })
}

function openPackage(file) {
  const entries = readZip(readInput(file, 'file'), file)
  const members = new PackageMembers()
  const duplicates = []
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    if (members.has(entry.name)) duplicates.push(entry.name)
    members.set(entry.name, entry)
  }
  return { members, duplicates }
}

function read(file, maxChars) {
  const { members, duplicates } = openPackage(file)
  const ext = extOf(file)
  const { problems, main: mainPart, types } = checkPackage(members, MAIN_TYPES[ext] ? ext : undefined)
  for (const name of duplicates) problems.unshift(`${name}: appears more than once in the ZIP (Office may refuse the file)`)
  const family = (mainPart && types ? familyOf(types.typeOf(mainPart) ?? '') : undefined) ?? familyOf(ext)
  if (!mainPart || !family || !members.has(mainPart)) throw fail(EXIT.invalid, `${file}: not a readable Office package${problems.length ? `:\n${problems.slice(0, 10).join('\n')}` : ''}`)
  let text = `file: ${resolve(file)}\n`
  if (problems.length) text += `package problems (pack would refuse these):\n${problems.slice(0, 15).map((p) => `  ${p}`).join('\n')}\n`
  text += readPackage(members, mainPart, family, maxChars)
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[truncated: showed ${maxChars} characters; pass --max-chars to see more]`
  print(text)
}

function unpack(file, dir, raw) {
  const { members, duplicates } = openPackage(file)
  if (duplicates.length) throw fail(EXIT.invalid, `${file}: members appear more than once (${duplicates.slice(0, 5).join(', ')}); refusing to pick one`)
  const seen = new Map()
  for (const name of members.keys()) {
    const why = unsafeMemberName(name)
    if (why) throw fail(EXIT.invalid, `${file}: refusing member "${name}": ${why}`)
    const lower = name.toLowerCase()
    if (seen.has(lower)) throw fail(EXIT.invalid, `${file}: members "${seen.get(lower)}" and "${name}" differ only in case`)
    seen.set(lower, name)
  }
  // A member named like another's directory ("a" beside "a/b") cannot be written beside it.
  for (const lower of seen.keys()) {
    for (let slash = lower.indexOf('/'); slash >= 0; slash = lower.indexOf('/', slash + 1)) {
      const parent = seen.get(lower.slice(0, slash))
      if (parent !== undefined) throw fail(EXIT.invalid, `${file}: member "${parent}" is also the directory of "${seen.get(lower)}"`)
    }
  }
  const abs = guardOutput(dir, { force: false, directory: true })
  mkdirSync(abs, { recursive: true })
  const warnings = []
  for (const [name, bytes] of members) {
    const target = resolve(abs, ...name.split('/'))
    if (!inside(target, abs) || target === abs) throw fail(EXIT.invalid, `refusing member "${name}": it resolves outside ${dir}`)
    let data = bytes
    // UTF-16 parts (rare) keep their bytes: re-encoding would contradict their XML declaration.
    if (!raw && /\.(xml|rels)$/i.test(name) && bytes[0] !== 0xff && bytes[0] !== 0xfe) {
      try {
        parseXml(bytes, name)
        data = Buffer.from(indentXml(bytes.toString('utf8').replace(/^\u{FEFF}/u, '')), 'utf8')
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        warnings.push(`${error.message} (written unchanged)`)
      }
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data, { flag: 'wx' })
  }
  const { main: mainPart } = checkPackage(members, undefined)
  print({ unpacked: abs, parts: members.size, main: mainPart ?? null, indented: !raw, warnings, next: `edit the parts, then: ${SELF} pack "${dir}" <new file>` })
}

function collect(dir) {
  const files = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current).toSorted()) {
      const full = join(current, entry)
      const info = lstatSync(full)
      if (info.isSymbolicLink()) throw fail(EXIT.invalid, `${full} is a symbolic link; pack takes regular files only`)
      if (info.isDirectory()) walk(full)
      else if (info.isFile()) files.set(relative(dir, full).split(sep).join('/'), readFileSync(full))
    }
  }
  walk(dir)
  return files
}

function pack(dir, out, force) {
  const ext = extOf(out)
  if (!MAIN_TYPES[ext]) throw fail(EXIT.usage, `pack writes an Office package (.docx, .xlsx, .pptx, …); got "${out}"`)
  const source = resolve(dir)
  if (!existsSync(source) || !statSync(source).isDirectory()) throw fail(EXIT.input, `${dir} is not a directory`)
  const abs = guardOutput(out, { force })
  if (inside(abs, source)) throw fail(EXIT.refused, `refusing to write ${out} inside the directory being packed`)
  const members = collect(source)
  const { problems } = checkPackage(members, ext)
  if (problems.length > 0) throw fail(EXIT.invalid, `pack refused ${dir} (${problems.length} problem${problems.length === 1 ? '' : 's'}); nothing was written:\n${problems.slice(0, 30).join('\n')}`)
  // [Content_Types].xml first, then every other member once, sorted.
  const names = ['[Content_Types].xml', ...[...members.keys()].filter((n) => n !== '[Content_Types].xml').toSorted()]
  const bytes = writeZip(names.map((name) => ({ name, data: members.get(name) })))
  write(abs, out, bytes, force)
  print({ wrote: abs, format: ext, parts: names.length, bytes: bytes.length, next: `${SELF} read "${out}"` })
}

// ---------------------------------------------------------------------------

function main(argv) {
  const { positional, flags } = parseArgs(argv)
  const [command, ...args] = positional
  if (command === undefined || command === 'help') return print(HELP)
  if (flags.get('help')) return print(command === 'build' ? BUILD_HELP : HELP)
  const need = (count, usage) => {
    if (args.length !== count) throw fail(EXIT.usage, `usage: ${usage}`)
  }
  const force = flags.get('force') === true
  switch (command) {
    case 'probe':
      need(0, 'probe')
      return probe()
    case 'build':
      need(2, 'build <spec.json> <out.docx|out.xlsx|out.pptx> [--force]')
      return build(args[0], args[1], force)
    case 'read': {
      need(1, 'read <file> [--max-chars N]')
      const max = Number(flags.get('max-chars') ?? DEFAULT_MAX_CHARS)
      if (!Number.isInteger(max) || max <= 0) throw fail(EXIT.usage, '--max-chars expects a positive integer')
      return read(args[0], max)
    }
    case 'unpack':
      need(2, 'unpack <file> <new-or-empty-dir> [--raw]')
      return unpack(args[0], args[1], flags.get('raw') === true)
    case 'pack':
      need(2, 'pack <dir> <out> [--force]')
      return pack(args[0], args[1], force)
    default:
      throw fail(EXIT.usage, `unknown command "${command}" (see --help)`)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`office.mjs: ${error.message}\n`)
    process.exitCode = error.exitCode
  } else {
    process.stderr.write(`office.mjs: internal error: ${error?.stack ?? error}\n`)
    process.exitCode = EXIT.internal
  }
}
