/**
 * A headless approval answerer. With `approve: true` it grants every request
 * once; otherwise it delegates, so the seam's fail-closed default (`unavailable`)
 * denies. This is the only answerer in a headless run.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { APPROVAL_REQUEST, type ApprovalAnswer } from '../../core/approval/index.ts'

export interface ApprovalHeadlessConfig {
  readonly approve?: boolean | undefined
}

const configSchema = z.strictObject({ approve: z.boolean().optional() }).optional()

export const approvalHeadlessPlugin: Plugin<ApprovalHeadlessConfig | undefined> = {
  name: 'approval-headless',
  config: configSchema,
  apply(ctx, config) {
    const approve = config?.approve ?? false
    // `auto`, and it says so: nobody was asked. An audit that recorded a flag
    // as a person would be worse than one that recorded nothing.
    ctx.on(APPROVAL_REQUEST, async (_request, next): Promise<ApprovalAnswer> => (approve ? { outcome: 'allowed-once', by: 'auto' } : next()))
  },
}
