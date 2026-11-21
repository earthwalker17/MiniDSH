import { describe, expect, it } from 'vitest'
import {
  createRoot,
  emitEvent,
  KernelError,
  parallelEvent,
  serialEvent,
  serviceKey,
  waterfallEvent,
  type Context,
  type Logger,
  type Plugin,
} from './index.ts'

interface Counter {
  value: number
}

const COUNTER = serviceKey<Counter>('counter')
const GREETER = serviceKey<{ greet(): string }>('greeter')

function testLogger(): Logger & { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  return {
    errors,
    warnings,
    warn: (message) => warnings.push(message),
    error: (message) => errors.push(message),
  }
}

function counterProvider(value = 0): Plugin {
  return {
    name: 'counter-provider',
    apply(ctx) {
      ctx.provide(COUNTER, { value })
    },
  }
}

describe('kernel: services and activation', () => {
  it('keeps a dependent pending until its injected service is active, then activates it', async () => {
    const root = createRoot({ logger: testLogger() })
    const loads: number[] = []
    const dependent: Plugin = {
      name: 'dependent',
      inject: [COUNTER],
      apply(ctx) {
        loads.push(ctx.get(COUNTER).value)
      },
    }
    const handle = root.plugin(dependent)
    let report = await root.settle()
    expect(handle.state).toBe('pending')
    expect(report.pending).toEqual([{ name: 'dependent', missing: ['counter'] }])

    root.plugin(counterProvider(7))
    report = await root.settle()
    expect(report.pending).toEqual([])
    expect(handle.state).toBe('active')
    expect(loads).toEqual([7])
  })

  it('does not expose a service while its provider is still loading', async () => {
    const root = createRoot({ logger: testLogger() })
    const gate = Promise.withResolvers<void>()
    const slowProvider: Plugin = {
      name: 'slow',
      async apply(ctx) {
        ctx.provide(COUNTER, { value: 1 })
        await gate.promise
      },
    }
    const seen: string[] = []
    const dependent: Plugin = {
      name: 'dependent',
      inject: [COUNTER],
      apply() {
        seen.push('loaded')
      },
    }
    root.plugin(slowProvider)
    const dep = root.plugin(dependent)
    await Promise.resolve()
    expect(dep.state).toBe('pending')
    expect(root.tryGet(COUNTER)).toBeUndefined()
    gate.resolve()
    await root.settle()
    expect(dep.state).toBe('active')
    expect(seen).toEqual(['loaded'])
  })

  it('enforces strict reads: no inject means no read; missing means unavailable', async () => {
    const logger = testLogger()
    const root = createRoot({ logger })
    const errors: KernelError[] = []
    const sneaky: Plugin = {
      name: 'sneaky',
      apply(ctx) {
        try {
          ctx.get(COUNTER)
        } catch (error) {
          errors.push(error as KernelError)
        }
        expect(ctx.tryGet(COUNTER)).toBeUndefined()
      },
    }
    root.plugin(sneaky)
    await root.settle()
    expect(errors.map((error) => error.code)).toEqual(['SERVICE_NOT_INJECTED'])
    expect(() => root.get(COUNTER)).toThrowError(/not available/)
  })

  it('claims a service once per realm and lets a child realm shadow it', async () => {
    const root = createRoot({ logger: testLogger() })
    root.provide(COUNTER, { value: 1 })
    expect(() => root.provide(COUNTER, { value: 2 })).toThrowError(/already provided/)
    const child = root.child({ scope: 'agent-a' })
    child.provide(COUNTER, { value: 2 })
    expect(root.get(COUNTER).value).toBe(1)
    expect(child.get(COUNTER).value).toBe(2)
    await child.dispose()
    expect(child.tryGet(COUNTER)?.value).toBe(1)
  })
})

describe('kernel: temporal composability', () => {
  it('unwinds effects in strict reverse order when a plugin is disposed', async () => {
    const root = createRoot({ logger: testLogger() })
    const order: string[] = []
    const plugin: Plugin = {
      name: 'ordered',
      apply(ctx) {
        ctx.effect(() => () => order.push('first'), 'first')
        ctx.effect(() => () => order.push('second'), 'second')
        ctx.effect(() => async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          order.push('third')
        }, 'third')
      },
    }
    const handle = root.plugin(plugin)
    await root.settle()
    expect(root.effects()).toEqual(['plugin("ordered")'])
    await handle.dispose()
    expect(order).toEqual(['third', 'second', 'first'])
    expect(handle.state).toBe('disposed')
    expect(root.effects()).toEqual([])
  })

  it('unloads a dependent when its dependency disappears and reloads when it returns', async () => {
    const root = createRoot({ logger: testLogger() })
    const log: string[] = []
    const dependent: Plugin = {
      name: 'dependent',
      inject: [COUNTER],
      apply(ctx) {
        log.push(`load:${ctx.get(COUNTER).value}`)
        ctx.effect(() => () => log.push('unload'))
      },
    }
    const dep = root.plugin(dependent)
    const provider = root.plugin(counterProvider(1))
    await root.settle()
    expect(dep.state).toBe('active')

    await provider.dispose()
    await root.settle()
    expect(dep.state).toBe('pending')
    expect(log).toEqual(['load:1', 'unload'])

    root.plugin(counterProvider(2))
    await root.settle()
    expect(dep.state).toBe('active')
    expect(log).toEqual(['load:1', 'unload', 'load:2'])
  })

  it('reloads a dependent when its provider is swapped for another instance', async () => {
    const root = createRoot({ logger: testLogger() })
    const seen: number[] = []
    const dependent: Plugin = {
      name: 'dependent',
      inject: [COUNTER],
      apply(ctx) {
        seen.push(ctx.get(COUNTER).value)
      },
    }
    const first = root.plugin(counterProvider(1))
    root.plugin(dependent)
    await root.settle()
    const swap = first.dispose().then(() => root.plugin(counterProvider(2)))
    await swap
    await root.settle()
    expect(seen).toEqual([1, 2])
  })

  it('marks a plugin failed when apply throws, unwinds its partial effects, and reports it', async () => {
    const logger = testLogger()
    const root = createRoot({ logger })
    const unwound: string[] = []
    const broken: Plugin = {
      name: 'broken',
      apply(ctx) {
        ctx.effect(() => () => unwound.push('partial'))
        throw new Error('boom')
      },
    }
    const handle = root.plugin(broken)
    const report = await root.settle()
    expect(handle.state).toBe('failed')
    expect(unwound).toEqual(['partial'])
    expect(report.failed.map((entry) => entry.name)).toEqual(['broken'])
    await expect(handle.settled()).rejects.toThrowError(/failed to load/)
    expect(logger.errors.some((message) => message.includes('failed to load'))).toBe(true)
  })

  it('cascades scope disposal and refuses registrations on a disposed scope', async () => {
    const root = createRoot({ logger: testLogger() })
    const order: string[] = []
    const outer = root.child({ scope: 'outer' })
    const inner = outer.child({ label: 'inner' })
    inner.effect(() => () => order.push('inner'))
    outer.effect(() => () => order.push('outer'))
    await outer.dispose()
    expect(order).toEqual(['outer', 'inner'])
    expect(() => inner.effect(() => () => {})).toThrowError(KernelError)
  })

  // The S20.5 audit's reproduction: a refused registration THREW, but only
  // after its side effect had happened — the listener stayed on the bus, the
  // service in the realm, the plugin in the root's instances — so the throw
  // that said "refused" described a registration that was in fact live.
  it('a refused registration leaves nothing behind: no listener, no service, no plugin, no effect run', async () => {
    const root = createRoot({ logger: testLogger() })
    const event = emitEvent<[]>('test/refused')
    const key = serviceKey<number>('test-refused')
    const scope = root.child({ scope: 'dead' })
    await scope.dispose()
    let heard = 0
    let ran = 0
    let observed = 0
    const instances = (root as unknown as { root: { instances: Set<unknown> } }).root.instances
    const before = instances.size
    expect(() => scope.on(event, () => void heard++, { global: true })).toThrowError(KernelError)
    expect(() => scope.provide(key, 1)).toThrowError(KernelError)
    expect(() => scope.plugin({ name: 'orphan', apply: () => void ran++ })).toThrowError(KernelError)
    expect(() => scope.effect(() => void ran++)).toThrowError(KernelError)
    expect(() => scope.observe(() => void observed++)).toThrowError(KernelError)
    root.emit(event)
    await root.settle()
    expect(heard).toBe(0)
    expect(ran).toBe(0)
    expect(observed).toBe(0)
    expect(root.tryGet(key)).toBeUndefined()
    // Where a refused provide or plugin USED to land (S20.5 review: these
    // halves could not fail when only the root's view was asked): the scope's
    // own realm, and the root's set of plugin instances.
    expect(scope.tryGet(key)).toBeUndefined()
    expect(instances.size).toBe(before)
  })

  it('disposing the root unwinds every mounted plugin', async () => {
    const root = createRoot({ logger: testLogger() })
    const order: string[] = []
    root.plugin({ name: 'a', apply: (ctx) => void ctx.effect(() => () => order.push('a')) })
    root.plugin({ name: 'b', apply: (ctx) => void ctx.effect(() => () => order.push('b')) })
    await root.settle()
    await root.dispose()
    expect(order).toEqual(['b', 'a'])
  })

  it('a child scope disposed on its own leaves no record on its parent', async () => {
    const root = createRoot({ logger: testLogger() })
    const before = root.effects().length
    const unwound: string[] = []
    for (let i = 0; i < 3; i++) {
      const child = root.child({ scope: { id: i }, label: `scope-${i}` })
      child.effect(() => () => unwound.push(`scope-${i}`))
      await child.dispose()
    }
    expect(unwound).toEqual(['scope-0', 'scope-1', 'scope-2'])
    expect(root.effects().length).toBe(before)
    // The parent-driven path still works and is idempotent with an early dispose.
    const late = root.child({ label: 'late' })
    late.effect(() => () => unwound.push('late'))
    await root.dispose()
    expect(unwound.at(-1)).toBe('late')
  })

  it('a plugin can read back the service it just provided while still loading', async () => {
    const root = createRoot({ logger: testLogger() })
    let seen: number | undefined
    let lenient: number | undefined
    root.plugin({
      name: 'self-reader',
      apply(ctx) {
        ctx.provide(COUNTER, { value: 5 })
        seen = ctx.get(COUNTER).value
        lenient = ctx.tryGet(COUNTER)?.value
      },
    })
    const report = await root.settle()
    expect(report.failed).toEqual([])
    expect(seen).toBe(5)
    expect(lenient).toBe(5)
  })

  it('settle(filter) waits for and reports only the selected plugins, and handles expose their mount scope', async () => {
    const root = createRoot({ logger: testLogger() })
    const tag = { name: 'agent-a' }
    const scope = root.child({ scope: tag })
    const slow: Plugin = {
      name: 'slow',
      async apply(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        ctx.effect(() => () => {})
      },
    }
    root.plugin({ name: 'stuck', inject: [GREETER], apply: () => {} })
    const handle = scope.plugin(slow)
    expect(handle.scope).toBe(tag)
    const report = await scope.settle((plugin) => plugin.scope === tag)
    expect(handle.state).toBe('active')
    expect(report.pending).toEqual([])
    expect((await root.settle()).pending.map((entry) => entry.name)).toEqual(['stuck'])
  })

  it('settle(filter) waits for root-wide quiescence, so a selected dependent of a still-loading unselected provider activates', async () => {
    const root = createRoot({ logger: testLogger() })
    const tag = { name: 'agent-b' }
    root.plugin({
      name: 'slow-counter',
      async apply(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        ctx.provide(COUNTER, { value: 1 })
      },
    })
    const scope = root.child({ scope: tag })
    const handle = scope.plugin({ name: 'needs-counter', inject: [COUNTER], apply: (ctx) => void ctx.get(COUNTER) })
    const report = await scope.settle((plugin) => plugin.scope === tag)
    expect(report.pending).toEqual([])
    expect(handle.state).toBe('active')
  })

  it('refuses to re-tag a child beneath a scope: scopes are flat', () => {
    const root = createRoot({ logger: testLogger() })
    const agent = root.child({ scope: { id: 'a' } })
    expect(() => agent.child({ scope: { id: 'nested' } })).toThrowError(KernelError)
    expect(() => agent.child({ scope: 'nested' })).toThrowError(/scopes are flat/)
    // Inheriting the scope (a label-only child) stays allowed, as does re-stating the same tag.
    expect(agent.child({ label: 'inner' }).scope).toBe(agent.scope)
    expect(agent.child({ scope: agent.scope }).scope).toBe(agent.scope)
  })

  it('a scope derived from a plugin context reads the key its plugin provides, even when provided afterwards', async () => {
    const root = createRoot({ logger: testLogger() })
    let seen: number | undefined
    root.plugin({
      name: 'scoped-provider',
      apply(ctx) {
        const inner = ctx.child({ label: 'inner' })
        ctx.provide(COUNTER, { value: 9 })
        seen = inner.get(COUNTER).value
      },
    })
    const report = await root.settle()
    expect(report.failed).toEqual([])
    expect(seen).toBe(9)
  })
})

/**
 * A plugin owns registrations only while a load is in flight or it is live.
 * The contexts below are CAPTURED from `apply` and used later, which is how
 * any plugin that keeps `ctx` in a closure (a registry handing it to a late
 * caller, a timer) reaches the kernel after its plugin has gone.
 */
describe('kernel: who may still register', () => {
  const PING = emitEvent<[]>('test/late-ping')
  const LATE = serviceKey<number>('test-late')

  /** Every kind of registration through `ctx`, each named with what became of it. */
  function attempts(ctx: Context, counters: { heard: number; cleaned: number; applied: number }): string[] {
    const tries: [name: string, register: () => unknown][] = [
      ['on', () => ctx.on(PING, () => void counters.heard++, { global: true })],
      ['effect', () => ctx.effect(() => () => void counters.cleaned++, 'late-effect')],
      ['provide', () => ctx.provide(LATE, 1)],
      ['observe', () => ctx.observe(() => {})],
      ['child', () => ctx.child({ label: 'late-scope' })],
      ['plugin', () => ctx.plugin({ name: 'late-plugin', apply: () => void counters.applied++ })],
    ]
    return tries.map(([name, register]) => {
      try {
        register()
        return `${name}: admitted`
      } catch (error) {
        return `${name}: ${error instanceof KernelError ? error.code : String(error)}`
      }
    })
  }
  const REFUSED = ['on', 'effect', 'provide', 'observe', 'child', 'plugin'].map((name) => `${name}: INACTIVE_OWNER`)

  it('refuses every registration through the context of a FAILED plugin, and leaves nothing behind', async () => {
    const root = createRoot({ logger: testLogger() })
    const counters = { heard: 0, cleaned: 0, applied: 0 }
    let captured: Context | undefined
    const handle = root.plugin({
      name: 'fails',
      apply(ctx) {
        captured = ctx
        throw new Error('boom')
      },
    })
    await root.settle()
    expect(handle.state).toBe('failed')
    expect(attempts(captured!, counters)).toEqual(REFUSED)
    root.emit(PING)
    await root.settle()
    expect({ ...counters, listeners: root.listenerCount(PING), service: root.tryGet(LATE), effects: captured!.effects() }).toEqual({
      heard: 0,
      cleaned: 0,
      applied: 0,
      listeners: 0,
      service: undefined,
      effects: [],
    })
    await root.dispose()
  })

  it('refuses them through a plugin unloaded to PENDING when its dependency left, and through a disposed one', async () => {
    const root = createRoot({ logger: testLogger() })
    const counters = { heard: 0, cleaned: 0, applied: 0 }
    let captured: Context | undefined
    const provider = root.plugin(counterProvider(1))
    const dependent = root.plugin({ name: 'dependent', inject: [COUNTER], apply: (ctx) => void (captured = ctx) })
    await root.settle()
    // The control: while it is live, the same context is admitted, and its unload takes the registration away.
    expect(dependent.state).toBe('active')
    captured!.on(PING, () => void counters.heard++, { global: true })
    expect(root.listenerCount(PING)).toBe(1)

    await provider.dispose()
    await root.settle()
    expect(dependent.state).toBe('pending')
    expect(root.listenerCount(PING)).toBe(0)
    expect(attempts(captured!, counters)).toEqual(REFUSED)

    await dependent.dispose()
    expect(dependent.state).toBe('disposed')
    expect(attempts(captured!, counters)).toEqual(REFUSED)
    root.emit(PING)
    expect({ ...counters, listeners: root.listenerCount(PING), effects: captured!.effects() }).toEqual({ heard: 0, cleaned: 0, applied: 0, listeners: 0, effects: [] })
    await root.dispose()
  })

  // A failed load unwinds its partial effects, and a cleanup may be awaited:
  // the plugin is no longer loading while that runs, so nothing registered in
  // that window lands on a list the load is already done with.
  it('refuses a registration made while a failed load is still unwinding its partial effects', async () => {
    const root = createRoot({ logger: testLogger() })
    const counters = { heard: 0, cleaned: 0, applied: 0 }
    const unwinding = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let captured: Context | undefined
    const handle = root.plugin({
      name: 'fails-slowly',
      apply(ctx) {
        captured = ctx
        ctx.effect(() => async () => {
          unwinding.resolve()
          await release.promise
        }, 'slow-cleanup')
        throw new Error('boom')
      },
    })
    await unwinding.promise
    const during = attempts(captured!, counters)
    release.resolve()
    await root.settle()
    expect(handle.state).toBe('failed')
    expect(during).toEqual(REFUSED)
    expect({ listeners: root.listenerCount(PING), effects: captured!.effects() }).toEqual({ listeners: 0, effects: [] })
    await root.dispose()
  })

  /**
   * The floor under `admit`: disposal is the last owner a registration has, so
   * it unwinds what the plugin still lists in ANY state. No public path can
   * list an effect on a failed or pending plugin any more, so the record is
   * put on the list directly, the way a future gap in `admit` would put it.
   */
  it('unwinds whatever a failed or a pending plugin still lists when it, or the root, is disposed', async () => {
    const list = (handle: unknown) => (handle as { effects: { add(record: { dispose: () => void; label: string }): unknown } }).effects
    const cleaned: string[] = []
    const stranded = (label: string) => ({ dispose: () => void cleaned.push(label), label })

    const root = createRoot({ logger: testLogger() })
    const failed = root.plugin({
      name: 'fails',
      apply() {
        throw new Error('boom')
      },
    })
    const pending = root.plugin({ name: 'waits', inject: [GREETER], apply: () => {} })
    const failedToo = root.plugin({
      name: 'fails-too',
      apply() {
        throw new Error('boom')
      },
    })
    await root.settle()
    expect([failed.state, pending.state, failedToo.state]).toEqual(['failed', 'pending', 'failed'])
    list(failed).add(stranded('on a failed plugin'))
    list(pending).add(stranded('on a pending plugin'))
    list(failedToo).add(stranded('on a failed plugin, at root disposal'))

    await failed.dispose()
    expect(cleaned).toEqual(['on a failed plugin'])
    await pending.dispose()
    expect(cleaned).toEqual(['on a failed plugin', 'on a pending plugin'])
    await root.dispose()
    expect(cleaned).toEqual(['on a failed plugin', 'on a pending plugin', 'on a failed plugin, at root disposal'])
    expect([failed.state, pending.state, failedToo.state]).toEqual(['disposed', 'disposed', 'disposed'])
  })
})

/**
 * The activation branches `refresh` takes when a dependency's identity changes
 * WITHOUT an inactive gap. A provider disposed and remounted goes through
 * "gone, then back" (above); here a scope shadows a key its plugin was reading
 * from the root, so the epoch moves from one live provider straight to another.
 */
describe('kernel: a dependency replaced with no gap', () => {
  it('unloads then reloads an active dependent, its old effects unwound exactly once and before the reload', async () => {
    const root = createRoot({ logger: testLogger() })
    root.plugin(counterProvider(1))
    const scope = root.child({ scope: 'agent' })
    const log: string[] = []
    const dependent = scope.plugin({
      name: 'dependent',
      inject: [COUNTER],
      apply(ctx) {
        const value = ctx.get(COUNTER).value
        log.push(`load:${value}`)
        ctx.effect(() => () => void log.push(`unload:${value}`))
      },
    })
    await root.settle()
    expect(log).toEqual(['load:1'])

    scope.provide(COUNTER, { value: 2 })
    await root.settle()
    expect(dependent.state).toBe('active')
    expect(log).toEqual(['load:1', 'unload:1', 'load:2'])
    await dependent.dispose()
    expect(log).toEqual(['load:1', 'unload:1', 'load:2', 'unload:2'])
    await root.dispose()
  })

  it('retries a FAILED dependent under the provider that replaced the one it failed under', async () => {
    const logger = testLogger()
    const root = createRoot({ logger })
    root.plugin(counterProvider(1))
    const scope = root.child({ scope: 'agent' })
    const seen: number[] = []
    const dependent = scope.plugin({
      name: 'picky',
      inject: [COUNTER],
      apply(ctx) {
        const value = ctx.get(COUNTER).value
        seen.push(value)
        if (value === 1) throw new Error('cannot work with 1')
      },
    })
    expect((await root.settle()).failed.map((entry) => entry.name)).toEqual(['picky'])
    expect(dependent.state).toBe('failed')
    // Never on its own: nothing changed, so nothing is retried.
    await root.settle()
    expect(seen).toEqual([1])

    scope.provide(COUNTER, { value: 2 })
    const report = await root.settle()
    expect({ state: dependent.state, error: dependent.error, seen, failed: report.failed }).toEqual({ state: 'active', error: undefined, seen: [1, 2], failed: [] })
    await root.dispose()
  })
})

describe('kernel: a plugin disposed while its apply is still running', () => {
  it('unwinds what the apply registered, never goes live, and never activates a dependent of what it provided', async () => {
    const logger = testLogger()
    const root = createRoot({ logger })
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const log: string[] = []
    const slow = root.plugin({
      name: 'slow-provider',
      async apply(ctx) {
        ctx.provide(COUNTER, { value: 1 })
        ctx.effect(() => () => void log.push('unwound'), 'before-the-gate')
        reached.resolve()
        await gate.promise
        log.push('apply returned')
      },
    })
    const dependent = root.plugin({ name: 'dependent', inject: [COUNTER], apply: (ctx) => void log.push(`dependent loaded:${ctx.get(COUNTER).value}`) })
    await reached.promise
    expect(slow.state).toBe('loading')

    const disposed = slow.dispose()
    gate.resolve()
    await disposed
    const report = await root.settle()
    expect(log).toEqual(['apply returned', 'unwound'])
    expect({ slow: slow.state, dependent: dependent.state, counter: root.tryGet(COUNTER), pending: report.pending, failed: report.failed, errors: logger.errors }).toEqual({
      slow: 'disposed',
      dependent: 'pending',
      counter: undefined,
      pending: [{ name: 'dependent', missing: ['counter'] }],
      failed: [],
      errors: [],
    })
    await root.dispose()
  })
})

describe('kernel: events', () => {
  const PING = emitEvent<[value: number]>('test/ping')
  const TRANSFORM = waterfallEvent<[input: string], string>('test/transform')
  const CHECKPOINT = serialEvent<[log: string[]]>('test/checkpoint')
  const FANOUT = parallelEvent<[log: string[]]>('test/fanout')

  it('emit delivers to every listener and contains exceptions', () => {
    const logger = testLogger()
    const root = createRoot({ logger })
    const seen: number[] = []
    root.on(PING, () => {
      throw new Error('bad listener')
    })
    root.on(PING, (value) => void seen.push(value))
    root.emit(PING, 42)
    expect(seen).toEqual([42])
    expect(logger.errors).toHaveLength(1)
  })

  it('waterfall composes listeners around the inner continuation; omitting next() short-circuits', () => {
    const root = createRoot({ logger: testLogger() })
    root.on(TRANSFORM, (_input, next) => `[${next()}]`)
    root.on(TRANSFORM, (_input, next) => `${next()}!`)
    expect(root.waterfall(TRANSFORM, 'x', () => 'x')).toBe('[x!]')
    root.on(TRANSFORM, () => 'short', { prepend: true })
    expect(root.waterfall(TRANSFORM, 'x', () => 'x')).toBe('short')
  })

  it('serial awaits listeners in registration order', async () => {
    const root = createRoot({ logger: testLogger() })
    root.on(CHECKPOINT, async (log) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      log.push('a')
    })
    root.on(CHECKPOINT, (log) => void log.push('b'))
    const log: string[] = []
    await root.serial(CHECKPOINT, log)
    expect(log).toEqual(['a', 'b'])
  })

  it('parallel runs every listener and aggregates failures', async () => {
    const root = createRoot({ logger: testLogger() })
    root.on(FANOUT, () => {
      throw new Error('one')
    })
    root.on(FANOUT, (log) => void log.push('two'))
    const log: string[] = []
    await expect(root.parallel(FANOUT, log)).rejects.toBeInstanceOf(AggregateError)
    expect(log).toEqual(['two'])
  })

  it('admits listeners by scope: a scoped dispatch reaches unscoped, same-scope and global listeners; an unscoped one never reaches scoped listeners', () => {
    const root = createRoot({ logger: testLogger() })
    const a = root.child({ scope: 'a' })
    const b = root.child({ scope: 'b' })
    const seen: string[] = []
    root.on(PING, () => void seen.push('root'))
    a.on(PING, () => void seen.push('a'))
    b.on(PING, () => void seen.push('b'))
    b.on(PING, () => void seen.push('b-global'), { global: true })
    a.emit(PING, 1)
    expect(seen).toEqual(['root', 'a', 'b-global'])
    seen.length = 0
    // A dispatch with no subject is not about any scope: scoped listeners observe their own subject only.
    root.emit(PING, 2)
    expect(seen).toEqual(['root', 'b-global'])
  })

  it('listeners registered through a plugin context are removed when the plugin unloads', async () => {
    const root = createRoot({ logger: testLogger() })
    const seen: number[] = []
    const handle = root.plugin({ name: 'listener', apply: (ctx) => void ctx.on(PING, (value) => void seen.push(value)) })
    await root.settle()
    root.emit(PING, 1)
    await handle.dispose()
    root.emit(PING, 2)
    expect(seen).toEqual([1])
    expect(root.listenerCount(PING)).toBe(0)
  })

  it('observers see a dispatch before delivery and can reject it', () => {
    const root = createRoot({ logger: testLogger() })
    const seen: string[] = []
    root.on(PING, () => void seen.push('delivered'))
    const observed: string[] = []
    root.observe((info) => {
      observed.push(`${info.mode}:${info.name}:${String(info.args[0])}`)
      if (info.args[0] === 13) throw new Error('rejected by observer')
    })
    root.emit(PING, 1)
    expect(() => root.emit(PING, 13)).toThrowError(/rejected by observer/)
    expect(observed).toEqual(['emit:test/ping:1', 'emit:test/ping:13'])
    expect(seen).toEqual(['delivered'])
  })

  it('prepareEmit separates preflight from delivery', () => {
    const root = createRoot({ logger: testLogger() })
    const seen: number[] = []
    root.on(PING, (value) => void seen.push(value))
    const deliver = root.prepareEmit(PING, 5)
    expect(seen).toEqual([])
    deliver()
    expect(seen).toEqual([5])
  })
})

describe('kernel: S5.5 hardening', () => {
  it('parses a plugin config through its declared schema before apply, and fails the row loudly on a bad one', async () => {
    const logger = testLogger()
    const root = createRoot({ logger })
    const applied: unknown[] = []
    const schema = {
      parse(value: unknown): { limit: number } {
        const record = value as { limit?: unknown; stale?: unknown }
        if (record.stale !== undefined) throw new Error('unknown key "stale"')
        return { limit: typeof record.limit === 'number' ? record.limit : 10 }
      },
    }
    const plugin: Plugin<{ limit: number }> = {
      name: 'limited',
      config: schema,
      apply: (_ctx, config) => void applied.push(config),
    }
    root.plugin(plugin, {} as { limit: number })
    await root.settle()
    expect(applied).toEqual([{ limit: 10 }]) // the PARSED value reaches apply

    const bad = root.plugin(plugin, { stale: 1 } as unknown as { limit: number })
    const report = await root.settle()
    expect(bad.state).toBe('failed')
    const failure = report.failed[0]!.error as KernelError
    expect(failure.code).toBe('PLUGIN_CONFIG')
    expect(failure.message).toMatch(/plugin "limited": invalid config: unknown key "stale"/)
    expect(applied).toHaveLength(1)
  })

  it('a scope providing a service widens its OWN reads only, and only while the provision lasts', async () => {
    const root = createRoot({ logger: testLogger() })
    const A = serviceKey<number>('a')
    root.provide(GREETER, { greet: () => 'root' })
    let pluginCtx: Context | undefined
    root.plugin({ name: 'reader', inject: [A], apply: (ctx) => void (pluginCtx = ctx) })
    root.plugin({ name: 'a-provider', apply: (ctx) => void ctx.provide(A, 1) })
    await root.settle()
    expect(() => pluginCtx!.get(GREETER)).toThrowError(/without inject/)
    const scope = pluginCtx!.child({ scope: { id: 'agent' } })
    const release = scope.provide(GREETER, { greet: () => 'shadow' })
    expect(scope.get(GREETER).greet()).toBe('shadow')
    // The plugin's own strict-read set is untouched by what its scope provided.
    expect(() => pluginCtx!.get(GREETER)).toThrowError(/without inject/)
    await release()
    expect(() => scope.get(GREETER)).toThrowError(/without inject/)
  })

  it('refuses a middleware that calls next() twice, so the inner continuation runs at most once', () => {
    const root = createRoot({ logger: testLogger() })
    const TWICE = waterfallEvent<[input: string], string>('test/twice')
    let inner = 0
    root.on(TWICE, (_input, next) => {
      next()
      return next()
    })
    expect(() =>
      root.waterfall(TWICE, 'x', () => {
        inner += 1
        return 'x'
      }),
    ).toThrowError(/called next\(\) more than once/)
    expect(inner).toBe(1)
  })

  it('runs the synchronous part of a cleanup eagerly, so off-then-register in one tick is legal', () => {
    const root = createRoot({ logger: testLogger() })
    const off = root.provide(COUNTER, { value: 1 })
    void off()
    expect(() => root.provide(COUNTER, { value: 2 })).not.toThrow()
    expect(root.get(COUNTER).value).toBe(2)
  })
})

describe('kernel: plugin context shape', () => {
  it('gives a plugin a context whose registrations it owns and whose reads are restricted to inject + own provides', async () => {
    const root = createRoot({ logger: testLogger() })
    let captured: Context | undefined
    const plugin: Plugin = {
      name: 'shape',
      inject: [COUNTER],
      apply(ctx) {
        captured = ctx
        ctx.provide(GREETER, { greet: () => `hi ${ctx.get(COUNTER).value}` })
      },
    }
    root.plugin(counterProvider(3))
    root.plugin(plugin)
    await root.settle()
    expect(captured?.get(GREETER).greet()).toBe('hi 3')
    expect(root.get(GREETER).greet()).toBe('hi 3')
    expect(captured?.effects()).toEqual(['provide("greeter")'])
    await expect(captured!.dispose()).rejects.toThrowError(KernelError)
  })
})
