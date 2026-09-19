# DSH reference: Architecture and subsystem map

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

A Cordis plugin tree with "no privileged core" (`docs/architecture.md`): 54 groups in `packages/`, four apps, six bundles. default-mounted = a live row in `packages/bundle/base/cordis.patch.yml` (89 rows) unless the purpose names another bundle; opt-in = no base row.

| Component | Path | Status | Purpose |
|---|---|---|---|
| Core spine | `packages/core` | default-mounted | Session log, tool registry and waterfalls, agents, swappable loop, prompt |
| Session data plane | `packages/session`, `packages/session-query` | default-mounted | JSONL persistence, v0-v3 migrations, projection folds, titles, queries |
| LLM | `packages/llm` | default-mounted | Model service, DeepSeek and pi-ai adapters, retry, token meter |
| Execution world | `packages/fs`, `packages/shell`, `packages/subprocess` | default-mounted | fs seam and tools, one-shot bash or pwsh, process-tree provider |
| Authority | `packages/sandbox`, `packages/interaction` | default-mounted | Confinement seam (bwrap, Landlock, Seatbelt), one-shot approval, three permission modes |
| Jobs | `packages/jobs` | default-mounted | Host registry keyed by owning agent; `job_*` tools |
| Delegation | `packages/subagent`, `packages/workflow`, `packages/ptc-runtime` | default-mounted | In-process spawn and fork, workflow engine, sandboxed Node code runtime |
| Goal, plan, todo, skills | `packages/goal`, `packages/plan`, `packages/todo`, `packages/skill` | default-mounted | Round driver, reviewed plan mode, todo events, layered skill registry |
| Context hygiene | `packages/compaction`, `packages/guard`, `packages/spill` | default-mounted | Compaction, pruner, image offload, repeat-call reminder, tool deadline, spill |
| Web tools | `packages/web` | default-mounted | Search and fetch seam; DeepSeek search, HTTP fetch live |
| Stores | `packages/storage`, `packages/settings`, `packages/credentials`, `packages/attachment` | default-mounted | JSON storage, settings file, credential references, attachments |
| Boot | `packages/boot` | default-mounted | Profile composition, config-only HMR, Plugin Manager |
| Disabled rows | `packages/bundle/base/cordis.patch.yml` | disabled-by-default | `tool-plugin-manager` (on only in `cordis` preset), `tool-ralph`, `skill-badge` |
| Agent presets | `packages/preset` | default-mounted | Per-session roster and persona; web-app bundle only |
| Web surface | `packages/host`, `packages/client`, `packages/deliverables`, `apps/web` | default-mounted | HTTP host, Typert RPC, browser shell, deliverables; web-app bundle |
| MCP | `packages/mcp` | opt-in | `mcp-resources` is live; no `mcp-client` row ships |
| Terminal (PTY) | `packages/terminal` | opt-in | Process-local PTY; `minimal` preset and sdk-minimal only |
| Extensions | `packages/extensions` | opt-in | Read-only API discovery in `cordis` preset; runners in web-app |
| Unmounted groups | `packages/schedule`, `packages/hooks`, `packages/lsp`, `packages/ssh`, `packages/webhook`, `packages/browser-use`, `packages/computer-use` | opt-in | No service row in any bundle; browser, computer providers experimental |
| Agent team | `packages/experimental/agent-team` | experimental | Roster, task board, mailbox over continuable subagents |
| Other carriers | `packages/sdk`, `packages/acp`, `packages/bundle/headless`, `apps/desktop` | opt-in | Thin overlays on base; Desktop is Electron bundling runtime and web app |
| TUI | `.agents/notes/archived/simplification/2026-08-04-remove-tui-package.md` | removed | `packages/ui/tui` deleted; stale comments still name it |

## Mechanisms worth knowing

- **Two composition planes**: the HOST plane (bundles) owns registries, sandbox and approval, persistence and the model route; the AGENT plane is a per-session preset, one `agent.cordis.yml` adding tools, persona and prompt sections. Only web-app mounts `dsh-agent-presets` (`default: standard`) and disables base's tool rows; headless, sdk and acp keep base's process-wide tools. `packages/bundle/web-app/cordis.patch.yml`, `packages/bundle/headless/cordis.patch.yml`
- **Profiles and layering**: five ship (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`): compositions, not protocols; Electron owns a reserved sixth. Layers land on an empty list: bundles in order, profile patch, home patch, `--patch`. A patch targets a row by id and replaces its WHOLE config; row order carries no load semantics. `dsh --profile web --dump-config` prints it. `docs/architecture.md`, `packages/bundle/base/cordis.patch.yml`
- **Isolate-realm rule**: a preset row publishing a service must sit in a `cordis:group` with an `isolate` realm, or `dsh-agent-presets` rejects the mount. A service read from OUTSIDE the realm stays on the host, keyed by owner: a realm-scoped jobs registry answered "background jobs unavailable". `packages/preset/agent-presets/presets/standard/agent.cordis.yml`, `packages/bundle/web-app/cordis.patch.yml`
- **Preset table**: the roster is the directory listing; a user preset carries "the same trust as shell access". `packages/preset/agent-presets/presets`, `packages/bundle/web-app/cordis.patch.yml`

| Preset | Contents |
|---|---|
| `minimal` | Complete fixed persona, one persistent PTY shell tool in an isolate realm, no compaction |
| `standard` | Web default: one-shot shell, fs, jobs, skills, goal, plan, compaction, delegation, workflow, todo, web, present |
| `cordis` | Creator: standard plus read-only `tool-cordis` and Plugin Manager tools, each call approved |
| `ptc` | Standard minus workflow rows plus `tool-presentation` (`run_code`) |

- **Package direction rule**: "Extension plugins depend on Service Definitions, never concrete providers"; the loop is swappable, so UI, hook and tool plugins depend on `dsh-agent`; bundles may depend on spine plugins; the module graph is generated and CI-gated. `packages/README.md`
- **Three-role seam**: Service Definition (a `ctx` key), Service Provider, Consumer (often a model-facing tool); "one role alone is not a seam". fs and subprocess providers share one execution world, so one swap moves Bash, PTY and LSP. `docs/architecture.md`, `AGENTS.md`
- **sdk-minimal floor (minimal-but-complete upstream)**: 32 rows, no `dsh-base`: JSON-RPC server, llm with DeepSeek adapter and retry, session, JSONL persistence, projection, tools, system-prompt, agent, agent-loop, sandbox and policy, subprocess, one PTY shell tool, jobs, mcp-resources, five invariant rows. Absent: approval, fs tools, compaction, storage, settings; `mode: danger-full-access`. `packages/bundle/sdk-minimal/cordis.patch.yml`
- **Durability limits**: "Model-visible means logged" is a runtime invariant. Process loss before settlement "leaves no durable attempt stream"; tail repair "remains a handle consumer responsibility". `docs/architecture.md`

## Why it matters to MiniDSH

- **Mapping**: `composition.json` layers are the host plane, `agentPresets` the agent plane. Classify each of the 18 service keys by lifetime (process, session, agent) before a preset may touch it. The dependency gate is the direction rule as an import lint; hold the 35 rows against sdk-minimal's 32.
- **Falsified beliefs**: two planes are web-only upstream; the MCP bridge is not "shipped disabled" (`mcp-resources` is live; no client row); model-written extensions became read-only discovery plus Plugin Manager installs, though `packages/README.md` still says "model-written mount/unmount"; `packages/terminal` is a PTY, not a TUI.
- **S14 Durable execution I**: no upstream oracle: DSH loses an unsettled attempt and leaves tail repair to the consumer. The one-execution-world seam says fs and shell providers own the effect record.
- **S15 Authority II**: one mode (`DSH_PERMISSION_MODE`) fuses sandbox level and approval policy, and the minimal floor ships no approval row; MiniDSH keeps shell-enforcement acceptance a separate knob. Transferable: Creator's single-call approval "does not change the session permission mode".
- **S16 Durable execution II**: adjacent migration packages (`packages/session/session-format-v2-to-v3`) are the format-evolution oracle; inspect/verify, shipped replay and salvage have none here.
- **S17 Jobs**: the owner-keyed host registry confirms `core/jobs`; PTY state dies with the process, so never log a held process as resumable. Job brackets across turns and a control-plane wire tier: no oracle here.
- **S18, S19, S20**: web search is default-on behind named providers (`packages/web/web-search-exa`); MiniDSH stays opt-in. `packages/llm` ships only `llm-deepseek` and `llm-pi-ai`: no Responses or Tavily oracle. Catalog-as-user-message and a CDP pipe have no oracle here.
- **S21, S22**: agent-team is experimental. Desktop is a carrier, not a thin client: it bundles its exact runtime. One launcher: `scripts/verify-application-entrypoints.ts` rejects a bin that bypasses `dsh`.

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `docs/architecture.md` | Profiles, layering, launch rule, seam roles, log, desktop | 2026-09-19 |
| `packages/README.md` | 54-group table, direction rule, stability tiers | 2026-09-19 |
| `AGENTS.md` | Launch rule, Cordis peerDependency, seam completeness | 2026-09-19 |
| `docs/subsystems/README.md` | Index of subsystem pages: where to read next | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Host default rows, disabled rows, patch semantics | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Disabled base rows, default preset, host-plane rule | 2026-09-19 |
| `packages/bundle/sdk-minimal/cordis.patch.yml` | The smallest complete tree | 2026-09-19 |
| `packages/bundle/headless/cordis.patch.yml` | Thin overlay, no presets (same for `sdk-app`, `acp-app`) | 2026-09-19 |
| `packages/preset/agent-presets/presets` | All four `agent.cordis.yml`: rows, realms, trust | 2026-09-19 |
| `.agents/notes/archived/simplification/2026-08-04-remove-tui-package.md` | TUI deletion (history, not contract) | 2026-09-19 |

## Likely to go stale

- Row sets of presets and base: composition YAML changes weekly (commits touched `minimal` on 09-03 and 09-08); self-modification and desktop moved days before the pin.
- Preset mount cardinality: `standard` says mounted once under a standing scope, `ptc` says one instance per session.
- Upstream comments lag: presets name `base.cordis.yml`; web-app names a TUI and `apps/cli/src/web.ts`, both absent.
- Profile count: `packages/experimental/agent-team-profile` exists and may graduate.

## Not read

- The 149 notes in `.agents/notes/implemented/architecture` (filenames only), e.g. `2026-08-10-host-plane-ownership-after-presets.md`.
- `docs/agent-lifecycle.md`, `docs/glossary.md`, `docs/session-format-status.md`, `docs/persistence-catalog.md`.
- `packages/identity` (no row in any bundle), `packages/context`, `packages/workspace`, `packages/typert`, `packages/feedback`.
- The desktop profile's composition; the code in `packages/preset/agent-presets` that rejects a realm-less row.
- Tree only: `packages/skill/skill-office`, `packages/experimental/ptc-runtime-python`.
- Release notes; commit history before 2026-09-17.
