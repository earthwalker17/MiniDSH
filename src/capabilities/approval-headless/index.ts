/**
 * A headless approval answerer. With `approve: true` it grants every request
 * once; otherwise it delegates, so the seam's fail-closed default (`unavailable`)
 * denies. This is the only answerer in a headless run.
 *
 * Between those two there is one rung: `allow`, a composition-declared list of
 * EXACT subjects this deployment will approve unattended. It exists because
 * `--approve` is all-or-nothing — a CI run that needs one command gets the
 * authority to run any of them — and because a tool-NAME list would be
 * `--approve` for that tool by another name. Keyed through the same
 * `intentKey` a grant is, so what it can express is exactly what the runtime
 * can identify, and no more: no prefixes, no patterns, no parser.
 *
 * It answers `auto`, never `user`: nobody was asked, and an audit that
 * recorded a config file as a person would be worse than one that recorded
 * nothing. It is also never a grant — a grant is a consent somebody gave, and
 * no host offers a scope in a headless run.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { APPROVAL_REQUEST, type ApprovalAnswer } from '../../core/approval/index.ts'
import { intentKey } from '../../core/effects/index.ts'
import { SANDBOX_MODES, type SandboxMode } from '../../core/sandbox/index.ts'

/** One exact action this deployment approves without asking anyone. */
export interface HeadlessAllowEntry {
  readonly tool: string
  readonly command: string
  /** The mode the command would run under; the same field the subject carries, because it is part of the identity. */
  readonly mode: SandboxMode
  /** What the host would deliver (default `none`: a host with no backend, which is where unattended runs need this). */
  readonly enforcement?: 'full' | 'partial' | 'none' | undefined
}

export interface ApprovalHeadlessConfig {
  readonly approve?: boolean | undefined
  readonly allow?: readonly HeadlessAllowEntry[] | undefined
}

const configSchema = z
  .strictObject({
    approve: z.boolean().optional(),
    allow: z
      .array(
        z.strictObject({
          tool: z.string().min(1),
          command: z.string().min(1),
          mode: z.enum(SANDBOX_MODES as [SandboxMode, ...SandboxMode[]]),
          enforcement: z.enum(['full', 'partial', 'none']).optional(),
        }),
      )
      .optional(),
  })
  .optional()

/** The allow-list as keys, built once at mount: a list this long is a lookup, not a scan. */
function allowedKeys(allow: readonly HeadlessAllowEntry[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const entry of allow) {
    const key = intentKey(entry.tool, {
      effect: 'shell-command',
      command: entry.command,
      mode: entry.mode,
      enforcement: entry.enforcement ?? 'none',
    })
    if (key !== undefined) keys.add(key)
  }
  return keys
}

export const approvalHeadlessPlugin: Plugin<ApprovalHeadlessConfig | undefined> = {
  name: 'approval-headless',
  config: configSchema,
  apply(ctx, config) {
    const approve = config?.approve ?? false
    const allowed = allowedKeys(config?.allow ?? [])
    // `auto`, and it says so: nobody was asked. An audit that recorded a flag
    // as a person would be worse than one that recorded nothing.
    ctx.on(APPROVAL_REQUEST, async (request, next): Promise<ApprovalAnswer> => {
      if (approve) return { outcome: 'allowed-once', by: 'auto' }
      // No subject means no identity, so nothing here can match it.
      const key = request.subject === undefined ? undefined : intentKey(request.toolName, request.subject)
      if (key !== undefined && allowed.has(key)) return { outcome: 'allowed-once', by: 'auto' }
      return next()
    })
  },
}
