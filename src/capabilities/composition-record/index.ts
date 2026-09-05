/**
 * Records which composition produced a session: a log-only
 * `composition/applied` event, folded by `findLast`, written only when it
 * differs from the last recorded one — the `request/header` discipline.
 * The append happens at agent creation, BEFORE session publication, so a
 * fresh snapshot carries it, a resume's attach delta carries it exactly once,
 * and a resume under an unchanged composition logs nothing. A fork inherits
 * the stamp inside its boundary the same way. Row configs never enter the
 * log — the hash covers them.
 */
import type { Plugin } from '../../kernel/index.ts'
import { AGENT_CREATED } from '../../core/agent/events.ts'
import { eventKind, matches, type EventEnvelope } from '../../core/session/index.ts'

export interface CompositionAppliedRow {
  readonly id: string
  readonly plugin: string
  readonly disabled?: boolean
}

export interface CompositionApplied {
  /** sha256/16 over the effective rows including canonicalized JSON-safe configs. */
  readonly hash: string
  /** The layer names that produced the rows, in application order. */
  readonly layers: readonly string[]
  readonly rows: readonly CompositionAppliedRow[]
}

export const COMPOSITION_APPLIED = eventKind<CompositionApplied>('composition/applied')

/** The composition a session currently records, or undefined before the first stamp. */
export function lastComposition(events: readonly EventEnvelope[]): CompositionApplied | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (matches(event, COMPOSITION_APPLIED)) return event.data
  }
  return undefined
}

export interface CompositionRecordConfig {
  readonly descriptor: CompositionApplied
}

export const compositionRecordPlugin: Plugin<CompositionRecordConfig> = {
  name: 'composition-record',
  apply(ctx, config) {
    ctx.on(AGENT_CREATED, (agent) => {
      if (lastComposition(agent.session.facts)?.hash === config.descriptor.hash) return
      agent.session.append(COMPOSITION_APPLIED, config.descriptor)
    })
  },
}
