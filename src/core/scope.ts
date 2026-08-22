/**
 * Per-agent registration layers — the scope contract shared by every core
 * registry that has an agent subject (tool definitions, guards, prompt
 * sections, prompt variables).
 *
 * Registration origin decides visibility and lifetime together: a
 * registration made through an unscoped context is deployment-global; one
 * made through an agent's scoped context (or a plugin mounted on it) lives in
 * that agent's layer and unwinds with it. A view merges the globals with
 * exactly one agent layer — a local entry shadows a same-named global. There
 * is no inheritance between scopes: a parent's registrations never enter a
 * child's view merely because the parent owns the child's lifetime.
 */
import type { Context } from '../kernel/index.ts'

export class ScopedLayers<T> {
  private readonly globals = new Map<string, T>()
  private readonly scoped = new WeakMap<object, Map<string, T>>()

  /** The layer a registration through `owner` lands in. A scope tag must be an object. */
  layerFor(owner: Context): Map<string, T> {
    const scope = owner.scope
    if (scope === undefined) return this.globals
    if (scope === null || typeof scope !== 'object') {
      throw new Error(`scope tag must be an object to own registrations (got ${scope === null ? 'null' : typeof scope})`)
    }
    let layer = this.scoped.get(scope)
    if (!layer) {
      layer = new Map()
      this.scoped.set(scope, layer)
    }
    return layer
  }

  /** Resolves `name` for `subject`: its own layer first, then the globals. */
  get(name: string, subject?: object): T | undefined {
    return (subject ? this.scoped.get(subject)?.get(name) : undefined) ?? this.globals.get(name)
  }

  /** The globals merged with the subject's layer; a local entry shadows a same-named global. */
  view(subject?: object): Map<string, T> {
    const merged = new Map(this.globals)
    const local = subject ? this.scoped.get(subject) : undefined
    if (local) for (const [name, value] of local) merged.set(name, value)
    return merged
  }
}
