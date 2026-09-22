# What MiniDSH believes about DSH: the ledger

> Authority rows pinned to `deepseek-ai/deepseek-harness@c36a83ff` (master, 2026-09-22), re-run in S15. Every other row is at `ddefc45f` (2026-09-17), checked 2026-09-20 for durability and delegation, 2026-09-19 for the rest. See [the reading rules](README.md).

MiniDSH's documents lean on claims about upstream, and a claim about a repository that changes weekly decays silently. Each is a row here with the verdict it got when last checked; after a `falsified` or `partly`, the document in the last column says the corrected thing or stops saying it. ARCH = `docs/ARCHITECTURE.md`, BP = `docs/BLUEPRINT.md`, PROJ = `docs/PROJECT.md`.

Verdicts: `confirmed`, `partly` (true, with a correction that matters), `falsified`, `unverifiable`. A bare source path is under `packages/`.

## Composition, presets, surfaces

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| The `minimal` preset is shell-only since 2026-09-03 | confirmed | `persona` plus a persistent PTY shell; no editor, compaction or jobs tools | `preset/agent-presets/presets/minimal/agent.cordis.yml` | PROJ §5, ARCH §12 |
| DSH ships five protocol profiles | partly | Five COMPOSITION profiles; `sdk`/`sdk-minimal` share a wire; Electron reserves a sixth | `docs/architecture.md` | ARCH §12 |
| DSH deleted its TUI | confirmed | None ships; `terminal` is a PTY capability for model tools | `apps/cli/README.md` | ARCH §12 |
| The desktop app is an Electron client of the same runtime | partly | Same code, not a thin client: Electron carries its own signed runtime and a private Host | `docs/architecture.md` | PROJ §8, route S22 |
| No lower-bound attach cursor upstream | confirmed | `follow()` always yields a tail-page snapshot; `page()` takes upper bounds only | `api/session-controller/src/history.ts` | ARCH §12 |
| DSH keeps per-follower copies and unbounded queues | partly | Queues are uncapped; followers share frozen event objects, so no copies | `api/session-controller/src/history.ts` | ARCH §12 |
| DSH packs the trace tier into pages | partly | No trace tier at all; log-only events ride in pages, so page bytes are unbounded | `api/session-controller/src/history.ts` | ARCH §12 |
| Approvals nobody can see stay pending forever upstream | partly | No answerer: immediately `unavailable`. A Web answerer with no browser: no timeout found | `docs/subsystems/approval.md` | ARCH §12 |

## Session log and durability

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| DSH salvages a torn log in place | confirmed | Write path only; readers never mutate; damage inside a committed frame has no salvage | `session/session-persistence-jsonl/README.md` | ARCH §12 |
| DSH uses a write lock rather than a lease | confirmed | A kernel lock (`flock`, a Windows semaphore), no TTL; its docs call it a lease | `session/session-persistence-jsonl/README.md` | ARCH §12 |
| There is no session deletion upstream | confirmed | "the seam has no deletion API"; a web archive UI exists, unread | `session/session-persistence-jsonl/README.md` | ARCH §12, §13 |
| DSH mounts a projection store by default | confirmed | Registry plus a rebuildable fail-soft cache in base; `sdk-minimal` mounts the registry only | `bundle/base/cordis.patch.yml` | BP §3 (rename projection) |
| `session-query` is mounted by no shipped composition | falsified | base mounts `session-query-sqlite` at `openAt: never`: only full-text search is off | `bundle/base/cordis.patch.yml` | ARCH §12 |
| DSH has the same replay defect (first-request-order binding) | confirmed | A stated limitation, deferred until siblings run concurrently | `test-support/llm-replay/README.md` | ARCH §13, BP §3, route S21 |
| A user interrupt parks work rather than killing it | partly | Only continuable children (`cancel` with `keepInbox`); claimed work is gone | `docs/subsystems/subagent.md` | BP §3 (background work) |
| DSH's inbox is durable, as MiniDSH's is | confirmed | `agent/inbox/spliced` is persisted and log-only; `inserted`/`claimed`/`discarded` are runtime emits | `docs/persistence-catalog.md` | ARCH §4, route S17 |
| No tool-lifecycle event beyond call and result | partly | `tool/ptc-dispatch-start`/`-dispatch` is that pair — but for PTC SUB-calls, BEFORE their gate; repair closes neither | `core/tools/src/types.ts` | ARCH §4, §12 |
| Upstream records no effect of a call | partly | It snapshots, content-addresses and counts lines, then keeps it on the Host and drops it with the process | `deliverables/workspace-changes/README.md` | ARCH §4, §12 |
| Repair reaches the whole unfinished log | falsified | ONE step, at the tail: the pending map clears at `step/end`, and no open turn yields no closers | `core/session/src/repair.ts` | ARCH §4 |
| A child can be joined back to its delegating CALL | falsified | Nothing does: "no delegation records, receipt, Header field, descriptor field, or Session format is added" | `docs/subsystems/subagent.md` | ARCH §4, §12 |
| DSH formats are additive like MiniDSH's version 0 | falsified | Immutable generations v0..v3, frozen migrations, fsync per batch, checksummed frames; unknown kinds REQUIRED unless marked ignorable | `docs/subsystems/persistence.md` | route S16 |

## Execution, jobs, delegation

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| `minimal` ships no jobs, continuable children, mailboxes or teams | confirmed | The jobs REGISTRY exists, but no controller serves a minimal agent, so `start()` refuses | `docs/subsystems/jobs.md` | ARCH §12 |
| The inbox is the only queue | confirmed | The job registry "neither queues nor preempts"; experimental teams add a mailbox that FEEDS the inbox | `docs/subsystems/subagent.md` | BP §2, route S17 |
| A producer must not start work its owner cannot collect | confirmed | `start` refuses while no job controller serves the owner | `docs/subsystems/jobs.md` | route S17 |
| Per-call `isConcurrencySafe`, results committed in model order | confirmed | Pure, synchronous, fail-closed classifier per CALL; pool cap 10 | `core/agent-loop/README.md` | BP §2, route S21 |
| The one-shot foreground child is upstream's default delegation | partly | Package default yes; SHIPPED default no — `standard` and base set `backgroundMode: continuable` | `preset/agent-presets/presets/standard/agent.cordis.yml` | ARCH §12, BP §2 |
| Background children are built on jobs | falsified | Continuable children use NO jobs (durable session, resident activation, own inbox); only the one-shot background child is | `docs/subsystems/subagent.md` | route S17, S21 |
| Upstream jobs are durable | falsified | In-memory registry; jobs die with the process and leave no session events | `jobs/jobs-local/README.md` | route S17 (MiniDSH diverges) |

## Authority

Re-run 2026-09-22; the mechanisms behind these verdicts are in [dsh/authority.md](dsh/authority.md).

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| A structured approval subject has no upstream oracle | falsified | `ToolCallView`, from each tool's pure `presentCall(args)` — never wired to approval | `core/tools/src/presentation.ts` | ARCH §7, §12 |
| A delegated child's authority is an enforced ceiling upstream | falsified | A seeded pin: a later child switch still wins. Only DEPTH is a real ceiling, in the header | `subagent/subagent/src/child-agent.ts` | ARCH §7, §12 |
| A confined command inherits the harness environment, keys included, as upstream's does | falsified | `scrubbedParentEnv()` scrubs every child, and did so before the old pin | `subprocess/subprocess/src/index.ts` | ARCH §13 |
| An approval decision records who decided it | falsified | No decider field; the gateway knows and discards it | `docs/persistence-schema.json` | ARCH §12 |
| A model-written approval reason is clamped before storage or display | falsified | No clamp, bound or control-character strip; the only bound is CSS | `interaction/user-approval/src/invariant.ts` | ARCH §7 |
| The Windows backend is a restricted-token subsystem, permanently `partial`, with an `Everyone` ACE and a hard-link escape | partly | Token, `partial` and hard link confirmed; a Low label and a delete deny landed 2026-09-18/19. The gap is Everyone in the RESTRICTING list; ACEs are STANDING | `sandbox/sandbox-windows-acl/README.md` | ARCH §13, BP §2 |
| Standing grants are deferred upstream pending a grant-scope identity | confirmed | Unchanged since 2026-07-06; S15 answers the open scope as exact-call-plus-session | `.agents/notes/implemented/feature/2026-07-06-approval-seam.md` | ARCH §7, §12 |
| Four confinement backends | partly | Chains are bwrap+landlock, seatbelt, windows-acl, plus `sandbox-ssh` and `runnerCommand` | `sandbox/sandbox-local/src/index.ts` | ARCH §12 |
| DSH removed the sandbox-mode sentence from its stable prompt after measuring zero-tool turns | partly | MOVED into a logged runtime-context message; no measurement found | `sandbox/sandbox-policy/README.md` | BP §4 (S8.5) |
| DSH writable roots add `/tmp` and `os.tmpdir()` | partly | The shared list does; only Seatbelt and the fs fence consume it | `sandbox/sandbox/src/roots.ts` | ARCH §12 |
| Upstream classifies shell commands to decide when to ask | falsified | No parser or prefix rule: the kernel decides, the model asks after a real denial | `sandbox/sandbox/src/escalation.ts` | ARCH §7, §12 |
| Upstream has no model-based approval | falsified | Auto review ships OFF, and is a `tools/pre-execute` policy listener, not an answerer | `experimental/auto-review/README.md` | ARCH §12 |

## Skills, extensions, web, attachments, providers

| Assumption | Verdict | What is true at the pin | Source | MiniDSH leans on it in |
|---|---|---|---|---|
| Model-written extensions are opt-in, session-scoped, `node:vm` not a boundary | partly | Still no boundary, but since 2026-09-16 no model tool creates dynamic packages: `plugin_manager` installs PERSISTENT ones behind full access or approval | `extensions/README.md` | ARCH §12, PROJ §4 |
| The MCP bridge ships disabled | partly | No disabled row: `mcp-resources` is mounted and inert; no `mcp-client` ships | `bundle/base/cordis.patch.yml` | ARCH §12 |
| PTC was renamed "Code Mode" | falsified | The reverse (2026-08-25); the `ptc` preset is non-default while the runtime is host-mounted | `.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.md` | ARCH §12 |
| Image bytes are stored beside the session | partly | Content-addressed and reference-only; the store is HOME-GLOBAL, so forks share objects | `attachment/attachment-local/README.md` | ARCH §5, §9 |
| Attachments are images only | falsified | A generic file kind exists, projected as one handle line with a read-only path, never bytes | `attachment/attachment/src/types.ts` | BP §3 (document input kind) |
| Browser use is a default DSH capability | falsified | Experimental, registration-only, in no shipped preset or bundle (landed 2026-09-12) | `docs/subsystems/browser-use.md` | route S20 |
| Web search and fetch are optional extras | partly | Default-mounted in practice (every preset but `minimal`); fetch needs no approval in any mode | `docs/subsystems/web.md` | route S18 |
| A text-only model gets screenshots through a vision subagent | unverifiable | Not found: an image is admitted only when the routed model declares image input | `mcp/mcp-client/README.md` | ARCH §12 (the verifier is MiniDSH's own) |
| Model roles and a durable base route are not upstream seams | partly | No role mechanism; but provider and model ARE in every logged request header | `llm/llm/src/types.ts` | ARCH §12 |
| A direct DeepSeek adapter plus one generic adapter | confirmed | `llm-deepseek` DEFAULTS to DeepSeek's Anthropic-style Messages endpoint; `llm-pi-ai` is dormant | `llm/README.md` | PROJ §9, route S18 |
| A source snapshot is how model facts are known | partly | Only for the direct adapter; others read the installed `pi-ai` registry, with 262,144 / 32,768 fallbacks | `llm/llm-pi-ai/src/catalog.ts` | BP §3 (catalog freshness) |
