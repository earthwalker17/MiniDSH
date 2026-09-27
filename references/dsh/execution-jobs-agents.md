# DSH reference: Execution: loop, jobs, subagents, teams

> Where to research DSH's loop, tool pipeline, jobs and delegation: pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2), checked 2026-09-26 ([reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| Agent loop, tools pipeline | `packages/core/agent-loop`, `packages/core/tools` | default-mounted | Inbox, turn/step machine, per-call `executionMode`, cancel |
| Subprocess, shell | `packages/subprocess`, `packages/shell` | default-mounted | Managed spawn; every command a job from its start (registry composed) |
| Jobs seam, local provider | `packages/jobs/jobs`, `packages/jobs/jobs-local` | default-mounted | `ctx.jobs`: in-memory, owner-fenced, capped; `wait`, `remove`, `awaited` settlements |
| Job tools | `packages/jobs/tool-jobs` | base; every preset but `minimal` | The controller arming `start()`; `job_output`, `job_list`, `job_kill`; notices |
| Job controller | `packages/api/job-controller` | web-app | `job.list`, `job.follow`, a human `job.kill` fenced by owner |
| Subagent registry, providers, tools | `packages/subagent` | default-mounted | One-shot and continuable children, parent catalog, `send_message`, `interrupt_agent`; codex, claude-code off |
| Agent teams | `packages/experimental/agent-team` | experimental, no bundle row | Lead plus teammates over continuable children; durable `team/*` records |
| Workflow | `packages/workflow` | default-mounted | Model-written script; `tool-workflow/run-*`, `agent-start\|end` persisted in the parent log; `tool-ralph` off |
| Schedule | `packages/schedule/schedule` | web-app row, `disabled: true` | Host-wide reminders in a storage domain, delivered as a follow-up in the origin session |
| Agent presets | `packages/bundle/web-app/presets/*.patch.yml` | web-app | `standard` (default), `minimal`, `ptc`, `cordis` |
| Goal, plan mode, todo | `packages/goal`, `packages/plan`, `packages/todo` | default-mounted | Log-only domains; the loop depends on none |

## Open for the route

- **S17, admission.** The collectability gate lives in the registry: `start()` refuses unless an attached controller serves the owner, and errors past the per-owner cap (10). The registry owns identity (`<kind>-N`: authorize, never hide) and lifecycle, the producer its resources; `remove` drops a settled job the model never saw. `docs/subsystems/jobs.md`
- **S17, delivery.** Completion reaches the owner only through its inbox: injected when busy, a woken turn when idle (unbounded by default since 2026-09-22, the old cap of 3 stalled sessions; `quiet` never wakes); `awaited` settlements, model kills and teardown get no notice. `packages/jobs/tool-jobs/README.md`
- **S17, settlement.** First-wins; `settled` is announced LAST, after the final drain, with `cause` and `awaited`. `docs/subsystems/jobs.md`
- **S17, the idle race.** STILL OPEN (the ledger); steering has the same hole; the fix "belongs to `agent-loop`". `packages/jobs/tool-jobs/README.md`
- **S17, composition.** Base mounts the registry and tool rows on the host plane; web-app disables the tool rows and every preset but `minimal` re-mounts `tool-jobs`; headless, sdk-app, acp-app keep base's rows; sdk-minimal has the registry only. `packages/bundle/web-app/cordis.patch.yml`
- **S20, the dev server as a job.** A foreground command is registered on `ctx.jobs` at its start and the call `wait`s on it: in time its record is removed, past the timeout the same id is returned (`promoteOnTimeout`); `terminal_send` is the third producer. `packages/shell/tool-bash/README.md`
- **S21, continuable children.** A durable child Session plus at most one resident Activation, steered by `Agent.steer()` (cold-resumed when absent; `ACTIVATION_LIMIT_REACHED` at capacity); `interrupt()` cancels keeping the inbox, claimed work not requeued; settling claims idle and closes admission in one JS turn. `docs/subsystems/subagent.md`
- **S21, parallel calls.** Reclassified before each start, so a registry change mid-group becomes a barrier; never-started calls after cancellation get synthetic `tool/call` + `ABORTED_BEFORE_DISPATCH` pairs (the 2026-07-10 note is stale here). `packages/core/agent-loop/src/tool-calls.ts`
- **S21, teams.** Still experimental, "no stability promise", no bundle row; a durable mailbox on the Lead log, every message a Steer into the inbox. `packages/experimental/agent-team/README.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/subsystems/jobs.md` | Contract, ring, cap, `remove`, settlement | 2026-09-26 |
| `packages/jobs/jobs-local/README.md` | Process-local, no queue, teardown | 2026-09-26 |
| `packages/jobs/tool-jobs/README.md` | Notice lanes, unbounded wakes, idle race | 2026-09-26 |
| `packages/core/agent-loop/README.md`, `src/tool-calls.ts` | Pool, inbox emits, abort pairs; reclassify before start | 2026-09-26 |
| `packages/core/tools/src/index.ts` | `executionMode`, fail-closed | 2026-09-26 |
| `docs/subsystems/subagent.md` | One-shot vs continuable; interrupt | 2026-09-26 |
| `packages/subagent/tool-subagent/README.md` | Default `one-shot`; depth 1; says "Task" | 2026-09-26 |
| `packages/bundle/web-app/presets/{standard,minimal}.patch.yml` | Spawn and fork continuable, `tool-jobs`; persona plus one persistent shell | 2026-09-26 |
| `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | Host rows, fork one-shot, ralph off; tool rows off, schedule off, default preset | 2026-09-26 |
| `packages/bundle/{headless,sdk-app,acp-app}/cordis.patch.yml` | Keep base's rows | 2026-09-26 |
| `packages/experimental/agent-team/README.md` | Experimental; durable mailbox | 2026-09-26 |
| `docs/subsystems/shell.md`, `packages/shell/tool-bash/README.md` | Handle without id; foreground as job | 2026-09-26 |
| `docs/persistence-catalog.md` | `tool-workflow/*`, `subagent/catalog`, `team/*` persist; no `job/*` | 2026-09-26 |

## Likely to go stale

- Jobs moved daily 2026-09-21/22: foreground-as-job with `remove`/`awaited` (bb201493), `job.kill` fence dropped (0659ded5), unbounded wakes (b6775f6d), archive stops owned jobs first (cbae324b).
- Schedule shipped in web-app on 2026-09-24 (e8967378) and was disabled four hours later (cad6fef2): expect a re-enable.
- Fork: continuable in the presets, one-shot in base. Numeric defaults (10, 10, depth 1, waits 30/600 s): `docs/config-catalog.md` is the authority.
- Teams churned 2026-09-19..23; promotion is a composition edit. agent-loop 2026-09-23: dynamic tool updates changed request-series rules.

## Not read

- Source bodies: `packages/subagent/subagent/src/continuation.ts`, `packages/jobs/tool-jobs/src`, `packages/jobs/jobs-local/src`, `packages/api/job-controller/src`.
- `packages/goal/goal-round-driver` and `docs/subsystems/user-questions.md` beyond their heads.
- `packages/subprocess/win32-process` beyond its head; the `team/*` event bodies.
