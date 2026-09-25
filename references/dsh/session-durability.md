# DSH reference: Session log and durable execution

> Where to research DSH's session log, repair, format generations and replay: pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24) for format, durability, salvage, inspection and replay (re-read in S16, 2026-09-26); the rest at `ddefc45f` (2026-09-17) ([reading rules](../README.md)).

## What exists (at the pin)

Default-mounted = a row in `packages/bundle/base/cordis.patch.yml`; the standalone sdk-minimal bundle mounts no checkpoint policy, cache or query.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Session, SessionStore | `packages/core/session` | default-mounted | Append-only typed log; history is a fold |
| `interruptedTurnClosers` | `packages/core/session/src/repair.ts` | default-mounted | Closers for a crash-orphaned tail turn |
| Persistence seam | `packages/session/session-persistence` | default-mounted | Read, append, flush, close; no delete |
| JSONL backend | `packages/session/session-persistence-jsonl` | default-mounted | The only backend: framed, fsynced, locked |
| Checkpoint policy | `packages/session/session-checkpoint-policy` | default-mounted | Fail-closed flush barriers |
| Format chain | `packages/session/session-format` (and `-v0-to-v1` to `-v3-to-v4`, `-catalog`) | default-mounted | Frozen migrations; writer at v4; generated catalog |
| Projection registry, cache | `packages/session/session-projection`, `packages/session/session-projection-cache` | default-mounted | Pure folds; rebuildable, fail-soft cache |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; search off (`openAt: never`) |
| Invariant companion | `packages/core/session/src/invariant.ts` | opt-in | Pairing checks; sdk-minimal, not base |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only replay of recorded streams |
| Log export | `packages/session-query/session-log-export` | opt-in | Web-app bundle, not base |

## Open for the route

- **Built in S16** (format rule, lifecycle record, synced checkpoints, cold verify/inspect, salvage): MiniDSH's side is ARCH §4 and §12. Upstream at the pin: an unknown kind is refused unless `ignorable`, envelope and header keys closed, `SessionFormatUnsupportedError` distinct from corruption (`packages/session/session-persistence/src/errors.ts`); no writer provenance is recorded (`docs/persistence-catalog.md`); fsync per batch plus the directory at creation on POSIX, nothing for a directory on Windows (`packages/session/session-persistence-jsonl/src/index.ts`); no stored-log verifier (`packages/experimental/inspector` is a CDP tool for a live host); replay test-only, tools really run (`packages/test-support/llm-replay/README.md`).
- **S16, still open:** a provider idempotency key off `exec.callId` is upstream's other answer to an uncertain effect (`packages/session/session-checkpoint-policy/README.md:115`); a raw-mode (uncompressed) log detects damage by a `turn/end` heuristic, not a frame checksum (`packages/session/session-persistence-jsonl/src/format.ts`).
- **S17, job brackets.** Repair reads turn, step and tool events only; a plugin's opener before the last `session/end-seed` is dead, judged by the plugin whose vocabulary it is. `docs/subsystems/persistence.md`
- **Built in S14 and S15** (dispatch fact, effect records, bracket closers, consent on the record): MiniDSH's side is ARCH §12, verdicts in [assumptions.md](../assumptions.md).

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/session.md` | Envelope, turn ends, fork | 2026-09-19 |
| `docs/subsystems/persistence.md` | Handles, barriers, repair ownership, refusal | 2026-09-19 |
| `packages/core/session/src/repair.ts` | Recovery codes, closer order | 2026-09-19 |
| `packages/core/session/src/types.ts` | Format constant, `ignorable` | 2026-09-19 |
| `packages/session/session-persistence-jsonl/README.md` | Frames, fsync, torn tail, lock, no delete | 2026-09-19 |
| `packages/session/session-checkpoint-policy/README.md` | Barriers; intent, not exactly-once | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Default rows | 2026-09-19 |
| `packages/bundle/sdk-minimal/cordis.patch.yml` | Standalone tree, invariants | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Log export, unarchive UI | 2026-09-19 |
| `docs/session-format-status.md` | Released 3, finalized (writer) 4; alpha obligations | 2026-09-26 |
| `docs/persistence-changes` | Schema records to 2026-09-20 | 2026-09-26 |
| `packages/deliverables/workspace-changes/README.md` | Effects computed, then dropped | 2026-09-20 |
| `docs/persistence-catalog.md` | What persists: THE authority; no writer field | 2026-09-26 |
| `docs/subsystems/session-projection.md` | Folds, cache checkpoints, no deletion | 2026-09-19 |
| `docs/subsystems/session-query.md` | Event windows, traces, lineage | 2026-09-19 |
| `packages/test-support/llm-replay/README.md` | Test-only; first-call order | 2026-09-19 |

## Likely to go stale

- The writer format number: v0 to v4 in about three months (v4 finalized 2026-09-19 while v3 is the released one), new `docs/persistence-changes` records every few days.
- Bundle rows and their location (composition already left `packages/preset`); `openAt: never` is an overridable default.
- The closer set in `repair.ts` (plugin families may add some), and zero-config durability (knobs come later).
- Replay keying, deferred "until such a scenario exists"; the web unarchive UI hints at a retention seam.

## Not read

- Under `docs/subsystems`: `storage.md`, `session-reference.md`, `session-telemetry.md` (OTel export and `session-log-deepseek` ship in base, unmapped), `invariants.md`. `docs/event-producer-consumer.md`, `docs/defensive-patterns.md`.
- Exist, not re-read: backend `src/storage.ts`, `src/zstd.ts`, `src/generation.ts`; `native/system/README.md`; `.agents/notes/implemented/architecture/`.
- How resume rebuilds the inbox projection; web archive semantics; cache row collection; when `SessionOwnershipLostError` fires.
- `docs/postmortem` 0001-0004 beyond their titles; `scripts/migrate-sessions-to-v4.ts` and its failure classifier.
- Whether any composition record persists upstream (ARCH once called one absent, unsourced): the catalog would say.
