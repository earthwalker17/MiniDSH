# DSH reference: Authority: sandbox, approvals, grants

> A map, not a copy: verify against the current repository before relying on any line ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@c36a83ff` (master, 2026-09-22); checked 2026-09-22 in S15.

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| sandbox seam | `packages/sandbox/sandbox` | default | `ctx.sandbox`, roots, escalation, `SandboxEnforcement` |
| sandbox-local | `packages/sandbox/sandbox-local` | default | platform chains, probes, `runnerCommand` |
| sandbox-windows-acl | `packages/sandbox/sandbox-windows-acl` | default | the win32 rung |
| sandbox-policy | `packages/sandbox/sandbox-policy` | default | deployment default, the durable mode knob |
| confined shell | `packages/shell/{bash,pwsh}-sandbox`, `tool-bash` | default | executors and the escalation fields |
| fs-sandbox | `packages/fs/fs-sandbox` | default | the in-process fs fence |
| user-approval | `packages/interaction/user-approval` | default | `ctx.approval`: outcomes, answerers, audit pair |
| permission-presets | `packages/interaction/permission-presets` | default | bundles of the two knobs, `/permission` |
| tool presentation | `packages/core/tools/src/presentation.ts` | default | `ToolCallView` from `presentCall(args)` |
| auto-review | `packages/experimental/auto-review` | experimental, off | a model-based reviewer |
| hooks bridges | `packages/hooks` | opt-in | command hooks at `tools/pre-execute` |
| subprocess scrub | `packages/subprocess/subprocess` | default | `scrubbedParentEnv()` for every child |
| `allow_always` | `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | proposed only | standing grants |

## Open for the route

- **S16, an audit of attempts.** Post-mortem 0004: stderr is forgeable attribution, so an authority fact read from command output is only the command's own claim. `docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md`
- **S16, replay as a capability.** The permission that governed a call is reconstructable from the log: Settings' `defaultPreset` reaches session CREATION only, and the durable mode knob has one writer. `packages/sandbox/sandbox-policy/src/session-mode.ts`
- **S17, a job that asks.** Upstream's unattended stance is composition, not a rule: `headless` mounts no approval channel, `sdk-minimal` removes the seam and pins `danger-full-access`, and nothing auto-answers or allow-lists per tool. `packages/bundle/headless/cordis.patch.yml`
- **S18, web search.** No backend confines the network (bwrap unshares no net namespace, Seatbelt is `(allow default)`), so a deployment that wants `web_fetch` gated is pointed at `tools/pre-execute`. `packages/sandbox/sandbox-local/src/profiles.ts`
- **S20, the browser process.** Eight spawners outside `ctx.subprocess` import `scrubbedParentEnv()` rather than reimplement it; a tool-launched Chrome is one more such spawner. `packages/subprocess/subprocess/src/index.ts`
- **S22, tool display facts.** `ToolCallView = Generic | Terminal | Diff`, from each tool's pure, replay-safe `presentCall(args)` over parsed arguments (a verb `kind`, `locations`, `cwd`, derived `diffs`). `packages/core/tools/src/presentation.ts`
- **Built in S14–S15** (the subject, grants, acceptance, the child environment, the delegation ceiling): MiniDSH's side is [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §7 and §12; upstream's is the Authority rows of [assumptions.md](../assumptions.md).

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/sandbox.md` | modes, fail-closed seam, `partial` | 2026-09-22 |
| `packages/sandbox/sandbox-local/src/index.ts` | chains, probes, `runnerCommand` | 2026-09-22 |
| `packages/sandbox/sandbox-local/src/profiles.ts` | backend argv; no net unshare | 2026-09-22 |
| `packages/sandbox/sandbox/src/roots.ts` | `writableRoots()` and its two consumers | 2026-09-19 |
| `packages/sandbox/sandbox/src/escalation.ts` | the ladder, same-mode return | 2026-09-22 |
| `packages/sandbox/sandbox-windows-acl/README.md` | the Windows rung, its gaps | 2026-09-22 |
| `packages/sandbox/sandbox-policy/src/session-mode.ts` | the durable knob, its one writer | 2026-09-22 |
| `packages/interaction/user-approval/src/{index,types}.ts` | the request shape, `never` in `decide()` | 2026-09-22 |
| `docs/persistence-schema.json` | the durable approval payloads | 2026-09-22 |
| `packages/core/tools/src/presentation.ts` | `ToolCallView`, `presentCall` | 2026-09-22 |
| `packages/core/tools/src/index.ts` | the two tiers; no argument rewrite | 2026-09-22 |
| `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | `allow_always` deferred; the scope question | 2026-09-22 |
| `.agents/notes/implemented/feature/2026-07-06-sandbox.md` | no persisted grant; the composition opt-out | 2026-09-22 |
| `packages/subagent/subagent/src/child-agent.ts` | delegation capture, the seeded pin | 2026-09-22 |
| `packages/subprocess/subprocess/src/index.ts` | `scrubbedParentEnv`, its pattern and holes | 2026-09-22 |
| `packages/experimental/auto-review/README.md` | tier, inputs, stated limits | 2026-09-22 |
| `packages/bundle/{base,headless}/cordis.patch.yml` | default rows; the headless composition | 2026-09-22 |
| `docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md` | stderr is forgeable attribution | 2026-09-22 |

## Likely to go stale

- The Windows rung: changed twice in five days (2026-09-18/19), a cleanup command undecided.
- `allow_always`: deferred since 2026-07-06, not rejected.
- auto-review: experimental and optional only since 2026-09-15.
- Whether `ToolCallView` reaches the approval request: the pieces are one wire apart.

## Not read

- The fs fence (`docs/subsystems/filesystem.md`, `packages/fs/fs-sandbox/`), the remote backend (`packages/ssh/sandbox-ssh/`), the win32 tool (`packages/shell/tool-pwsh/`).
- Whether any Host or Client renders `enforcement` to a human (searched, none found, not exhaustively).
- Whether any in-repo profile or fixture sets `runnerCommand`.
- The seam's tests: `packages/interaction/user-approval/tests/`.
- Whether hooks, skills or the workflow engine spawn children bypassing `ctx.subprocess`.
- Whether each backend gives a confined child its own POSIX session (`packages/sandbox/sandbox-local/src/profiles.ts`): ARCH once claimed a divergence; upstream's side was never recorded.
