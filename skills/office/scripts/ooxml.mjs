/**
 * The package layer under `office.mjs`: ZIP in and out, a strict XML reader,
 * and the structural checks `pack` runs before it writes anything.
 *
 * Node built-ins only, on purpose. The skill promises a model it can make and
 * edit Office files on a host with no Office, no Python and no LibreOffice, so
 * nothing here may assume a library the host might lack.
 *
 * **Deterministic bytes.** Every member carries the same DOS timestamp
 * (1980-01-01 00:00), the members are written in a fixed order, and nothing
 * here reads the clock. Building the same spec twice gives the same bytes, so a
 * replayed run can be compared with a recorded one byte for byte.
 *
 * **Strict where Office is strict.** The XML reader refuses what Word, Excel
 * and PowerPoint refuse — a mismatched tag, an unescaped `&`, an unbound
 * namespace prefix, a DTD — and reports the part, line and column, because the
 * model that broke the part is the one that has to find the line.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/** Exit codes, one per class of failure, so a caller can tell a typo from a broken file. */
export const EXIT = Object.freeze({ internal: 1, usage: 2, input: 3, invalid: 4, refused: 5, unsupported: 6 })

export class CliError extends Error {
  constructor(exitCode, message) {
    super(message)
    this.exitCode = exitCode
  }
}

export const fail = (exitCode, message) => new CliError(exitCode, message)

// ---------------------------------------------------------------------------
// ZIP

/** 1980-01-01 00:00:00 in DOS form: the earliest a ZIP can say, and the same on every build. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1
/** A member larger than this inflates to an error rather than to all of memory. */
const MAX_MEMBER_BYTES = 256 * 1024 * 1024

/**
 * Writes a new archive: deflated members, in the order given, each name once.
 * No data descriptors, no extra fields, no ZIP64 — the plainest form every
 * Office reader accepts.
 */
export function writeZip(entries) {
  const seen = new Set()
  const chunks = []
  const central = []
  let offset = 0
  if (entries.length > 0xfffe) throw fail(EXIT.unsupported, `too many members for a plain ZIP (${entries.length})`)
  for (const { name, data } of entries) {
    const key = name.toLowerCase()
    if (seen.has(key)) throw fail(EXIT.invalid, `duplicate member ${name}`)
    seen.add(key)
    const nameBytes = Buffer.from(name, 'utf8')
    const flags = /[^ -~]/.test(name) ? 0x0800 : 0
    const packed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data) >>> 0
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw fail(EXIT.unsupported, 'the package is too large for a plain ZIP')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt16LE(DOS_TIME, 12)
    record.writeUInt16LE(DOS_DATE, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(packed.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, nameBytes)
    chunks.push(local, nameBytes, packed)
    offset += local.length + nameBytes.length + packed.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBytes, end])
}

/**
 * Reads the central directory and returns each member with a lazy `read()`.
 * The central directory is the truth (local headers can lie about sizes when
 * a data descriptor follows); the local header is read only for its length.
 */
export function readZip(buffer, label = 'file') {
  const bad = (why) => fail(EXIT.invalid, `${label}: ${why}`)
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw bad('not a ZIP package (no end-of-central-directory record); an Office file is a ZIP of XML parts')
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw fail(EXIT.unsupported, `${label}: ZIP64 archives are not supported`)
  if (cdOffset + cdSize > eocd) throw bad('the central directory lies outside the file (truncated?)')
  const entries = []
  let at = cdOffset
  for (let n = 0; n < count; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw bad(`central directory entry ${n + 1} is damaged`)
    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const packedSize = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw bad(`member ${name} has no local header`)
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    if (dataStart + packedSize > buffer.length) throw bad(`member ${name} runs past the end of the file`)
    entries.push({
      name,
      size,
      read() {
        if (flags & 1) throw fail(EXIT.unsupported, `${label}: member ${name} is encrypted`)
        const raw = buffer.subarray(dataStart, dataStart + packedSize)
        let data
        if (method === 0) data = Buffer.from(raw)
        else if (method === 8) {
          try {
            data = inflateRawSync(raw, { maxOutputLength: MAX_MEMBER_BYTES })
          } catch (error) {
            throw bad(`member ${name} does not inflate (${error.message})`)
          }
        } else throw fail(EXIT.unsupported, `${label}: member ${name} uses compression method ${method}`)
        if (data.length !== size || (crc32(data) >>> 0) !== crc) throw bad(`member ${name} fails its CRC or size check`)
        return data
      },
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// XML

/** The message carries an index; `parseXml` turns it into a line and column. */
class XmlError extends Error {
  constructor(message, index) {
    super(message)
    this.index = index
  }
}

const NAME = /[A-Za-z_:\u{C0}-\u{FFFF}][-A-Za-z0-9_:.\u{B7}\u{C0}-\u{FFFF}]*/uy
const isSpace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

export function locate(text, index) {
  let line = 1
  let column = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      column = 1
    } else column++
  }
  return { line, column }
}

/** Bytes to text the way an Office reader does: a UTF-16 BOM, else strict UTF-8. */
export function decodeXml(bytes, part) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    throw fail(EXIT.invalid, `${part}: not valid UTF-8`)
  }
}

/** Parses a part into `{ name, attrs: Map, children: (element | string)[] }`, or throws with part, line and column. */
export function parseXml(input, part = 'xml') {
  const text = typeof input === 'string' ? (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input) : decodeXml(input, part)
  try {
    return parse(text)
  } catch (error) {
    if (!(error instanceof XmlError)) throw error
    const { line, column } = locate(text, error.index)
    throw fail(EXIT.invalid, `${part}: line ${line}, column ${column}: ${error.message}`)
  }
}

function checkCharacters(text) {
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k)
    if (c < 0x20) {
      if (c !== 9 && c !== 10 && c !== 13) throw new XmlError(`control character U+${c.toString(16).padStart(4, '0').toUpperCase()} is not allowed in XML`, k)
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(k + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new XmlError('unpaired surrogate', k)
      k++
    } else if ((c >= 0xdc00 && c <= 0xdfff) || c === 0xfffe || c === 0xffff) throw new XmlError(`character U+${c.toString(16).toUpperCase()} is not allowed in XML`, k)
  }
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(raw, at) {
  if (!raw.includes('&')) return raw
  let out = ''
  let i = 0
  for (;;) {
    const amp = raw.indexOf('&', i)
    if (amp < 0) return out + raw.slice(i)
    out += raw.slice(i, amp)
    const semi = raw.indexOf(';', amp)
    const body = semi < 0 ? '' : raw.slice(amp + 1, semi)
    if (semi < 0 || semi - amp > 12) throw new XmlError("unescaped '&' (write &amp;)", at + amp)
    if (Object.hasOwn(ENTITIES, body)) out += ENTITIES[body]
    else if (/^#[0-9]+$/.test(body) || /^#x[0-9a-fA-F]+$/.test(body)) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      const legal = code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
      if (!legal) throw new XmlError(`character reference &${body}; is not a legal XML character`, at + amp)
      out += String.fromCodePoint(code)
    } else throw new XmlError(`undefined entity &${body}; (only &lt; &gt; &amp; &quot; &apos; and numeric references exist in XML)`, at + amp)
    i = semi + 1
  }
}

function parse(text) {
  checkCharacters(text)
  const n = text.length
  const stack = []
  const scopes = [new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])]
  let root
  let i = 0
  const err = (message, at = i) => {
    throw new XmlError(message, at)
  }
  if (text.startsWith('<?xml') && isSpace(text.charCodeAt(5))) {
    const end = text.indexOf('?>')
    if (end < 0) err('unterminated XML declaration')
    i = end + 2
  }
  while (i < n) {
    const lt = text.indexOf('<', i)
    const textEnd = lt < 0 ? n : lt
    if (textEnd > i) {
      const raw = text.slice(i, textEnd)
      if (stack.length === 0) {
        const at = raw.search(/\S/)
        if (at >= 0) err(root ? 'text after the root element' : 'text before the root element', i + at)
      } else {
        const bad = raw.indexOf(']]>')
        if (bad >= 0) err("']]>' is not allowed in text", i + bad)
        stack.at(-1).el.children.push(decodeEntities(raw, i))
      }
      i = textEnd
      if (lt < 0) break
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) err('unterminated comment')
      const body = text.slice(i + 4, end)
      if (body.includes('--') || body.endsWith('-')) err("'--' is not allowed inside a comment", i)
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) err('CDATA outside the root element')
      const end = text.indexOf(']]>', i + 9)
      if (end < 0) err('unterminated CDATA section')
      stack.at(-1).el.children.push(text.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (text.startsWith('<!DOCTYPE', i)) err('a DOCTYPE is not allowed in an Office part')
    if (text.startsWith('<!', i)) err('unexpected markup declaration')
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end < 0) err('unterminated processing instruction')
      const target = /^[^\s?]*/.exec(text.slice(i + 2, end))[0]
      if (target.length === 0) err('processing instruction without a target')
      if (target.toLowerCase() === 'xml') err('the XML declaration is only allowed at the very start of a part')
      i = end + 2
      continue
    }
    if (text.startsWith('</', i)) {
      NAME.lastIndex = i + 2
      const m = NAME.exec(text)
      if (!m) err('malformed end tag')
      let j = i + 2 + m[0].length
      while (isSpace(text.charCodeAt(j))) j++
      if (text[j] !== '>') err(`malformed end tag </${m[0]}`, j)
      const open = stack.pop()
      if (!open) err(`end tag </${m[0]}> has no open element`)
      if (open.el.name !== m[0]) err(`end tag </${m[0]}> does not match <${open.el.name}> opened at line ${locate(text, open.index).line}`)
      scopes.pop()
      i = j + 1
      continue
    }
    NAME.lastIndex = i + 1
    const m = NAME.exec(text)
    if (!m) err("'<' is not followed by a name (escape a literal '<' as &lt;)")
    if (stack.length === 0 && root) err('a second root element')
    const el = { name: m[0], attrs: new Map(), children: [] }
    let j = i + 1 + m[0].length
    let selfClosing = false
    for (;;) {
      const before = j
      while (isSpace(text.charCodeAt(j))) j++
      if (text[j] === '>') {
        j++
        break
      }
      if (text.startsWith('/>', j)) {
        j += 2
        selfClosing = true
        break
      }
      if (j >= n) err(`unterminated start tag <${el.name}>`, i)
      if (j === before) err(`expected whitespace before an attribute of <${el.name}>`, j)
      NAME.lastIndex = j
      const a = NAME.exec(text)
      if (!a) err(`malformed attribute in <${el.name}>`, j)
      const name = a[0]
      j += name.length
      while (isSpace(text.charCodeAt(j))) j++
      if (text[j] !== '=') err(`attribute ${name} has no value`, j)
      j++
      while (isSpace(text.charCodeAt(j))) j++
      const quote = text[j]
      if (quote !== '"' && quote !== "'") err(`the value of ${name} must be quoted`, j)
      const close = text.indexOf(quote, j + 1)
      if (close < 0) err(`unterminated value of ${name}`, j)
      const raw = text.slice(j + 1, close)
      const lessThan = raw.indexOf('<')
      if (lessThan >= 0) err(`'<' inside the value of ${name} (write &lt;)`, j + 1 + lessThan)
      if (el.attrs.has(name)) err(`duplicate attribute ${name} on <${el.name}>`, j)
      el.attrs.set(name, decodeEntities(raw.replace(/[\t\n\r]/g, ' '), j + 1))
      j = close + 1
    }
    const scope = new Map(scopes.at(-1))
    for (const [key, value] of el.attrs) {
      if (key === 'xmlns') scope.set('', value)
      else if (key.startsWith('xmlns:')) {
        if (value === '') err(`prefix ${key.slice(6)} is bound to an empty namespace`, i)
        scope.set(key.slice(6), value)
      }
    }
    const bound = (qname, what) => {
      const colon = qname.indexOf(':')
      if (colon < 0) return
      const prefix = qname.slice(0, colon)
      if (prefix !== 'xmlns' && !scope.has(prefix)) err(`unbound namespace prefix "${prefix}" on ${what} (declare xmlns:${prefix} on this element or an ancestor)`, i)
    }
    bound(el.name, `<${el.name}>`)
    for (const key of el.attrs.keys()) if (key !== 'xmlns' && !key.startsWith('xmlns:')) bound(key, `attribute ${key} of <${el.name}>`)
    if (stack.length > 0) stack.at(-1).el.children.push(el)
    else root = el
    if (!selfClosing) {
      stack.push({ el, index: i })
      scopes.push(scope)
    }
    i = j
  }
  if (stack.length > 0) err(`<${stack.at(-1).el.name}> is never closed`, stack.at(-1).index)
  if (!root) err('no root element', 0)
  return root
}

// DOM helpers. Elements are matched by LOCAL name, so any prefix a producer
// chose (w:, x:, ns0:) reads the same.

export const localName = (name) => name.slice(name.indexOf(':') + 1)
export const elements = (el) => (el ? el.children.filter((c) => typeof c !== 'string') : [])
export const kids = (el, local) => elements(el).filter((c) => localName(c.name) === local)
export const kid = (el, local) => elements(el).find((c) => localName(c.name) === local)
export function attr(el, local) {
  if (!el) return undefined
  for (const [key, value] of el.attrs) if (localName(key) === local && !key.startsWith('xmlns')) return value
  return undefined
}
/** Every descendant with this local name, document order. */
export function descendants(el, local, out = []) {
  for (const child of elements(el)) {
    if (localName(child.name) === local) out.push(child)
    descendants(child, local, out)
  }
  return out
}
export function textOf(el) {
  if (!el) return ''
  return el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
}

/** Text for an XML text node; refuses characters XML cannot carry rather than writing a part Office rejects. */
export function esc(value, where = 'text') {
  const text = String(value)
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k)
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff) {
      throw fail(EXIT.invalid, `${where}: character U+${c.toString(16).padStart(4, '0').toUpperCase()} cannot appear in an Office file`)
    }
  }
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const escAttr = (value, where) => esc(value, where).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')

/**
 * Re-indents a part for a file editor without changing what it means: a line
 * break goes only between two tags with nothing between them, and never into
 * an element that holds text, so `<w:t>` content and `xml:space="preserve"`
 * runs keep every byte. Office ignores whitespace between elements.
 */
export function indentXml(text) {
  let out = ''
  let depth = 0
  let i = 0
  let previous = 'none'
  const n = text.length
  while (i < n) {
    if (text[i] !== '<') {
      const lt = text.indexOf('<', i)
      const end = lt < 0 ? n : lt
      out += text.slice(i, end)
      previous = 'text'
      i = end
      continue
    }
    let end
    let kind
    if (text.startsWith('<!--', i)) {
      end = text.indexOf('-->', i) + 3
      kind = 'other'
    } else if (text.startsWith('<![CDATA[', i)) {
      end = text.indexOf(']]>', i) + 3
      kind = 'cdata'
    } else if (text.startsWith('<?', i)) {
      end = text.indexOf('?>', i) + 2
      kind = 'other'
    } else {
      let j = i + 1
      let quote = ''
      while (j < n) {
        const ch = text[j]
        if (quote) {
          if (ch === quote) quote = ''
        } else if (ch === '"' || ch === "'") quote = ch
        else if (ch === '>') break
        j++
      }
      end = j + 1
      kind = text[i + 1] === '/' ? 'close' : text[j - 1] === '/' ? 'empty' : 'open'
    }
    if (end <= i) return text
    if (kind === 'close') depth--
    const breakBefore = (kind === 'open' || kind === 'empty') ? previous !== 'text' && previous !== 'none' && previous !== 'cdata' : kind === 'close' && (previous === 'close' || previous === 'empty')
    if (breakBefore) out += '\n' + '  '.repeat(Math.max(0, depth))
    out += text.slice(i, end)
    if (kind === 'open') depth++
    previous = kind === 'other' ? (previous === 'none' ? 'none-other' : 'other') : kind
    i = end
  }
  return out
}

// ---------------------------------------------------------------------------
// The package (OPC) rules `pack` enforces.

export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_DOCUMENT_TYPES = new Set([`${REL}/officeDocument`, 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'])

/** The exact content type a main part must have, by file extension. */
export const MAIN_TYPES = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
})

/** docx/xlsx/pptx family of an extension or main content type. */
export function familyOf(extOrType) {
  const value = String(extOrType)
  if (/^do[ct][xm]$/.test(value) || value.includes('wordprocessingml') || value.includes('ms-word')) return 'docx'
  if (/^xl[st][xm]$/.test(value) || value.includes('spreadsheetml') || value.includes('ms-excel')) return 'xlsx'
  if (/^p[po]t[xm]$/.test(value) || value.includes('presentationml') || value.includes('ms-powerpoint')) return 'pptx'
  return undefined
}

const isXmlPart = (name) => /\.(xml|rels)$/i.test(name)

/** Where a relationship target points, as a package part name; undefined when it climbs out of the package. */
export function resolveTarget(sourcePart, target) {
  let decoded = target.split('#')[0]
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // A malformed escape is kept literally; the existence check reports it.
  }
  const base = decoded.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (base.length === 0) return undefined
      base.pop()
    } else base.push(segment)
  }
  return base.join('/')
}

/** `word/_rels/document.xml.rels` → `word/document.xml`; `_rels/.rels` → '' (the package). */
export function sourceOfRels(relsName) {
  const m = /^(.*?)_rels\/([^/]*)\.rels$/.exec(relsName)
  if (!m) return undefined
  return m[1] + m[2]
}

export function relsFor(part) {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

/** The content-type map of a package: overrides by lower-cased part name, defaults by lower-cased extension. */
export function contentTypes(root) {
  const overrides = new Map()
  const defaults = new Map()
  for (const el of elements(root)) {
    const local = localName(el.name)
    if (local === 'Override') overrides.set(String(attr(el, 'PartName') ?? '').replace(/^\//, '').toLowerCase(), { type: attr(el, 'ContentType'), partName: attr(el, 'PartName') })
    if (local === 'Default') defaults.set(String(attr(el, 'Extension') ?? '').toLowerCase(), attr(el, 'ContentType'))
  }
  return {
    overrides,
    defaults,
    typeOf(part) {
      const override = overrides.get(part.toLowerCase())
      if (override) return override.type
      const dot = part.lastIndexOf('.')
      return dot < 0 ? undefined : defaults.get(part.slice(dot + 1).toLowerCase())
    },
  }
}

export function relationships(root) {
  return kids(root, 'Relationship').map((el) => ({ id: attr(el, 'Id'), type: attr(el, 'Type'), target: attr(el, 'Target'), external: attr(el, 'TargetMode') === 'External' }))
}

/**
 * Every structural problem `pack` refuses, as `part: problem` lines. `members`
 * maps package names to bytes; `ext` is the output's extension. Parsed parts
 * come back so a caller can use them.
 */
export function checkPackage(members, ext) {
  const problems = []
  const parsed = new Map()
  const byLower = new Map()
  for (const name of members.keys()) {
    const lower = name.toLowerCase()
    if (byLower.has(lower)) problems.push(`${name}: duplicates ${byLower.get(lower)} (part names are case-insensitive)`)
    byLower.set(lower, name)
  }
  const exists = (part) => byLower.has(part.toLowerCase())
  for (const [name, bytes] of members) {
    if (!isXmlPart(name)) continue
    try {
      parsed.set(name, parseXml(bytes, name))
    } catch (error) {
      if (error instanceof CliError) problems.push(error.message)
      else throw error
    }
  }
  const typesRoot = parsed.get('[Content_Types].xml')
  if (!members.has('[Content_Types].xml')) problems.push('[Content_Types].xml: missing (every Office package needs it)')
  const rootRels = parsed.get('_rels/.rels')
  if (!members.has('_rels/.rels')) problems.push('_rels/.rels: missing (it names the main part)')
  const types = typesRoot ? contentTypes(typesRoot) : undefined
  let main
  if (rootRels) {
    const office = relationships(rootRels).find((r) => OFFICE_DOCUMENT_TYPES.has(r.type ?? ''))
    if (!office) problems.push('_rels/.rels: no officeDocument relationship (it must point at the main part)')
    else main = resolveTarget('', office.target ?? '')
  }
  const expected = MAIN_TYPES[ext]
  if (main !== undefined && types) {
    const actual = types.typeOf(main)
    if (!exists(main)) problems.push(`_rels/.rels: the main part ${main} does not exist`)
    else if (expected !== undefined && actual !== expected) problems.push(`[Content_Types].xml: the main part /${main} must have content type ${expected} for a .${ext} file (found ${actual ?? 'none'})`)
  }
  if (types) {
    for (const name of members.keys()) {
      if (name === '[Content_Types].xml') continue
      if (types.typeOf(name) === undefined) problems.push(`${name}: no content type (add an <Override PartName="/${name}" .../> or a <Default Extension=.../> to [Content_Types].xml)`)
    }
    for (const { partName } of types.overrides.values()) {
      const part = String(partName ?? '').replace(/^\//, '')
      if (!exists(part)) problems.push(`[Content_Types].xml: Override for ${partName} names a part that does not exist (remove it)`)
    }
  }
  for (const [name, root] of parsed) {
    const source = sourceOfRels(name)
    if (source === undefined) continue
    if (source !== '' && !exists(source)) problems.push(`${name}: its source part ${source} does not exist`)
    const ids = new Set()
    for (const rel of relationships(root)) {
      if (!rel.id) problems.push(`${name}: a Relationship without an Id`)
      else if (ids.has(rel.id)) problems.push(`${name}: duplicate relationship Id ${rel.id}`)
      ids.add(rel.id)
      if (rel.external || rel.target === undefined) continue
      const target = resolveTarget(source, rel.target)
      if (target === undefined) problems.push(`${name}: ${rel.id} target ${rel.target} climbs out of the package`)
      else if (!exists(target)) problems.push(`${name}: ${rel.id} target ${rel.target} (${target}) does not exist`)
    }
  }
  return { problems, parsed, main, types }
}

/** Unsafe ZIP member names: what `unpack` refuses before it writes a single file. */
export function unsafeMemberName(name) {
  if (name.length === 0) return 'empty name'
  if (name.includes('\\')) return 'a backslash in the name'
  if (name.startsWith('/')) return 'an absolute path'
  if (/^[A-Za-z]:/.test(name)) return 'a drive letter'
  if (name.includes('\0')) return 'a NUL character'
  const segments = name.replace(/\/$/, '').split('/')
  if (segments.some((s) => s === '..')) return "a '..' segment"
  if (segments.some((s) => s === '' || s === '.')) return 'an empty or "." segment'
  if (segments.some((s) => /[<>:"|?*]/.test(s) || /[. ]$/.test(s))) return 'a character no file system accepts'
  return undefined
}
