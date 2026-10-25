# DSH reference: Execution: loop, tools, jobs, delegation

> Where to research DSH's loop, tool pipeline, jobs and delegation: pinned to `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, dsh-v0.2.1-rc.3), checked 2026-10-25 in S20.5 ([reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| Agent loop | `packages/core/agent-loop` | default | Inbox lanes (`followup` next turn, `steer` next step, both wake; `inject` never wakes); turn/step machine; `maxParallelToolCalls` (10) read per batch |
| Tool registry | `packages/core/tools` | default | Step-admitted `ResolvedToolSet` (`when` conditions, rc.2); `src/batch.ts` schedules a batch; `src/presentation.ts` the UI cards |
| Executors | `packages/core/tool-executor-{native,ptc}` | base; PTC row disabled | One per scope since rc.2: parsing, scheduling, cancellation, `tool/call`/`tool/result` logging |
| Subprocess, shell | `packages/subprocess`, `packages/shell` | default | Managed spawn (systemd scope, Windows Job, else a process group); every bash/pwsh command is a job from its start |
| Jobs | `packages/jobs/*`; `packages/api/job-controller` (web-app) | base; not `minimal` | `ctx.jobs` in memory, owner-fenced, capped; log-only `job/registered`/`job/settled`; producers: shell, workflow, experimental terminal; `job.list\|follow\|kill` |
| Subagents | `packages/subagent` | base | `subagent` (spawn), `subagent_fork`; `send_message`, `interrupt_agent`, `list_agents` in one row (rc.1); no child is a job |
| Workflow | `packages/workflow` | base | Model-written script; root runs bracketed in the parent log; a background run is a `workflow` job |
| Schedule | `packages/schedule/schedule` | web-app, sdk-app | Host-wide reminders, a follow-up in the origin Session via `schedule/resolve-agent` |
| Teams | `packages/experimental/agent-team{,-profile}` | experimental, bundle off | Lead, teammates, task board over direct inbox delivery |
| Persistent PTY | `packages/terminal`, `packages/experimental/tool-terminal` | `minimal`'s shell; bundle off | For model tools, not a TUI |
| Instructions | `packages/context/agent-instructions` | base | `AGENTS.md` as a durable `user/message`, each chain capped apart (rc.1), refreshed by fs touches |

## Open for the route

- **S21, continuable children.** A local child is a durable Session plus at most one resident activation, never a job; every delegation returns `started subagent <id>` at once and is `isConcurrencySafe`: siblings in one message start together; `maxActiveSubagents` (8 per activation tree) refuses with `ACTIVATION_LIMIT_REACHED`, never queues; external backends run once. `packages/subagent/subagent/README.md`
- **S21, settlement.** The parent gets `{kind:'subagent-settled', form:'notice'}`: followup when idle, steer when busy, inject in its closing teardown, under no wake budget. The guidance says to end the turn, not sleep or poll (restored 2026-10-20 on a measured probe). `packages/subagent/subagent/src/manager.ts`, `packages/subagent/tool-subagent/src/index.ts`
- **S21, send and interrupt.** `send_message` needs the exact live sender and adjacency: it steers a working target, wakes or cold-resumes an inactive direct child, returns acceptance only, framed `{kind:'agent-message', form:'relay'}`. `interrupt_agent` ends a local child's current turn only: its queue stays parked, descendants run on. `packages/subagent/tool-subagent-control/README.md`
- **S21, parallel calls.** `executeToolBatch`: an exact `true` joins a rolling pool, anything else is a barrier, reclassified before each start; a call's `tool/call` is logged as it starts; pre-execute, guards and approval run in model order, only bodies overlap; results commit in model order citing their call's seq; after cancellation unstarted calls get synthetic `tool/call` + `ABORTED_BEFORE_DISPATCH` pairs. `packages/core/tools/src/batch.ts`
- **S21, admission.** A call runs only its step's admitted registration (re-registered mid-step: `UNKNOWN_TOOL`); a successful result may carry `concludesTurn` (plan mode, structured child capture). `docs/upgrade-guide/v0.2.1-rc.2/conditional-tools/guide.md`
- **S21, replay.** Still first-call-order binding, "stronger keying deferred"; `subagent/start|end` are live emits and `subagent/catalog` carries no call id, so nothing upstream keys a child by its call. `packages/test-support/llm-replay/README.md`
- **S21, jobs.** Since 2026-10-21 a notice inlines up to 2,048 B of unread output and a `job_output` wait yields to a user steer; waking is unbounded by default, the retirement-window race open. `packages/jobs/tool-jobs/README.md`
- **S22, tool kind.** `ToolCallKind` (`read|edit|delete|move|search|execute|fetch|other`) on a `generic|terminal|diff|search` card, from `presentCall`/`presentResult`. `packages/core/tools/src/presentation.ts`
- **S22, a person and a child.** A browser prompt to a child picks Queue or Steer; its images enter the attachment store first, refused for a text-only child model. `packages/subagent/subagent/README.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/tool-execution-pipeline.md`, `docs/agent-lifecycle.md`, `packages/core/tools/src/{batch,pipeline}.ts` | Executor-owned batch, ordered policy, pool, fail-closed classification | 2026-10-25 |
| `docs/upgrade-guide/v0.2.1-rc.{1,2}/*` | Executors, conditions, control tools, chain budgets | 2026-10-25 |
| `docs/subsystems/subagent.md`, `packages/subagent/*/README.md`, `packages/subagent/subagent/src/{manager,catalog}.ts` | Activations, capacity, messages, settlement lanes, catalog | 2026-10-25 |
| `docs/subsystems/jobs.md`, `packages/jobs/*/README.md` | Contract, cap, bracket, notices, waits, the idle race | 2026-10-25 |
| `packages/test-support/llm-replay/README.md` | First-call-order binding | 2026-10-25 |
| `packages/bundle/{base,web-app,sdk-app}/cordis.patch.yml` | Which rows mount where | 2026-10-25 |
| `docs/persistence-catalog.md` | `job/*`, `tool-workflow/*`, `subagent/catalog` persist; `subagent/start\|end` do not | 2026-10-25 |

## Likely to go stale

- Executors and step admission landed 2026-10-19..21. The loop README's "Turn and step flow" is truncated upstream.
- The steer-yielding wait is marked a heuristic (`184605873`); the idle-race fix is an unscheduled agent-loop change; the lost-settlement P0 is still proposed (`.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md`).
- Numeric defaults (10 jobs per owner, 10 parallel calls, 8 active children, 2,048 B inline): `docs/config-catalog.md` rules.

## Not read

- The jobs, tool-jobs and agent-loop test bodies (outside the snapshot).
- `packages/subagent/subagent/src/manager.ts` beyond settlement and delivery; `packages/core/tool-executor-ptc/src/ptc.ts` beyond classification.
- `packages/subprocess/win32-process/src` and `subprocess-local/src/{terminal,output}.ts` beyond their headers; the `schedule` domain rewrite.
