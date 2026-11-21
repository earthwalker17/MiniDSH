/**
 * The invariant registry itself: which installers a composition's row selects,
 * who may register one, and what a cold whole-log check reports. What each
 * invariant REFUSES is tested beside its owner (`core/session`, `core/sandbox`,
 * `core/jobs`, `core/agent`, `core/loop`).
 */
import { describe, expect, it } from 'vitest'
import { createRoot, emitEvent, KernelError, type Context, type Logger } from '../../kernel/index.ts'
import { firstViolation, InvariantError, INVARIANTS, invariantsPlugin, type InvariantsConfig } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const PING = emitEvent<[value: number]>('test/invariant-ping')

async function mounted(config?: InvariantsConfig): Promise<Context> {
  const root = createRoot({ logger: silent })
  root.plugin(invariantsPlugin, config)
  expect((await root.settle()).failed).toEqual([])
  return root
}

/** Registers one installer per name and answers which of them the row let run. */
function installed(root: Context, names: readonly string[]): string[] {
  const ran: string[] = []
  for (const name of names) root.get(INVARIANTS).register(root, name, () => void ran.push(name))
  return ran
}

describe('invariant selection', () => {
  const names = ['core-session', 'core-authority', 'core-jobs']

  it('runs every registered invariant by default, and none when the row switches them off', async () => {
    const on = await mounted()
    expect(installed(on, names)).toEqual(names)
    await on.dispose()
    const off = await mounted({ enabled: false })
    expect(installed(off, names)).toEqual([])
    await off.dispose()
  })

  it('runs only the allowed names when the allow list is not empty, and never a blocked one', async () => {
    const cases: [config: InvariantsConfig, expected: string[]][] = [
      [{ allow: ['core-authority'] }, ['core-authority']],
      // An empty allow list is no list: everything runs.
      [{ allow: [] }, names],
      [{ block: ['core-authority'] }, ['core-session', 'core-jobs']],
      // Block outranks allow.
      [{ allow: ['core-session', 'core-jobs'], block: ['core-jobs'] }, ['core-session']],
    ]
    const outcomes: string[][] = []
    for (const [config] of cases) {
      const root = await mounted(config)
      outcomes.push(installed(root, names))
      await root.dispose()
    }
    expect(outcomes).toEqual(cases.map(([, expected]) => expected))
  })

  it('refuses a row with a key it does not know, by name', async () => {
    const root = createRoot({ logger: silent })
    root.plugin(invariantsPlugin, { enabld: false } as never)
    const report = await root.settle()
    expect(report.failed.map((entry) => (entry.error instanceof Error ? entry.error.message : String(entry.error)))).toEqual([expect.stringMatching(/plugin "core-invariants": invalid config: .*enabld/)])
    await root.dispose()
  })
})

describe('invariant registration', () => {
  it('holds a name to one registration at a time, selected or not, and frees it with the disposer', async () => {
    const root = await mounted({ block: ['blocked'] })
    const registry = root.get(INVARIANTS)
    for (const name of ['selected', 'blocked']) {
      const release = registry.register(root, name, () => {})
      expect(() => registry.register(root, name, () => {}), name).toThrowError(`invariant "${name}" is already registered`)
      await release()
      expect(() => registry.register(root, name, () => {}), name).not.toThrow()
    }
    for (const name of ['', ' padded', 'padded ']) expect(() => registry.register(root, name, () => {}), JSON.stringify(name)).toThrowError(/invalid invariant package name/)
    await root.dispose()
  })

  // An invariant observes the whole root: registered from an agent's scope it
  // would police every agent and die with one of them.
  it('refuses a scoped owner, and leaves the name free and the installer unrun', async () => {
    const root = await mounted()
    const registry = root.get(INVARIANTS)
    const scope = root.child({ scope: { agent: 'a' } })
    let ran = 0
    let refused: unknown
    try {
      registry.register(scope, 'scoped', () => void ran++)
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(KernelError)
    expect({ code: (refused as KernelError).code, ran }).toEqual({ code: 'SCOPED_OWNER', ran: 0 })
    expect(() => registry.register(root, 'scoped', () => {})).not.toThrow()
    await root.dispose()
  })

  // The name was reserved before the kernel admitted the owner: a plugin
  // registering while it unloads was refused and still held the name, so the
  // reload that followed met "already registered" with no disposer to call.
  it('refuses an owner that is no longer live, and leaves the name free and the installer unrun', async () => {
    const root = await mounted()
    const registry = root.get(INVARIANTS)
    const gone = root.child({ label: 'gone' })
    await gone.dispose()
    let ran = 0
    let refused: unknown
    try {
      registry.register(gone, 'reloaded', () => void ran++)
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(KernelError)
    expect({ code: (refused as KernelError).code, ran }).toEqual({ code: 'INACTIVE_OWNER', ran: 0 })
    let reran = 0
    expect(() => registry.register(root, 'reloaded', () => void reran++)).not.toThrow()
    expect(reran).toBe(1)
    await root.dispose()
  })

  it('gives an installer a context that observes the root pre-commit, a failure that names its package, and a lifetime its disposer ends', async () => {
    const root = await mounted()
    const heard: number[] = []
    root.on(PING, (value) => void heard.push(value))
    const release = root.get(INVARIANTS).register(root, 'no-thirteen', (ctx, fail) => {
      ctx.observe((info) => {
        if (info.name === PING.name && info.args[0] === 13) fail('thirteen is not allowed')
      })
    })
    root.emit(PING, 1)
    let thrown: unknown
    try {
      root.emit(PING, 13)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvariantError)
    expect({ code: (thrown as InvariantError).code, packageName: (thrown as InvariantError).packageName, message: (thrown as InvariantError).message }).toEqual({
      code: 'INVARIANT',
      packageName: 'no-thirteen',
      message: 'invariant violated by "no-thirteen": thirteen is not allowed',
    })
    // Refused before delivery: no listener heard it.
    expect(heard).toEqual([1])
    await release()
    root.emit(PING, 13)
    expect(heard).toEqual([1, 13])
    await root.dispose()
  })
})

describe('firstViolation', () => {
  const events = [{ seq: 4 }, { seq: 5 }, { seq: 6 }, { seq: 7 }]

  it('reports the first broken rule at its seq and stops there', () => {
    const visited: number[] = []
    const violation = firstViolation(events, (index, fail) => {
      visited.push(index)
      if (index >= 1) fail(`rule broken at index ${index}`)
    })
    expect(violation).toEqual({ seq: 5, message: 'rule broken at index 1' })
    expect(visited).toEqual([0, 1])
  })

  it('reports a step that could not read its payload as malformed, not as a broken rule', () => {
    const violation = firstViolation(events, (index) => {
      if (index === 2) (undefined as unknown as { turn: number }).turn.toFixed()
    })
    expect(violation).toMatchObject({ seq: 6, malformed: true })
    expect(violation?.message).toMatch(/^malformed payload: /)
  })

  it('answers nothing for a log every step accepts, and for an empty one', () => {
    expect(firstViolation(events, () => {})).toBeUndefined()
    expect(firstViolation([], (_index, fail) => fail('never reached'))).toBeUndefined()
  })
})
