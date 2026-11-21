# A case study: building MiniDSH architecture-first

MiniDSH is a small agent harness, written as an independent study of DeepSeek Harness. One person built it with Claude Code in about 35 sessions between 2026-08-22 and 2026-11-21, and the agent wrote nearly all of the code. This page says what happened here. It is one repository with no control group, so it does not show that the method works in general.

The session-by-session record is [BLUEPRINT §4](BLUEPRINT.md#4-development-record). The rules are [CLAUDE.md](../CLAUDE.md). Session names such as S14 come from that record.

## The method

- **Four documents, read at every session start.** `CLAUDE.md` is the constitution, under 200 lines. [`PROJECT.md`](PROJECT.md) is the thesis. [`ARCHITECTURE.md`](ARCHITECTURE.md) is the map: what each layer owns and must not own, each invariant with its owning file, and a table from a new thing to its home. `BLUEPRINT.md` holds the next brief, the route and the record.
- **A home before code.** A session names a capability's layer, seam, owned state and lifecycle before implementing it. A feature with no home is an architecture question first.
- **Plan, then phases.** Architecture-affecting sessions start in plan mode. Each phase is verified and committed before the next.
- **Real compositions in tests.** Tests mount the real plugin composition of the one runtime. Only the model is scripted, or replayed from a recorded session log.
- **The same ending every session.** The full gate on Windows and under WSL 2, a bounded adversarial review, and a live run against a real model API.
- **Checkpoints.** After a cluster of architectural change, a ".5" session rereads the repository, re-audits each documented invariant against the code and re-researches upstream. There have been eight.

## What each kind of check caught

Each row gives findings that, in the record, came from that kind of check and no other.

| Check | Found there |
|---|---|
| Plan critic, before code | S14 (2026-09-20): the first design let a turn end as completed after a durable write was lost. The fix moved one log record to a different writer before any code existed. S16.5 (2026-09-26): one critic returned 16 findings, one a planned measurement that would have measured nothing. |
| Design verification with runtime probes | S5 (2026-08-26): three designs refuted before implementation. One put an output bound where the text no longer existed. |
| Diff review by fixed lenses | S1 (2026-08-22): 10 defects that 90 passing tests had not shown. One stored a cancelled reply in a shape that makes every later request invalid at the provider. S15 (2026-09-23): two different commands rendered as one consent line and shared one grant. |
| Refuters given a claim and a file:line, never the argument | S22.5 (2026-11-21): 47 of 48 audit claims confirmed with a reproduction. Reproducing turned two "majors" into blockers: an edit silently rewrote a non-UTF-8 file, and the web sign-in cookie reached a second server on another loopback port. |
| Live run with a real model | S15: a delegated child could accept an unconfined shell for itself. S22 (2026-11-19): the browser view stopped following at the first approval. |
| CI on other operating systems | S11.5 (2026-09-08): an `EPIPE` on macOS alone, and a gate that had never executed. S22.5: the macOS app stayed running after its last window closed in 4 of 10 runs. |
| Claim review of the documents | 2026-09-10: reviewers who were not the authors raised 235 findings over 1,334 claims after a compaction. S15.1 (2026-09-24): 15 claims flagged as suspected false, one a security claim an experiment then disproved. |
| Re-researching upstream | S7.5 (2026-09-01): 15 of about 200 documented claims about DeepSeek Harness were stale or refuted. S8.5 (2026-09-05): the current upstream overturned three plans. |

Two more results. The checkpoints S1.5, S5.5 and S7.5 found three documented invariants that were untrue in the code. In S22.5 each fix came with a red proof, its new test failing on the unfixed source, because tests that could not fail had kept appearing (S11.5, S22.2).

## Where it failed

- **The documents outgrew their budget.** At S8.5 the four session-start documents were about 230 KB. Compactions told "never delete a contract" stalled: in S14 three compressors freed 0.37% of `ARCHITECTURE.md`. Its ceiling was raised from 84 KB to 94 KB (2026-09-21). S15.1 replaced the rule with a deletion test and halved the document, from 96,245 to 49,485 bytes.
- **Compactions deleted contracts.** The S11.5 rewrite dropped the one stated gap in the file fence, a hard link. The gap was real: a reproduced write landed outside the workspace. On 2026-09-10 parallel authors replaced shared claims with pointers to each other, so five were stated nowhere. Review still restores claims after each compaction, 13 in S22.2.
- **An agent workflow reached 46 agents** (S9, 2026-09-05). A four-lens review spawned three verifiers per finding, and the owner interrupted it. A written prohibition had existed since S8.5 ([CLAUDE.md §8](../CLAUDE.md#8-sub-agents-and-dynamic-workflows)). S16.5 still ran 22 agents against a ceiling of 20.
- **A usage limit resumed a dead workflow** (S13, 2026-09-19). The limit killed eight writer agents. At reset the harness resumed the run silently, while replacements were being launched. It happened twice in that session.
- **A recursive delete followed a link, twice.** A review agent linked the repository's `node_modules` into a scratch worktree, then removed the worktree. The real dependency tree was emptied in S6 and again in S7.5, when the cause was found. A hook refuses that shape now (`.claude/hooks/guard-repo.mjs`).
- **The agent reported findings that did not exist.** S13's closing summary listed six open review findings. None was in any reviewer's output. A closing list is now generated from the findings, never recalled.
- **Small samples misled, and some flakes stay unexplained.** A live test that passed 4 of 4 in S18 passed 17 of 21 in S20.5. A live jobs test timed out once in 7 Windows runs (S17) and not in 12 more (S18). The context test passed 5 of 6 (S22). A new test failed once in 14 runs (S22.5). In S14 and S22.5 the failure text was lost to an output filter. None is recorded as fixed.
- **The first release from CI took four runs of its tag** (1.1.0, 2026-09-27). The workflow had never run before the tag existed.

## What the numbers do and do not show

- **Size.** On 2026-11-21 `node scripts/count-lines.ts` reports about 42,700 lines of TypeScript in 159 files under `src/` and 50,500 lines of tests and harness. At 1.0.0 (2026-09-09) they were 19,777 and 18,027.
- **Tests.** 2,029 passed on Windows and 2,046 under WSL 2 at S22.2 (2026-11-20). That says the suite is green. It does not say the architecture held.
- **What suggests it held.** S21 added parallel execution with no kernel change. The desktop app (S22.2) does not import the runtime. These are two observations, not a metric.
- **No comparison.** Nobody built a feature-first twin. Finding counts measure what reviewers wrote down, not defect density.
- **One reader.** No second contributor has used the map to place a capability. Its only test was one probe in S15.1: a model answered 8 placement questions correctly from both the 96 KB and the 49 KB version, reading about 166k and 83k input tokens. Most measures [PROJECT.md](PROJECT.md) §5 names were applied as judgement, not counted.
- **macOS is CI-only.** The suite, the live run and the desktop app run there on hosted runners. The record shows no run by hand on a Mac.
- **Cost was not totalled.** Sub-agent tokens were recorded for some sessions: 1.83M in S13, about 3.5M for the 2026-09-10 compaction. The record has no hours.

## What seems to transfer

1. **Critique the design before the code.** S14's plan critique changed the architecture for the cost of one agent. The five-lens review afterwards used 866k sub-agent tokens and found one regression.
2. **Reproduce a finding before ranking it.** S22.5's two blockers were filed as majors until someone ran them.
3. **Turn a rule into a number or a script.** The 46-agent run happened under a rule that named no number. Document sizes, hand-typed line counts and the `node_modules` rule each drifted or broke until a gate, a script or a hook held them.
4. **Compact by deletion, with a ledger and a reviewer who is not the author.** Four paraphrasing compactions each stopped near 90%.
5. **Make a failure say what it saw, and rehearse what has never run.** A Linux desktop test failed 3 attempts in 4 with a bare timeout (S22.5), and was explained once it printed where the prompt had stopped. After the four-run release, S22.5 ran its release as a dry run before any tag existed.
