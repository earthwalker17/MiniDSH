import { describe, expect, it } from 'vitest'
import { checkTree, collectImports, directionViolation, findCycle, readsPayloadByCast, unresolvableImports } from './deps-graph.ts'

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

  it('reads `import type{ A }` as erased, like `import type { A }`', () => {
    expect(collectImports(`import type{ A } from './a.ts'`)).toEqual([{ spec: './a.ts', typeOnly: true }])
  })
})

/** A tree of one importer per case; each file imports what its case names. */
const tree = (files: Record<string, string>): Map<string, string> => new Map(Object.entries(files))

describe('the rules, over synthetic trees', () => {
  it('direction is a whitelist per layer: a capability may not import test-support, app, another capability or core/loop', () => {
    const { violations } = checkTree(
      tree({
        'capabilities/x/index.ts': [
          `import { ok } from '../../core/llm/index.ts'`,
          `import { own } from './helper.ts'`,
          `import { kernel } from '../../kernel/index.ts'`,
          `import { harness } from '../../test-support/harness.ts'`,
          `import { cli } from '../../app/cli.ts'`,
          `import { other } from '../y/index.ts'`,
          `import { loop } from '../../core/loop/index.ts'`,
          `import { escape } from '../../../scripts/build.ts'`,
        ].join('\n'),
      }),
    )
    expect(violations).toEqual([
      'capabilities/x/index.ts: -> ../../test-support/harness.ts: capabilities must not import test-support',
      'capabilities/x/index.ts: -> ../../app/cli.ts: capabilities must not import app',
      'capabilities/x/index.ts: -> ../y/index.ts: capabilities must not import other capabilities',
      'capabilities/x/index.ts: -> ../../core/loop/index.ts: core/loop is swappable; only app/test-support may import it',
      'capabilities/x/index.ts: -> ../../../scripts/build.ts: capabilities may import only kernel, core and their own directory',
    ])
    expect(directionViolation('core/a/index.ts', 'test-support/harness.ts')).toBe('core may import only kernel and core')
    expect(directionViolation('kernel/index.ts', 'core/x.ts')).toBe('kernel may import nothing internal')
    expect(directionViolation('core/loop/driver.ts', 'core/loop/types.ts')).toBeUndefined()
    expect(directionViolation('app/cli.ts', 'test-support/harness.ts')).toBeUndefined()
    expect(directionViolation('test-support/harness.ts', 'core/loop/index.ts')).toBeUndefined()
  })

  it('refuses an import() it cannot resolve in kernel, core and capabilities, and nowhere else', () => {
    const source = ['const m = await import(`../../app/${name}.ts`)', `const n = await import(path)`, `const ok = await import('./fine.ts')`, `type T = import('./typed.ts').T`].join('\n')
    expect(unresolvableImports(source)).toEqual(['import(`../../app/${name}.ts`', 'import(path'])
    const { violations } = checkTree(tree({ 'core/a.ts': source, 'capabilities/x/index.ts': source, 'app/b.ts': source }))
    expect(violations.filter((line) => line.includes('hides its target'))).toHaveLength(4)
    expect(violations.some((line) => line.startsWith('app/'))).toBe(false)
  })

  it('sees a core cycle closed by an inline-type import, and none closed by `import type`', () => {
    const cyclic = checkTree(tree({ 'core/a.ts': `import { type B } from './b.ts'`, 'core/b.ts': `import { a } from './a.ts'` }))
    expect(cyclic.violations.at(-1)).toMatch(/core is not acyclic at file level: core\/a\.ts -> core\/b\.ts -> core\/a\.ts/)
    const erased = checkTree(tree({ 'core/a.ts': `import type { B } from './b.ts'`, 'core/b.ts': `import { a } from './a.ts'` }))
    expect(erased.violations).toEqual([])
  })

  it('catches every payload cast form that once slipped by, and leaves the honest reads alone', () => {
    for (const cast of [
      'const x = event.data as { a: string }',
      'const x = event.data as unknown as { a: string }',
      'const x = (event.data) as Foo',
      'const x = event.data\n  as Foo',
      "const x = event['data'] as Foo",
      'const x = <Foo>event.data',
    ]) {
      expect(readsPayloadByCast(cast), cast).toBe(true)
    }
    for (const honest of ['const x = event.data as unknown', 'f(event.data as unknown, 1)', 'const y = parse<Foo>(event.data)', 'if (matches(event, KIND)) use(event.data)']) {
      expect(readsPayloadByCast(honest), honest).toBe(false)
    }
    const { violations } = checkTree(tree({ 'capabilities/x/index.ts': 'const x = (event.data) as Foo', 'test-support/y.ts': 'const x = event.data as Foo' }))
    expect(violations).toEqual(['capabilities/x/index.ts: reads an event payload through a type assertion; narrow with matches(event, KIND) so a renamed field is a type error'])
  })
})
