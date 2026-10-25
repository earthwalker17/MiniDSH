# DSH reference: Skills, documents, extensions, MCP

> Where to research DSH's skills, document tooling, deliverables and extensions ([reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, `dsh-v0.2.1-rc.3`); re-researched in S20.5, 2026-10-25 (skill sources unchanged since `687f282e`).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.skills` registry | `packages/skill/skill` | base | Host + per-scope layers: the nearest layer wins a name, rank only within it; runtime `register()` at 250 |
| Filesystem provider | `packages/skill/skill-filesystem` | base; Web: every preset but `minimal` | Project `.dsh/skills` 100, `.agents/skills` 200, custom 300, user 400/500, bundled 600; one level deep; watched; bodies never cached |
| `skill` tool | `packages/skill/tool-skill` | as the provider | The catalog message, `skill({name})`, the `/name` gesture |
| Plugin skills | `packages/sandbox/sandbox-windows-acl/src/acl-skill.ts` | win32 | `ctx.skills.registerProvider` at rank 600; also experimental `skill-badge`, `creation-recommendations`, `plugin-recommendations` |
| Office skills | `packages/skill/skill-office` | Desktop and the SDK, env-gated | Seven instruction-only skills: an `office` router, docx/pptx/xlsx over a bundled Python, render/export-pdf/recalculate over the LibreOffice Kit CLI; no checker, no PDF skill |
| Workspace deps tool | `packages/skill/tool-workspace-dependencies` | carrier opt-in | `load_workspace_dependencies`: a bundled Python, Node, pnpm |
| `present` | `packages/deliverables/tool-present` | Web presets, the SDK app | `maxFiles` 8 (4 advised); one log-only event |
| File-link guidance | `packages/deliverables/deliverable-file-references` | Web, SDK (2026-10-19) | One fixed system-prompt paragraph |
| Plugin Manager | `packages/boot/plugin-manager` | base; tool in Standard and Creator | Persistent profile-wide bundles, in-process and unsandboxed, behind `danger-full-access` or a per-call approval |
| Extensions | `packages/extensions` | Web; `tool-cordis` in Creator | Read-only `tool-cordis`; process-local `node:vm` definitions (no boundary) that no model tool creates |
| Creator skills | `packages/preset/agent-preset/skills` | `cordis` preset | Four skills through `customSkillDirs` |
| MCP | `packages/mcp` | clients opt-in; `mcp-resources` in base | Resources through shared tools, server instructions in the prompt; prompt templates unsupported; stdio env scrubbed |
| PTC | `packages/ptc-runtime` | Node runtime in base | A fresh Node per call under bash's sandbox policy, or an opt-in persistent REPL; its executor a plugin the `ptc` preset mounts (rc.2); Python experimental, unshipped |

- **The catalog.** Recomputed at every `agent/pre-step`: a sha256 over `[name, description]` against the newest LIVE `skill-catalog` message; a change appends the whole list, an emptied list one retirement, an incomplete snapshot nothing. A user-role `<system-reminder>`, descriptions capped at 500, no path, worded as mandatory. `packages/skill/tool-skill/src/index.ts`
- **The loader.** `skill({name})` re-reads the file and reveals only its base directory; `allowed-tools`, `model` and argument substitution are unparsed. Same file.
- **Front-matter.** `name`, `description`, `whenToUse`, `metadata`, two invocation flags; camelCase flags drop the skill. `packages/skill/skill-filesystem/src/index.ts`
- **Sizing.** The pruner keeps a 4,096 head and 1,024 tail of a result over 8,192 code points, so creator skills stay under it. `.agents/notes/archived/architecture/2026-09-21-creator-skills-progressive-disclosure.md`

## Open for the route

- **S22, user invocation.** A `/name` token in a user text block injects the body as a `skill-invocation` user message, last in the step; a `disable-model-invocation` skill is reachable only so. `packages/skill/tool-skill/src/index.ts`
- **S22, carriers.** Desktop ships Python, Node and pnpm as a manifest-checked payload and its office skills in `runtime/office-skills`, outside ASAR; the CLI gets no office paths. `apps/desktop/README.md`
- **S22, cold inspect.** `deliverables/presented` names live paths; `workspace/changes {turn}` is logged while its summary dies with the Session; hosts may show presented files only after the turn. `docs/subsystems/deliverables.md`
- **S22.5, installs.** The default Web preset (`standard`) gained `plugin_manager` on 2026-10-21; the model may also approve pnpm build scripts (`approvedBuilds`) after a conversational yes the service does not verify. `packages/boot/plugin-manager/README.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/skill/{tool-skill,skill-filesystem}/src/index.ts` | Catalog, loader, gesture; ranks, front-matter, `trustedHost` a read path | 2026-10-25 |
| `docs/subsystems/skills.md` | Layers, caching, "optional instructions, not session events" | 2026-10-25 |
| `packages/skill/skill-office/README.md`, `packages/bundle/sdk-app/cordis.patch.yml` | The seven skills; SDK rows behind `DSH_PRIMARY_RUNTIME ?? DSH_BUNDLED_PRIMARY_RUNTIME` or `DSH_BUNDLED_OFFICE_CLI` | 2026-10-25 |
| `packages/bundle/web-app/presets/*.patch.yml` | Skill, `present` and `plugin_manager` rows per preset | 2026-10-25 |
| `packages/boot/plugin-manager/README.md`, `packages/extensions/cordis-host-runner/README.md` | Install authority; `node:vm` is not a boundary | 2026-10-25 |
| `packages/mcp/mcp-client/README.md`, `docs/subsystems/ptc-runtime.md` | MCP limits; the PTC run and its sandbox facts | 2026-10-25 |

## Likely to go stale

- Office: reshaped 10-09 to 10-13, docx guidance trimmed 10-22; a Web mount or a PDF skill are plausible.
- The catalog's prose and its digest input (the doc says rendered text, the code JSON entries).
- `plugin_manager` per preset (Standard since 10-21) and the plugin market.
- Discovery follows the Session's working directory (since 2026-10-05), not the header cwd.

## Not read

- `plugin-manager/src` beyond a grep (no skill reference); the office e2e tests (outside the snapshot).
- `ptc-runtime-python` beyond its summary; DSH's 21 `.agents/skills` beyond four (one front-matter adds `user-invocable: false`).
