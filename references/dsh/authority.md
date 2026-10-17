# DSH reference: Authority: sandbox, approvals, grants

> Where to research DSH's sandbox, approvals and grants ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, `dsh-v0.1.7-rc.2`); checked 2026-09-26 in S16.5; the audit-payload source rechecked at `57190202` on 2026-10-15.

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| sandbox seam | `packages/sandbox/sandbox` | default | `ctx.sandbox`, `writableRoots`, the escalation ladder, `SandboxEnforcement` |
| sandbox-local | `packages/sandbox/sandbox-local` | default | per-platform chains, probes, `runnerCommand` |
| sandbox-windows-acl | `packages/sandbox/sandbox-windows-acl` | default | the win32 rung: restricted token, Low label, delete deny |
| sandbox-policy | `packages/sandbox/sandbox-policy` | default | the deployment default and the durable `sandbox/mode` knob |
| sandbox-ssh | `packages/ssh/sandbox-ssh` | opt-in | the remote host's own backend, same facts |
| confined shell | `packages/shell/{bash,pwsh}-sandbox`, `tool-{bash,pwsh}` | default | executors; `result.sandbox{mode,denied,enforcement}` goes to the MODEL and the log, never rendered to a person |
| fs-sandbox | `packages/fs/fs-sandbox` | default | the in-process fence, `FS_SANDBOX_DENIED` |
| user-approval | `packages/interaction/user-approval` | default | `ctx.approval`: outcomes, `ask\|never`, audit pair, `displayReason` |
| permission-presets | `packages/interaction/permission-presets` | default | bundles of the two knobs, `/permission`, `custom` |
| approval panel | `packages/client/ui-approval` | web | the prompt plus the correlated call's `command` argument |
| tool gates | `packages/core/tools/src/index.ts` | default | `tools/pre-execute`: `allow\|deny\|cancel\|ask`, no rewrite |
| auto-review | `packages/experimental/auto-review` | optional bundle, off | a model reviewer; a denial under `ask` becomes an ask |
| hooks bridges | `packages/hooks` | opt-in | Claude Code and Codex dialects at `tools/pre-execute`, run via `ctx.shell` |
| subprocess scrub | `packages/subprocess/subprocess/src/index.ts` | default | `scrubbedParentEnv()`: a name pattern plus the proxy overlay |

## Open for the route

- **S18, web search.** No backend confines the network (bwrap unshares pid only, Seatbelt allows default), so gating `web_fetch` is a `tools/pre-execute` listener, the shape hooks and auto-review already use. `packages/sandbox/sandbox-local/src/profiles.ts`
- **S20, a job that asks.** A background command asks only to escalate, before its background branch, so an approved one-shot grant covers the job's whole life, its mode fixed at spawn (MiniDSH never escalates a job; 2026-10-15 at `57190202`). `packages/shell/tool-bash/src/index.ts`
- **S20, the browser process.** Ten spawners outside `ctx.subprocess` import `scrubbedParentEnv()`; the Stagehand Chrome launch is the browser precedent. `packages/experimental/browser-use-stagehand-native/src/launch.ts`
- **S21, actors.** Delegation also seeds `permission/preset` for `auto`/`danger-full-access` in the child's creation window; the ceiling itself is the ledger's delegation row. `packages/subagent/subagent/src/child-agent.ts`
- **S22, tool display facts.** `ToolCallView = Generic | Terminal | Diff` from a pure `presentCall(args)`, which the approval panel does not use (the ledger's consent row). `packages/core/tools/src/presentation.ts`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/sandbox.md`, `docs/subsystems/approval.md` | modes, fail-closed seam, `partial`; outcomes, `ask\|never`, the request omits arguments | 2026-09-26 |
| `packages/sandbox/sandbox-local/src/{index,profiles}.ts` | chains, sole candidate unprobed, `runnerCommand`; the three POSIX profiles | 2026-09-26 |
| `packages/sandbox/sandbox/src/roots.ts` | `writableRoots()`: Seatbelt and the fs fence | 2026-09-26 |
| `packages/sandbox/sandbox/src/escalation.ts` | the ladder, `displayReason`, no command parser | 2026-09-26 |
| `packages/sandbox/sandbox-windows-acl/README.md` | the rung, its boundaries, standing edits | 2026-09-26 |
| `packages/interaction/user-approval/src/types.ts`, `docs/persistence-schema.json` | the audit payloads; no clamp, no decider; `invariant.ts` deleted 2026-09-30 | 2026-10-15 |
| `packages/core/tools/src/{index,presentation}.ts` | the gates, `ask`, `ToolCallView` | 2026-09-26 |
| `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | `allow_always` deferred, the scope question | 2026-09-26 |
| `packages/subprocess/subprocess/src/index.ts`, `packages/util/http-proxy/src/install.ts` | `SENSITIVE_ENV_PATTERN`, `DSH_`; the proxy overlay | 2026-09-26 |
| `packages/experimental/auto-review/README.md` | optional bundle, `ask` policy, limits | 2026-09-26 |
| `packages/bundle/{base,headless,sdk-minimal}/cordis.patch.yml` | the rows each mounts | 2026-09-26 |

## Likely to go stale

- The approval prompt: `displayReason` landed 2026-09-24 (#4793); `allow_always` is still deferred, not rejected.
- auto-review: three commits on 2026-09-24.
- Tool prose trimmed 2026-09-24: the strings in `escalation.ts` may move again.
- permission-presets: volatile Config forms (2026-09-21) and the `auto` identity (2026-09-24); the Windows rung's cleanup command is undecided.

## Not read

- The ssh backend's server side (`packages/ssh/sandbox-ssh/src`), the fs fence's tests, the Landlock launcher (`native/system`, outside the sparse set).
- `docs/subsystems/permission-presets.md` and `docs/config-catalog.md` for the `auto` identity's fold.
- Whether the seam's Web answerer times out an unseen ask (`packages/client/ui-approval/src`; the S13 "no timeout found" stands unrechecked).
