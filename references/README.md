# references/

A curated local map of DeepSeek Harness (DSH) for MiniDSH sessions. MiniDSH studies DSH as an architecture textbook and a behavioural oracle, never as a fork (see [PROJECT.md](../docs/PROJECT.md)). This folder says **where an upstream subsystem lives, what MiniDSH leans on about it, and where to research next**. It is a navigation layer, never a mirror: upstream mechanisms are fetched on demand from the paths here, every claim carries a repository path, and the repository itself stays the authority.

**Current pin:** `deepseek-ai/deepseek-harness@ddefc45fbc7f8e46dd73185e68295696d1297887` (`master`, 2026-09-17, release `0.1.6-alpha.2`), written in S13 and spot-verified against a checkout. [dsh/authority.md](dsh/authority.md) and the Authority rows of [assumptions.md](assumptions.md) are ahead of it, at `c36a83ff` (2026-09-22, S15). An ordinary session moves the pin only for the area it researched, so each file's header says which commit it describes; the next `.5` moves the rest.

## The files

| File | Area | Route sessions that start here |
|---|---|---|
| [dsh/architecture-map.md](dsh/architecture-map.md) | the two composition planes, the subsystem map, presets | every session: the entry map; S16, S17, S22 |
| [dsh/session-durability.md](dsh/session-durability.md) | the session log, crash repair, format generations, locking, projections, replay | S16, S17 |
| [dsh/execution-jobs-agents.md](dsh/execution-jobs-agents.md) | loop, tool pipeline, jobs, subagents, teams, workflow, schedule | S17, S20, S21 |
| [dsh/authority.md](dsh/authority.md) | sandbox backends (Windows included), approvals, grants, presets, hooks, the model reviewer | S16, S17, S18, S20, S22 |
| [dsh/skills-documents-extensions.md](dsh/skills-documents-extensions.md) | skills, document tooling, deliverables, extensions, MCP, PTC | S16, S19 |
| [dsh/web-browser-attachments.md](dsh/web-browser-attachments.md) | web search and fetch, browser and computer use, the attachment plane | S16, S18, S20, S21, S22 |
| [dsh/llm-providers.md](dsh/llm-providers.md) | the LLM seam, adapters, the OpenAI path, model facts, retries | S16, S17, S18, S21 |
| [dsh/surfaces.md](dsh/surfaces.md) | host, clients, carriers, profiles, attach and paging, Desktop | S17, S21, S22 |
| [assumptions.md](assumptions.md) | the ledger: each claim a MiniDSH document leans on, its verdict at the pin, and where it is leaned on | every session that touches an area; every `.5` |

Every area file has five sections: *What exists (at the pin)*, *Open for the route* (one fact and one upstream path per upcoming need), *Sources* (with check dates), *Likely to go stale*, *Not read*. Verdicts live only in the ledger.

## How a session uses this (CLAUDE.md §4)

**An ordinary session** reads every `**S<n>,` bullet for its session number under `dsh/` (the table's last column) and those areas' ledger tables FIRST, then researches only those parts of the CURRENT DSH, starting from *Sources* and *Likely to go stale*. When it finds a line here false, it fixes the line, re-dates the source row, and updates the ledger in the same commit. It does not re-research areas its task does not touch.

**A `.5` hardening session** moves the pin, reruns every ledger row, works through each *Not read* list, and deletes what no longer matters to the route.

Evidence order: current code and composition files, then official and subsystem docs, then implemented design notes and tests, then anything else. A note under `.agents/notes/` explains WHY a boundary exists; only current code and docs are the contract, and notes move between `proposed/`, `implemented/` and `archived/` within weeks.

## How to read DSH without cloning 200 MB

```
R=repos/deepseek-ai/deepseek-harness; REF=master                                    # or a sha to pin
gh api "$R/commits/$REF" --jq '.sha + " " + .commit.committer.date'                 # where is master now
gh api "$R/contents/<dir>?ref=$REF" --jq '.[] | "\(.type) \(.path)"'                # list a directory
gh api "$R/contents/<path>?ref=$REF" -H "Accept: application/vnd.github.raw"        # read a file
gh api "$R/commits?path=<path>&per_page=3&sha=$REF" --jq '.[] | .commit.committer.date + " " + (.commit.message | split("\n")[0])'
gh api -X GET search/code -f q='<terms> repo:deepseek-ai/deepseek-harness' --jq '.items[].path'   # 10 per minute
```

For a broad pass, a partial checkout is cheaper: `git fetch --depth 1 --filter=blob:limit=200k origin <sha>` into a scratch directory outside this repository, checking out only `docs`, `packages/README.md`, `packages/bundle`, `packages/preset` and `AGENTS.md`; skip `*.zh.md` and `*.i18n.yaml`.

**An absent file is not an absent fact.** That blob limit silently omits large generated files, `docs/persistence-catalog.md` and `docs/persistence-schema.json` among them, and those are the AUTHORITY on what upstream persists. S13 "verified" DSH's inbox as live-only from a sequence diagram in a checkout that lacked the catalog, which lists `agent/inbox/spliced` as persisted. For "is X durable upstream", read the catalog through `gh api`, never a diagram.

## Naming traps

- `docs/subsystems/web.md` and `packages/web` are **web search and fetch**, not the GUI, which is `packages/host`, `packages/client`, `packages/api` and `apps/web`.
- `docs/api-gateway.md` is the UI-to-host RPC gateway, not LLM traffic.
- Upstream "effect" means a FILE effect (`packages/deliverables/workspace-changes`) and "intent" the fs freshness waterfall: neither is MiniDSH's `effect/recorded` or `EffectIntent`.
- `packages/terminal` is a persistent PTY for model tools, not a TUI. DSH ships no TUI.
- `packages/preset` holds only per-session **agent presets** and the persona; the host plane is `packages/bundle/*/cordis.patch.yml` (older notes say `base.cordis.yml`).
- "Profiles" (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`, Electron's reserved `desktop`) are composition stacks, not wire protocols.
- Code Mode was renamed TO PTC (programmatic tool calls); the v2→v3 migration renamed the log tags too: `tool/ptc-dispatch-start|dispatch`.

Budgets are in `scripts/check-docs.ts` (`--sections` prints them): an area file that outgrows its ceiling has started copying. Nothing here ships: `package.json` `files` is a whitelist.
