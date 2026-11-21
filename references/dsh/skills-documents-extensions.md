# DSH reference: Skills, documents, extensions, MCP

> Where to research DSH's skills, document tooling, deliverables and extensions ([reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, `dsh-v0.2.2-rc.5`); re-researched in S22.5, 2026-11-21.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.skills` registry | `packages/skill/skill` | base | Host + per-scope layers: the nearest layer wins a name, rank only within it; runtime `register()` at 250 |
| Filesystem provider | `packages/skill/skill-filesystem` | base; Web: every preset but `minimal` | Project `.dsh/skills` 100, `.agents/skills` 200, custom 300, user 400/500, bundled 600; `<name>/SKILL.md` or flat `<name>.md`, one level deep; watched; bodies never cached; the front-matter keys |
| `skill` tool | `packages/skill/tool-skill` | as the provider | The catalog message (recomputed every `agent/pre-step`), the `skill({name})` loader, the `/name` gesture |
| Plugin skills | `packages/sandbox/sandbox-windows-acl/src/acl-skill.ts`, `packages/connector/upstream-skills` | win32; base | `registerProvider` at rank 600; a connector's entry skill over vendor files fetched at a pinned commit |
| Office skills | `packages/skill/skill-office` | Web, Desktop, SDK | Four instruction-only skills: an `office` router, docx/pptx/xlsx authoring over Python (bundled on Desktop and the packaged SDK, else the user's); an appearance or slide change requires a render; no PDF skill |
| Office tools | `packages/document/tool-office` | `standard`, `ptc`, SDK (2026-11-04) | `office_render` (pages as images, PDF too), `office_convert`, `office_recalculate`: LibreOffice Kit in the Host process, outside the shell sandbox; declared only after an Office skill loads; output lands in a Host store |
| Workspace deps tool | `packages/skill/tool-workspace-dependencies` | Desktop or SDK with `DSH_PRIMARY_RUNTIME` | `load_workspace_dependencies`: absolute paths to a bundled Python, Node, pnpm; PATH untouched |
| `present` | `packages/deliverables/tool-present` | `standard`, `ptc`, `cordis`, SDK | `maxFiles` 8 (4 advised); absolute paths, outside the workspace too; one log-only event |
| Plugin Manager | `packages/boot/plugin-manager` | base; tool in Standard, Creator, the SDK | Persistent profile-wide bundles, in-process and unsandboxed; EVERY action, a list too, behind `danger-full-access` or a per-call approval. The market (`packages/boot/plugin-market`) is read-only, in no shipped profile |
| Extensions | `packages/extensions` | Web; `cordis_inspect` in Standard and Creator | Read-only inspection; process-local `node:vm` definitions (no boundary) that no model tool creates |
| Creator skill | `packages/preset/agent-preset/skills/dsh-doc` | Standard and Creator | ONE skill, through `customSkillDirs` |
| MCP | `packages/mcp`, `packages/connector` | `mcp-manager` in Web; `mcp-resources` in base; no server by default | A fleet of clients from settings and plugins (Linear, Notion); OAuth only for plugin-registered servers; `toolLoading: on-demand`; prompt templates unsupported; stdio env scrubbed |
| PTC | `packages/ptc-runtime` | Node runtime in base; executor in the `ptc` preset | A fresh Node per call under the Session's sandbox policy (no confinement fails the run), or opt-in retained state; no Python runtime since 2026-11-11 |

## Open for the route

- **later, a document input kind.** `office_render` hands the model document, slide, sheet and PDF pages as images, saved through the attachment store before the result returns, and refuses a route without image input. `packages/document/tool-office/README.md`
- **later, an importable surface.** A bundle declares `engines.dsh` and DSH peers; an unmet one is refused before pnpm runs; an exemption names one plugin and one runtime version, with `acceptRisk`. `packages/boot/plugin-manager/README.md`
- **later, workspace-lifetime grants.** This area's persisted approvals live in the PROFILE, never a log (`pnpm-workspace.yaml`, `compatibility.json`); the service checks names, not the conversation. Same file.
- **later, an unreadable root.** Omitted, the rest published; a lower-priority same-name skill may answer meanwhile. `packages/skill/skill-filesystem/README.md`
- **later, user invocation.** The ledger has the `/name` gesture. `packages/skill/tool-skill/src/index.ts`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/skill/{tool-skill,skill-filesystem}/src/index.ts` | Catalog (its digest, wording and caps), loader, gesture; ranks, front-matter, `trustedHost` a read path | 2026-11-21 |
| `docs/subsystems/skills.md` | Layers, caching, "optional instructions, not session events" | 2026-11-21 |
| `packages/skill/skill-office/README.md`, `packages/document/{tool-office,office-kit}/README.md` | The four skills, the three tools, the output store | 2026-11-21 |
| `packages/bundle/{base,web-app,sdk-app}/cordis.patch.yml`, `packages/bundle/web-app/presets/*.patch.yml` | Which row mounts where | 2026-11-21 |
| `packages/boot/plugin-manager/{README.md,src/tools.ts}` | Install authority (`approveEscalation`), `approvedBuilds` | 2026-11-21 |
| `packages/extensions/cordis-host-runner/README.md` | `node:vm` is not a boundary | 2026-11-21 |
| `packages/mcp/{mcp-client,mcp-manager}/README.md`, `packages/ptc-runtime/ptc-runtime-node/README.md` | MCP limits and OAuth; PTC modes and sandbox facts | 2026-11-21 |
| `docs/persistence-catalog.md` | Durable: `deliverables/presented`, `workspace/changes {turn}` (not its summary), the `skill-catalog` and `skill-invocation` sources; no office, MCP or plugin event | 2026-11-21 |

## Likely to go stale

- Office: the native tools date from 2026-11-04 (`.agents/notes/implemented/architecture/2026-10-31-native-office-tool.md`); activation and a GUI view of rendered pages are named limitations.
- MCP and connectors: 78 commits under `packages/mcp` since 2026-10-23.
- `plugin_manager` per preset, its Official catalog, where the market mounts.
- Discovery follows the Session's working directory (`ctx.workingDirectory`), not the header cwd.

## Not read

- Source under `plugin-manager/src` beyond `tools.ts`, and all of `mcp-client`, `mcp-manager`, `office-kit`, `tool-office`, `tool-executor-ptc`: READMEs only.
- The office e2e tests beyond `render-tools.e2e.ts`; the bodies under `skill-office/assets`.
- `dsh-doc/references/*`; DSH's 22 `.agents/skills`; `connector/{cli-account,linear}`; `docs/subsystems/{mcp,extensions,office-kit}.md`.
