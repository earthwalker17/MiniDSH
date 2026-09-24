# DSH reference: Skills, documents, extensions, MCP

> A map: verify against the current repository before relying on a line ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17); checked 2026-09-19.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.skills` registry | `packages/skill/skill` | default-mounted | Layered host-plane registry |
| Filesystem provider | `packages/skill/skill-filesystem` | default-mounted | Ranked roots, per-load re-read, watch |
| `skill` tool | `packages/skill/tool-skill` | default-mounted | Catalog message, body loader, user `/name` |
| Office skills | `packages/skill/skill-office` | opt-in | docx, pptx, xlsx, a checker; Desktop only |
| Office-to-PDF | `packages/document/office-to-pdf` | default-mounted | Web-app preview; no model tool, no events |
| `present` tool | `packages/deliverables/tool-present` | default-mounted | Up to 8 deliverables; one log-only event |
| Workspace changes | `packages/deliverables/workspace-changes` | default-mounted | Per-turn git snapshots, change summary; host memory |
| Package runner | `packages/extensions/cordis-host-runner` | default-mounted | `node:vm` registry no shipped model tool reaches |
| Inspect tools | `packages/extensions/tool-cordis` | opt-in | Two read-only API tools; `cordis` only |
| Plugin Manager tool | `packages/boot/plugin-manager` | disabled-by-default | Persistent profile-wide bundles; on only in `cordis` |
| MCP | `packages/mcp` | opt-in | A client row per server, none shipped; resources inert |
| PTC | `packages/ptc-runtime` | default-mounted | Host runtime in base; `run_code` in the `ptc` preset only |

## Open for the route

- **S16, format evolution.** A durable event name is a format contract: the Code Mode→PTC rename waited for a versioned format edge, not an in-place rename (v2→v3 did it: README naming traps). `.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.md`
- **S16, cold inspect.** Deliverable events point outside the log: `deliverables/presented` names live paths; `workspace/changes {turn}` is logged while its diffs stay in host memory. `docs/subsystems/deliverables.md`
- **S19, catalog.** Each `agent/pre-step` compares a digest of model-invocable entries with the newest visible `skill-catalog` message; a change appends one user-role `<system-reminder>` holding the whole list, even empty. No skill event type. `packages/skill/tool-skill/README.md`
- **S19, loader.** `skill({name})` re-reads the file, only then reveals its directory, and enforces `disable-model-invocation`. Loading by ordinary reads, S19's catalog must carry the path, and that flag has no enforcement point. `packages/skill/tool-skill/README.md`
- **S19, shadowing.** Lower rank wins: project `.dsh/skills` (100), `.agents/skills` (200), then `customSkillDirs` (300), user homes (400/500), bundled (600); with no documented trust gate (`SAFETY.md` never mentions skills), a clone can shadow by name. `packages/skill/skill-filesystem/README.md`
- **S19, discovery.** A malformed flag drops the skill; neither an incomplete snapshot (consumers keep the last-good view) nor a body is cached. `docs/subsystems/skills.md`
- **S19, document skills.** Instructions plus `check_office.py`, a stdlib OOXML checker, for docx, pptx, xlsx (no PDF); no package installs; visual QA optional, its absence stated. `packages/skill/skill-office/README.md`
- **Built (S14, S15).** Skill scripts run through the shell tool (`packages/skill/skill-filesystem/README.md`), so the recorded effect and the consent subject cover them: `docs/ARCHITECTURE.md` §12.

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/subsystems/skills.md` | Registry, layering, caching | 2026-09-19 |
| `packages/skill/tool-skill/README.md` | Catalog and loader templates | 2026-09-19 |
| `packages/skill/skill-filesystem/README.md` | Format, rank table, limits | 2026-09-19 |
| `packages/skill/skill-office/README.md` | Office skill set, checker | 2026-09-19 |
| `packages/skill/skill-office/assets/office-docx/SKILL.md` | One concrete document skill | 2026-09-19 |
| `apps/desktop-host/src/office.ts` | Desktop-only mount; bundled Python interpreter (S22) | 2026-09-19 |
| `packages/preset/agent-presets/presets/standard/agent.cordis.yml` | Skills, `present` on; plugin tool off | 2026-09-19 |
| `packages/preset/agent-presets/presets/cordis/agent.cordis.yml` | TRUST header, Creator rows | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Host rows: skills, PTC, MCP | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Base skill rows off | 2026-09-19 |
| `docs/subsystems/deliverables.md` | Two log-only events | 2026-09-19 |
| `packages/extensions/cordis-host-runner/README.md` | Trust stance, pivot | 2026-09-19 |
| `packages/boot/plugin-manager/README.md` | Approval rule, build-script caveat | 2026-09-19 |
| `docs/subsystems/mcp.md` | Opt-in rule, unsupported list | 2026-09-19 |
| `packages/mcp/mcp-client/README.md` | Tool names, reconnect | 2026-09-19 |
| `.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.md` | Rename direction and scope | 2026-09-19 |
| `SAFETY.md` | No workspace-skill trust rule | 2026-09-19 |

## Likely to go stale

- The extensions pivot was a day old; the runners look vestigial; `docs/subsystems/extensions.md` is a stub.
- `skill-office` is days old: a CLI or Web mount, a PDF skill or renamed Desktop tools are plausible.
- The rank table and missing trust gate: a trust prompt is an obvious follow-up.
- Which plane owns the skill rows.
- Memory-only `workspace/changes` is a documented limitation; MCP's unsupported list tracks the official SDK.

## Not read

- Skill source (`packages/skill/skill-filesystem/src/index.ts`, `packages/skill/tool-skill/src/index.ts`): "no trust gate" is docs-only.
- `snapshots/session/skill-load`: model-only and user-only skills recorded, the best S19 oracle.
- `office-pptx`, `office-xlsx` SKILL.md bodies, `check_office.py`, the Creator skills (`packages/preset/agent-presets/presets/cordis/skills`), DSH's twelve `.agents/skills`.
- `apps/desktop-host/src/workspace-dependencies.ts`; the `render_document` backend (no pinned file name matches); PDF handling.
- `packages/extensions/tool-cordis/README.md`, `docs/tool-catalog.md`.
- The `headless`, `acp-app`, `sdk-app`, `sdk-minimal` bundles; the `ptc` preset's skill rows.
- How compaction treats loaded skill bodies.
