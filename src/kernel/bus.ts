import type { DispatchMode } from './tokens.ts'

/** The handle returned by every registration: single-shot, awaits the cleanup. */
export type Disposer = () => Promise<void>

/** What an effect returns to undo itself; a plain `() => void` is enough. */
export type EffectCleanup = (() => void) | (() => Promise<void>)

export interface Hook {
  readonly name: string
  readonly fn: (...args: unknown[]) => unknown
  /** Scope tag of the registering context; `undefined` = unscoped. */
  readonly scope: unknown
  /** Admitted for every dispatch regardless of scope. */
  readonly global: boolean
}

export interface DispatchInfo {
  readonly mode: DispatchMode
  readonly name: string
  readonly args: readonly unknown[]
  readonly scope: unknown
}

export type Observer = (info: DispatchInfo) => void

export interface Logger {
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/**
 * The single event bus of a root context. It stores listeners, selects the
 * admitted ones for a dispatch scope, and runs pre-delivery observers.
 */
export class EventBus {
  private readonly hooks = new Map<string, Hook[]>()
  private readonly observers: Observer[] = []
  readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  add(hook: Hook, prepend: boolean): () => void {
    let list = this.hooks.get(hook.name)
    if (!list) {
      list = []
      this.hooks.set(hook.name, list)
    }
    if (prepend) list.unshift(hook)
    else list.push(hook)
    return () => {
      const current = this.hooks.get(hook.name)
      if (!current) return
      const index = current.indexOf(hook)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.hooks.delete(hook.name)
    }
  }

  observe(observer: Observer): () => void {
    this.observers.push(observer)
    return () => {
      const index = this.observers.indexOf(observer)
      if (index >= 0) this.observers.splice(index, 1)
    }
  }

  /**
   * Admission rule: a dispatch reaches unscoped listeners and `global`
   * listeners, plus — when it carries a scope — the listeners of that same
   * scope. A scoped listener therefore never sees a dispatch about another
   * scope or about no scope at all; it observes its own subject only.
   */
  select(name: string, scope: unknown): Hook['fn'][] {
    const list = this.hooks.get(name)
    if (!list) return []
    return list
      .filter((hook) => hook.global || hook.scope === undefined || (scope !== undefined && hook.scope === scope))
      .map((hook) => hook.fn)
  }

  /** Runs observers before delivery. An observer throw rejects the dispatch. */
  preflight(info: DispatchInfo): void {
    const snapshot = this.observers.slice()
    for (const observer of snapshot) observer(info)
  }

  listenerCount(name: string): number {
    return this.hooks.get(name)?.length ?? 0
  }
}
