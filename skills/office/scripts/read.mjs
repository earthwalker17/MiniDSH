/**
 * `office.mjs read`: what a document SAYS, as text a model can check against
 * what it was asked to produce.
 *
 * Not a renderer. It reports content and the structure that carries meaning —
 * paragraph styles and run marks, table rows, cell values with their formulas
 * and whether a cached value exists, slide titles, bodies and notes — because
 * "reopen the file and check the requested content" is the verification this
 * skill can always do, on any host. How the page LOOKS needs a renderer.
 */
import { attr, descendants, elements, kid, kids, localName, parseXml, relationships, relsFor, resolveTarget, textOf } from './ooxml.mjs'

/** Opens a part through the package; undefined when it is absent or not XML. */
function loader(members) {
  const byLower = new Map([...members.keys()].map((name) => [name.toLowerCase(), name]))
  const cache = new Map()
  return (part) => {
    if (part === undefined) return undefined
    const name = byLower.get(part.toLowerCase())
    if (name === undefined) return undefined
    if (!cache.has(name)) cache.set(name, parseXml(members.get(name), name))
    return cache.get(name)
  }
}

function relsOf(load, part) {
  const root = load(relsFor(part))
  const map = new Map()
  if (root) for (const rel of relationships(root)) if (!rel.external && rel.target) map.set(rel.id, { type: rel.type ?? '', part: resolveTarget(part, rel.target) })
  return map
}

// ---------------------------------------------------------------------------
// docx

/** Groups runs with the same marks and renders them as **bold**, *italic*, <u>underline</u>. */
function marked(pieces) {
  const merged = []
  for (const piece of pieces) {
    const last = merged.at(-1)
    if (last && last.key === piece.key) last.text += piece.text
    else merged.push({ ...piece })
  }
  return merged
    .map(({ text, bold, italic, underline, deleted }) => {
      if (text.trim().length === 0) return text
      // Marks hug the words; surrounding spaces stay outside, as in Markdown.
      const [, lead, core, trail] = /^(\s*)([^]*?)(\s*)$/.exec(text)
      let out = core
      if (underline) out = `<u>${out}</u>`
      if (italic) out = `*${out}*`
      if (bold) out = `**${out}**`
      if (deleted) out = `~~${out}~~`
      return lead + out + trail
    })
    .join('')
}

const on = (rPr, local) => {
  const el = kid(rPr, local)
  if (!el) return false
  const val = attr(el, 'val')
  return val === undefined || !['0', 'false', 'none', 'off'].includes(val)
}

/** Text pieces of a paragraph, descending through hyperlinks, fields, content controls and tracked changes. */
function paragraphPieces(p, notes) {
  const pieces = []
  const walk = (el, deleted) => {
    for (const child of elements(el)) {
      const local = localName(child.name)
      if (local === 'r') {
        const rPr = kid(child, 'rPr')
        const style = { bold: on(rPr, 'b'), italic: on(rPr, 'i'), underline: on(rPr, 'u'), deleted }
        const key = `${style.bold}${style.italic}${style.underline}${deleted}`
        for (const part of elements(child)) {
          const kind = localName(part.name)
          if (kind === 't' || kind === 'delText') pieces.push({ ...style, key, text: textOf(part) })
          else if (kind === 'tab') pieces.push({ ...style, key, text: '\t' })
          else if (kind === 'br' || kind === 'cr') {
            if (attr(part, 'type') === 'page') notes.add('page break')
            else pieces.push({ ...style, key, text: '\n' })
          } else if (kind === 'drawing' || kind === 'pict') pieces.push({ ...style, key: 'img', text: '[image]' })
          else if (kind === 'footnoteReference' || kind === 'endnoteReference') pieces.push({ ...style, key, text: '[note]' })
        }
      } else if (local === 'del') walk(child, true)
      else if (local !== 'pPr' && local !== 'rPr') walk(child, deleted)
    }
  }
  walk(p, false)
  return pieces
}

function docxParagraph(p, styleNames) {
  const pPr = kid(p, 'pPr')
  const styleId = attr(kid(pPr, 'pStyle'), 'val') ?? 'Normal'
  // A style id the styles part does not define renders as Normal in Word, silently: say so.
  const label = [styleNames.size > 0 && !styleNames.has(styleId) && styleId !== 'Normal' ? `${styleId} (not defined in styles.xml)` : styleId]
  const numPr = kid(pPr, 'numPr')
  if (numPr) label.push(`list ${attr(kid(numPr, 'numId'), 'val') ?? '?'} level ${attr(kid(numPr, 'ilvl'), 'val') ?? '0'}`)
  const jc = attr(kid(pPr, 'jc'), 'val')
  if (jc && jc !== 'left' && jc !== 'start' && jc !== 'both') label.push(jc)
  const notes = new Set()
  const text = marked(paragraphPieces(p, notes)).replace(/\n/g, '\n    ')
  const lines = []
  if (notes.has('page break') && text.length === 0) return ['[page break]']
  lines.push(`[${label.join(', ')}] ${text}`.trimEnd())
  if (notes.has('page break')) lines.push('[page break]')
  return lines
}

function docxTable(tbl, depth) {
  const rows = kids(tbl, 'tr')
  const width = Math.max(0, ...rows.map((tr) => kids(tr, 'tc').length))
  const out = [`${'  '.repeat(depth)}[table: ${rows.length} rows x ${width} columns]`]
  for (const tr of rows) {
    const cells = kids(tr, 'tc').map((tc) =>
      elements(tc)
        .filter((c) => localName(c.name) === 'p')
        .map((p) => marked(paragraphPieces(p, new Set())))
        .join(' / ')
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' '),
    )
    out.push(`${'  '.repeat(depth)}| ${cells.join(' | ')} |`)
    for (const tc of kids(tr, 'tc')) for (const inner of kids(tc, 'tbl')) out.push(...docxTable(inner, depth + 1))
  }
  return out
}

function readDocx(load, main) {
  const document = load(main)
  const rels = relsOf(load, main)
  const stylesPart = [...rels.values()].find((r) => r.type.endsWith('/styles'))?.part
  const styleNames = new Map()
  const styles = load(stylesPart)
  if (styles) for (const st of kids(styles, 'style')) styleNames.set(attr(st, 'styleId'), attr(kid(st, 'name'), 'val'))
  const body = kid(document, 'body')
  const lines = []
  let paragraphs = 0
  let tables = 0
  const walk = (container) => {
    for (const child of elements(container)) {
      const local = localName(child.name)
      if (local === 'p') {
        paragraphs++
        lines.push(...docxParagraph(child, styleNames))
      } else if (local === 'tbl') {
        tables++
        lines.push(...docxTable(child, 0))
      } else if (local === 'sdt') walk(kid(child, 'sdtContent'))
    }
  }
  walk(body)
  const sections = descendants(body, 'sectPr').length
  const extras = [...rels.values()].filter((r) => /\/(header|footer|footnotes|endnotes|comments)$/.test(r.type)).map((r) => r.type.split('/').at(-1))
  const head = `docx: ${paragraphs} paragraphs, ${tables} tables, ${sections} section(s)${extras.length ? `; also has ${[...new Set(extras)].join(', ')} (not shown)` : ''}\nmarks: **bold** *italic* <u>underline</u> ~~deleted~~; [Style, list numId level N] precedes each paragraph`
  return `${head}\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// xlsx

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
const BUILTIN_CODES = { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 14: 'mm-dd-yy', 49: '@' }

function isDateCode(code) {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[dmyhs]/i.test(bare) && !/^[#0.,%E+-]+$/.test(bare)
}

function serialToDate(serial) {
  const ms = Math.round((serial - 25569) * 86400000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return undefined
  const iso = d.toISOString()
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

function readXlsx(load, main, maxChars) {
  const workbook = load(main)
  const rels = relsOf(load, main)
  const find = (suffix) => [...rels.values()].find((r) => r.type.endsWith(suffix))?.part
  const strings = []
  const sst = load(find('/sharedStrings'))
  // A string item is one <t>, or rich-text runs; phonetic runs (rPh) are not part of the value.
  if (sst) for (const si of kids(sst, 'si')) strings.push(kid(si, 't') ? textOf(kid(si, 't')) : kids(si, 'r').map((r) => textOf(kid(r, 't'))).join(''))
  const formats = []
  const styles = load(find('/styles'))
  if (styles) {
    const custom = new Map(kids(kid(styles, 'numFmts'), 'numFmt').map((f) => [Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '']))
    const bold = kids(kid(styles, 'fonts'), 'font').map((f) => Boolean(kid(f, 'b')) && attr(kid(f, 'b'), 'val') !== '0')
    for (const xf of kids(kid(styles, 'cellXfs'), 'xf')) {
      const id = Number(attr(xf, 'numFmtId') ?? 0)
      const code = custom.get(id) ?? BUILTIN_CODES[id]
      formats.push({ code, date: BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && custom.has(id) && isDateCode(code)), bold: bold[Number(attr(xf, 'fontId') ?? 0)] === true })
    }
  }
  const sheets = kids(kid(workbook, 'sheets'), 'sheet')
  const out = [`xlsx: ${sheets.length} sheet(s); each cell: REF value | =formula [cached value] | =formula (no cached value)`]
  let used = out[0].length
  for (const [index, sheet] of sheets.entries()) {
    const id = [...sheet.attrs].find(([k]) => localName(k) === 'id' && k.includes(':'))?.[1]
    const part = rels.get(id)?.part
    const state = attr(sheet, 'state')
    out.push('', `== sheet ${index + 1}: ${attr(sheet, 'name')}${state && state !== 'visible' ? ` (${state})` : ''}`)
    const root = load(part)
    if (!root) {
      out.push('(sheet part missing or not a worksheet)')
      continue
    }
    const pane = descendants(root, 'pane').find((p) => attr(p, 'state') === 'frozen')
    const merges = kids(kid(root, 'mergeCells'), 'mergeCell').map((m) => attr(m, 'ref'))
    const info = [`range ${attr(kid(root, 'dimension'), 'ref') ?? '?'}`]
    if (pane) info.push(`frozen at ${attr(pane, 'topLeftCell') ?? '?'}`)
    if (merges.length) info.push(`merged ${merges.slice(0, 10).join(' ')}${merges.length > 10 ? ' …' : ''}`)
    const cols = kids(kid(root, 'cols'), 'col').filter((c) => attr(c, 'customWidth') === '1' || attr(c, 'width'))
    if (cols.length) info.push(`widths ${cols.slice(0, 12).map((c) => `${attr(c, 'min')}${attr(c, 'max') !== attr(c, 'min') ? `-${attr(c, 'max')}` : ''}:${Number(attr(c, 'width')).toFixed(1)}`).join(' ')}`)
    out.push(info.join('; '))
    const shared = new Map()
    for (const row of kids(kid(root, 'sheetData'), 'row')) {
      for (const c of kids(row, 'c')) {
        const ref = attr(c, 'r') ?? '?'
        const t = attr(c, 't') ?? 'n'
        const f = kid(c, 'f')
        const v = kid(c, 'v')
        const style = formats[Number(attr(c, 's') ?? 0)]
        let value
        if (t === 's') value = v ? JSON.stringify(strings[Number(textOf(v))] ?? `?string ${textOf(v)}`) : undefined
        else if (t === 'inlineStr') value = JSON.stringify(descendants(kid(c, 'is'), 't').map(textOf).join(''))
        else if (t === 'str') value = v ? JSON.stringify(textOf(v)) : undefined
        else if (t === 'b') value = v ? (textOf(v) === '1' ? 'TRUE' : 'FALSE') : undefined
        else if (t === 'e') value = v ? textOf(v) : undefined
        else if (v) {
          value = textOf(v)
          if (style?.date && value !== '') value = `${value} (= ${serialToDate(Number(value)) ?? '?'})`
        }
        let formula
        if (f) {
          const si = attr(f, 'si')
          const text = textOf(f)
          if (attr(f, 't') === 'shared' && si !== undefined) {
            if (text) shared.set(si, ref)
            formula = text ? `=${text}` : `=(shared formula ${si} from ${shared.get(si) ?? '?'})`
          } else formula = `=${text}`
        }
        if (value === undefined && formula === undefined) continue
        const marks = []
        if (style?.code && style.code !== 'General') marks.push(`format ${style.code}`)
        if (style?.bold) marks.push('bold')
        const line = formula ? `${ref} ${formula} ${value === undefined ? '(no cached value)' : `[cached ${value}]`}` : `${ref} ${value}`
        out.push(marks.length ? `${line}  {${marks.join(', ')}}` : line)
        used += out.at(-1).length + 1
        if (used > maxChars * 2) return out.join('\n')
      }
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// pptx

/** Paragraphs of a shape; `bulleted` says whether a body placeholder's paragraph keeps the master's bullet. */
function shapeText(sp, inBody = false) {
  const body = kid(sp, 'txBody')
  if (!body) return []
  return kids(body, 'p').map((p) => {
    const pPr = kid(p, 'pPr')
    const level = Number(attr(pPr, 'lvl') ?? 0)
    const bulleted = Boolean(kid(pPr, 'buChar') || kid(pPr, 'buAutoNum')) || (inBody && !kid(pPr, 'buNone'))
    const text = elements(p)
      .map((el) => {
        const local = localName(el.name)
        if (local === 'r' || local === 'fld') return textOf(kid(el, 't'))
        if (local === 'br') return '\n'
        return ''
      })
      .join('')
    return { level, text, bulleted }
  })
}

const PLACEHOLDER_ROLE = { title: 'title', ctrTitle: 'title', subTitle: 'subtitle', body: 'body', obj: 'body' }

function slideShapes(tree, out, depth = 0) {
  for (const el of elements(tree)) {
    const local = localName(el.name)
    if (local === 'sp') {
      const ph = kid(kid(kid(el, 'nvSpPr'), 'nvPr'), 'ph')
      const type = ph ? (attr(ph, 'type') ?? 'obj') : undefined
      if (type && ['dt', 'ftr', 'sldNum', 'hdr', 'sldImg'].includes(type)) continue
      const role = type ? (PLACEHOLDER_ROLE[type] ?? type) : 'text box'
      const paragraphs = shapeText(el, role === 'body').filter((p) => p.text.trim().length > 0)
      if (paragraphs.length === 0) continue
      out.push({ role, paragraphs })
    } else if (local === 'grpSp') slideShapes(el, out, depth + 1)
    else if (local === 'pic') out.push({ role: 'picture', paragraphs: [{ level: 0, text: attr(kid(kid(el, 'nvPicPr'), 'cNvPr'), 'descr') ?? attr(kid(kid(el, 'nvPicPr'), 'cNvPr'), 'name') ?? '' }] })
    else if (local === 'graphicFrame') {
      const rows = descendants(el, 'tr').map((tr) => `| ${kids(tr, 'tc').map((tc) => descendants(tc, 't').map(textOf).join(' ').replace(/\|/g, '\\|')).join(' | ')} |`)
      if (rows.length) out.push({ role: 'table', paragraphs: rows.map((text) => ({ level: 0, text })) })
      else if (descendants(el, 'chart').length) out.push({ role: 'chart', paragraphs: [] })
    }
  }
}

function readPptx(load, main) {
  const presentation = load(main)
  const rels = relsOf(load, main)
  const size = kid(presentation, 'sldSz')
  const cx = Number(attr(size, 'cx'))
  const cy = Number(attr(size, 'cy'))
  const ratio = cx && cy ? (Math.abs(cx / cy - 16 / 9) < 0.01 ? '16:9' : Math.abs(cx / cy - 4 / 3) < 0.01 ? '4:3' : `${(cx / cy).toFixed(2)}:1`) : '?'
  const ids = kids(kid(presentation, 'sldIdLst'), 'sldId')
  const out = [`pptx: ${ids.length} slide(s), ${ratio} (${cx}x${cy} EMU)`]
  ids.forEach((sldId, index) => {
    const rid = [...sldId.attrs].find(([k]) => k.includes(':') && localName(k) === 'id')?.[1]
    const part = rels.get(rid)?.part
    const slide = load(part)
    const slideRels = part ? relsOf(load, part) : new Map()
    const layoutPart = [...slideRels.values()].find((r) => r.type.endsWith('/slideLayout'))?.part
    const layoutName = attr(kid(load(layoutPart), 'cSld'), 'name')
    const hidden = attr(slide, 'show') === '0'
    out.push('', `== slide ${index + 1} (${part ?? 'missing part'}${layoutName ? `, layout "${layoutName}"` : ''}${hidden ? ', hidden' : ''})`)
    if (!slide) return
    const shapes = []
    slideShapes(kid(kid(slide, 'cSld'), 'spTree'), shapes)
    if (shapes.length === 0) out.push('(no text)')
    for (const shape of shapes) {
      if (shape.role === 'title' && shape.paragraphs.length === 1) {
        out.push(`title: ${shape.paragraphs[0].text.replace(/\n/g, ' / ')}`)
        continue
      }
      out.push(`${shape.role}:`)
      for (const p of shape.paragraphs) out.push(`${'  '.repeat(p.level + 1)}${p.bulleted ? '\u{2022} ' : ''}${p.text.replace(/\n/g, ' / ')}`)
    }
    const notesPart = [...slideRels.values()].find((r) => r.type.endsWith('/notesSlide'))?.part
    const notes = load(notesPart)
    if (notes) {
      const text = []
      for (const sp of descendants(notes, 'sp')) {
        const ph = kid(kid(kid(sp, 'nvSpPr'), 'nvPr'), 'ph')
        if (ph && attr(ph, 'type') === 'body') text.push(...shapeText(sp).map((p) => p.text))
      }
      const joined = text.join('\n').trim()
      if (joined) out.push(`notes: ${joined.replace(/\n/g, '\n       ')}`)
    }
  })
  return out.join('\n')
}

/** The dump for a package whose main part and family the caller already checked. */
export function readPackage(members, main, family, maxChars) {
  const load = loader(members)
  if (family === 'docx') return readDocx(load, main)
  if (family === 'xlsx') return readXlsx(load, main, maxChars)
  return readPptx(load, main)
}
