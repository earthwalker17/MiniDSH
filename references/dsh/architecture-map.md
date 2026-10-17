# DSH reference: Architecture and subsystem map

> The entry map to DSH ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2); checked 2026-09-26; the counts rechecked at `57190202` on 2026-10-15.

## What exists (at the pin)

A Cordis plugin tree with "no privileged core" (`docs/architecture.md`): 52 groups, 336 packages on 2026-10-14 (`docs/module-graph.md`, generated), four apps, six bundles. The HOST plane (bundles) owns registries, authority, persistence and the model route; the AGENT plane is a per-session preset, since 2026-09-21 an ordinary `@deepseek-ai/dsh-agent-preset` row a profile patch can override; only the preset IDENTITY persists (header `agentPreset`, log-only `agent-preset/selected`, `docs/persistence-catalog.md`). Status `default` = a live row in the base bundle unless the purpose names another.

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
| Web tools | `packages/web` | default | Search and fetch |
| Stores, small groups | `packages/storage`, `settings`, `credentials`, `attachment`, `identity`, `feedback`, `workspace`, `typert` | default | KV and the named planes; `typert` is RPC types |
| Boot | `packages/boot` | default | YAML layers (bundles, profile, home, `--patch`), config HMR, Plugin Manager |
| Agent presets | `packages/bundle/web-app/presets/<id>.patch.yml`, `packages/preset` | default | Web-app only: `standard` (default), `ptc`, `minimal`, `cordis` (Creator) |
| Smallest complete tree | `packages/bundle/sdk-minimal/cordis.patch.yml` | opt-in | One insert, no base: no approval, fs tools or compaction; `danger-full-access` |
| Web surface | `packages/host`, `packages/client`, `packages/api`, `packages/deliverables`, `apps/web` | default | Web-app bundle: see [surfaces.md](surfaces.md) |
| MCP | `packages/mcp` | opt-in | `mcp-resources` live; no `mcp-client` row |
| Terminal (PTY) | `packages/terminal` | opt-in | The `minimal` preset and sdk-minimal only |
| Extensions | `packages/extensions` | opt-in | `tool-cordis` in the `cordis` preset; inspect providers in web-app |
| Unmounted groups | `packages/lsp`, `packages/ssh`, `packages/browser-use`, `packages/computer-use`; hooks and webhook under `packages/experimental` since 2026-10-06 | opt-in | No row in any bundle |
| Optional bundles | `packages/experimental/agent-team-profile`, `voice-input-bundle`, `auto-review` | experimental | Offered by the Web plugin page |
| Other carriers | `packages/sdk`, `packages/acp`, `packages/bundle/headless`, `sdk-app`, `acp-app` | opt-in | Overlays on base: persona restated, `session-title-llm` and HMR off |
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron shell; a private Host runs the CLI-rejected `desktop` profile |
| TUI | `packages/ui/tui` | removed | Deleted 2026-08-04; `tui` survives as an example name |

## Open for the route

- **S18, the default route.** `agent-default-model` is a host row apart from the adapters; a saved selection overrides it at creation. `packages/bundle/base/cordis.patch.yml`
- **S20, a held process.** fs and subprocess providers share one execution world: one swap moves Bash, PTY and LSP together, and the subprocess seam owns the process range. `packages/subprocess/subprocess/src/index.ts`
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
| `.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.md`, `2026-08-10-host-plane-ownership-after-presets.md` | Presets as rows; the host-plane rule | 2026-09-26 |

## Likely to go stale

- Presets: `tool-plugin-manager` sits disabled in every preset; the Coding Tools preference (renamed 09-24) gates selection.
- web-app rows churn: `schedule` was inserted and disabled on 09-24 and is enabled at `57190202`.
- The count (312 on 09-24, 336 on 10-14): the graph regenerates weekly.

## Not read

- 198 notes in `.agents/notes/implemented/architecture`; four read (above).
- `packages/preset/agent-preset-registry/src`: the realm-less-row rejection and revision retention.
