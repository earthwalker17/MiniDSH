# DSH reference: Execution: loop, jobs, subagents, teams

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| Agent loop, tools pipeline | `packages/core/agent-loop`, `packages/core/tools` | default-mounted | Inbox, turn/step machine, tool scheduling, cancel, crash closers; per-call concurrency classifier. |
| Subprocess, shell | `packages/subprocess`, `packages/shell` | default-mounted | Managed spawn and terminate under shell exec and a background `start()` handle. |
| Jobs seam, local provider | `packages/jobs/jobs`, `packages/jobs/jobs-local` | default-mounted | `ctx.jobs`: in-memory, owner-fenced, capped, never queues. |
| Job tools | `packages/jobs/tool-jobs` | default-mounted | Controller arming `start()`; `job_output`, `job_list`, `job_kill`; notices. |
| Subagent registry, providers, tools | `packages/subagent` | default-mounted | One-shot runs, continuable children, `backgroundMode` delegate tool, `send_message`; codex and claude-code rows ship disabled. |
| Agent teams | `packages/experimental/agent-team` | experimental | Lead plus teammates; durable mailbox and task board in the Lead log. |
| Workflow | `packages/workflow` | default-mounted | Model-written JS script starting subagents through one engine; `tool-ralph` ships `disabled: true`. |
| Schedule | `packages/schedule/schedule` | opt-in | Session-local durable reminders; only an example overlay mounts it. |
| Goal, plan mode, todo | `packages/goal`, `packages/plan/plan-mode`, `packages/todo/tool-todo` | default-mounted | Log-only session domains; the loop depends on none. |

## Mechanisms worth knowing

- **Dependency order, lower rungs**: log, loop and inbox; tools pipeline; subprocess; shell; jobs registry; `tool-jobs` controller; only then background bash and the one-shot BACKGROUND child. Knowledge runs one way: shell's `start()` handle has no id or owner. `docs/subsystems/shell.md`
- **Dependency order, actors**: a one-shot FOREGROUND child needs only loop and sessions. Continuable children add a durable child session, steer and cancel-with-keepInbox, and use NO jobs: the two are independent. Teams sit on continuable children, workflow on the subagent seam, schedule on the inbox alone. `docs/subsystems/subagent.md`
- **Loop, cancel, crash repair**: every inbox mutation is one durable `agent/inbox/spliced` event; a turn boundary claims next-step input plus ONE queued prompt. Cancel clears the inbox unless `keepInbox`; undispatched calls get synthetic `ABORTED_BEFORE_DISPATCH` results. Resume appends `interruptedTurnClosers`: repair is "the agent layer's job", not storage's. `packages/core/agent-loop/README.md`
- **Parallel tool calls**: a synchronous pure `isConcurrencySafe(args)` classifies each CALL, failing closed to exclusive. Rolling pool of `maxParallelToolCalls` (10); exclusive calls are barriers. Only tool bodies overlap; policy stages and `tool/result` commits stay in model order. `packages/core/agent-loop/README.md`
- **Job contract and admission**: a record `<kind>-N`; the registry owns identity and lifecycle, the producer owns resources. `start()` refuses unless an attached controller serves the owner ("cannot start work that owner cannot collect or stop"); past 10 per owner it errors: it "neither queues nor preempts". Settlement first-wins, completion announced LAST. `docs/subsystems/jobs.md`, `packages/jobs/jobs-local/README.md`
- **Jobs leave NO session events**: records are in-memory and "die with the harness process"; owner disposal cancels and removes them. The provider imports no session package: no job start or settle record exists; only tool results and inbox notices reach history. `packages/jobs/jobs-local/README.md`, `packages/jobs/jobs-local/src/index.ts`
- **Completion delivery**: output is pulled with `job_output`. Completion goes through the owner's inbox: injected when busy, a woken turn when idle, capped by `maxConsecutiveWakes` (3), refilled only by user input; a `reported` bit dedups. Known defect: a settlement in the driver's retirement window is injected and nothing wakes. `packages/jobs/tool-jobs/README.md`
- **Subagent modes**: one-shot `run_in_background: true` is a parent-owned `subagent` job; continuable resolves at inbox acceptance, creates no job, reports by settlement notice. Package default `one-shot` (foreground); the standard preset sets spawn AND fork `continuable`. `packages/subagent/tool-subagent/README.md`, `packages/preset/agent-presets/presets/standard/agent.cordis.yml`
- **Continuable children**: a durable child Session plus at most one process-local Activation; "The Agent inbox is the only queue". Messages use `Agent.steer()`, cold-resuming when absent. Interrupt is cancel-with-keepInbox; claimed work "is not requeued". Settling claims idle and closes admission in one JavaScript turn. Authority: live sender plus `parentSession` header. `docs/subsystems/subagent.md`
- **Teams, workflow, schedule**: the team mailbox is a queued-minus-delivered fold in the Lead log IN FRONT of the inbox, never a second queue. Workflow writes `tool-workflow/run-start` and `tool-workflow/run-end` records to the parent Session. Schedule queues a `followup()` into the LIVE session only. `packages/experimental/agent-team/README.md`, `docs/subsystems/workflow.md`, `docs/subsystems/schedule.md`
- **Composition split**: base mounts registries and tool rows on the host plane; the web-app bundle disables the tool rows so presets own them: a preset decides whether its agent can collect background work. `minimal` mounts a persona and one persistent shell. `packages/bundle/web-app/cordis.patch.yml`, `packages/preset/agent-presets/presets/minimal/agent.cordis.yml`

## Why it matters to MiniDSH

- **S14**: upstream balances history by synthesis, appended by the agent layer on resume, never by storage: the recovery contract's ownership rule. It closes turns and undispatched calls only; gate-versus-body and a provider-written effect record have NO upstream oracle.
- **S17, transferable**: the collectability gate lives in the registry, not in producers; runtime owns identity, producer owns resources; settle first-wins, announce last; dedup with a `reported` bit; fail at capacity, never queue; complete only through the inbox. The dev server of S20 is one such bash-kind job.
- **S17, deliberate divergence**: upstream jobs leave NO session events and vanish silently with the host. MiniDSH's log is its single source of truth, so it writes durable job brackets spanning turns, closed by S14's recovery. What a resumed session learns about dead jobs has NO upstream oracle.
- **S17, warning**: upstream's check-then-idle race strands a job notice, though its continuation manager claims idle and closes admission in one step. MiniDSH's claim-commit ordering must do that for jobs.
- **S21**: continuable children need no job layer, so S17 and S21 are independent and loop, one-shot foreground child, jobs, continuable is a valid order. Runtime-authored notices need their own durable source kind. Ids are predictable: authorize, do not hide.
- **S21, parallel calls**: the classifier is per CALL from parsed arguments, not the static per-tool flag MiniDSH assumed. Model-order commit lets replay key on identity.
- **Falsified**: MiniDSH believed the one-shot foreground child is upstream's default delegation. True of the package default only; shipped compositions default to continuable background. MiniDSH's child with start/end records in the PARENT log is a sound first rung, not upstream's product path.
- **Partly falsified**: "an interrupt parks rather than kills" holds only for a continuable child's unclaimed inbox. Claimed work is gone, plain cancel clears the inbox, `job_kill` terminates.
- **Confirmed**: the inbox is the only queue; `minimal` ships no job tools, children or teams. Teams, workflow and schedule are off the route.

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/subsystems/jobs.md` | Job contract, collectability gate, settlement | 2026-09-19 |
| `packages/jobs/jobs-local/README.md` | Cap 10, no queue, teardown, process-local | 2026-09-19 |
| `packages/jobs/jobs-local/src/index.ts` | Imports only: no session package | 2026-09-19 |
| `packages/jobs/tool-jobs/README.md` | Job tools, delivery lanes, wake budget, defect | 2026-09-19 |
| `packages/core/agent-loop/README.md` | Pool size, cancel, abort pairs, crash closers | 2026-09-19 |
| `.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md` | History: why a unary classifier, commit cursor | 2026-09-19 |
| `docs/subsystems/subagent.md` | One-shot versus continuable, only queue, interrupt | 2026-09-19 |
| `packages/subagent/tool-subagent/README.md` | `backgroundMode` semantics, package default | 2026-09-19 |
| `packages/preset/agent-presets/presets/standard/agent.cordis.yml` | Spawn and fork continuable; disabled rows | 2026-09-19 |
| `packages/preset/agent-presets/presets/minimal/agent.cordis.yml` | Persona plus persistent shell only | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Host rows; fork one-shot; no team or schedule row | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Base tool rows and `ui-schedule` disabled | 2026-09-19 |
| `packages/experimental/agent-team/README.md` | Team records, experimental status | 2026-09-19 |
| `docs/subsystems/workflow.md` | Never-rejecting result, run records | 2026-09-19 |
| `docs/subsystems/schedule.md` | `schedule/change` authority, live-only delivery | 2026-09-19 |
| `docs/subsystems/shell.md` | Handle without id or owner | 2026-09-19 |

## Likely to go stale

- Fork is continuable in the standard preset but one-shot in `packages/bundle/base/cordis.patch.yml`, citing `.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md`: in flux.
- The word "job" and the tool names: `packages/subagent/tool-subagent/README.md` still says "Task".
- Numeric defaults (10, 10, 3, depth 1): several are live settings; `docs/config-catalog.md` is the authority.
- The stranded-notice defect: its fix "belongs to `agent-loop`", likely to land.
- Process-local jobs: the seam is abstract so a durable backend can arrive, changing every crash answer here.
- Teams and schedule staying off by default: promotion is a small composition edit.

## Not read

- Source bodies: `packages/core/agent-loop/src/tool-calls.ts`, `packages/subagent/subagent/src/continuation.ts`, `packages/jobs/tool-jobs/src/index.ts`; `packages/jobs/jobs-local/src/index.ts` beyond its imports.
- Whether a durable PARENT-log record brackets a child: `docs/subsystems/subagent.md` calls the `subagent/start` and `subagent/end` pair observe-only.
- The README-versus-note conflict on never-started calls after abort.
- A new Web session's default preset; the `ptc` and `cordis` presets; whether the headless, sdk-app, acp-app and sdk-minimal bundles disable base's tool rows.
- The PTY job producer; goal round driver; `docs/subsystems/user-questions.md`; `packages/schedule/schedule/README.md`.
- The continuable activation cap (`snapshots/sdk/subagent-activation-limit`); Windows termination in `packages/subprocess/win32-process`.
