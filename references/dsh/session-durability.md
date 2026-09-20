# DSH reference: Session log and durable execution

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-20 (master had not moved in three days). A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

Default-mounted = a row in `packages/bundle/base/cordis.patch.yml`. `…/sdk-minimal/cordis.patch.yml` is standalone ("does not layer over dsh-base"): it persists with no checkpoint-policy, cache or query row.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Session, SessionStore | `packages/core/session` | default-mounted | Append-only typed event log; history is a fold. |
| `interruptedTurnClosers` | `packages/core/session/src/repair.ts` | default-mounted | Pure closers for a crash-orphaned tail turn. |
| Persistence seam | `packages/session/session-persistence` | default-mounted | Handles: read, append, flush, close. No delete. |
| JSONL backend | `packages/session/session-persistence-jsonl` | default-mounted | The only backend: zstd frames, fsync per batch, kernel lock. |
| Checkpoint policy | `packages/session/session-checkpoint-policy` | default-mounted | Fail-closed flush before request, tool body, pre-step. |
| Format chain | `packages/session/session-format` (and `-v0-to-v1` to `-v2-to-v3`, `-catalog`) | default-mounted | Frozen adjacent migrations; generated catalog. |
| Projection registry, cache | `packages/session/session-projection`, `packages/session/session-projection-cache` | default-mounted | Pure fold units; rebuildable, fail-soft. |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; `openAt: never` disables search only. |
| Invariant companion | `packages/core/session/src/invariant.ts` | opt-in | Pairing checks; sdk-minimal, not base. |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only replay of recorded streams. |
| Log export | `packages/session-query/session-log-export` | opt-in | Web-app bundle, not base. |

## Mechanisms worth knowing

- **Flush is the only barrier**: `append` is "best-effort" inside a fixed 200 ms batching window; after a failed background write the next flush rejects, in order, with the automatic path paused. The policy flushes before the adapter stream, before a top-level tool body (after policy and guards) and at `agent/pre-step`, fail-closed; without it a backend is "valid but weaker". Stated limit: "Durable execution intent, not exactly-once effects". `docs/subsystems/persistence.md`, `packages/session/session-checkpoint-policy/README.md`
- **Repair**: per unmatched tool-call BLOCK of the assistant message (never a scan for call events) one error `tool/result` — `TOOL_OUTCOME_UNKNOWN` if a `tool/call` was logged ("retry only if the operation is read-only or idempotent … Do not retry blindly"), else `TOOL_NOT_STARTED`, and only the first cites its call in `sourceEventSeqs` — then `step/end` and `turn/end{interrupted}`. Deterministic (seqs continue, the last real timestamp is reused); the effect is never recorded. The pending map clears at `step/end` too, so repair reaches ONE step at the tail and a log with no open turn yields nothing. `packages/core/session/src/repair.ts`
- **Who repairs**: persistence "does not truncate or repair"; resume appends closers under write ownership, with no flush of its own (a second crash recomputes them); session-query balances COLD logs in memory only. Repair reads turn, step and tool events; a plugin opener before the last `session/end-seed` is dead, judged by its owner. `docs/subsystems/persistence.md`
- **Physical format**: `create` writes nothing; the first append publishes without overwrite (POSIX `link()`, Windows rename); each batch is one checksummed zstd frame fsynced before append resolves. Readers never return a torn tail; the write handle truncates it after admission checks. Mid-file damage is corruption. `packages/session/session-persistence-jsonl/README.md`
- **Single writer**: in-process claim plus a kernel lock (`flock(2)` on `session.lock`; a Windows named semaphore), taken lazily, dies with the process, no TTL; a wedged live holder blocks writers. `docs/subsystems/persistence.md` still says "write lease". `packages/session/session-persistence-jsonl/README.md`
- **Format generations**: `SESSION_FORMAT_VERSION = 3`, matching the release record; an alpha publication creates format obligations. Generations are immutable files: read-open migrates in memory, write-open stages, verifies and publishes without overwrite. An unknown event type is REQUIRED unless marked `ignorable: true`; refusal is `SessionFormatUnsupportedError`, distinct from corruption. `docs/session-format-status.md`, `packages/core/session/src/types.ts`, `docs/subsystems/persistence.md`
- **A dispatch fact exists, for sub-calls only**: `tool/ptc-dispatch-start`/`tool/ptc-dispatch`, a log-only start/settle pair keyed by call id, appended when the scheduler STARTS a PTC sub-call (an abandoned queued one logs nothing), arguments normalized first, ignored by `deriveMessages()`. It fires BEFORE its gate and repair closes neither. A TOP-LEVEL call gets no such fact, only the fail-closed flush. A LIVE cancel pair (`ABORTED_BEFORE_DISPATCH`/`ABORTED`) is decided from in-process knowledge the log does not keep: four words for "did it run", two surviving a crash. `packages/core/tools/src/types.ts`, `docs/subsystems/tools.md`
- **Effects are computed and then discarded, by decision**: per-turn git snapshots, a pre-body copy of each file a write names, content-addressed by SHA-1, changed lines counted — kept on the Host, dropped with the process. Upstream reserves "effect" for FILE effects and "intent" for the fs freshness waterfall, so neither word means what it means here. `packages/deliverables/workspace-changes/README.md`
- **Approvals, queued input**: `tool/call` is logged before policy, the approval ask and guards. An ask appends log-only `approval/asked` then `approval/decided`; policy is the last `approval/policy` event; repair has no approval closer. Every inbox mutation commits one persisted log-only `agent/inbox/spliced` event (`docs/persistence-catalog.md`); only `agent/inbox/inserted`, `claimed` and `discarded` are runtime emits. `docs/tool-execution-pipeline.md`, `docs/subsystems/approval.md`, `docs/agent-lifecycle.md`
- **Cancel, fork, replay**: cancel ends the turn `aborted`, no parked state; fork rejects a boundary inside an open turn and stamps `session/end-seed{inherited:true}`; replay binds scripts "in first-call order", so concurrent siblings bind non-deterministically (deferred). `docs/subsystems/session.md`, `packages/test-support/llm-replay/README.md`
- **Cache, retention**: the projection cache writes every 200 events or 5000 ms, after the log flush (may lag, never lead), fail-soft. "Nothing deletes session files". `packages/bundle/base/cordis.patch.yml`, `docs/subsystems/session-projection.md`

## Why it matters to MiniDSH

- **S14, BUILT** (ARCH §12 holds the divergences). What is left for later: upstream's recovery split is trustworthy only because the call record is fsynced before the body, so MiniDSH's holds against process death, not power loss (S16 measures it); upstream's other answer to an uncertain effect is a provider idempotency key off `exec.callId`, which `callId` keying leaves open; its kernel lock needs no stale cleanup but cannot recover a wedged holder, the opposite trade to MiniDSH's lease. Repair is safe only under that ownership.
- **S15**: policy as a log event and the asked/decided pair transfer. An upstream approval's subject is `{agent, toolName, callId?, reason?}` and no more, and its waterfalls may rewrite a call between the logged `tool/call` and the body — so upstream cannot prove the approved arguments are the executed ones either. A structured subject, grants and enforcement acceptance have NO oracle.
- **S16, format evolution**: never rewrite a log: publish immutable generations without overwrite, migrate reads in memory, make "cannot faithfully read" a distinct error naming the raw file. MiniDSH's additive version 0 has no refusal rule, and the published `minidsh@1.0.0` already created the obligation.
- **S16, durability, verify, salvage**: upstream pairs fsync per batch with a 200 ms window and fail-closed barriers; measure before copying. Its salvage is tail-only and write-path-only; MiniDSH's `.torn` sidecar keeps what upstream discards. No standalone verifier exists: `sessions inspect/verify` has only the query seam as a partial oracle.
- **S16 replay, S21**: upstream replay is test-only and carries MiniDSH's exact first-request-order defect, deferred. NO oracle: key by an identity recorded in the parent log.
- **S17**: upstream's inbox is DURABLE too (`agent/inbox/spliced`), so MiniDSH's op-shaped one has an oracle, and completion through it is upstream's shape — though its JOBS leave no events.
- **No oracle**: deletion, and retention beyond "nothing deletes session files". What was listed here as falsified now lives once, in [assumptions.md](../assumptions.md).

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/session.md` | Envelope, turn ends, fork, end-seed | 2026-09-19 |
| `docs/subsystems/persistence.md` | Handles, barriers, repair ownership | 2026-09-19 |
| `packages/core/session/src/repair.ts` | Recovery codes and closer order | 2026-09-19 |
| `packages/core/session/src/types.ts` | Format constant, `ignorable` | 2026-09-19 |
| `packages/session/session-persistence-jsonl/README.md` | fsync, torn tail, lock, no delete | 2026-09-19 |
| `packages/session/session-checkpoint-policy/README.md` | Barriers; intent, not effect | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Default rows | 2026-09-19 |
| `packages/bundle/sdk-minimal/cordis.patch.yml` | Standalone tree, invariants | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Log export, unarchive UI | 2026-09-19 |
| `docs/session-format-status.md` | Released format 3 | 2026-09-19 |
| `docs/persistence-changes` | Schema records to 2026-09-14 | 2026-09-19 |
| `docs/subsystems/approval.md` | Audit pair, policy event | 2026-09-19 |
| `docs/tool-execution-pipeline.md` | `tool/call` precedes the ask | 2026-09-19 |
| `packages/core/tools/src/types.ts`, `docs/subsystems/tools.md` | PTC dispatch pair; live cancel pair | 2026-09-20 |
| `packages/deliverables/workspace-changes/README.md` | Effects computed, then dropped | 2026-09-20 |
| `docs/agent-lifecycle.md` | Turn flow; its diagram does NOT say what persists | 2026-09-19 |
| `docs/persistence-catalog.md` | `agent/inbox/spliced` persists: THE authority on durability | 2026-09-20 |
| `docs/subsystems/session-projection.md` | Fold units, cache checkpoints | 2026-09-19 |
| `docs/subsystems/session-query.md` | Event windows, traces, lineage | 2026-09-19 |
| `packages/test-support/llm-replay/README.md` | Test-only; first-call-order limit | 2026-09-19 |

## Likely to go stale

- The writer format number: v0 to v3 in about three months, four `docs/persistence-changes` records in four days.
- Bundle rows and location: composition already left `packages/preset`; `openAt: never` is an overridable default.
- The closer set in `repair.ts` — five commits back to 2026-08-09 add none, but plugin families may — and zero-config durability (knobs are a common later addition).
- Replay keying, deferred "until such a scenario exists"; the web unarchive UI hints at a retention seam.

## Not read

- Under `docs/subsystems`: `storage.md`, `session-reference.md`, `session-telemetry.md` (OTel export and `session-log-deepseek` ship in base, unmapped), `invariants.md`. `docs/event-producer-consumer.md`, `docs/defensive-patterns.md`.
- Exist, not re-read: backend `src/storage.ts`, `src/zstd.ts`, `src/generation.ts`; `native/system/README.md`; `.agents/notes/implemented/architecture/`.
- How resume rebuilds the inbox projection; web archive semantics; cache row collection; when `SessionOwnershipLostError` fires.
- `packages/experimental/inspector` or any fsck-style verifier; `docs/postmortem` 0001-0004.
