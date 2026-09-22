# DSH reference: Authority: sandbox, approvals, grants

> Pinned to `deepseek-ai/deepseek-harness@c36a83ff` (master, 2026-09-22); this area re-checked 2026-09-22 in S15. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| sandbox seam | `packages/sandbox/sandbox` | default | `ctx.sandbox`, roots, escalation, `SandboxEnforcement`. |
| sandbox-local | `packages/sandbox/sandbox-local` | default | Platform chains, probes, per-call wrap, `runnerCommand`. |
| sandbox-windows-acl | `packages/sandbox/sandbox-windows-acl` | default | win32 rung: restricted token + Low integrity label; `partial`. |
| sandbox-policy | `packages/sandbox/sandbox-policy` | default | Deployment default, `sandbox/mode` fold, `resolve()`, the model's mode sentence. |
| confined shell | `packages/shell/{bash,pwsh}-sandbox`, `tool-bash` | default | Executors (pwsh on win32) and the escalation fields. |
| fs-sandbox | `packages/fs/fs-sandbox` | default | In-process fs fence under the same policy. |
| user-approval | `packages/interaction/user-approval` | default | `ctx.approval`: closed outcomes, answerer waterfall, audit pair. |
| permission-presets | `packages/interaction/permission-presets` | default | Bundles of the two knobs, `/permission`, `custom`. |
| tool presentation | `packages/core/tools/src/presentation.ts` | default | `ToolCallView` — a trusted structured call view, NOT wired to approval. |
| auto-review | `packages/experimental/auto-review` | experimental, off | Model reviewer on `tools/pre-execute`, not an answerer. |
| hooks bridges | `packages/hooks` | opt-in | Command hooks, also `tools/pre-execute`; no base row. |
| subprocess scrub | `packages/subprocess/subprocess` | default | `scrubbedParentEnv()`: one credential scrub for every child. |
| `allow_always` | `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | proposed only | Standing grants; deferred since 2026-07-06. |

## Mechanisms worth knowing

- **Two tiers, not one.** `tools/pre-execute` is a waterfall of POLICY listeners (`allow`/`deny`/`cancel`/`ask`); only `ask` reaches `ctx.approval.request()`, the ANSWERER tier, which ships two listeners. Auto-review and both hook bridges are tier one, and upstream calls neither a boundary — the reviewer registers `danger-full-access` + `never`, so it REPLACES the file sandbox; hooks fail open on any exit code but 2. `docs/tool-execution-pipeline.md`
- **Two knobs, file effects only.** `never` is decided INSIDE the service before the waterfall, so a `prepend: true` listener cannot reopen the gate, and Settings' `defaultPreset` reaches session CREATION only, so replay can reconstruct which permission governed a call. `docs/subsystems/sandbox.md`, `packages/sandbox/sandbox-policy/src/session-mode.ts`
- **Platform chains, then probes**: `{linux:['bwrap','landlock'], darwin:['seatbelt'], win32:['windows-acl']}`, a sole candidate selected unprobed. `confine()` never returns the original argv; `runnerCommand` skips probes and hard-codes `full` but still WRAPS — an operator assertion of a DIFFERENT enforcer, never of none. `packages/sandbox/sandbox-local/src/index.ts`
- **`SandboxEnforcement` is `'full' | 'partial'` — no `none`.** windows-acl is the only `partial`, PTC reports it to the MODEL alone, and nothing asks a person to accept it — though the doc says a consumer needing the absolute promise must reject or surface the distinction. `docs/subsystems/sandbox.md`
- **The Windows rung hardened twice in five days** (2026-09-18/19, issue #4581) with a Low mandatory label and a `FILE_DELETE_CHILD` deny, because `cmd /c del` had escaped both confined modes. Still `partial`: hard links alias past it, reads and network are open, and its ACEs and labels are STANDING — `icacls` cannot revoke them. `packages/sandbox/sandbox-windows-acl/README.md`
- **The approval request carries no arguments, deliberately** — `{agent, toolName, callId?, reason?, signal?}` — because `callId` names an already-presented call and a second copy could drift; the durable pair carries no subject and no decider, and **nothing clamps, bounds or strips control characters from `reason`**. So a person consents to prose — for an escalation, `escalate sandbox to <mode>: <model justification>`, a trusted fact concatenated into model text — beside a slot whose renderer `JSON.parse`s the raw arguments IN THE BROWSER. Truncating that command was rejected: hiding its tail asks a person to consent to text they cannot read. `packages/interaction/user-approval/src/types.ts`, `.agents/notes/archived/bug-fix/2026-07-30-approval-panel-command-cap.md`
- **A trusted structured call view DOES exist, one seam over**: `ToolCallView = Generic | Terminal | Diff`, from each tool's pure, replay-safe `presentCall(args)` over parsed arguments — a verb `kind`, `locations`, `cwd`, argument-derived `diffs`. Never wired to approval. `packages/core/tools/src/presentation.ts`
- **Escalation, not classification**: no parser or prefix rule, a closed SCHEMA vocabulary whose strictly-wider check runs at execution, and a same-mode request that costs no prompt — where MiniDSH refuses one as `SANDBOX_NOT_WIDER`. `packages/sandbox/sandbox/src/escalation.ts`
- **No standing grants.** `allowed-once` is the only grant, and none is persisted. Left open: a grant's scope identity "beyond the sandbox mode — exact call, path, command prefix, session, or time window", with a rejected alternative calling command-string identity fragile and saying to "Revisit only if `allow_always` grant storage ever needs machine-checkable scopes." `.agents/notes/implemented/feature/2026-07-06-approval-seam.md`
- **Subagents: a seeded pin, not an enforced ceiling.** Capture runs before the child's first await, takes only the parent's EXPLICIT override — never deployment defaults or one-shot grants — and seeds both knobs `source: 'delegation'` onto the child's own log. But a later child switch still wins and `source` is never read: only the absence of a model-facing write path holds the line. The DEPTH ceiling is immutable, in the HEADER. `packages/subagent/subagent/src/child-agent.ts`
- **Deterministic headless is composition.** `headless` mounts no approval channel, so every ask falls to `unavailable`; `sdk-minimal` removes the seam and pins `danger-full-access`. No auto-answer, no per-tool allow-list, no timeout anywhere. `packages/bundle/headless/cordis.patch.yml`
- **One credential scrub, every child.** `scrubbedParentEnv()` drops `/KEY|PASSWORD|SECRET|TOKEN/i` and every `DSH_*`, and an explicit `env` merges AFTER so a caller can forward a secret on purpose; eight spawners outside `ctx.subprocess` import it rather than reimplement it. Stated holes: `*PASSPHRASE*`, `SSH_AUTH_SOCK` and a proxy URL carrying userinfo. `packages/subprocess/subprocess/src/index.ts`
- **Network: no confinement.** bwrap carries `--unshare-pid` but no net unshare, Seatbelt is `(allow default)`, and presets expose `web_fetch` in every sandbox and approval mode without confirmation, pointing a deployment at `tools/pre-execute`. `docs/subsystems/web.md`

## Why it matters to MiniDSH

- **S15, the subject** (built): upstream's omission rests on an anti-drift argument MiniDSH answers rather than avoids — its subject comes from the same frozen, VALIDATED arguments the body receives, and neither harness has an argument-rewrite path. `ToolCallView` is the oracle for shape; MiniDSH attaches it to the approval record and keys its families to S14's "did" vocabulary rather than a verb enum.
- **S15, grants** (built): nothing to copy, but upstream named the blocker — with no arguments on the record, `toolName` is the only key available — and named the unlock, "machine-checkable scopes". Transferable: a grant is reconstructable from the log that governed the call, it dies with the scope it was cut to, and no host to offer a scope means no grant rather than a fallback.
- **S15, enforcement acceptance** (built): NO upstream artifact. Its historical answer to an empty win32 chain was to degrade the MODE until a rung existed, and its documented opt-out is composition — mount an honestly-unconfined executor. MiniDSH's durable per-session knob is the auditable form of that choice and keeps the fs fence a mode degradation drops.
- **S15, the edges**: MiniDSH's "inherits the environment, provider keys included — deliberate" was NOT parity, so copy the scrub's shape. The deterministic stance belongs in the SERVICE, not a listener. Delegation: capture before the first await and seed the child's own log — MiniDSH ENFORCES what upstream only pins, which is a lead.
- **S16/S18/S20**: `source: 'delegation'` written and never read is the shape of a provenance marker that survives replay, and post-mortem 0004 bounds what any authority fact derived from command output can claim. Tavily and CDP Chrome have no confinement oracle.

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/sandbox.md` | Modes, fail-closed seam, `partial`. | 2026-09-22 |
| `packages/sandbox/sandbox-local/src/index.ts` | Chains, probes, `runnerCommand`. | 2026-09-22 |
| `packages/sandbox/sandbox-local/src/profiles.ts` | bwrap/Landlock/Seatbelt argv; no net unshare. | 2026-09-22 |
| `packages/sandbox/sandbox/src/roots.ts` | `writableRoots()` and its two consumers. | 2026-09-19 |
| `packages/sandbox/sandbox/src/escalation.ts` | The ladder, markers, same-mode return. | 2026-09-22 |
| `packages/sandbox/sandbox-windows-acl/README.md` | Windows mechanism, boundaries, open gaps. | 2026-09-22 |
| `packages/sandbox/sandbox-policy/src/session-mode.ts` | The durable knob shape and its one writer. | 2026-09-22 |
| `packages/interaction/user-approval/src/index.ts` | Request shape, `never` in `decide()`, outcomes. | 2026-09-22 |
| `docs/persistence-schema.json` | The durable payloads: no subject, no decider. | 2026-09-22 |
| `packages/core/tools/src/presentation.ts` | `ToolCallView`, `presentCall`, replay-safety. | 2026-09-22 |
| `packages/core/tools/src/index.ts` | The two tiers; no argument-rewrite variant. | 2026-09-22 |
| `.agents/notes/archived/bug-fix/2026-07-30-approval-panel-command-cap.md` | Why truncating a consent line was rejected. | 2026-09-22 |
| `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | `allow_always` deferred; the open scope question. | 2026-09-22 |
| `.agents/notes/implemented/feature/2026-07-06-sandbox.md` | No persisted grant; composition as the opt-out. | 2026-09-22 |
| `packages/subagent/subagent/src/child-agent.ts` | Capture-before-await; the seeded pin. | 2026-09-22 |
| `packages/subprocess/subprocess/src/index.ts` | `scrubbedParentEnv`, its pattern, its holes. | 2026-09-22 |
| `packages/experimental/auto-review/README.md` | Tier, inputs, fail-closed, stated limits. | 2026-09-22 |
| `packages/bundle/base/cordis.patch.yml` | Default rows and presets. | 2026-09-22 |
| `docs/postmortem/0004-landlock-partial-notice-misclassified-child-failures.md` | Stderr is forgeable attribution. | 2026-09-22 |

## Likely to go stale

- The Windows rung moved twice in five days and leaves a cleanup command undecided: re-read before citing any boundary.
- `allow_always`: deferred 2.5 months with nothing in `proposed/` — but deferred, not rejected.
- Auto review's status and tier: experimental and optional only since 2026-09-15.
- Whether `ToolCallView` ever reaches the approval request. The pieces are one wire apart.

## Not read

- The fs fence itself (`docs/subsystems/filesystem.md`, `packages/fs/fs-sandbox/`), the remote backend (`packages/ssh/sandbox-ssh/`) and the win32 tool (`packages/shell/tool-pwsh/`).
- Whether any Host or Client component renders `enforcement` to a human (searched, none found, not exhaustively).
- Whether any in-repo profile or fixture actually sets `runnerCommand`.
- The behavioural tests behind the seam: `packages/interaction/user-approval/tests/`.
- Whether hooks, skills or the workflow engine spawn children on a path bypassing `ctx.subprocess`.
