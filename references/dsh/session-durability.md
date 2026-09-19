# DSH reference: Session log and durable execution

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

Default-mounted = a row in `packages/bundle/base/cordis.patch.yml`. `packages/bundle/sdk-minimal/cordis.patch.yml` is standalone ("does not layer over dsh-base"): it persists with no checkpoint-policy, cache or query row.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Session, SessionStore | `packages/core/session` | default-mounted | In-memory append-only typed event log; history is a fold. |
| `interruptedTurnClosers` | `packages/core/session/src/repair.ts` | default-mounted | Pure synthetic closers for a crash-orphaned tail turn. |
| Persistence seam | `packages/session/session-persistence` | default-mounted | `ctx.sessionPersistence` handles: read, append, flush, close; no delete. |
| JSONL backend | `packages/session/session-persistence-jsonl` | default-mounted | Only first-party backend: zstd frames, fsync per batch, kernel lock. |
| Checkpoint policy | `packages/session/session-checkpoint-policy` | default-mounted | Config-free fail-closed flush before model request, tool body, pre-step. |
| Format chain | `packages/session/session-format` (and `-v0-to-v1` to `-v2-to-v3`, `-catalog`) | default-mounted | Frozen adjacent migrations; generated catalog. |
| Projection registry, cache | `packages/session/session-projection`, `packages/session/session-projection-cache` | default-mounted | Pure fold units; rebuildable, fail-soft checkpoints. |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; `openAt: never` disables only search. |
| Invariant companion | `packages/core/session/src/invariant.ts` | opt-in | Runtime pairing checks; in sdk-minimal, not base. |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only replay of recorded assistant streams. |
| Log export | `packages/session-query/session-log-export` | opt-in | Web-app bundle, not base. |

## Mechanisms worth knowing

- **Flush is the only barrier**: `append` is "best-effort" inside a fixed batching window; after a failed background write the next flush rejects. The policy flushes before the adapter stream, before a top-level tool body (after policy and guards) and at `agent/pre-step`, fail-closed; without it a backend is "valid but weaker". Stated limit: "Durable execution intent, not exactly-once effects". `docs/subsystems/persistence.md`, `packages/session/session-checkpoint-policy/README.md`
- **Repair**: per unmatched tool-call block one error `tool/result`: `TOOL_OUTCOME_UNKNOWN` if a `tool/call` was logged ("Do not retry blindly"), else `TOOL_NOT_STARTED`; then `step/end` and `turn/end{interrupted}`. Closers are deterministic (seqs continue, the last real timestamp is reused); the effect is never recorded. `packages/core/session/src/repair.ts`
- **Who repairs**: persistence "does not truncate or repair" an open turn; resume appends closers under write ownership; session-query balances cold logs in memory only. Repair reads only turn, step and tool events; a plugin opener before the last `session/end-seed` is dead, judged by its owner. `docs/subsystems/persistence.md`, `docs/subsystems/session.md`
- **Physical format**: `create` writes nothing; first append publishes without overwrite (POSIX `link()`, Windows rename); each batch is one checksummed zstd frame fsynced before append resolves. Readers never return a torn tail; the write handle truncates it, after admission checks. Mid-file damage is corruption. `packages/session/session-persistence-jsonl/README.md`
- **Single writer**: in-process claim plus a kernel lock (`flock(2)` on `session.lock`; a Windows named semaphore), taken lazily, dies with the process, no TTL; a wedged live holder blocks writers. `docs/subsystems/persistence.md` still says "write lease". `packages/session/session-persistence-jsonl/README.md`
- **Format generations**: `SESSION_FORMAT_VERSION = 3`, matching the release record; an alpha publication creates format obligations. Generations are immutable files: read-open migrates in memory; write-open stages, verifies, publishes without overwrite. An unknown event type is required unless marked `ignorable: true`; refusal is `SessionFormatUnsupportedError`, distinct from corruption. `docs/session-format-status.md`, `packages/core/session/src/types.ts`, `docs/subsystems/persistence.md`
- **Approvals, queued input**: `tool/call` is logged before policy, the approval ask and guards. An ask appends log-only `approval/asked` then `approval/decided`; policy is the last `approval/policy` event; repair has no approval closer. Every inbox mutation commits one persisted log-only `agent/inbox/spliced` event (`docs/persistence-catalog.md`); only `agent/inbox/inserted`, `claimed` and `discarded` are runtime emits. `docs/tool-execution-pipeline.md`, `docs/subsystems/approval.md`, `docs/agent-lifecycle.md`
- **Cancel, fork, replay**: cancel ends the turn `aborted`; no parked state. Fork rejects a boundary inside an open turn and stamps `session/end-seed{inherited:true}` in the child. Replay binds scripts "in first-call order"; concurrent siblings bind non-deterministically, fix deferred. `docs/subsystems/session.md`, `packages/test-support/llm-replay/README.md`
- **Cache, retention**: the projection cache writes every 200 events or 5000 ms, after the log flush (may lag, never lead), fail-soft. "Nothing deletes session files". `packages/bundle/base/cordis.patch.yml`, `docs/subsystems/session-projection.md`

## Why it matters to MiniDSH

- **S14, the two codes**: upstream's NOT_STARTED versus OUTCOME_UNKNOWN split is trustworthy only because the call record is fsynced before the tool body. MiniDSH has the codes and NO fsync: its split holds against process death, not power loss. S14 states that limit; S16 measures it.
- **S14, gate versus body**: upstream logs the call before the approval gate and repairs nothing for a pending ask, so a crash mid-ask would (inferred, untested) resume as outcome-unknown though no body ran. MiniDSH's durable gate-vs-body distinction and crash-cancelled approvals go further on purpose; NO oracle.
- **S14, brackets and effects**: upstream does NOT close every unfinished bracket: plugin brackets die by the lifetime marker. Closing them all is a deliberate MiniDSH difference; keep closers deterministic so cold reads and durable repair agree. The fs/shell effect record has NO oracle: upstream records intent only. Never imply exactly-once.
- **S14, the lease**: upstream's kernel lock needs no stale cleanup but cannot recover a wedged holder; MiniDSH's lease file is the opposite trade. Repair is safe only under that ownership.
- **S15**: policy as a log event and the asked/decided pair transfer; a structured subject, session-lifetime grants and enforcement acceptance have NO oracle here.
- **S16, format evolution**: never rewrite a log: publish immutable generations without overwrite, migrate reads in memory, make "cannot faithfully read" a distinct error naming the raw file. MiniDSH's additive version 0 has no refusal rule, and the published `minidsh@1.0.0` already created the obligation.
- **S16, durability, verify, salvage**: upstream pairs fsync per batch with a batching window and fail-closed barriers; measure before copying. Its salvage is tail-only and write-path-only; MiniDSH's `.torn` sidecar keeps the evidence upstream discards. No standalone verifier was found: `sessions inspect/verify` has only the query seam (`docs/subsystems/session-query.md`) as a partial oracle.
- **S16 replay, S21**: upstream replay is test-only and carries MiniDSH's exact first-request-order defect, deferred. NO oracle: key by an identity recorded in the parent log.
- **S17**: upstream's inbox is DURABLE too (`agent/inbox/spliced`, a durable projection in the loop), so MiniDSH's op-shaped inbox has an oracle; job completion through it is upstream's shape as well, though upstream's JOBS leave no events.
- **Falsified**: "session-query is mounted by no shipped preset" (base mounts it, search disabled); "an interrupt parks work" (cancel ends the turn); composition under `packages/preset` (it is `packages/bundle/*/cordis.patch.yml`). Deletion and retention have NO oracle.

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/session.md` | Envelope, turn-end reasons, fork, end-seed | 2026-09-19 |
| `docs/subsystems/persistence.md` | Handles, flush barrier, repair ownership | 2026-09-19 |
| `packages/core/session/src/repair.ts` | Recovery codes, closer order | 2026-09-19 |
| `packages/core/session/src/types.ts` | Writer format constant, `ignorable` | 2026-09-19 |
| `packages/session/session-persistence-jsonl/README.md` | fsync, torn tail, lock, no deletion | 2026-09-19 |
| `packages/session/session-checkpoint-policy/README.md` | Three barriers, intent-not-effect | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Default rows and config | 2026-09-19 |
| `packages/bundle/sdk-minimal/cordis.patch.yml` | Standalone tree, invariant rows | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Log export, unarchive UI | 2026-09-19 |
| `docs/session-format-status.md` | Released format 3, tag `dsh-v0.1.5-alpha.1` | 2026-09-19 |
| `docs/persistence-changes` | Schema records up to 2026-09-14 | 2026-09-19 |
| `docs/subsystems/approval.md` | Audit pair, policy event | 2026-09-19 |
| `docs/tool-execution-pipeline.md` | `tool/call` precedes the approval ask | 2026-09-19 |
| `docs/agent-lifecycle.md` | Inbox claims; `agent/*` is live-only | 2026-09-19 |
| `docs/subsystems/session-projection.md` | Fold units, cache checkpoints | 2026-09-19 |
| `docs/subsystems/session-query.md` | Event windows, traces, lineage | 2026-09-19 |
| `packages/test-support/llm-replay/README.md` | Test-only, first-call-order limit | 2026-09-19 |

## Likely to go stale

- The writer format number: v0 to v3 in about three months, four `docs/persistence-changes` records in four days.
- Bundle rows and location: composition already left `packages/preset`; `openAt: never` is an overridable default.
- The closer set in `repair.ts` (plugin families may gain closers) and zero-config durability (knobs are a common later addition).
- Replay keying, deferred "until such a scenario exists"; the web unarchive UI hints at a retention seam.

## Not read

- Under `docs/subsystems`: `storage.md`, `session-reference.md`, `session-telemetry.md` (OTel export and `packages/session/session-log-deepseek` ship in base, unmapped), `invariants.md`. `docs/persistence-catalog.md`, `docs/event-producer-consumer.md`, `docs/defensive-patterns.md`, `docs/persistence-changes/README.md`.
- Resume in code (`packages/core/agent-loop`).
- Exist, not re-read for this map: backend `src/storage.ts`, `src/zstd.ts`, `src/generation.ts`; `native/system/README.md`; the history notes under `.agents/notes/implemented/architecture/`.
- A test for a crash while an approval is pending (outcome-unknown is inferred).
- A running tool body or subprocess on cancel (`docs/subsystems/jobs.md`, `docs/subsystems/subprocess.md`).
- How resume rebuilds the inbox projection from its events; web archive semantics; cache row collection; the batching window's length; when `SessionOwnershipLostError` fires.
- `packages/experimental/inspector` or any fsck-style verifier; `docs/postmortem` 0001 to 0004; last-change dates.
