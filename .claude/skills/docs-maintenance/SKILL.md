---
name: docs-maintenance
description: MiniDSH's documentation maintenance procedure. Use when `pnpm check:docs` warns or fails on a document budget or form rule, before compacting docs/ARCHITECTURE.md, docs/BLUEPRINT.md or references/, when briefing subagents to do that compaction, or when deciding whether a detail belongs in a project document at all.
---

# Documentation maintenance

The project documents are **maps**: they tell a session the shape of the system, its boundaries, owners and invariants, where a capability belongs, and what to read next. They are not the record of every detail. Code comments at the owning site, tests, commits and targeted research carry the detail. The rules every session follows (the growth rule, delegation) are in `CLAUDE.md` §5. This file is the procedure.

## The deletion test

> If this disappeared, would a future session materially misunderstand the system, choose the wrong architectural home, or fail to know where to investigate next?

If not, **delete it**. Do not rewrite it shorter. A pass that paraphrases the same claims into fewer words, without taking whole claims out, has failed. That is what four compactions did before 2026-09-24, and each stopped at about 90 %.

A reason stays only where its absence would invite a plausible wrong change: the fence someone would otherwise tear down. Every other reason lives in the comment at the code that enforces the rule.

## What each document is for

Budgets live only in `scripts/check-docs.ts`. `node scripts/check-docs.ts --sections` prints every ceiling and every section's size.

| Document | Purpose and reader | Must remain | Delete or collapse |
|---|---|---|---|
| `CLAUDE.md` | how sessions run; auto-loaded | rules a session follows | history of why a rule exists (→ BLUEPRINT §4, memory) |
| `docs/PROJECT.md` | the stable thesis | positioning, scope | anything that changes per session; it is replaced, never appended |
| `docs/ARCHITECTURE.md` | the map, read at every session start | every table row (§1, §3, §8, §9, §10, §11, §14); dependency direction; must-not-own clauses; cross-subsystem invariants, one line each with the owning file; §13 as a complete one-line register of user-visible, security-relevant, route-constraining or code-cited limitations | history; budget narrative; rationale the owning code comment states; field-by-field payloads (they are in each `events.ts`); flag trivia; anything stated twice |
| `docs/BLUEPRINT.md` | §1 the next brief, §2 the route, §3 open questions, §4 the record | the next brief, the route, open decisions, measurements a later session will reuse | §4 entries once their decisions are in the code or the architecture: collapse older ones to a line |
| `README.md` | a first-time visitor | its eleven sections (CLAUDE.md §5) | architecture a visitor cannot parse (link it instead) |
| `references/dsh/<area>.md` | where to research one DSH area | *What exists* table, *Open for the route* (one fact plus one upstream path per upcoming need), *Sources* with check dates, *Likely to go stale*, *Not read* | descriptions of upstream mechanisms that can be fetched on demand; built items (point to ARCH §12) |
| `references/assumptions.md` | the ledger: what MiniDSH leans on, with a verdict at the pin | one row per claim some document still relies on | rows whose only reader is history |

**Where a detail belongs.** If the detail is a rule, give the doc one line naming the rule and its owning file, and put the why in that file's comment. If it is history, put it in the §4 entry or the commit message. If it is an upstream fact, put it in `references/`: ARCH §12 states MiniDSH's decision and one reason clause, never upstream's mechanism.

**Line forms in ARCHITECTURE.** An invariant takes the form `**Rule.** one sentence (owner: path).` A shared claim is stated in the ONE section that owns the topic, and every other section points at it with `(§N)`. A pointer is valid only if §N states the claim.

## Worked example (ARCHITECTURE §9, 2026-09-24: 6,835 → 2,983 bytes)

Before, 777 bytes:

> **Retention: content is never swept; an affordance may expire.** Attachments and session logs are content (a log is the only script its arc replays from; deleting one needs an authority above the append-only seam, which does not exist). A spill file is an affordance (the excerpt beside it is already what the model saw), the one store a sweep may touch. `spill-local` sweeps in **one pass at load**, awaited at disposal, never ON disposal (a fork inherits its parent's locators): per file, STRICTLY older than one pre-walk cutoff; exact generated names only; `lstat` (symlinks skipped); `unlink`; non-recursive `rmdir` only if empty AND older (mtime read before any delete, since deleting bumps it). `cleanupPeriodDays` …

After, 234 bytes (the retention table follows unchanged):

> **Retention: content is never swept; an affordance may expire.** Spill is the one affordance: its excerpt is already what the model saw. `spill-local` sweeps it once at load, never on disposal (a fork inherits its parent's locators).

The deletion ledger for that paragraph:

| Deleted claim | Category |
|---|---|
| the sweep's per-file rules (cutoff, names, `lstat`, `rmdir`) | code carries it: `spill-local/index.ts:67-78,194-200` |
| why logs are content | duplicate: the table's "content, replay oracle" |
| `cleanupPeriodDays` default | duplicate: the table row |

The "never on disposal" reason stayed, because deleting it invites exactly the wrong change.

## Delegated compaction

**The parent** defines the work and does not write the text:
1. Run `node scripts/check-docs.ts --sections` and set a binding **maximum per section**, about 7 % below the landing target so that restored claims fit.
2. Run `node scripts/doc-registers.ts <scratch-dir>` for the three registers: inbound pointers, code citations, outside readers.
3. Cut sections into groups **by coupling**. Two sections that point at each other get one author. §12 and §13 lines go to the group that owns their topic, and the parent assembles §12 and §13.
4. Fix the agent count before launch: at most 5 per run, sequential runs, with the total stated in the plan (CLAUDE.md §8).
5. Brief each agent with this file's path (Read it), its sections, its maxima, the inbound pointers it must satisfy, the claims it may only point to, and the code citations into its sections. It writes to scratch, never to the document.
6. Keep working. **Queue your own additions** to the document and apply them after the compacted text merges.

**Each agent:**
1. **Structural pass first.** For each paragraph, bullet and cell, apply the deletion test. Delete it, merge a duplicate into its owner, or replace it with a pointer to the owning code site. Before claiming "code carries it", Read that `file:line` and confirm it states the claim. If it does not, return the claim as a proposed comment edit instead.
2. Only if the text is still over its maximum, tighten sentences.
3. **Stop rule.** If a pass saves under 5 %, stop and report why. Do not paraphrase again.
4. Return three things:
   - the new text;
   - a **deletion ledger**: each deleted claim tagged `trivia`, `code-carries-it file:line`, `duplicate-of §N`, `history`, or `suspected-false`;
   - the ten **riskiest cuts**.

   A `suspected-false` claim goes to the parent, because a doc/code mismatch may be a code bug.

**Verification, before commit:**
1. Assemble, then run `pnpm check:docs` for budgets, form rules, the heading pin, links and table rows.
2. Run `node scripts/doc-registers.ts --pointers`, and compare its count with the pre-compaction run. A new suspect is a candidate moved-but-absent claim.
3. Run a **claim review by agents other than the authors**, with fixed lenses:
   - load-bearing loss against the old text (`git show HEAD:<doc>`), split by size;
   - navigation and cross-document: code-cited content still present, outside readers still true;
   - accuracy: every new sentence true of the code.

   Findings are `lost`, `weakened`, `moved-but-absent`, `invented`, `pointer-to-nowhere`, or `cross-document`.
4. The parent adjudicates each finding against a `file:line`, restores only what passes the deletion test, and records the before/after numbers in the commit.

## Failure shapes this project has already paid for

- **Circular pointers.** Two sections each replaced a shared claim with "(§N)" pointing at the other, so the claim was stated nowhere (five pairs, 2026-09-10).
- **Silent contract loss.** A compaction deleted the fs fence's hard-link edge (S11.5), and another deleted nineteen contracts (S8.5). Only a claim review saw either.
- **Inversion.** "Cannot follow a hard link" read as safe, when the fence is the thing that cannot detect one.
- **Invention.** A rewrite called `canonicalPath` pure.
- **Paraphrase loops.** Four passes stopped at about 90 %. Clause-level tightening without deletion has a floor.
- **The parent rewriting it itself.** It burns the main context on text a subagent can produce and a review can check.
