# DSH reference: Execution: loop, tools, jobs, delegation

> Where to research DSH's loop, tool pipeline, jobs and delegation ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, dsh-v0.2.2-rc.5); checked 2026-11-21.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| Agent loop | `packages/core/agent-loop` | default | Inbox lanes (`followup` next turn, `steer` next step, both wake; `inject` never wakes); turn/step machine; `maxParallelToolCalls` (10) read per batch; a latched wake for a maintaining or aborted Agent |
| Tool registry | `packages/core/tools` | default | Step-admitted `ResolvedToolSet`; `src/batch.ts`, the only scheduler (the ledger has its lane, pool and opt-in rules); `src/presentation.ts` the UI cards |
| Executors | `packages/core/tool-executor-{native,ptc}` | base; PTC row disabled | One per scope: parsing, scheduling, cancellation, `tool/call`/`tool/result` logging |
| Subprocess, shell | `packages/subprocess`, `packages/shell` | default | Managed spawn: a user-systemd scope, a kill-on-close Windows Job (ordinary spawns only), else a process group; a job settles at its direct command's exit, survivors die at service disposal |
| Jobs | `packages/jobs/*`; `packages/api/job-controller` (web-app) | base; not `minimal` | `ctx.jobs` in memory, owner-fenced, 10 per owner, never queued; producers bash, pwsh, workflow, experimental `tool-terminal`; archiving kills running jobs |
| Subagents | `packages/subagent` | base | `subagent` (spawn), `subagent_fork`; a separate `tool-subagent-control` row: `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`; every instance owned by its tree's root, addressed by name (the ledger has activations, cold resume and the join) |
| Workflow | `packages/workflow` | base | Model-written script; root runs bracketed in the parent log (`tool-workflow/run-start`, `run-end`); each `agent()` a managed Activation under the run's fixed parent, outside the parent's catalog and notices; a background run is a `workflow` job |
| Schedule | `packages/schedule/schedule` | web-app, sdk-app | Host tasks: one timer and one FIFO, seven timing kinds, a 60 s floor per task, delivery an inbox write then a receipt; a delegated child is refused as a target |
| Teams | `packages/team/{agent-team,tool-agent-team}` | base, per root Session | Out of `experimental`: Team mode adds a shared task board (log-only `team/task`) over ordinary subagent messaging; its roster and mailbox are historical |
| Instructions | `packages/context/agent-instructions` | base | `AGENTS.md` as a durable `user/message`, each chain capped apart, refreshed by fs touches |

## Open for the route

- **later, stopping one child among several.** A child is stopped by addressing ITS Session (the ledger has what a parent's Stop reaches): a user interrupt, which the Gateway checks on the child, or an ancestor's `interrupt_agent`, ends a local child's current turn, its queue parked, descendants running on, the child still continuable. No parent call is waiting upstream, so "which result" never arises. `packages/api/session-controller/src/commands.ts:528-542`, `packages/subagent/subagent/src/{manager,control}.ts`
- **later, detached children: why not jobs.** Children were jobs, then continuable sessions, then activations: a job-backed child had "two FIFOs with no single ordering authority", duplicated the loop's admission, cancellation and quiescence, and one terminal result cannot hold a multi-turn residency. `.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md`, `.agents/notes/implemented/simplification/2026-09-17-unified-subagent-activations.md`
- **later, settlement.** A `subagent-settled` notice has no wake budget, and a parent that is not the exact live Agent loses it silently. "Done" is the tree's: headless waits `waitForTreeWork(root)`, teardown `drainDescendants([root])`. `packages/subagent/subagent/src/manager.ts:251-300,1125-1141`, `.agents/notes/implemented/bug-fix/2026-10-21-subagent-end-turn-guidance.md`, `packages/bundle/headless/src/index.ts`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/core/tools/src/{batch,contracts}.ts`, `packages/core/tools/README.md` | One lane, pool, barriers; the concurrency-safety contract | 2026-11-21 |
| `packages/core/agent-loop/README.md`, `src/agent.ts` | Lanes, the wake latch, `runMaintenance` (`:204-225`), failed-step recovery | 2026-11-21 |
| `packages/subagent/subagent/README.md`, `src/{manager,catalog,child-agent}.ts`, `packages/subagent/tool-subagent-control/README.md` | Activations, capacity, settlement lanes, interrupt authority, cold resume, the seeded policy | 2026-11-21 |
| `docs/subsystems/jobs.md`, `packages/jobs/{jobs-local,tool-jobs}/README.md` | Contract, cap, bracket, notices, waits, the idle race | 2026-11-21 |
| `packages/subprocess/subprocess-local/README.md` | Scope, Windows Job, fallbacks, disposal reaping | 2026-11-21 |
| `packages/bundle/{base,web-app,sdk-app,headless,sdk-minimal}/cordis.patch.yml`, `packages/bundle/web-app/presets` | Which rows mount where, with which toggles | 2026-11-21 |
| `docs/subsystems/{schedule,agent-team}.md`, `packages/workflow/{tool-workflow,workflow-ptc}/README.md` | Host tasks; the task board; run brackets and members | 2026-11-21 |
| `docs/persistence-catalog.md` | Which events persist (`subagent/start`, `subagent/end` do not) | 2026-11-21 |

## Likely to go stale

- The retirement window is still open: a settlement between the driver's last inbox check and its idle phase is injected and wakes nothing (`packages/jobs/tool-jobs/README.md`; `packages/core/agent-loop/src/agent.ts:235-246,278-285`). The steer-yielding wait is a FIXME heuristic (`packages/jobs/tool-jobs/src/index.ts:477`); the root-shutdown loss of a final `turn/end` has only a proposed fix (`.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md`).
- A shipped toggle is not a plugin default: `interrupt_agent` is off in base and three presets since 2026-11-07, on in the plugin (`docs/upgrade-guide/v0.2.2-rc.1/subagent-interrupt-default/guide.md`).
- Numeric defaults (10 jobs per owner, 10 parallel calls, 8 active children, 2,048 B inline): `docs/config-catalog.md` rules.

## Not read

- `packages/core/tool-executor-ptc/src/ptc.ts` beyond classification.
- At this pin: `packages/core/tools/src/pipeline.ts`, `packages/core/agent-loop/tests/tool-calls.spec.ts`, `packages/subprocess/win32-process`.
- `packages/team/*/README.md`; `packages/subagent/subagent/src/control.ts` beyond its schema; `packages/experimental/{worktree,tool-worktree}` (`enter_worktree`).
