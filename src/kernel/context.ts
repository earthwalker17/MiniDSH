import { EventBus, type Disposer, type DispatchInfo, type EffectCleanup, type Logger, type Observer } from './bus.ts'
import { KernelError } from './errors.ts'
import type { AnyEventKey, EventKey, Listener, ServiceKey } from './tokens.ts'

/** A plugin: an owned unit of registrations with declared service dependencies. */
export interface Plugin<C = undefined> {
  readonly name: string
  readonly inject?: readonly ServiceKey<unknown>[]
  apply(ctx: Context, config: C): void | Promise<void>
}

export type PluginState = 'pending' | 'loading' | 'active' | 'unloading' | 'disposed' | 'failed'

export interface PluginHandle {
  readonly name: string
  readonly state: PluginState
  /** The error of the last failed load, if any. */
  readonly error: unknown
  /** Resolves once no transition is in flight; rejects if the plugin failed. */
  settled(): Promise<void>
  dispose(): Promise<void>
}

export interface SettleReport {
  readonly pending: readonly { name: string; missing: readonly string[] }[]
  readonly failed: readonly { name: string; error: unknown }[]
}

export interface ListenOptions {
  readonly prepend?: boolean
  readonly global?: boolean
}

interface EffectRecord {
  dispose: EffectCleanup
  label: string
}

/** Anything that can own effects: the root, a scope, or a plugin instance. */
interface EffectOwner {
  readonly label: string
  readonly active: boolean
  addEffect(record: EffectRecord): Disposer
}

/** A service slot in a realm. */
interface Impl {
  readonly key: string
  readonly value: unknown
  /** The providing plugin instance, or `null` when provided outside any plugin. */
  readonly provider: PluginInstance | null
  readonly id: number
}

/** A realm is the service map of one context level; lookups walk up the chain. */
class Realm {
  readonly parent: Realm | null
  private readonly impls = new Map<string, Impl>()
  constructor(parent: Realm | null) {
    this.parent = parent
  }
  lookup(key: string): Impl | undefined {
    return this.impls.get(key) ?? this.parent?.lookup(key)
  }
  has(key: string): boolean {
    return this.impls.has(key)
  }
  set(impl: Impl): void {
    this.impls.set(impl.key, impl)
  }
  delete(key: string, impl: Impl): void {
    if (this.impls.get(key) === impl) this.impls.delete(key)
  }
}

class RootState {
  readonly bus: EventBus
  readonly logger: Logger
  readonly instances = new Set<PluginInstance>()
  private nextId = 1
  constructor(logger: Logger) {
    this.logger = logger
    this.bus = new EventBus(logger)
  }
  mintId(): number {
    return this.nextId++
  }
  /** Re-evaluates every plugin's activation epoch after a service change. */
  notify(): void {
    const snapshot = Array.from(this.instances)
    for (const instance of snapshot) instance.refresh()
  }
}

class EffectList {
  private readonly records: EffectRecord[] = []
  add(record: EffectRecord): Disposer {
    this.records.push(record)
    let task: Promise<void> | undefined
    return () => {
      if (task) return task
      const index = this.records.indexOf(record)
      if (index >= 0) this.records.splice(index, 1)
      task = Promise.resolve().then(() => record.dispose())
      return task
    }
  }
  /** Strict reverse-order, sequential disposal. */
  async unwindAll(logger: Logger, owner: string): Promise<void> {
    while (this.records.length > 0) {
      const record = this.records.pop()!
      try {
        await record.dispose()
      } catch (error) {
        logger.error(`effect "${record.label}" of ${owner} failed to dispose`, error)
      }
    }
  }
  labels(): string[] {
    return this.records.map((record) => record.label)
  }
}

const INACTIVE = '__inactive__'

class PluginInstance implements EffectOwner, PluginHandle {
  readonly name: string
  readonly plugin: Plugin<unknown>
  readonly config: unknown
  readonly id: number
  readonly root: RootState
  readonly mount: Context
  readonly ctx: Context
  state: PluginState = 'pending'
  error: unknown = undefined
  private epoch: string | null = null
  private inertia: Promise<void> = Promise.resolve()
  private readonly effects = new EffectList()
  private mounted = true
  private mountDisposer: Disposer | null = null

  constructor(root: RootState, mount: Context, plugin: Plugin<unknown>, config: unknown) {
    this.root = root
    this.mount = mount
    this.plugin = plugin
    this.config = config
    this.name = plugin.name
    this.id = root.mintId()
    const allowed = new Set((plugin.inject ?? []).map((key) => key.name))
    this.ctx = new Context({
      root,
      parent: mount,
      realm: mount.realm,
      owner: this,
      scope: mount.scope,
      inject: allowed,
    })
  }

  get label(): string {
    return `plugin "${this.name}"`
  }

  get active(): boolean {
    return this.state === 'loading' || this.state === 'active'
  }

  addEffect(record: EffectRecord): Disposer {
    if (!this.mounted || this.state === 'unloading' || this.state === 'disposed') {
      throw new KernelError('INACTIVE_OWNER', `cannot register "${record.label}" on ${this.label}: ${this.state}`)
    }
    return this.effects.add(record)
  }

  attachMountDisposer(disposer: Disposer): void {
    this.mountDisposer = disposer
  }

  settled(): Promise<void> {
    return this.inertia.then(() => {
      if (this.state === 'failed') {
        throw new KernelError('PLUGIN_FAILED', `${this.label} failed to load`, { cause: this.error })
      }
    })
  }

  /** Unmet dependency names (only meaningful while pending). */
  missing(): string[] {
    const names: string[] = []
    for (const key of this.plugin.inject ?? []) {
      const impl = this.mount.realm.lookup(key.name)
      if (!impl || (impl.provider && impl.provider.state !== 'active')) names.push(key.name)
    }
    return names
  }

  private computeEpoch(): string {
    let epoch = ''
    for (const key of this.plugin.inject ?? []) {
      const impl = this.mount.realm.lookup(key.name)
      if (!impl) return INACTIVE
      if (impl.provider && impl.provider.state !== 'active') return INACTIVE
      epoch += `:${impl.id}`
    }
    return epoch
  }

  /** Epoch-gated activation: the single mechanism behind wait, unload-on-loss, and reload-on-swap. */
  refresh(): void {
    if (!this.mounted || this.state === 'failed') return
    const next = this.computeEpoch()
    if (next === this.epoch) return
    const previous = this.epoch
    this.epoch = next
    if (next === INACTIVE) {
      if (previous !== null && previous !== INACTIVE) this.schedule(() => this.unload())
      return
    }
    if (previous === null || previous === INACTIVE) {
      this.schedule(() => this.load())
    } else {
      this.schedule(async () => {
        await this.unload()
        // Re-check: the epoch may have changed again while unloading.
        if (this.mounted && this.computeEpoch() === this.epoch && this.epoch !== INACTIVE) await this.load()
      })
    }
  }

  private schedule(task: () => Promise<void>): void {
    this.inertia = this.inertia.then(task, task)
  }

  private async load(): Promise<void> {
    if (!this.mounted) return
    this.state = 'loading'
    try {
      await this.plugin.apply(this.ctx, this.config)
      if (!this.mounted) {
        await this.effects.unwindAll(this.root.logger, this.label)
        return
      }
      this.state = 'active'
      this.error = undefined
      this.root.notify()
    } catch (error) {
      this.error = error
      this.root.logger.error(`${this.label} failed to load`, error)
      await this.effects.unwindAll(this.root.logger, this.label)
      this.state = 'failed'
      this.root.notify()
    }
  }

  private async unload(): Promise<void> {
    if (this.state !== 'active' && this.state !== 'loading') return
    this.state = 'unloading'
    await this.effects.unwindAll(this.root.logger, this.label)
    this.state = this.mounted ? 'pending' : 'disposed'
    this.root.notify()
  }

  async dispose(): Promise<void> {
    if (!this.mounted) {
      await this.inertia
      return
    }
    this.mounted = false
    this.root.instances.delete(this)
    this.schedule(async () => {
      if (this.state === 'active' || this.state === 'loading') {
        this.state = 'unloading'
        await this.effects.unwindAll(this.root.logger, this.label)
      }
      this.state = 'disposed'
      this.root.notify()
    })
    await this.inertia
    if (this.mountDisposer) {
      const disposer = this.mountDisposer
      this.mountDisposer = null
      await disposer()
    }
  }

  effectLabels(): string[] {
    return this.effects.labels()
  }
}

/** A scope: a disposable child context owning its own effects and realm. */
class Scope implements EffectOwner {
  readonly label: string
  active = true
  private readonly effects = new EffectList()
  private readonly logger: Logger
  constructor(label: string, logger: Logger) {
    this.label = label
    this.logger = logger
  }
  addEffect(record: EffectRecord): Disposer {
    if (!this.active) throw new KernelError('INACTIVE_OWNER', `cannot register "${record.label}" on disposed ${this.label}`)
    return this.effects.add(record)
  }
  async unwind(): Promise<void> {
    if (!this.active) return
    this.active = false
    await this.effects.unwindAll(this.logger, this.label)
  }
  effectLabels(): string[] {
    return this.effects.labels()
  }
}

interface ContextInit {
  root: RootState
  parent: Context | null
  realm: Realm
  owner: EffectOwner
  scope: unknown
  /** Allowed strict reads; `null` = unrestricted (root and scopes). */
  inject: Set<string> | null
}

/**
 * The composition context. Services, plugins, effects, listeners, and child
 * scopes all hang off it; registrations made through a context belong to its
 * owner and unwind with it.
 */
export class Context {
  readonly parent: Context | null
  readonly realm: Realm
  readonly scope: unknown
  readonly owner: EffectOwner
  readonly root: RootState
  private readonly inject: Set<string> | null
  private readonly ownScope: Scope | null

  constructor(init: ContextInit, ownScope: Scope | null = null) {
    this.root = init.root
    this.parent = init.parent
    this.realm = init.realm
    this.owner = init.owner
    this.scope = init.scope
    this.inject = init.inject
    this.ownScope = ownScope
  }

  get logger(): Logger {
    return this.root.logger
  }

  // ---- services -----------------------------------------------------------

  /** Strict read: the key must be injected (or provided by this owner) and active. */
  get<T>(key: ServiceKey<T>): T {
    if (this.inject && !this.inject.has(key.name)) {
      throw new KernelError('SERVICE_NOT_INJECTED', `cannot read service "${key.name}" from ${this.owner.label} without inject`)
    }
    const impl = this.realm.lookup(key.name)
    if (!impl || (impl.provider && impl.provider.state !== 'active')) {
      throw new KernelError('SERVICE_UNAVAILABLE', `service "${key.name}" is not available`)
    }
    return impl.value as T
  }

  /** Lenient read for optional dependencies; `undefined` when absent or inactive. */
  tryGet<T>(key: ServiceKey<T>): T | undefined {
    const impl = this.realm.lookup(key.name)
    if (!impl || (impl.provider && impl.provider.state !== 'active')) return undefined
    return impl.value as T
  }

  /** Claims a service key in this context's realm. An effect: unprovided on unwind. */
  provide<T>(key: ServiceKey<T>, value: T): Disposer {
    if (this.realm.has(key.name)) {
      throw new KernelError('SERVICE_DUPLICATE', `service "${key.name}" is already provided in this realm`)
    }
    const provider = this.owner instanceof PluginInstance ? this.owner : null
    const impl: Impl = { key: key.name, value, provider, id: this.root.mintId() }
    this.realm.set(impl)
    if (this.inject) this.inject.add(key.name)
    const disposer = this.effect(() => {
      return () => {
        this.realm.delete(key.name, impl)
        this.root.notify()
      }
    }, `provide("${key.name}")`)
    this.root.notify()
    return disposer
  }

  // ---- plugins and effects ------------------------------------------------

  /** Mounts a plugin here; it activates once its injected services are active. */
  plugin(plugin: Plugin<undefined>): PluginHandle
  plugin<C>(plugin: Plugin<C>, config: C): PluginHandle
  plugin<C>(plugin: Plugin<C>, config?: C): PluginHandle {
    const instance = new PluginInstance(this.root, this, plugin as Plugin<unknown>, config)
    this.root.instances.add(instance)
    const mountDisposer = this.effect(() => () => instance.dispose(), `plugin("${plugin.name}")`)
    instance.attachMountDisposer(mountDisposer)
    instance.refresh()
    return instance
  }

  /** Registers a reversible effect on this context's owner. */
  effect(execute: () => EffectCleanup | void, label = 'effect'): Disposer {
    const dispose = execute() ?? (() => {})
    return this.owner.addEffect({ dispose, label })
  }

  /** Derives a disposable scoped child context. Its realm may shadow services. */
  child(options: { scope?: unknown; label?: string } = {}): Context {
    const scope = new Scope(options.label ?? `scope(${String(options.scope ?? 'anonymous')})`, this.root.logger)
    const ctx = new Context(
      {
        root: this.root,
        parent: this,
        realm: new Realm(this.realm),
        owner: scope,
        scope: options.scope ?? this.scope,
        inject: this.inject ? new Set(this.inject) : null,
      },
      scope,
    )
    // A scope unwinds with its parent owner.
    this.owner.addEffect({ dispose: () => scope.unwind(), label: scope.label })
    return ctx
  }

  /** Disposes this context if it is a scope or the root; plugin contexts dispose through their handle. */
  async dispose(): Promise<void> {
    if (this.ownScope) {
      await this.ownScope.unwind()
      return
    }
    if (this.parent === null) {
      await (this.owner as Scope).unwind()
      return
    }
    throw new KernelError('INACTIVE_OWNER', `${this.owner.label} is disposed through its plugin handle`)
  }

  /** Labels of the effects currently owned by this context's owner (diagnostics). */
  effects(): string[] {
    const owner = this.owner as EffectOwner & { effectLabels?: () => string[] }
    return owner.effectLabels ? owner.effectLabels() : []
  }

  // ---- events -------------------------------------------------------------

  on<K extends AnyEventKey>(key: K, listener: Listener<K>, options: ListenOptions = {}): Disposer {
    const remove = this.root.bus.add(
      { name: key.name, fn: listener as (...args: unknown[]) => unknown, scope: this.scope, global: options.global ?? false },
      options.prepend ?? false,
    )
    return this.effect(() => remove, `on("${key.name}")`)
  }

  /** Pre-delivery observation of every dispatch on this root (the invariant seam). */
  observe(observer: Observer): Disposer {
    const remove = this.root.bus.observe(observer)
    return this.effect(() => remove, 'observe')
  }

  /** Prepares an emit: observers run now (may reject), delivery happens when the returned function is called. */
  prepareEmit<A extends unknown[]>(key: EventKey<'emit', A, void>, ...args: A): () => void {
    const info: DispatchInfo = { mode: 'emit', name: key.name, args, scope: this.scope }
    this.root.bus.preflight(info)
    const listeners = this.root.bus.select(key.name, this.scope)
    return () => {
      for (const fn of listeners) {
        try {
          const result = fn(...args)
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            ;(result as Promise<unknown>).catch((error: unknown) =>
              this.root.logger.error(`listener of "${key.name}" rejected`, error),
            )
          }
        } catch (error) {
          this.root.logger.error(`listener of "${key.name}" threw`, error)
        }
      }
    }
  }

  emit<A extends unknown[]>(key: EventKey<'emit', A, void>, ...args: A): void {
    this.prepareEmit(key, ...args)()
  }

  waterfall<A extends unknown[], R>(key: EventKey<'waterfall', A, R>, ...args: [...A, () => R]): R {
    const inner = args[args.length - 1] as () => R
    const plain = args.slice(0, -1)
    this.root.bus.preflight({ mode: 'waterfall', name: key.name, args: plain, scope: this.scope })
    const listeners = this.root.bus.select(key.name, this.scope)
    const run = (index: number): R => {
      if (index >= listeners.length) return inner()
      const fn = listeners[index]!
      return fn(...plain, () => run(index + 1)) as R
    }
    return run(0)
  }

  async serial<A extends unknown[]>(key: EventKey<'serial', A, void>, ...args: A): Promise<void> {
    this.root.bus.preflight({ mode: 'serial', name: key.name, args, scope: this.scope })
    for (const fn of this.root.bus.select(key.name, this.scope)) await fn(...args)
  }

  async parallel<A extends unknown[]>(key: EventKey<'parallel', A, void>, ...args: A): Promise<void> {
    this.root.bus.preflight({ mode: 'parallel', name: key.name, args, scope: this.scope })
    const listeners = this.root.bus.select(key.name, this.scope)
    const results = await Promise.allSettled(listeners.map((fn) => Promise.resolve().then(() => fn(...args))))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${failures.length} listener(s) of "${key.name}" failed`,
      )
    }
  }

  listenerCount(key: AnyEventKey): number {
    return this.root.bus.listenerCount(key.name)
  }

  // ---- root-level --------------------------------------------------------

  /** Waits until no plugin transition is in flight and reports pending and failed plugins. */
  async settle(): Promise<SettleReport> {
    for (let round = 0; round < 1000; round++) {
      const snapshot = [...this.root.instances]
      await Promise.all(snapshot.map((instance) => instance.settled().catch(() => undefined)))
      const quiet = snapshot.every((instance) => instance.state !== 'loading' && instance.state !== 'unloading')
      const sameSet = snapshot.length === this.root.instances.size && snapshot.every((instance) => this.root.instances.has(instance))
      if (quiet && sameSet) break
    }
    const pending = [...this.root.instances]
      .filter((instance) => instance.state === 'pending')
      .map((instance) => ({ name: instance.name, missing: instance.missing() }))
    const failed = [...this.root.instances]
      .filter((instance) => instance.state === 'failed')
      .map((instance) => ({ name: instance.name, error: instance.error }))
    return { pending, failed }
  }
}

export interface RootOptions {
  readonly logger?: Logger
}

const consoleLogger: Logger = {
  warn: (message, detail) => console.warn(`[minidsh] ${message}`, detail ?? ''),
  error: (message, detail) => console.error(`[minidsh] ${message}`, detail ?? ''),
}

/** Creates a root context: the top of the composition tree. */
export function createRoot(options: RootOptions = {}): Context {
  const logger = options.logger ?? consoleLogger
  const root = new RootState(logger)
  const scope = new Scope('root', logger)
  return new Context({ root, parent: null, realm: new Realm(null), owner: scope, scope: undefined, inject: null })
}
