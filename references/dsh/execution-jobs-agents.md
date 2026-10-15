# DSH reference: Execution: loop, jobs, subagents, teams

> Where to research DSH's loop, tool pipeline, jobs and delegation: pinned to `deepseek-ai/deepseek-harness@57190202` (master, 2026-10-14, dsh-v0.2.1-alpha.3), checked 2026-10-15 in S17 ([reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| Agent loop, tools pipeline | `packages/core/agent-loop`, `packages/core/tools` | default-mounted | Inbox, turn/step machine, per-call `executionMode`, cancel |
| Subprocess, shell | `packages/subprocess`, `packages/shell` | default-mounted | Managed spawn (a systemd scope, a Windows kill-on-close Job, else a process group); every bash/pwsh call is a job |
| Jobs seam, local provider | `packages/jobs/jobs`, `packages/jobs/jobs-local` | default-mounted | `ctx.jobs`: in-memory, owner-fenced, capped; a byte ring per job; log-only `job/registered`, `job/settled` per owned job |
| Job tools | `packages/jobs/tool-jobs` | base; every preset but `minimal` | Arms `start()`; `job_output`, `job_list`, `job_kill`; completion notices |
| Job controller | `packages/api/job-controller` | web-app | `job.list` (whole-set rows), `job.follow`, a human `job.kill` fenced by the registry owner alone |
| Subagent activations | `packages/subagent` | default-mounted | Every child returns an id at once and reports through the parent's inbox; no child is a job |
| Agent teams | `packages/experimental/agent-team` | experimental, no bundle row | Lead plus teammates; a message goes straight into the target inbox |
| Workflow | `packages/workflow` | default-mounted | Model-written script; root runs bracketed in the parent log; a background run is a `workflow` job |
| Schedule | `packages/schedule/schedule` | web-app | Host-wide reminders, delivered as a follow-up in the origin session |
| Agent presets | `packages/bundle/web-app/presets/*.patch.yml` | web-app | `standard` (default), `minimal`, `ptc`, `cordis` |
| Goal, plan mode, todo | `packages/goal`, `packages/plan`, `packages/todo` | default-mounted | Log-only domains; the loop depends on none |

## Open for the route

- **S17, the bracket (MiniDSH diverges).** The registry appends `job/registered` and `job/settled` synchronously at its commit, so a terminal fact precedes the notice it causes; ids are `<kind>-<16 hex>` because history outlives the registry. A missing settlement "remains incomplete" and nothing closes it: an ordered shutdown was added and reverted (`3d89cded`), so even a graceful exit can lose it. `docs/subsystems/jobs.md`
- **S17, admission.** A live owner Agent, a controller serving it, then a per-owner cap of 10 (running plus stopping); nothing queues or preempts, and a refusal leaves no id. `packages/jobs/jobs-local/src/index.ts`
- **S17, delivery.** A notice is a user message (`{kind:'tool-jobs', form:'notice'}`): `followup` for an idle owner, else `inject`; none for an awaited end, a model kill or teardown, while a person's kill notifies. Waking is unbounded by default: a cap of 3 stalled sessions INVISIBLY (#641, "an observable cost beats an unobservable stall"). The idle race is still open in `agent.ts`. `packages/jobs/tool-jobs/README.md`
- **S17, headless.** `dsh run` waits for children, never jobs; teardown kills them without a notice. `packages/bundle/headless/README.md`
- **S20, the dev server as a job.** A foreground command is registered at its start and waited on: in time its record is removed, past the timeout the same id is returned (`promoteOnTimeout`). `terminal_send` moved to `packages/experimental`. `packages/shell/tool-bash/README.md`
- **S21, continuable children.** Every local child is a durable Session plus one resident activation, settled into the parent's inbox (steer when busy, followup when idle), outside any wake budget; `interrupt()` keeps the inbox, claimed work is not requeued. `.agents/notes/implemented/simplification/2026-09-17-unified-subagent-activations.md`
- **S21, parallel calls.** Reclassified before each start, so a registry change mid-group becomes a barrier; never-started calls after cancellation get synthetic `tool/call` + `ABORTED_BEFORE_DISPATCH` pairs. `packages/core/agent-loop/src/tool-calls.ts`
- **S21, teams.** Still experimental; the outbox, retries and dedupe were removed for direct inbox delivery (#5247). `.agents/notes/implemented/simplification/2026-09-26-team-direct-inbox.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/subsystems/jobs.md` | Contract, cap, `remove`, settlement, the lifecycle records | 2026-10-15 |
| `packages/jobs/jobs-local/src/index.ts`, `README.md` | Admission order, first-wins settle, record before waiters, teardown | 2026-10-15 |
| `packages/jobs/tool-jobs/src/index.ts`, `README.md` | Notice shape and lanes, wake budget, schemas, idle race | 2026-10-15 |
| `packages/core/agent-loop/src/agent.ts` | `wakeDriver` latches only maintenance or aborted phases | 2026-10-15 |
| `.agents/notes/implemented/bug-fix/2026-09-30-job-session-lifecycle.md` | Synchronous recording; why no finish is invented | 2026-10-15 |
| `.agents/notes/archived/feature/2026-09-22-unbounded-completion-wakes-by-default.md` | Why the wake cap went | 2026-10-15 |
| `packages/shell/tool-bash/src/{index,background}.ts` | `run_in_background`, promotion, outcome mapping | 2026-10-15 |
| `packages/subprocess/subprocess-local/README.md`, `src/spawn.ts` | Containment modes, kill ladder, host death | 2026-10-15 |
| `packages/bundle/headless/src/index.ts` | Waits for idle and children only | 2026-10-15 |
| `packages/bundle/{base,web-app,sdk-minimal}/cordis.patch.yml` | Registry and tool rows; controller in web-app only | 2026-10-15 |
| `docs/persistence-catalog.md` | `job/*`, `tool-workflow/*`, `subagent/catalog` persist | 2026-10-15 |

## Likely to go stale

- The bracket churned 2026-09-30..10-09 (`executionId` added then dropped, the shutdown registry added then removed); a proposed note names the lost settlement P0 (`.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md`).
- The re-check DSH names for the idle race ("every turn-close path") is an unscheduled agent-loop change.
- Numeric defaults (cap 10, ring 256 KiB, waits 30/600 s): `docs/config-catalog.md` is the authority.

## Not read

- `packages/jobs/jobs-local/src/events.ts`, the jobs and tool-jobs test bodies, `packages/api/job-controller/src/client`.
- `packages/subagent/subagent/src/manager.ts` beyond `notifySettlement`; `packages/goal/goal-round-driver`.
- `packages/subprocess/win32-process/src` beyond its README; `subprocess-local/src/{terminal,output}.ts`.
