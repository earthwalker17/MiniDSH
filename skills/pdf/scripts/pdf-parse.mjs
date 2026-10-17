/**
 * The PDF reader under `pdf.mjs`: objects, cross-references, streams, fonts,
 * and the text a page shows, with Node built-ins only.
 *
 * It reads what real writers produce, not only what the specification
 * prefers: classic xref tables and xref streams (PNG predictors), hybrid files
 * that carry both, objects packed in object streams, and files whose recorded
 * offsets are simply wrong — every object fetched through the xref is checked
 * against its `N G obj` header, and a mismatch falls back to a scan of the
 * whole file. Real PDFs from browsers, Word and scanners all exercise one of
 * these paths, which is why the tests read files those writers produced.
 *
 * Text comes from the content stream's show operators, decoded through each
 * font's ToUnicode map (code width taken from the codespace, so Type0
 * Identity-H fonts read as 2-byte codes) or its simple encoding. Spacing and
 * line breaks are recovered from glyph POSITIONS — writers split words across
 * operators and place every run absolutely — so the font widths are read too.
 */
import { inflateRawSync, inflateSync, constants as zlibConstants } from 'node:zlib'

export const EXIT = Object.freeze({ internal: 1, usage: 2, input: 3, invalid: 4, refused: 5, unsupported: 6 })

export class CliError extends Error {
  constructor(exitCode, message) {
    super(message)
    this.exitCode = exitCode
  }
}

export const fail = (exitCode, message) => new CliError(exitCode, message)

// ---------------------------------------------------------------------------
// Objects and the lexer. Names are JS strings, strings are `Str` (bytes as a
// latin1 string), dictionaries are Maps.

export class Str {
  constructor(bytes) {
    this.bytes = bytes
  }

  toString() {
    return `(${this.bytes})`
  }
}

export class Ref {
  constructor(num, gen) {
    this.num = num
    this.gen = gen
  }

  toString() {
    return `${this.num} ${this.gen} R`
  }
}

export class Stream {
  constructor(dict, raw) {
    this.dict = dict
    this.raw = raw
  }

  toString() {
    return `stream (${this.raw.length} bytes)`
  }
}

const isWhite = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32
const isDelimiter = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

class Lexer {
  constructor(s, pos = 0) {
    this.s = s
    this.pos = pos
  }

  skip() {
    const s = this.s
    for (;;) {
      const c = s.charCodeAt(this.pos)
      if (isWhite(c)) this.pos++
      else if (c === 37) {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++
      } else return
    }
  }

  /** `{ t: 'num'|'name'|'str'|'op'|'['|']'|'<<'|'>>'|'{'|'}'|'eof', v }` */
  next() {
    this.skip()
    const s = this.s
    const start = this.pos
    if (start >= s.length) return { t: 'eof' }
    const c = s[start]
    if (c === '[' || c === ']' || c === '{' || c === '}') {
      this.pos++
      return { t: c }
    }
    if (c === '<') {
      if (s[start + 1] === '<') {
        this.pos += 2
        return { t: '<<' }
      }
      const end = s.indexOf('>', start)
      const stop = end < 0 ? s.length : end
      let hex = s.slice(start + 1, stop).replace(/[^0-9A-Fa-f]/g, '')
      if (hex.length % 2) hex += '0'
      this.pos = stop + 1
      return { t: 'str', v: Buffer.from(hex, 'hex').toString('latin1') }
    }
    if (c === '>') {
      this.pos += s[start + 1] === '>' ? 2 : 1
      return { t: '>>' }
    }
    if (c === '(') return { t: 'str', v: this.literal() }
    if (c === '/') {
      let j = start + 1
      while (j < s.length && !isWhite(s.charCodeAt(j)) && !isDelimiter(s.charCodeAt(j))) j++
      this.pos = j
      return { t: 'name', v: s.slice(start + 1, j).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16))) }
    }
    if (c === ')') {
      this.pos++
      return { t: 'op', v: ')' }
    }
    let j = start
    while (j < s.length && !isWhite(s.charCodeAt(j)) && !isDelimiter(s.charCodeAt(j))) j++
    if (j === start) j++
    this.pos = j
    const word = s.slice(start, j)
    if (NUMBER.test(word)) return { t: 'num', v: Number(word) }
    return { t: 'op', v: word }
  }

  literal() {
    const s = this.s
    let i = this.pos + 1
    let depth = 1
    let out = ''
    while (i < s.length) {
      const ch = s[i]
      if (ch === '\\') {
        const n = s[i + 1]
        i += 2
        if (n === 'n') out += '\n'
        else if (n === 'r') out += '\r'
        else if (n === 't') out += '\t'
        else if (n === 'b') out += '\b'
        else if (n === 'f') out += '\f'
        else if (n === '\r') {
          if (s[i] === '\n') i++
        } else if (n === '\n') {
          // a backslash at the end of a line continues the string
        } else if (n >= '0' && n <= '7') {
          let digits = n
          while (digits.length < 3 && s[i] >= '0' && s[i] <= '7') digits += s[i++]
          out += String.fromCharCode(Number.parseInt(digits, 8) & 0xff)
        } else if (n !== undefined) out += n
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      } else if (ch === '\r') {
        // An end of line inside a string reads as \n, whatever the file used.
        out += '\n'
        i += s[i + 1] === '\n' ? 2 : 1
        continue
      }
      out += ch
      i++
    }
    this.pos = i
    return out
  }
}

/** One value from the lexer; `N G R` becomes a Ref. */
function parseValue(lx, depth = 0) {
  if (depth > 200) throw fail(EXIT.invalid, 'objects nested too deeply')
  const tok = lx.next()
  return valueFrom(lx, tok, depth)
}

function valueFrom(lx, tok, depth) {
  switch (tok.t) {
    case 'num': {
      if (Number.isInteger(tok.v) && tok.v >= 0) {
        const save = lx.pos
        const gen = lx.next()
        if (gen.t === 'num' && Number.isInteger(gen.v)) {
          const r = lx.next()
          if (r.t === 'op' && r.v === 'R') return new Ref(tok.v, gen.v)
        }
        lx.pos = save
      }
      return tok.v
    }
    case 'name':
      return tok.v
    case 'str':
      return new Str(tok.v)
    case '[': {
      const out = []
      for (;;) {
        const t = lx.next()
        if (t.t === ']' || t.t === 'eof') return out
        out.push(valueFrom(lx, t, depth + 1))
      }
    }
    case '<<': {
      const dict = new Map()
      for (;;) {
        const key = lx.next()
        if (key.t === '>>' || key.t === 'eof') return dict
        if (key.t !== 'name') continue
        const save = lx.pos
        const t = lx.next()
        if (t.t === '>>') {
          lx.pos = save
          dict.set(key.v, null)
          continue
        }
        dict.set(key.v, valueFrom(lx, t, depth + 1))
      }
    }
    case 'op':
      if (tok.v === 'true') return true
      if (tok.v === 'false') return false
      if (tok.v === 'null') return null
      return { op: tok.v }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Filters

function inflate(data) {
  try {
    return inflateSync(data)
  } catch {
    try {
      // A truncated stream still yields what it has.
      return inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH })
    } catch {
      return inflateRawSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH })
    }
  }
}

function unpredict(data, parms) {
  const predictor = Number(parms?.get('Predictor') ?? 1)
  if (predictor < 2) return data
  const colors = Number(parms.get('Colors') ?? 1)
  const bpc = Number(parms.get('BitsPerComponent') ?? 8)
  const columns = Number(parms.get('Columns') ?? 1)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLength = Math.ceil((colors * bpc * columns) / 8)
  if (predictor === 2) {
    const out = Buffer.from(data)
    if (bpc !== 8) return out
    for (let row = 0; row + rowLength <= out.length; row += rowLength) for (let i = bpp; i < rowLength; i++) out[row + i] = (out[row + i] + out[row + i - bpp]) & 0xff
    return out
  }
  // PNG: each row carries its own filter byte.
  const rows = Math.floor(data.length / (rowLength + 1))
  const out = Buffer.alloc(rows * rowLength)
  let previous = Buffer.alloc(rowLength)
  for (let r = 0; r < rows; r++) {
    const filter = data[r * (rowLength + 1)]
    const src = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1))
    const row = out.subarray(r * rowLength, (r + 1) * rowLength)
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? row[i - bpp] : 0
      const up = previous[i]
      const upLeft = i >= bpp ? previous[i - bpp] : 0
      let value = src[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      row[i] = value & 0xff
    }
    previous = row
  }
  return out
}

function asciiHex(data) {
  let hex = data.toString('latin1')
  const end = hex.indexOf('>')
  if (end >= 0) hex = hex.slice(0, end)
  hex = hex.replace(/[^0-9A-Fa-f]/g, '')
  if (hex.length % 2) hex += '0'
  return Buffer.from(hex, 'hex')
}

function ascii85(data) {
  const text = data.toString('latin1').replace(/\s/g, '').replace(/^<~/, '')
  const end = text.indexOf('~>')
  const body = end >= 0 ? text.slice(0, end) : text
  const out = []
  let group = []
  const flush = (count) => {
    let value = 0
    for (let k = 0; k < 5; k++) value = value * 85 + (group[k] ?? 84)
    for (let k = 0; k < count - 1; k++) out.push((value >>> (24 - 8 * k)) & 0xff)
  }
  for (const ch of body) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    group.push(ch.charCodeAt(0) - 33)
    if (group.length === 5) {
      flush(5)
      group = []
    }
  }
  if (group.length > 0) flush(group.length)
  return Buffer.from(out)
}

function lzw(data, earlyChange = 1) {
  const out = []
  let table = []
  const reset = () => {
    table = []
    for (let i = 0; i < 256; i++) table.push([i])
    table.push(null, null)
  }
  reset()
  let width = 9
  let bits = 0
  let buffer = 0
  let previous = null
  for (let i = 0; i < data.length; i++) {
    buffer = (buffer << 8) | data[i]
    bits += 8
    while (bits >= width) {
      const code = (buffer >>> (bits - width)) & ((1 << width) - 1)
      bits -= width
      if (code === 256) {
        reset()
        width = 9
        previous = null
        continue
      }
      if (code === 257) return Buffer.from(out)
      let entry
      if (code < table.length && table[code]) entry = table[code]
      else if (previous) entry = [...previous, previous[0]]
      else return Buffer.from(out)
      out.push(...entry)
      if (previous) table.push([...previous, entry[0]])
      previous = entry
      if (table.length + earlyChange >= 1 << width && width < 12) width++
    }
  }
  return Buffer.from(out)
}

function runLength(data) {
  const out = []
  for (let i = 0; i < data.length; ) {
    const n = data[i++]
    if (n === 128) break
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++])
    } else {
      const byte = data[i++]
      for (let k = 0; k < 257 - n; k++) out.push(byte)
    }
  }
  return Buffer.from(out)
}

// ---------------------------------------------------------------------------
// The document

export class PdfDoc {
  constructor(buffer) {
    this.buf = buffer
    this.s = buffer.toString('latin1')
    this.cache = new Map()
    this.entries = new Map()
    this.trailer = new Map()
    this.decoded = new WeakMap()
    this.objectStreams = new Map()
    this.scanned = undefined
    this.xrefKind = 'none'
    this.repaired = false
    const header = /%PDF-(\d\.\d)/.exec(this.s.slice(0, 1024))
    if (!header) throw fail(EXIT.invalid, 'not a PDF (no %PDF- header in the first 1024 bytes)')
    this.version = header[1]
    this.loadXref()
    if (!(this.resolve(this.trailer.get('Root')) instanceof Map)) {
      this.repaired = true
      this.useScan()
    }
    const catalogVersion = this.resolve(this.root()?.get('Version'))
    if (typeof catalogVersion === 'string' && catalogVersion > this.version) this.version = catalogVersion
  }

  root() {
    const root = this.resolve(this.trailer.get('Root'))
    return root instanceof Map ? root : undefined
  }

  loadXref() {
    const at = this.s.lastIndexOf('startxref')
    let offset = at < 0 ? Number.NaN : Number(/^\s*(\d+)/.exec(this.s.slice(at + 9, at + 40))?.[1])
    const visited = new Set()
    const kinds = new Set()
    try {
      while (Number.isInteger(offset) && !visited.has(offset) && offset < this.buf.length) {
        visited.add(offset)
        const section = this.readSection(offset)
        if (!section) break
        kinds.add(section.kind)
        for (const [key, value] of section.trailer) if (!this.trailer.has(key)) this.trailer.set(key, value)
        const hybrid = section.trailer.get('XRefStm')
        if (typeof hybrid === 'number' && !visited.has(hybrid)) {
          visited.add(hybrid)
          const extra = this.readSection(hybrid)
          if (extra) kinds.add('hybrid')
        }
        offset = section.trailer.get('Prev')
      }
    } catch (error) {
      if (!(error instanceof CliError)) throw error
    }
    this.xrefKind = kinds.has('hybrid') ? 'hybrid' : [...kinds].join('+') || 'none'
    if (this.entries.size === 0) {
      this.repaired = true
      this.useScan()
    }
  }

  /** One xref section (table or stream) at an offset; its entries fill only numbers no newer section set. */
  readSection(offset) {
    const lx = new Lexer(this.s, offset)
    lx.skip()
    if (this.s.startsWith('xref', lx.pos)) {
      lx.pos += 4
      for (;;) {
        const tok = lx.next()
        if (tok.t === 'op' && tok.v === 'trailer') {
          const trailer = parseValue(lx)
          return { kind: 'table', trailer: trailer instanceof Map ? trailer : new Map() }
        }
        if (tok.t !== 'num') return undefined
        const count = lx.next()
        if (count.t !== 'num') return undefined
        for (let i = 0; i < count.v; i++) {
          const off = lx.next()
          lx.next()
          const kind = lx.next()
          if (off.t !== 'num' || kind.t !== 'op') return undefined
          const num = tok.v + i
          if (kind.v === 'n' && off.v > 0 && !this.entries.has(num)) this.entries.set(num, { type: 1, offset: off.v })
        }
      }
    }
    const stream = this.readObjectAt(offset)
    if (!(stream instanceof Stream) || stream.dict.get('Type') !== 'XRef') return undefined
    const widths = (this.resolve(stream.dict.get('W')) ?? []).map(Number)
    const size = Number(stream.dict.get('Size') ?? 0)
    const index = this.resolve(stream.dict.get('Index')) ?? [0, size]
    const data = this.decode(stream)
    if (!data || widths.length < 3) return undefined
    let p = 0
    const field = (w) => {
      let v = 0
      for (let k = 0; k < w; k++) v = v * 256 + (data[p++] ?? 0)
      return v
    }
    for (let k = 0; k + 1 < index.length; k += 2) {
      for (let i = 0; i < index[k + 1]; i++) {
        if (p >= data.length) break
        const type = widths[0] ? field(widths[0]) : 1
        const f2 = field(widths[1])
        const f3 = field(widths[2])
        const num = index[k] + i
        if (this.entries.has(num)) continue
        if (type === 1) this.entries.set(num, { type: 1, offset: f2 })
        else if (type === 2) this.entries.set(num, { type: 2, stream: f2, index: f3 })
      }
    }
    return { kind: 'stream', trailer: stream.dict }
  }

  /** The whole-file scan: every `N G obj` (the last definition wins), every trailer, and the objects inside object streams. */
  scan() {
    if (this.scanned) return this.scanned
    const table = new Map()
    const re = /(\d+)\s+(\d+)\s+obj\b/g
    for (let m = re.exec(this.s); m; m = re.exec(this.s)) table.set(Number(m[1]), { type: 1, offset: m.index })
    this.scanned = table
    // A copy: object streams found below add entries to the table being walked.
    for (const [num, entry] of Array.from(table)) {
      const value = this.readObjectAt(entry.offset, num)
      if (value instanceof Stream && value.dict.get('Type') === 'ObjStm') {
        const parsed = this.objectStream(num, value)
        parsed?.offsets.forEach(([inner], index) => {
          if (!table.has(inner)) table.set(inner, { type: 2, stream: num, index })
        })
      }
    }
    return table
  }

  useScan() {
    const table = this.scan()
    for (const [num, entry] of table) this.entries.set(num, entry)
    this.cache.clear()
    if (this.resolve(this.trailer.get('Root')) instanceof Map) return
    let at = this.s.indexOf('trailer')
    while (at >= 0) {
      const value = parseValue(new Lexer(this.s, at + 7))
      if (value instanceof Map) for (const [k, v] of value) this.trailer.set(k, v)
      at = this.s.indexOf('trailer', at + 7)
    }
    if (this.resolve(this.trailer.get('Root')) instanceof Map) return
    for (const num of table.keys()) {
      const value = this.get(num)
      if (value instanceof Map && value.get('Type') === 'Catalog') {
        this.trailer.set('Root', new Ref(num, 0))
        return
      }
    }
  }

  readObjectAt(offset, expected) {
    const lx = new Lexer(this.s, offset)
    const n = lx.next()
    const g = lx.next()
    const kw = lx.next()
    if (n.t !== 'num' || g.t !== 'num' || kw.t !== 'op' || kw.v !== 'obj') return undefined
    if (expected !== undefined && n.v !== expected) return undefined
    let value
    try {
      value = parseValue(lx)
    } catch (error) {
      if (error instanceof CliError) return undefined
      throw error
    }
    if (!(value instanceof Map)) return value
    const save = lx.pos
    const tok = lx.next()
    if (tok.t !== 'op' || tok.v !== 'stream') {
      lx.pos = save
      return value
    }
    let start = lx.pos
    if (this.s[start] === '\r') start++
    if (this.s[start] === '\n') start++
    const declared = this.resolve(value.get('Length'))
    let end = typeof declared === 'number' ? start + declared : -1
    if (end < start || end > this.s.length || !/^\s*endstream/.test(this.s.slice(end, end + 30))) {
      // A wrong /Length is common; the keyword is the truth.
      const found = this.s.indexOf('endstream', start)
      end = found < 0 ? this.s.length : found
      if (this.s[end - 1] === '\n') end--
      if (this.s[end - 1] === '\r') end--
    }
    return new Stream(value, this.buf.subarray(start, end))
  }

  objectStream(num, stream) {
    if (this.objectStreams.has(num)) return this.objectStreams.get(num)
    this.objectStreams.set(num, undefined)
    const data = this.decode(stream)
    if (!data) return undefined
    const s = data.toString('latin1')
    const count = Number(stream.dict.get('N') ?? 0)
    const first = Number(stream.dict.get('First') ?? 0)
    const lx = new Lexer(s, 0)
    const offsets = []
    for (let i = 0; i < count; i++) {
      const a = lx.next()
      const b = lx.next()
      if (a.t !== 'num' || b.t !== 'num') break
      offsets.push([a.v, b.v])
    }
    const parsed = { s, first, offsets }
    this.objectStreams.set(num, parsed)
    return parsed
  }

  fromObjectStream(streamNum, index, num) {
    const stream = this.get(streamNum)
    if (!(stream instanceof Stream)) return undefined
    const parsed = this.objectStream(streamNum, stream)
    if (!parsed) return undefined
    let slot = parsed.offsets[index]
    if (!slot || slot[0] !== num) slot = parsed.offsets.find(([n]) => n === num)
    if (!slot) return undefined
    return parseValue(new Lexer(parsed.s, parsed.first + slot[1]))
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num)
    this.cache.set(num, null)
    let value
    const entry = this.entries.get(num)
    if (entry?.type === 1) value = this.readObjectAt(entry.offset, num)
    else if (entry?.type === 2) value = this.fromObjectStream(entry.stream, entry.index, num)
    if (value === undefined) {
      // The recorded offset did not hold this object: trust the file over its index.
      const scanned = this.scan().get(num)
      if (scanned?.type === 1) value = this.readObjectAt(scanned.offset, num)
      else if (scanned?.type === 2) value = this.fromObjectStream(scanned.stream, scanned.index, num)
      if (value !== undefined && entry) this.repaired = true
    }
    value = value === undefined ? null : value
    this.cache.set(num, value)
    return value
  }

  resolve(value, depth = 0) {
    let v = value
    while (v instanceof Ref && depth++ < 32) v = this.get(v.num)
    return v instanceof Ref ? null : v
  }

  /** Decoded stream bytes, or undefined for an image codec this reader has no use for. */
  decode(stream) {
    if (this.decoded.has(stream)) return this.decoded.get(stream)
    let filters = this.resolve(stream.dict.get('Filter'))
    let parms = this.resolve(stream.dict.get('DecodeParms') ?? stream.dict.get('DP'))
    filters = Array.isArray(filters) ? filters.map((f) => this.resolve(f)) : filters ? [filters] : []
    parms = Array.isArray(parms) ? parms.map((p) => this.resolve(p)) : [parms]
    let data = stream.raw
    try {
      for (const [i, filter] of filters.entries()) {
        const parm = parms[i] instanceof Map ? parms[i] : undefined
        if (filter === 'FlateDecode' || filter === 'Fl') data = unpredict(inflate(data), parm)
        else if (filter === 'LZWDecode' || filter === 'LZW') data = unpredict(lzw(data, Number(parm?.get('EarlyChange') ?? 1)), parm)
        else if (filter === 'ASCIIHexDecode' || filter === 'AHx') data = asciiHex(data)
        else if (filter === 'ASCII85Decode' || filter === 'A85') data = ascii85(data)
        else if (filter === 'RunLengthDecode' || filter === 'RL') data = runLength(data)
        else {
          data = undefined
          break
        }
      }
    } catch {
      data = undefined
    }
    this.decoded.set(stream, data)
    return data
  }

  /** Leaf pages in order, with inherited Resources and MediaBox. */
  pages() {
    const out = []
    const seen = new Set()
    const walk = (ref, inherited, depth) => {
      const node = this.resolve(ref)
      if (!(node instanceof Map) || depth > 64) return
      if (ref instanceof Ref) {
        if (seen.has(ref.num)) return
        seen.add(ref.num)
      }
      const scope = {
        resources: this.resolve(node.get('Resources')) ?? inherited.resources,
        mediaBox: this.resolve(node.get('MediaBox')) ?? inherited.mediaBox,
      }
      const kids = this.resolve(node.get('Kids'))
      if (node.get('Type') === 'Pages' || (Array.isArray(kids) && node.get('Type') !== 'Page')) {
        for (const kid of kids ?? []) walk(kid, scope, depth + 1)
      } else out.push({ dict: node, ...scope })
    }
    walk(this.root()?.get('Pages'), {}, 0)
    return out
  }

  info() {
    const info = this.resolve(this.trailer.get('Info'))
    const field = (key) => {
      const value = info instanceof Map ? this.resolve(info.get(key)) : undefined
      return value instanceof Str ? textString(value.bytes) : undefined
    }
    return { title: field('Title'), author: field('Author'), creator: field('Creator'), producer: field('Producer') }
  }

  encrypted() {
    return this.trailer.has('Encrypt') && this.trailer.get('Encrypt') !== null
  }
}

// ---------------------------------------------------------------------------
// Text strings and encodings

const PDF_DOC_HIGH = {
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044, 0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018,
  0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160, 0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161, 0x9e: 0x017e, 0xa0: 0x20ac,
}

/** A PDF text string: UTF-16BE or UTF-8 with a BOM, else PDFDocEncoding. */
export function textString(bytes) {
  if (bytes.startsWith('\xfe\xff')) return utf16be(bytes.slice(2, 2 + ((bytes.length - 2) & ~1)))
  if (bytes.startsWith('\xef\xbb\xbf')) return Buffer.from(bytes.slice(3), 'latin1').toString('utf8')
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes.charCodeAt(i)
    out += String.fromCharCode(PDF_DOC_HIGH[c] ?? c)
  }
  return out
}

/** Glyph names for codes 32..126 (ASCII, as WinAnsi names them) and 160..255 (Latin-1). */
const ASCII_NAMES = 'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde'.split(' ')
const LATIN1_NAMES = 'nbspace exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'.split(' ')
/** WinAnsi 0x80..0x9F: [glyph name, code point]; empty slots are undefined in the encoding. */
export const WIN_ANSI_HIGH = [
  ['Euro', 0x20ac], [], ['quotesinglbase', 0x201a], ['florin', 0x0192], ['quotedblbase', 0x201e], ['ellipsis', 0x2026], ['dagger', 0x2020], ['daggerdbl', 0x2021],
  ['circumflex', 0x02c6], ['perthousand', 0x2030], ['Scaron', 0x0160], ['guilsinglleft', 0x2039], ['OE', 0x0152], [], ['Zcaron', 0x017d], [],
  [], ['quoteleft', 0x2018], ['quoteright', 0x2019], ['quotedblleft', 0x201c], ['quotedblright', 0x201d], ['bullet', 0x2022], ['endash', 0x2013], ['emdash', 0x2014],
  ['tilde', 0x02dc], ['trademark', 0x2122], ['scaron', 0x0161], ['guilsinglright', 0x203a], ['oe', 0x0153], [], ['zcaron', 0x017e], ['Ydieresis', 0x0178],
]
const EXTRA_GLYPHS = { fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, dotlessi: 0x0131, Lslash: 0x0141, lslash: 0x0142, minus: 0x2212, fraction: 0x2044, caron: 0x02c7, breve: 0x02d8, dotaccent: 0x02d9, ring: 0x02da, ogonek: 0x02db, hungarumlaut: 0x02dd, space: 0x20, nonbreakingspace: 0xa0, hyphenminus: 0x2d, quoteleft: 0x2018, quoteright: 0x2019 }

const GLYPHS = (() => {
  const map = new Map()
  ASCII_NAMES.forEach((name, i) => map.set(name, 32 + i))
  LATIN1_NAMES.forEach((name, i) => map.set(name, 160 + i))
  for (const [name, code] of WIN_ANSI_HIGH) if (name) map.set(name, code)
  for (const [name, code] of Object.entries(EXTRA_GLYPHS)) map.set(name, code)
  return map
})()

function glyphToUnicode(name) {
  if (GLYPHS.has(name)) return String.fromCodePoint(GLYPHS.get(name))
  const base = name.split('.')[0]
  if (base !== name && GLYPHS.has(base)) return String.fromCodePoint(GLYPHS.get(base))
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(base)
  if (m) return base.slice(3).match(/.{4}/g).map((h) => String.fromCharCode(Number.parseInt(h, 16))).join('')
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base)
  if (m) return String.fromCodePoint(Number.parseInt(m[1], 16))
  if (base.includes('_')) return base.split('_').map((part) => glyphToUnicode(part) ?? '').join('') || undefined
  return undefined
}

function winAnsiTable() {
  const table = []
  for (let c = 0; c < 256; c++) table.push(c >= 32 && c < 127 ? String.fromCharCode(c) : c >= 160 ? String.fromCharCode(c) : undefined)
  WIN_ANSI_HIGH.forEach((entry, i) => {
    if (entry[1]) table[0x80 + i] = String.fromCodePoint(entry[1])
  })
  table[0x27] = "'"
  return table
}

const STANDARD_HIGH = { 0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen', 0xa6: 'florin', 0xa7: 'section', 0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft', 0xab: 'guillemotleft', 0xac: 'guilsinglleft', 0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl', 0xb1: 'endash', 0xb2: 'dagger', 0xb3: 'daggerdbl', 0xb4: 'periodcentered', 0xb6: 'paragraph', 0xb7: 'bullet', 0xb8: 'quotesinglbase', 0xb9: 'quotedblbase', 0xba: 'quotedblright', 0xbb: 'guillemotright', 0xbc: 'ellipsis', 0xbd: 'perthousand', 0xbf: 'questiondown', 0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron', 0xc6: 'breve', 0xc7: 'dotaccent', 0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla', 0xcd: 'hungarumlaut', 0xce: 'ogonek', 0xcf: 'caron', 0xd0: 'emdash', 0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash', 0xe9: 'Oslash', 0xea: 'OE', 0xeb: 'ordmasculine', 0xf1: 'ae', 0xf5: 'dotlessi', 0xf8: 'lslash', 0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls' }

function standardTable() {
  const table = []
  for (let c = 0; c < 256; c++) table.push(c >= 32 && c < 127 ? String.fromCharCode(c) : undefined)
  table[0x27] = '\u{2019}'
  table[0x60] = '\u{2018}'
  for (const [code, name] of Object.entries(STANDARD_HIGH)) table[Number(code)] = glyphToUnicode(name)
  return table
}

const MAC_ROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u{A0}ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\u{F8FF}ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ'

function macRomanTable() {
  const table = []
  for (let c = 0; c < 256; c++) table.push(c >= 32 && c < 127 ? String.fromCharCode(c) : c >= 128 ? MAC_ROMAN_HIGH[c - 128] : undefined)
  return table
}

const BASE_ENCODINGS = { WinAnsiEncoding: winAnsiTable, StandardEncoding: standardTable, MacRomanEncoding: macRomanTable }

/** Helvetica and Helvetica-Bold advance widths for WinAnsi codes 32..255 (1/1000 em), from the Adobe AFM metrics. */
export const HELVETICA = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
    556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350,
    556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667,
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
  ],
}

// ---------------------------------------------------------------------------
// CMaps and fonts

function utf16be(bytes) {
  if (bytes.length % 2) return bytes
  let out = ''
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1))
  return out
}

const codeOf = (bytes) => {
  let v = 0
  for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes.charCodeAt(i)
  return v
}

/** codespacerange, bfchar and bfrange (both forms) of a CMap. */
function parseCMap(text) {
  const lx = new Lexer(text, 0)
  const cmap = { codespace: [], chars: [new Map(), new Map(), new Map(), new Map(), new Map()], ranges: [] }
  const strings = (end) => {
    const out = []
    for (;;) {
      const tok = lx.next()
      if (tok.t === 'eof' || (tok.t === 'op' && tok.v === end)) return out
      out.push(valueFrom(lx, tok, 0))
    }
  }
  for (;;) {
    const tok = lx.next()
    if (tok.t === 'eof') break
    if (tok.t !== 'op') continue
    if (tok.v === 'begincodespacerange') {
      const items = strings('endcodespacerange')
      for (let i = 0; i + 1 < items.length; i += 2) {
        const lo = items[i]
        const hi = items[i + 1]
        if (lo instanceof Str && hi instanceof Str && lo.bytes.length === hi.bytes.length && lo.bytes.length > 0 && lo.bytes.length <= 4) cmap.codespace.push({ length: lo.bytes.length, lo: [...lo.bytes].map((c) => c.charCodeAt(0)), hi: [...hi.bytes].map((c) => c.charCodeAt(0)) })
      }
    } else if (tok.v === 'beginbfchar') {
      const items = strings('endbfchar')
      for (let i = 0; i + 1 < items.length; i += 2) {
        const src = items[i]
        const dst = items[i + 1]
        if (!(src instanceof Str) || src.bytes.length === 0 || src.bytes.length > 4) continue
        const value = dst instanceof Str ? utf16be(dst.bytes) : typeof dst === 'string' ? glyphToUnicode(dst) : undefined
        if (value !== undefined) cmap.chars[src.bytes.length].set(codeOf(src.bytes), value)
      }
    } else if (tok.v === 'beginbfrange') {
      const items = strings('endbfrange')
      for (let i = 0; i + 2 < items.length; i += 3) {
        const [lo, hi, dst] = [items[i], items[i + 1], items[i + 2]]
        if (!(lo instanceof Str) || !(hi instanceof Str) || lo.bytes.length === 0 || lo.bytes.length > 4) continue
        cmap.ranges.push({ length: lo.bytes.length, lo: codeOf(lo.bytes), hi: codeOf(hi.bytes), dst: dst instanceof Str ? utf16be(dst.bytes) : Array.isArray(dst) ? dst.map((d) => (d instanceof Str ? utf16be(d.bytes) : '')) : '' })
      }
    }
  }
  return cmap
}

function cmapLookup(cmap, code, length) {
  const direct = cmap.chars[length]?.get(code)
  if (direct !== undefined) return direct
  for (const range of cmap.ranges) {
    if (range.length !== length || code < range.lo || code > range.hi) continue
    if (Array.isArray(range.dst)) return range.dst[code - range.lo]
    if (range.dst.length === 0) return undefined
    const last = range.dst.charCodeAt(range.dst.length - 1) + (code - range.lo)
    return range.dst.slice(0, -1) + String.fromCharCode(last & 0xffff)
  }
  return undefined
}

/** Splits shown bytes into codes by codespace: the first range whose bytes all fit wins. */
function splitBySpace(bytes, codespace) {
  const codes = []
  let i = 0
  const shortest = Math.min(...codespace.map((r) => r.length))
  while (i < bytes.length) {
    let taken = 0
    for (const range of codespace) {
      if (i + range.length > bytes.length) continue
      let fits = true
      for (let k = 0; k < range.length; k++) {
        const b = bytes.charCodeAt(i + k)
        if (b < range.lo[k] || b > range.hi[k]) {
          fits = false
          break
        }
      }
      if (fits) {
        taken = range.length
        break
      }
    }
    if (taken === 0) taken = Math.min(shortest, bytes.length - i)
    codes.push({ code: codeOf(bytes.slice(i, i + taken)), length: taken })
    i += taken
  }
  return codes
}

class Font {
  constructor(doc, dict) {
    const r = (v) => doc.resolve(v)
    this.subtype = r(dict.get('Subtype'))
    this.composite = this.subtype === 'Type0'
    this.baseFont = String(r(dict.get('BaseFont')) ?? '')
    this.widths = new Map()
    this.defaultWidth = 0.5
    this.unicodeCodes = false
    const toUnicode = r(dict.get('ToUnicode'))
    const toUnicodeData = toUnicode instanceof Stream ? doc.decode(toUnicode) : undefined
    this.toUnicode = toUnicodeData ? parseCMap(toUnicodeData.toString('latin1')) : undefined
    if (this.composite) {
      const encoding = r(dict.get('Encoding'))
      if (encoding instanceof Stream) {
        const data = doc.decode(encoding)
        const space = data ? parseCMap(data.toString('latin1')).codespace : []
        this.codespace = space.length ? space : undefined
      } else if (typeof encoding === 'string' && /^Identity-[HV]$/.test(encoding)) this.codespace = undefined
      else {
        this.unicodeCodes = typeof encoding === 'string' && /^Uni.*-(UCS2|UTF16)-[HV]$/.test(encoding)
        this.codespace = this.toUnicode?.codespace.length ? this.toUnicode.codespace : undefined
      }
      const descendants = r(dict.get('DescendantFonts'))
      const cid = r(Array.isArray(descendants) ? descendants[0] : undefined)
      if (cid instanceof Map) {
        this.defaultWidth = Number(r(cid.get('DW')) ?? 1000) / 1000
        const w = r(cid.get('W'))
        if (Array.isArray(w)) {
          for (let i = 0; i < w.length; ) {
            const first = r(w[i])
            const next = r(w[i + 1])
            if (Array.isArray(next)) {
              next.forEach((value, k) => this.widths.set(first + k, Number(r(value)) / 1000))
              i += 2
            } else {
              const last = Math.min(next, first + 65535)
              const value = Number(r(w[i + 2])) / 1000
              for (let c = first; c <= last; c++) this.widths.set(c, value)
              i += 3
            }
          }
        }
      }
      return
    }
    // Simple fonts: one byte per code.
    const matrix = r(dict.get('FontMatrix'))
    const scale = this.subtype === 'Type3' && Array.isArray(matrix) ? Number(r(matrix[0])) : 0.001
    const first = Number(r(dict.get('FirstChar')) ?? 0)
    const widths = r(dict.get('Widths'))
    const descriptor = r(dict.get('FontDescriptor'))
    const missing = descriptor instanceof Map ? Number(r(descriptor.get('MissingWidth')) ?? 0) : 0
    if (Array.isArray(widths)) {
      widths.forEach((value, k) => this.widths.set(first + k, Number(r(value)) * scale))
      this.defaultWidth = missing * scale
    } else {
      const name = this.baseFont.replace(/^[A-Z]{6}\+/, '')
      if (/Courier/i.test(name)) this.defaultWidth = 0.6
      else {
        const table = /Bold/i.test(name) ? HELVETICA.bold : HELVETICA.regular
        table.forEach((value, k) => this.widths.set(32 + k, value / 1000))
      }
    }
    const encoding = r(dict.get('Encoding'))
    const flags = descriptor instanceof Map ? Number(r(descriptor.get('Flags')) ?? 0) : 0
    const symbolic = (flags & 4) !== 0 && (flags & 32) === 0
    let baseName = encoding instanceof Map ? r(encoding.get('BaseEncoding')) : encoding
    if (!BASE_ENCODINGS[baseName]) baseName = this.subtype === 'TrueType' || /Arial|Helvetica|Times|Courier/i.test(this.baseFont) ? 'WinAnsiEncoding' : 'StandardEncoding'
    this.encoding = /Symbol|Dingbats/i.test(this.baseFont) || (symbolic && !(encoding instanceof Map)) ? [] : BASE_ENCODINGS[baseName]()
    const differences = encoding instanceof Map ? r(encoding.get('Differences')) : undefined
    if (Array.isArray(differences)) {
      let code = 0
      for (const item of differences) {
        const v = r(item)
        if (typeof v === 'number') code = v
        else if (typeof v === 'string') this.encoding[code++] = glyphToUnicode(v)
      }
    }
  }

  codes(bytes) {
    if (!this.composite) return Array.from(bytes, (ch) => ({ code: ch.charCodeAt(0), length: 1 }))
    if (this.codespace) return splitBySpace(bytes, this.codespace)
    const out = []
    for (let i = 0; i < bytes.length; i += 2) out.push({ code: codeOf(bytes.slice(i, i + 2)), length: Math.min(2, bytes.length - i) })
    return out
  }

  text({ code, length }) {
    if (this.toUnicode) {
      const mapped = cmapLookup(this.toUnicode, code, length)
      if (mapped !== undefined) return mapped
    }
    if (this.composite) return this.unicodeCodes ? String.fromCharCode(code) : undefined
    return this.encoding?.[code] ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : undefined)
  }

  width(code) {
    return this.widths.get(code) ?? this.defaultWidth
  }
}

// ---------------------------------------------------------------------------
// Content streams → text

/** Control characters a ToUnicode map sometimes produces carry no text. */
function dropControls(text) {
  let out = ''
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    if (c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) out += ch
  }
  return out
}

const multiply = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]]
const IDENTITY = [1, 0, 0, 1, 0, 0]

/** Lays glyphs out as lines: a new line when the baseline moves, a space when the pen jumps further than a glyph gap. */
class TextSink {
  constructor() {
    this.out = ''
    this.last = undefined
    this.glyphs = 0
    this.unmapped = 0
  }

  add(text, start, end, size, direction) {
    this.glyphs++
    if (text === undefined) {
      this.unmapped++
      text = '\u{FFFD}'
    }
    const along = (p) => p[0] * direction[0] + p[1] * direction[1]
    const across = (p) => p[1] * direction[0] - p[0] * direction[1]
    const last = this.last
    if (last) {
      const sameDirection = Math.abs(direction[0] - last.direction[0]) < 0.01 && Math.abs(direction[1] - last.direction[1]) < 0.01
      const lineGap = Math.abs(across(start) - last.across)
      const height = Math.max(size, last.size, 0.0001)
      if (!sameDirection || lineGap > height * 0.5) {
        this.out = this.out.trimEnd()
        this.out += lineGap > height * 2.2 ? '\n\n' : '\n'
      } else {
        const gap = along(start) - last.along
        if ((gap > height * 0.2 || gap < -height * 1.5) && !/\s$/.test(this.out) && !/^\s/.test(text)) this.out += ' '
      }
    }
    this.out += text
    this.last = { along: along(end), across: across(start), size, direction }
  }
}

function contentText(doc, data, resources, sink, depth, fontCache) {
  const s = data.toString('latin1')
  const lx = new Lexer(s, 0)
  const operands = []
  const stack = []
  let ctm = IDENTITY
  let state = { font: undefined, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0 }
  let tm = IDENTITY
  let tlm = IDENTITY
  const fonts = doc.resolve(resources?.get('Font'))
  const xobjects = doc.resolve(resources?.get('XObject'))
  const fontFor = (name) => {
    const ref = fonts instanceof Map ? fonts.get(name) : undefined
    const key = ref instanceof Ref ? ref.num : ref
    if (key !== undefined && fontCache.has(key)) return fontCache.get(key)
    const dict = doc.resolve(ref)
    const font = dict instanceof Map ? new Font(doc, dict) : undefined
    if (key !== undefined) fontCache.set(key, font)
    return font
  }
  const show = (bytes) => {
    const font = state.font
    const codes = font ? font.codes(bytes) : Array.from(bytes, (ch) => ({ code: ch.charCodeAt(0), length: 1 }))
    for (const unit of codes) {
      const trm = multiply([state.size * state.scale, 0, 0, state.size, 0, state.rise], multiply(tm, ctm))
      const width = font ? font.width(unit.code) : 0.5
      const advance = (width * state.size + state.charSpace + (unit.length === 1 && unit.code === 32 ? state.wordSpace : 0)) * state.scale
      const start = [trm[4], trm[5]]
      tm = multiply([1, 0, 0, 1, advance, 0], tm)
      const after = multiply([state.size * state.scale, 0, 0, state.size, 0, state.rise], multiply(tm, ctm))
      const length = Math.hypot(trm[0], trm[1]) || 1
      const direction = [trm[0] / length, trm[1] / length]
      const size = Math.hypot(trm[2], trm[3])
      let text = font ? font.text(unit) : String.fromCharCode(unit.code)
      if (text !== undefined) text = dropControls(text)
      if (text === '') continue
      sink.add(text, start, [after[4], after[5]], size, direction)
    }
  }
  const nextLine = () => {
    tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm)
    tm = tlm
  }
  for (;;) {
    const tok = lx.next()
    if (tok.t === 'eof') break
    if (tok.t !== 'op') {
      operands.push(valueFrom(lx, tok, 0))
      continue
    }
    const op = tok.v
    const num = (i) => Number(operands[i] ?? 0)
    switch (op) {
      case 'q':
        stack.push({ ctm, state: { ...state } })
        break
      case 'Q': {
        const saved = stack.pop()
        if (saved) ({ ctm, state } = saved)
        break
      }
      case 'cm':
        ctm = multiply([num(0), num(1), num(2), num(3), num(4), num(5)], ctm)
        break
      case 'BT':
        tm = IDENTITY
        tlm = IDENTITY
        break
      case 'Tf':
        state.font = fontFor(operands[0])
        state.size = num(1)
        break
      case 'Tc':
        state.charSpace = num(0)
        break
      case 'Tw':
        state.wordSpace = num(0)
        break
      case 'Tz':
        state.scale = num(0) / 100
        break
      case 'TL':
        state.leading = num(0)
        break
      case 'Ts':
        state.rise = num(0)
        break
      case 'Td':
      case 'TD':
        if (op === 'TD') state.leading = -num(1)
        tlm = multiply([1, 0, 0, 1, num(0), num(1)], tlm)
        tm = tlm
        break
      case 'Tm':
        tlm = [num(0), num(1), num(2), num(3), num(4), num(5)]
        tm = tlm
        break
      case 'T*':
        nextLine()
        break
      case 'Tj':
        if (operands[0] instanceof Str) show(operands[0].bytes)
        break
      case "'":
        nextLine()
        if (operands[0] instanceof Str) show(operands[0].bytes)
        break
      case '"':
        state.wordSpace = num(0)
        state.charSpace = num(1)
        nextLine()
        if (operands[2] instanceof Str) show(operands[2].bytes)
        break
      case 'TJ':
        for (const item of Array.isArray(operands[0]) ? operands[0] : []) {
          if (item instanceof Str) show(item.bytes)
          else if (typeof item === 'number') tm = multiply([1, 0, 0, 1, (-item / 1000) * state.size * state.scale, 0], tm)
        }
        break
      case 'Do': {
        const xobject = xobjects instanceof Map ? doc.resolve(xobjects.get(operands[0])) : undefined
        if (xobject instanceof Stream && xobject.dict.get('Subtype') === 'Form' && depth < 12) {
          const formData = doc.decode(xobject)
          const matrix = doc.resolve(xobject.dict.get('Matrix'))
          const formCtm = Array.isArray(matrix) && matrix.length === 6 ? multiply(matrix.map(Number), ctm) : ctm
          if (formData) contentTextWith(doc, formData, doc.resolve(xobject.dict.get('Resources')) ?? resources, sink, depth + 1, fontCache, formCtm)
        }
        break
      }
      case 'BI': {
        // Inline image: skip its data to the EI that ends it.
        const id = s.indexOf('ID', lx.pos)
        const ei = id < 0 ? -1 : s.slice(id + 3).search(/\sEI(\s|$)/)
        lx.pos = ei < 0 ? s.length : id + 3 + ei + 3
        break
      }
      default:
        break
    }
    operands.length = 0
  }
}

/** A form XObject runs with its own matrix; everything else about the page's state carries in. */
function contentTextWith(doc, data, resources, sink, depth, fontCache, ctm) {
  const prefixed = Buffer.concat([Buffer.from(`${ctm.join(' ')} cm\n`, 'latin1'), data])
  contentText(doc, prefixed, resources, sink, depth, fontCache)
}

/** The text of one page, plus how many glyphs had no Unicode mapping. */
export function pageText(doc, page) {
  const contents = doc.resolve(page.dict.get('Contents'))
  const parts = (Array.isArray(contents) ? contents : [contents]).map((c) => doc.resolve(c)).filter((c) => c instanceof Stream)
  const chunks = parts.map((part) => doc.decode(part)).filter(Boolean)
  const sink = new TextSink()
  if (chunks.length > 0) {
    const data = Buffer.concat(chunks.flatMap((chunk) => [chunk, Buffer.from('\n')]))
    contentText(doc, data, page.resources instanceof Map ? page.resources : undefined, sink, 0, new Map())
  }
  const text = sink.out
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, glyphs: sink.glyphs, unmapped: sink.unmapped }
}
