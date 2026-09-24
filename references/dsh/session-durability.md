# DSH reference: Session log and durable execution

> Where to research DSH's session log, repair, format generations and replay: pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17), checked 2026-09-20 ([reading rules](../README.md)).

## What exists (at the pin)

Default-mounted = a row in `packages/bundle/base/cordis.patch.yml`; the standalone sdk-minimal bundle mounts no checkpoint policy, cache or query.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Session, SessionStore | `packages/core/session` | default-mounted | Append-only typed log; history is a fold |
| `interruptedTurnClosers` | `packages/core/session/src/repair.ts` | default-mounted | Closers for a crash-orphaned tail turn |
| Persistence seam | `packages/session/session-persistence` | default-mounted | Read, append, flush, close; no delete |
| JSONL backend | `packages/session/session-persistence-jsonl` | default-mounted | The only backend: framed, fsynced, locked |
| Checkpoint policy | `packages/session/session-checkpoint-policy` | default-mounted | Fail-closed flush barriers |
| Format chain | `packages/session/session-format` (and `-v0-to-v1` to `-v2-to-v3`, `-catalog`) | default-mounted | Frozen migrations; generated catalog |
| Projection registry, cache | `packages/session/session-projection`, `packages/session/session-projection-cache` | default-mounted | Pure folds; rebuildable, fail-soft cache |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; search off (`openAt: never`) |
| Invariant companion | `packages/core/session/src/invariant.ts` | opt-in | Pairing checks; sdk-minimal, not base |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only replay of recorded streams |
| Log export | `packages/session-query/session-log-export` | opt-in | Web-app bundle, not base |

## Open for the route

- **S16, format evolution.** A reader that cannot faithfully read refuses with `SessionFormatUnsupportedError`, distinct from corruption and naming the raw file; reads migrate in memory, and a write-open publishes a new generation without overwrite. `docs/subsystems/persistence.md`
- **S16, checkpoint durability.** Flush is the only barrier: `append` is best-effort in a 200 ms batch; the policy flushes fail-closed before the adapter stream, before a top-level tool body (after policy and guards) and at `agent/pre-step`. `packages/session/session-checkpoint-policy/README.md`
- **S16, salvage.** Detection rests on the frame: each batch is one checksummed zstd frame; the first append publishes the file without overwrite (POSIX `link()`, Windows rename). `packages/session/session-persistence-jsonl/README.md`
- **S16, inspect and verify.** No standalone verifier found (the inspector is unread); the nearest oracle is session-query, which balances an unfinished COLD log in memory only. `docs/subsystems/persistence.md`
- **S16, audit of attempts.** Stated limit: "durable execution intent, not exactly-once effects"; the other answer to an uncertain effect is a provider idempotency key off `exec.callId`, which MiniDSH's `callId` keying leaves open. `packages/session/session-checkpoint-policy/README.md`
- **S16, replay as a capability.** Nothing to copy: upstream replay is a test-only harness. `packages/test-support/llm-replay/README.md`
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
| `docs/session-format-status.md` | Released format 3; alpha obligations | 2026-09-19 |
| `docs/persistence-changes` | Schema records to 2026-09-14 | 2026-09-19 |
| `packages/deliverables/workspace-changes/README.md` | Effects computed, then dropped | 2026-09-20 |
| `docs/persistence-catalog.md` | What persists: THE authority | 2026-09-20 |
| `docs/subsystems/session-projection.md` | Folds, cache checkpoints, no deletion | 2026-09-19 |
| `docs/subsystems/session-query.md` | Event windows, traces, lineage | 2026-09-19 |
| `packages/test-support/llm-replay/README.md` | Test-only; first-call order | 2026-09-19 |

## Likely to go stale

- The writer format number: v0 to v3 in about three months, four `docs/persistence-changes` records in four days.
- Bundle rows and their location (composition already left `packages/preset`); `openAt: never` is an overridable default.
- The closer set in `repair.ts` (plugin families may add some), and zero-config durability (knobs come later).
- Replay keying, deferred "until such a scenario exists"; the web unarchive UI hints at a retention seam.

## Not read

- Under `docs/subsystems`: `storage.md`, `session-reference.md`, `session-telemetry.md` (OTel export and `session-log-deepseek` ship in base, unmapped), `invariants.md`. `docs/event-producer-consumer.md`, `docs/defensive-patterns.md`.
- Exist, not re-read: backend `src/storage.ts`, `src/zstd.ts`, `src/generation.ts`; `native/system/README.md`; `.agents/notes/implemented/architecture/`.
- How resume rebuilds the inbox projection; web archive semantics; cache row collection; when `SessionOwnershipLostError` fires.
- `packages/experimental/inspector` or any fsck-style verifier; `docs/postmortem` 0001-0004.
- Whether any composition record persists upstream (ARCH once called one absent, unsourced): the catalog would say.
