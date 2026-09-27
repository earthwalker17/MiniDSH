# DSH reference: Architecture and subsystem map

> The entry map to DSH ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2); checked 2026-09-26.

## What exists (at the pin)

A Cordis plugin tree with "no privileged core" (`docs/architecture.md`): 54 groups, 312 packages (`docs/module-graph.md`, generated), four apps, six bundles. The HOST plane (bundles) owns registries, authority, persistence and the model route; the AGENT plane is a per-session preset, since 2026-09-21 an ordinary `@deepseek-ai/dsh-agent-preset` row a profile patch can override; only the preset IDENTITY persists (header `agentPreset`, log-only `agent-preset/selected`, `docs/persistence-catalog.md`). Status `default` = a live row in the base bundle unless the purpose names another.

| Component | Path | Status | Purpose |
|---|---|---|---|
| Core spine | `packages/core` | default | Log, tools, agents, swappable loop, prompt, `agent-default-model` |
| Session data plane | `packages/session`, `packages/session-query` | default | JSONL, v0-v4 migrations, projections, queries |
| LLM | `packages/llm` | default | DeepSeek api-key and account adapters, dormant pi-ai, retry, meter |
| Execution world | `packages/fs`, `packages/shell`, `packages/subprocess` | default | fs tools, one-shot shell, process tree |
| Authority | `packages/sandbox`, `packages/interaction` | default | Confinement, approval; `DSH_PERMISSION_MODE` fuses sandbox and approval |
| Jobs | `packages/jobs` | default | Host registry keyed by owner; `job_*` tools |
| Delegation | `packages/subagent`, `packages/workflow`, `packages/ptc-runtime` | default | Spawn, fork, codex and claude-code providers, workflow, PTC |
| Goal, plan, todo, skills | `packages/goal`, `packages/plan`, `packages/todo`, `packages/skill` | default | Round driver, plan mode, todos, layered skills |
| Context hygiene | `packages/compaction`, `packages/guard`, `packages/spill`, `packages/context` | default | Compaction, pruner, image offload, guards, spill, instructions, time context |
| Web tools | `packages/web` | default | Search and fetch, not the GUI |
| Stores, small groups | `packages/storage`, `settings`, `credentials`, `attachment`, `identity`, `feedback`, `workspace`, `typert` | default | KV, settings, credentials, attachments, identity, feedback, workspace, RPC types |
| Boot | `packages/boot` | default | YAML layers (bundles, profile, home, `--patch`), config HMR, Plugin Manager |
| Disabled rows | `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | disabled | base: `tool-plugin-manager`, `tool-ralph`, `skill-badge`; web-app: `schedule`, `time-context`, `ui-schedule` |
| Agent presets | `packages/bundle/web-app/presets/<id>.patch.yml`, `packages/preset` | default | Web-app only: `standard` (default), `ptc`, `minimal` (persona plus a PTY group), `cordis` (Creator); the registry and persona in `packages/preset` |
| Smallest complete tree | `packages/bundle/sdk-minimal/cordis.patch.yml` | opt-in | One insert, no base: no approval, fs tools or compaction; `danger-full-access` |
| Web surface | `packages/host`, `packages/client`, `packages/api`, `packages/deliverables`, `apps/web` | default | Web-app bundle: see [surfaces.md](surfaces.md) |
| MCP | `packages/mcp` | opt-in | `mcp-resources` live; no `mcp-client` row |
| Terminal (PTY) | `packages/terminal` | opt-in | PTY, not a TUI; the `minimal` preset and sdk-minimal only |
| Extensions | `packages/extensions` | opt-in | `tool-cordis` in the `cordis` preset; inspect providers in web-app |
| Unmounted groups | `packages/hooks`, `packages/lsp`, `packages/ssh`, `packages/webhook`, `packages/browser-use`, `packages/computer-use` | opt-in | No row in any bundle |
| Optional bundles | `packages/experimental/agent-team-profile`, `voice-input-bundle`, `auto-review` | experimental | Offered by the Web plugin page |
| Other carriers | `packages/sdk`, `packages/acp`, `packages/bundle/headless`, `sdk-app`, `acp-app` | opt-in | Overlays on base: persona restated, `session-title-llm` and HMR off |
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron shell; a private Host runs the CLI-rejected `desktop` profile |
| TUI | `packages/ui/tui` | removed | Deleted 2026-08-04; `tui` survives as an example name |

## Open for the route

- **S17, job ownership.** A preset's service sits in an `isolate` realm; a service a row outside the realm READS stays on the host, keyed by owner (a realm-scoped jobs registry answered "background jobs unavailable"). `packages/bundle/web-app/cordis.patch.yml`
- **S17, a held process.** fs and subprocess providers share one execution world: one swap moves Bash, PTY and LSP together. `docs/architecture.md`
- **S18, the default route.** `agent-default-model` is a host row apart from the adapters; a saved selection overrides it at creation. `packages/bundle/base/cordis.patch.yml`
- **S19, the skill registry.** Host plus per-scope layers: a preset's `skill-filesystem` fills its own layer; base's host row is disabled in web-app. `packages/bundle/web-app/cordis.patch.yml`
- **S20, browser providers.** Playwright MCP, DevTools MCP and Cua stay explicit compositions, never optional bundles. `.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md`
- **S22, one launcher.** `scripts/verify-application-entrypoints.ts` rejects a bin bypassing `dsh`; Desktop boots through `@deepseek-ai/dsh/profile-boot`. `apps/desktop-host/src/index.ts`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/architecture.md`, `docs/subsystems/README.md` | Planes, layering, seam roles, durability limits, Desktop; the index | 2026-09-26 |
| `packages/README.md`, `docs/module-graph.md` | Group table and direction rule; the generated package count | 2026-09-26 |
| `AGENTS.md`, `scripts/verify-application-entrypoints.ts`, `apps/cli/README.md` | Launch rule and its gate; profiles | 2026-09-26 |
| `packages/bundle/*/cordis.patch.yml` | Default, disabled and overlay rows | 2026-09-26 |
| `packages/bundle/web-app/presets`, `packages/preset/README.md` | Four declared presets: rows, realms, order | 2026-09-26 |
| `.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.md`, `2026-08-10-host-plane-ownership-after-presets.md`, `2026-09-21-experimental-capabilities-as-optional-bundles.md` | Presets as rows; host-plane rule; optional bundles | 2026-09-26 |

## Likely to go stale

- Presets: directories became declarations on 09-21; `tool-plugin-manager` sits disabled in every preset; the Coding Tools preference (renamed 09-24) gates selection.
- web-app rows churn daily: `schedule` and `time-context` inserted then disabled on 09-24.
- The count: 312 on 09-24, account and provider packages added 09-22/23; the graph regenerates weekly.

## Not read

- 198 notes in `.agents/notes/implemented/architecture`; four read (above).
- `packages/preset/agent-preset-registry/src`: the realm-less-row rejection and revision retention.
