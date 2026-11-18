// @ts-check
/**
 * Markdown for the browser client: `parseMarkdown(text)` turns model-written
 * text into a plain node TREE, and the client builds DOM from it with
 * `createElement`/`textContent` only. CommonMark's block and inline structure
 * with the GFM extensions a coding agent writes (tables, task items,
 * strikethrough, bare autolinks); no raw HTML, no reference links, no images.
 *
 * This module is the first line of the client's defence, so three rules are
 * structural rather than filters applied afterwards:
 *
 * - Raw HTML is never a node. There is no HTML construct at all: a `<` is a
 *   character unless it opens an autolink, so `<script>` is literal text.
 * - A link's `href` is only ever an absolute `http://`, `https://` or
 *   `mailto:` URL (`safeHref`), checked on the string the DOM will receive —
 *   after entities and escapes are decoded, so `jav&#x61;script:` cannot pass.
 *   Any other target renders the link's text and no link. An image renders
 *   its alt text: nothing here ever makes the browser fetch.
 * - Bounded work: input past 200 000 characters is not parsed, nesting past
 *   12 containers (or 24 inline spans) is text, and no regex can backtrack
 *   catastrophically — the inline scanner is CommonMark's delimiter-stack
 *   algorithm over a linked list, linear in practice.
 *
 * `streaming: true` parses a growing prefix: the only difference is that a
 * fence still open at the end of the input is marked `open`, so the client
 * can show it is still arriving. A half-written span or link is literal text
 * by the ordinary rules, and nothing throws on any prefix.
 *
 * Plain ES module shipped without a build step; no imports, no DOM.
 */

/**
 * @typedef {{ type: 'text', text: string }} TextNode
 * @typedef {{ type: 'strong', children: Inline[] }} StrongNode
 * @typedef {{ type: 'emphasis', children: Inline[] }} EmphasisNode
 * @typedef {{ type: 'delete', children: Inline[] }} DeleteNode
 * @typedef {{ type: 'code', text: string }} InlineCodeNode
 * @typedef {{ type: 'link', href: string, children: Inline[] }} LinkNode
 * @typedef {{ type: 'break' }} BreakNode
 * @typedef {TextNode | StrongNode | EmphasisNode | DeleteNode | InlineCodeNode | LinkNode | BreakNode} Inline
 *
 * @typedef {{ type: 'paragraph', children: Inline[] }} ParagraphNode
 * @typedef {{ type: 'heading', depth: 1|2|3|4|5|6, children: Inline[] }} HeadingNode
 * @typedef {{ type: 'code', lang?: string, text: string, open?: true }} CodeNode
 * @typedef {{ children: Block[], checked?: boolean }} ListItem
 * @typedef {{ type: 'list', ordered: boolean, start?: number, items: ListItem[] }} ListNode
 * @typedef {{ type: 'blockquote', children: Block[] }} BlockquoteNode
 * @typedef {'left'|'center'|'right'|null} Align
 * @typedef {{ type: 'table', align: Align[], head: Inline[][], rows: Inline[][][] }} TableNode
 * @typedef {{ type: 'rule' }} RuleNode
 * @typedef {ParagraphNode | HeadingNode | CodeNode | ListNode | BlockquoteNode | TableNode | RuleNode} Block
 *
 * @typedef {{ type: 'root', children: Block[] }} Root
 * @typedef {{ streaming?: boolean }} ParseOptions
 */

/** Characters parsed; the rest is one plain paragraph. */
const MAX_INPUT = 200_000
/** Nested block containers (quotes and list items together); deeper markers are text. */
const MAX_DEPTH = 12
/** Nested inline spans; deeper spans flatten to their text. */
const MAX_INLINE_DEPTH = 24
/** How far a link destination and title may run before the bracket is just text. */
const LINK_SCAN = 4096
/** How far a `<` looks for the `>` of an autolink. */
const AUTOLINK_SCAN = 2048

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')

/**
 * Whether `s` holds a C0 control character or DEL. A loop, not a regex: the
 * linter rightly refuses control characters in a pattern.
 * @param {string} s
 */
function hasControl(s) {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The one URL gate
// ---------------------------------------------------------------------------

const SAFE_SCHEME = /^(?:https?:\/\/|mailto:)/i

/**
 * The href a link may carry, or null when the target is anything but an
 * absolute http(s) or mailto URL. Applied to the DECODED string the DOM will
 * receive; the scheme must be literally present, so a percent-encoded,
 * entity-encoded, mixed-case-with-control-character or relative target
 * (`java%73cript:`, `java\tscript:`, `//host`, `/path`) is refused rather
 * than normalised.
 * @param {string} raw
 * @returns {string | null}
 */
function safeHref(raw) {
  let start = 0
  let end = raw.length
  while (start < end && raw.charCodeAt(start) <= 0x20) start++
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end--
  const href = raw.slice(start, end)
  if (hasControl(href)) return null
  const scheme = SAFE_SCHEME.exec(href)
  if (scheme === null) return null
  return scheme[0].toLowerCase() + href.slice(scheme[0].length)
}

// ---------------------------------------------------------------------------
// Entities and escapes
// ---------------------------------------------------------------------------

/** The named entities decoded; any other name stays literal. */
const NAMED = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['nbsp', ' '],
])
const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/y

/**
 * The entity reference at `i`, decoded, or null when there is none (or it
 * names an entity this module does not decode).
 * @param {string} s
 * @param {number} i
 * @returns {{ text: string, end: number } | null}
 */
function entityAt(s, i) {
  ENTITY.lastIndex = i
  const m = ENTITY.exec(s)
  if (m === null) return null
  const end = i + m[0].length
  if (m[3] !== undefined) {
    const named = NAMED.get(m[3])
    return named === undefined ? null : { text: named, end }
  }
  const code = m[1] !== undefined ? Number.parseInt(m[1], 16) : Number(m[2])
  const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
  return { text: valid ? String.fromCodePoint(code) : '�', end }
}

/**
 * Backslash escapes and entities decoded, as a link destination needs.
 * @param {string} s
 */
function decode(s) {
  if (!s.includes('\\') && !s.includes('&')) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '\\' && ASCII_PUNCT.has(s.charAt(i + 1))) {
      out += s.charAt(i + 1)
      i++
      continue
    }
    if (c === '&') {
      const entity = entityAt(s, i)
      if (entity !== null) {
        out += entity.text
        i = entity.end - 1
        continue
      }
    }
    out += c
  }
  return out
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

/**
 * One inline unit while a paragraph is parsed. Each level is a doubly linked
 * list, so wrapping a run of items into a span is O(1) — an array splice per
 * match would make a long line of `*a*` quadratic.
 * @typedef {object} Item
 * @property {'text'|'code'|'break'|'link'|'strong'|'emphasis'|'delete'} k
 * @property {string} text
 * @property {string} href
 * @property {Item | null} prev
 * @property {Item | null} next
 * @property {Item | null} first
 */

/**
 * A run of `*`, `_` or `~~` that may open or close a span (CommonMark §6.2).
 * @typedef {object} Delim
 * @property {Item} item
 * @property {number} pos creation order, which is also stack order
 * @property {string} ch
 * @property {number} count
 * @property {number} orig
 * @property {boolean} canOpen
 * @property {boolean} canClose
 * @property {Delim | null} prev
 * @property {Delim | null} next
 */

/**
 * An unmatched `[` or `![`, and the delimiter that was on top when it opened.
 * @typedef {{ item: Item, image: boolean, bottom: Delim | null }} Bracket
 */

/**
 * @param {Item['k']} k
 * @param {string} [text]
 * @returns {Item}
 */
const mkItem = (k, text = '') => ({ k, text, href: '', prev: null, next: null, first: null })

/** @param {string} c a character, or '' for the edge of the text */
const isWhite = (c) => c === '' || /\s/.test(c)
/** @param {string} c */
const isPunct = (c) => c !== '' && /[\p{P}\p{S}]/u.test(c)

/**
 * The character before `i`, whole if it is a surrogate pair.
 * @param {string} s
 * @param {number} i
 */
function charBefore(s, i) {
  if (i <= 0) return ''
  const low = s.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) return s.slice(i - 2, i)
  return s.charAt(i - 1)
}

/**
 * The character at `i`, whole if it is a surrogate pair.
 * @param {string} s
 * @param {number} i
 */
function charAtWhole(s, i) {
  const cp = s.codePointAt(i)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

/**
 * The text of a run of items and everything inside them, without recursion:
 * spans can nest as deep as the input is long.
 * @param {Item | null} first
 */
function plainText(first) {
  let out = ''
  /** @type {(Item | null)[]} */
  const stack = []
  let it = first
  for (;;) {
    if (it === null) {
      if (stack.length === 0) return out
      it = stack.pop() ?? null
      continue
    }
    if (it.k === 'text' || it.k === 'code') out += it.text
    else if (it.k === 'break') out += ' '
    if (it.first !== null) {
      stack.push(it.next)
      it = it.first
    } else {
      it = it.next
    }
  }
}

/** Plus no control character (`hasControl`), checked beside it. */
const URI_AUTOLINK = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/
const EMAIL_AUTOLINK = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
const HOST = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.?(?::\d{1,5})?$/u
const HOST_CHAR = /[\p{L}\p{N}_.:-]/u
/** Characters a bare URL never ends with (GFM), plus quotes. */
const URL_TRAIL = new Set('?!.,:*_~\'"')
/** Characters that end a bare URL: brackets and backticks belong to the markdown around it. */
const URL_STOP = new Set('<>[]`')
/** How far a bare URL may run; past it the link simply ends. */
const BARE_URL_SCAN = 2048

/**
 * Whether a character ends a bare URL: whitespace (ASCII or Unicode), a
 * control character, or a markdown bracket.
 * @param {string} c
 */
const endsUrl = (c) => {
  const code = c.charCodeAt(0)
  return code <= 0x20 || code === 0x7f || URL_STOP.has(c) || (code >= 0x80 && /\s/.test(c))
}

/**
 * @param {string} host
 * @param {number} schemeLength 0 for a `www.` link, which needs more than `www.`
 */
const validHost = (host, schemeLength) => HOST.test(host) && (schemeLength !== 0 || host.length > 4)

/**
 * A GFM bare autolink (`https://…`, `http://…`, `www.…`) starting at `i`,
 * with trailing punctuation, an unbalanced `)` and a trailing entity
 * reference left outside it.
 *
 * The host is read and checked BEFORE the rest of the URL: a near-URL is
 * retried from every word boundary inside it (`(www.a(www.a(…`), and an
 * invalid host must cost only its own length, not a scan to the end of the
 * token each time.
 * @param {string} src
 * @param {number} i
 * @returns {{ text: string, href: string, end: number } | null}
 */
function bareAutolink(src, i) {
  const head = src.slice(i, i + 8).toLowerCase()
  const schemeLength = head.startsWith('https://') ? 8 : head.startsWith('http://') ? 7 : 0
  if (schemeLength === 0 && !head.startsWith('www.')) return null
  const limit = Math.min(src.length, i + BARE_URL_SCAN)
  let end = i + schemeLength
  while (end < limit && HOST_CHAR.test(src.charAt(end))) end++
  const stop = end < limit ? src.charAt(end) : ''
  const pathed = stop === '/' || stop === '?' || stop === '#'
  if (pathed) {
    if (!validHost(src.slice(i + schemeLength, end), schemeLength)) return null
    while (end < limit && !endsUrl(src.charAt(end))) end++
  } else if (stop !== '' && !endsUrl(stop)) {
    // After a bare host only trailing punctuation may come before the URL
    // ends; anything else would make the host invalid.
    let k = end
    while (k < limit && (URL_TRAIL.has(src.charAt(k)) || src.charAt(k) === ')')) k++
    if (k < limit && !endsUrl(src.charAt(k))) return null
  }
  let opens = 0
  let closes = 0
  for (let k = i; k < end; k++) {
    const c = src.charAt(k)
    if (c === '(') opens++
    else if (c === ')') closes++
  }
  while (end > i) {
    const c = src.charAt(end - 1)
    if (URL_TRAIL.has(c)) {
      end--
      continue
    }
    if (c === ')' && closes > opens) {
      end--
      closes--
      continue
    }
    if (c === ';') {
      let k = end - 2
      while (k > i && /[A-Za-z0-9]/.test(src.charAt(k))) k--
      if (k < end - 2 && src.charAt(k) === '&') {
        end = k
        continue
      }
    }
    break
  }
  const text = src.slice(i, end)
  // A host followed by a path was checked above (trimming can shorten it only
  // by trailing punctuation, and the href goes through `safeHref` either way).
  if (!pathed && !validHost(text.slice(schemeLength), schemeLength)) return null
  // Through the one gate like every other link, `www.` included.
  const href = safeHref(schemeLength === 0 ? `http://${text}` : text)
  return href === null ? null : { text, href, end }
}

/**
 * The inline destination after `](`: `(dest "title")`. Returns the decoded
 * destination and the index after `)`, or null when it is not one.
 * @param {string} src
 * @param {number} p the index after `(`
 * @returns {{ href: string, end: number } | null}
 */
function destination(src, p) {
  const limit = Math.min(src.length, p + LINK_SCAN)
  /** @param {number} at */
  const skipSpace = (at) => {
    let q = at
    while (q < limit && (src.charAt(q) === ' ' || src.charAt(q) === '\t' || src.charAt(q) === '\n')) q++
    return q
  }
  let q = skipSpace(p)
  let raw = ''
  if (src.charAt(q) === '<') {
    let r = q + 1
    while (r < limit) {
      const c = src.charAt(r)
      if (c === '>' || c === '\n' || c === '<') break
      if (c === '\\' && r + 1 < limit) {
        raw += c + src.charAt(r + 1)
        r += 2
        continue
      }
      raw += c
      r++
    }
    if (r >= limit || src.charAt(r) !== '>') return null
    q = r + 1
  } else {
    let depth = 0
    let r = q
    while (r < limit) {
      const c = src.charAt(r)
      const code = src.charCodeAt(r)
      if (code <= 0x20 || code === 0x7f) break
      if (c === '\\' && r + 1 < limit && ASCII_PUNCT.has(src.charAt(r + 1))) {
        raw += c + src.charAt(r + 1)
        r += 2
        continue
      }
      if (c === '(') {
        depth++
        if (depth > 32) return null
      } else if (c === ')') {
        if (depth === 0) break
        depth--
      }
      raw += c
      r++
    }
    if (depth !== 0) return null
    q = r
  }
  const beforeTitle = q
  q = skipSpace(q)
  const open = src.charAt(q)
  if (q > beforeTitle && (open === '"' || open === "'" || open === '(')) {
    const close = open === '(' ? ')' : open
    let r = q + 1
    while (r < limit && src.charAt(r) !== close) r += src.charAt(r) === '\\' ? 2 : 1
    if (r >= limit) return null
    q = skipSpace(r + 1)
  }
  if (q >= limit || src.charAt(q) !== ')') return null
  return { href: decode(raw), end: q + 1 }
}

/**
 * The inline content of one paragraph, heading or table cell.
 * @param {string} src
 * @returns {Inline[]}
 */
function parseInline(src) {
  const head = mkItem('text')
  let tail = head
  /** @type {Delim | null} */
  let top = null
  let delimiters = 0
  /** @type {Bracket[]} */
  const brackets = []
  // Link openers below this index are inactive: links do not nest (CommonMark
  // §6.3). An index, not a flag per opener, so a link costs O(1), not O(openers).
  let linkFloor = 0
  // Backtick run lengths with no closer later in the text: each length is
  // searched for at most once, so a line of mismatched runs stays linear.
  /** @type {Set<number>} */
  const noCloser = new Set()
  let nextGt = -1
  let buf = ''
  const n = src.length
  const special = /[\\`*_~[\]!<&\nhHwW]/g

  /** @param {Item} item */
  const append = (item) => {
    item.prev = tail
    tail.next = item
    tail = item
  }
  const flush = () => {
    if (buf !== '') {
      append(mkItem('text', buf))
      buf = ''
    }
  }
  /** @param {Item} item */
  const unlinkItem = (item) => {
    const before = item.prev ?? head
    before.next = item.next
    if (item.next !== null) item.next.prev = before
    else tail = before
  }
  /** @param {Delim} d */
  const unlinkDelim = (d) => {
    if (d.prev !== null) d.prev.next = d.next
    if (d.next !== null) d.next.prev = d.prev
    else top = d.prev
  }
  /**
   * Move the items strictly between `before` and `after` (or the tail) into a
   * new container linked in their place.
   * @param {Item['k']} k
   * @param {Item} before
   * @param {Item | null} after
   */
  const wrap = (k, before, after) => {
    const box = mkItem(k)
    const first = before.next
    if (first !== null && first !== after) {
      const last = after === null ? tail : after.prev
      box.first = first
      first.prev = null
      if (last !== null) last.next = null
    }
    before.next = box
    box.prev = before
    box.next = after
    if (after !== null) after.prev = box
    else tail = box
    return box
  }

  /**
   * CommonMark's "process emphasis" over the delimiters above `bottom`, with
   * the openers-bottom table that keeps it linear.
   * @param {Delim | null} bottom
   */
  const processEmphasis = (bottom) => {
    // Per closer kind, the creation position at or below which no opener can
    // match. A position, not a delimiter: a floor delimiter that a later match
    // removes from the stack would never be met again, and every later walk
    // would fall through to the bottom.
    /** @type {Map<string, number>} */
    const floors = new Map()
    const bottomPos = bottom === null ? -1 : bottom.pos
    let closer = top === bottom ? null : top
    while (closer !== null && closer.prev !== bottom) closer = closer.prev
    while (closer !== null) {
      if (!closer.canClose) {
        closer = closer.next
        continue
      }
      const key = `${closer.ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}`
      const floor = floors.get(key) ?? bottomPos
      let opener = closer.prev
      let found = false
      while (opener !== null && opener.pos > floor) {
        const odd = closer.ch !== '~' && (closer.canOpen || opener.canClose) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0
        if (opener.ch === closer.ch && opener.canOpen && !odd) {
          found = true
          break
        }
        opener = opener.prev
      }
      const old = closer
      if (found && opener !== null) {
        const use = closer.ch === '~' ? 2 : closer.count >= 2 && opener.count >= 2 ? 2 : 1
        opener.count -= use
        closer.count -= use
        opener.item.text = opener.ch.repeat(opener.count)
        closer.item.text = closer.ch.repeat(closer.count)
        wrap(closer.ch === '~' ? 'delete' : use === 2 ? 'strong' : 'emphasis', opener.item, closer.item)
        // Delimiters inside the new span can no longer match anything outside it.
        opener.next = closer
        closer.prev = opener
        if (opener.count === 0) {
          unlinkItem(opener.item)
          unlinkDelim(opener)
        }
        if (closer.count === 0) {
          const next = closer.next
          unlinkItem(closer.item)
          unlinkDelim(closer)
          closer = next
        }
      } else {
        closer = closer.next
      }
      if (!found) {
        floors.set(key, old.prev === null ? -1 : old.prev.pos)
        if (!old.canOpen) unlinkDelim(old)
      }
    }
    let rest = top
    while (rest !== null && rest !== bottom) {
      const below = rest.prev
      unlinkDelim(rest)
      rest = below
    }
  }

  let i = 0
  while (i < n) {
    special.lastIndex = i
    const m = special.exec(src)
    const at = m === null ? n : m.index
    if (at > i) {
      buf += src.slice(i, at)
      i = at
      if (i >= n) break
    }
    const c = src.charAt(i)
    switch (c) {
      case '\\': {
        const next = src.charAt(i + 1)
        if (next === '\n') {
          flush()
          append(mkItem('break'))
          i += 2
        } else if (ASCII_PUNCT.has(next)) {
          buf += next
          i += 2
        } else {
          buf += '\\'
          i++
        }
        break
      }
      case '`': {
        let k = i
        while (src.charAt(k) === '`') k++
        const length = k - i
        let found = -1
        if (!noCloser.has(length)) {
          let p = k
          for (;;) {
            const q = src.indexOf('`', p)
            if (q < 0) break
            let r = q
            while (src.charAt(r) === '`') r++
            if (r - q === length) {
              found = q
              break
            }
            p = r
          }
          if (found < 0) noCloser.add(length)
        }
        if (found < 0) {
          buf += src.slice(i, k)
          i = k
          break
        }
        let body = src.slice(k, found).replaceAll('\n', ' ')
        if (body.length >= 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') body = body.slice(1, -1)
        flush()
        append(mkItem('code', body))
        i = found + length
        break
      }
      case '*':
      case '_':
      case '~': {
        let k = i
        while (src.charAt(k) === c) k++
        const count = k - i
        const run = src.slice(i, k)
        // GFM strikethrough is exactly `~~`; any other tilde run is text.
        if (c === '~' && count !== 2) {
          buf += run
          i = k
          break
        }
        const before = charBefore(src, i)
        const after = charAtWhole(src, k)
        const left = !isWhite(after) && (!isPunct(after) || isWhite(before) || isPunct(before))
        const right = !isWhite(before) && (!isPunct(before) || isWhite(after) || isPunct(after))
        // Intraword `_` neither opens nor closes (CommonMark §6.2 rules 2 and 4).
        const canOpen = c === '_' ? left && (!right || isPunct(before)) : left
        const canClose = c === '_' ? right && (!left || isPunct(after)) : right
        if (!canOpen && !canClose) {
          buf += run
          i = k
          break
        }
        flush()
        const item = mkItem('text', run)
        append(item)
        /** @type {Delim} */
        const d = { item, pos: delimiters++, ch: c, count, orig: count, canOpen, canClose, prev: top, next: null }
        if (top !== null) top.next = d
        top = d
        i = k
        break
      }
      case '[': {
        flush()
        const item = mkItem('text', '[')
        append(item)
        brackets.push({ item, image: false, bottom: top })
        i++
        break
      }
      case '!': {
        if (src.charAt(i + 1) !== '[') {
          buf += '!'
          i++
          break
        }
        flush()
        const item = mkItem('text', '![')
        append(item)
        brackets.push({ item, image: true, bottom: top })
        i += 2
        break
      }
      case ']': {
        i++
        const opener = brackets[brackets.length - 1]
        if (opener === undefined) {
          buf += ']'
          break
        }
        const active = opener.image || brackets.length - 1 >= linkFloor
        const dest = active && src.charAt(i) === '(' ? destination(src, i + 1) : null
        if (dest === null) {
          brackets.pop()
          linkFloor = Math.min(linkFloor, brackets.length)
          buf += ']'
          break
        }
        flush()
        processEmphasis(opener.bottom)
        brackets.pop()
        linkFloor = Math.min(linkFloor, brackets.length)
        if (opener.image) {
          // An image is its alt text: the client never loads a remote resource.
          opener.item.text = plainText(opener.item.next)
          opener.item.next = null
          tail = opener.item
        } else {
          const href = safeHref(dest.href)
          if (href !== null) {
            const link = wrap('link', opener.item, null)
            link.href = href
            // An empty link text would be an invisible anchor: show where it goes.
            if (link.first === null) link.first = mkItem('text', href)
          }
          // Safe or not, the `[` goes; an unsafe target leaves only the text.
          unlinkItem(opener.item)
          linkFloor = brackets.length
        }
        i = dest.end
        break
      }
      case '<': {
        if (nextGt < i) {
          nextGt = src.indexOf('>', i)
          if (nextGt < 0) nextGt = n
        }
        if (nextGt < n && nextGt - i <= AUTOLINK_SCAN) {
          const inner = src.slice(i + 1, nextGt)
          const uri = URI_AUTOLINK.test(inner) && !hasControl(inner)
          if (uri || EMAIL_AUTOLINK.test(inner)) {
            const href = uri ? safeHref(inner) : `mailto:${inner}`
            if (href === null) {
              buf += inner
            } else {
              flush()
              const link = mkItem('link')
              link.href = href
              link.first = mkItem('text', inner)
              append(link)
            }
            i = nextGt + 1
            break
          }
        }
        buf += '<'
        i++
        break
      }
      case '&': {
        const entity = entityAt(src, i)
        if (entity === null) {
          buf += '&'
          i++
        } else {
          buf += entity.text
          i = entity.end
        }
        break
      }
      case '\n': {
        // Two trailing spaces make a hard break; otherwise the line break is a
        // space. The line is flushed either way: reading the end of a `buf`
        // built by `+=` flattens it, and flattening a whole paragraph at every
        // line would be quadratic.
        let t = buf.length
        while (t > 0 && buf.charAt(t - 1) === ' ') t--
        const spaces = buf.length - t
        buf = buf.slice(0, t)
        flush()
        if (spaces >= 2) append(mkItem('break'))
        else buf = ' '
        i++
        while (src.charAt(i) === ' ' || src.charAt(i) === '\t') i++
        break
      }
      default: {
        // h, H, w, W: a bare autolink may start here, at the start of a word —
        // but not right after `](`, where it is the target of a link still
        // being written (a complete one was consumed by the `]` case).
        const before = charBefore(src, i)
        const boundary = before === '' || isWhite(before) || '*_~'.includes(before) || (before === '(' && src.charAt(i - 2) !== ']')
        const link = boundary ? bareAutolink(src, i) : null
        if (link === null) {
          buf += c
          i++
          break
        }
        flush()
        const item = mkItem('link')
        item.href = link.href
        item.first = mkItem('text', link.text)
        append(item)
        i = link.end
      }
    }
  }
  flush()
  processEmphasis(null)
  return toInline(head.next, 0, false)
}

/**
 * The linked items as the exported node shape: adjacent text merged, a link
 * inside a link unwrapped to its text (a bare URL inside link text), and spans
 * past MAX_INLINE_DEPTH flattened to text so no consumer recurses unboundedly.
 * @param {Item | null} first
 * @param {number} depth
 * @param {boolean} inLink
 * @returns {Inline[]}
 */
function toInline(first, depth, inLink) {
  /** @type {Inline[]} */
  const out = []
  /** @param {string} value */
  const text = (value) => {
    if (value === '') return
    const last = out[out.length - 1]
    if (last !== undefined && last.type === 'text') last.text += value
    else out.push({ type: 'text', text: value })
  }
  for (let it = first; it !== null; it = it.next) {
    if (it.k === 'text') text(it.text)
    else if (it.k === 'code') out.push({ type: 'code', text: it.text })
    else if (it.k === 'break') out.push({ type: 'break' })
    else if (depth >= MAX_INLINE_DEPTH) text(plainText(it.first))
    else if (it.k === 'link') {
      const children = toInline(it.first, depth + 1, true)
      if (!inLink) out.push({ type: 'link', href: it.href, children })
      else {
        for (const child of children) {
          if (child.type === 'text') text(child.text)
          else out.push(child)
        }
      }
    } else if (it.k === 'strong') out.push({ type: 'strong', children: toInline(it.first, depth + 1, inLink) })
    else if (it.k === 'emphasis') out.push({ type: 'emphasis', children: toInline(it.first, depth + 1, inLink) })
    else out.push({ type: 'delete', children: toInline(it.first, depth + 1, inLink) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Block structure: line classifiers
// ---------------------------------------------------------------------------

/** @param {string} line */
const isBlank = (line) => /^[ \t]*$/.test(line)

/**
 * Leading indentation in columns, a tab advancing to the next multiple of 4.
 * @param {string} line
 */
function indentOf(line) {
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c === 32) col++
    else if (c === 9) col += 4 - (col % 4)
    else break
  }
  return col
}

/** @param {string} line */
function firstNonSpace(line) {
  let i = 0
  while (line.charAt(i) === ' ' || line.charAt(i) === '\t') i++
  return i
}

/**
 * `line` with `k` columns of leading indentation removed; a tab that straddles
 * the cut leaves its remainder as spaces.
 * @param {string} line
 * @param {number} k
 */
function stripColumns(line, k) {
  let col = 0
  let i = 0
  while (i < line.length && col < k) {
    const c = line.charCodeAt(i)
    if (c === 32) {
      col++
      i++
    } else if (c === 9) {
      const width = 4 - (col % 4)
      if (col + width > k) return ' '.repeat(col + width - k) + line.slice(i + 1)
      col += width
      i++
    } else {
      break
    }
  }
  return line.slice(i)
}

/** @param {string} line */
const stripLeading = (line) => line.slice(firstNonSpace(line))

/**
 * @param {string} line
 * @returns {{ depth: 1|2|3|4|5|6, text: string } | null}
 */
function atxHeading(line) {
  if (indentOf(line) > 3) return null
  const start = firstNonSpace(line)
  let p = start
  while (line.charAt(p) === '#') p++
  const depth = p - start
  if (depth < 1 || depth > 6) return null
  if (p < line.length && line.charAt(p) !== ' ' && line.charAt(p) !== '\t') return null
  let text = line.slice(p).trim()
  // An optional closing run of `#`, separated by a space, is not content.
  let end = text.length
  while (end > 0 && text.charAt(end - 1) === '#') end--
  if (end === 0) text = ''
  else if (end < text.length && (text.charAt(end - 1) === ' ' || text.charAt(end - 1) === '\t')) text = text.slice(0, end).trimEnd()
  return { depth: /** @type {1|2|3|4|5|6} */ (depth), text }
}

/** @param {string} line */
function isRule(line) {
  if (indentOf(line) > 3) return false
  let ch = ''
  let count = 0
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i)
    if (c === ' ' || c === '\t') continue
    if ((c !== '-' && c !== '*' && c !== '_') || (ch !== '' && c !== ch)) return false
    ch = c
    count++
  }
  return count >= 3
}

/**
 * 1 for a `===` underline, 2 for `---`, 0 for neither.
 * @param {string} line
 */
function setextLevel(line) {
  if (indentOf(line) > 3) return 0
  const t = line.trim()
  if (t === '') return 0
  const c = t.charAt(0)
  if (c !== '=' && c !== '-') return 0
  for (let i = 1; i < t.length; i++) if (t.charAt(i) !== c) return 0
  return c === '=' ? 1 : 2
}

/**
 * @typedef {{ ch: string, length: number, indent: number, lang: string }} Fence
 */

/**
 * @param {string} line
 * @returns {Fence | null}
 */
function openFence(line) {
  const indent = indentOf(line)
  if (indent > 3) return null
  const p = firstNonSpace(line)
  const ch = line.charAt(p)
  if (ch !== '`' && ch !== '~') return null
  let q = p
  while (line.charAt(q) === ch) q++
  if (q - p < 3) return null
  const info = line.slice(q).trim()
  if (ch === '`' && info.includes('`')) return null
  const lang = (info.split(/[ \t]/, 1)[0] ?? '').toLowerCase()
  return { ch, length: q - p, indent, lang }
}

/**
 * @param {string} line
 * @param {Fence} fence
 */
function closesFence(line, fence) {
  if (indentOf(line) > 3) return false
  const t = line.trim()
  if (t.length < fence.length) return false
  for (let i = 0; i < t.length; i++) if (t.charAt(i) !== fence.ch) return false
  return true
}

/**
 * The fence state after one more line: open, still open, or closed.
 * @param {Fence | null} fence
 * @param {string} line
 */
const stepFence = (fence, line) => (fence === null ? openFence(line) : closesFence(line, fence) ? null : fence)

/**
 * The content of a `>` line, or null when the line is not one.
 * @param {string} line
 */
function quoteRest(line) {
  if (indentOf(line) > 3) return null
  const p = firstNonSpace(line)
  if (line.charAt(p) !== '>') return null
  const next = line.charAt(p + 1)
  return line.slice(next === ' ' || next === '\t' ? p + 2 : p + 1)
}

/**
 * @typedef {{ indent: number, ordered: boolean, marker: string, start: number, contentIndent: number, content: string }} ItemStart
 */

/**
 * A list item marker at the start of `line`: `-`, `+`, `*`, or 1–9 digits and
 * `.` or `)`, followed by whitespace or the end of the line.
 * @param {string} line
 * @returns {ItemStart | null}
 */
function listItem(line) {
  const indent = indentOf(line)
  if (indent > 3) return null
  const p = firstNonSpace(line)
  let q = p
  let ordered = false
  let marker = line.charAt(p)
  let start = 1
  if (marker === '-' || marker === '+' || marker === '*') {
    q = p + 1
  } else {
    while (q - p < 9 && line.charCodeAt(q) >= 48 && line.charCodeAt(q) <= 57) q++
    if (q === p) return null
    marker = line.charAt(q)
    if (marker !== '.' && marker !== ')') return null
    ordered = true
    start = Number(line.slice(p, q))
    q++
  }
  if (q < line.length && line.charAt(q) !== ' ' && line.charAt(q) !== '\t') return null
  const markerEnd = indent + (q - p)
  let col = markerEnd
  let r = q
  while (r < line.length && (line.charAt(r) === ' ' || line.charAt(r) === '\t')) {
    col += line.charAt(r) === '\t' ? 4 - (col % 4) : 1
    r++
  }
  const content = line.slice(r)
  const contentIndent = content === '' || col - markerEnd > 4 ? markerEnd + 1 : col
  return { indent, ordered, marker, start, contentIndent, content }
}

/**
 * Whether `line` starts a block that ends a paragraph (CommonMark's
 * "can interrupt a paragraph"): a fence, a heading, a rule, a quote, or a
 * non-empty bullet item / ordered item starting at 1.
 * @param {string} line
 * @param {number} depth
 */
function interrupts(line, depth) {
  if (indentOf(line) > 3) return false
  if (openFence(line) !== null || atxHeading(line) !== null || isRule(line)) return true
  if (depth >= MAX_DEPTH) return false
  if (quoteRest(line) !== null) return true
  const item = listItem(line)
  return item !== null && item.content !== '' && (!item.ordered || item.start === 1)
}

/**
 * Whether a line read as paragraph text, so the next line may continue it lazily.
 * @param {string | undefined} line
 */
const paragraphish = (line) => line !== undefined && !isBlank(line) && atxHeading(line) === null && !isRule(line) && openFence(line) === null

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The cells of a table row: outer pipes dropped, split on unescaped `|`, an
 * escaped `\|` becoming a literal pipe inside its cell.
 * @param {string} line
 */
function splitCells(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) {
    let slashes = 0
    while (s.charAt(s.length - 2 - slashes) === '\\') slashes++
    if (slashes % 2 === 0) s = s.slice(0, -1)
  }
  /** @type {string[]} */
  const cells = []
  let cell = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '\\' && i + 1 < s.length) {
      const next = s.charAt(i + 1)
      cell += next === '|' ? '|' : c + next
      i++
    } else if (c === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += c
    }
  }
  cells.push(cell.trim())
  return cells
}

const DELIMITER_CELL = /^:?-+:?$/

/**
 * The alignments of a delimiter row (`| :-- | :-: | --: |`), or null.
 * @param {string} line
 * @returns {Align[] | null}
 */
function delimiterRow(line) {
  if (indentOf(line) > 3 || !line.includes('|') || !line.includes('-')) return null
  /** @type {Align[]} */
  const align = []
  for (const cell of splitCells(line)) {
    if (!DELIMITER_CELL.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return align
}

/**
 * A table starting at `lines[i]`: a header row with a pipe, then a delimiter
 * row with the same number of cells.
 * @param {readonly string[]} lines
 * @param {number} i
 * @returns {{ align: Align[], head: string[] } | null}
 */
function tableAt(lines, i) {
  const header = lines[i]
  const delimiter = lines[i + 1]
  if (header === undefined || delimiter === undefined || indentOf(header) > 3 || !header.includes('|')) return null
  const align = delimiterRow(delimiter)
  if (align === null) return null
  const head = splitCells(header)
  return head.length === align.length ? { align, head } : null
}

// ---------------------------------------------------------------------------
// Block structure: the recursive parse
// ---------------------------------------------------------------------------

/**
 * @typedef {{ streaming: boolean }} Ctx
 */

/**
 * The blocks of a run of lines, already stripped of their container's prefix.
 * @param {readonly string[]} lines
 * @param {number} depth containers above these lines
 * @param {boolean} atEnd these lines run to the end of the input, so a fence
 *   left open here is still arriving
 * @param {Ctx} ctx
 * @returns {Block[]}
 */
function parseBlocks(lines, depth, atEnd, ctx) {
  /** @type {Block[]} */
  const blocks = []
  const n = lines.length
  let i = 0
  while (i < n) {
    const line = lines[i] ?? ''
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = openFence(line)
    if (fence !== null) {
      /** @type {string[]} */
      const body = []
      let j = i + 1
      let closed = false
      while (j < n) {
        const l = lines[j] ?? ''
        j++
        if (closesFence(l, fence)) {
          closed = true
          break
        }
        body.push(stripColumns(l, fence.indent))
      }
      const arriving = !closed && atEnd && ctx.streaming
      // A closing fence half-typed (`` after ```) is not code yet: showing it
      // would flash a stray line into the block until the third backtick lands.
      const tail = body[body.length - 1]?.trim() ?? ''
      if (arriving && tail !== '' && tail.length < fence.length && [...tail].every((c) => c === fence.ch)) body.pop()
      /** @type {CodeNode} */
      const node = { type: 'code', text: body.join('\n') }
      if (fence.lang !== '') node.lang = fence.lang
      if (arriving) node.open = true
      blocks.push(node)
      i = j
      continue
    }

    const heading = atxHeading(line)
    if (heading !== null) {
      blocks.push({ type: 'heading', depth: heading.depth, children: parseInline(heading.text) })
      i++
      continue
    }

    if (isRule(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    if (depth < MAX_DEPTH && quoteRest(line) !== null) {
      i = blockquote(lines, i, depth, atEnd, ctx, blocks)
      continue
    }

    const item = depth < MAX_DEPTH ? listItem(line) : null
    if (item !== null) {
      i = list(lines, i, item, depth, atEnd, ctx, blocks)
      continue
    }

    const table = tableAt(lines, i)
    if (table !== null) {
      /** @type {Inline[][][]} */
      const rows = []
      let j = i + 2
      while (j < n) {
        const l = lines[j] ?? ''
        if (isBlank(l) || interrupts(l, depth)) break
        const cells = splitCells(l)
        rows.push(table.head.map((_, column) => parseInline(cells[column] ?? '')))
        j++
      }
      blocks.push({ type: 'table', align: table.align, head: table.head.map((cell) => parseInline(cell)), rows })
      i = j
      continue
    }

    i = paragraph(lines, i, depth, atEnd && ctx.streaming, blocks)
  }
  return blocks
}

/**
 * A paragraph from `lines[i]`, or a setext heading when an underline ends it.
 * @param {readonly string[]} lines
 * @param {number} i
 * @param {number} depth
 * @param {boolean} arriving the last of `lines` is the streaming edge of the input
 * @param {Block[]} blocks
 * @returns {number} the index after it
 */
function paragraph(lines, i, depth, arriving, blocks) {
  const text = [stripLeading(lines[i] ?? '')]
  let j = i + 1
  let level = 0
  while (j < lines.length) {
    const l = lines[j] ?? ''
    if (isBlank(l)) break
    // A lone `-` still arriving is the start of a list item far more often
    // than an underline: left to the next block, it does not flash the
    // paragraph into a heading for one chunk.
    if (arriving && j === lines.length - 1 && l.trim() === '-') break
    level = setextLevel(l)
    if (level !== 0) {
      j++
      break
    }
    if (interrupts(l, depth) || tableAt(lines, j) !== null) break
    text.push(stripLeading(l))
    j++
  }
  const children = parseInline(text.join('\n').trimEnd())
  blocks.push(level === 0 ? { type: 'paragraph', children } : { type: 'heading', depth: level === 1 ? 1 : 2, children })
  return j
}

/**
 * A block quote from `lines[i]`: its `>` lines, and the lazy continuation
 * lines a paragraph inside it may run on to.
 * @param {readonly string[]} lines
 * @param {number} i
 * @param {number} depth
 * @param {boolean} atEnd
 * @param {Ctx} ctx
 * @param {Block[]} blocks
 * @returns {number} the index after it
 */
function blockquote(lines, i, depth, atEnd, ctx, blocks) {
  /** @type {string[]} */
  const inner = []
  /** @type {Fence | null} */
  let fence = null
  let j = i
  while (j < lines.length) {
    const l = lines[j] ?? ''
    const rest = quoteRest(l)
    if (rest !== null) {
      inner.push(rest)
      fence = stepFence(fence, rest)
      j++
      continue
    }
    if (isBlank(l) || fence !== null || !paragraphish(inner[inner.length - 1]) || interrupts(l, depth)) break
    inner.push(l)
    j++
  }
  blocks.push({ type: 'blockquote', children: parseBlocks(inner, depth + 1, atEnd && j >= lines.length, ctx) })
  return j
}

const TASK = /^\[([ xX])\](?:[ \t]|$)/

/**
 * A list from `lines[i]`: consecutive items with the same marker kind. An
 * item holds the lines indented to its content (or, leniently, two columns
 * past its marker — the nesting models write after `1.`), blank lines, and
 * lazy paragraph continuations.
 * @param {readonly string[]} lines
 * @param {number} i
 * @param {ItemStart} first
 * @param {number} depth
 * @param {boolean} atEnd
 * @param {Ctx} ctx
 * @param {Block[]} blocks
 * @returns {number} the index after it
 */
function list(lines, i, first, depth, atEnd, ctx, blocks) {
  /** @type {ListNode} */
  const node = { type: 'list', ordered: first.ordered, items: [] }
  if (first.ordered) node.start = first.start
  const n = lines.length
  let j = i
  while (j < n) {
    const line = lines[j] ?? ''
    const item = isRule(line) ? null : listItem(line)
    if (item === null || item.ordered !== first.ordered || item.marker !== first.marker) break
    const threshold = Math.min(item.contentIndent, item.indent + 2)
    const body = [item.content]
    let fence = stepFence(null, item.content)
    let last = item.content
    let blanks = 0
    j++
    while (j < n) {
      const l = lines[j] ?? ''
      if (isBlank(l)) {
        body.push('')
        blanks++
        j++
        continue
      }
      const indent = indentOf(l)
      if (indent >= threshold) {
        const stripped = stripColumns(l, Math.min(indent, item.contentIndent))
        body.push(stripped)
        fence = stepFence(fence, stripped)
        last = stripped
        blanks = 0
        j++
        continue
      }
      if (blanks > 0 || fence !== null || isRule(l) || listItem(l) !== null || interrupts(l, depth) || !paragraphish(last)) break
      body.push(l)
      last = l
      j++
    }
    while (body.length > 1 && body[body.length - 1] === '') body.pop()
    /** @type {ListItem} */
    const entry = { children: [] }
    const task = TASK.exec(body[0] ?? '')
    if (task !== null) {
      entry.checked = task[1] !== ' '
      body[0] = (body[0] ?? '').slice(task[0].length)
    }
    entry.children = parseBlocks(body, depth + 1, atEnd && j >= n, ctx)
    node.items.push(entry)
  }
  blocks.push(node)
  return j
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Parse markdown into the node tree the client renders. Never throws; raw HTML
 * is text; every link is http(s) or mailto; input past 200 000 characters is
 * appended unparsed as one plain paragraph.
 * @param {string} text
 * @param {ParseOptions} [options]
 * @returns {Root}
 */
export function parseMarkdown(text, options = {}) {
  const source = typeof text === 'string' ? text : ''
  const head = source.length > MAX_INPUT ? source.slice(0, MAX_INPUT) : source
  const rest = source.length > MAX_INPUT ? source.slice(MAX_INPUT) : ''
  const lines = head.split(/\r\n|\r|\n/)
  // A final line break ends the last line; it does not start an empty one
  // (which an open fence would otherwise show as a trailing blank line).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const children = parseBlocks(lines, 0, rest === '', { streaming: options.streaming === true })
  if (rest !== '') children.push({ type: 'paragraph', children: [{ type: 'text', text: rest }] })
  return { type: 'root', children }
}
