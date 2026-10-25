/**
 * The pure half of the source-shape gate: import extraction, the three rules
 * and cycle detection, over an in-memory tree. `check-deps.ts` walks the disk
 * and hands the tree to `checkTree`; this module has no filesystem access, so
 * every rule is tested against synthetic trees (`check-deps.test.ts`) — the
 * S20.5 review found all three could miss a violation while only extraction
 * and cycle-finding were ever tested.
 */
import { posix } from 'node:path'

export interface ImportRef {
  readonly spec: string
  /**
   * Erased at runtime, so not an edge. Under `verbatimModuleSyntax` — which is
   * what Node's native type stripping implements — ONLY `import type …` and
   * `export type …` statements are dropped whole. A brace list of inline
   * `type` specifiers (`import { type A } from './x'`) is kept as
   * `import {} from './x'`, and `./x` is still evaluated: that is a value edge.
   */
  readonly typeOnly: boolean
}

/**
 * One import/export statement's clause, which may span lines inside its
 * braces but never runs into the next statement: the tempered `(?!…)` stops
 * the lazy scan at a line that begins another `import`/`export`.
 */
const STATEMENT = /(?:^|\n)[ \t]*(import|export)\s+((?:(?!\n[ \t]*(?:import|export)\s)[^'"])*?)from\s*['"](\.[^'"]+)['"]/g

/**
 * Every relative import a source file makes: `import … from './x'`,
 * `export … from './x'`, `import './x'`, and `import('./x')` in expression
 * position. `import('./x').T` is a type position (a member access on the
 * namespace type), erased at runtime, and is not counted.
 */
export function collectImports(source: string): ImportRef[] {
  const refs: ImportRef[] = []
  for (const match of source.matchAll(STATEMENT)) {
    // `import type{ A }` is as erased as `import type { A }`.
    refs.push({ spec: match[3]!, typeOnly: /^type(?=[\s{*])/.test(match[2]!.trimStart()) })
  }
  for (const match of source.matchAll(/import\s+['"](\.[^'"]+)['"]/g)) refs.push({ spec: match[1]!, typeOnly: false })
  for (const match of source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)(?!\s*\.)/g)) refs.push({ spec: match[1]!, typeOnly: false })
  return refs
}

/**
 * The first cycle in a directed graph, as the path that closes it (`a → b → a`),
 * or `undefined` when the graph is acyclic. Depth-first with a colour set, so a
 * graph of a few hundred files is checked in one pass.
 */
export function findCycle(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): string[] | undefined => {
    state.set(node, 'open')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      const seen = state.get(next)
      if (seen === 'done') continue
      if (seen === 'open') return [...stack.slice(stack.indexOf(next)), next]
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    state.set(node, 'done')
    return undefined
  }
  for (const node of [...graph.keys()].toSorted()) {
    if (state.get(node) === undefined) {
      const found = visit(node)
      if (found) return found
    }
  }
  return undefined
}

// ---- the rules ----------------------------------------------------------------

export type Layer = 'kernel' | 'core' | 'capabilities' | 'app' | 'test-support' | 'other' | 'outside'

/** A path relative to `src/`, posix; one that climbs out of `src/` is `outside`. */
export function layerOf(relPath: string): Layer {
  if (relPath.startsWith('..')) return 'outside'
  const top = relPath.split('/')[0]
  if (top === 'kernel' || top === 'core' || top === 'capabilities' || top === 'app' || top === 'test-support') return top
  return 'other'
}

const capabilityOf = (relPath: string): string | undefined => {
  const parts = relPath.split('/')
  return parts[0] === 'capabilities' ? parts[1] : undefined
}

const inLoop = (relPath: string): boolean => relPath.startsWith('core/loop/')

/**
 * Rule 1, as a WHITELIST per layer, mirroring ARCHITECTURE §1's table: what a
 * layer MAY import, so a target nobody thought to forbid is refused too. It
 * used to be a blacklist, and a capability importing `test-support` passed —
 * test code a shipped capability would carry into dist/, which
 * tsconfig.build's `exclude` cannot stop for an imported file.
 *
 * `undefined` means allowed; otherwise the reason.
 */
export function directionViolation(importer: string, target: string): string | undefined {
  const from = layerOf(importer)
  const to = layerOf(target)
  if (from === 'kernel') return to === 'kernel' ? undefined : 'kernel may import nothing internal'
  if (from === 'core') {
    if (to !== 'kernel' && to !== 'core') return 'core may import only kernel and core'
    if (inLoop(target) && !inLoop(importer)) return 'core/loop is swappable; only app/test-support may import it'
    return undefined
  }
  if (from === 'capabilities') {
    if (to === 'kernel') return undefined
    if (to === 'core') return inLoop(target) ? 'core/loop is swappable; only app/test-support may import it' : undefined
    if (to === 'capabilities') return capabilityOf(importer) === capabilityOf(target) ? undefined : 'capabilities must not import other capabilities'
    if (to === 'app') return 'capabilities must not import app'
    if (to === 'test-support') return 'capabilities must not import test-support'
    return 'capabilities may import only kernel, core and their own directory'
  }
  // app, test-support and the rest import anything (§1).
  return undefined
}

/**
 * Every `import(...)` whose argument is not one plain string literal: a
 * template literal or an expression. Its target cannot be resolved, so no rule
 * can see the edge — not the direction, and not a core cycle. In core and the
 * capabilities that makes it a violation in itself.
 */
export function unresolvableImports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\bimport\s*\(\s*(?!['"][^'"\n]*['"]\s*[,)])([^)\n]{0,60})/g)) found.push(`import(${match[1]!.trim()}`)
  return found
}

/**
 * Rule 2: a payload read through a type assertion instead of `matches(event,
 * KIND)`. Widened at S20.5 past `.data as T` to the forms that slipped by:
 * `.data as unknown as T` (a cast laundered through unknown), `(event.data) as
 * T`, a cast broken across lines, `event['data'] as T` and `<T>event.data`.
 * `as unknown` ending an expression stays legal — it is the honest read of a
 * possibly-forged payload. A destructured `data as T` is NOT caught: the name
 * alone cannot tell a payload from any other local called `data`.
 */
const PAYLOAD_CASTS: readonly RegExp[] = [
  /(?:\.data\b|\[\s*['"]data['"]\s*\])\s*\)?\s*as\s+(?!unknown\s*(?:[;,)\]}]|$))/m,
  /(?<![\w$])<[A-Z][\w.]*(?:<[^<>]*>)?>\s*\(?\s*[\w$.]+(?:\.data\b|\[\s*['"]data['"]\s*\])/,
]

export function readsPayloadByCast(source: string): boolean {
  return PAYLOAD_CASTS.some((pattern) => pattern.test(source))
}

export interface TreeReport {
  readonly violations: string[]
  /** How many core files the acyclicity rule saw. */
  readonly coreFiles: number
}

/**
 * All three rules over a tree: `files` maps each source file's path relative
 * to `src/` (posix) to its text. Test files are the caller's to leave out —
 * they mount real compositions across layers.
 */
export function checkTree(files: ReadonlyMap<string, string>): TreeReport {
  const violations: string[] = []
  /** File-level value-import graph over `core`, for the acyclicity rule. */
  const coreGraph = new Map<string, Set<string>>()
  for (const [file, source] of files) {
    const importer = layerOf(file)
    const fail = (why: string): void => void violations.push(`${file}: ${why}`)
    if (importer === 'core') coreGraph.set(file, new Set())
    const seen = new Set<string>()
    for (const ref of collectImports(source)) {
      const target = posix.normalize(posix.join(posix.dirname(file), ref.spec))
      if (importer === 'core' && layerOf(target) === 'core' && !ref.typeOnly && target !== file) coreGraph.get(file)!.add(target)
      if (seen.has(ref.spec)) continue
      seen.add(ref.spec)
      const why = directionViolation(file, target)
      if (why !== undefined) fail(`-> ${ref.spec}: ${why}`)
    }
    if (importer === 'kernel' || importer === 'core' || importer === 'capabilities') {
      for (const expression of unresolvableImports(source)) fail(`${expression}: a dynamic import that is not a string literal hides its target from every rule`)
    }
    if (importer !== 'test-support' && readsPayloadByCast(source)) {
      fail('reads an event payload through a type assertion; narrow with matches(event, KIND) so a renamed field is a type error')
    }
  }
  const cycle = findCycle(coreGraph)
  if (cycle) violations.push(`core is not acyclic at file level: ${cycle.join(' -> ')} (move the shared vocabulary below the service, into an events.ts/types.ts)`)
  return { violations, coreFiles: coreGraph.size }
}
