/**
 * The authority-presets provider: a configured (or shipped) table over the
 * two canonical setters. It owns no enforcement and holds no state — the
 * current preset is derived from the session's folds on every ask. The
 * capability registers its own invariant (the first capability-owned one):
 * a forged `authority/preset` naming an unknown preset is rejected
 * pre-commit; `apply` itself validates too, so the refusal stands even in a
 * composition that runs without invariants.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { APPROVAL, APPROVAL_POLICIES, type Approval } from '../../core/approval/index.ts'
import { INVARIANTS } from '../../core/invariants/index.ts'
import {
  AUTHORITY_PRESET,
  presetFor,
  presetTable,
  PRESETS,
  type AuthorityPresets,
  type AuthorityPresetSpec,
  type AuthorityState,
} from '../../core/presets/index.ts'
import { effectiveSandboxMode, SANDBOX, SANDBOX_MODES, type Sandbox } from '../../core/sandbox/index.ts'
import { matches, SESSION_EVENT, type EventEnvelope, type Session } from '../../core/session/index.ts'

export interface AuthorityPresetsConfig {
  /** Replaces the shipped table wholesale when given (`custom` stays reserved). */
  readonly presets?: Readonly<Record<string, AuthorityPresetSpec>> | undefined
}

const configSchema = z
  .strictObject({
    presets: z
      .record(
        z.string().min(1),
        z.strictObject({ sandbox: z.enum(SANDBOX_MODES), approval: z.enum(APPROVAL_POLICIES), description: z.string().optional() }),
      )
      .optional(),
  })
  .optional()

class PresetService implements AuthorityPresets {
  private readonly table: ReadonlyMap<string, AuthorityPresetSpec>
  private readonly sandbox: Sandbox
  private readonly approval: Approval
  constructor(table: ReadonlyMap<string, AuthorityPresetSpec>, sandbox: Sandbox, approval: Approval) {
    this.table = table
    this.sandbox = sandbox
    this.approval = approval
  }

  names(): readonly string[] {
    return [...this.table.keys()]
  }

  get(name: string): AuthorityPresetSpec | undefined {
    return this.table.get(name)
  }

  selectFor(state: AuthorityState): string {
    return presetFor(this.table, state)
  }

  selectForSession(session: Session): string {
    // Reading is not an effect: fold + defaults, never `resolve()`.
    return this.selectFor({
      sandbox: effectiveSandboxMode(session.facts) ?? this.sandbox.defaultMode,
      approval: this.approval.policyFor(session),
    })
  }

  apply(session: Session, name: string): void {
    const spec = this.table.get(name)
    if (!spec) throw new Error(`unknown authority preset "${name}" (known: ${this.names().join(', ')})`)
    session.append(AUTHORITY_PRESET, { name })
    this.sandbox.setMode(session, spec.sandbox)
    this.approval.setPolicy(session, spec.approval)
  }
}

export const authorityPresetsPlugin: Plugin<AuthorityPresetsConfig | undefined> = {
  name: 'authority-presets',
  inject: [SANDBOX, APPROVAL],
  config: configSchema,
  apply(ctx, config) {
    const table = presetTable(config?.presets)
    ctx.provide(PRESETS, new PresetService(table, ctx.get(SANDBOX), ctx.get(APPROVAL)))
    // tryGet, not inject: a composition that disables the invariants row must
    // not leave this row pending forever. The stateless check needs no trace.
    ctx.tryGet(INVARIANTS)?.register(ctx, 'authority-presets', (ictx, fail) => {
      ictx.observe((info) => {
        if (info.name !== SESSION_EVENT.name) return
        const event = info.args[1] as EventEnvelope
        if (!matches(event, AUTHORITY_PRESET)) return
        // A possibly-forged payload: read it as unknown, never through `matches`.
        const name = (event.data as Record<string, unknown> | null)?.name
        if (typeof name !== 'string' || !table.has(name)) {
          fail(`authority/preset names an unknown preset ${JSON.stringify(name)}`)
        }
      })
    })
  },
}
