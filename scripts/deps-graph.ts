/**
 * The pure half of the source-shape gate: import extraction and cycle
 * detection over a file graph. `check-deps.ts` walks the tree and applies the
 * rules; this module has no filesystem access so the rules can be tested
 * against synthetic graphs.
 */

export interface ImportRef {
  readonly spec: string
  /** `import type …` / `export type …` / a brace list whose every entry is `type X`: erased at runtime, so not a cycle. */
  readonly typeOnly: boolean
}

/**
 * Every relative import a source file makes: `import … from './x'`,
 * `export … from './x'`, `import './x'`, `import('./x')` and `import('./x').T`.
 */
export function collectImports(source: string): ImportRef[] {
  const refs: ImportRef[] = []
  for (const match of source.matchAll(/(?:^|\n)\s*(import|export)\s+([^'"]*?)from\s*['"](\.[^'"]+)['"]/g)) {
    const clause = match[2]!.trim()
    const braces = clause.match(/\{([^}]*)\}/)
    const allTyped =
      braces !== null &&
      braces[1]!
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .every((entry) => entry.startsWith('type '))
    refs.push({ spec: match[3]!, typeOnly: clause.startsWith('type ') || allTyped })
  }
  for (const match of source.matchAll(/import\s+['"](\.[^'"]+)['"]/g)) refs.push({ spec: match[1]!, typeOnly: false })
  for (const match of source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) refs.push({ spec: match[1]!, typeOnly: false })
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
