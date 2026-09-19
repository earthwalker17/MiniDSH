# DSH reference: Authority: sandbox, approvals, grants

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| sandbox seam | `packages/sandbox/sandbox` | default-mounted | `ctx.sandbox` contract plus the shared roots and escalation modules. |
| sandbox-local | `packages/sandbox/sandbox-local` | default-mounted | Platform runner chain, functional probes, per-call wrap. |
| sandbox-windows-acl | `packages/sandbox/sandbox-windows-acl` | default-mounted | win32 rung: `WRITE_RESTRICTED` token plus DACL grants over koffi FFI; partial. |
| sandbox-policy | `packages/sandbox/sandbox-policy` | default-mounted | Deployment default, `sandbox/mode` fold, per-call `resolve()`. |
| confined shell | `packages/shell/bash-sandbox`, `packages/shell/pwsh-sandbox`, `packages/shell/tool-bash` | default-mounted | Executors (pwsh on win32, bash elsewhere) and the tool carrying escalation fields. |
| fs-sandbox | `packages/fs/fs-sandbox` | default-mounted | In-process fs fence under the same policy. |
| user-approval | `packages/interaction/user-approval` | default-mounted | `ctx.approval`: closed outcomes, answerer waterfall, audit pair. |
| permission-presets | `packages/interaction/permission-presets` | default-mounted | Named bundles of the two knobs; no enforcement. |
| auto-review | `packages/experimental/auto-review` | experimental | Model reviewer replacing human approval; ships off, Web only. |
| hooks bridges | `packages/hooks` | opt-in | Claude Code and Codex command hooks; no base row. |
| guards | `packages/guard` | default-mounted | Repeat-call reminder and timeouts; not authority. |
| `allow_always` | `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | proposed-only | Persistent grants; deferred, never advertised. |

## Mechanisms worth knowing

- **Two knobs, file effects only**: sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) governs file effects; "Network and process visibility are outside this vocabulary". Approval policy (`ask`, `never`) is separate. Base presets (read-only+ask, workspace-write+ask, danger-full-access+never) only bundle the two; replay reads the knob events. `docs/subsystems/sandbox.md`, `docs/subsystems/permission-presets.md`, `packages/bundle/base/cordis.patch.yml`
- **Policy per call, folded from the log**: `resolve()` takes an approved explicit mode, else the last log-only `sandbox/mode` event, else the deployment default (package `read-only`; base bundle `workspace-write`, `DSH_PERMISSION_MODE` overrides); root is the immutable session cwd. The mode sentence rides runtime context; the system prompt "remains byte-identical across mode changes". `packages/sandbox/sandbox-policy/README.md`
- **Writable roots differ by dialect**: `writableRoots()` gives workspace, `/tmp`, `os.tmpdir()` and feeds only Seatbelt and the fs fence. bwrap mounts a private `--tmpfs /tmp`; Landlock grants `/dev/null`, `/tmp`, workspace; Windows a private per-session temp, never the ambient one. `packages/sandbox/sandbox/src/roots.ts`, `packages/sandbox/sandbox-local/src/profiles.ts`
- **Runner chain, reported enforcement**: linux bwrap then Landlock, darwin Seatbelt, win32 ACL runner; competitors are functionally probed once, a sole candidate is not. `confine()` reports `full` or `partial` (Windows, older Landlock ABIs) or rejects `SANDBOX_UNAVAILABLE`, never passthrough. Consumers test `runnerFailureRules` before `denialSignatures`. `packages/sandbox/sandbox-local/README.md`, `docs/subsystems/sandbox.md`
- **Windows rung**: a `WRITE_RESTRICTED` token restricted to logon SID, Everyone, a deterministic workspace SID (standing ACE, never revoked, beyond `icacls`) and a random per-session temp SID. Everyone-writable objects and NTFS hard-link aliases stay writable; reads and sockets are open. `packages/sandbox/sandbox-windows-acl/README.md`
- **Approval seam**: `ctx.approval.request()` needs an open turn and brackets the answerer waterfall with log-only `approval/asked` and `approval/decided`. Closed outcomes: `allowed-once`, `rejected`, `cancelled`, `unavailable` (any missing or misbehaving answerer). The request omits tool arguments; the UI attaches by `callId`. `never` rejects before any answerer. `docs/subsystems/approval.md`
- **Escalation, not classification**: no command parsing or prefix rules. After a denial marker the model may retry once with `sandbox_permissions` (strictly wider, checked at execution) plus `justification`; approval precedes execution; rejection is final. One module serves bash and fs tools. `packages/sandbox/sandbox/src/escalation.ts`, `packages/shell/tool-bash/README.md`
- **No standing grants**: nothing is stored between requests. `allow_always` is Deferred pending storage, scope identity ("call? path? prefix? session? time window?") and revocation; offering it early "manufactures doomed grants". Only a mode or preset switch widens durably. `.agents/notes/implemented/feature/2026-07-06-approval-seam.md`
- **Auto review and hooks**: preset `auto` is Full access plus a pre-execute listener where the agent's own model judges each call; a failed review denies. "Model classification can be wrong"; it "provides no file sandbox". Hooks fail open on any exit code but 2. `packages/experimental/auto-review/README.md`, `packages/hooks/hook-protocol/README.md`
- **Subagents**: delegation copies the parent's sandbox override and pins a durable `approval/policy` event (`never`, source `delegation`) on every in-process child log, continuable ones included. It reversed shipped approval inheritance, which left children blocked on no visible surface. `.agents/notes/implemented/feature/2026-08-10-subagent-approval-pinned-never.md`
- **Network**: no confinement: bwrap carries `--unshare-pid` but no net unshare, Seatbelt is `(allow default)`, no domain allow-list found. The one proxy policy, which a project `.env` cannot set, is routing only. `packages/sandbox/sandbox-local/src/profiles.ts`, `.agents/notes/implemented/architecture/2026-08-27-outbound-proxy-policy.md`

## Why it matters to MiniDSH

- **S15, approval subject**: upstream keeps tool arguments out of the request and attaches by `callId`, so a structured subject on the runtime's record has NO oracle. Transfer: closed outcomes, one granting value, an asked/decided pair inside an open turn.
- **S15, session-lifetime grants**: NO upstream oracle; MiniDSH would lead. Upstream's bar: storage, scope identity and revocation before any option is shown. Shape a grant like `sandbox/mode`: a durable event that folds.
- **S15, shell-enforcement acceptance**: upstream FALSIFIED "no Windows backend story": a koffi-FFI restricted-token rung is the win32 default. It is partial, mutates workspace DACLs durably and leaves reads and sockets open, so a durable acceptance knob stays a deliberate difference. Transfer: enforcement is a reported per-call fact; "read-only" never means "no reads". Corrected: the gap is the Everyone SID in the restricting list, not an added ACE.
- **S15 network stance, S18, S20**: Tavily search and CDP-driven Chrome have NO upstream confinement oracle. Transferable: a repository-controlled file never chooses the harness's network route.
- **Writable roots (S15, S17, S20)**: "DSH adds `/tmp` and `os.tmpdir()`" holds only for Seatbelt and the fs fence. The workspace-only ceiling stands; if jobs or the browser need temp, copy the private per-session temp (TMP/TEMP rewritten).
- **S14**: blocked-versus-broke is the distinction a shell effect record needs. Nothing read closes a crash between asked and decided: no oracle for that bracket.
- **S21**: pinning children to `never` by a durable sourced event matches MiniDSH and covers continuable children. Routing child asks to a parent is deferred: no oracle.
- **Prompt belief FALSIFIED**: MiniDSH recorded that DSH removed the sandbox sentence after measuring zero-tool turns. It moved into runtime context for cache stability; no measurement was found.
- **Never a boundary**: a model reviewer or a fail-open hook, by upstream's own account.

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/sandbox.md` | File-effects-only modes, fail-closed seam. | 2026-09-19 |
| `packages/sandbox/sandbox/src/roots.ts` | `writableRoots()` and its two consumers. | 2026-09-19 |
| `packages/sandbox/sandbox/src/escalation.ts` | Shared escalation ladder and markers. | 2026-09-19 |
| `packages/sandbox/sandbox-local/README.md` | Runner chain, probes, partial cases. | 2026-09-19 |
| `packages/sandbox/sandbox-local/src/profiles.ts` | bwrap, Landlock, Seatbelt arguments. | 2026-09-19 |
| `packages/sandbox/sandbox-windows-acl/README.md` | Windows mechanism and limits. | 2026-09-19 |
| `packages/sandbox/sandbox-policy/README.md` | Resolve precedence, context placement. | 2026-09-19 |
| `docs/subsystems/approval.md` | Outcomes, policy, request, audit pair. | 2026-09-19 |
| `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | `allow_always` deferred. | 2026-09-19 |
| `docs/subsystems/permission-presets.md` | Preset service, `custom`, `auto`. | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Default rows, three presets. | 2026-09-19 |
| `packages/shell/tool-bash/README.md` | Escalation as the model sees it. | 2026-09-19 |
| `packages/experimental/auto-review/README.md` | Reviewer inputs and limits. | 2026-09-19 |
| `packages/hooks/hook-protocol/README.md` | Merge order, fail-open failures. | 2026-09-19 |
| `.agents/notes/implemented/feature/2026-08-10-subagent-approval-pinned-never.md` | Why children are pinned. | 2026-09-19 |
| `.agents/notes/implemented/architecture/2026-08-27-outbound-proxy-policy.md` | Project `.env` refused. | 2026-09-19 |

## Likely to go stale

- Auto review's status and tiers: an optional bundle only since 2026-09-15.
- No `allow_always`: Deferred, not rejected; a design can land any time.
- A same-mode `sandbox_permissions` retry runs unapproved: a note dated 2026-09-16.
- The three-preset base table: composition files move often; the service's own table has two.
- Children pinned to `never`: a self-described pre-release note that already reversed one decision.
- How the model learns the mode: `docs/subsystems/shell.md` still says from a denial marker only.
- The Windows boundary list: FAT warnings and an ACE cleanup command are open.

## Not read

- `docs/subsystems/filesystem.md`, `packages/fs/fs-sandbox/README.md`: the fs fence.
- `packages/ssh/sandbox-ssh/README.md`, `packages/shell/tool-pwsh/README.md`: remote backend, win32 tool.
- `packages/core/tools/README.md`: the `tools/pre-execute` decision surface (notes only so far).
- Notes by filename only: `2026-09-16-user-terminal-permissions.md`, `2026-09-16-sandbox-same-mode.md`, `2026-08-08-windows-acl-restricted-token-sandbox.md` (why not AppContainer), archived `2026-07-30-current-sandbox-policy-context.md` (zero-tool-turn rationale?).
- `packages/util/http-proxy/README.md`, `packages/web/tool-web/README.md`: proxy mount status, `web_fetch` validation.
- User guides, `/permission`, approval rendering in Web and TUI; hooks in non-base bundles; Landlock and the network; Auto review's wording on unsafe allows.
