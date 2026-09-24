# DSH reference: Execution: loop, jobs, subagents, teams

> Where to research DSH's loop, tool pipeline, jobs and delegation, and their dependency order: pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17), checked 2026-09-19 ([reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| Agent loop, tools pipeline | `packages/core/agent-loop`, `packages/core/tools` | default-mounted | Inbox, turn/step machine, tool scheduling, cancel, crash closers |
| Subprocess, shell | `packages/subprocess`, `packages/shell` | default-mounted | Managed spawn; shell exec and a background `start()` handle |
| Jobs seam, local provider | `packages/jobs/jobs`, `packages/jobs/jobs-local` | default-mounted | `ctx.jobs`: in-memory, owner-fenced, capped |
| Job tools | `packages/jobs/tool-jobs` | default-mounted | The controller arming `start()`; `job_output`, `job_list`, `job_kill` |
| Subagent registry, providers, tools | `packages/subagent` | default-mounted | One-shot and continuable children, `send_message`; codex and claude-code rows disabled |
| Agent teams | `packages/experimental/agent-team` | experimental | Lead plus teammates over continuable children |
| Workflow | `packages/workflow` | default-mounted | Model-written script starting subagents; `tool-ralph` disabled |
| Schedule | `packages/schedule/schedule` | opt-in | Session-local reminders; only an example overlay mounts it |
| Goal, plan mode, todo | `packages/goal`, `packages/plan/plan-mode`, `packages/todo/tool-todo` | default-mounted | Log-only domains; the loop depends on none |

## Open for the route

- **S17, admission.** The collectability gate lives in the registry, not in producers: `start()` refuses unless an attached controller serves the owner, and errors past its per-owner cap. The registry owns identity (`<kind>-N`, predictable: authorize, never hide) and lifecycle; the producer owns resources. `docs/subsystems/jobs.md`
- **S17, delivery.** Completion reaches the owner only through its inbox: injected when busy, a woken turn when idle, capped by `maxConsecutiveWakes` (3), refilled only by user input; a `reported` bit dedups. `packages/jobs/tool-jobs/README.md`
- **S17, the idle race.** A known defect: a settlement landing in the driver's retirement window is injected and nothing wakes. MiniDSH's claim-commit ordering must close that window for jobs. `packages/jobs/tool-jobs/README.md`
- **S17, composition.** Base mounts the registries and tool rows on the host plane; the web-app bundle disables the tool rows, so a preset decides whether its agent can collect background work. `packages/bundle/web-app/cordis.patch.yml`
- **S20, the dev server as a job.** A bash-kind job: shell's `start()` handle has no id or owner; the jobs registry and `tool-jobs` controller supply both (knowledge runs one way). `docs/subsystems/shell.md`
- **S21, continuable children.** A durable child Session plus at most one process-local Activation, steered by `Agent.steer()` (cold-resuming when absent); settling claims idle and closes admission in one JavaScript turn. `docs/subsystems/subagent.md`
- **S21, parallel calls.** Only tool bodies overlap: policy stages and `tool/result` commits stay in model order and exclusive calls are barriers, so replay can key on identity, not arrival. `packages/core/agent-loop/README.md`
- **Built in S14** (resume-time closers owned by the agent layer, never storage): MiniDSH's side is ARCH §12, verdicts in [assumptions.md](../assumptions.md).

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/subsystems/jobs.md` | Job contract, collectability gate, settlement | 2026-09-19 |
| `packages/jobs/jobs-local/README.md` | Cap, no queue, process-local | 2026-09-19 |
| `packages/jobs/jobs-local/src/index.ts` | Imports only: no session package | 2026-09-19 |
| `packages/jobs/tool-jobs/README.md` | Job tools, delivery, wake budget, defect | 2026-09-19 |
| `packages/core/agent-loop/README.md` | Pool, cancel, abort pairs, crash closers | 2026-09-19 |
| `.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md` | Why a per-call classifier; commit cursor | 2026-09-19 |
| `docs/subsystems/subagent.md` | One-shot versus continuable; interrupt | 2026-09-19 |
| `packages/subagent/tool-subagent/README.md` | `backgroundMode`; package default | 2026-09-19 |
| `packages/preset/agent-presets/presets/standard/agent.cordis.yml` | Spawn and fork continuable | 2026-09-19 |
| `packages/preset/agent-presets/presets/minimal/agent.cordis.yml` | Persona plus one persistent shell | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Host rows; fork one-shot | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Base tool rows disabled | 2026-09-19 |
| `packages/experimental/agent-team/README.md` | Team records; experimental | 2026-09-19 |
| `docs/subsystems/shell.md` | Handle without id or owner | 2026-09-19 |

## Likely to go stale

- Fork: continuable in the standard preset, one-shot in base, citing `.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md`. In flux.
- The word "job" and the tool names: `packages/subagent/tool-subagent/README.md` still says "Task".
- Numeric defaults (10, 10, 3, depth 1), several of them live settings: `docs/config-catalog.md` is the authority.
- The stranded-notice defect, whose fix "belongs to `agent-loop`".
- Process-local jobs: the seam is abstract, so a durable backend can arrive.
- Teams and schedule off by default: promotion is a small composition edit.

## Not read

- Source bodies: `packages/core/agent-loop/src/tool-calls.ts`, `packages/subagent/subagent/src/continuation.ts`, `packages/jobs/tool-jobs/src/index.ts`; `packages/jobs/jobs-local/src/index.ts` beyond its imports.
- In code, whether any durable PARENT-log record brackets a child: `docs/subsystems/subagent.md` calls the `subagent/start` and `subagent/end` pair observe-only.
- The README-versus-note conflict on never-started calls after abort.
- A new Web session's default preset; the `ptc` and `cordis` presets; whether the headless, sdk-app, acp-app and sdk-minimal bundles disable base's tool rows.
- The PTY job producer; goal round driver; `docs/subsystems/user-questions.md`; `packages/schedule/schedule/README.md`.
- The continuable activation cap (`snapshots/sdk/subagent-activation-limit`); Windows termination in `packages/subprocess/win32-process`.
