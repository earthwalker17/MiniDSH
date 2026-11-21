/**
 * Documentation gates. The documents are MAPS sized to what a session reads
 * before it starts work (CLAUDE.md §5); this script is the only place their
 * numbers live. Nine rules, one script:
 *
 * 1. Size budgets. Every document a session reads at its start is a per-session
 *    cost, so each has a hard ceiling set from a reading load, not from what
 *    happens to exist: crossing it fails the gate, crossing 90% of it warns and
 *    names the largest sections. `references/` (the DSH map) has a per-file and
 *    a folder ceiling too.
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
 * 4. The architecture headings. Code comments, the README, CONTRIBUTING,
 *    SECURITY and two issue-template links cite `docs/ARCHITECTURE.md` by
 *    section number and title, so its fourteen `## N.` headings are pinned.
 *
 * 5. The map form of `docs/ARCHITECTURE.md`: no paragraph or bullet over
 *    PARAGRAPH_MAX bytes and no table cell over CELL_MAX — a longer one is an
 *    encyclopedia entry whose detail belongs in the owning code's comment — and
 *    a per-section target whose overrun warns, so growth is caught in the
 *    section where it happens rather than when the ceiling breaks.
 *
 * 6. The reader documents (the guide, the case study, the module READMEs,
 *    CONTRIBUTING): a ceiling each, and the README's eleven sections by name
 *    and order.
 *
 * 7. A layer README names every module of its layer.
 *
 * 8. Every `minidsh` command and `--flag` the README and the guide tell a
 *    person to type exists in the CLI's own tables.
 *
 * 9. Every picture a document shows exists, every picture under
 *    `docs/images/` is shown or listed, and every download link names an
 *    asset the release uploads.
 *
 * Run: `node scripts/check-docs.ts` (part of `pnpm check`); `--sections` also
 * prints each budgeted document's `##` sections by size, the input a
 * compaction starts from (`.claude/skills/docs-maintenance/SKILL.md`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Hard ceilings in bytes (~2.7 bytes per token for these documents). The
 * startup read — CLAUDE, PROJECT, ARCHITECTURE, BLUEPRINT — is held near 40k
 * tokens, which gives the architecture map ~20k. The procedure document is
 * read only when compacting. A ceiling moves only with the user's agreement.
 */
const BUDGETS: Record<string, number> = {
  'CLAUDE.md': 16 * 1024,
  'docs/PROJECT.md': 17 * 1024,
  'docs/ARCHITECTURE.md': 56 * 1024,
  'docs/BLUEPRINT.md': 30 * 1024,
  'README.md': 32 * 1024,
  '.claude/skills/docs-maintenance/SKILL.md': 8 * 1024,
}
/** The constitution's own rule (CLAUDE.md §5): under 200 lines. */
const LINE_BUDGETS: Record<string, number> = { 'CLAUDE.md': 200 }
const WARN_AT = 0.9

/** The map form (rule 5). Section keys are the `## N.` numbers; 0 is the preamble. */
const ARCHITECTURE = 'docs/ARCHITECTURE.md'
const PARAGRAPH_MAX = 700
const CELL_MAX = 450
const SECTION_TARGETS: Record<number, number> = {
  0: 700, 1: 1050, 2: 1500, 3: 4350, 4: 4800, 5: 1750, 6: 4050, 7: 5950,
  8: 4550, 9: 3450, 10: 2100, 11: 3400, 12: 2450, 13: 9400, 14: 2000,
}
const SECTION_WARN = 1.15

/**
 * `references/` is a curated MAP of DeepSeek Harness, consulted by topic
 * (CLAUDE.md §4): what exists upstream, why it matters, where the source is,
 * what may be stale. A file that outgrows its ceiling has started copying, and
 * a folder that outgrows its own has stopped being something a session reads
 * before researching.
 */
const REFERENCES_DIR = 'references'
const REFERENCE_FILE_CEILING = 8 * 1024
/** The ledger holds every verdict once, for all areas; a session reads one area's table of it. */
const REFERENCE_FILE_OVERRIDES: Record<string, number> = { 'references/assumptions.md': 16 * 1024 }
const REFERENCES_TOTAL_CEILING = 80 * 1024

/** Cited by number and title from code and from other documents: renaming one is a repository-wide change, not an edit. */
const ARCHITECTURE_HEADINGS = [
  '## 1. Layers and dependency direction',
  '## 2. Kernel (`src/kernel`)',
  '## 3. Core contracts (`src/core`)',
  '## 4. Canonical facts: the session log',
  '## 5. LLM vocabulary and the adapters',
  '## 6. The loop and the tool pipeline',
  '## 7. Authority',
  '## 8. Surfaces',
  '## 9. Composition, configuration and packaging',
  '## 10. Verification',
  '## 11. Where new things go',
  '## 12. Divergences from DeepSeek Harness (the ones that still shape decisions)',
  '## 13. Known limitations (current)',
  '## 14. File map',
]

const REPO_BLOB = 'https://github.com/earthwalker17/MiniDSH/blob/main/'
// Generated or foreign trees: `build` is desktop/build (the packed app, and
// the Node release unpacked with ITS markdown); `worktrees` holds agents'
// checkouts of this repository under .claude.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build', 'worktrees'])

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

/** A document's `##` sections outside code fences, the preamble first, with their sizes in bytes. */
function sectionsOf(markdown: string): { heading: string; bytes: number }[] {
  const sections = [{ heading: '(preamble)', bytes: 0 }]
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && line.startsWith('## ')) sections.push({ heading: line, bytes: 0 })
    sections.at(-1)!.bytes += Buffer.byteLength(line, 'utf8') + 1
  }
  return sections.filter((section) => section.bytes > 0)
}

const failures: string[] = []
const warnings: string[] = []
const SHOW_SECTIONS = process.argv.includes('--sections')

for (const [file, ceiling] of Object.entries(BUDGETS)) {
  const path = join(ROOT, file)
  if (!existsSync(path)) {
    failures.push(`${file}: missing (CLAUDE.md §5 names it as a primary document)`)
    continue
  }
  const bytes = statSync(path).size
  const pct = Math.round((bytes / ceiling) * 100)
  const sections = sectionsOf(readFileSync(path, 'utf8'))
  const largest = sections
    .toSorted((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((section) => `${section.heading.replace(/^## /, '')} ${section.bytes}`)
    .join(', ')
  if (bytes > ceiling) failures.push(`${file}: ${bytes} bytes exceeds its ${ceiling}-byte ceiling (${pct}%) — largest sections: ${largest}. Apply the docs-maintenance skill`)
  else if (bytes > ceiling * WARN_AT) warnings.push(`${file}: ${bytes} bytes is ${pct}% of its ${ceiling}-byte ceiling — largest sections: ${largest}. Compact before it grows again (docs-maintenance skill)`)
  else console.log(`${file}: ${bytes} bytes (${pct}% of ${ceiling})`)
  if (SHOW_SECTIONS) {
    console.log(`  ${file}, by section:`)
    for (const section of sections) {
      const target = file === ARCHITECTURE ? SECTION_TARGETS[sectionNumber(section.heading)] : undefined
      console.log(`  ${String(section.bytes).padStart(6)}${target === undefined ? '' : ` / ${target}`}  ${section.heading}`)
    }
  }
}

for (const [file, max] of Object.entries(LINE_BUDGETS)) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n').length
  if (lines > max) failures.push(`${file}: ${lines} lines exceeds its ${max}-line budget`)
  else console.log(`${file}: ${lines} lines (budget ${max})`)
}

/** `## 7. Authority` → 7; the preamble → 0. */
function sectionNumber(heading: string): number {
  return Number(/^## (\d+)\./.exec(heading)?.[1] ?? 0)
}

{
  const text = readFileSync(join(ROOT, ARCHITECTURE), 'utf8')
  for (const section of sectionsOf(text)) {
    const n = sectionNumber(section.heading)
    const target = SECTION_TARGETS[n]
    if (target !== undefined && section.bytes > target * SECTION_WARN) {
      warnings.push(`${ARCHITECTURE} §${n}: ${section.bytes} bytes, over its ${target}-byte target by more than ${Math.round((SECTION_WARN - 1) * 100)}% — a map line per invariant, detail at the owning code (docs-maintenance skill)`)
    }
  }
  // A paragraph or bullet is one block of consecutive prose lines; a list marker starts a new one.
  const lines = text.split('\n')
  let inFence = false
  let block: { start: number; bytes: number } | undefined
  const close = (): void => {
    if (block && block.bytes > PARAGRAPH_MAX) failures.push(`${ARCHITECTURE}:${block.start}: a ${block.bytes}-byte paragraph or bullet (max ${PARAGRAPH_MAX}) — state the rule and its owner; the detail belongs in the owning code's comment`)
    block = undefined
  }
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      close()
      inFence = !inFence
      return
    }
    if (inFence) return
    if (/^\s*\|/.test(line)) {
      close()
      if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) return
      for (const cell of line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/)) {
        const bytes = Buffer.byteLength(cell.trim(), 'utf8')
        if (bytes > CELL_MAX) failures.push(`${ARCHITECTURE}:${i + 1}: a ${bytes}-byte table cell (max ${CELL_MAX})`)
      }
      return
    }
    if (line.trim() === '' || line.startsWith('#')) return close()
    if (/^\s*([-*]|\d+\.)\s/.test(line)) close()
    if (!block) block = { start: i + 1, bytes: 0 }
    block.bytes += Buffer.byteLength(line, 'utf8') + 1
  })
  close()

  const headings = lines.filter((line) => line.startsWith('## '))
  const missing = ARCHITECTURE_HEADINGS.filter((heading) => !headings.includes(heading))
  const extra = headings.filter((heading) => !ARCHITECTURE_HEADINGS.includes(heading))
  for (const heading of missing) failures.push(`${ARCHITECTURE}: heading "${heading}" is missing — code and other documents cite it by number and title`)
  for (const heading of extra) failures.push(`${ARCHITECTURE}: unexpected heading "${heading}" — a new section is a new citation target; add it to ARCHITECTURE_HEADINGS deliberately`)
  if (missing.length === 0 && extra.length === 0 && headings.join('\n') !== ARCHITECTURE_HEADINGS.join('\n')) failures.push(`${ARCHITECTURE}: the fourteen headings are out of order`)
}

if (!existsSync(join(ROOT, REFERENCES_DIR))) failures.push(`${REFERENCES_DIR}/: missing (CLAUDE.md §4 names it as the DSH reference map)`)
else {
  let total = 0
  for (const path of walk(join(ROOT, REFERENCES_DIR))) {
    if (!path.endsWith('.md')) continue
    const bytes = statSync(path).size
    total += bytes
    const rel = relative(ROOT, path).replace(/\\/g, '/')
    const ceiling = REFERENCE_FILE_OVERRIDES[rel] ?? REFERENCE_FILE_CEILING
    if (bytes > ceiling) failures.push(`${rel}: ${bytes} bytes exceeds its ${ceiling}-byte ceiling — curate it, a map is not a copy (docs-maintenance skill)`)
    if (SHOW_SECTIONS) console.log(`  ${String(bytes).padStart(6)} / ${ceiling}  ${rel}`)
  }
  if (total > REFERENCES_TOTAL_CEILING) failures.push(`${REFERENCES_DIR}/: ${total} bytes exceeds its ${REFERENCES_TOTAL_CEILING}-byte ceiling`)
  else console.log(`${REFERENCES_DIR}/: ${total} bytes (${Math.round((total / REFERENCES_TOTAL_CEILING) * 100)}% of ${REFERENCES_TOTAL_CEILING})`)
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

/**
 * Rule 6. The reader documents. Not session context (CLAUDE.md §5): a visitor,
 * a user or someone reading the code opens them, so each has a ceiling that
 * keeps it something a person finishes, and the README keeps its eleven
 * sections, by name and in order.
 */
const READER_BUDGETS: Record<string, number> = {
  'docs/GUIDE.md': 18 * 1024,
  'docs/CASE-STUDY.md': 10 * 1024,
  'src/README.md': 8 * 1024,
  'src/kernel/README.md': 4 * 1024,
  'src/core/README.md': 7 * 1024,
  'src/capabilities/README.md': 7 * 1024,
  'src/app/README.md': 6 * 1024,
  'src/capabilities/protocol/README.md': 5 * 1024,
  'desktop/README.md': 4 * 1024,
  'skills/README.md': 5 * 1024,
  'CONTRIBUTING.md': 7 * 1024,
}
for (const [file, ceiling] of Object.entries(READER_BUDGETS)) {
  const path = join(ROOT, file)
  if (!existsSync(path)) {
    failures.push(`${file}: missing (a reader document other documents link to)`)
    continue
  }
  const bytes = statSync(path).size
  if (bytes > ceiling) failures.push(`${file}: ${bytes} bytes exceeds its ${ceiling}-byte ceiling: move the detail to the document that owns it`)
  else console.log(`${file}: ${bytes} bytes (${Math.round((bytes / ceiling) * 100)}% of ${ceiling})`)
}

const README_HEADINGS = [
  '## What MiniDSH is',
  '## Quick start',
  '## What you get',
  '## Status and limitations',
  '## The question it investigates',
  '## Architecture',
  '## What MiniDSH learned from DeepSeek Harness',
  '## The architecture-first experiment',
  '## Verification',
  '## Documents and help',
  '## License and attribution',
]
{
  const headings = sectionsOf(readFileSync(join(ROOT, 'README.md'), 'utf8'))
    .map((section) => section.heading)
    .filter((heading) => heading.startsWith('## '))
  if (headings.join('\n') !== README_HEADINGS.join('\n')) failures.push(`README.md: its eleven sections changed (CLAUDE.md §5 fixes them by name and order). Found: ${headings.join(' | ')}`)
}

/**
 * Rule 7. A layer README is a way INTO its layer, so it names every module of
 * it: a directory added without a line there is a module a reader is never
 * pointed at. Names only; what the README says about each is a person's to judge.
 */
const LAYER_READMES: Record<string, 'dirs' | 'files'> = { 'src/kernel': 'files', 'src/core': 'dirs', 'src/capabilities': 'dirs', 'src/app': 'dirs' }
for (const [layer, kind] of Object.entries(LAYER_READMES)) {
  const readme = join(ROOT, layer, 'README.md')
  if (!existsSync(readme)) continue // reported above
  const text = readFileSync(readme, 'utf8')
  const entries = readdirSync(join(ROOT, layer), { withFileTypes: true })
  const names =
    kind === 'dirs'
      ? entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')).map((entry) => entry.name)
  // Whole names in a code span: `tool-shell`, `tool-shell/`, `bus.ts`.
  const missing = names.filter((name) => !new RegExp('`' + name.replace(/[.]/g, '\\.') + '/?`').test(text))
  if (missing.length > 0) failures.push(`${layer}/README.md: does not name ${missing.map((name) => `\`${name}\``).join(', ')}: every ${kind === 'dirs' ? 'directory' : 'source file'} of the layer has a line there`)
}

/**
 * Rule 8. What a person is told to type exists. In the README and the guide,
 * every `--flag` on a line or in a code span that names `minidsh`, and every
 * word that follows `minidsh` as a command, is looked up in the CLI's own
 * tables (`FLAGS` and `COMMANDS` in `src/app/cli.ts`), read as text so this
 * script needs no runtime.
 */
{
  const cli = readFileSync(join(ROOT, 'src/app/cli.ts'), 'utf8')
  const block = (name: string): string => {
    const start = cli.indexOf(`const ${name}`)
    if (start === -1) throw new Error(`check-docs: src/app/cli.ts has no ${name} table to read`)
    return cli.slice(start, cli.indexOf('\n}', start))
  }
  const flags = new Set([...block('FLAGS').matchAll(/'(--[a-z][a-z-]*)/g)].map((match) => match[1]!))
  for (const always of ['--help', '--version']) flags.add(always)
  const commands = new Set([...block('COMMANDS').matchAll(/^\s{2}([a-z][a-z-]*): \{/gm)].map((match) => match[1]!))
  for (const always of ['help', 'version']) commands.add(always)
  if (flags.size < 10 || commands.size < 8) failures.push(`check-docs: read only ${flags.size} flags and ${commands.size} commands from src/app/cli.ts; its tables changed shape`)
  for (const file of ['README.md', 'docs/GUIDE.md']) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    const lines = readFileSync(path, 'utf8').split('\n')
    let inFence = false
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return
      }
      // In a fence the whole line is a command; in prose, each code span is.
      const spans = inFence ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)
      for (const span of spans) {
        const ours = /(^|[\s;&|(])minidsh(\s|$)/.test(span)
        for (const match of span.matchAll(/(^|[\s;&|(])minidsh\s+([a-z][a-z-]*)(?=\s|$)/g)) {
          if (!commands.has(match[2]!)) failures.push(`${file}:${i + 1}: \`minidsh ${match[2]}\` is not a command (src/app/cli.ts COMMANDS)`)
        }
        // A bare flag in prose (`--approve`) is ours too; inside a fence only on a minidsh line.
        if (!ours && (inFence || !/^--[a-z]/.test(span.trim()))) continue
        for (const match of span.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) {
          if (!flags.has(match[1]!)) failures.push(`${file}:${i + 1}: \`${match[1]}\` is not a flag of minidsh (src/app/cli.ts FLAGS)`)
        }
      }
    })
  }
}

/**
 * Rule 9. Pictures and downloads. An `<img src>` is a link like any other
 * (rule 2 reads only Markdown's own syntax); a picture under `docs/images/`
 * that nothing shows is a file nobody will ever retake; and a download link
 * names an asset the release workflow actually uploads
 * (`desktop/release-assets.json`, the tarball, the checksum file).
 */
{
  const shown = new Set<string>()
  for (const file of walk(ROOT)) {
    if (!file.endsWith('.md')) continue
    const text = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const sources = [...text.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/g)].map((match) => match[1]!)
    const markdown = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((match) => match[1]!)
    for (const source of sources) {
      if (/^[a-z]+:/i.test(source)) continue
      if (!existsSync(resolve(dirname(file), decodeURIComponent(source)))) failures.push(`${rel}: image does not exist: ${source}`)
    }
    for (const source of [...sources, ...markdown]) {
      if (/^[a-z]+:/i.test(source)) continue
      shown.add(relative(ROOT, resolve(dirname(file), decodeURIComponent(source))).replace(/\\/g, '/'))
    }
    // A plain mention counts as shown too: docs/images/README.md lists what each file is.
    for (const match of text.matchAll(/docs\/images\/[\w./-]+\.(?:png|svg|jpg|webp)/g)) shown.add(match[0])
    for (const match of text.matchAll(/`([\w./-]+\.(?:png|svg|jpg|webp))`/g)) shown.add(relative(ROOT, resolve(dirname(file), match[1]!)).replace(/\\/g, '/'))
  }
  const images = join(ROOT, 'docs', 'images')
  const pictures = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? pictures(join(dir, entry.name)) : /\.(png|svg|jpg|webp)$/.test(entry.name) ? [join(dir, entry.name)] : []))
  for (const picture of pictures(images)) {
    const rel = relative(ROOT, picture).replace(/\\/g, '/')
    if (!shown.has(rel)) failures.push(`${rel}: no document shows or lists this picture (docs/images/README.md says what each one is)`)
  }

  const assets = JSON.parse(readFileSync(join(ROOT, 'desktop', 'release-assets.json'), 'utf8')) as { installers: Record<string, string> }
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
  const uploaded = new Set([...Object.values(assets.installers), 'SHA256SUMS', `minidsh-${version}.tgz`])
  let downloads = 0
  for (const file of walk(ROOT)) {
    if (!file.endsWith('.md')) continue
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    // The changelog's older entries name what older releases shipped.
    for (const match of readFileSync(file, 'utf8').matchAll(/earthwalker17\/MiniDSH\/releases\/(latest\/download|download\/v([\d.]+))\/([\w.-]+)/g)) {
      if (match[2] !== undefined && match[2] !== version) continue
      downloads++
      if (!uploaded.has(match[3]!)) failures.push(`${rel}: download link names ${match[3]}, which the release does not upload (desktop/release-assets.json)`)
    }
  }
  console.log(`checked ${shown.size} pictures shown and ${downloads} download links`)
}

for (const warning of warnings) console.warn(`WARN ${warning}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log('docs ok')
