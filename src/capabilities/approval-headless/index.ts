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
import { clampIntent, intentKey, MAX_INTENT_CHARS } from '../../core/effects/index.ts'
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
          // Bounded by the same cap the subject is: past it an intent is
          // `truncated` and has no key at all, so a longer entry could only
          // ever be a row that silently matches nothing. The contract refuses
          // it at boot, naming the row, as every shipped config does.
          command: z.string().min(1).max(MAX_INTENT_CHARS),
          mode: z.enum(SANDBOX_MODES as [SandboxMode, ...SandboxMode[]]),
          enforcement: z.enum(['full', 'partial', 'none']).optional(),
        }),
      )
      .optional(),
  })
  .optional()

/**
 * The allow-list as keys, built once at mount: a list this long is a lookup,
 * not a scan.
 *
 * Every entry goes through `clampIntent` — the SAME normalization the seam
 * applies to a live subject before keying it. Keying the raw config string
 * instead would disagree with the request side in both directions: an entry
 * naming a two-line script could never match (a dead row, silently), and an
 * entry naming a one-line command could match a two-line one the author never
 * wrote. A row whose key cannot exist at all (the cut at `MAX_INTENT_CHARS`)
 * fails the boot naming itself, because a silently inert allow entry is how an
 * unattended run stops for a reason nobody can see.
 */
function allowedKeys(allow: readonly HeadlessAllowEntry[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const entry of allow) {
    const key = intentKey(
      entry.tool,
      clampIntent({
        effect: 'shell-command',
        command: entry.command,
        mode: entry.mode,
        enforcement: entry.enforcement ?? 'none',
      }),
    )
    if (key === undefined) throw new Error(`approval-headless: allow entry for "${entry.tool}" has a command too long to identify; shorten it or drop the entry`)
    keys.add(key)
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
