# DSH reference: Authority: sandbox, approvals, grants

> Where to research DSH's sandbox, approvals and grants ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, `dsh-v0.2.1-rc.3`); re-researched in S20.5, 2026-10-25.

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| sandbox seam | `packages/sandbox/sandbox` | default | `ctx.sandbox`, `writableRoots`, the escalation ladder, `full\|partial`, `SANDBOX_UNSUPPORTED_POLICY` |
| sandbox-local | `packages/sandbox/sandbox-local` | default | chains linux `[bwrap, landlock]`, darwin `[seatbelt]`, win32 `[windows-acl]`; a sole candidate unprobed; `runnerCommand` |
| sandbox-windows-acl | `packages/sandbox/sandbox-windows-acl` | default on win32 | restricted token, Low label, delete deny, `partial`; a diagnose-and-repair skill (2026-09-25) |
| sandbox-policy | `packages/sandbox/sandbox-policy` | default | default mode, root, `additionalWritableRoots`, the `sandbox/mode` knob |
| sandbox-ssh | `packages/ssh/sandbox-ssh` | opt-in | forwards `confine` to the remote helper, which mounts its own local chain (`packages/ssh/ssh/src/helper.ts`) |
| confined shells | `packages/shell/{bash,pwsh}-sandbox`, `packages/terminal/terminal-bash` | default | one-shot and persistent PTY; a terminal refuses a mode change while open |
| fs-sandbox | `packages/fs/fs-sandbox` | default | the in-process fence over `writableRoots`, `FS_SANDBOX_DENIED` |
| user-approval | `packages/interaction/user-approval` | default | `ctx.approval`: four outcomes, `ask\|never`, audit pair; needs `sessionProjections` (rc.2) |
| permission-presets | `packages/interaction/permission-presets` | default | `workspace-write`+`ask`, `danger-full-access`+`never`; reserved `custom`, `auto` (= full access + `ask`) |
| approval panel | `packages/client/ui-approval` | web | no timeout; a reject/allow/always-allow card that app consent reuses |
| tool gates | `packages/core/tools/src/contracts.ts` | default | `tools/pre-execute`: `allow\|deny\|cancel\|ask`, no rewrite; monotonic `tools.guard()` after it |
| auto-review | `packages/experimental/auto-review` | opt-in, Web or headless | a model reviewer per call |
| hook bridges | `packages/experimental/hooks-{claude-code,codex}` | opt-in | `PreToolUse` `deny`/`ask` at `tools/pre-execute`, run through `ctx.shell` |
| subprocess scrub | `packages/subprocess/subprocess/src/index.ts` | default | `scrubbedParentEnv()`: `/KEY\|PASSWORD\|SECRET\|TOKEN/i`, `DSH_*`, the proxy overlay |
| app consent | `packages/experimental/cua/src/application-access.ts` | experimental | session or saved grants per verified executable, revocable |

- **Writable roots.** `writableRoots()` adds host `/tmp` and `os.tmpdir()` (Seatbelt, the fence); bwrap mounts a tmpfs `/tmp`, Landlock grants `/tmp`, win32 a private temp per session. Since rc.3 (2026-10-18) operator-named physical `additionalWritableRoots` (headless `--add-dir`, per invocation) bind on every POSIX backend; win32 refuses them. `packages/sandbox/sandbox/src/roots.ts`
- **The network** is outside the mode vocabulary; the Landlock launcher governs filesystem access only. `docs/subsystems/sandbox.md`, `native/system/docs/cli-contract.md`
- **Auto review.** The agent's own model reviews each native or PTC inner call; allow runs it under full access, a denial asks a person under `ask` and is final under `never`. Headless since 2026-10-18; shutdown keeps Auto, removal moves live sessions to full access. `packages/experimental/auto-review/README.md`

## Open for the route

- **S21, parallel calls.** Pre-execute, so every `ask`, runs one call at a time in model order; only dispatch and bodies overlap, in a `maxParallelToolCalls` pool. `packages/core/tools/src/batch.ts`
- **S21, continuable children.** Delegation appends `sandbox/mode{source:'delegation'}`, `approval/policy never` and, from Auto or full access, `permission/preset` once, after any fork seed; later child switches win; nothing re-seeds a continuation. `packages/subagent/subagent/src/child-agent.ts`
- **S21, who speaks for the user.** Auto gives `source.kind:'user'` text instruction authority on any transport; a child's creation prompt and its direct parent's messages stay subordinate, inherited prompts are facts. `docs/upgrade-guide/v0.2.1-rc.2/auto-review-user-sources/guide.md`
- **S22, tool display facts.** `ToolCallView = Generic | Terminal | Diff` with a `ToolCallKind` (`read|edit|delete|move|search|execute|fetch|other`) from a pure `presentCall(args)`; the approval panel parses only `args.command`. `packages/core/tools/src/presentation.ts`
- **S22, grants on a surface.** Only computer use lists and revokes grants (saved on a page, session ones in memory); tool approvals stay `allowed-once`. `packages/experimental/cua/README.md`
- **S22, authority on resume.** A saved Auto session reopens only with its integration, even to switch preset; `--add-dir` must be passed again. `docs/upgrade-guide/v0.2.1-rc.2/auto-review-shutdown/guide.md`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/{sandbox,approval,permission-presets}.md` | modes, `partial`, extra roots; outcomes, the request omits arguments; the `auto` bundle | 2026-10-25 |
| `packages/sandbox/sandbox-local/src/{index,profiles}.ts`, `README.md` | chains, probes, the three POSIX profiles, win32's refusal | 2026-10-25 |
| `packages/sandbox/sandbox/src/{roots,escalation}.ts` | roots and their validation; the ladder, localized `displayReason` | 2026-10-25 |
| `packages/sandbox/sandbox-windows-acl/README.md`, `src/acl-skill.ts` | the rung, its boundaries, the repair skill | 2026-10-25 |
| `packages/interaction/user-approval/src/{index,types}.ts`, `packages/client/ui-approval/src/client/index.ts` | the projection, no clamp, no decider; the Web answerer waits until answered, cancelled or delegated | 2026-10-25 |
| `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | `allow_always` deferred, the scope question | 2026-10-25 |
| `packages/subprocess/subprocess/src/index.ts` | the scrub, unchanged since 2026-09-24 | 2026-10-25 |
| `packages/bundle/{base,headless,sdk-minimal}/cordis.patch.yml` | the rows each mounts; base `never` only under full access | 2026-10-25 |
| `docs/upgrade-guide/v0.2.1-rc.2/{approval-projection-dependency,headless-policy-composition}` | approval needs the registry; headless policy reads `--add-dir` | 2026-10-25 |

## Likely to go stale

- Extra writable roots (rc.3): Windows support, a Web surface.
- Auto review: headless, user sources and shutdown all within a week; still experimental, its projection migration deferred.
- `allow_always` is deferred, not rejected; computer use's saved grants are the first per-subject store.
- Windows: the repair skill and the undecided cleanup of standing ACEs.

## Not read

- The fence's and the backends' tests (outside the snapshot); the Landlock launcher's source beyond its contract.
- `hooks-codex`, the auto-review decision note (`2026-08-28-auto-review.md`), where computer use stores saved grants.
