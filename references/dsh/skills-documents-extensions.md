# DSH reference: Skills, documents, extensions, MCP

> Where to research DSH's skills, document tooling, deliverables and extensions ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@687f282e` (master, 2026-10-17, `0.2.1-rc.2`); re-researched in S19, 2026-10-18.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.skills` registry | `packages/skill/skill` | base host row; Web keeps it on the host | Host + per-scope layers: the nearest layer wins a name, rank only within a layer; runtime `register()` at rank 250 |
| Filesystem provider | `packages/skill/skill-filesystem` | base host row; Web: the `standard`/`ptc` presets | Ranks: project `.dsh/skills` 100, `.agents/skills` 200, custom 300, user 400/500, bundled 600; one level deep; watched; bodies never cached |
| `skill` tool | `packages/skill/tool-skill` | beside the provider | The catalog message, `skill({name})`, the `/name` gesture |
| Office skills | `packages/skill/skill-office` | Desktop and the SDK, env-gated | Seven instruction-only skills: an `office` router, docx/pptx/xlsx authoring over a bundled Python, render/export-pdf/recalculate over the LibreOffice Kit CLI. No checker, no PDF skill |
| Workspace deps tool | `packages/skill/tool-workspace-dependencies` | carrier opt-in | `load_workspace_dependencies`: absolute paths to a bundled Python, Node, pnpm |
| `present` tool | `packages/deliverables/tool-present` | default-mounted | `maxFiles` 8; one log-only event |
| Plugin Manager, market | `packages/boot/plugin-manager`, `plugin-market` | `cordis` preset | Persistent profile-wide bundles behind approval; a read-only market index (2026-10-14) |
| Creator skills | `packages/preset/agent-preset/skills` | `cordis` only | Four skills through `customSkillDirs` (`agent-experience` added 2026-09-28) |
| A plugin's own skill | `packages/sandbox/sandbox-windows-acl` | with the Windows runner | `ctx.skills.registerProvider` from a plugin: the one first-party case |
| MCP | `packages/mcp` | opt-in | Prompts unsupported; resources through three tools; nothing becomes a skill |
| PTC | `packages/ptc-runtime` | default-mounted | Node runtime in base; Python experimental |

What MiniDSH's skills (S19) were measured against:

- **The catalog.** Recomputed at every `agent/pre-step`: a sha256 over `[name, description]` entries against the newest LIVE `skill-catalog` message; a change appends the whole list again, an emptied published list appends one retirement message, an incomplete snapshot appends nothing. User-role `<system-reminder>`, descriptions capped at 500, sorted by name, no path or origin, worded as mandatory ("call the `skill` tool … before taking task actions"). `packages/skill/tool-skill/src/index.ts`
- **The loader.** `skill({name})` re-reads the file and reveals only the base directory; argument substitution, `allowed-tools` and `model` are deliberately unparsed. Same file.
- **Front-matter.** `name`, `description`, `whenToUse`, `metadata`, and two invocation flags; camelCase flags drop the skill. `packages/skill/skill-filesystem/src/index.ts`
- **Office lessons.** The structural checker was removed for a semantic reopen (`fb2a554c`); "copy each unchanged member once" moved into the guidance (`fa740a58`); never point the model at tools the carrier lacks (`f12fa3ba`); no PATH launchers (`bfcc6d50`); nested skill injection added and removed in three days (`efcc1298`). `.agents/notes/implemented/architecture/2026-09-27-progressive-office-skills.md`
- **Sizing.** The pruner cuts a result over 8,192 code points to a 4,096 head plus a 1,024 tail, so every creator SKILL.md and reference is held under 8,192 with line numbers. `.agents/notes/archived/architecture/2026-09-21-creator-skills-progressive-disclosure.md`, `packages/preset/agent-preset/tests/skills.spec.ts`

## Open for the route

- **S22, user invocation.** A `/name` anywhere in a user text block (`/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`) injects the body as a `skill-invocation` user message, last in the step; a `disable-model-invocation` skill is reachable only this way. MiniDSH has no gesture and hides such a skill. `packages/skill/tool-skill/src/index.ts`
- **S22, carriers.** Desktop and the SDK ship Python, Node and pnpm as a manifest-checked payload, copied under the home on first use or used in place. `packages/skill/tool-workspace-dependencies/README.md`
- **S22, cold inspect.** Deliverable events point outside the log: `deliverables/presented` names live paths; `workspace/changes {turn}` is logged while its summary dies with the Session. `docs/subsystems/deliverables.md`
- **Later, judging a skill.** Upstream keeps no provenance on a skill (front-matter is name and description); its office e2e tests reopen the output with the authoring library and include a "loads no skill" case, the with/without evidence. One maintenance loop exists, proposed and human-reviewed. `packages/skill/skill-office/tests/render-tools.e2e.ts`, `.agents/notes/proposed/process/2026-07-13-human-review-skill-maintenance.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/skill/tool-skill/src/index.ts`, `README.md` | Catalog digest, replacement and retirement; loader; gesture | 2026-10-18 |
| `packages/skill/skill-filesystem/src/index.ts`, `README.md` | Ranks, layout, front-matter, watch; `trustedHost` is a read path, not a gate | 2026-10-18 |
| `docs/subsystems/skills.md` | Layers, caching, "skills are optional instructions, not session events" | 2026-10-18 |
| `packages/skill/skill-office/README.md`, `assets/*/SKILL.md` | The seven skills, runtimes, degradation sentences | 2026-10-18 |
| `apps/desktop-host/src/office.ts`, `packages/bundle/sdk-app/cordis.patch.yml` | Desktop mount; SDK rows behind `DSH_PRIMARY_RUNTIME ?? DSH_BUNDLED_PRIMARY_RUNTIME` or `DSH_BUNDLED_OFFICE_CLI` | 2026-10-18 |
| `packages/bundle/base/cordis.patch.yml`, `web-app/cordis.patch.yml`, `presets/*.patch.yml` | Skill rows per deployment; pruner 8,192/4,096/1,024 | 2026-10-18 |
| `packages/boot/plugin-manager/README.md` | Approval, compatibility, lock; never mentions skills | 2026-10-18 |

## Likely to go stale

- Office: seven skills since 2026-10-09, reshaped again 10-12 and 10-13; a Web or base mount, a PDF skill or a renamed router are plausible.
- The catalog's prose and its digest input (the doc says rendered text, the code JSON entries).
- Discovery follows the Session's working directory since 2026-10-05, not the header cwd.
- Plugin market and Discover tab (2026-10-14).

## Not read

- `plugin-manager/src`; the `windows-acl-skill` snapshot; the office e2e test bodies beyond their assertions.
- `docs/subsystems/ptc-runtime.md` body; `ptc-runtime-python` beyond its summary.
- DSH's 19 `.agents/skills` beyond two (front-matter is name and description in all 22 read).
