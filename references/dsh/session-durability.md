# DSH reference: Session log and durable execution

> Where to research DSH's session log, repair, format generations, forks and replay ([reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, dsh-v0.2.2-rc.5); checked 2026-11-21 (S22.5).

## What exists (at the pin)

Default-mounted = a row in `packages/bundle/base/cordis.patch.yml`; sdk-minimal's own tree mounts the registry, the working directory and the checkpoint policy, no cache or query.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Session, SessionStore | `packages/core/session` | default-mounted | Append-only typed log, history a fold (`deriveMessages`); store-owned writes wait for `session/created` |
| `openTurnClosers`, `ToolCallRecovery` | `packages/core/session/src/repair.ts` | default-mounted | Tail-turn closers, cause `interrupted` or `forked`, shared with live failed steps (the ledger has their reach) |
| Persistence seam | `packages/session/session-persistence` | default-mounted | `create/open/stat/list`; handles `read/append/flush/close`; a fork is `create(header, {source})` with its whole history, no source in its header; no delete or retention |
| JSONL backend | `packages/session/session-persistence-jsonl` | default-mounted | The only SHIPPED backend: 200 ms write-behind batches, fsync per batch, checksummed zstd frames (raw under `compression: 'none'`); a fork COPIES its history |
| SQLite backend | `packages/session/session-persistence-sqlite` | opt-in, in no profile (2026-11-14) | One `<root>/.segments/sessions.sqlite` of predecessor-linked Segments: a fork SHARES the parent's persisted prefix; imports a JSONL history on first open; current format only |
| Write lease | `packages/session/session-persistence-jsonl/src/{lease,win32}.ts` | default-mounted | A KERNEL lock (`flock` addon on POSIX, koffi named semaphore on Windows): dies with its holder, never probed, no expiry |
| Checkpoint policy | `packages/session/session-checkpoint-policy` | default-mounted | Fail-closed flush before a model request, a top-level tool body and a step |
| Format chain | `packages/session/session-format` (`-v0-to-v1` … `-v3-to-v4`, `-catalog`) | default-mounted | Immutable generations and frozen adjacent migrations (the ledger has the rule); v4 writer, finalized and released; a V3→V4 parent restore reads its direct children's files |
| Working directory | `packages/session/working-directory` | default-mounted | A session's directory folds log-only `workspace-root/change` (Host moves only, 2026-11-13); the header keeps the original project |
| Projections | `packages/session/session-projection`, `-cache` | default-mounted | Pure folds; `register()` yields a `ProjectionHandle`; fail-soft cache, no eviction |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; search off (`openAt: never`); model tools in `packages/experimental/tool-session-query` |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only model streams; tools really run |

## Open for the route

- **A per-boot lease identity, off Linux (BLUEPRINT §3).** Upstream needs none: the lease is a kernel object the OS releases on any process death, with deliberately no expiry. MiniDSH's lease is a file, and since S22.5 it records the Linux boot id (`src/capabilities/persistence-jsonl/index.ts`); Windows still rests on uptime and macOS on the pid probe alone. `packages/session/session-persistence-jsonl/src/lease.ts`
- **Detached children (BLUEPRINT §3).** Repair is per Session and closes only a tail turn: a parent dying with resident children or open jobs records nothing about them. `packages/core/session/src/repair.ts`
- **Workspace-lifetime grants (BLUEPRINT §3).** A store keyed by canonical root meets a root that moves: since rc.4 `workspace-write` follows the session's `workspace-root/change`, not the header's project. `docs/upgrade-guide/v0.2.2-rc.4/workspace-write-boundary-follows-root/guide.md`
- **What projection a rename needs (BLUEPRINT §3).** `session/title` is log-only, folded by a `title` unit; the cache checkpoints each session at creation, every `turn/end` and disposal, and list rows read it with zero I/O. `packages/session/session-projection-cache/README.md`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/{session,persistence}.md` | Envelope, `deriveMessages`, `turn/end` reasons, `session/end-seed`, fork API; repair only under write ownership | 2026-11-21 |
| `packages/core/session/{README.md,src/{repair,types,fork}.ts}` | Recovery codes, closer order; header fields, no writer; plugin records | 2026-11-21 |
| `packages/session/session-persistence-jsonl/{README.md,src/{format,storage,lease,win32}.ts}` | Frames, fsync, the 200 ms window, torn tail, raw mode's damage heuristic, the lock | 2026-11-21 |
| `packages/session/{session-persistence,session-persistence-sqlite,session-checkpoint-policy}/README.md` | The seam, no delete; Segments, import, the shared prefix; barriers, intent not exactly-once, an idempotency key off the call id | 2026-11-21 |
| `packages/bundle/{base,sdk-minimal}/cordis.patch.yml` | Default rows; sdk-minimal's own tree | 2026-11-21 |
| `docs/session-format-status.md`, `docs/persistence-changes/` | Writer, finalized and released 4 (`dsh-v0.2.0-rc.2`); records through 2026-11-13 | 2026-11-21 |
| `docs/persistence-catalog.md` | What persists: THE authority; 64 kinds | 2026-11-21 |
| `packages/session/working-directory/README.md`, `docs/upgrade-guide/v0.2.2-rc.3/working-directory-tool-removed` | Who moves a session's directory; where a stored session resumes | 2026-11-21 |
| `packages/deliverables/workspace-changes/README.md` | `workspace/changes {turn}` persisted, summary Host-only | 2026-11-21 |
| `packages/session/{session-projection-cache,session-title}/README.md` | Checkpoints, list reads, titles | 2026-11-21 |
| `packages/api/session-controller/src/{types,archived-session-gate}.ts`, `docs/upgrade-guide/v0.2.2-rc.3/session-fork-source` | `session.fork {sessionId, atSeq?, allowMigration?}` unchanged; the fork source; archive gates work, nothing deletes | 2026-11-21 |
| `packages/test-support/llm-replay/{README.md,src/index.ts}` | First-call order; keying still deferred | 2026-11-21 |
| `.agents/notes/implemented/{architecture/2026-10-23-independent-session-forks,process/2026-10-08-session-reader-compatibility-review}.md` | Why a fork records no source; reader behaviour decides a version bump | 2026-11-21 |

## Likely to go stale

- The SQLite backend is a week old; a profile adopting it turns a fork from a copy into a shared prefix.
- `docs/persistence-changes` gains a record every few days (six since 2026-10-27).
- `docs/subsystems/session.md` still says the fork API "rejects" an open cut beside "closes any open tail".

## Not read

- `packages/session/session-persistence-jsonl/src/{generation,catalog-migration}.ts`: doc comments only; `migration-verifier.ts`, `scripts/migrate-sessions-to-v4.ts`, `packages/session/session-persistence-sqlite/src/`: unread.
- `docs/subsystems/session-projection.md` beyond a search; `docs/subsystems/working-directory.md`; the snapshot bodies under `snapshots/session/`.
