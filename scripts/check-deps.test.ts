import { describe, expect, it } from 'vitest'
import { collectImports, findCycle } from './deps-graph.ts'

describe('the source-shape gate', () => {
  it('reads every relative import form and tells a type-only statement from a value one', () => {
    const source = [
      `import { a, type B } from './value.ts'`,
      `import type { C } from './typed.ts'`,
      // Inline type specifiers are NOT erased under verbatimModuleSyntax: Node
      // keeps `import {} from './all-typed.ts'` and evaluates the module.
      `import { type D, type E } from './all-typed.ts'`,
      `import Dflt, { type F } from './default-and-typed.ts'`,
      `export { f } from './re-export.ts'`,
      `export type { G } from './typed-re-export.ts'`,
      `import {`,
      `  multi,`,
      `  line,`,
      `} from './multi-line.ts'`,
      `import './side-effect.ts'`,
      `const lazy = await import('./dynamic.ts')`,
      `type Lazy = import('./type-position.ts').Thing`,
      `import zod from 'zod'`,
    ].join('\n')
    expect(collectImports(source)).toEqual([
      { spec: './value.ts', typeOnly: false },
      { spec: './typed.ts', typeOnly: true },
      { spec: './all-typed.ts', typeOnly: false },
      { spec: './default-and-typed.ts', typeOnly: false },
      { spec: './re-export.ts', typeOnly: false },
      { spec: './typed-re-export.ts', typeOnly: true },
      { spec: './multi-line.ts', typeOnly: false },
      { spec: './side-effect.ts', typeOnly: false },
      { spec: './dynamic.ts', typeOnly: false },
    ])
  })

  it('never lets an earlier `export type` line swallow the import statement after it', () => {
    const source = [`export type Mode = 'a' | 'b'`, `import { bar } from './bar.ts'`, `export interface Foo { a: number }`, `import type { Baz } from './baz.ts'`].join('\n')
    expect(collectImports(source)).toEqual([
      { spec: './bar.ts', typeOnly: false },
      { spec: './baz.ts', typeOnly: true },
    ])
  })

  it('finds a cycle and names the path that closes it', () => {
    const graph = new Map<string, Set<string>>([
      ['core/a.ts', new Set(['core/b.ts'])],
      ['core/b.ts', new Set(['core/c.ts'])],
      ['core/c.ts', new Set(['core/a.ts'])],
      ['core/d.ts', new Set(['core/a.ts'])],
    ])
    expect(findCycle(graph)).toEqual(['core/a.ts', 'core/b.ts', 'core/c.ts', 'core/a.ts'])
  })

  it('accepts a graph whose only loops are at package level', () => {
    // agent/index -> sandbox/events and sandbox/index -> agent/events: two
    // packages that depend on each other, no FILE that does.
    const graph = new Map<string, Set<string>>([
      ['core/agent/index.ts', new Set(['core/agent/events.ts', 'core/sandbox/events.ts'])],
      ['core/agent/events.ts', new Set(['core/session/types.ts'])],
      ['core/sandbox/index.ts', new Set(['core/sandbox/events.ts', 'core/agent/events.ts', 'core/agent/index.ts'])],
      ['core/sandbox/events.ts', new Set(['core/session/types.ts'])],
      ['core/session/types.ts', new Set()],
    ])
    expect(findCycle(graph)).toBeUndefined()
  })
})
