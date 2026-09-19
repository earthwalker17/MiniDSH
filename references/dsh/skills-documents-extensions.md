# DSH reference: Skills, documents, extensions, MCP

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.skills` registry | `packages/skill/skill` | default-mounted | Layered host-plane provider registry. |
| Filesystem provider | `packages/skill/skill-filesystem` | default-mounted | Scans ranked roots; re-reads bodies per load; watches. |
| `skill` tool | `packages/skill/tool-skill` | default-mounted | Durable catalog message, body loader, user `/name` gesture. |
| Office skills | `packages/skill/skill-office` | opt-in | docx, pptx, xlsx skills plus a stdlib checker; Desktop only. |
| Office-to-PDF | `packages/document/office-to-pdf` | default-mounted | Web-app preview service; no model tool, no session events. |
| `present` tool | `packages/deliverables/tool-present` | default-mounted | Declares up to 8 deliverable files; one log-only event. |
| Workspace changes | `packages/deliverables/workspace-changes` | default-mounted | Web-app row; per-turn changed-file summary in host memory. |
| Package runner | `packages/extensions/cordis-host-runner` | default-mounted | Web-app row; `node:vm` registry no shipped model tool reaches. |
| Inspect tools | `packages/extensions/tool-cordis` | opt-in | Two read-only API discovery tools; `cordis` preset only. |
| Plugin Manager tool | `packages/boot/plugin-manager` | disabled-by-default | Installs persistent profile-wide bundles; on only in `cordis`. |
| MCP | `packages/mcp` | opt-in | One client row per server, none shipped; resource service inert. |
| PTC | `packages/ptc-runtime` | opt-in | Runtime host row default-mounted; presentation only in the `ptc` preset. |

## Mechanisms worth knowing

- **Format and roots**: `<root>/<name>/SKILL.md` or flat `<name>.md`, one level deep. Front-matter `name`, `description`, optional `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable`; a malformed flag drops the skill. Ranks, lower wins: 100 `.dsh/skills`, 200 `.agents/skills` (project), 300 `customSkillDirs`, 400/500 user homes, 600 bundled. `packages/skill/skill-filesystem/README.md`
- **Registry**: global plus per-scope layers; the nearest layer wins a duplicate name, rank decides only inside a layer. Providers expose `list`/`get`. Incomplete snapshots are never cached (consumers keep the last-good view), nor are bodies. `docs/subsystems/skills.md`
- **Mounting**: base mounts `skill`, `skill-filesystem`, `tool-skill` as host rows; the web-app overlay disables the last two so presets own them: `standard` and `cordis` mount both plus `present`, `minimal` none; `cordis` adds two authoring skills via `customSkillDirs`. `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml`, `packages/preset/agent-presets/presets`
- **Catalog**: never a system-prompt section. Each `agent/pre-step` compares a digest of model-invocable entries with the newest visible `skill-catalog` message in the log; a change appends one user-role `<system-reminder>` with the whole list (names, descriptions capped at 500), even an empty one. No skill event type. `packages/skill/tool-skill/README.md`
- **Body load**: `skill({name})` re-reads the file and returns a base directory (no listing) plus instructions, kept as tool history; a user `/name` token injects the identical block. `disable-model-invocation` hides a skill from catalog and loader. Body edits touch neither catalog nor old results. `packages/skill/tool-skill/README.md`
- **Scripts and trust**: no script runner; skill scripts run through the ordinary shell tool under the session's sandbox and approvals. No trust gate for workspace skills is documented (`SAFETY.md` never mentions skills), yet project roots rank first, so a clone can shadow user and bundled skills by name. `packages/skill/skill-filesystem/README.md`
- **Office skills**: python-docx, python-pptx, openpyxl/pandas instructions plus `check_office.py`, a stdlib OOXML checker. Interpreter: Desktop's bundled Python (`load_workspace_dependencies`); installing packages is forbidden; `render_document` visual QA is optional, its absence stated. No PDF skill. `packages/skill/skill-office/README.md`, `apps/desktop-host/src/office.ts`
- **Deliverables**: `present` appends `deliverables/presented`, pointing at live paths and copying no bytes. `workspace/changes {turn}` is appended at turn stop, but its summary and diffs stay in host memory until session dispose. Neither reaches the model. `docs/subsystems/deliverables.md`
- **Extensions pivot**: the `node:vm` runner is session-scoped and "is not a security boundary"; no shipped model tool defines packages now. Model-authored code installs as bundles through `plugin_manager`: each action needs `danger-full-access` or per-call approval, persists profile-wide, runs in-process outside the sandbox. `packages/extensions/cordis-host-runner/README.md`, `packages/boot/plugin-manager/README.md`
- **MCP**: tools register as `mcp__<serverName>__<tool>` in the ordinary registry with permissions and recorded results; a failed refresh keeps the previous generation; server instructions join the recorded system prompt. Prompts, elicitation, tasks, subscriptions unsupported. `docs/subsystems/mcp.md`, `packages/mcp/mcp-client/README.md`

## Why it matters to MiniDSH

- **S19, catalog**: upstream confirms the plan: a durable user-role message after the stable prefix, whole-list replacement, an explicit empty catalog, a change baseline read from the log.
- **S19, loader: NO upstream oracle.** DSH loads bodies through a dedicated tool; MiniDSH plans none, so S19 owns what that tool gives DSH: the catalog must carry a readable path (DSH hides paths until load), `disable-model-invocation` has no enforcement point once any file read opens the body, and no rendering is shared with a `/name` gesture.
- **S19, shadowing**: upstream is the warning, not the oracle: "must not shadow by name" reverses DSH's rank table, so S19 tests it alone.
- **S19, document skills**: copy the shape: instructions plus one dependency-free checker; interpreter, libraries and renderer come from the deployment; visual checks optional. FALSIFIED: the route lists docx/pdf/xlsx/pptx, but upstream has no PDF skill and mounts the rest only on Desktop.
- **S19, discovery**: never publish a deletion from a failed scan; fail closed on malformed flags; re-read bodies, never version them. Per-scope layers can wait for S21.
- **S14, S15**: skills add instructions, never authority: scripts run through the shell tool, so S14's effect record and S15's approval subject already cover them.
- **S15, self-extension**: FALSIFIED in part: MiniDSH believed model-written extensions were opt-in vm packages; at the pin no model tool creates them and the gate is the permission layer. A model-written `composition.json` row belongs behind S15 approval. Warning: DSH's build-script approval "does not verify conversation approval" (`packages/boot/plugin-manager/README.md`).
- **S16**: durable event names are a format contract; pick names without product terms. FALSIFIED: MiniDSH recorded "PTC was renamed Code Mode"; history says Code Mode was renamed TO PTC (2026-08-25), and durable `tool/code-dispatch*` waits for a versioned format edge because an in-place rename would make old logs unreadable (`.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.md`). Replay counter-example: `workspace/changes` is logged but its payload is not.
- **S18**: FALSIFIED: "the MCP bridge ships disabled". No disabled row exists; MCP is unconfigured and inert while `mcp-resources` is mounted in every profile (`docs/subsystems/mcp.md`). The Tavily row should copy zero footprint when unconfigured and stable namespaced names.
- **S20, S22**: a deliverable is a logged declaration of a live path, not an artifact store; upstream document rendering is a preview service outside loop and log. A bundled interpreter is an S22 launcher question.

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/subsystems/skills.md` | Registry contract, layering | 2026-09-19 |
| `packages/skill/tool-skill/README.md` | Catalog and result templates | 2026-09-19 |
| `packages/skill/skill-filesystem/README.md` | Format, rank table, limits | 2026-09-19 |
| `packages/skill/skill-office/README.md` | Office skill set, checker | 2026-09-19 |
| `packages/skill/skill-office/assets/office-docx/SKILL.md` | One concrete document skill | 2026-09-19 |
| `apps/desktop-host/src/office.ts` | Desktop mount of `dsh-skill-office` | 2026-09-19 |
| `packages/preset/agent-presets/presets/standard/agent.cordis.yml` | Skills, `present` on; plugin tool off | 2026-09-19 |
| `packages/preset/agent-presets/presets/cordis/agent.cordis.yml` | TRUST header, Creator rows | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Host rows: skills, badge, PTC, MCP | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Web rows; base skill rows disabled | 2026-09-19 |
| `docs/subsystems/deliverables.md` | Two log-only events, memory-only summary | 2026-09-19 |
| `packages/extensions/cordis-host-runner/README.md` | Lifecycle, trust stance, pivot | 2026-09-19 |
| `packages/boot/plugin-manager/README.md` | Approval rule, build-script caveat | 2026-09-19 |
| `docs/subsystems/mcp.md` | Opt-in rule, unsupported list | 2026-09-19 |
| `packages/mcp/mcp-client/README.md` | Tool naming, reconnect behaviour | 2026-09-19 |
| `.agents/notes/archived/architecture/2026-08-25-rename-code-mode-to-ptc.md` | History: rename direction and scope | 2026-09-19 |
| `SAFETY.md` | No trust rule for workspace skills | 2026-09-19 |

## Likely to go stale

- The extensions pivot is one day old at the pin; the runners look vestigial and `docs/subsystems/extensions.md` is a stub.
- `dsh-skill-office` is days old: a CLI or Web mount, a PDF skill, or renamed `load_workspace_dependencies` and `render_document` tools are plausible.
- The rank table and the missing trust gate: a trust prompt is an obvious follow-up.
- Which plane owns the skill rows; composition files change weekly.
- `tool/code-dispatch*` awaits a rename; memory-only `workspace/changes` is a documented limitation; the MCP unsupported list tracks the official SDK.

## Not read

- Skill package source (`packages/skill/skill-filesystem/src/index.ts`, `packages/skill/tool-skill/src/index.ts`): "no trust gate" rests on docs only.
- `snapshots/session/skill-load`: recorded logs with model-only and user-only skills; the best behavioural oracle for S19.
- The `office-pptx` and `office-xlsx` SKILL.md bodies, `check_office.py`, the Creator skills (`packages/preset/agent-presets/presets/cordis/skills`), DSH's own twelve skills under `.agents/skills`.
- `apps/desktop-host/src/workspace-dependencies.ts` and the `render_document` backend (no file name in the pinned tree matches it); PDF handling.
- `packages/extensions/tool-cordis/README.md`, `docs/tool-catalog.md`; inspect tool names come from the `cordis` preset persona.
- The `headless`, `acp-app`, `sdk-app`, `sdk-minimal` bundles under `packages/bundle`; the `ptc` preset's skill rows.
- How compaction treats loaded skill bodies.
