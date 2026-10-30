# What MiniDSH believes about DSH: the ledger

> Every row rerun at `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, `dsh-v0.2.1-rc.3`) in S20.5 (2026-10-25); S21 reran the execution rows and the four it added at `ce7073d5` (2026-10-29, `dsh-0.2.1-rc.5`). See [the reading rules](README.md).

Each claim a MiniDSH document leans on is a row with its verdict when last checked. After a `falsified` or `partly`, the document in the last column says the corrected thing or stops saying it; a row that no document, or only the BP §4 record, leans on is deleted. Verdicts: `confirmed`, `partly` (true, with a correction that matters), `falsified`, `unverifiable`. ARCH, BP, PROJ = `docs/ARCHITECTURE.md`, `docs/BLUEPRINT.md`, `docs/PROJECT.md`; a bare source path is under `packages/`.

## Composition, presets, surfaces

| Assumption | Verdict | What is true at the pin | Source | Leaned on in |
|---|---|---|---|---|
| The `minimal` preset is shell-only | partly | Persona and one PTY group, plus image-only `tool-fs` and compaction since 2026-10-12; presets are rows under `bundle/web-app/presets/` | `bundle/web-app/presets/minimal.patch.yml` | PROJ §5, README |
| DSH ships five protocol profiles | partly | Five COMPOSITION profiles; `sdk`/`sdk-minimal` share one wire; Electron reserves `desktop` | `docs/architecture.md` | README |
| DSH deleted its TUI | confirmed | None ships; `packages/terminal` is a PTY for model tools | `apps/cli/README.md` | ARCH §12, README |
| The desktop app is an Electron client of the same runtime | partly | Same code, not a thin client: a RunAsNode child runs the `desktop` profile on an OS-assigned port; the window forwards to it | `apps/desktop/README.md` | PROJ §8, BP §2 |
| No lower-bound attach cursor upstream | confirmed | `follow()` opens with a tail page; `page()` takes upper bounds only | `api/session-controller/src/history.ts` | ARCH §8 |
| DSH keeps per-follower copies, unbounded queues, and the trace tier in pages | partly | Uncapped per-follower queues of REFERENCES; no trace tier: a page holds every event up to the client's `maxMessages` (Host default 50, no maximum) | `api/session-controller/src/history.ts` | ARCH §12 |
| Approvals nobody can see stay pending forever upstream | partly | Web: an unseen one waits, with no timeout, for the next owner client; headless, SDK and ACP with no answerer get `unavailable` | `api/gateway/src/index.ts` | ARCH §12, README |
| DSH has 363 packages in 52 groups (2026-10-23) | confirmed | Regenerated with each package change | `docs/module-graph.md` | README |
| DSH's SDK wire is newline-delimited JSON-RPC | confirmed | Over stdio: seven requests, opt-in server requests, five notifications; no fork | `sdk/protocol/README.md` | ARCH §12, README |

## Session log and durability

| Assumption | Verdict | What is true at the pin | Source | Leaned on in |
|---|---|---|---|---|
| There is no session deletion upstream | confirmed | No deletion or retention API; the archive is a visibility write that first stops a session's turns, jobs, subagents and schedules | `session/session-persistence/README.md` | BP §2, README |
| DSH derives model-visible history from the log | confirmed | `Session.deriveMessages()` folds surface events; log-only kinds add nothing | `docs/subsystems/session.md` | README |
| `session-query` is mounted by no shipped composition | falsified | Base mounts `session-query-sqlite` (search off); its five model tools are experimental (`session-search`) | `experimental/tool-session-query/README.md` | README |
| A gate-to-body fact exists upstream | falsified | `tool/call` is appended at a call's start, before policy and the ask, so a crash mid-consent reads `TOOL_OUTCOME_UNKNOWN`; the one dispatch pair brackets PTC sub-calls | `core/tools/src/batch.ts` | ARCH §12 |
| Upstream records no effect of a call | partly | A log-only `workspace/changes {turn}` marker per top-level turn; nothing per call | `deliverables/workspace-changes/README.md` | ARCH §12 |
| Upstream repair reaches the whole unfinished log | falsified | ONE tail step; turn, step and tool events only; a job bracket is never closed | `core/session/src/repair.ts` | ARCH §12 |
| A child can be joined back to its delegating CALL | falsified | No structured join: `subagent/catalog` carries no call id; only the call's result text names the child | `subagent/subagent/src/catalog.ts` | ARCH §12 |
| Replay binds a child by first-call order upstream | confirmed | Keying deferred "until such a scenario exists"; the one parallel snapshot is ordered by barriers | `test-support/llm-replay/README.md` | ARCH §12 |
| DSH formats are additive like MiniDSH's version 0, and a log names its writer | falsified | Immutable generations v0..v4, frozen migrations, checksummed zstd frames, an unknown kind refused unless `ignorable`; no writer named | `docs/session-format-status.md` | ARCH §12 |
| DSH mounts a projection store by default | confirmed | A registry plus a rebuildable cache in base | `bundle/base/cordis.patch.yml` | BP §3 |

## Execution, jobs, delegation

| Assumption | Verdict | What is true at the pin | Source | Leaned on in |
|---|---|---|---|---|
| The inbox is the only queue; a producer never starts work its owner cannot collect | confirmed | The registry "neither queues nor preempts"; `start` refuses without a live owner; no second message queue anywhere | `docs/subsystems/jobs.md` | ARCH §3 |
| Upstream's parallel batch is the one scheduler, everything else refuses rather than queues | confirmed | No run queue, fairness or priority; jobs (10 per owner) and activations (8 per tree) refuse | `core/tools/src/batch.ts` | ARCH §12 |
| Per-call `isConcurrencySafe`, results committed in model order | confirmed | Only an exact `true` joins a rolling pool (10), every shipped one `() => true`; policy, asks and results stay in model order | `core/tools/src/batch.ts` | ARCH §12 |
| The one-shot foreground child is upstream's default delegation | falsified | Every child is an activation that returns an id at once and settles into the parent's inbox | `docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md` | ARCH §12 |
| A continuable child upstream is a durable session with its own inbox, never a job | confirmed | A Session plus at most one resident activation; settles as an unbudgeted notice; past 8 live children admission refuses; job-backed children were dropped for it | `subagent/subagent/README.md` | BP §3 |
| DSH re-applies a child's descriptor on cold resume, from the parent's CURRENT composition unless a preset was selected | confirmed | A new descriptor holds provider, label and route; persona and tools come from the preset | `subagent/subagent/src/manager.ts` | BP §1 |
| Upstream jobs leave no record, and a resume learns what was lost | falsified | `job/registered`/`job/settled` persist; a missing settlement "remains incomplete": no `lost`, no notice | `jobs/jobs-local/README.md` | ARCH §12, README |
| Upstream brackets a child in the parent's log | partly | `subagent/start`/`end` are live only and `subagent/catalog` unpaired; workflow runs and jobs are bracketed | `docs/persistence-catalog.md` | ARCH §12 |
| Waking is budgeted and the jobs idle race is fixed | falsified | Unbounded by default since 2026-09-22; the retirement-window race is still open; a child's settlement is never budgeted | `jobs/tool-jobs/README.md` | ARCH §12, README |
| A parent's Stop does not reach its running children upstream | confirmed | Web Stop is `agent.cancel({kind:'user'},{keepInbox:true})` on the parent only; children run on and later wake it | `api/session-controller/src/commands.ts` | ARCH §12 |

## Authority

| Assumption | Verdict | What is true at the pin | Source | Leaned on in |
|---|---|---|---|---|
| Upstream's consent shows model prose, with no structured subject oracle | partly | The request omits arguments; `presentCall` serves UIs only, so only a shell ask shows its command | `interaction/user-approval/src/types.ts` | ARCH §12, README |
| Upstream cannot express accepting unconfined execution | confirmed | `SandboxEnforcement` is `full \| partial`; win32 reports `partial` silently | `docs/subsystems/sandbox.md` | ARCH §12, README |
| A delegated child's authority is an enforced ceiling upstream | falsified | A seeded pin that "later child switches still win"; only DEPTH is enforced | `subagent/subagent/src/child-agent.ts` | ARCH §7, §12, README, SECURITY |
| The Windows backend is permanently `partial`, with a hard-link escape | partly | Restricted token plus per-root ACEs and a Low label; `partial` for hard links and unconfined reads; refuses extra roots | `sandbox/sandbox-windows-acl/README.md` | ARCH §13, README, BP §2 |
| Standing grants are deferred upstream | partly | For tools the only grant is `allowed-once`; experimental computer use alone keeps grants per verified application | `experimental/cua/README.md` | ARCH §12, SECURITY |
| Four confinement backends, each probed even alone | partly | Linux `[bwrap, landlock]`, darwin `[seatbelt]`, win32 `[windows-acl]`; only the Linux chain is probed | `sandbox/sandbox-local/src/index.ts` | ARCH §12, README |
| MiniDSH adopted DSH's bubblewrap profile flag for flag | confirmed | `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`; `workspace-write` adds `--tmpfs /tmp` and a `--bind` per root | `sandbox/sandbox-local/src/profiles.ts` | README |
| DSH writable roots add the temp roots | partly | `/tmp` and `os.tmpdir()` (bwrap: a tmpfs `/tmp`); since 2026-10-18 operator-named `additionalWritableRoots` bind on POSIX, and win32 refuses them | `sandbox/sandbox/src/roots.ts` | ARCH §12, README |
| Upstream withholds credentials from a child by declared name | falsified | Drops names matching `/KEY\|PASSWORD\|SECRET\|TOKEN/i` and `DSH_*`, keeps the rest | `subprocess/subprocess/src/index.ts` | ARCH §12, README, SECURITY |

## Skills, extensions, web, attachments, providers

| Assumption | Verdict | What is true at the pin | Source | Leaned on in |
|---|---|---|---|---|
| Model roles are not an upstream seam | confirmed | `purpose` maps only to transport metadata; the session route is durable (log-only `model/selection` per Agent, kept on resume) | `core/agent/README.md` | ARCH §12, README |
| A direct DeepSeek adapter plus one generic adapter, none first-party for OpenAI | confirmed | `llm-deepseek` behind the api-key and account routes; `llm-pi-ai` (1.3.0) is the only way to OpenAI; foreign thinking is dropped | `llm/llm-pi-ai/README.md` | PROJ §9 |
| A source snapshot is how model facts are known | falsified | Both DeepSeek routes follow `GET /models` on the official origin (the api-key route since 2026-10-22); pi-ai reads its installed registry | `llm/llm-deepseek-api-key/README.md` | ARCH §12 |
| An unknown DeepSeek id passes through text-only at the full window | confirmed | Text-only, 1,000,000 window, 256,000 cap, all four efforts | `llm/llm-deepseek/src/model-info.ts` | ARCH §12 |
| `deepseek-flash` is the shipped default; `deepseek-v4-flash` was left undeprecated | confirmed | Base sets `deepseek-flash`; `deepseek-v4-flash` stays the default of `acp-app` and the SDKs | `bundle/acp-app/cordis.patch.yml` | ARCH §13, README |
| Upstream presents a session to providers | confirmed | pi-ai sends `prompt_cache_key` = the session id; `llm-deepseek` sends user and session ids and, by default, the whole log (`dsh_session_log`) | `docs/deepseek-llm-api-wire-extensions.md` | BP §3 |
| Model-written extensions have no boundary | partly | No model tool creates `node:vm` definitions; `plugin_manager` installs persistent in-process bundles behind full access or an approval, in Standard (2026-10-21) and Creator | `boot/plugin-manager/README.md` | PROJ §4, BP §2 |
| Image bytes are stored beside the session | partly | Content-addressed under `<DSH_HOME>/attachments/v1` (home-global), fsynced before the event, never deleted | `attachment/attachment-local/README.md` | ARCH §5, README |
| Attachments are images only | falsified | `FileAttachmentRef` exists: bytes, projected to the model as one path handle | `attachment/attachment/src/types.ts` | BP §3 |
| DSH gives workspace skills top precedence with no trust gate | confirmed | Project `.dsh/skills` and `.agents/skills` outrank every other root; `SAFETY.md` never mentions skills | `skill/skill-filesystem/src/index.ts` | ARCH §12 |
| Upstream lists skills behind a dedicated tool | confirmed | A name-and-description reminder re-digested every step; a body loads only through `skill({name})`, mandated before acting | `skill/tool-skill/src/index.ts` | ARCH §12 |
| A user's `/name` injects a skill's body upstream | confirmed | The body enters as a `skill-invocation` message; a `disable-model-invocation` skill is reachable only so | `skill/tool-skill/src/index.ts` | BP §3 |
| Document skills are scripts over bundled interpreters | partly | Seven instruction-only skills over a bundled Python and the LibreOffice Kit CLI; no PDF skill; Desktop and SDK only | `skill/skill-office/README.md` | ARCH §12 |
| Upstream ships a default, fenced browser | falsified | Experimental, in no bundle; Stagehand runs Chrome on `--remote-debugging-port=0` with `--remote-allow-origins=*`; no network, download or `file:` rule | `experimental/browser-use-stagehand-native/src/launch.ts` | ARCH §12 |
| Web search and fetch are default-mounted and ask no consent | confirmed | Base mounts both; no mode or approval gates them; a route without a credential is not offered them (2026-10-22) | `docs/subsystems/web.md` | ARCH §12 |
| Upstream search results are structured sources behind a fixed notice | partly | Structured sources, but the model sees ONE prose block (notice, answer, `Sources:` lines); the list reaches only `meta` | `web/tool-web/src/search.ts` | ARCH §12 |
| The fetch guard pins every hop to validated addresses | falsified | No guard since 2026-10-20: fetch reaches loopback, private and metadata hosts | `web/web-fetch-http/README.md` | BP §3 |
