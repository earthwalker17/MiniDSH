# DSH reference: Session log and durable execution

> Where to research DSH's session log, repair, format generations, forks and replay: pinned to `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, dsh-v0.2.1-rc.3), checked 2026-10-25 ([reading rules](../README.md)).

## What exists (at the pin)

Default-mounted = a row in `packages/bundle/base/cordis.patch.yml`; the standalone sdk-minimal tree mounts the registry and (since rc.2) the checkpoint policy, no cache or query.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Session, SessionStore | `packages/core/session` | default-mounted | Append-only typed log, history a fold (`deriveMessages`); store-owned writes wait for `session/created` (rc.2) |
| `openTurnClosers`, `ToolCallRecovery` | `packages/core/session/src/repair.ts` | default-mounted | ONE tail step, turn/step/tool events only, cause `interrupted` or `forked`; shared with live failed steps; never closes a job |
| Persistence seam | `packages/session/session-persistence` | default-mounted | `create/open/stat/list`; handles `read/append/flush/close`; no delete or retention |
| JSONL backend | `packages/session/session-persistence-jsonl` | default-mounted | The only backend: 200 ms write-behind batches, fsync per batch, checksummed zstd frames (raw under `compression: 'none'`) |
| Write lease | `session-persistence-jsonl/src/{lease,win32}.ts` | default-mounted | A KERNEL lock (`flock` addon on POSIX, koffi named semaphore on Windows): dies with its holder, never probed |
| Checkpoint policy | `packages/session/session-checkpoint-policy` | default-mounted | Fail-closed flush before a model request, a top-level tool body and a step |
| Format chain | `packages/session/session-format` (`-v0-to-v1` … `-v3-to-v4`, `-catalog`) | default-mounted | Immutable generations, frozen adjacent migrations; v4 writer, finalized and released |
| Plugin records | `appendPluginRecord`, `packages/core/session/README.md` | experimental only | `plugin:<owner>/<record>`, `ignorable`, outside released schemas |
| Projections | `packages/session/session-projection`, `-cache` | default-mounted | Pure folds; `register()` yields a `ProjectionHandle` (rc.2); fail-soft cache, no eviction |
| Session query | `packages/session-query/session-query-sqlite` | default-mounted | Exact reads, traces, lineage; search off (`openAt: never`); model tools in `experimental/tool-session-query` |
| Replay harness | `packages/test-support/llm-replay` | opt-in | Test-only model streams; tools really run |

## Open for the route

- **S21, parallel calls.** Each call's `tool/call` is appended when it starts, before policy and the ask; results commit in model order, so a crash mid-batch closes every started call `TOOL_OUTCOME_UNKNOWN`, in assistant order. `packages/core/tools/src/batch.ts`, `packages/core/session/src/repair.ts`
- **S21, continuable children.** Identity is the child's OWN `subagent/descriptor` (once, before its first request; a continuable one carries persona, `toolFilter` and route) plus the parent's `subagent/catalog`; an inherited descriptor proves nothing, only a direct child cold-resumes, a missing selected preset refuses. Only the call's result text `started subagent <id>` joins child to call. `packages/subagent/subagent/README.md`, `packages/subagent/tool-subagent/src/index.ts`
- **S21, replay.** First-call-order binding, deferred "until such a scenario exists" (concurrent siblings); jobs really run, snapshots normalize job ids. `packages/test-support/llm-replay/README.md`, `packages/test-support/session-snapshot/src/normalize.ts`
- **S22, fork on the wire.** `session.fork {sessionId, atSeq?, allowMigration?}`: omitted = latest completed-turn prefix; an open cut gets `forked` closers (`core/session/src/fork.ts`; `session.md`'s "rejects" is stale). Since rc.3 an ordinary fork records no source; `parentSession` is a subagent's creator, `origin: 'subagent'` the classifier; older V4 readers may refuse such a fork. `packages/api/session-controller/src/types.ts`, `docs/upgrade-guide/v0.2.1-rc.3/independent-session-forks/guide.md`
- **Unscheduled since S16.** A provider idempotency key off `exec.callId` (`packages/session/session-checkpoint-policy/README.md:114`); raw mode detects damage by a `turn/end` heuristic, not a checksum (`session-persistence-jsonl/src/format.ts`).

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/session.md` | Envelope, `deriveMessages`, `turn/end` reasons, `session/end-seed`, fork API, plugin records | 2026-10-25 |
| `docs/subsystems/persistence.md` | Handles; repair only under write ownership | 2026-10-25 |
| `packages/core/session/src/{repair,types,fork}.ts` | Recovery codes and wording, closer order; header fields, no writer | 2026-10-25 |
| `packages/session/session-persistence-jsonl/README.md`, `src/{format,storage,win32}.ts` | Frames, fsync, torn tail, lock, generations, no delete | 2026-10-25 |
| `packages/session/session-checkpoint-policy/README.md` | Barriers; intent, not exactly-once | 2026-10-25 |
| `packages/bundle/{base,sdk-minimal}/cordis.patch.yml` | Default rows; sdk-minimal's own tree | 2026-10-25 |
| `docs/session-format-status.md`, `docs/persistence-changes/README.md` | Writer, finalized and released 4 (`dsh-v0.2.0-rc.2`); same-version rules | 2026-10-25 |
| `docs/persistence-catalog.md` | What persists: THE authority; 62 kinds, as at `57190202` | 2026-10-25 |
| `packages/deliverables/workspace-changes/README.md` | `workspace/changes {turn}` persisted, summary Host-only | 2026-10-25 |
| `docs/subsystems/session-projection.md`, `packages/session/session-projection-cache/README.md` | Handles, cache checkpoints, no eviction | 2026-10-25 |
| `packages/api/session-controller/src/archived-session-gate.ts` | Archive stops and gates work; nothing deletes | 2026-10-25 |
| `docs/upgrade-guide/v0.2.1-rc.2/{session-store-writes,session-projection-handles,sdk-minimal-checkpoints}`, `v0.2.1-rc.3/independent-session-forks` | The four changes since the last pin | 2026-10-25 |
| `packages/test-support/llm-replay/README.md` | Test-only; first-call order | 2026-10-25 |

## Likely to go stale

- `docs/persistence-changes` gains a record every few days; a same-version addition needs a recorded review (since 2026-10-08).
- Fork lineage changed meaning on 2026-10-23: `parentSession` alone no longer marks a child.
- `openAt: never` is an overridable default; the query tools moved to `experimental/` on 2026-10-06.

## Not read

- `.agents/notes/implemented/architecture/2026-10-23-independent-session-forks.md`, `.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md`: `.agents/` is outside the snapshot.
- `session-persistence-jsonl/src/{generation,catalog-migration,migration-verifier}.ts` and `scripts/migrate-sessions-to-v4.ts`: module heads only.
