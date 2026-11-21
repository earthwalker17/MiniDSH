# DSH reference: Architecture and subsystem map

> The entry map to DSH ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, dsh-v0.2.2-rc.5); checked 2026-11-21.

## What exists (at the pin)

A Cordis plugin tree with "no privileged core" (`docs/architecture.md`): 55 groups, 391 packages (`docs/module-graph.md`, generated; `account`, `connector`, `team` are new), six apps, six bundles. The HOST plane (bundles) owns registries, authority, persistence and the model route; the AGENT plane is a per-session preset, an ordinary `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` a `preset` patch edits by id; only the preset IDENTITY persists (header `agentPreset`, log-only `agent-preset/selected`, `docs/persistence-catalog.md`). A preset revision lives while an Agent binds it, a child joins its parent's revision unless it names a preset, and a row leaking a service outside its `cordis:group` `isolate` realm fails the mount (`packages/preset/agent-preset-registry/README.md`). Every Node application launches through `dsh --profile <name>` (`scripts/verify-application-entrypoints.ts`). Status `default` = a live row in the base bundle unless the purpose names another.

| Component | Path | Status | Purpose |
|---|---|---|---|
| Core spine | `packages/core` | default | Log, tools, agents, swappable loop, prompt, `agent-default-model`; executors are rows (`tool-executor-native`; `-ptc` off); `agent-tool-presentation` picks native or PTC schemas per preset |
| Session data plane | `packages/session`, `packages/session-query` | default | JSONL, v0-v4 migrations, projections, queries |
| LLM | `packages/llm`, `packages/account` | default | DeepSeek api-key and account adapters over `deepseek-auth`, dormant pi-ai, retry, meter |
| Execution world | `packages/fs`, `packages/shell`, `packages/subprocess` | default | fs tools (`apply_patch` off in every shipped row since 2026-11-02), one-shot shell, process tree |
| Authority | `packages/sandbox`, `packages/interaction` | default | Confinement, approval; `DSH_PERMISSION_MODE` fuses sandbox and approval |
| Jobs | `packages/jobs` | default | Host registry keyed by owner; `job_*` tools |
| Delegation | `packages/subagent`, `packages/workflow`, `packages/ptc-runtime`, `packages/team` | default | Spawn, fork, control tools (`interrupt_agent` off in shipped rows since 2026-11-07), workflow, PTC, a Team task board per root Session; codex and claude-code providers on demand |
| Goal, plan, todo, skills | `packages/goal`, `packages/plan`, `packages/todo`, `packages/skill` | default | Round driver, plan mode, todos, layered skills |
| Context hygiene | `packages/compaction`, `packages/guard`, `packages/spill`, `packages/context` | default | Compaction, pruner, image offload, guards, spill, instructions, time context |
| Web tools | `packages/web` | default | Search and fetch |
| Stores, small groups | `packages/storage`, `settings`, `credentials`, `attachment`, `identity`, `feedback`, `workspace`, `typert`, `telemetry`, `connector` | default | KV and the named planes; `typert` is RPC types; `connector` binds third-party services (`cli-account`, `upstream-skills` rows) |
| Boot | `packages/boot`, `packages/util/official-bundles` | default | YAML layers (bundles, profile, home, `--patch`), config HMR, Plugin Manager; the compiled bundle lists |
| Agent presets | `packages/bundle/web-app/presets/<id>.patch.yml`, `packages/preset` | default | Web-app only: `standard` (default), `ptc`, `minimal`, `cordis` (Creator) |
| Smallest complete tree | `packages/bundle/sdk-minimal/cordis.patch.yml` | opt-in | No base: a PTY shell, image-only `tool-fs`, compaction; no approval, `danger-full-access`; checkpoints before dispatch |
| Web surface | `packages/host`, `packages/client`, `packages/api`, `packages/deliverables`, `apps/web` | default | Web-app bundle, over the Typert gateway and `remote-access` rows of base: see [surfaces.md](surfaces.md) |
| MCP | `packages/mcp` | default | Web-app: `mcp-manager` runs a settings-driven fleet of `mcp-client` instances; `mcp-resources` in base |
| Terminal (PTY) | `packages/terminal` | opt-in | The `minimal` preset and sdk-minimal only |
| Extensions | `packages/extensions`, `packages/boot/plugin-manager` | default | In `standard` (since 2026-11-13) and `cordis`: `tool-cordis`, read-only inspection, beside the `plugin_manager` tools |
| Unmounted groups | `packages/lsp`, `ssh`, `browser-use`, `computer-use`; hooks and webhook under `packages/experimental` | opt-in | No row in any of the six bundles |
| Optional bundles | `packages/util/official-bundles/src/bundles.ts` | experimental | Eighteen, off by default (cua, terminal, liveshare, tool-worktree, forge, auto-review...) |
| Other carriers | `packages/sdk`, `packages/acp`, `packages/bundle/headless`, `sdk-app`, `acp-app` | opt-in | Overlays on base: persona restated, HMR off; SDK and ACP drop `session-title-llm` |
| Desktop | `apps/desktop`, `apps/desktop-host`, `apps/desktop-publisher` | opt-in | Electron shell; a private Host runs the CLI-rejected `desktop` profile through `@deepseek-ai/dsh/profile-boot` |
| TUI | none | removed | `packages/ui` deleted 2026-08-04; `--profile tui` survives as an example in `apps/cli/README.md` |

## Open for the route

- **later, an importable surface.** An out-of-tree plugin is a pnpm package in the profile's own `node_modules` that declares `@deepseek-ai/dsh-*` PEERS (a peer means one shared instance) and an `engines.dsh` range, enforced at install and at every profile start; the installation's packages resolve first. The CLI exports `@deepseek-ai/dsh/profile-boot` for the Desktop host. `apps/cli/README.md`, `docs/module-graph.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/architecture.md`, `docs/subsystems/README.md` | Planes, launch rule, seams, Desktop; the index | 2026-11-21 |
| `packages/README.md`, `docs/module-graph.md` | Group table and direction rule; the generated package count | 2026-11-21 |
| `apps/cli/README.md`, `packages/util/official-bundles/src/bundles.ts` | Profiles, plugin resolution; templates, optional, retired and on-demand lists | 2026-11-21 |
| `packages/bundle/*/cordis.patch.yml`, `packages/bundle/web-app/presets` | Default, disabled and overlay rows; the four presets | 2026-11-21 |
| `packages/preset/agent-preset-registry/README.md` | Revision retention, the realm audit, the user default | 2026-11-21 |
| `docs/upgrade-guide/v0.2.2-{alpha.2,alpha.3,rc.1,rc.2,rc.3,rc.4}` | One directory per release change: names listed, `rc.1/subagent-interrupt-default` read | 2026-11-21 |

## Likely to go stale

- Preset toggles: three moved in two weeks (`apply_patch` off "temporarily", `interrupt_agent` off, Cordis inspection into `standard`); a profile may still carry the retired `modeSelectionEnabled`, which nothing reads.
- The count (336 on 10-14, 363 on 10-23, 391 on 11-18): regenerated with each package change.
- Groups leave `packages/experimental` (team by 10-30, its optional bundle retired): recheck "no row in any bundle" per group before citing it.

## Not read

- 239 notes in `.agents/notes/implemented/architecture`; a handful read. Notes move to `archived/` (`2026-07-08-agent-scope-contexts.md`, `2026-07-19-gui-web-client-architecture.md` on 2026-09-30).
- `apps/cli/composition.md`, the generated per-profile composition: the rows above were read from the patch files instead.
- `packages/account`, `packages/connector` beyond their group tables; `website/`, `BENCHMARK.md`, `docs/user/`.
