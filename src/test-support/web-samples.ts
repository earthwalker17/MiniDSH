/**
 * One sample of every event kind a browser projection must decide about —
 * shared by the parity gate (`app/web/rows.test.ts`), which holds the browser
 * to the terminal's visibility, and the conversation model's tests
 * (`app/web/conversation.test.ts`), which hold where each visible one lands.
 *
 * Every kind `app/present.ts` renders, every `case` of `rows.js` and every
 * `case` of `conversation.js` needs a sample here: the gate reads those names
 * out of the sources and fails on one without.
 */
import { AGENT_NARROWING, AGENT_OPTIONS, INBOX_SPLICED, SUBAGENT_END, SUBAGENT_START } from '../core/agent/index.ts'
import { APPROVAL_ASKED, APPROVAL_DECIDED, APPROVAL_GRANT, APPROVAL_POLICY } from '../core/approval/index.ts'
import { COMPACTION_APPLIED, COMPACTION_END, COMPACTION_START } from '../core/compaction/index.ts'
import { asAttachmentId } from '../core/attachments/index.ts'
import { EFFECT_RECORDED } from '../core/effects/index.ts'
import { asCallId } from '../core/ids.ts'
import { JOB_END, JOB_START } from '../core/jobs/index.ts'
import { createAssistantMessage, createPluginMessage, createToolResultMessage, createUserMessage } from '../core/llm/message.ts'
import { AUTHORITY_PRESET } from '../core/presets/index.ts'
import { SANDBOX_ACCEPTANCE, SANDBOX_MODE } from '../core/sandbox/index.ts'
import {
  ASSISTANT_CHUNK,
  ASSISTANT_MESSAGE,
  REQUEST_CONTEXT,
  SESSION_LIFECYCLE,
  SESSION_TITLE,
  STEP_END,
  STEP_START,
  TOOL_CALL,
  TOOL_DISPATCH,
  TOOL_RESULT,
  TURN_END,
  TURN_START,
  USER_MESSAGE,
  type EventEnvelope,
  type EventKind,
} from '../core/session/index.ts'

export interface Sample {
  /** The constant's NAME as `present.ts` spells it: what the coverage check reads out of the source. */
  readonly constant: string
  readonly label: string
  readonly event: EventEnvelope
}

let seq = 0
function sample<Data>(constant: string, label: string, kind: EventKind<string, Data>, data: Data, surface = false): Sample {
  const event: EventEnvelope = { type: kind.type, seq: seq++, time: 1, data, ...(surface ? { surfaceOp: { op: 'append' as const } } : {}) }
  return { constant, label, event }
}

const usage = { inputTokens: 1200, outputTokens: 80 }
const image = { type: 'image' as const, attachment: { id: asAttachmentId('sha256-ab'), mediaType: 'image/png' as const, bytes: 10, width: 2, height: 2 }, text: '[image: 2x2 png]' }

export const SAMPLES: readonly Sample[] = [
  sample('USER_MESSAGE', 'a person', USER_MESSAGE, { message: createUserMessage('fix the slug') }, true),
  sample('USER_MESSAGE', 'plugin context', USER_MESSAGE, { message: createPluginMessage('workspace-instructions', 'AGENTS.md says…', 'instructions') }, true),
  // Context is visible whatever its body holds; only a PERSON's empty message has nothing to show.
  sample('USER_MESSAGE', 'empty plugin context', USER_MESSAGE, { message: createPluginMessage('context-runtime', '') }, true),
  sample('USER_MESSAGE', 'an empty message from a person', USER_MESSAGE, { message: createUserMessage('') }, true),
  sample('ASSISTANT_MESSAGE', 'text', ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([{ type: 'text', text: 'done' }], 'deepseek', 'deepseek-v4-flash'), usage }, true),
  sample('ASSISTANT_MESSAGE', 'tool calls only', ASSISTANT_MESSAGE, { turn: 1, step: 1, message: createAssistantMessage([{ type: 'tool-call', id: asCallId('c1'), name: 'pwsh', arguments: '{}' }], 'deepseek', 'deepseek-v4-flash') }, true),
  sample('TOOL_CALL', 'call', TOOL_CALL, { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"node --test"}' }),
  sample('TOOL_RESULT', 'ok', TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: '9/9' }], false) }, true),
  sample('TOOL_RESULT', 'error', TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'no' }], true), error: { name: 'ToolError', code: 'FS_SANDBOX_DENIED' } }, true),
  sample('TOOL_RESULT', 'image', TOOL_RESULT, { turn: 1, step: 1, callId: 'c1', message: createToolResultMessage(asCallId('c1'), [image], false) }, true),
  sample('TURN_END', 'completed', TURN_END, { turn: 1, reason: { kind: 'completed' } }),
  sample('TURN_END', 'error', TURN_END, { turn: 1, reason: { kind: 'error', code: 'MISSING_CREDENTIAL', message: 'set DEEPSEEK_API_KEY' } }),
  sample('TURN_END', 'interrupted', TURN_END, { turn: 1, reason: { kind: 'interrupted' } }),
  sample('SANDBOX_MODE', 'stamp', SANDBOX_MODE, { mode: 'workspace-write', enforcement: 'none', reason: 'initial' }),
  sample('SANDBOX_MODE', 'switch', SANDBOX_MODE, { mode: 'read-only', enforcement: 'none', reason: 'change' }),
  sample('SANDBOX_ACCEPTANCE', 'accepted', SANDBOX_ACCEPTANCE, { accepts: 'none', forMode: 'workspace-write', reason: 'change' }),
  sample('APPROVAL_POLICY', 'policy', APPROVAL_POLICY, { policy: 'ask', reason: 'initial' }),
  sample('APPROVAL_POLICY', 'switch', APPROVAL_POLICY, { policy: 'never', reason: 'change' }),
  sample('AGENT_OPTIONS', 'initial', AGENT_OPTIONS, { options: { provider: 'deepseek', model: 'deepseek-v4-flash' }, reason: 'initial' }),
  sample('AGENT_OPTIONS', 'change', AGENT_OPTIONS, { options: { provider: 'anthropic', model: 'claude-sonnet-5', reasoningEffort: 'high' }, reason: 'change' }),
  sample('AGENT_NARROWING', 'narrowing', AGENT_NARROWING, { tools: [{ deny: ['job_start'], denyTags: ['network'] }], sections: [{ name: 'persona', order: -50, text: 'You are a subagent.' }] }),
  sample('AGENT_NARROWING', 'unreadable', AGENT_NARROWING, { tools: 'all' } as never),
  sample('REQUEST_CONTEXT', 'route', REQUEST_CONTEXT, { provider: 'anthropic', model: 'claude-sonnet-5', contextWindow: 1_000_000 }),
  sample('AUTHORITY_PRESET', 'preset', AUTHORITY_PRESET, { name: 'workspace-write' }),
  sample('APPROVAL_ASKED', 'asked', APPROVAL_ASKED, { id: 'approval-7', toolName: 'pwsh', callId: 'c1', reason: 'run under "danger-full-access": tests' }),
  sample('APPROVAL_ASKED', 'with a subject', APPROVAL_ASKED, {
    id: 'approval-9',
    toolName: 'pwsh',
    callId: 'c2',
    reason: 'run under "danger-full-access": tests',
    subject: { effect: 'shell-command', command: 'pnpm check', mode: 'danger-full-access', enforcement: 'none' },
  }),
  sample('APPROVAL_ASKED', 'with a network subject', APPROVAL_ASKED, {
    id: 'approval-10',
    toolName: 'web_search',
    callId: 'c3',
    subject: { effect: 'network-request', destination: 'https://api.tavily.com/search', credential: 'TAVILY_API_KEY', payload: 'node 24 lts date' },
  }),
  sample('APPROVAL_DECIDED', 'decided', APPROVAL_DECIDED, { id: 'approval-7', outcome: 'allowed-once' }),
  sample('APPROVAL_DECIDED', 'decided by a person', APPROVAL_DECIDED, { id: 'approval-9', outcome: 'allowed-once', decidedBy: 'user' }),
  sample('APPROVAL_GRANT', 'granted', APPROVAL_GRANT, {
    op: 'grant',
    id: 'grant-11',
    toolName: 'pwsh',
    subject: { effect: 'shell-command', command: 'pnpm check', mode: 'danger-full-access', enforcement: 'none' },
    fromApproval: 'approval-9',
  }),
  sample('APPROVAL_GRANT', 'granted a network request', APPROVAL_GRANT, {
    op: 'grant',
    id: 'grant-12',
    toolName: 'web_search',
    subject: { effect: 'network-request', destination: 'https://api.tavily.com/search', credential: 'TAVILY_API_KEY', payload: 'node 24 lts date' },
    fromApproval: 'approval-10',
  }),
  sample('APPROVAL_GRANT', 'revoked', APPROVAL_GRANT, { op: 'revoke', id: 'grant-11' }),
  sample('EFFECT_RECORDED', 'fs write', EFFECT_RECORDED, { callId: 'c1', effect: 'fs-write', path: '/ws/notes.txt', bytes: 15, sha256: 'a1b2c3d4e5f6a7b8c9d0' }),
  sample('EFFECT_RECORDED', 'shell command', EFFECT_RECORDED, { callId: 'c1', effect: 'shell-command', exitCode: 0, durationMs: 1234, mode: 'workspace-write', enforcement: 'full' }),
  sample('EFFECT_RECORDED', 'shell command killed', EFFECT_RECORDED, { callId: 'c1', effect: 'shell-command', durationMs: 120_000, mode: 'read-only', enforcement: 'none', timedOut: true }),
  sample('SUBAGENT_START', 'start', SUBAGENT_START, { callId: 'c2', childId: 's-child', depth: 1, provider: 'deepseek', model: 'deepseek-v4-flash', sandbox: 'read-only', approval: 'never' }),
  sample('SUBAGENT_END', 'end', SUBAGENT_END, { callId: 'c2', childId: 's-child', reason: { kind: 'completed' }, usage }),
  sample('COMPACTION_START', 'start', COMPACTION_START, { trigger: 'explicit', budgetTokens: 1000, projectedTokens: 900, plannedStart: 2, plannedEnd: 9, plannedNodes: 6 }),
  sample('COMPACTION_END', 'applied', COMPACTION_END, { startSeq: 3, outcome: { kind: 'applied' } }),
  sample('COMPACTION_END', 'declined', COMPACTION_END, { startSeq: 3, outcome: { kind: 'declined', reason: 'summary-not-smaller' } }),
  sample('COMPACTION_APPLIED', 'applied', COMPACTION_APPLIED, {
    trigger: 'explicit',
    budgetTokens: 1000,
    projectedTokens: 900,
    surfaceTokensBefore: 800,
    surfaceTokensAfter: 200,
    shadowedSeqs: [2, 3, 4],
    retainedNodes: 2,
    auxCallSeq: 11,
    startSeq: 9,
  }),
  sample('JOB_START', 'started', JOB_START, { jobId: 'job-0123456789abcdef', callId: 'c4', kind: 'shell', label: 'pnpm dev', pid: 4242, mode: 'workspace-write', enforcement: 'none' }),
  sample('JOB_START', 'no pid', JOB_START, { jobId: 'job-0123456789abcdee', kind: 'shell', label: 'pnpm test --watch', mode: 'read-only', enforcement: 'full' }),
  sample('JOB_END', 'exited', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'exited', exitCode: 0, durationMs: 12_300, outputBytes: 80 }),
  sample('JOB_END', 'signalled', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'exited', signal: 'SIGTERM' }),
  sample('JOB_END', 'failed', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'failed', detail: 'bwrap: setting up uid map: Permission denied' }),
  sample('JOB_END', 'cancelled by the model', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'cancelled', by: 'model', reportedBy: 'c5', durationMs: 900 }),
  sample('JOB_END', 'cancelled by a person', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'cancelled', by: 'user' }),
  sample('JOB_END', 'cancelled by the authority', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'cancelled', by: 'authority' }),
  sample('JOB_END', 'cancelled by a disposal', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'cancelled', by: 'disposal', durationMs: 61_000 }),
  sample('JOB_END', 'lost', JOB_END, { jobId: 'job-0123456789abcdef', cause: 'lost' }),
  // Kinds neither projection renders. Listed so that giving one of them a line
  // in EITHER projection fails here until the other is decided too.
  sample('TURN_START', 'structure', TURN_START, { turn: 1 }),
  sample('STEP_START', 'structure', STEP_START, { turn: 1, step: 1 }),
  sample('STEP_END', 'structure', STEP_END, { turn: 1, step: 1 }),
  // Pure structure, like the two above: the gate-to-body fact is one per tool
  // call and says nothing a reader wants in a transcript. Listed so that giving
  // it a line in EITHER projection fails here until the other is decided too.
  sample('TOOL_DISPATCH', 'structure', TOOL_DISPATCH, { turn: 1, step: 1, callId: 'c1' }),
  sample('ASSISTANT_CHUNK', 'trace', ASSISTANT_CHUNK, { turn: 1, step: 1, attempt: 1, chunk: { type: 'text-delta', index: 0, text: 'd' } }),
  sample('INBOX_SPLICED', 'inbox', INBOX_SPLICED, { op: 'clear' }),
  sample('SESSION_TITLE', 'title', SESSION_TITLE, { title: 'fix the slug', messageSeqs: [2], source: { kind: 'fallback' } }),
  // The opening of every lifecycle: structure the conversation model reads (a
  // new lifecycle's stamps are an opening again), with a line in neither.
  sample('SESSION_LIFECYCLE', 'structure', SESSION_LIFECYCLE, { origin: 'new', dispatch: true, durability: 'synced' }),
]

/** The sample with this constant and label. */
export function sampleEvent(constant: string, label: string): EventEnvelope {
  const found = SAMPLES.find((entry) => entry.constant === constant && entry.label === label)
  if (!found) throw new Error(`no sample ${constant} (${label})`)
  return found.event
}
