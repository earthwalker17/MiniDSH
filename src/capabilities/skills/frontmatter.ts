/**
 * A `SKILL.md` front-matter reader: the subset of YAML the open skill format
 * (agentskills.io) actually uses, with no dependency.
 *
 * Three keys are read — `name`, `description`, `disable-model-invocation` — and
 * every other key is skipped whole, nested maps such as `metadata:` included.
 * That is the runtime's whole contract with a skill: what it is called, when it
 * fits, and whether its author wants it listed at all. `license`,
 * `allowed-tools`, `model` and the rest describe things this harness never
 * grants a skill (ARCHITECTURE §11: a skill is data, never code or authority),
 * so reading them would only invite a later session to start honouring them.
 *
 * Lenient where authors are sloppy and the meaning is still plain: a value with
 * an unquoted `: ` keeps everything after the first one, as the agentskills
 * client guide recommends, and CRLF or a BOM changes nothing. Strict only where
 * a guess would list something its author did not mean to: a missing fence and
 * a flag that is not a boolean refuse the file.
 */

export interface SkillFrontmatter {
  readonly name?: string | undefined
  readonly description?: string | undefined
  /** The author's "never list this to the model"; MiniDSH has no other way to invoke a skill, so it hides it. */
  readonly disableModelInvocation: boolean
}

export type ParsedSkillFile = { readonly ok: true; readonly frontmatter: SkillFrontmatter } | { readonly ok: false; readonly reason: string }

/** The open format's name rule: lowercase letters, digits and single inner hyphens, at most 64 characters. */
export function isSkillName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/
const MAP_LINE = /^[ \t]+[A-Za-z0-9_.-]+[ \t]*:(?:[ \t]|$)/
const BLOCK_HEADER = /^([|>])([+-]?)([1-9]?)[+-]?(?:[ \t]+#.*)?$/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** A plain scalar ends at ` #`; a quoted one is handled before this is called. */
function stripComment(value: string): string {
  const at = value.search(/(^|[ \t])#/)
  return at < 0 ? value : value.slice(0, at)
}

/** Plain multi-line scalars fold: each line break between non-empty lines becomes a space, an empty line a newline. */
function fold(lines: readonly string[]): string {
  let out = ''
  let pendingBreaks = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) {
      pendingBreaks++
      continue
    }
    if (out.length > 0) out += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : ' '
    pendingBreaks = 0
    out += line
  }
  return out
}

function blockScalar(style: string, lines: readonly string[]): string {
  const content = lines.filter((line) => line.trim().length > 0)
  if (content.length === 0) return ''
  const indent = Math.min(...content.map(indentOf))
  const stripped = lines.map((line) => (line.trim().length === 0 ? '' : line.slice(indent)))
  if (style === '|') return stripped.join('\n')
  // Folded: lines join with a space, an empty line is a newline, and a
  // more-indented line keeps its break (YAML's rule, simplified to what a
  // description needs).
  let out = ''
  let previousMoreIndented = false
  let pendingBreaks = 0
  for (const line of stripped) {
    if (line.length === 0) {
      pendingBreaks++
      continue
    }
    const moreIndented = /^[ \t]/.test(line)
    if (out.length > 0) out += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : moreIndented || previousMoreIndented ? '\n' : ' '
    pendingBreaks = 0
    previousMoreIndented = moreIndented
    out += line
  }
  return out
}

const DOUBLE_ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f', e: '\x1b', ' ': ' ' }

/** A quoted scalar may continue over the key's indented lines; its line breaks fold like a plain scalar's. */
function quoted(first: string, continuation: readonly string[]): string | undefined {
  const quote = first[0]!
  const source = [first.slice(1), ...continuation.map((line) => line.trim())]
  let out = ''
  let joined = false
  for (let lineIndex = 0; lineIndex < source.length; lineIndex++) {
    const line = source[lineIndex]!
    if (lineIndex > 0 && !joined) out += line.length === 0 ? '\n' : out.endsWith('\n') || out.length === 0 ? '' : ' '
    joined = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (quote === "'") {
        if (ch === "'") {
          if (line[i + 1] === "'") {
            out += "'"
            i++
            continue
          }
          return out
        }
        out += ch
        continue
      }
      if (ch === '"') return out
      if (ch === '\\') {
        const next = line[i + 1]
        if (next === undefined) {
          // An escaped line break joins the lines with nothing between them.
          joined = true
          break
        }
        if (next === 'u' || next === 'x' || next === 'U') {
          const width = next === 'x' ? 2 : next === 'u' ? 4 : 8
          const hex = line.slice(i + 2, i + 2 + width)
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) return undefined
          const code = Number.parseInt(hex, 16)
          // Past U+10FFFF `fromCodePoint` THROWS, and a lone surrogate is no
          // character: both are a value nobody meant, refused like a bad escape.
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined
          out += String.fromCodePoint(code)
          i += 1 + width
          continue
        }
        const mapped = DOUBLE_ESCAPES[next]
        if (mapped === undefined) return undefined
        out += mapped
        i++
        continue
      }
      out += ch
    }
  }
  // An unterminated quote is not a value anyone meant.
  return undefined
}

type Scalar = { readonly kind: 'string'; readonly value: string } | { readonly kind: 'map' } | { readonly kind: 'invalid' }

function scalar(rest: string | undefined, continuation: readonly string[]): Scalar {
  const head = (rest ?? '').trim()
  if (head.length === 0) {
    if (continuation.length === 0) return { kind: 'string', value: '' }
    const firstContent = continuation.find((line) => line.trim().length > 0)
    if (firstContent !== undefined && (MAP_LINE.test(firstContent) || firstContent.trimStart().startsWith('- '))) return { kind: 'map' }
    return { kind: 'string', value: fold(continuation.map(stripComment)) }
  }
  const block = BLOCK_HEADER.exec(head)
  if (block) return { kind: 'string', value: blockScalar(block[1]!, continuation) }
  if (head.startsWith('"') || head.startsWith("'")) {
    const value = quoted(head, continuation)
    return value === undefined ? { kind: 'invalid' } : { kind: 'string', value }
  }
  if (head.startsWith('[') || head.startsWith('{')) return { kind: 'map' }
  return { kind: 'string', value: fold([stripComment(head), ...continuation.map(stripComment)]) }
}

function flag(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0', ''].includes(normalized)) return false
  return undefined
}

export function parseSkillFile(text: string): ParsedSkillFile {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trimEnd() !== '---') return { ok: false, reason: 'no front-matter (the first line must be ---)' }
  const end = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === '---' || line.trimEnd() === '...'))
  if (end < 0) return { ok: false, reason: 'unterminated front-matter (no closing ---)' }

  const fields = new Map<string, { rest: string | undefined; continuation: string[] }>()
  let current: { rest: string | undefined; continuation: string[] } | undefined
  for (const line of lines.slice(1, end)) {
    // A sequence may sit at the key's own indent (`tags:` then `- a`): that is
    // still the key's value, not a new key.
    if (line.length > 0 && indentOf(line) === 0 && !/^-([ \t]|$)/.test(line)) {
      if (line.startsWith('#')) continue
      const match = KEY_LINE.exec(line)
      if (!match) return { ok: false, reason: `unreadable front-matter line: ${line.slice(0, 80)}` }
      current = { rest: match[2], continuation: [] }
      // The last occurrence wins, as most YAML readers allow.
      fields.set(match[1]!, current)
      continue
    }
    current?.continuation.push(line)
  }
  // Trailing blank lines belong to no value.
  for (const field of fields.values()) {
    while (field.continuation.length > 0 && field.continuation.at(-1)!.trim().length === 0) field.continuation.pop()
  }

  const read = (key: string): Scalar | undefined => {
    const field = fields.get(key)
    return field === undefined ? undefined : scalar(field.rest, field.continuation)
  }
  const stringField = (key: string): string | undefined | { error: string } => {
    const value = read(key)
    if (value === undefined) return undefined
    if (value.kind !== 'string') return { error: `${key} is not a string` }
    const trimmed = value.value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }

  const name = stringField('name')
  if (typeof name === 'object') return { ok: false, reason: name.error }
  const description = stringField('description')
  if (typeof description === 'object') return { ok: false, reason: description.error }
  const hidden = read('disable-model-invocation')
  let disableModelInvocation = false
  if (hidden !== undefined) {
    const parsed = hidden.kind === 'string' ? flag(hidden.value) : undefined
    if (parsed === undefined) return { ok: false, reason: 'disable-model-invocation is not a boolean' }
    disableModelInvocation = parsed
  }
  return { ok: true, frontmatter: { name, description, disableModelInvocation } }
}
