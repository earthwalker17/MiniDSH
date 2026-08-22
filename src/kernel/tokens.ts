/**
 * Typed tokens for services and events.
 *
 * MiniDSH does not use declaration merging: a service is addressed by a
 * `ServiceKey<T>` and an event by an `EventKey` that carries its dispatch mode
 * in the type, so dispatching an event with the wrong method is a compile
 * error. Tokens are plain frozen objects whose `name` appears in logs.
 */

export interface ServiceKey<T> {
  readonly kind: 'service'
  readonly name: string
  /** Phantom field (covariant); never set at runtime. */
  readonly __type?: T
}

/** Declare a service key. One key per `ctx` slot; the owner module exports it. */
export function serviceKey<T>(name: string): ServiceKey<T> {
  return Object.freeze({ kind: 'service', name }) as ServiceKey<T>
}

export type DispatchMode = 'emit' | 'waterfall' | 'serial' | 'parallel'

export interface EventKey<M extends DispatchMode, A extends unknown[], R> {
  readonly kind: 'event'
  readonly mode: M
  readonly name: string
  /** Phantom fields (covariant); never set at runtime. */
  readonly __args?: A
  readonly __ret?: R
}

/** A synchronous fire-and-forget notification; listener exceptions are contained. */
export function emitEvent<A extends unknown[]>(name: string): EventKey<'emit', A, void> {
  return Object.freeze({ kind: 'event', mode: 'emit', name }) as EventKey<'emit', A, void>
}

/**
 * Around-middleware. Listeners receive `(...args, next)`; calling `next()`
 * delegates to the next listener and finally to the dispatcher's own
 * continuation. Returning without calling `next()` short-circuits the chain.
 */
export function waterfallEvent<A extends unknown[], R>(name: string): EventKey<'waterfall', A, R> {
  return Object.freeze({ kind: 'event', mode: 'waterfall', name }) as EventKey<'waterfall', A, R>
}

/** Awaited in registration order; used for ordered checkpoints. */
export function serialEvent<A extends unknown[]>(name: string): EventKey<'serial', A, void> {
  return Object.freeze({ kind: 'event', mode: 'serial', name }) as EventKey<'serial', A, void>
}

/** Awaited fan-out (`allSettled`); every listener gets an independent chance. */
export function parallelEvent<A extends unknown[]>(name: string): EventKey<'parallel', A, void> {
  return Object.freeze({ kind: 'event', mode: 'parallel', name }) as EventKey<'parallel', A, void>
}

export type AnyEventKey = EventKey<DispatchMode, unknown[], unknown>

/** The listener signature an event key admits, derived from its mode. */
export type Listener<K extends AnyEventKey> =
  K extends EventKey<'emit', infer A, unknown> ? (...args: A) => void
  : K extends EventKey<'waterfall', infer A, infer R> ? (...args: [...A, () => R]) => R
  : K extends EventKey<'serial', infer A, unknown> ? (...args: A) => void | Promise<void>
  : K extends EventKey<'parallel', infer A, unknown> ? (...args: A) => void | Promise<void>
  : never
