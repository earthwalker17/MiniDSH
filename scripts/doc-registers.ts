/**
 * Inputs for a delegated compaction of `docs/ARCHITECTURE.md`, and one check on
 * its result (`.claude/skills/docs-maintenance/SKILL.md` is the procedure).
 * A compaction that splits the document between agents loses claims in one
 * characteristic way: a section keeps "(§N)" while §N stops stating the thing
 * pointed at, or two sections each point at the other. These registers hand
 * every author what the rest of the repository relies on its sections for.
 *
 *   node scripts/doc-registers.ts <outdir>   writes three registers:
 *     inbound-pointers.md  per section N, the sentences elsewhere in the
 *                          document that point at §N;
 *     code-citations.md    per section N, the code, script and template
 *                          comments that cite it;
 *     outside-readers.md   every line in another document that describes
 *                          ARCHITECTURE or cites one of its sections.
 *   node scripts/doc-registers.ts --pointers  lists each "(§N)" pointer whose
 *                          sentence shares no `identifier` with §N: a
 *                          candidate moved-but-absent claim, for a person or
 *                          a reviewer to judge. A report, not a gate.
 *
 * Not part of `pnpm check`: it serves a compaction, and its heuristics are
 * deliberately loose.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DOC = 'docs/ARCHITECTURE.md'
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])
/** A `§N` preceded by one of these names another document's section. */
const FOREIGN = /(CLAUDE|BLUEPRINT|PROJECT|README|RFC)(\.md)?[`\s]*(\d+\s*)?$/

/** The document split at its `## N.` headings; the preamble is section 0. */
function sectionsOf(text: string): Map<number, string[]> {
  const sections = new Map<number, string[]>()
  let current = 0
  for (const line of text.split('\n')) {
    const heading = /^## (\d+)\./.exec(line)
    if (heading) current = Number(heading[1])
    const lines = sections.get(current) ?? []
    lines.push(line)
    sections.set(current, lines)
  }
  return sections
}

/** Every section number a line cites as this document's, with the offset of each citation. */
function citations(line: string): { n: number; at: number }[] {
  const found: { n: number; at: number }[] = []
  for (const match of line.matchAll(/§\s?(\d+)((?:\s?,\s?§?\s?\d+)*)/g)) {
    if (FOREIGN.test(line.slice(0, match.index))) continue
    for (const n of [match[1]!, ...(match[2] ?? '').split(/[,\s§]+/).filter(Boolean)]) found.push({ n: Number(n), at: match.index })
  }
  return found
}

function walk(dir: string, pattern: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, pattern))
    else if (pattern.test(entry)) out.push(full)
  }
  return out
}

const rel = (path: string): string => relative(ROOT, path).replace(/\\/g, '/')
const grouped = (title: string, intro: string, groups: Map<number, string[]>): string =>
  `# ${title}\n\n${intro}\n` +
  [...groups.keys()]
    .toSorted((a, b) => a - b)
    .map((n) => `\n## §${n} (${groups.get(n)!.length})\n\n${groups.get(n)!.map((line) => `- ${line}`).join('\n')}\n`)
    .join('')

function push(groups: Map<number, string[]>, n: number, line: string): void {
  const list = groups.get(n) ?? []
  list.push(line)
  groups.set(n, list)
}

const sections = sectionsOf(readFileSync(join(ROOT, DOC), 'utf8'))

if (process.argv.includes('--pointers')) {
  const identifiers = (text: string): string[] => [...text.matchAll(/`([^`]{3,})`/g)].map((match) => match[1]!)
  let suspects = 0
  for (const [from, lines] of sections) {
    for (const line of lines) {
      for (const { n, at } of citations(line)) {
        if (n === from || !sections.has(n)) continue
        const sentence = line.slice(Math.max(0, line.lastIndexOf('. ', at) + 1), line.indexOf('. ', at) === -1 ? undefined : line.indexOf('. ', at))
        const wanted = identifiers(sentence)
        if (wanted.length === 0) continue
        const target = sections.get(n)!.join('\n')
        if (wanted.some((id) => target.includes(id))) continue
        suspects++
        console.log(`§${from} → §${n}: none of ${wanted.map((id) => `\`${id}\``).join(', ')} appears in §${n}\n    ${sentence.trim().slice(0, 240)}`)
      }
    }
  }
  console.log(`${suspects} pointer(s) whose sentence shares no identifier with the section it cites`)
} else {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: node scripts/doc-registers.ts <outdir> | --pointers')
    process.exit(2)
  }
  mkdirSync(out, { recursive: true })

  const inbound = new Map<number, string[]>()
  for (const [from, lines] of sections) {
    for (const line of lines) {
      for (const { n, at } of citations(line)) {
        if (n !== from) push(inbound, n, `from §${from}: …${line.slice(Math.max(0, at - 220), at + 80).trim()}…`)
      }
    }
  }
  writeFileSync(join(out, 'inbound-pointers.md'), grouped('Inbound pointers', `Sentences in OTHER sections of ${DOC} that point at §N. Section N must state what each relies on, or the pointer goes.`, inbound))

  const cited = new Map<number, string[]>()
  for (const dir of ['src', 'scripts', 'bin', '.github']) {
    for (const file of walk(join(ROOT, dir), /\.(ts|js|mjs|yml|yaml|html|css|md)$/)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const { n } of citations(line)) {
          const context = lines.slice(Math.max(0, i - 2), i + 2).map((text) => text.trim()).join(' ⏎ ')
          push(cited, n, `${rel(file)}:${i + 1} — ${context.slice(0, 420)}`)
        }
      })
    }
  }
  writeFileSync(join(out, 'code-citations.md'), grouped('Code and template citations', `Comments citing a section of ${DOC} (a bare §N in \`src/\` is this document's). The section must still state what the comment relies on, or the comment must stand on its own.`, cited))

  const readers: string[] = []
  const documents = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'CLAUDE.md', 'docs/PROJECT.md', 'docs/BLUEPRINT.md', ...walk(join(ROOT, 'references'), /\.md$/).map(rel)]
  for (const document of documents) {
    readFileSync(join(ROOT, document), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/ARCH(ITECTURE)?\b/.test(line)) readers.push(`- ${document}:${i + 1} — ${line.trim().slice(0, 260)}`)
      })
  }
  writeFileSync(join(out, 'outside-readers.md'), `# Outside readers\n\nEvery line in another document that describes ${DOC} or cites a section of it.\n\n${readers.join('\n')}\n`)
  console.log(`inbound pointers into ${inbound.size} sections, citations of ${cited.size} sections, ${readers.length} outside-reader lines → ${out}`)
}
