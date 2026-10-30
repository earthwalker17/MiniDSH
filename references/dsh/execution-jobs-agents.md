# DSH reference: Execution: loop, tools, jobs, delegation

> Where to research DSH's loop, tool pipeline, jobs and delegation: pinned to `deepseek-ai/deepseek-harness@ce7073d5` (master, 2026-10-29, dsh-0.2.1-rc.5), checked 2026-10-31 in S21: the execution sources are byte-identical to `22ddee37` but for a refactor of `agent.ts` (`fcca5408`) ([reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| Agent loop | `packages/core/agent-loop` | default | Inbox lanes (`followup` next turn, `steer` next step, both wake; `inject` never wakes); turn/step machine; `maxParallelToolCalls` (10) read per batch |
| Tool registry | `packages/core/tools` | default | Step-admitted `ResolvedToolSet`; `src/batch.ts`, the only scheduler: one serial lane (pre-execute → ask → guards, then commits) in model order, only bodies pooled; every shipped opt-in is `() => true`; `src/presentation.ts` the UI cards |
| Executors | `packages/core/tool-executor-{native,ptc}` | base; PTC row disabled | One per scope: parsing, scheduling, cancellation, `tool/call`/`tool/result` logging |
| Subprocess, shell | `packages/subprocess`, `packages/shell` | default | Managed spawn: a systemd scope, a kill-on-close Windows Job (ordinary spawns only), else a process group; a job settles at its direct command's exit, survivors die at service disposal |
| Jobs | `packages/jobs/*`; `packages/api/job-controller` (web-app) | base; not `minimal` | `ctx.jobs` in memory, owner-fenced, capped; log-only `job/registered`/`job/settled`; producers bash, pwsh, workflow, experimental terminal; archiving kills running jobs |
| Subagents | `packages/subagent` | base | `subagent` (spawn), `subagent_fork`; `send_message`, `interrupt_agent`, `list_agents` in one row; no child is a job |
| Workflow | `packages/workflow` | base | Model-written script; root runs bracketed in the parent log; each `agent()` queues in the engine's FIFO for a tree slot; a background run is a `workflow` job |
| Schedule | `packages/schedule/schedule` | web-app, sdk-app | Host tasks since 2026-10-29: one timer and one FIFO, a 60 s floor, delivery a followup then a receipt; refused from a child |
| Teams | `packages/experimental/agent-team{,-profile}` | experimental, bundle off | Lead, teammates, task board over direct inbox delivery (a Lead-log mailbox retired 2026-09-26) |
| Persistent PTY | `packages/terminal`, `packages/experimental/tool-terminal` | `minimal`'s shell; bundle off | For model tools, not a TUI |
| Instructions | `packages/context/agent-instructions` | base | `AGENTS.md` as a durable `user/message`, each chain capped apart, refreshed by fs touches |

## Open for the route

- **S21.1, a child's narrowing across continuation.** Cold resume rebuilds a child from its own model-hidden `subagent/descriptor` (v3); a NEW one carries only provider, label and route (persona and `toolFilter` are historical fields the tool now rejects; both come from the Agent Preset). An `agent-preset/selected` before the first descriptor restores that preset; otherwise the child composes from the parent's CURRENT composition: the half not to copy. Depth is the header's `delegationDepth`. `packages/subagent/subagent/src/{descriptor,manager}.ts`, `packages/subagent/subagent/README.md`
- **S21.1, Windows job containment.** A per-spawn Node runner over koffi FFI creates the target suspended, assigns it to an unnamed kill-on-close Job (no breakaway) and resumes it; ConPTY, the persistent pwsh included, stays outside (an identity-fenced `taskkill /T`). PID and parent-tree scans were rejected. `packages/subprocess/subprocess-local/src/{index,windows-job,spawn-runner}.ts`, `packages/subprocess/win32-process/src/process.ts`, `.agents/notes/archived/architecture/2026-08-28-subprocess-native-containment.md`
- **S22, stopping one child.** A person's Web Stop is `agent.cancel({kind:'user'},{keepInbox:true})` on the parent alone: running children continue and later wake it. `interrupt_agent` (any live ancestor) ends a local child's current turn, its queue parked, descendants running on; an external child stops for good. `packages/api/session-controller/src/commands.ts`, `packages/subagent/subagent/src/manager.ts`
- **S22, a person and a child.** A browser prompt to a child picks Queue or Steer; its images enter the attachment store first, refused for a text-only child model. `packages/subagent/subagent/README.md`
- **later, detached children: why not jobs.** Children were jobs (2026-07-08, one Task per activation 07-21), became continuable sessions 07-28 and activations 09-17 (v0.2.1-alpha.1 removed foreground and `run_in_background`): a job-backed child had "two FIFOs with no single ordering authority", duplicated the loop's admission, cancellation and quiescence, and one terminal result cannot hold a multi-turn residency. `.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md`, `.agents/notes/implemented/simplification/2026-09-17-unified-subagent-activations.md`
- **later, settlement.** `{kind:'subagent-settled', form:'notice'}`: followup when idle, steer when busy, inject only while draining; no wake budget; a parent not the exact live Agent loses it silently. "Done" is the tree's: headless waits `whenIdle()` + `waitForChildren()` at an unchanged seq; only teardown, unload, `interrupt_agent` or archive stop a child. The end-turn guidance: 0/300 sleeps with it, 29/300 without. `packages/subagent/subagent/src/manager.ts`, `.agents/notes/implemented/bug-fix/2026-10-21-subagent-end-turn-guidance.md`, `packages/bundle/headless/src/index.ts`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/core/tools/src/{batch,pipeline}.ts`, `packages/core/agent-loop/tests/tool-calls.spec.ts` | One lane, pool, barriers, abort drain, recovery | 2026-10-31 |
| `docs/upgrade-guide/v0.2.1-rc.{1,2}/*` | Executors, conditions, control tools, chain budgets | 2026-10-25 |
| `packages/subagent/*/README.md`, `packages/subagent/subagent/src/{manager,descriptor}.ts` | Activations, capacity, settlement lanes, cold resume | 2026-10-31 |
| `docs/subsystems/jobs.md`, `packages/jobs/*/README.md` | Contract, cap, bracket, notices, waits, the idle race | 2026-10-31 |
| `packages/subprocess/{subprocess-local,win32-process}` | The Windows Job runner, its reach, disposal reaping | 2026-10-31 |
| `packages/bundle/{base,web-app,sdk-app,headless}` | Which rows mount where; headless waits for children | 2026-10-31 |
| `docs/subsystems/schedule.md` | Host tasks | 2026-10-31 |

## Likely to go stale

- The loop README's "Turn and step flow" is truncated upstream (`README.md:120`): read `batch.ts` and `tool-calls.spec.ts`.
- The steer-yielding wait is a FIXME heuristic; the retirement window (the idle race: a wake latched only in maintenance, `agent.ts:236,275-279,427`) is open and untested; the root-disposal P0 is still proposed (`.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md`).
- `tool-jobs/README.md` still names subagents as job producers; no code does.
- Numeric defaults (10 jobs per owner, 10 parallel calls, 8 active children, 2,048 B inline): `docs/config-catalog.md` rules. Schedule was rewritten 2026-10-29; event-triggered automation is proposed.

## Not read

- `packages/core/tool-executor-ptc/src/ptc.ts` beyond classification.
- `subprocess-local/src/{output,terminal}.ts` beyond the win32 branch; the Windows Job test bodies.
