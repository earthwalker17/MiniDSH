---
name: docs-maintenance
description: MiniDSH's documentation maintenance procedure. Use when `pnpm check:docs` warns or fails on a document budget or form rule, before compacting docs/ARCHITECTURE.md, docs/BLUEPRINT.md or references/, when briefing subagents to do that compaction, or when deciding whether a detail belongs in a project document at all.
---

# Documentation maintenance

The project documents are **maps**. They give a session the system's shape, owners, invariants, where a capability belongs, and what to read next. `CLAUDE.md` §5 holds the rules every session follows (growth, delegation); this file is the procedure.

## The deletion test

> Without this, would a future session materially misunderstand the system, choose the wrong architectural home, or fail to know where to investigate next?

If not, **delete it**. Do not rewrite it shorter. Four paraphrasing compactions each stopped near 90 %. A reason stays only where its absence would invite a plausible wrong change. Every other reason belongs in the owning code's comment.

## What each document is for

Budgets, section targets and form rules live only in `scripts/check-docs.ts`; `node scripts/check-docs.ts --sections` prints them.

| Document | Purpose | Must remain | Delete or collapse |
|---|---|---|---|
| `CLAUDE.md` | how sessions run; ≤ 200 lines | rules | why a rule exists (→ BLUEPRINT §4, memory) |
| `docs/PROJECT.md` | the stable thesis | positioning, scope | anything per-session: replace, never append |
| `docs/ARCHITECTURE.md` | the map, read every session | every table row; dependency direction; must-not-own clauses; each invariant as one line with its owning file; §13 as a one-line register of every user-visible, security-relevant, route-constraining or code-cited limitation | history, rationale the owning code states, payload fields (each `events.ts`), flag trivia, anything stated twice |
| `docs/BLUEPRINT.md` | §1 brief, §2 route, §3 open questions, §4 record | the brief, the route, open decisions, measurements a later session reuses | §4 entries whose decisions now live in code or the map: collapse older ones |
| `README.md` | a first-time visitor | its eleven sections (CLAUDE.md §5) | architecture a visitor cannot parse (link it) |
| `references/dsh/<area>.md` | where to research one DSH area | *What exists*, *Open for the route* (one fact plus one upstream path per upcoming need), *Sources* with check dates, *Likely to go stale*, *Not read* | upstream mechanisms fetchable on demand; verdicts (they live in the ledger); built items (→ ARCH §12) |
| `references/assumptions.md` | the ledger: what MiniDSH leans on, with a verdict at the pin | one row per claim a document still relies on | rows only history reads |

**Where a detail goes.**
- A rule gets one map line naming its owning file, with the why in that file's comment.
- History goes in the §4 entry or the commit.
- An upstream fact goes in `references/`; ARCH §12 states MiniDSH's decision and one reason clause.

**ARCHITECTURE line forms.**
- An invariant: `**Rule.** sentence (owner path).`
- A shared claim is stated in the ONE section that owns it; others point with `(§N)`, valid only if §N states it.

## Worked example (ARCHITECTURE §9, 2026-09-24: 6,835 → 2,983 bytes)

Before (777 bytes, elided here):

> **Retention: content is never swept; an affordance may expire.** Attachments and session logs are content (a log is the only script its arc replays from; …). A spill file is an affordance (the excerpt beside it is already what the model saw) … `spill-local` sweeps in **one pass at load**, awaited at disposal, never ON disposal (a fork inherits its parent's locators): per file, STRICTLY older than one pre-walk cutoff; … `lstat`; `unlink`; non-recursive `rmdir` … `cleanupPeriodDays` …

After, 234 bytes:

> **Retention: content is never swept; an affordance may expire.** Spill is the one affordance: its excerpt is already what the model saw. `spill-local` sweeps it once at load, never on disposal (a fork inherits its parent's locators).

Ledger: the sweep's per-file rules, code carries them (`spill-local/index.ts:67-78,194-200`); why logs are content and the `cleanupPeriodDays` default, duplicates of the table.

"Never on disposal" stayed, because deleting it invites exactly the wrong change.

## Delegated compaction

**The parent** defines the work and judges the result. It does not write the prose.
1. From `node scripts/check-docs.ts --sections`, set a binding **maximum per section** about 7 % under the landing: the review restores claims (~2 KB of 48 in S15.1).
2. `node scripts/doc-registers.ts <scratch-dir>` writes the inbound-pointer, code-citation and outside-reader registers.
3. Group sections **by coupling** (two that point at each other get one author); §12 and §13 lines go to the group owning their topic, and the parent assembles those two.
4. Fix the agent count before launch: at most 5 per run, runs in sequence (CLAUDE.md §8). Brief each with this file's path, its sections and maxima, the inbound pointers it must satisfy, the claims it may only point to, and the code citations into it; it writes to scratch.
5. Keep working. **Queue your own edits** to that document until the compacted text merges.

**Each agent:**
1. **Structural pass first.** Apply the deletion test to every paragraph, bullet and cell: delete it, merge a duplicate into its owner, or point to the owning code. Claim "code carries it" only after Reading that `file:line`; otherwise propose a comment edit.
2. Only then, if the text is still over its maximum, tighten sentences. A pass that saves under 5 % has failed: report, do not paraphrase again.
3. Return:
   - the text;
   - a **deletion ledger**: each deleted claim tagged `trivia`, `code-carries-it file:line`, `duplicate-of §N`, `history` or `suspected-false`;
   - the ten **riskiest cuts**;
   - proposed comment edits.

**Then the parent:**
1. Triages the riskiest cuts and every `suspected-false` claim first. S15.1's rewrite found fifteen, among them a false security claim an experiment disproved. A doc/code mismatch can be a code bug, so it is never deleted silently.
2. Assembles and runs `pnpm check:docs`: budgets, form rules, the heading pin, links and table rows.
3. Runs `node scripts/doc-registers.ts --pointers` and compares the count with the pre-compaction run. A new suspect is a candidate moved-but-absent claim.
4. Has the claim review done by agents other than the authors, with fixed lenses:
   - load-bearing loss against `git show HEAD:<doc>`, split by size;
   - navigation and cross-document;
   - accuracy against the code.

   Findings are `lost`, `weakened`, `moved-but-absent`, `invented`, `pointer-to-nowhere` or `cross-document`. The parent restores only what passes the deletion test, grounded in a `file:line`.

## Failure shapes already paid for

- **Circular pointers.** Two sections each pointed at the other, so the claim was stated nowhere.
- **Silent contract loss.** Compactions deleted the hard-link edge and nineteen contracts unnoticed.
- **Inversion and invention.** "Cannot follow a hard link" read as safe; a rewrite called `canonicalPath` pure.
- **Paraphrase loops.** Clause-level tightening without deletion has a floor.
- **The parent rewriting it itself**, which burns the main context.
