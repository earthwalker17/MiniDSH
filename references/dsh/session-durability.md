# DSH reference: Session log and durable execution

> Where to research DSH's session log, repair, format generations and replay: pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2), checked 2026-09-26; the S17 rows rechecked at `57190202` (2026-10-14) on 2026-10-15 ([reading rules](../README.md)).

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
| Format chain | `packages/session/session-format` (and `-v0-to-v1` to `-v3-to-v4`, `-catalog`) | default-mounted | Frozen migrations; writer and released v4; additive kinds same-version |
| Projection registry, cache | `packages/session/session-projection`, `packages/session/session-projection-cache` | default-mounted | Pure folds; a rebuildable fail-soft cache with no eviction or retention surface |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; search off (`openAt: never`) |
| Runtime invariants | (deleted `f028f256`, 2026-09-30) | removed | Every `./invariant` companion and `ctx.invariants`; relational rules left to tests |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only replay of recorded streams |

## Open for the route

- **Unscheduled since S16.** A provider idempotency key off `exec.callId` is upstream's other answer to an uncertain effect (`packages/session/session-checkpoint-policy/README.md:115`); a raw-mode (uncompressed) log detects damage by a `turn/end` heuristic, not a frame checksum (`packages/session/session-persistence-jsonl/src/format.ts`).
- **S17, job brackets.** Owned jobs persist log-only `job/registered`, `job/settled` (no turn or step field; a settlement may follow `turn/end`); repair still reads turn, step and tool events only (`ToolCallRecovery`, shared with live failed steps), never closes a job, and invents no finish. `docs/persistence-catalog.md`, `packages/core/session/src/repair.ts`
- **S17, replay.** `llm-replay` replays model streams only: jobs really run, and the snapshot harness pins whatever order the run produced, normalizing job ids and times. `packages/test-support/session-snapshot/src/normalize.ts`

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
| `packages/bundle/{base,sdk-minimal,web-app}/cordis.patch.yml` | Default rows; the standalone tree; log export (web-app only), `:memory:` query, workspace-changes | 2026-09-26 |
| `docs/session-format-status.md`, `docs/persistence-changes` | Released and finalized 4 (`dsh-v0.2.0-rc.2`); `job/*` added same-version | 2026-10-15 |
| `packages/deliverables/workspace-changes/README.md` | Marker persisted, summary Host-only | 2026-09-26 |
| `docs/persistence-catalog.md` | What persists: THE authority; no writer field; 62 kinds | 2026-10-15 |
| `docs/subsystems/session-projection.md`, `packages/session/session-projection-cache/README.md` | Folds, cache checkpoints, `ver` invalidation; no eviction surface | 2026-09-26 |
| `docs/subsystems/session-query.md` | Event windows, traces, lineage, search scopes | 2026-09-26 |
| `packages/test-support/llm-replay/README.md` | Test-only, tools really run; first-call order | 2026-09-26 |
| `.agents/notes/implemented/bug-fix/2026-09-24-exited-holder-lock-takeover.md` | The PID-probe takeover is `dsh-atomic-write`'s `<file>.lock` for settings and profiles, not the Session lease; moving it onto the kernel lock is "the stronger fix" | 2026-09-26 |

## Likely to go stale

- `docs/persistence-changes` gains records every few days, and same-version additions need review since 2026-10-08.
- `openAt: never` is an overridable default.
- `repair.ts` was refactored into `ToolCallRecovery` 2026-09-25 with the same closer output; durability is zero-config (knobs come later).
- Replay keying, deferred "until such a scenario exists"; the web archive may grow a retention seam.

## Not read

- `docs/defensive-patterns.md` beyond its head.
- Exist, not re-read: backend `src/storage.ts`, `src/zstd.ts`, `src/generation.ts`, `src/catalog-migration.ts`, `src/migration-verifier.ts`; `scripts/migrate-sessions-to-v4.ts`; `packages/experimental/inspector` (a CDP tool for a live host, no stored-log verifier).
