/**
 * A headless approval answerer. With `approve: true` it grants every request
 * once; otherwise it delegates, so the seam's fail-closed default (`unavailable`)
 * denies. This is the only answerer in a headless run.
 */
import type { Plugin } from '../../kernel/index.ts'
import { APPROVAL_REQUEST, type ApprovalOutcome } from '../../core/approval/index.ts'

export interface ApprovalHeadlessConfig {
  readonly approve?: boolean
}

export const approvalHeadlessPlugin: Plugin<ApprovalHeadlessConfig | undefined> = {
  name: 'approval-headless',
  apply(ctx, config) {
    const approve = config?.approve ?? false
    ctx.on(APPROVAL_REQUEST, async (_request, next): Promise<ApprovalOutcome> => (approve ? 'allowed-once' : next()))
  },
}
