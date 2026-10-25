/**
 * `office.mjs build`: a JSON spec in, a complete .docx, .xlsx or .pptx out.
 *
 * Each builder writes every part its format needs to open cleanly in Word,
 * Excel, PowerPoint and LibreOffice — styles, numbering, a theme, the master
 * and layout chain — with child elements in the order the schemas require.
 * Office repairs (or refuses) a part whose children are out of order even
 * when the XML is well-formed, so the order here is load-bearing; the
 * comments name the schema sequence where it bites.
 *
 * Nothing reads the clock: docProps/core.xml carries no dates, and
 * docProps/app.xml names this generator, so a file it built can be told from
 * one Office saved.
 */
import { EXIT, esc, escAttr, fail } from './ooxml.mjs'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const CT = 'application/vnd.openxmlformats-officedocument'
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const GENERATOR = 'MiniDSH office.mjs'

const bad = (path, why) => fail(EXIT.invalid, `spec${path}: ${why}`)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function onlyKeys(value, path, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw bad(path, `unknown key "${key}" (allowed: ${allowed.join(', ')})`)
}

function stringAt(value, path) {
  if (typeof value !== 'string') throw bad(path, 'expected a string')
  esc(value, `spec${path}`)
  return value
}

function contentTypesXml(defaults, overrides) {
  const d = defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('')
  const o = overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('')
  return `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${d}${o}</Types>`
}

function relsXml(rels) {
  const body = rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${escAttr(target)}"/>`).join('')
  return `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
}

/** No created/modified dates: they would make two builds of one spec differ. */
function coreXml(title) {
  const t = title === undefined ? '' : `<dc:title>${esc(title)}</dc:title>`
  return `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${t}</cp:coreProperties>`
}

function appXml() {
  return `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${GENERATOR}</Application></Properties>`
}

const PACKAGE_RELS = (main) =>
  relsXml([
    ['rId1', `${RT}/officeDocument`, main],
    ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
    ['rId3', `${RT}/extended-properties`, 'docProps/app.xml'],
  ])

const DOC_PROPS_TYPES = [
  ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ['docProps/app.xml', `${CT}.extended-properties+xml`],
]

const BASE_DEFAULTS = [
  ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
  ['xml', 'application/xml'],
]

/** [Content_Types].xml first, then the parts in the order each builder lists them. */
function finish(parts) {
  return parts.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') }))
}

// ---------------------------------------------------------------------------
// docx

const PAGE = { A4: { w: 11906, h: 16838 }, Letter: { w: 12240, h: 15840 } }
const MARGIN = 1440

/** `"text"` or `[{text, bold, italic, underline}]` → runs, validated. */
function runsOf(value, path) {
  if (typeof value === 'string') return [{ text: stringAt(value, path) }]
  if (!Array.isArray(value)) throw bad(path, 'expected a string or an array of runs')
  return value.map((run, i) => {
    const at = `${path}[${i}]`
    if (typeof run === 'string') return { text: stringAt(run, at) }
    if (!isObject(run)) throw bad(at, 'a run is a string or {"text", "bold"?, "italic"?, "underline"?}')
    onlyKeys(run, at, ['text', 'bold', 'italic', 'underline'])
    for (const flag of ['bold', 'italic', 'underline']) if (run[flag] !== undefined && typeof run[flag] !== 'boolean') throw bad(`${at}.${flag}`, 'expected true or false')
    return { text: stringAt(run.text, `${at}.text`), bold: run.bold === true, italic: run.italic === true, underline: run.underline === true }
  })
}

/** One `w:r` per line/tab piece. `w:rPr` children in schema order: b, i, …, u. */
function runXml(run) {
  const props = `${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${run.underline ? '<w:u w:val="single"/>' : ''}`
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : ''
  let body = ''
  run.text.split('\n').forEach((line, lineIndex) => {
    if (lineIndex > 0) body += '<w:br/>'
    line.split('\t').forEach((piece, tabIndex) => {
      if (tabIndex > 0) body += '<w:tab/>'
      if (piece.length > 0) body += `<w:t xml:space="preserve">${esc(piece)}</w:t>`
    })
  })
  return `<w:r>${rPr}${body}</w:r>`
}

/** `w:pPr` children in schema order: pStyle, keepNext, …, numPr, …, spacing, ind, …, jc. */
function paragraphXml(runs, { style, numId, jc } = {}) {
  const props = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${numId !== undefined ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : ''}${jc ? `<w:jc w:val="${jc}"/>` : ''}`
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs.map(runXml).join('')}</w:p>`
}

function tableXml(table, path, textWidth) {
  if (!isObject(table)) throw bad(path, 'expected {"header"?: [...], "rows": [[...]]}')
  onlyKeys(table, path, ['header', 'rows'])
  const header = table.header === undefined ? undefined : table.header
  if (header !== undefined && !Array.isArray(header)) throw bad(`${path}.header`, 'expected an array of strings')
  if (!Array.isArray(table.rows)) throw bad(`${path}.rows`, 'expected an array of rows')
  const cell = (value, at) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw bad(at, 'expected a finite number')
      return { text: String(value), number: true }
    }
    if (typeof value === 'string') return { text: stringAt(value, at), number: false }
    throw bad(at, 'expected a string or a number')
  }
  const rows = []
  if (header) rows.push({ header: true, cells: header.map((v, i) => cell(v, `${path}.header[${i}]`)) })
  table.rows.forEach((row, r) => {
    if (!Array.isArray(row)) throw bad(`${path}.rows[${r}]`, 'expected an array of cells')
    rows.push({ header: false, cells: row.map((v, c) => cell(v, `${path}.rows[${r}][${c}]`)) })
  })
  const columns = Math.max(1, ...rows.map((row) => row.cells.length))
  const width = Math.floor(textWidth / columns)
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')
  const body = rows
    .map((row) => {
      // w:tr: trPr before the cells; every w:tc holds at least one w:p.
      const cells = Array.from({ length: columns }, (_, c) => row.cells[c] ?? { text: '', number: false })
        .map((c) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraphXml(c.text ? [{ text: c.text, bold: row.header }] : [], c.number ? { jc: 'right' } : {})}</w:tc>`)
        .join('')
      return `<w:tr>${row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`
    })
    .join('')
  // w:tblPr children in schema order: tblStyle, …, tblW, …, tblLook.
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
}

const STYLES_XML = `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>\
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>\
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>\
${[1, 2, 3]
  .map(
    (level) =>
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="${level === 1 ? 120 : 80}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="${[32, 28, 24][level - 1]}"/><w:szCs w:val="${[32, 28, 24][level - 1]}"/></w:rPr></w:style>`,
  )
  .join('')}\
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>\
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>\
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('')}</w:tblBorders></w:tblPr></w:style>\
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style></w:styles>`

const SETTINGS_XML = `${DECL}<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`

/**
 * One bullet abstract list shared by every bulleted list, one decimal abstract
 * list, and one `w:num` per numbered list carrying a `startOverride` — so each
 * numbered list in the spec restarts at 1, as an author expects. Schema order:
 * every `w:abstractNum` before any `w:num`.
 */
function numberingXml(numberedLists) {
  const level = (format, text) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`
  const nums = [`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`]
  for (let k = 0; k < numberedLists; k++) nums.push(`<w:num w:numId="${k + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`)
  return `${DECL}<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${level('bullet', '\u{2022}')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${level('decimal', '%1.')}</w:abstractNum>${nums.join('')}</w:numbering>`
}

export function buildDocx(spec) {
  if (!isObject(spec)) throw bad('', 'expected an object {"title"?, "body": [...]}')
  onlyKeys(spec, '', ['title', 'body', 'pageSize'])
  const title = spec.title === undefined ? undefined : stringAt(spec.title, '.title')
  // An own key only: "toString" is a property of every object, and it reached the page geometry.
  const sizeName = spec.pageSize ?? 'A4'
  if (typeof sizeName !== 'string' || !Object.hasOwn(PAGE, sizeName)) throw bad('.pageSize', 'expected "A4" or "Letter"')
  const page = PAGE[sizeName]
  if (!Array.isArray(spec.body)) throw bad('.body', 'expected an array of blocks')
  const textWidth = page.w - 2 * MARGIN
  const blocks = []
  let numbered = 0
  let lists = false
  if (title !== undefined) blocks.push({ kind: 'p', xml: paragraphXml([{ text: title }], { style: 'Title' }) })
  spec.body.forEach((block, index) => {
    const path = `.body[${index}]`
    if (!isObject(block)) throw bad(path, 'expected a block object')
    const kinds = ['heading', 'paragraph', 'bullets', 'numbered', 'table', 'pageBreak'].filter((k) => k in block)
    if (kinds.length !== 1) throw bad(path, 'a block has exactly one of heading, paragraph, bullets, numbered, table, pageBreak')
    const kind = kinds[0]
    if (kind === 'heading') {
      onlyKeys(block, path, ['heading', 'level'])
      const level = block.level ?? 1
      if (![1, 2, 3].includes(level)) throw bad(`${path}.level`, 'expected 1, 2 or 3')
      blocks.push({ kind: 'p', xml: paragraphXml([{ text: stringAt(block.heading, `${path}.heading`) }], { style: `Heading${level}` }) })
    } else if (kind === 'paragraph') {
      onlyKeys(block, path, ['paragraph'])
      blocks.push({ kind: 'p', xml: paragraphXml(runsOf(block.paragraph, `${path}.paragraph`)) })
    } else if (kind === 'bullets' || kind === 'numbered') {
      onlyKeys(block, path, [kind])
      if (!Array.isArray(block[kind]) || block[kind].length === 0) throw bad(`${path}.${kind}`, 'expected a non-empty array of items')
      lists = true
      const numId = kind === 'bullets' ? 1 : 2 + numbered++
      for (const [i, item] of block[kind].entries()) blocks.push({ kind: 'p', xml: paragraphXml(runsOf(item, `${path}.${kind}[${i}]`), { style: 'ListParagraph', numId }) })
    } else if (kind === 'table') {
      onlyKeys(block, path, ['table'])
      // Two tables in a row would merge into one; a table cannot end the body.
      if (blocks.at(-1)?.kind === 'tbl') blocks.push({ kind: 'p', xml: '<w:p/>' })
      blocks.push({ kind: 'tbl', xml: tableXml(block.table, `${path}.table`, textWidth) })
    } else {
      onlyKeys(block, path, ['pageBreak'])
      if (block.pageBreak !== true) throw bad(`${path}.pageBreak`, 'expected true')
      blocks.push({ kind: 'p', xml: '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' })
    }
  })
  if (blocks.length === 0 || blocks.at(-1).kind === 'tbl') blocks.push({ kind: 'p', xml: '<w:p/>' })
  const sectPr = `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>`
  const document = `${DECL}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${blocks.map((b) => b.xml).join('')}${sectPr}</w:body></w:document>`
  const docRels = [
    ['rId1', `${RT}/styles`, 'styles.xml'],
    ['rId2', `${RT}/settings`, 'settings.xml'],
  ]
  const overrides = [
    ['word/document.xml', `${CT}.wordprocessingml.document.main+xml`],
    ['word/styles.xml', `${CT}.wordprocessingml.styles+xml`],
    ['word/settings.xml', `${CT}.wordprocessingml.settings+xml`],
  ]
  if (lists) {
    docRels.push(['rId3', `${RT}/numbering`, 'numbering.xml'])
    overrides.push(['word/numbering.xml', `${CT}.wordprocessingml.numbering+xml`])
  }
  overrides.push(...DOC_PROPS_TYPES)
  const parts = [
    ['[Content_Types].xml', contentTypesXml(BASE_DEFAULTS, overrides)],
    ['_rels/.rels', PACKAGE_RELS('word/document.xml')],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', relsXml(docRels)],
    ['word/styles.xml', STYLES_XML],
    ['word/settings.xml', SETTINGS_XML],
  ]
  if (lists) parts.push(['word/numbering.xml', numberingXml(numbered)])
  parts.push(['docProps/core.xml', coreXml(title)], ['docProps/app.xml', appXml()])
  return finish(parts)
}

// ---------------------------------------------------------------------------
// xlsx

/** Cell text as Excel stores it: a literal `_xHHHH_` would read back as one escaped character, so its underscore becomes `_x005F_`. */
const xstring = (text) => esc(text).replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_')

export function columnName(index) {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** Excel's built-in number formats: a code that matches one uses its id instead of a custom entry. */
const BUILTIN_FORMATS = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11, 'mm-dd-yy': 14, 'd-mmm-yy': 15, 'h:mm': 20, 'h:mm:ss': 21, '@': 49 }

/** Days since 1899-12-30: Excel's serial for any date from 1900-03-01 on (the 1900 leap-year bug sits before it). */
function excelSerial(text, path) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) throw bad(path, 'expected a date as "YYYY-MM-DD"')
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const time = Date.UTC(y, mo - 1, d)
  const back = new Date(time)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw bad(path, `${text} is not a calendar date`)
  if (time < Date.UTC(1900, 2, 1)) throw bad(path, 'dates before 1900-03-01 are not supported')
  return (time - Date.UTC(1899, 11, 30)) / 86400000
}

function sheetNameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'a sheet name is a non-empty string'
  if (name.length > 31) return 'a sheet name has at most 31 characters'
  if (/[[\]:*?/\\]/.test(name)) return 'a sheet name cannot contain [ ] : * ? / \\'
  if (name.startsWith("'") || name.endsWith("'")) return 'a sheet name cannot start or end with an apostrophe'
  if (name.toLowerCase() === 'history') return '"History" is reserved by Excel'
  return undefined
}

export function buildXlsx(spec) {
  if (!isObject(spec)) throw bad('', 'expected an object {"sheets": [...]}')
  onlyKeys(spec, '', ['sheets'])
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) throw bad('.sheets', 'expected a non-empty array of sheets')
  const strings = new Map()
  let stringRefs = 0
  const shared = (text) => {
    stringRefs++
    if (!strings.has(text)) strings.set(text, strings.size)
    return strings.get(text)
  }
  // Styles are made on demand: one cellXfs entry per (bold, number format) pair used.
  const formats = new Map()
  const xfs = [{ bold: false, numFmtId: 0 }]
  const styleIndex = (bold, code) => {
    let numFmtId = 0
    if (code !== undefined) {
      if (Object.hasOwn(BUILTIN_FORMATS, code)) numFmtId = BUILTIN_FORMATS[code]
      else {
        if (!formats.has(code)) formats.set(code, 164 + formats.size)
        numFmtId = formats.get(code)
      }
    }
    let index = xfs.findIndex((x) => x.bold === bold && x.numFmtId === numFmtId)
    if (index < 0) index = xfs.push({ bold, numFmtId }) - 1
    return index
  }
  const names = new Set()
  const sheets = spec.sheets.map((sheet, sheetIndex) => {
    const path = `.sheets[${sheetIndex}]`
    if (!isObject(sheet)) throw bad(path, 'expected a sheet object')
    onlyKeys(sheet, path, ['name', 'rows', 'columnWidths', 'freezeHeader', 'boldHeader'])
    const problem = sheetNameProblem(sheet.name)
    if (problem) throw bad(`${path}.name`, problem)
    esc(sheet.name, `spec${path}.name`)
    if (names.has(sheet.name.toLowerCase())) throw bad(`${path}.name`, `duplicate sheet name ${sheet.name}`)
    names.add(sheet.name.toLowerCase())
    if (!Array.isArray(sheet.rows)) throw bad(`${path}.rows`, 'expected an array of rows')
    if (sheet.rows.length > 1048576) throw bad(`${path}.rows`, 'more rows than Excel allows')
    let maxColumn = 0
    const rowsXml = sheet.rows
      .map((row, r) => {
        if (!Array.isArray(row)) throw bad(`${path}.rows[${r}]`, 'expected an array of cells')
        if (row.length > 16384) throw bad(`${path}.rows[${r}]`, 'more columns than Excel allows')
        const bold = sheet.boldHeader === true && r === 0
        const cells = row
          .map((cell, c) => {
            const at = `${path}.rows[${r}][${c}]`
            const ref = `${columnName(c)}${r + 1}`
            if (cell === null || cell === undefined) return bold ? `<c r="${ref}" s="${styleIndex(true)}"/>` : ''
            maxColumn = Math.max(maxColumn, c + 1)
            const s = (code) => {
              const index = styleIndex(bold, code)
              return index === 0 ? '' : ` s="${index}"`
            }
            const text = (value) => {
              if (value.length > 32767) throw bad(at, 'a cell holds at most 32767 characters')
              esc(value, `spec${at}`)
              return shared(value)
            }
            if (typeof cell === 'string') return `<c r="${ref}"${s()} t="s"><v>${text(cell)}</v></c>`
            if (typeof cell === 'number') {
              if (!Number.isFinite(cell)) throw bad(at, 'expected a finite number')
              return `<c r="${ref}"${s()}><v>${cell}</v></c>`
            }
            if (typeof cell === 'boolean') return `<c r="${ref}"${s()} t="b"><v>${cell ? 1 : 0}</v></c>`
            if (!isObject(cell)) throw bad(at, 'expected a string, number, boolean, null, or {formula|value|date}')
            if ('formula' in cell) {
              onlyKeys(cell, at, ['formula', 'value', 'format'])
              const formula = stringAt(cell.formula, `${at}.formula`).replace(/^=/, '')
              if (formula.length === 0) throw bad(`${at}.formula`, 'empty formula')
              const format = cell.format === undefined ? undefined : stringAt(cell.format, `${at}.format`)
              if (cell.value === undefined) return `<c r="${ref}"${s(format)}><f>${esc(formula)}</f></c>`
              if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return `<c r="${ref}"${s(format)}><f>${esc(formula)}</f><v>${cell.value}</v></c>`
              if (typeof cell.value === 'string') return `<c r="${ref}"${s(format)} t="str"><f>${esc(formula)}</f><v>${xstring(cell.value)}</v></c>`
              throw bad(`${at}.value`, 'a cached value is a number or a string')
            }
            if ('date' in cell) {
              onlyKeys(cell, at, ['date', 'format'])
              const format = cell.format === undefined ? 'yyyy-mm-dd' : stringAt(cell.format, `${at}.format`)
              return `<c r="${ref}"${s(format)}><v>${excelSerial(cell.date, `${at}.date`)}</v></c>`
            }
            if ('value' in cell) {
              onlyKeys(cell, at, ['value', 'format'])
              const format = cell.format === undefined ? undefined : stringAt(cell.format, `${at}.format`)
              if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return `<c r="${ref}"${s(format)}><v>${cell.value}</v></c>`
              if (typeof cell.value === 'string') return `<c r="${ref}"${s(format)} t="s"><v>${text(cell.value)}</v></c>`
              throw bad(`${at}.value`, 'expected a number or a string')
            }
            throw bad(at, 'a cell object has "formula", "value" or "date"')
          })
          .join('')
        return cells ? `<row r="${r + 1}">${cells}</row>` : ''
      })
      .join('')
    let cols = ''
    if (sheet.columnWidths !== undefined) {
      if (!Array.isArray(sheet.columnWidths) || sheet.columnWidths.some((w) => w !== null && (typeof w !== 'number' || !(w > 0) || w > 255))) throw bad(`${path}.columnWidths`, 'expected widths in characters, each > 0 and <= 255 (null keeps the default)')
      const entries = sheet.columnWidths.map((w, i) => (w === null ? '' : `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)).join('')
      if (entries) cols = `<cols>${entries}</cols>`
    }
    for (const flag of ['freezeHeader', 'boldHeader']) if (sheet[flag] !== undefined && typeof sheet[flag] !== 'boolean') throw bad(`${path}.${flag}`, 'expected true or false')
    const lastRow = sheet.rows.length
    const dimension = maxColumn > 0 && lastRow > 0 ? `A1:${columnName(maxColumn - 1)}${lastRow}` : 'A1'
    const pane = sheet.freezeHeader === true ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ''
    const view = `<sheetViews><sheetView${sheetIndex === 0 ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`
    // CT_Worksheet order: dimension, sheetViews, sheetFormatPr, cols, sheetData, …, pageMargins.
    const xml = `${DECL}<worksheet xmlns="${S}" xmlns:r="${R}"><dimension ref="${dimension}"/>${view}<sheetFormatPr defaultRowHeight="15"/>${cols}${rowsXml ? `<sheetData>${rowsXml}</sheetData>` : '<sheetData/>'}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
    return { name: sheet.name, xml }
  })
  const numFmts = formats.size === 0 ? '' : `<numFmts count="${formats.size}">${[...formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escAttr(code)}"/>`).join('')}</numFmts>`
  const cellXfs = xfs
    .map((x) => `<xf numFmtId="${x.numFmtId}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${x.numFmtId ? ' applyNumberFormat="1"' : ''}${x.bold ? ' applyFont="1"' : ''}/>`)
    .join('')
  // CT_Stylesheet order: numFmts, fonts, fills, borders, cellStyleXfs, cellXfs, cellStyles. Fills 0 and 1 are reserved by Excel.
  const styles = `${DECL}<styleSheet xmlns="${S}">${numFmts}<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${cellXfs}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  const sst = `${DECL}<sst xmlns="${S}" count="${stringRefs}" uniqueCount="${strings.size}">${[...strings.keys()].map((t) => `<si><t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''}>${xstring(t)}</t></si>`).join('')}</sst>`
  // fullCalcOnLoad: this helper does not calculate, so Excel recalculates every formula on open.
  const workbook = `${DECL}<workbook xmlns="${S}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sh, i) => `<sheet name="${escAttr(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`
  const workbookRels = sheets.map((_, i) => [`rId${i + 1}`, `${RT}/worksheet`, `worksheets/sheet${i + 1}.xml`])
  workbookRels.push([`rId${sheets.length + 1}`, `${RT}/styles`, 'styles.xml'])
  if (strings.size > 0) workbookRels.push([`rId${sheets.length + 2}`, `${RT}/sharedStrings`, 'sharedStrings.xml'])
  const overrides = [['xl/workbook.xml', `${CT}.spreadsheetml.sheet.main+xml`], ...sheets.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, `${CT}.spreadsheetml.worksheet+xml`]), ['xl/styles.xml', `${CT}.spreadsheetml.styles+xml`]]
  if (strings.size > 0) overrides.push(['xl/sharedStrings.xml', `${CT}.spreadsheetml.sharedStrings+xml`])
  overrides.push(...DOC_PROPS_TYPES)
  const parts = [
    ['[Content_Types].xml', contentTypesXml(BASE_DEFAULTS, overrides)],
    ['_rels/.rels', PACKAGE_RELS('xl/workbook.xml')],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', relsXml(workbookRels)],
    ...sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sh.xml]),
    ['xl/styles.xml', styles],
  ]
  if (strings.size > 0) parts.push(['xl/sharedStrings.xml', sst])
  parts.push(['docProps/core.xml', coreXml(undefined)], ['docProps/app.xml', appXml()])
  return finish(parts)
}

// ---------------------------------------------------------------------------
// pptx

const SLIDE_W = 12192000
const SLIDE_H = 6858000
const NS_PML = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`
const TITLE_BOX = { x: 838200, y: 365125, cx: 10515600, cy: 1325563 }
const BODY_BOX = { x: 838200, y: 1825625, cx: 10515600, cy: 4351338 }
const xfrm = (b) => `<a:xfrm><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.cx}" cy="${b.cy}"/></a:xfrm>`
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
const FONT_REFS = (kind) => `<a:latin typeface="+${kind}-lt"/><a:ea typeface="+${kind}-ea"/><a:cs typeface="+${kind}-cs"/>`
const TX1 = '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>'

function placeholder(id, name, ph, box, body) {
  const spPr = box ? `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` : '<p:spPr/>'
  const tx = body === undefined ? '' : `<p:txBody>${body}</p:txBody>`
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}${tx}</p:sp>`
}

/**
 * A complete theme: Office's colour and font schemes and a format scheme with
 * the three entries each list must hold. PowerPoint refuses a theme whose
 * fmtScheme lists are short, which is the classic hand-written-pptx failure.
 */
function themeXml(name) {
  const scheme = [
    ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
    ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ['dk2', '<a:srgbClr val="44546A"/>'],
    ['lt2', '<a:srgbClr val="E7E6E6"/>'],
    ['accent1', '<a:srgbClr val="4472C4"/>'],
    ['accent2', '<a:srgbClr val="ED7D31"/>'],
    ['accent3', '<a:srgbClr val="A5A5A5"/>'],
    ['accent4', '<a:srgbClr val="FFC000"/>'],
    ['accent5', '<a:srgbClr val="5B9BD5"/>'],
    ['accent6', '<a:srgbClr val="70AD47"/>'],
    ['hlink', '<a:srgbClr val="0563C1"/>'],
    ['folHlink', '<a:srgbClr val="954F72"/>'],
  ]
    .map(([k, v]) => `<a:${k}>${v}</a:${k}>`)
    .join('')
  const fill = (mod) => `<a:solidFill><a:schemeClr val="phClr">${mod}</a:schemeClr></a:solidFill>`
  const fills = fill('') + fill('<a:tint val="50000"/>') + fill('<a:shade val="80000"/>')
  const lines = [6350, 12700, 19050].map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill('')}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')
  const effects = '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)
  const font = (latin) => `<a:latin typeface="${latin}" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/>`
  return `${DECL}<a:theme xmlns:a="${A}" name="${name}"><a:themeElements><a:clrScheme name="Office">${scheme}</a:clrScheme><a:fontScheme name="Office"><a:majorFont>${font('Calibri Light')}</a:majorFont><a:minorFont>${font('Calibri')}</a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${effects}</a:effectStyleLst><a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
}

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
const PARA_FLAGS = 'defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"'

// a:pPr children in schema order: lnSpc, spcBef, spcAft, bullet font, bullet, defRPr.
const MASTER_XML = `${DECL}<p:sldMaster ${NS_PML}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}\
${placeholder(2, 'Title Placeholder 1', '<p:ph type="title"/>', TITLE_BOX, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p>')}\
${placeholder(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', BODY_BOX, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>')}\
</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles>\
<p:titleStyle><a:lvl1pPr algn="l" ${PARA_FLAGS}><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200">${TX1}${FONT_REFS('mj')}</a:defRPr></a:lvl1pPr></p:titleStyle>\
<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600" algn="l" ${PARA_FLAGS}><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="\u{2022}"/><a:defRPr sz="2800" kern="1200">${TX1}${FONT_REFS('mn')}</a:defRPr></a:lvl1pPr>\
<a:lvl2pPr marL="685800" indent="-228600" algn="l" ${PARA_FLAGS}><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="500"/></a:spcBef><a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="\u{2022}"/><a:defRPr sz="2400" kern="1200">${TX1}${FONT_REFS('mn')}</a:defRPr></a:lvl2pPr></p:bodyStyle>\
<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" ${PARA_FLAGS}><a:defRPr sz="1800" kern="1200">${TX1}${FONT_REFS('mn')}</a:defRPr></a:lvl1pPr></p:otherStyle>\
</p:txStyles></p:sldMaster>`

/** Explicit geometry on the layout too, so a placeholder never depends on type-matching to the master to be visible. */
const LAYOUT_XML = `${DECL}<p:sldLayout ${NS_PML} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${GROUP}\
${placeholder(2, 'Title 1', '<p:ph type="title"/>', TITLE_BOX, '<a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master title style</a:t></a:r></a:p>')}\
${placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', BODY_BOX, '<a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>')}\
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

/** The notes page for 16:9 slides: a slide image above the notes body. */
const NOTES_MASTER_XML = `${DECL}<p:notesMaster ${NS_PML}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}\
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 685800, y: 1143000, cx: 5486400, cy: 3086100 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>\
${placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', { x: 685800, y: 4400550, cx: 5486400, cy: 3600450 }, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p>')}\
</p:spTree></p:cSld>${CLR_MAP}<p:notesStyle><a:lvl1pPr marL="0" algn="l" ${PARA_FLAGS}><a:defRPr sz="1200" kern="1200">${TX1}${FONT_REFS('mn')}</a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`

/** Paragraphs of a text body; `plain` turns the master's bullet off for running text. */
function textParagraphs(items, size) {
  const rPr = `<a:rPr lang="en-US"${size ? ` sz="${size}"` : ''} dirty="0"/>`
  return items
    .map(({ text, plain }) => {
      const pPr = plain ? '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>' : ''
      const runs = text
        .split('\n')
        .map((line, i) => `${i > 0 ? `<a:br>${rPr}</a:br>` : ''}${line ? `<a:r>${rPr}<a:t>${esc(line)}</a:t></a:r>` : ''}`)
        .join('')
      return `<a:p>${pPr}${runs}<a:endParaRPr lang="en-US"${size ? ` sz="${size}"` : ''} dirty="0"/></a:p>`
    })
    .join('')
}

/** A rough fit: shrink the body font as the text grows, so a long slide still fits its box. */
function bodySize(items) {
  const lines = items.reduce((sum, { text }) => sum + text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 60)), 0), 0)
  if (lines <= 7) return undefined
  if (lines <= 10) return 2400
  if (lines <= 14) return 2000
  return 1600
}

export function buildPptx(spec) {
  if (!isObject(spec)) throw bad('', 'expected an object {"slides": [...]}')
  onlyKeys(spec, '', ['slides', 'title'])
  const title = spec.title === undefined ? undefined : stringAt(spec.title, '.title')
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) throw bad('.slides', 'expected a non-empty array of slides')
  const warnings = []
  const slides = spec.slides.map((slide, i) => {
    const path = `.slides[${i}]`
    if (!isObject(slide)) throw bad(path, 'expected {"title", "bullets"?, "text"?, "notes"?}')
    onlyKeys(slide, path, ['title', 'bullets', 'text', 'notes'])
    const heading = stringAt(slide.title ?? '', `${path}.title`)
    const items = []
    if (slide.text !== undefined) for (const para of stringAt(slide.text, `${path}.text`).split(/\n{2,}/)) items.push({ text: para, plain: true })
    if (slide.bullets !== undefined) {
      if (!Array.isArray(slide.bullets)) throw bad(`${path}.bullets`, 'expected an array of strings')
      slide.bullets.forEach((b, k) => items.push({ text: stringAt(b, `${path}.bullets[${k}]`), plain: false }))
    }
    const notes = slide.notes === undefined ? undefined : stringAt(slide.notes, `${path}.notes`)
    const size = bodySize(items)
    if (size === 1600) warnings.push(`slide ${i + 1} carries a lot of text; consider splitting it`)
    return { heading, items, notes, size }
  })
  const hasNotes = slides.some((s) => s.notes !== undefined)
  const parts = []
  const overrides = [['ppt/presentation.xml', `${CT}.presentationml.presentation.main+xml`]]
  const presRels = [['rId1', `${RT}/slideMaster`, 'slideMasters/slideMaster1.xml']]
  slides.forEach((_, i) => presRels.push([`rId${i + 2}`, `${RT}/slide`, `slides/slide${i + 1}.xml`]))
  let next = slides.length + 2
  const notesMasterRel = hasNotes ? `rId${next++}` : undefined
  if (notesMasterRel) presRels.push([notesMasterRel, `${RT}/notesMaster`, 'notesMasters/notesMaster1.xml'])
  for (const [type, target] of [['presProps', 'presProps.xml'], ['viewProps', 'viewProps.xml'], ['theme', 'theme/theme1.xml'], ['tableStyles', 'tableStyles.xml']]) presRels.push([`rId${next++}`, `${RT}/${type}`, target])
  // CT_Presentation order: sldMasterIdLst, notesMasterIdLst, sldIdLst, sldSz, notesSz, defaultTextStyle.
  const presentation = `${DECL}<p:presentation ${NS_PML} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesMasterRel ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRel}"/></p:notesMasterIdLst>` : ''}<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" ${PARA_FLAGS}><a:defRPr sz="1800" kern="1200">${TX1}${FONT_REFS('mn')}</a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>`
  parts.push(['ppt/presentation.xml', presentation], ['ppt/_rels/presentation.xml.rels', relsXml(presRels)])
  slides.forEach((slide, i) => {
    const n = i + 1
    const shapes = [placeholder(2, 'Title 1', '<p:ph type="title"/>', undefined, `<a:bodyPr/><a:lstStyle/>${textParagraphs([{ text: slide.heading, plain: false }], undefined)}`)]
    if (slide.items.length > 0) shapes.push(placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', undefined, `<a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${textParagraphs(slide.items, slide.size)}`))
    parts.push([`ppt/slides/slide${n}.xml`, `${DECL}<p:sld ${NS_PML}><p:cSld><p:spTree>${GROUP}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`])
    const rels = [['rId1', `${RT}/slideLayout`, '../slideLayouts/slideLayout1.xml']]
    if (slide.notes !== undefined) rels.push(['rId2', `${RT}/notesSlide`, `../notesSlides/notesSlide${n}.xml`])
    parts.push([`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(rels)])
    overrides.push([`ppt/slides/slide${n}.xml`, `${CT}.presentationml.slide+xml`])
  })
  parts.push(
    ['ppt/slideMasters/slideMaster1.xml', MASTER_XML],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([['rId1', `${RT}/slideLayout`, '../slideLayouts/slideLayout1.xml'], ['rId2', `${RT}/theme`, '../theme/theme1.xml']])],
    ['ppt/slideLayouts/slideLayout1.xml', LAYOUT_XML],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([['rId1', `${RT}/slideMaster`, '../slideMasters/slideMaster1.xml']])],
    ['ppt/theme/theme1.xml', themeXml('Office Theme')],
  )
  overrides.push(['ppt/slideMasters/slideMaster1.xml', `${CT}.presentationml.slideMaster+xml`], ['ppt/slideLayouts/slideLayout1.xml', `${CT}.presentationml.slideLayout+xml`], ['ppt/theme/theme1.xml', `${CT}.theme+xml`])
  if (hasNotes) {
    parts.push(['ppt/notesMasters/notesMaster1.xml', NOTES_MASTER_XML], ['ppt/notesMasters/_rels/notesMaster1.xml.rels', relsXml([['rId1', `${RT}/theme`, '../theme/theme2.xml']])], ['ppt/theme/theme2.xml', themeXml('Office Theme')])
    overrides.push(['ppt/notesMasters/notesMaster1.xml', `${CT}.presentationml.notesMaster+xml`], ['ppt/theme/theme2.xml', `${CT}.theme+xml`])
    slides.forEach((slide, i) => {
      if (slide.notes === undefined) return
      const n = i + 1
      const body = `<a:bodyPr/><a:lstStyle/>${textParagraphs(slide.notes.split(/\n{2,}/).map((text) => ({ text, plain: false })), undefined)}`
      const xml = `${DECL}<p:notes ${NS_PML}><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>${placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" idx="1"/>', undefined, body)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
      parts.push([`ppt/notesSlides/notesSlide${n}.xml`, xml], [`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, relsXml([['rId1', `${RT}/notesMaster`, '../notesMasters/notesMaster1.xml'], ['rId2', `${RT}/slide`, `../slides/slide${n}.xml`]])])
      overrides.push([`ppt/notesSlides/notesSlide${n}.xml`, `${CT}.presentationml.notesSlide+xml`])
    })
  }
  parts.push(
    ['ppt/presProps.xml', `${DECL}<p:presentationPr ${NS_PML}/>`],
    ['ppt/viewProps.xml', `${DECL}<p:viewPr ${NS_PML}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`],
    ['ppt/tableStyles.xml', `${DECL}<a:tblStyleLst xmlns:a="${A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`],
  )
  overrides.push(['ppt/presProps.xml', `${CT}.presentationml.presProps+xml`], ['ppt/viewProps.xml', `${CT}.presentationml.viewProps+xml`], ['ppt/tableStyles.xml', `${CT}.presentationml.tableStyles+xml`], ...DOC_PROPS_TYPES)
  parts.push(['docProps/core.xml', coreXml(title)], ['docProps/app.xml', appXml()])
  const entries = finish([['[Content_Types].xml', contentTypesXml(BASE_DEFAULTS, overrides)], ['_rels/.rels', PACKAGE_RELS('ppt/presentation.xml')], ...parts])
  entries.warnings = warnings
  return entries
}
