/**
 * Source-shape gates. Three rules, one script:
 *
 * 1. Dependency direction, from docs/ARCHITECTURE.md §1, as a whitelist per
 *    layer: kernel imports only kernel; core imports kernel + core (but
 *    nothing but app/test-support imports core/loop); a capability imports
 *    kernel, core and its own directory — never another capability, app or
 *    test-support; app and test-support import anything. Static, dynamic
 *    (`import('…')`), side-effect and inline-type imports all count, and in
 *    kernel, core and capabilities an `import()` whose target is not a string
 *    literal is a violation in itself: no rule can see where it goes.
 *
 * 2. Payload discipline: outside tests and test-support, an event payload is
 *    read through `matches(event, KIND)`, never a type assertion on `.data`.
 *    A cast hides a renamed field from the type checker; the S5.5 audit found
 *    the terminal printing `~NaNk` for exactly that reason.
 *
 * 3. Core is acyclic at FILE level. Core packages depend on each other freely
 *    at package level (agent ↔ sandbox, session ↔ llm, …); what keeps that
 *    sound is that each package's vocabulary (`events.ts`, `types.ts`) sits
 *    below its service, so no FILE's value imports ever close a loop. That was
 *    a convention until S8.5; this rule pins it. Only `import type` /
 *    `export type` statements and `import('./x').T` type positions are
 *    erased and do not count — an inline `{ type A }` specifier keeps the
 *    import and evaluates the module under Node's type stripping.
 *
 * Test files are exempt (they mount real compositions across layers). The
 * rules themselves live in `deps-graph.ts`, pure, and are tested there.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { checkTree } from './deps-graph.ts'

const SRC = resolve(import.meta.dirname, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = new Map<string, string>()
for (const file of walk(SRC)) files.set(relative(SRC, file).replace(/\\/g, '/'), readFileSync(file, 'utf8'))
const { violations, coreFiles } = checkTree(files)
if (violations.length > 0) {
  process.stderr.write(`source-shape violations:\n${violations.map((v) => `  ${v}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`check-deps: dependency direction, payload discipline and core acyclicity OK (${coreFiles} core files)\n`)
