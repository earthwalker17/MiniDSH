/**
 * Model roles: a composition row that routes a call by its PURPOSE — the
 * compaction summary down a cheaper model, a delegated child down an
 * independent one — as one `agent/request` listener over the base route.
 *
 * A role is composition, never settings: the row's config is part of what
 * `composition/applied` hashes, so a session records the routing it ran
 * under. Purpose never changes wire bytes — an adapter never sees it — and
 * the route a role chose is what the log records anyway (the `llm/aux-call`
 * record's provider/model, a child's own `agent/options`). A loop step has
 * no purpose and is never rerouted here: the base route, switchable through
 * `Agent.configure`, is what a step runs on.
 *
 * DSH has no such seam — its `purpose` is only an adapter-visible tag, and
 * each auxiliary producer carries its own optional provider/model pair.
 * MiniDSH's design: one table, one listener, one path (`resolveCallConfig`)
 * every out-of-loop call already takes.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { AGENT_REQUEST, type CallConfig } from '../../core/agent/index.ts'

export interface ModelRole {
  readonly provider: string
  readonly model: string
  /** Adapter-owned effort id for THIS route; the base's effort never carries over (ids mean nothing across adapters). */
  readonly reasoningEffort?: string | undefined
  readonly maxTokens?: number | undefined
}

export interface ModelRolesConfig {
  /** Purpose → route. Known purposes today: `compaction`, `subagent`; an unknown purpose passes through. */
  readonly roles?: Readonly<Record<string, ModelRole>> | undefined
}

const configSchema = z
  .strictObject({
    roles: z
      .record(
        z.string().min(1),
        z.strictObject({
          provider: z.string().min(1),
          model: z.string().min(1),
          reasoningEffort: z.string().min(1).optional(),
          maxTokens: z.number().int().positive().optional(),
        }),
      )
      .optional(),
  })
  .optional()

/** The route a role names, as a whole call config: nothing of the base survives but what the role restates. */
export function routeFor(role: ModelRole): CallConfig {
  return {
    provider: role.provider,
    model: role.model,
    ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
    ...(role.maxTokens === undefined ? {} : { maxTokens: role.maxTokens }),
  }
}

export const modelRolesPlugin: Plugin<ModelRolesConfig | undefined> = {
  name: 'model-roles',
  config: configSchema,
  apply(ctx, config) {
    const roles = config?.roles ?? {}
    ctx.on(
      AGENT_REQUEST,
      async (context, next) => {
        const base = await next()
        if (context.purpose === undefined) return base
        const role = roles[context.purpose]
        return role === undefined ? base : routeFor(role)
      },
      { global: true },
    )
  },
}
