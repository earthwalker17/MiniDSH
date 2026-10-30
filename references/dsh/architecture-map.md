# DSH reference: Architecture and subsystem map

> The entry map to DSH ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, dsh-v0.2.1-rc.3); checked 2026-10-25.

## What exists (at the pin)

A Cordis plugin tree with "no privileged core" (`docs/architecture.md`): 52 groups, 363 packages on 2026-10-23 (`docs/module-graph.md`, generated), five apps, six bundles. The HOST plane (bundles) owns registries, authority, persistence and the model route; the AGENT plane is a per-session preset, an ordinary `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` a `preset` patch edits by id; only the preset IDENTITY persists (header `agentPreset`, log-only `agent-preset/selected`, `docs/persistence-catalog.md`). A preset revision lives while an Agent binds it, a child joins its parent's exact revision, and a row publishing a service outside an `isolate` realm fails the mount (`packages/preset/agent-preset-registry/src/{index,mount}.ts`). Status `default` = a live row in the base bundle unless the purpose names another.

| Component | Path | Status | Purpose |
|---|---|---|---|
| Core spine | `packages/core` | default | Log, tools, agents, swappable loop, prompt, `agent-default-model`; executors are rows (`tool-executor-native`; `-ptc` off) |
| Session data plane | `packages/session`, `packages/session-query` | default | JSONL, v0-v4 migrations, projections, queries |
| LLM | `packages/llm` | default | DeepSeek api-key and account adapters, dormant pi-ai, retry, meter |
| Execution world | `packages/fs`, `packages/shell`, `packages/subprocess` | default | fs tools, one-shot shell, process tree |
| Authority | `packages/sandbox`, `packages/interaction` | default | Confinement, approval; `DSH_PERMISSION_MODE` fuses sandbox and approval |
| Jobs | `packages/jobs` | default | Host registry keyed by owner; `job_*` tools |
| Delegation | `packages/subagent`, `packages/workflow`, `packages/ptc-runtime` | default | Spawn, fork, workflow, PTC; codex and claude-code providers on demand |
| Goal, plan, todo, skills | `packages/goal`, `packages/plan`, `packages/todo`, `packages/skill` | default | Round driver, plan mode, todos, layered skills |
| Context hygiene | `packages/compaction`, `packages/guard`, `packages/spill`, `packages/context` | default | Compaction, pruner, image offload, guards, spill, instructions, time context |
| Web tools | `packages/web` | default | Search and fetch |
| Stores, small groups | `packages/storage`, `settings`, `credentials`, `attachment`, `identity`, `feedback`, `workspace`, `typert`, `telemetry` | default | KV and the named planes; `typert` is RPC types |
| Boot | `packages/boot`, `packages/util/official-bundles` | default | YAML layers (bundles, profile, home, `--patch`), config HMR, Plugin Manager; the compiled bundle lists |
| Agent presets | `packages/bundle/web-app/presets/<id>.patch.yml`, `packages/preset` | default | Web-app only: `standard` (default), `ptc`, `minimal`, `cordis` (Creator) |
| Smallest complete tree | `packages/bundle/sdk-minimal/cordis.patch.yml` | opt-in | No base: a PTY shell, image-only `tool-fs`, compaction; no approval, `danger-full-access`; checkpoints before dispatch |
| Web surface | `packages/host`, `packages/client`, `packages/api`, `packages/deliverables`, `apps/web` | default | Web-app bundle: see [surfaces.md](surfaces.md) |
| MCP | `packages/mcp` | opt-in | `mcp-resources` live; no `mcp-client` row |
| Terminal (PTY) | `packages/terminal` | opt-in | The `minimal` preset and sdk-minimal only |
| Extensions | `packages/extensions`, `packages/boot/plugin-manager` | opt-in | `tool-cordis` in `cordis`; `plugin_manager` tools in `standard` (2026-10-21) and `cordis` |
| Unmounted groups | `packages/lsp`, `ssh`, `browser-use`, `computer-use`; hooks and webhook under `packages/experimental` | opt-in | No row in any bundle |
| Optional bundles | `packages/util/official-bundles/src/bundles.ts` | experimental | Fourteen, off by default (cua, terminal, agent-team, auto-review...); a list changes only with a release |
| Other carriers | `packages/sdk`, `packages/acp`, `packages/bundle/headless`, `sdk-app`, `acp-app` | opt-in | Overlays on base: persona restated, HMR off; SDK and ACP drop `session-title-llm` |
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron shell; a private Host runs the CLI-rejected `desktop` profile |
| TUI | `packages/ui/tui` | removed | Deleted 2026-08-04; `tui` survives as an example name |

## Open for the route

- **S22, one launcher.** `scripts/verify-application-entrypoints.ts` rejects a bin bypassing `dsh`; Desktop boots through `@deepseek-ai/dsh/profile-boot`. `apps/cli/README.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/architecture.md`, `docs/subsystems/README.md` | Planes, seams, Desktop; the index | 2026-10-25 |
| `packages/README.md`, `docs/module-graph.md` | Group table and direction rule; the generated package count | 2026-10-25 |
| `apps/cli/README.md`, `packages/util/official-bundles/src/bundles.ts` | Launch rule, profiles; templates, optional and on-demand lists | 2026-10-25 |
| `packages/bundle/*/cordis.patch.yml`, `packages/bundle/web-app/presets` | Default, disabled and overlay rows; the four presets | 2026-10-25 |
| `packages/preset/agent-preset-registry/src` | Revision retention, the realm audit | 2026-10-25 |
| `docs/upgrade-guide/v0.2.1-rc.2/*`, `v0.2.1-rc.3/*` | The release changes this file cites | 2026-10-25 |

## Likely to go stale

- Presets: the Coding Tools preference gates which presets a person may pick; `plugin_manager` moved into `standard` on 10-21.
- The count (312 on 09-24, 336 on 10-14, 363 on 10-23): regenerated with each package change.

## Not read

- 194 notes in `.agents/notes/implemented/architecture` (outside the snapshot); five read.
- `apps/desktop-host/src` (outside the snapshot): its `profile-boot` call is known only from `apps/cli/README.md`.
