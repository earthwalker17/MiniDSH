# references/

A curated local map of DeepSeek Harness (DSH) for MiniDSH sessions. MiniDSH studies DSH as an architecture textbook and a behavioural oracle, never as a fork (see [PROJECT.md](../docs/PROJECT.md)). This folder says **what exists upstream, why it matters here, where the official source is, and what is likely to go stale**. It is a map, never a copy: no source dumps, every claim about DSH carries a repository path, and the repository itself stays the authority.

**Current pin:** `deepseek-ai/deepseek-harness@ddefc45fbc7f8e46dd73185e68295696d1297887` (`master`, 2026-09-17, release `0.1.6-alpha.2`). Written 2026-09-19 in S13 from one broad research pass (eight primary-source researchers, one per file) and spot-verified in the parent against a checkout of the pin.

## The files

| File | Area | Route sessions that start here |
|---|---|---|
| [dsh/architecture-map.md](dsh/architecture-map.md) | the two composition planes, the subsystem map, presets, what "minimal but complete" means upstream | every session: the entry map |
| [dsh/session-durability.md](dsh/session-durability.md) | the session log, crash repair, format generations, locking, projections, replay | S14, S16 |
| [dsh/execution-jobs-agents.md](dsh/execution-jobs-agents.md) | loop, tool pipeline, jobs, subagents, teams, workflow, schedule, and their dependency order | S17, S21 |
| [dsh/authority.md](dsh/authority.md) | sandbox backends (Windows included), approvals, grants, presets, hooks, the model-based reviewer | S15 |
| [dsh/skills-documents-extensions.md](dsh/skills-documents-extensions.md) | skills, document tooling, deliverables, extensions, MCP, PTC | S19 |
| [dsh/web-browser-attachments.md](dsh/web-browser-attachments.md) | web search and fetch, browser and computer use, the attachment plane | S18, S20 |
| [dsh/llm-providers.md](dsh/llm-providers.md) | the LLM seam, adapters, the OpenAI path, model facts, retries | S18 |
| [dsh/surfaces.md](dsh/surfaces.md) | host, clients, carriers, profiles, attach and paging, Desktop | S17, S22 |
| [assumptions.md](assumptions.md) | the ledger: what MiniDSH believes about DSH, the verdict at the pin, and where MiniDSH leans on it | every `.5` checkpoint |

Every area file has the same six sections: *What exists (at the pin)*, *Mechanisms worth knowing*, *Why it matters to MiniDSH*, *Sources*, *Likely to go stale*, *Not read*.

## How a session uses this (CLAUDE.md §4)

**An ordinary session** reads the files its task touches FIRST, then researches only those parts of the CURRENT DSH, starting from the file's *Sources* table and its *Likely to go stale* list. When it finds a line here false, it fixes the line, re-dates the source row, and updates [assumptions.md](assumptions.md) in the same commit. It does not re-research areas its task does not touch.

**A `.5` hardening session** re-researches the current DSH broadly: it moves the pin, reruns every row of the assumptions ledger, works through each file's *Not read* list, and deletes what no longer matters to the route. That is the only kind of session that refreshes the whole folder.

Evidence order, unchanged: current code and composition files, then official docs and subsystem docs, then implemented design notes and tests, then anything else. A design note under `.agents/notes/` explains WHY a boundary exists; only current code and docs are the contract, and notes move between `proposed/`, `implemented/` and `archived/` within weeks.

## How to read DSH without cloning 200 MB

The GitHub CLI reads the repository at any commit (replace `REF` with a sha to pin, or `master` for today):

```
R=repos/deepseek-ai/deepseek-harness; REF=master
gh api "$R/commits/$REF" --jq '.sha + " " + .commit.committer.date'                 # where is master now
gh api "$R/contents/<dir>?ref=$REF" --jq '.[] | "\(.type) \(.path)"'                # list a directory
gh api "$R/contents/<path>?ref=$REF" -H "Accept: application/vnd.github.raw"        # read a file
gh api "$R/commits?path=<path>&per_page=3&sha=$REF" --jq '.[] | .commit.committer.date + " " + (.commit.message | split("\n")[0])'
gh api -X GET search/code -f q='<terms> repo:deepseek-ai/deepseek-harness' --jq '.items[].path'   # 10 per minute: use sparingly
```

For a broad pass, a partial checkout is cheaper than hundreds of API reads: `git fetch --depth 1 --filter=blob:limit=200k origin <sha>` into a scratch directory outside this repository, then check out only `docs`, `packages/README.md`, `packages/bundle`, `packages/preset` and `AGENTS.md`. Skip `*.zh.md` and `*.i18n.yaml`: they are translations.

**An absent file is not an absent fact.** That blob limit silently omits the large generated files, `docs/persistence-catalog.md` and `docs/persistence-schema.json` among them, and those are the AUTHORITY on what upstream persists. S13 "verified" DSH's inbox as live-only from a sequence diagram in a checkout that lacked the catalog; the catalog lists `agent/inbox/spliced` as a persisted event. For "is X durable upstream", read the catalog through `gh api`, never a diagram.

## Naming traps (each cost a researcher time)

- Upstream `docs/subsystems/web.md` and `packages/web` are **web search and fetch**, not the GUI. The GUI is `packages/host`, `packages/client`, `packages/api` and `apps/web`.
- Upstream `docs/api-gateway.md` is the UI-to-host RPC gateway. It has nothing to do with LLM traffic.
- `packages/terminal` is a persistent PTY capability for model tools, not a TUI. DSH ships no TUI.
- Deployment compositions moved: `packages/preset` now holds only per-session **agent presets** and the persona; the host plane is `packages/bundle/*/cordis.patch.yml`. Older notes and comments still say `base.cordis.yml`.
- "Profiles" (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`, plus Electron's reserved `desktop`) are composition stacks, not wire protocols.
- Code Mode was renamed TO PTC (programmatic tool calls), not the reverse; the durable `tool/code-dispatch*` log vocabulary was deliberately left unrenamed.

## Budget

Each file here stays under 12 KB and the folder under 120 KB, enforced by `scripts/check-docs.ts` in `pnpm check`, which also checks every relative link and table row in these files. A reference file that outgrows its budget has started copying. Nothing here ships: `package.json` `files` is a whitelist.
