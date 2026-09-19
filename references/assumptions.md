# What MiniDSH believes about DSH: the ledger

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. See [the reading rules](README.md).

MiniDSH's documents lean on claims about upstream (`docs/ARCHITECTURE.md` §12 and §13, `docs/BLUEPRINT.md` §2 and §3), and a claim about a repository that changes weekly decays silently. Each is a row here with the verdict it got when last checked. An ordinary session re-checks and re-dates the rows it touches; a `.5` hardening session reruns them all. After a `falsified` or `partly`, the document in the last column says the corrected thing or stops saying it.

Verdicts: `confirmed`, `partly` (true, with a correction that matters), `falsified`, `unverifiable`.

## Composition, presets, surfaces

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| The `minimal` preset is shell-only since 2026-09-03 | confirmed | `persona` plus a persistent PTY shell; no editor, compaction or jobs tools | `packages/preset/agent-presets/presets/minimal/agent.cordis.yml` | PROJECT §5, ARCHITECTURE §12 |
| DSH ships five protocol profiles | partly | Five COMPOSITION profiles, not protocols; `sdk` and `sdk-minimal` share one wire; Electron owns a reserved sixth, `desktop` | `docs/architecture.md`, `apps/cli/README.md` | ARCHITECTURE §12 "The wire" |
| DSH deleted its TUI | confirmed | No TUI package, app or bundle; `packages/terminal` is a PTY capability for model tools | `apps/cli/README.md`, `packages/terminal/README.md` | ARCHITECTURE §12 "Surfaces" |
| The desktop app is an Electron client of the same runtime | partly | Same code, not a thin client: Electron carries its own signed runtime and starts a private Desktop Host | `docs/architecture.md`, `apps/desktop/README.md` | PROJECT §8, route S22 |
| No lower-bound attach cursor upstream | confirmed | `follow()` always yields a tail-page snapshot; `page()` takes upper bounds only | `packages/api/session-controller/src/history.ts` | ARCHITECTURE §12 "The wire" |
| DSH keeps per-follower copies and unbounded queues | partly | Queues are uncapped; followers share the same frozen event objects, so no copies | `packages/api/session-controller/src/history.ts` | ARCHITECTURE §12 "The wire" |
| DSH packs the trace tier into pages | partly | No trace tier exists: token deltas are not durable rows; log-only events ride in pages, so page bytes are unbounded | `packages/api/session-controller/src/history.ts` | ARCHITECTURE §12 "The wire" |
| Approvals nobody can see stay pending forever upstream | partly | No answerer: immediately `unavailable`. Web answerer with no browser attached: no timeout found | `docs/subsystems/approval.md` | ARCHITECTURE §12 "The wire" |

## Session log and durability

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| DSH salvages a torn log in place | confirmed | Write path only; readers never mutate; damage inside a committed frame has no salvage | `packages/session/session-persistence-jsonl/README.md` | ARCHITECTURE §12 "Durability" |
| DSH uses a write lock rather than a lease | confirmed | A kernel lock (`flock`, a Windows semaphore), no TTL; its docs call it a lease | `packages/session/session-persistence-jsonl/README.md` | ARCHITECTURE §12 "Durability" |
| There is no session deletion upstream | confirmed | "the seam has no deletion API"; a web archive UI exists and was not read | `packages/session/session-persistence-jsonl/README.md` | ARCHITECTURE §12, §13 |
| DSH mounts a projection store by default | confirmed | Registry plus a rebuildable, fail-soft cache in the base bundle; `sdk-minimal` mounts the registry only | `packages/bundle/base/cordis.patch.yml` | BLUEPRINT §3 (rename projection) |
| `session-query` is mounted by no shipped composition | falsified | The base bundle mounts `session-query-sqlite` with `openAt: never`: exact reads, titles and lineage work, only full-text search is off | `packages/bundle/base/cordis.patch.yml` | ARCHITECTURE §12 "Context" |
| DSH has the same replay defect (first-request-order binding) | confirmed | A stated known limitation, deferred until siblings run concurrently | `packages/test-support/llm-replay/README.md` | ARCHITECTURE §13, BLUEPRINT §3, route S21 |
| A user interrupt parks work rather than killing it | partly | Only for continuable children (`cancel` with `keepInbox`); work already claimed is gone; a plain cancel ends the turn `aborted` | `docs/subsystems/subagent.md`, `docs/subsystems/session.md` | BLUEPRINT §3 (background work) |
| Queued input survives a DSH restart, as MiniDSH's inbox does | falsified | `agent/inbox/*` are runtime `emit` events, not session facts; input is logged as `user/message` only once claimed: unclaimed input dies with the process. MiniDSH's durable inbox has no oracle | `docs/agent-lifecycle.md`, `docs/event-producer-consumer.md` | ARCHITECTURE §4 "The durable inbox", route S17 |
| DSH formats are additive like MiniDSH's version 0 | falsified | Immutable generations (v0..v3), frozen adjacent migrations, fsync per batch, checksummed frames; unknown kinds are REQUIRED unless marked ignorable | `docs/subsystems/persistence.md`, `docs/session-format-status.md` | route S16 |

## Execution, jobs, delegation

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| `minimal` ships no jobs, continuable children, mailboxes or teams | confirmed | The jobs REGISTRY exists on the host plane, but no controller serves a minimal agent, so `start()` refuses | `docs/subsystems/jobs.md` | ARCHITECTURE §12 "Concurrency" |
| The inbox is the only queue | confirmed | The job registry "neither queues nor preempts"; experimental teams add a durable mailbox that FEEDS the inbox | `docs/subsystems/subagent.md` | BLUEPRINT §3, route S17 |
| A producer must not start work its owner cannot collect | confirmed | `start` refuses while no job controller serves the owner | `docs/subsystems/jobs.md` | route S17 |
| Per-call `isConcurrencySafe`, results committed in model order | confirmed | Pure, synchronous, fail-closed classifier per CALL; pool cap 10 | `packages/core/agent-loop/README.md` | BLUEPRINT §3, route S21 |
| The one-shot foreground child is upstream's default delegation | partly | Package default, yes; SHIPPED default, no: `standard` and the base bundle set `backgroundMode: continuable` | `packages/preset/agent-presets/presets/standard/agent.cordis.yml` | ARCHITECTURE §12 "Concurrency", BLUEPRINT §2 |
| Background children are built on jobs | falsified | Continuable children use NO jobs (durable child session, resident activation, its own inbox); only the one-shot background child is a job | `docs/subsystems/subagent.md` | route S17, S21 |
| Upstream jobs are durable | falsified | In-memory registry; jobs die with the process and leave no session events | `packages/jobs/jobs-local/README.md` | route S17 (MiniDSH diverges on purpose) |

## Authority

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| The Windows backend is a restricted-token subsystem, permanently `partial`, with an `Everyone` ACE and a hard-link escape | partly | `WRITE_RESTRICTED` token over koffi FFI, reports `partial`, hard-link escape confirmed. The gap is the Everyone SID in the restricting list, not an added ACE; "permanently" is unstated; it leaves durable DACL changes | `packages/sandbox/sandbox-windows-acl/README.md` | ARCHITECTURE §13, BLUEPRINT §2, route S15 |
| Standing grants are deferred upstream pending a grant-scope identity | confirmed | `allow_always` is withheld until storage, scope identity and revocation are designed; `allowed-once` is the only grant | `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | BLUEPRINT §2, route S15 |
| Four confinement backends | partly | Four local runners, plus `sandbox-ssh` and a custom `runnerCommand` that skips probes | `docs/subsystems/sandbox.md` | ARCHITECTURE §12 "Confinement" |
| DSH removed the sandbox-mode sentence from its stable prompt after measuring zero-tool turns | partly | MOVED, not removed: it rides a logged runtime-context message; the measurement was not found | `packages/sandbox/sandbox-policy/README.md` | BLUEPRINT §4 (S8.5) |
| DSH writable roots add `/tmp` and `os.tmpdir()` | partly | The shared list does; only Seatbelt and the fs fence consume it. bwrap uses a private tmpfs, Windows a private directory | `packages/sandbox/sandbox/src/roots.ts` | ARCHITECTURE §12 "The ceiling" |
| Upstream classifies shell commands to decide when to ask | falsified | No parser, prefix rules or read-only detection: the kernel decides, the model asks for a wider retry after a real denial | `docs/subsystems/approval.md`, `docs/subsystems/shell.md` | route S15 |
| Upstream has no model-based approval | falsified | An experimental Auto review ships switched off: current-session only, fails closed, registers `danger-full-access` + `never`, so it REPLACES the file sandbox | `packages/experimental/auto-review/README.md` | route S15 (not before deterministic grants) |

## Skills, extensions, web, attachments, providers

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| Model-written extensions are opt-in, session-scoped, `node:vm` not a boundary | partly | Still not a boundary, but since 2026-09-16 no model tool creates dynamic packages: `cordis` installs PERSISTENT plugins via `plugin_manager` behind full access or per-call approval | `packages/extensions/README.md`, `packages/preset/agent-presets/presets/cordis/agent.cordis.yml` | ARCHITECTURE §12 "Not built", PROJECT §4 |
| The MCP bridge ships disabled | partly | No disabled row: `mcp-resources` is mounted and inert; no `mcp-client` ships, so MCP is opt-in per server | `packages/bundle/base/cordis.patch.yml`, `docs/subsystems/mcp.md` | ARCHITECTURE §12 "Not built" |
| PTC was renamed "Code Mode" | falsified | The reverse: Code Mode was renamed TO PTC (2026-08-25); the `ptc` preset is non-default while the PTC runtime is host-mounted | `.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.md` | ARCHITECTURE §12 "Not built" |
| Image bytes are stored beside the session | partly | Content-addressed and reference-only, yes; the store is HOME-GLOBAL so forks share objects | `packages/attachment/attachment-local/README.md` | ARCHITECTURE §5, §9 (same shape here) |
| Attachments are images only | falsified | A generic file kind exists, projected as one deterministic handle line with a read-only path, never bytes | `packages/attachment/attachment/src/types.ts` | BLUEPRINT §3 (document input kind) |
| Browser use is a default DSH capability | falsified | Experimental, registration-only, in no shipped preset or bundle (landed 2026-09-12) | `docs/subsystems/browser-use.md` | route S20 |
| Web search and fetch are optional extras | partly | Optional by architecture, default-mounted in practice (every preset but `minimal`); fetch needs no approval | `docs/subsystems/web.md`, `packages/bundle/base/cordis.patch.yml` | route S18 |
| A text-only model gets screenshots through a vision subagent | unverifiable | Not found: an image is admitted only when the routed model declares image input, else bounded text | `packages/mcp/mcp-client/README.md` | ARCHITECTURE §12 (the verifier is MiniDSH's own) |
| Model roles and a durable base route are not upstream seams | partly | No role mechanism; but provider and model ARE in every logged request header | `packages/llm/llm/src/types.ts`, `docs/user/guide/providers.md` | ARCHITECTURE §12 "Delegation and routing" |
| A direct DeepSeek adapter plus one generic adapter | confirmed | `llm-deepseek` now DEFAULTS to DeepSeek's Anthropic-style Messages endpoint; `llm-pi-ai` is mounted dormant with zero routes | `packages/llm/README.md` | PROJECT §9, route S18 |
| A source snapshot is how model facts are known | partly | Only for the direct adapter; others read the installed `pi-ai` registry, with 262,144 / 32,768 fallbacks | `packages/llm/llm-pi-ai/src/catalog.ts` | BLUEPRINT §3 (catalog freshness) |
