# DSH reference: Skills, documents, extensions, MCP

> A map: verify against the current repository before relying on a line ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2); checked 2026-09-26.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.skills` registry | `packages/skill/skill` | default-mounted | Host+per-scope layered: nearest layer wins a name, rank only within a layer |
| Filesystem provider | `packages/skill/skill-filesystem` | default-mounted | Ranked roots, per-load re-read, watch; a preset row in Web (host row off) |
| `skill` tool | `packages/skill/tool-skill` | default-mounted | Catalog message, body loader, user `/name` |
| Badge skill | `packages/skill/skill-badge` | disabled-by-default | One bundled skill; a packaged-provider template |
| Office skills | `packages/skill/skill-office` | carrier opt-in | docx, pptx, xlsx over a bundled LibreOffice Kit CLI; Desktop and the SDK profile |
| Workspace deps tool | `packages/skill/tool-workspace-dependencies` | carrier opt-in | `load_workspace_dependencies`: absolute paths to a bundled Python, Node, pnpm |
| Office-to-PDF | `packages/document/office-to-pdf` | Web bundle | Preview conversion; no model tool, no event, no attachment |
| `present` tool | `packages/deliverables/tool-present` | default-mounted | `maxFiles` 8, prompt asks for at most four; one log-only event |
| Workspace changes | `packages/deliverables/workspace-changes` | Web bundle | Per-turn git snapshots; summary in host memory |
| Package runners | `packages/extensions/cordis-host-runner`, `cordis-client-runner` | Web bundle | `node:vm` host half, browser half; no shipped model tool reaches them |
| Inspect tools | `packages/extensions/tool-cordis` | `cordis` only | Two read-only API tools over `ctx.cordisInspect` |
| Plugin Manager tool | `packages/boot/plugin-manager` | `cordis` with a profile | Persistent profile-wide bundles; a DSH peer-version gate with exact exemptions |
| Creator skills | `packages/preset/agent-preset/skills` | `cordis` only | Three skills through `customSkillDirs`; SKILL.md plus `references/` |
| MCP | `packages/mcp` | opt-in | A client row per server, none shipped; `mcp-resources` in base and `sdk-minimal`, inert until a server is configured |
| PTC | `packages/ptc-runtime` | default-mounted | Node runtime in base; the `ptc` preset switches `tool-presentation` to `mode: ptc`; Python runtime experimental |

## Open for the route

- **S19, catalog.** Each `agent/pre-step` compares a digest of model-invocable entries with the newest visible `skill-catalog` message; a change appends one user-role `<system-reminder>` holding the whole list, even empty. No skill event type; tool-set changes are a separate `developer/message` diff. `packages/skill/tool-skill/README.md`, `.agents/notes/implemented/architecture/2026-09-20-dynamic-tool-updates.md`
- **S19, loader.** `skill({name})` re-reads the file, only then reveals its directory, and enforces `disable-model-invocation`. Loading by ordinary reads, S19's catalog must carry the path, and that flag has no enforcement point. `packages/skill/tool-skill/README.md`
- **S19, shadowing.** Within a layer lower rank wins: project `.dsh/skills` (100), `.agents/skills` (200), `customSkillDirs` (300), user homes (400/500), bundled (600); across layers the agent's preset beats the host; no trust prompt anywhere (the ledger). `packages/skill/skill-filesystem/src/index.ts`
- **S19, discovery.** A malformed flag drops the skill; neither an incomplete snapshot (consumers keep the last-good view) nor a body is cached. Oracle: `snapshots/session/skill-load`. `docs/subsystems/skills.md`
- **S19, document skills.** Instructions plus `check_office.py` (stdlib OOXML checker) plus a bundled LibreOffice Kit CLI (render, PDF convert, recalculate); the SDK profile mounts them behind `DSH_PRIMARY_RUNTIME`. Oracles: `snapshots/session/office-skills`, `office-skills-no-renderer`. `packages/skill/skill-office/README.md`, `packages/bundle/sdk-app/cordis.patch.yml`
- **S19, body size.** Base and `standard` prune a tool result over 8,192 chars to a 4,096 head plus tail once pressure is confirmed, so upstream split its Creator skills into a short SKILL.md and `references/` files: size S19's bodies for the reader's budget. `.agents/notes/implemented/architecture/2026-09-21-creator-skills-progressive-disclosure.md`
- **S22, carriers.** Desktop and the SDK ship Python, Node and pnpm as a manifest-checked payload, copied under the home on first use or used in place. `packages/skill/tool-workspace-dependencies/README.md`
- **S22, cold inspect.** Deliverable events point outside the log: `deliverables/presented` names live paths; `workspace/changes {turn}` is logged while its summary dies with the Session. `docs/subsystems/deliverables.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/subsystems/skills.md` | Layered registry, rank table, caching, browser catalog | 2026-09-26 |
| `packages/skill/tool-skill/README.md` | Catalog and loader templates | 2026-09-26 |
| `packages/skill/skill-filesystem/README.md`, `src/index.ts` | Format, rank table, limits; `trustedHost` is a read path, not a gate | 2026-09-26 |
| `packages/skill/skill-office/README.md` | Office skill set, checker, kit CLI | 2026-09-26 |
| `packages/skill/tool-workspace-dependencies/README.md` | Payload manifest, carriers | 2026-09-26 |
| `apps/desktop-host/src/office.ts`, `packages/bundle/sdk-app/cordis.patch.yml` | Desktop mount of both Office plugins; SDK rows, env-gated | 2026-09-26 |
| `packages/bundle/web-app/presets/standard.patch.yml` (also `cordis`, `ptc`) | Preset skill, `present`, plugin-tool rows | 2026-09-26 |
| `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | Host rows: skills, PTC, MCP, pruner; host skill rows off, runners, office-to-pdf, changes | 2026-09-26 |
| `docs/subsystems/deliverables.md` | Two log-only events | 2026-09-26 |
| `packages/boot/plugin-manager/README.md` | Approval rule, compatibility, lock | 2026-09-26 |

## Likely to go stale

- Office moved fast since 2026-09-17: the shared runtime (09-17/18), the kit CLI across deployments (09-23), kit 0.1.1 (09-24). A Web or base mount, more formats, or a renamed tool are plausible.
- Plugin Manager: registries and fallbacks (09-22), peer compatibility with exemptions (09-23), bounded pnpm runs and lock takeover (09-23/24).
- `docs/subsystems/extensions.md` is now a generated API page; the runners look vestigial beside Plugin Manager.

## Not read

- `packages/skill/tool-skill/src/index.ts`; the skill-load and office-skills snapshot contents.
- `office-pptx`, `office-xlsx` SKILL.md bodies, `check_office.py`, the kit package (external), DSH's fourteen `.agents/skills`.
- `docs/subsystems/ptc-runtime.md` body; `ptc-runtime-python` beyond its summary; the `headless` and `acp-app` bundles' skill rows.
