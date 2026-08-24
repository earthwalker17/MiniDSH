/**
 * Authority presets: one product-facing selector over the two canonical
 * authority knobs. A preset owns NO enforcement — applying one writes through
 * `sandbox.setMode` and `approval.setPolicy`, whose change-gating and closed
 * vocabularies stand untouched — and the selection itself is recorded as a
 * log-only intent event. The current preset is DERIVED from the two folds:
 * `custom` is what a pair matching no table entry displays as, and it is
 * never a switch target and never an event payload.
 */
import { serviceKey } from '../../kernel/index.ts'
import type { ApprovalPolicy } from '../approval/index.ts'
import type { SandboxMode } from '../sandbox/index.ts'
import { isApprovalPolicy } from '../approval/index.ts'
import { isSandboxMode } from '../sandbox/index.ts'
import { eventKind } from '../session/types.ts'
import type { Session } from '../session/session.ts'

export interface AuthorityPresetSpec {
  readonly sandbox: SandboxMode
  readonly approval: ApprovalPolicy
  readonly description?: string
}

export interface AuthorityState {
  readonly sandbox: SandboxMode
  readonly approval: ApprovalPolicy
}

/** Reserved: the displayable non-preset. Never a table key, never applied. */
export const CUSTOM_PRESET = 'custom'

/** The shipped table (DSH's exact two); `read-only` stays a legal mode no preset selects. */
export const DEFAULT_PRESETS: Readonly<Record<string, AuthorityPresetSpec>> = {
  'workspace-write': {
    sandbox: 'workspace-write',
    approval: 'ask',
    description: 'Write inside the workspace; anything wider needs approval.',
  },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    description: 'Full file access without approval prompts.',
  },
}

/** Validates a configured table (falling back to the shipped one); broken config throws, never mounts. */
export function presetTable(specs?: Readonly<Record<string, AuthorityPresetSpec>>): ReadonlyMap<string, AuthorityPresetSpec> {
  const table = new Map<string, AuthorityPresetSpec>()
  for (const [name, spec] of Object.entries(specs ?? DEFAULT_PRESETS)) {
    if (name.trim().length === 0) throw new Error('authority preset names must be non-empty')
    if (name === CUSTOM_PRESET) throw new Error(`"${CUSTOM_PRESET}" is reserved for the derived non-preset state and cannot be a table entry`)
    if (!isSandboxMode(spec.sandbox)) throw new Error(`authority preset "${name}" names an unknown sandbox mode ${JSON.stringify(spec.sandbox)}`)
    if (!isApprovalPolicy(spec.approval)) throw new Error(`authority preset "${name}" names an unknown approval policy ${JSON.stringify(spec.approval)}`)
    table.set(name, spec)
  }
  return table
}

/** Pure derivation: the first table entry the pair matches, else `custom`. */
export function presetFor(table: ReadonlyMap<string, AuthorityPresetSpec>, state: AuthorityState): string {
  for (const [name, spec] of table) {
    if (spec.sandbox === state.sandbox && spec.approval === state.approval) return name
  }
  return CUSTOM_PRESET
}

/** Log-only user intent; the knob events that follow it are the truth a reader folds. */
export const AUTHORITY_PRESET = eventKind<{ name: string }>('authority/preset')

export interface AuthorityPresets {
  names(): readonly string[]
  get(name: string): AuthorityPresetSpec | undefined
  /** Derived current preset for a live pair (`initialize` uses the deployment defaults). */
  selectFor(state: AuthorityState): string
  /** Derived current preset from a session's folds. */
  selectForSession(session: Session): string
  /** Validate → append the intent event → write through both canonical setters. */
  apply(session: Session, name: string): void
}

export const PRESETS = serviceKey<AuthorityPresets>('authority-presets')
