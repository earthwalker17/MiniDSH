/**
 * Runtime invariant registry.
 *
 * Invariants observe authoritative event streams or mutable data and call
 * `fail()` on a violation. They are package-owned (each names itself), run in a
 * disposable child context, and are config-selectable so shipped compositions
 * can omit them. The always-on structural checks (session immutability, seq
 * contiguity, surface validity) live in the owning module, not here.
 */
import { z } from 'zod'
import { KernelError, serviceKey, type Context, type Disposer, type Plugin, type ServiceKey } from '../../kernel/index.ts'

export type InvariantFailure = (message: string) => never

export interface InvariantInstaller {
  (ctx: Context, fail: InvariantFailure): void | Promise<void>
  readonly inject?: readonly ServiceKey<unknown>[]
}

export class InvariantError extends Error {
  readonly code = 'INVARIANT' as const
  readonly packageName: string
  constructor(packageName: string, message: string) {
    super(`invariant violated by "${packageName}": ${message}`)
    this.name = 'InvariantError'
    this.packageName = packageName
  }
}

export interface Invariants {
  register(owner: Context, packageName: string, installer: InvariantInstaller): Disposer
}

export const INVARIANTS = serviceKey<Invariants>('invariants')

export interface InvariantsConfig {
  /** Master switch (default true). */
  readonly enabled?: boolean | undefined
  /** If non-empty, only these package names are active. */
  readonly allow?: readonly string[] | undefined
  /** These package names are never active. */
  readonly block?: readonly string[] | undefined
}

const configSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    allow: z.array(z.string()).optional(),
    block: z.array(z.string()).optional(),
  })
  .optional()

class InvariantRegistry implements Invariants {
  private readonly reserved = new Set<string>()
  private readonly config: InvariantsConfig
  constructor(config: InvariantsConfig) {
    this.config = config
  }

  private selected(name: string): boolean {
    if (this.config.enabled === false) return false
    if (this.config.allow && this.config.allow.length > 0 && !this.config.allow.includes(name)) return false
    if (this.config.block && this.config.block.includes(name)) return false
    return true
  }

  register(owner: Context, packageName: string, installer: InvariantInstaller): Disposer {
    if (packageName.length === 0 || packageName.trim() !== packageName) {
      throw new Error(`invalid invariant package name ${JSON.stringify(packageName)}`)
    }
    // Invariants observe the whole root; one registered from an agent scope
    // would police every agent and die with one of them. Deployment-global only.
    if (owner.scope !== undefined) {
      throw new KernelError('SCOPED_OWNER', `invariant "${packageName}" cannot be registered from a scoped context; invariants are deployment-global`)
    }
    if (this.reserved.has(packageName)) throw new Error(`invariant "${packageName}" is already registered`)
    this.reserved.add(packageName)
    let disposeChild: Disposer = async () => {}
    if (this.selected(packageName)) {
      const child = owner.child({ label: `invariant:${packageName}` })
      const fail: InvariantFailure = (message) => {
        throw new InvariantError(packageName, message)
      }
      void installer(child, fail)
      disposeChild = () => child.dispose()
    }
    return owner.effect(() => async () => {
      this.reserved.delete(packageName)
      await disposeChild()
    }, `invariant("${packageName}")`)
  }
}

/** Provides `ctx.invariants`. Omit from shipped compositions; mount in tests and E2E. */
export const invariantsPlugin: Plugin<InvariantsConfig | undefined> = {
  name: 'core-invariants',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(INVARIANTS, new InvariantRegistry(config ?? {}))
  },
}
