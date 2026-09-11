/**
 * Documentation gates. Three rules, one script:
 *
 * 1. Size budgets. `docs/ARCHITECTURE.md` and `docs/BLUEPRINT.md` are reread
 *    at the start of every development session, so their size is a per-session
 *    cost; `README.md` is what a visitor reads first, so its size is the cost
 *    of a first impression. Each has a hard ceiling (CLAUDE.md §5); crossing it fails the gate,
 *    and crossing 90% of it prints a warning that says which document must be
 *    compacted before it grows again. The ceilings exist because the documents
 *    reached ~230 KB once (S8.5) and ~95 KB for the architecture alone (V1),
 *    and each time the fix was an emergency rewrite that lost contracts.
 *
 * 2. Internal links. Every relative link, image and `blob/main/` URL in the
 *    repository's markdown and issue templates must name a file that exists,
 *    and a `#fragment` must name a heading in that file (GitHub's slug rules).
 *    The documents moved once (root → `docs/`), and a link that rots silently
 *    is the same defect as a claim that rots silently.
 *
 * 3. Table rows. In every markdown table each row carries exactly the header's
 *    cell count. An unescaped `|` inside a code span is a column separator to
 *    every renderer, and a compaction once broke a §3 row that way invisibly.
 *
 * Run: `node scripts/check-docs.ts` (part of `pnpm check`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Hard ceilings in bytes. Change them in CLAUDE.md §5 first; this is the enforcement. */
const BUDGETS: Record<string, number> = {
  'docs/ARCHITECTURE.md': 84 * 1024,
  'docs/BLUEPRINT.md': 30 * 1024,
  'README.md': 32 * 1024,
}
const WARN_AT = 0.9

const REPO_BLOB = 'https://github.com/earthwalker17/MiniDSH/blob/main/'
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(md|yml|yaml)$/.test(entry)) out.push(full)
  }
  return out
}

/** GitHub's heading → fragment rule: lowercase, drop punctuation, spaces to hyphens, `-n` on repeats. */
function slugsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>()
  const slugs = new Set<string>()
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) continue
    const match = /^#{1,6}\s+(.*)$/.exec(line)
    if (!match) continue
    const text = match[1]!.replace(/`/g, '').trim()
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  return slugs
}

const failures: string[] = []
const warnings: string[] = []

for (const [file, ceiling] of Object.entries(BUDGETS)) {
  const path = join(ROOT, file)
  if (!existsSync(path)) {
    failures.push(`${file}: missing (CLAUDE.md §5 names it as a primary document)`)
    continue
  }
  const bytes = statSync(path).size
  const pct = Math.round((bytes / ceiling) * 100)
  if (bytes > ceiling) failures.push(`${file}: ${bytes} bytes exceeds its ${ceiling}-byte ceiling (${pct}%) — compact existing sections before adding`)
  else if (bytes > ceiling * WARN_AT) warnings.push(`${file}: ${bytes} bytes is ${pct}% of its ${ceiling}-byte ceiling — compact before it grows again`)
  else console.log(`${file}: ${bytes} bytes (${pct}% of ${ceiling})`)
}

const slugCache = new Map<string, Set<string>>()
const slugsFor = (path: string): Set<string> => {
  let slugs = slugCache.get(path)
  if (!slugs) {
    slugs = slugsOf(readFileSync(path, 'utf8'))
    slugCache.set(path, slugs)
  }
  return slugs
}

const LINK = /(?:!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(?:https:\/\/github\.com\/earthwalker17\/MiniDSH\/blob\/main\/([^\s)>"']+)))/g
let links = 0
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  for (const match of text.matchAll(LINK)) {
    const [, inline, blob] = match
    let target: string
    let base: string
    if (blob !== undefined) {
      target = blob
      base = ROOT
    } else if (inline !== undefined) {
      if (/^[a-z]+:/i.test(inline)) {
        // An absolute URL to this repository's own tree is checked like a relative link; anything else is not ours to check.
        if (!inline.startsWith(REPO_BLOB)) continue
        target = inline.slice(REPO_BLOB.length)
        base = ROOT
      } else {
        target = inline
        base = dirname(file)
      }
    } else continue
    links++
    const [pathPart, fragment] = target.split('#', 2)
    const resolved = pathPart === '' ? file : resolve(base, decodeURIComponent(pathPart!))
    if (!existsSync(resolved)) {
      failures.push(`${rel}: link target does not exist: ${target}`)
      continue
    }
    if (fragment !== undefined && fragment !== '' && /\.md$/i.test(resolved)) {
      if (!slugsFor(resolved).has(fragment.toLowerCase())) failures.push(`${rel}: no heading #${fragment} in ${relative(ROOT, resolved).replace(/\\/g, '/')}`)
    }
  }
}
console.log(`checked ${links} internal links`)

/** Cells of one table row, honouring `\|` as an escaped pipe. */
const cellCount = (row: string): number => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length
const isRow = (line: string | undefined): boolean => line !== undefined && /^\s*\|.*\|\s*$/.test(line)
const isRule = (line: string | undefined): boolean => line !== undefined && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)
let tables = 0
for (const file of walk(ROOT)) {
  if (!file.endsWith('.md')) continue
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) inFence = !inFence
    if (inFence) continue
    if (!isRow(lines[i]) || !isRule(lines[i + 1])) continue
    tables++
    const width = cellCount(lines[i]!)
    let j = i + 2
    for (; j < lines.length && isRow(lines[j]); j++) {
      const cells = cellCount(lines[j]!)
      if (cells !== width) failures.push(`${rel}:${j + 1}: table row has ${cells} cells, header has ${width}`)
    }
    i = j - 1
  }
}
console.log(`checked ${tables} tables`)

for (const warning of warnings) console.warn(`WARN ${warning}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log('docs ok')
