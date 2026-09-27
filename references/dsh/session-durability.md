# DSH reference: Session log and durable execution

> Where to research DSH's session log, repair, format generations and replay: pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2), checked 2026-09-26 ([reading rules](../README.md)).

## What exists (at the pin)

Default-mounted = a row in `packages/bundle/base/cordis.patch.yml`; the standalone sdk-minimal bundle mounts no checkpoint policy, cache or query.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Session, SessionStore | `packages/core/session` | default-mounted | Append-only typed log; history is a fold |
| `openTurnClosers` | `packages/core/session/src/repair.ts` | default-mounted | Two causes, one mechanism: `interrupted` (crash), `forked` (seed cut in an open turn) |
| Persistence seam | `packages/session/session-persistence` | default-mounted | Read, append, flush, close; no delete |
| JSONL backend | `packages/session/session-persistence-jsonl` | default-mounted | The only backend: framed, fsynced, locked |
| Write lease | `session-persistence-jsonl/src/lease.ts`, `native/system` | default-mounted | A KERNEL lock (`flock` addon on POSIX, koffi named semaphore on Windows): dies with its holder, never probed |
| Checkpoint policy | `packages/session/session-checkpoint-policy` | default-mounted | Fail-closed flush barriers |
| Format chain | `packages/session/session-format` (and `-v0-to-v1` to `-v3-to-v4`, `-catalog`) | default-mounted | Frozen migrations; writer at v4; generated catalog |
| Projection registry, cache | `packages/session/session-projection`, `packages/session/session-projection-cache` | default-mounted | Pure folds; a rebuildable fail-soft cache with no eviction or retention surface |
| Storage domains | `packages/storage` | default-mounted | Non-log state: projection cache, schedule tasks |
| Telemetry export | `packages/session/session-telemetry`, `-otel` | default-mounted | Canonical-event capture behind a redaction waterfall |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; search off (`openAt: never`) |
| Invariant companion | `packages/core/session/src/invariant.ts` | opt-in | Pairing checks; sdk-minimal, not base |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only replay of recorded streams |
| Log export | `packages/session-query/session-log-export` | opt-in | Web-app bundle, not base |

## Open for the route

- **Open after S16 (S16.5 or later):** a provider idempotency key off `exec.callId` is upstream's other answer to an uncertain effect (`packages/session/session-checkpoint-policy/README.md:115`); a raw-mode (uncompressed) log detects damage by a `turn/end` heuristic, not a frame checksum (`packages/session/session-persistence-jsonl/src/format.ts`).
- **S17, job brackets.** Repair reads turn, step and tool events only, its pending map clearing at every `step/end`; a plugin's opener before the last `session/end-seed` is dead, judged by the plugin whose vocabulary it is. No `job/*` kind persists. `docs/subsystems/persistence.md`, `docs/persistence-catalog.md`
- **S17, who listens.** A generated per-event matrix of dispatchers and listeners. `docs/event-producer-consumer.md`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/session.md` | Envelope, `turn/end` reasons, fork seed marker and `forked` closers | 2026-09-26 |
| `docs/subsystems/persistence.md` | Handles, barriers, repair under write ownership, refusal | 2026-09-26 |
| `packages/core/session/src/repair.ts` | Recovery codes, closer order, one tail step | 2026-09-26 |
| `packages/core/session/src/types.ts`, `packages/session/session-persistence/src/errors.ts` | Format constant; an unknown kind refused unless `ignorable`; `SessionFormatUnsupportedError` distinct from corruption | 2026-09-26 |
| `packages/session/session-persistence-jsonl/src/{index,format,lease}.ts` | fsync per batch, no directory sync on Windows; raw-mode damage heuristic; kernel lock, `SessionAlreadyOwnedError`, release never removes the lock file | 2026-09-26 |
| `packages/session/session-persistence-jsonl/README.md` | Frames, fsync, torn tail, lock, no delete | 2026-09-26 |
| `packages/session/session-checkpoint-policy/README.md` | Barriers; intent, not exactly-once | 2026-09-19 |
| `packages/bundle/{base,sdk-minimal,web-app}/cordis.patch.yml` | Default rows; the standalone tree; log export, `:memory:` query, workspace-changes | 2026-09-26 |
| `docs/session-format-status.md`, `docs/persistence-changes` | Released 3, finalized (writer) 4; schema records to 2026-09-20 | 2026-09-26 |
| `packages/deliverables/workspace-changes/README.md` | Marker persisted, summary Host-only | 2026-09-26 |
| `docs/persistence-catalog.md` | What persists: THE authority; no writer field | 2026-09-26 |
| `docs/subsystems/session-projection.md`, `packages/session/session-projection-cache/README.md` | Folds, cache checkpoints, `ver` invalidation; no eviction surface | 2026-09-26 |
| `docs/subsystems/session-query.md`, `storage.md`, `session-telemetry.md` | Event windows, traces, lineage, search scopes; non-log state; capture and redaction | 2026-09-26 |
| `packages/test-support/llm-replay/README.md` | Test-only, tools really run; first-call order | 2026-09-26 |
| `.agents/notes/implemented/bug-fix/2026-09-24-exited-holder-lock-takeover.md` | The PID-probe takeover is `dsh-atomic-write`'s `<file>.lock` for settings and profiles, not the Session lease | 2026-09-26 |

## Likely to go stale

- The writer format number: v0 to v4 in about three months (v4 finalized 2026-09-19, v3 released); `docs/persistence-changes` gains records every few days; the JSONL README changed eight times 2026-09-19/20.
- Bundle rows and their location (presets now live under `packages/bundle/web-app/presets`); `openAt: never` is an overridable default.
- The closer set in `repair.ts` (unchanged since 2026-09-18) and zero-config durability (knobs come later).
- Lock takeover: the 2026-09-24 note calls moving `withFileLock` onto the kernel lock "the stronger fix"; the Session lease itself did not move.
- Replay keying, deferred "until such a scenario exists"; the web archive now stops work before hiding it and may grow a retention seam.

## Not read

- `docs/subsystems/session-reference.md` (not durability), `docs/defensive-patterns.md`, `docs/subsystems/invariants.md` beyond their heads.
- Exist, not re-read: backend `src/storage.ts`, `src/zstd.ts`, `src/generation.ts`, `src/catalog-migration.ts`, `src/migration-verifier.ts`; `scripts/migrate-sessions-to-v4.ts`; `packages/experimental/inspector` (a CDP tool for a live host, no stored-log verifier).
