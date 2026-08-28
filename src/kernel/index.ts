/**
 * MiniDSH kernel — the composition substrate.
 *
 * Five mechanisms, nothing more: non-mutating child contexts with scope tags,
 * plugin instances as ownership boundaries with ordered effect lists,
 * epoch-gated activation from declared dependencies, a single-claim service
 * store, and a typed event bus whose tokens carry their dispatch mode.
 */
export { Context, createRoot, describeConfigError } from './context.ts'
export type { ConfigSchema, Plugin, PluginHandle, PluginState, SettleReport, ListenOptions, RootOptions } from './context.ts'
export type { Disposer, EffectCleanup, DispatchInfo, Logger, Observer } from './bus.ts'
export { KernelError } from './errors.ts'
export type { KernelErrorCode } from './errors.ts'
export { serviceKey, emitEvent, waterfallEvent, serialEvent, parallelEvent } from './tokens.ts'
export type { ServiceKey, EventKey, AnyEventKey, DispatchMode, Listener } from './tokens.ts'
