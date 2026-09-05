/**
 * The pure half of the source-shape gate: import extraction and cycle
 * detection over a file graph. `check-deps.ts` walks the tree and applies the
 * rules; this module has no filesystem access so the rules can be tested
 * against synthetic graphs.
 */

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
    refs.push({ spec: match[3]!, typeOnly: match[2]!.trimStart().startsWith('type ') })
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
