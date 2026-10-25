#!/usr/bin/env node
/**
 * pdf.mjs: read PDFs and write simple ones with Node alone.
 *
 * The helper of the bundled `pdf` skill. `read` and `info` handle the PDFs
 * people actually have — browser prints, Word exports, files with object
 * streams and broken offsets (see `pdf-parse.mjs`). `build` writes a plain
 * text document in the standard Helvetica fonts, which every viewer has, so
 * it needs no font file — and therefore handles only text the WinAnsi
 * encoding can carry. Anything richer (other scripts, images, real layout)
 * goes HTML → a probed Chrome or Edge, which the skill describes.
 *
 * Same habits as every skill helper: writes only the output path it is given,
 * never inside its own skill directory, never over a file without --force;
 * no prompts, no processes, no network, no temp directory.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, extname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { CliError, EXIT, fail, HELVETICA, PdfDoc, pageText, WIN_ANSI_HIGH } from './pdf-parse.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const SKILL_DIR = resolve(dirname(SCRIPT), '..')
const DEFAULT_MAX_CHARS = 20000

const HELP = `pdf.mjs: read PDFs and write simple ones with Node alone.

  probe                                 JSON: which converters exist here (Chrome, Edge, Chromium, soffice, pdftotext)
  info <file.pdf>                       JSON: pages, version, encryption, title, producer
  read <file.pdf> [--pages 1-3,5] [--max-chars N] [--json]
                                        the text of each page, in reading order; says when a page has no text
  build <spec.json|spec.md> <out.pdf>   a plain document in Helvetica: headings, paragraphs, lists, page numbers.
                                        Latin text only (WinAnsi); anything else: write HTML and print it with a
                                        probed Chrome/Edge (see the skill)

  spec.json: {"title"?, "pageSize"?: "A4"|"Letter", "blocks": [{"heading": "..", "level"?: 1|2} | {"paragraph": ".."} |
             {"bullets": [".."]} | {"numbered": [".."], "start"?: 1}]}
  spec.md:   # heading, ## heading, paragraphs separated by blank lines, "- " bullets, "1. " numbered items;
             *emphasis* markers are dropped, [text](url) prints as "text (url)"

  --force       overwrite an existing <out>
  --max-chars   read: maximum characters printed (default ${DEFAULT_MAX_CHARS}); the output says when it was cut

Writes only the output path given, never inside this skill's directory. Exit codes: 0 ok, 1 internal error,
2 usage, 3 input not found, 4 invalid input, 5 refused output, 6 unsupported (e.g. an encrypted PDF).`

// ---------------------------------------------------------------------------
// Arguments and output guards

const FLAGS = { force: 'switch', json: 'switch', help: 'switch', 'max-chars': 'value', pages: 'value' }

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

function guardOutput(out, force) {
  const abs = resolve(out)
  const skill = [SKILL_DIR, realish(SKILL_DIR)]
  for (const candidate of [abs, realish(abs)]) {
    if (skill.some((dir) => inside(candidate, dir))) throw fail(EXIT.refused, `refusing to write ${out}: it is inside this skill's directory ${SKILL_DIR}; write outputs in your workspace`)
  }
  if (!existsSync(dirname(abs))) throw fail(EXIT.refused, `the directory ${dirname(abs)} does not exist; create it first`)
  // A link is refused whatever it points at: writing through a dangling one creates its target, wherever that is.
  const existing = entryAt(abs)
  if (existing?.isSymbolicLink()) throw linkRefusal(out)
  if (existing) {
    if (existing.isDirectory()) throw fail(EXIT.refused, `${out} is a directory`)
    if (!force) throw fail(EXIT.refused, `${out} already exists; pass --force to overwrite it`)
  }
  return abs
}

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

function readInput(path, what) {
  try {
    return readFileSync(path)
  } catch (error) {
    throw fail(EXIT.input, `cannot read ${what} ${path}: ${error.code ?? error.message}`)
  }
}

const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)

// ---------------------------------------------------------------------------
// probe: PATH and well-known install locations, without running anything

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

function firstExisting(paths) {
  return paths.find((path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })
}

function probe() {
  const env = process.env
  const win = process.platform === 'win32'
  const mac = process.platform === 'darwin'
  const programRoots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean)
  const find = (names, known) => {
    for (const name of names) {
      const hit = onPath(name)
      if (hit) return hit
    }
    return firstExisting(known)
  }
  let libreoffice = []
  if (!win && !mac) {
    try {
      libreoffice = readdirSync('/opt').filter((e) => /^libreoffice/i.test(e)).map((e) => join('/opt', e, 'program', 'soffice'))
    } catch {
      // no /opt
    }
  }
  const tools = {
    chrome: find(win ? ['chrome'] : ['google-chrome', 'google-chrome-stable', 'chrome'], win ? programRoots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')) : mac ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/opt/google/chrome/chrome']),
    edge: find(win ? ['msedge'] : ['microsoft-edge', 'microsoft-edge-stable', 'msedge'], win ? programRoots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')) : mac ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/opt/microsoft/msedge/msedge']),
    chromium: find(['chromium', 'chromium-browser'], mac ? ['/Applications/Chromium.app/Contents/MacOS/Chromium'] : win ? [] : ['/snap/bin/chromium', '/usr/lib/chromium/chromium']),
    soffice: find(['soffice', 'libreoffice'], win ? programRoots.map((r) => join(r, 'LibreOffice', 'program', 'soffice.exe')) : mac ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice'] : ['/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', ...libreoffice]),
    pdftotext: find(['pdftotext'], []),
  }
  const browser = tools.chrome ?? tools.edge ?? tools.chromium
  const routes = ['read/info/build (Latin text) work here with Node alone']
  if (browser) routes.push(`HTML -> PDF: "${browser}" --headless --no-pdf-header-footer --print-to-pdf=<out.pdf> --user-data-dir=<dir> <file.html>`)
  if (tools.soffice) routes.push(`docx/xlsx/pptx -> PDF: "${tools.soffice}" -env:UserInstallation=file:///<dir> --headless --convert-to pdf --outdir <dir> <file>`)
  if (tools.pdftotext) routes.push(`second opinion on text: "${tools.pdftotext}" -layout <file.pdf> -`)
  if (!browser) routes.push('no browser found: a PDF that needs non-Latin text, images or styled layout cannot be made here; say so')
  print({ platform: process.platform, tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v ?? null])), routes })
}

// ---------------------------------------------------------------------------
// info, read

function open(file) {
  const doc = new PdfDoc(readInput(file, 'file'))
  return doc
}

function info(file) {
  const doc = open(file)
  const encrypted = doc.encrypted()
  const meta = encrypted ? {} : doc.info()
  print({ file: resolve(file), version: doc.version, pages: doc.pages().length, encrypted, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)), xref: doc.xrefKind, repaired: doc.repaired })
}

function pageList(spec, count) {
  if (spec === undefined) return Array.from({ length: count }, (_, i) => i + 1)
  const pages = new Set()
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part)
    if (!m) throw fail(EXIT.usage, `--pages expects a list like 1-3,5 (got "${spec}")`)
    const from = Number(m[1])
    const to = Number(m[2] ?? m[1])
    if (from < 1 || to < from || to > count) throw fail(EXIT.usage, `--pages ${part.trim()} is outside 1-${count}`)
    for (let p = from; p <= to; p++) pages.add(p)
  }
  return [...pages].toSorted((a, b) => a - b)
}

function read(file, { pages: pagesFlag, maxChars, json }) {
  const doc = open(file)
  if (doc.encrypted()) throw fail(EXIT.unsupported, `${file} is encrypted; this helper cannot decrypt it. If probe found pdftotext, try that; otherwise ask for an unencrypted copy.`)
  const all = doc.pages()
  const wanted = pageList(pagesFlag, all.length)
  const results = []
  let used = 0
  let truncated = false
  for (const number of wanted) {
    if (used >= maxChars) {
      truncated = true
      break
    }
    const { text, glyphs, unmapped, notes: skipped } = pageText(doc, all[number - 1])
    let note
    // What the reader skipped explains an empty page better than a guess at scanning does.
    if (glyphs === 0 && skipped.length > 0) note = undefined
    else if (glyphs === 0) note = 'no extractable text on this page (it may be a scanned image or drawn shapes)'
    else if (unmapped === glyphs) note = 'text is drawn with a font that has no Unicode map; it cannot be extracted (OCR would be needed)'
    // A page that draws only blank glyphs — Word puts a space on the empty page
    // after a page break — has nothing to extract; saying "OCR would be needed"
    // there would send a reader looking for text that does not exist.
    else if (text.replace(/[\s\u{FFFD}]/gu, '').length === 0) note = unmapped > 0 ? `only blank characters on this page, and ${unmapped} glyphs with no Unicode map` : 'only blank characters on this page'
    else if (unmapped > 0) note = `${unmapped} of ${glyphs} glyphs have no Unicode map (shown as \u{FFFD})`
    if (skipped.length > 0) note = [note, ...skipped].filter(Boolean).join('; ')
    let shown = text
    if (used + shown.length > maxChars) {
      shown = shown.slice(0, maxChars - used)
      truncated = true
    }
    used += shown.length
    results.push({ page: number, text: shown, ...(note ? { note } : {}) })
  }
  if (json) {
    print({ file: resolve(file), version: doc.version, pages: all.length, shown: results.map((r) => r.page), text: results, truncated, repaired: doc.repaired })
    return
  }
  const lines = [`file: ${resolve(file)} (PDF ${doc.version}, ${all.length} page${all.length === 1 ? '' : 's'}${pagesFlag ? `; pages ${pagesFlag}` : ''})`]
  if (doc.repaired) lines.push('(the cross-reference index is damaged; objects were found by scanning the file)')
  for (const r of results) {
    lines.push(`--- page ${r.page} ---`)
    if (r.note) lines.push(`(${r.note})`)
    if (r.text) lines.push(r.text)
  }
  if (truncated) lines.push(`[truncated at ${maxChars} characters; use --pages or --max-chars to see more]`)
  print(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// build

/** Unicode → WinAnsi byte for the 0x80..0x9F block; Latin-1 maps to itself. */
const TO_WIN_ANSI = new Map(WIN_ANSI_HIGH.flatMap((entry, i) => (entry[1] ? [[entry[1], 0x80 + i]] : [])))

function winAnsi(text, where) {
  let out = ''
  for (const ch of text.replace(/\t/g, '    ')) {
    const code = ch.codePointAt(0)
    if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff)) out += String.fromCharCode(code)
    else if (TO_WIN_ANSI.has(code)) out += String.fromCharCode(TO_WIN_ANSI.get(code))
    else if (code === 0x0a || code === 0x0d) out += ' '
    else {
      throw fail(EXIT.invalid, `${where}: the character "${ch}" (U+${code.toString(16).toUpperCase().padStart(4, '0')}) is outside the Latin (WinAnsi) set 'pdf build' supports. For other scripts write the document as HTML and print it with a Chrome or Edge that probe found (see the skill), or convert a .docx with soffice.`)
    }
  }
  return out
}

const PAGE = { A4: [595.28, 841.89], Letter: [612, 792] }
const MARGIN = 72
const STYLE = {
  title: { size: 22, bold: true, before: 0, after: 14 },
  h1: { size: 16, bold: true, before: 14, after: 6 },
  h2: { size: 13, bold: true, before: 10, after: 4 },
  p: { size: 11, bold: false, before: 0, after: 8 },
  li: { size: 11, bold: false, before: 0, after: 3 },
}

function textWidth(bytes, size, bold) {
  const table = bold ? HELVETICA.bold : HELVETICA.regular
  let w = 0
  for (let i = 0; i < bytes.length; i++) w += table[bytes.charCodeAt(i) - 32] ?? 556
  return (w / 1000) * size
}

/**
 * Greedy word wrap on WinAnsi bytes; a word wider than the line is split.
 *
 * A word too wide for a line is measured ONCE — the running sum of its glyph
 * widths — and each cut is a binary search over that sum: the longest piece
 * that fits, never less than one character. Measuring every candidate cut
 * from the start was cubic in the word, and a base64 data URI is one word:
 * 16,000 characters took 80 s (review, S20.5).
 */
function wrap(bytes, size, bold, width) {
  const table = bold ? HELVETICA.bold : HELVETICA.regular
  const fits = (units) => (units / 1000) * size <= width
  const lines = []
  let line = ''
  for (const word of bytes.split(' ').filter((w) => w.length > 0)) {
    const candidate = line ? `${line} ${word}` : word
    if (textWidth(candidate, size, bold) <= width) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    // units[i]: the width of word[0, i) in glyph units, textWidth's own sum.
    const units = new Float64Array(word.length + 1)
    for (let i = 0; i < word.length; i++) units[i + 1] = units[i] + (table[word.charCodeAt(i) - 32] ?? 556)
    let start = 0
    while (!fits(units[word.length] - units[start])) {
      let cut = start + 1
      let low = start + 2
      let high = word.length - 1
      while (low <= high) {
        const mid = (low + high) >>> 1
        if (fits(units[mid] - units[start])) {
          cut = mid
          low = mid + 1
        } else high = mid - 1
      }
      lines.push(word.slice(start, cut))
      start = cut
    }
    line = word.slice(start)
  }
  if (line || lines.length === 0) lines.push(line)
  return lines
}

/**
 * Inline Markdown as one font can print it: emphasis markers dropped rather
 * than printed, a link as "text (url)", code spans kept literally.
 */
function plainInline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((piece, i) => {
      if (i % 2 === 1) return piece.slice(1, -1)
      return piece
        .replace(/!?\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (_, label, url) => (label && label !== url ? `${label} (${url})` : url || label))
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/\*(?=\S)([^*]*?\S)\*/g, '$1')
        .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
    })
    .join('')
}

function parseMarkdown(text) {
  const blocks = []
  let paragraph = []
  let list
  const flush = () => {
    if (paragraph.length) blocks.push({ paragraph: paragraph.join(' ') })
    if (list) blocks.push(list.numbered ? { numbered: list.items, start: list.start } : { bullets: list.items })
    paragraph = []
    list = undefined
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    let number = /^(\d{1,9})[.)]\s+(.*)$/.exec(line)
    // As in CommonMark, only "1." starts a list inside a paragraph; "2024. was a year" continues it.
    if (number && paragraph.length > 0 && Number(number[1]) !== 1) number = null
    if (line.length === 0) flush()
    else if (heading) {
      flush()
      blocks.push({ heading: heading[2].replace(/\s+#+$/, ''), level: heading[1].length === 1 ? 1 : 2 })
    } else if (bullet || number) {
      if (paragraph.length || (list && list.numbered !== Boolean(number))) flush()
      list ??= { numbered: Boolean(number), start: number ? Number(number[1]) : undefined, items: [] }
      list.items.push(number ? number[2] : bullet[1])
    } else if (list && /^\s/.test(raw)) list.items[list.items.length - 1] += ` ${line}`
    else {
      if (list) flush()
      paragraph.push(line)
    }
  }
  flush()
  return blocks.map((b) => (b.paragraph ? { paragraph: plainInline(b.paragraph) } : b.bullets ? { bullets: b.bullets.map(plainInline) } : b.numbered ? { ...b, numbered: b.numbered.map(plainInline) } : { ...b, heading: plainInline(b.heading) }))
}

function loadSpec(path) {
  const raw = readInput(path, 'spec').toString('utf8').replace(/^\u{FEFF}/u, '')
  if (extname(path).toLowerCase() !== '.json') return { blocks: parseMarkdown(raw) }
  let spec
  try {
    spec = JSON.parse(raw)
  } catch (error) {
    throw fail(EXIT.invalid, `${path} is not valid JSON: ${error.message}`)
  }
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) throw fail(EXIT.invalid, 'spec: expected {"title"?, "blocks": [...]}')
  for (const key of Object.keys(spec)) if (!['title', 'blocks', 'pageSize'].includes(key)) throw fail(EXIT.invalid, `spec: unknown key "${key}"`)
  if (!Array.isArray(spec.blocks)) throw fail(EXIT.invalid, 'spec.blocks: expected an array')
  return spec
}

const pdfString = (bytes) => `(${bytes.replace(/[\\()]/g, (c) => `\\${c}`)})`

/** A PDF text string for /Info: PDFDocEncoding when it fits, UTF-16BE otherwise. */
function infoString(text) {
  if ([...text].every((ch) => ch.codePointAt(0) < 0x7f)) return pdfString(text)
  const units = Buffer.from(text, 'utf16le').swap16()
  return `<FEFF${units.toString('hex').toUpperCase()}>`
}

function build(specPath, out, force) {
  if (extname(out).toLowerCase() !== '.pdf') throw fail(EXIT.usage, `build writes a .pdf; got "${out}"`)
  const spec = loadSpec(specPath)
  // An own key only: "toString" is a property of every object, and it reached the page geometry.
  const sizeName = spec.pageSize ?? 'A4'
  if (typeof sizeName !== 'string' || !Object.hasOwn(PAGE, sizeName)) throw fail(EXIT.invalid, 'spec.pageSize: expected "A4" or "Letter"')
  const pageSize = PAGE[sizeName]
  const [pageW, pageH] = pageSize
  const width = pageW - 2 * MARGIN
  // Lay out every line first: page numbers need the page count.
  const items = []
  if (spec.title !== undefined) {
    if (typeof spec.title !== 'string') throw fail(EXIT.invalid, 'spec.title: expected a string')
    items.push({ style: STYLE.title, text: winAnsi(spec.title, 'spec.title') })
  }
  spec.blocks.forEach((block, i) => {
    const at = `spec.blocks[${i}]`
    if (typeof block !== 'object' || block === null) throw fail(EXIT.invalid, `${at}: expected a block`)
    if (typeof block.heading === 'string') {
      if (block.level !== undefined && block.level !== 1 && block.level !== 2) throw fail(EXIT.invalid, `${at}.level: expected 1 or 2`)
      items.push({ style: block.level === 2 ? STYLE.h2 : STYLE.h1, text: winAnsi(block.heading, `${at}.heading`) })
    } else if (typeof block.paragraph === 'string') items.push({ style: STYLE.p, text: winAnsi(block.paragraph, `${at}.paragraph`) })
    else if (Array.isArray(block.bullets) || Array.isArray(block.numbered)) {
      const key = Array.isArray(block.bullets) ? 'bullets' : 'numbered'
      const start = block.start ?? 1
      if (key === 'numbered' && !(Number.isInteger(start) && start >= 0)) throw fail(EXIT.invalid, `${at}.start: expected a whole number`)
      block[key].forEach((b, k) => {
        if (typeof b !== 'string') throw fail(EXIT.invalid, `${at}.${key}[${k}]: expected a string`)
        items.push({ style: STYLE.li, text: winAnsi(b, `${at}.${key}[${k}]`), marker: key === 'bullets' ? '\x95' : `${start + k}.` })
      })
      if (block[key].length > 0) items.at(-1).style = { ...STYLE.li, after: 8 }
    } else throw fail(EXIT.invalid, `${at}: a block is {"heading"}, {"paragraph"}, {"bullets"} or {"numbered"}`)
  })
  const abs = guardOutput(out, force)
  const pages = [[]]
  let y = pageH - MARGIN
  const bottom = MARGIN + 24
  for (const item of items) {
    const { size, bold, before, after } = item.style
    const indent = item.marker ? 18 : 0
    const lines = wrap(item.text, size, bold, width - indent)
    const leading = size * 1.35
    // A heading keeps at least two following lines with it.
    const need = before + leading * Math.min(lines.length, item.style === STYLE.p || item.marker ? 2 : 1) + (bold ? 2 * 11 * 1.35 : 0)
    if (y - need < bottom && pages.at(-1).length > 0) {
      pages.push([])
      y = pageH - MARGIN
    } else if (pages.at(-1).length > 0) y -= before
    lines.forEach((line, k) => {
      if (y - leading < bottom) {
        pages.push([])
        y = pageH - MARGIN
      }
      y -= leading
      // A bullet sits at the left; a number ends just before the text, whatever its width.
      if (item.marker && k === 0) pages.at(-1).push({ x: item.marker === '\x95' ? MARGIN + 4 : MARGIN + indent - 4 - textWidth(item.marker, size, bold), y, size, bold, text: item.marker })
      pages.at(-1).push({ x: MARGIN + indent, y, size, bold, text: line })
    })
    y -= after
  }
  const objects = []
  const add = (body) => objects.push(body) // object number = index + 1
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // pages, filled below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  add(`<< /Producer (MiniDSH pdf.mjs)${spec.title !== undefined ? ` /Title ${infoString(spec.title)}` : ''} >>`)
  const kids = []
  pages.forEach((lines, index) => {
    const footer = `Page ${index + 1} of ${pages.length}`
    const ops = lines.map((l) => `BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf ${l.x.toFixed(2)} ${l.y.toFixed(2)} Td ${pdfString(l.text)} Tj ET`)
    ops.push(`BT /F1 9 Tf ${((pageW - textWidth(footer, 9, false)) / 2).toFixed(2)} ${(MARGIN / 2).toFixed(2)} Td ${pdfString(footer)} Tj ET`)
    const content = deflateSync(Buffer.from(ops.join('\n'), 'latin1'))
    add(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString('latin1')}\nendstream`)
    const contentNum = objects.length
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`)
    kids.push(`${objects.length} 0 R`)
  })
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  // Every string here is latin1, one character per byte, so offsets are string lengths.
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = Buffer.from(pdf, 'latin1')
  write(abs, out, bytes, force)
  print({ wrote: abs, pages: pages.length, bytes: bytes.length, next: `node "${SCRIPT}" read "${out}"` })
}

// ---------------------------------------------------------------------------

function main(argv) {
  const { positional, flags } = parseArgs(argv)
  const [command, ...args] = positional
  if (command === undefined || command === 'help' || flags.get('help')) return print(HELP)
  const need = (count, usage) => {
    if (args.length !== count) throw fail(EXIT.usage, `usage: ${usage}`)
  }
  switch (command) {
    case 'probe':
      need(0, 'probe')
      return probe()
    case 'info':
      need(1, 'info <file.pdf>')
      return info(args[0])
    case 'read': {
      need(1, 'read <file.pdf> [--pages 1-3] [--max-chars N] [--json]')
      const maxChars = Number(flags.get('max-chars') ?? DEFAULT_MAX_CHARS)
      if (!Number.isInteger(maxChars) || maxChars <= 0) throw fail(EXIT.usage, '--max-chars expects a positive integer')
      return read(args[0], { pages: flags.get('pages'), maxChars, json: flags.get('json') === true })
    }
    case 'build':
      need(2, 'build <spec.json|spec.md> <out.pdf> [--force]')
      return build(args[0], args[1], flags.get('force') === true)
    default:
      throw fail(EXIT.usage, `unknown command "${command}" (see --help)`)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`pdf.mjs: ${error.message}\n`)
    process.exitCode = error.exitCode
  } else {
    process.stderr.write(`pdf.mjs: internal error: ${error?.stack ?? error}\n`)
    process.exitCode = EXIT.internal
  }
}
