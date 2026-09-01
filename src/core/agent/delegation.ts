/**
 * The delegation VOCABULARY: the two log-only records a parent writes about a
 * child it started. Split from the tool that writes them for the same reason
 * `approval/events.ts` and `sandbox/events.ts` are split from their services —
 * delegation is a runtime concept the log records, not one tool's private
 * bookkeeping, and more than one module has to be able to name it.
 *
 * The lineage half already lives here: `SessionHeader.delegatedBy` and
 * `delegationDepth` are session facts, `agents.fork` refuses a boundary that
 * would cut below a child's opening stamps, and the ceiling and the pin are
 * folds over `core/sandbox` and `core/approval`. Only the LIFECYCLE half sat in
 * a capability, which had two costs: `app/present.ts` — the one projection every
 * plain-text surface shares — was the sole app module importing a capability for
 * its vocabulary, and no capability could name a delegation at all, because a
 * capability may not import another (`scripts/check-deps.ts`).
 *
 * Both records live in the PARENT's session. The child's own steps live in the
 * child's own log; `sessions show <child>` is where they are read.
 */
import { eventKind, type TurnEndReason } from '../session/index.ts'
import type { TokenUsage } from '../llm/types.ts'
import type { SandboxMode } from '../sandbox/events.ts'

/** Log-only, in the PARENT's session: which child was started for which call, and under what. */
export const SUBAGENT_START = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly depth: number
  readonly provider: string
  readonly model: string
  readonly sandbox: SandboxMode
  readonly approval: 'never'
}>('subagent/start')

/** Log-only, in the PARENT's session: how the child's turn ended, and what it cost. */
export const SUBAGENT_END = eventKind<{
  readonly callId: string
  readonly childId: string
  readonly reason: TurnEndReason
  readonly usage?: TokenUsage
}>('subagent/end')
