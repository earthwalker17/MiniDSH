# DSH reference: Authority: sandbox, approvals, grants

> Where to research DSH's sandbox, approvals and grants ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, `dsh-v0.2.2-rc.5`); re-researched whole in S22.5, 2026-11-21.

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| sandbox seam | `packages/sandbox/sandbox` | default | `ctx.sandbox.confine`, `writableRoots`, the coded escalation ladder, `full\|partial`; `SANDBOX_UNSUPPORTED_POLICY` is gone (0.2.1-rc.4) |
| sandbox-local | `packages/sandbox/sandbox-local` | default | chains linux `[bwrap, landlock]`, darwin `[seatbelt]`, win32 `[windows-acl]`; a sole candidate unprobed; `runnerCommand` |
| sandbox-windows-acl | `packages/sandbox/sandbox-windows-acl` | default on win32 | `WRITE_RESTRICTED` token (`LUA_TOKEN` dropped 2026-10-26: administrators too), Low label, delete deny, `partial`; a STANDING ACE and label per workspace; a repair skill; a kill-on-close Job |
| sandbox-policy | `packages/sandbox/sandbox-policy` | default | per-call `resolve`, the `sandbox/mode` knob, `additionalWritableRoots`, `registerWritableRoot`; reads no Git layout |
| confined shells | `packages/shell/{bash,pwsh}-sandbox`, `packages/terminal/terminal-bash` | default | one-shot and persistent PTY; a terminal refuses a mode change while open |
| fs-sandbox | `packages/fs/fs-sandbox` | default | the in-process fence over `writableRoots`, `FS_SANDBOX_DENIED` |
| user-approval | `packages/interaction/user-approval` | default | `ctx.approval`: four outcomes, `ask\|never`, a log-only audit pair; one-shot only; a pending ask is process-local |
| permission-presets | `packages/interaction/permission-presets` | default | `workspace-write`+`ask`, `danger-full-access`+`never`; base adds `read-only`+`ask`; reserved `custom`, `auto` (= full access + `ask`) |
| approval panel | `packages/client/ui-approval` | web | no timeout; reject, allow, and an always-allow only app consent offers |
| tool gates | `packages/core/tools/src/contracts.ts` | default | `tools/pre-execute`: `allow\|deny\|cancel\|ask`, no rewrite; a monotonic `ToolGuard` after it |
| auto-review | `packages/experimental/auto-review` | opt-in, Web or headless | the agent's own model reviews each native or PTC inner call: allow runs under full access, a denial asks a person under `ask`, is final under `never` (always, in a child) |
| hook bridges | `packages/experimental/hooks-{claude-code,codex}` | opt-in | `PreToolUse` blocks (claude-code may `ask`) at `tools/pre-execute`; commands run through `ctx.shell` |
| subprocess scrub | `packages/subprocess/subprocess/src/index.ts` | default | `scrubbedParentEnv()`: `/KEY\|PASSWORD\|SECRET\|TOKEN/i`, `DSH_*` in any case, the proxy overlay |
| app consent | `packages/experimental/cua/src/application-access.ts` | experimental | per-application grants, `session` or `persistent`, revocable |

- **Writable roots.** `writableRoots()` is the workspace, extra roots, host `/tmp` and `os.tmpdir()` (Seatbelt, the fence); bwrap mounts a tmpfs `/tmp`, Landlock grants `/tmp`, win32 a private temp per live session. Extra roots are the operator's `additionalWritableRoots` (headless `--add-dir`) and, since 2026-11-04, a Host plugin's `registerWritableRoot(session, dir)`: one live Session, runtime-only, registered again after resume or fork. On win32 only `write` and `edit` honor either; processes ignore them. `packages/sandbox/sandbox/src/roots.ts`, `packages/sandbox/sandbox-policy/README.md`
- **The root moves.** Since 0.2.2-rc.4 `workspaceRoot` is the Session's working directory (`workspace-root/change`), not the header's project: a worktree narrows writes to itself, its repository's `.git` outside until granted. `docs/upgrade-guide/v0.2.2-rc.4/workspace-write-boundary-follows-root/guide.md`
- **A child's authority** is seeded onto its log at the delegation boundary: the parent's explicit mode override, an `auto` or full-access preset, approval pinned `never`; later child switches still win and only depth is enforced. `packages/subagent/subagent/src/child-agent.ts`

## Open for the route

- **Workspace-lifetime grants.** Upstream's one durable grant store is computer use's: a storage domain per canonical PROFILE directory, read fresh under the profile's file lock on every check, with revocation generations so a stale handle cannot restore access; unreadable fails closed. Tool approvals stay `allowed-once`: `allow_always` waits on storage, scope identity and revocation. `.agents/notes/implemented/architecture/2026-10-19-cua-profile-consent-storage.md`
- **Detached children.** A child never asks (the `never` pin), so it needs no answerer and cannot escalate. `packages/subagent/subagent/src/child-agent.ts`
- **An egress provider.** The network is outside the mode vocabulary and no backend fences it: bwrap unshares the PID namespace only, Seatbelt is allow-default with a write deny. `packages/sandbox/sandbox-local/src/profiles.ts`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/{sandbox,approval,permission-presets}.md` | modes, `partial`, per-call policy; the request omits arguments; `auto` | 2026-11-21 |
| `packages/sandbox/sandbox-local/{README.md,src/index.ts,src/profiles.ts}` | chains, the sole-candidate rule, the POSIX profiles | 2026-11-21 |
| `packages/sandbox/sandbox/src/{roots,escalation}.ts`, `packages/sandbox/sandbox-policy/README.md` | roots, the ladder, configured against registered grants | 2026-11-21 |
| `packages/sandbox/sandbox-windows-acl/{README.md,src/token.ts}` | the rung's boundaries, the token flags | 2026-11-21 |
| `.agents/notes/implemented/architecture/2026-10-{26-session-writable-directory-effects,29-windows-file-tool-directory-grants}.md` | why grants are effects; why win32 processes ignore them | 2026-11-21 |
| `packages/interaction/user-approval/README.md`, `packages/client/ui-approval/README.md` | the projection, one-shot grants; the card | 2026-11-21 |
| `.agents/notes/implemented/feature/{2026-07-06-approval-seam,2026-08-28-auto-review}.md` | `allow_always` deferred; the reviewer's risk classes | 2026-11-21 |
| `packages/subprocess/subprocess/src/index.ts`, `packages/experimental/hook-protocol/README.md` | the scrub, unchanged; how a hook runs | 2026-11-21 |
| `packages/bundle/{base,headless}/cordis.patch.yml` | three presets, base `never` only under full access, `--add-dir` | 2026-11-21 |
| `packages/experimental/cua/README.md`, `docs/upgrade-guide/v0.2.1-rc.3/cua-bundle-id-consent/guide.md` | grant scopes; identities authenticate no publisher | 2026-11-21 |
| `docs/persistence-catalog.md` | `approval/*`, `sandbox/mode`, `permission/preset`, `hook/*` log-only; no grant event | 2026-11-21 |

## Likely to go stale

- Session directory grants and the moving root are weeks old: Windows process support waits for a better backend, and nothing persists a grant.
- `allow_always` is deferred, not rejected; the shared card already carries the action. Auto review stays experimental.
- Windows: standing ACEs have no cleanup command; wide-directory and FAT warnings are unbuilt.

## Not read

- The fence's and the backends' tests; `sandbox-windows-acl/src/{acl,grant,runner}.ts`; the Landlock launcher beyond its contract.
- ACP's machine answerer (`packages/acp/acp`); `ui-permission-presets`; the `snapshots/session/session-sandbox-root` oracle.
