# DSH reference: Architecture and subsystem map

> The entry map to DSH ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19.

## What exists (at the pin)

A Cordis plugin tree with "no privileged core" (`docs/architecture.md`): 54 groups in `packages/`, four apps, six bundles. The HOST plane (bundles) owns registries, authority, persistence and the model route; the AGENT plane is a per-session preset, mounted only by web-app. Status `default` = a live row in the base bundle unless the purpose names another.

| Component | Path | Status | Purpose |
|---|---|---|---|
| Core spine | `packages/core` | default | Log, tools, agents, swappable loop, prompt |
| Session data plane | `packages/session`, `packages/session-query` | default | JSONL, v0-v3 migrations, projections, queries |
| LLM | `packages/llm` | default | DeepSeek and pi-ai adapters, retry, meter |
| Execution world | `packages/fs`, `packages/shell`, `packages/subprocess` | default | fs tools, one-shot shell, process tree |
| Authority | `packages/sandbox`, `packages/interaction` | default | Confinement, approval; `DSH_PERMISSION_MODE` fuses sandbox and approval |
| Jobs | `packages/jobs` | default | Host registry keyed by owner; `job_*` tools |
| Delegation | `packages/subagent`, `packages/workflow`, `packages/ptc-runtime` | default | Spawn, fork, workflow, code runtime |
| Goal, plan, todo, skills | `packages/goal`, `packages/plan`, `packages/todo`, `packages/skill` | default | Round driver, plan mode, todos, layered skills |
| Context hygiene | `packages/compaction`, `packages/guard`, `packages/spill` | default | Compaction, pruner, image offload, guards, spill |
| Web tools | `packages/web` | default | Search and fetch, not the GUI |
| Stores | `packages/storage`, `packages/settings`, `packages/credentials`, `packages/attachment` | default | Storage, settings, credential refs, attachments |
| Boot | `packages/boot` | default | YAML layers (bundles, profile, home, `--patch`), config-only HMR, Plugin Manager |
| Disabled rows | `packages/bundle/base/cordis.patch.yml` | disabled | `tool-plugin-manager` (on in `cordis`), `tool-ralph`, `skill-badge` |
| Agent presets | `packages/preset/agent-presets/presets` | default | Web-app only: `standard` (default), `minimal` (one PTY shell), `cordis` (Plugin Manager), `ptc` (`run_code`) |
| Smallest complete tree | `packages/bundle/sdk-minimal/cordis.patch.yml` | opt-in | 32 rows: no approval, fs tools or compaction; `danger-full-access` |
| Web surface | `packages/host`, `packages/client`, `packages/deliverables`, `apps/web` | default | Web-app bundle: see [surfaces.md](surfaces.md) |
| MCP | `packages/mcp` | opt-in | `mcp-resources` live; no `mcp-client` row |
| Terminal (PTY) | `packages/terminal` | opt-in | PTY, not a TUI; `minimal` and sdk-minimal only |
| Extensions | `packages/extensions` | opt-in | Discovery in `cordis`; runners in web-app |
| Unmounted groups | `packages/schedule`, `packages/hooks`, `packages/lsp`, `packages/ssh`, `packages/webhook`, `packages/browser-use`, `packages/computer-use` | opt-in | No row in any bundle |
| Agent team | `packages/experimental/agent-team` | experimental | Mailbox, tasks over continuable subagents |
| Other carriers | `packages/sdk`, `packages/acp`, `packages/bundle/headless`, `apps/desktop` | opt-in | Overlays on base |
| TUI | `packages/ui/tui` | removed | Deleted (2026-08-04 note) |

## Open for the route

- **S16, an audit of attempts.** "Model-visible means logged", yet process loss before settlement "leaves no durable attempt stream" and tail repair "remains a handle consumer responsibility". `docs/architecture.md`
- **S16, provenance.** Unchecked whether upstream persists the composition a session ran under (old ARCH §12 said no; MiniDSH appends `composition/applied`). `docs/persistence-catalog.md`
- **S17, job ownership.** A preset's service must sit in an `isolate` realm; one read from outside it stays on the host, keyed by owner (a realm-scoped jobs registry answered "background jobs unavailable"). `packages/preset/agent-presets/presets/standard/agent.cordis.yml`
- **S17, a held process.** fs and subprocess providers share one execution world: one swap moves Bash, PTY and LSP together. `docs/architecture.md`
- **S22, one launcher.** `scripts/verify-application-entrypoints.ts` rejects a bin bypassing `dsh`.
- **Built (S14, S15).** ARCH §12; verdicts in [assumptions.md](../assumptions.md).

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/architecture.md` | Planes, layering, seam roles, durability limits | 2026-09-19 |
| `packages/README.md` | Group table, direction rule, tiers | 2026-09-19 |
| `AGENTS.md`, `scripts/verify-application-entrypoints.ts` | Launch rule and its gate; seam completeness | 2026-09-19 |
| `docs/subsystems/README.md` | Subsystem index | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Default and disabled rows | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml`, `packages/bundle/sdk-minimal/cordis.patch.yml`, `packages/bundle/headless/cordis.patch.yml` | Preset plane; smallest tree; overlays (so `sdk-app`, `acp-app`) | 2026-09-19 |
| `packages/preset/agent-presets/presets` | Four presets: rows, realms, trust | 2026-09-19 |
| `.agents/notes/archived/simplification/2026-08-04-remove-tui-package.md` | TUI deletion (history) | 2026-09-19 |

## Likely to go stale

- Preset and base rows change weekly (`minimal` on 09-03 and 09-08).
- Preset cardinality: `standard` says mounted once under a standing scope, `ptc` once per session.
- Comments lag: presets name `base.cordis.yml`; web-app names a TUI and `apps/cli/src/web.ts`; `packages/README.md` says "model-written mount/unmount".
- Profile count: `packages/experimental/agent-team-profile` may graduate.

## Not read

- 149 notes in `.agents/notes/implemented/architecture`, e.g. `2026-08-10-host-plane-ownership-after-presets.md`.
- `docs/agent-lifecycle.md`, `docs/glossary.md`, `docs/session-format-status.md`, `docs/persistence-catalog.md`.
- `packages/identity` (no row in any bundle), `packages/context`, `packages/workspace`, `packages/typert`, `packages/feedback`.
- The desktop profile's composition; the code in `packages/preset/agent-presets` that rejects a realm-less row.
- Tree only: `packages/skill/skill-office`, `packages/experimental/ptc-runtime-python`.
- Release notes; commit history before 2026-09-17.
