/**
 * Source-shape gates. Five rules, one script:
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
 * 4. A browser module (`src/app/web/*.js`) imports at runtime only a sibling,
 *    as `./<name>.js`: the host serves one flat directory and ships exactly
 *    `WEB_ASSETS`, so anything else works under a checkout's Node and 404s in
 *    every browser. JSDoc type imports are comments and are not counted.
 *
 * 5. The desktop package (`desktop/src`) imports only `electron`, `node:*`
 *    builtins and itself, type imports included: it reaches the runtime by
 *    spawning the bundled CLI and speaking the wire, never by importing it.
 *
 * Test files are exempt (they mount real compositions across layers). The
 * rules themselves live in `deps-graph.ts`, pure, and are tested there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { checkDesktop, checkTree } from './deps-graph.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const DESKTOP = join(ROOT, 'desktop', 'src')

/** Source files under `dir` whose name `source` matches, tests left out. */
function walk(dir: string, source: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, source))
    else if (source.test(full) && !/\.test\.[cm]?[jt]s$/.test(full)) out.push(full)
  }
  return out
}

const read = (root: string, source: RegExp): Map<string, string> => {
  const files = new Map<string, string>()
  for (const file of walk(root, source)) files.set(relative(root, file).replace(/\\/g, '/'), readFileSync(file, 'utf8'))
  return files
}

// Every `.ts`, and the browser client's `.js` modules (rule 4).
const { violations, coreFiles } = checkTree(read(SRC, /\.(ts|js)$/))
const desktopFiles = existsSync(DESKTOP) ? read(DESKTOP, /\.[cm]?[jt]s$/) : new Map<string, string>()
violations.push(...checkDesktop(desktopFiles))
if (violations.length > 0) {
  process.stderr.write(`source-shape violations:\n${violations.map((v) => `  ${v}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(
  `check-deps: dependency direction, payload discipline, core acyclicity, browser-module imports and desktop isolation OK (${coreFiles} core files, ${desktopFiles.size} desktop files)\n`,
)
