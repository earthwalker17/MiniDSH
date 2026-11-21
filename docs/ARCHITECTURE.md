# MiniDSH Architecture

One runtime composed from plugins over a tiny kernel. Everything the model sees derives from an append-only session log; everything it does goes through one guarded tool pipeline, fenced at the effect boundary by an authority the log records. The model is a capability the runtime routes to, not the agent. Every surface only renders the log, and a session survives its process.

This is the map: what each layer owns and must not own, and where a new thing goes. Usage is in `GUIDE.md`, a code tour in `src/README.md`, history in `CASE-STUDY.md` and `BLUEPRINT.md` §4. DSH is DeepSeek Harness (§12). Code comments cite section numbers, which are stable.

## 1. Layers and dependency direction

`scripts/check-deps.ts` enforces each rule here. **Direction** (a whitelist, `scripts/deps-graph.ts`):

| from | may import |
|---|---|
| `kernel` (§2) | nothing internal |
| `core/<x>`: Definitions + default drivers (§3) | `kernel`, other `core`; **`core/loop` only by `app` and `test-support`** |
| `capabilities/<x>`: providers + consumers (§3) | `kernel`, `core` except `core/loop`, itself; never another capability |
| `app`: assembly + surfaces (§14) | anything |
| `test-support` (§14), `*.test.ts` | anything |
| `desktop/src` (§8) | `electron`, `node:*`, itself: never `src/`, `dist/` or `minidsh` |

In `kernel`, `core` and capabilities a non-literal `import()` or a path out of `src/` fails. **Payloads** are read via `matches(event, KIND)`, never a type assertion on `event.data`, outside tests. **Core is acyclic at file level**: each package's `events.ts`/`types.ts` sits below its service. A capability is a directory, not a package; the browser client shares only the wire with the host.

## 2. Kernel (`src/kernel`)

Five mechanisms (`kernel/index.ts`).

- **Context and services.** `child({scope?})` derives a scoped context. `provide` is an effect, one claim per key per realm (a plugin's context shares its mount's); `get` needs the key `inject`ed or self-provided.
- **Plugins.** `pending` until every injected key is provided, and a replaced provider reloads its dependents. A plugin admits a registration only while loading or active (`INACTIVE_OWNER`); a failed load and every disposal unwind whatever is listed. Effects unwind before dependents unload: **a disposer must not read the services its plugin injected** (`kernel/context.ts`).
- **Events.** A token carries its dispatch mode (`kernel/tokens.ts`); a waterfall's `next()` is single-shot; `observe` runs before any listener. A dispatch reaches unscoped and `global` listeners plus its own scope's, so an agent-scoped listener hears `session/*` or `llm/stream` only with `global: true` (`kernel/bus.ts`).

**Scope contract** (`core/scope.ts`). Registration context = visibility = lifetime: a view is the globals plus one agent layer, a local entry shadows a global, nothing is inherited between scopes. An agent's operation events dispatch in its scope (`agent/*`, `tools/*`, `approval/request`, `system-prompt/assemble`, `fs/*`); `llm/stream` and `session/*` are unscoped. Deployment-global registries (`llm`, `invariants`) refuse a scoped owner. Consumers get the agent as subject, never services via `agent.ctx`.

## 3. Core contracts (`src/core`)

Nineteen service keys: eighteen `core` (below) + app-only `app-composition`; `loop` is a plugin, not a key. A seam needs all three roles: Definition (core), Provider (capability), Consumer (capability, usually a tool). Agent id = session id.

| ctx key | owns | must not own |
|---|---|---|
| `sessions` | `Session`: header + append-only log + surface (§4); `repairInterruptedTail` | persistence backends, UI state, model |
| `persistence` | READ Definition: `load(id)` → the readable prefix (`damaged?`, `lease`); `durability`, the flush guarantee it declares (§4) | the write path (the provider's); repair; deletion |
| `credentials` | `CredentialRef`: a validated env-var NAME, the only thing config, logs and errors carry; resolved per call; the `declare`d refs are the secrets (§9) | storing or logging values; which layers exist |
| `presets` | key `authority-presets`: `presetTable`, pure `presetFor`, the log-only `authority/preset` intent (§7) | enforcement; knobs; a `defaultPreset` |
| `llm` | the provider-neutral vocabulary and a deployment-global adapter registry (§5); `stream`, the `llm/stream` waterfall | API keys, session state, default model |
| `tools` | `restrict` (subtractive, by name or `tags` KIND) through the one resolver: a hidden tool is unknown to the model and refused if called; `ToolCall.onDispatch` and the pipeline (§6); `display`, a surface's card, read by no runtime path | policy |
| `prompt` | ordered named sections + strict `{{var}}` variables in STRING sections; `assemble(agent)` → `system-prompt/assemble`; sections stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request` → `allowed-once \| rejected \| cancelled \| unavailable` (default `unavailable`); the model-written `reason` neutralized and clamped before the log, `subject` its trusted half; `ApprovalPolicy` `ask \| never`; `grants`/`revoke` (§7) | answer logic; model-facing prose; a public `grant` |
| `fs` | `fs/edit-intent` (read-before-edit) and `fs/observed`; **fences every mutation**, reads always pass (§7); `readBytes` emits no observation | tool schemas; policy itself |
| `shell` | `sessionFor(agent)` → `ShellSession`; `exec` reports the `enforcement` it got and REFUSES what it cannot enforce (`SANDBOX_UNAVAILABLE`) unless the call `accepts` it (§7); optional `start` (a job's process), refused alike | model-facing descriptions; negotiation; a job's lifecycle |
| `sandbox` | the authority stamp (`SandboxMode`, `sandbox/mode`); the pure `writableRoots`/`allowsWrite` every fence derives from; the ACCEPTANCE knob (`sandbox/acceptance`). All §7 | enforcement backends; what any tool may do; **what the model is told of it** |
| `compaction` | `compactNow(agent)`; its log-only bracket (§4); PURE `planCompaction` (the pairing rule, §6) | threshold, summary, trigger |
| `attachments` | content-addressed `AttachmentRef`; **an image is validated and durably committed before its event** (§5) | normalization; retention; who may look |
| `spill` | output with NO OTHER HOME: `save` → a path, `open` streams a job's; head/tail excerpt renderers | threshold (each tool's own) |
| `jobs` | owner-scoped background work: identity, admission (a cap), ONE terminal fact (first-wins), delivery through the owner's inbox (§4); each job's output tail and capped spill file | processes (the producer's), wire state, a queue or scheduler |
| `settings` | REMOTE-writable defaults, written under `expectedRevision` (§8); `settings/changed` | store; authority; composition; anything a resumed session recorded |
| `agents` | **Creation is a TRANSACTION** (`core/loop/factory.ts`): `world` → narrowing → `setup` unpublished, published, then a continuer's `opening` before any wake; a failure rolls back. `resume` = `load` (refusing `damaged`) → `repairTail` → seed → that transaction, under the header's preset, a child's stamps (§7); `fork` may `salvage` a damaged prefix; `configure` switches the base route (§4) | driver |
| `invariants` | `register`: deployment-global, config-selected, validating pre-commit via `observe` | product logic |
| `loop` | the driver and the agent factory (§6): each lifecycle's opening facts (§4), `Agent.own` work joined at disposal | anything extensions do; a queue or scheduler |

## 4. Canonical facts: the session log

The log is the single source of truth: `{type, seq, time, data}`, `seq === log.length`, frozen at append.

- **Three tiers** (`core/session/types.ts`). **Surface** kinds (`user/message`, `assistant/message`, `tool/result`) carry `surfaceOp` and `sourceEventSeqs`; model history is their fold. Every other kind is log-only: a **fact**, or **trace** if nothing folds it at runtime; folds walk `Session.facts`, the log without its trace. An arriving `user/message` sits in an open turn; a range REPLACE may land between turns (`core/session/invariant.ts`).
- **Vocabulary: 35 kinds**, by owner. session: `turn/start|end`, `step/start|end`, `user/message`, `assistant/chunk|message`, `tool/call|dispatch|result`, `request/header|context`, `session/title|end-seed|lifecycle`; agent: `agent/options|narrowing`, `inbox/spliced`, `subagent/start|end` (the PARENT's log); `approval/asked|decided|grant|policy`; `sandbox/mode|acceptance`; presets: `authority/preset`; `compaction/start|applied|end`; `effect/recorded`; `job/start|end`; `llm/aux-call`; `composition/applied`.
- **Format** (`core/session/format.ts`): the header's `version` alone; a writer continues its own format, forks an older one, refuses a newer one (`SessionFormatError`, not damage). A change an older reader meets conservatively is a note there, never a bump.
- **Every lifecycle opens with `session/lifecycle`** (`core/session/invariant.ts`): `dispatch`, `durability: 'synced'`, `salvage`. Readers use its claims, never its presence (`core/session/types.ts`).
- **The route is one fact in two records.** `agent/options` is the BASE; `request/context` the EFFECTIVE route, window and modalities per step (§6); a role rewrites header and context, never the base. Both `request/*` are written only on change, so a field added to one reads as absent where never rewritten (`core/loop/driver.ts`).
- **The header** is immutable identity and lineage: fork, `delegatedByCallId`, `agentPreset`. **Opening facts** land before publication: `agent/options`, `approval/policy`, `sandbox/mode` (each `initial`), `composition/applied`. **`agent/narrowing` is written once, in the first lifecycle's opening, and re-applied by every lifecycle** (`core/agent/events.ts`).
- **The durable inbox** is `inbox/spliced`, op-shaped (`core/agent/events.ts`): a claim commits after the messages it entered, so a crash re-delivers, never loses; a refused step leaves none pending, and a turn its DISPOSAL stopped forgets it, the log still owing the prompt (`core/loop/driver.ts`). A job's end notice is never consumed unseen (`Inbox`). A resume wakes iff a WAKING insert was restored, a fork never (`core/loop/factory.ts`).
- **A job is a bracket outside every step** (`core/jobs/events.ts`): `job/start` once spawned, `job/end`, then its notice, only through the inbox.
- **Crash repair closes everything the log left open** (`repairTail`, `core/agent/repair.ts`): resume and cold fork run a STATIC list, innermost first: a delegation (`subagent/end{interrupted}`), a compaction, the turn, jobs LAST (`job/end{lost}`, a QUIET notice). Closers are pure and state only what the log proves.
- **A synthetic result states the evidence** (`classify`, `core/session/repair.ts`): `TOOL_NOT_STARTED` only for a call with no `tool/call`, or with no `tool/dispatch` and no recorded effect under a lifecycle claiming `dispatch` and `synced`; any other owed call, and any under salvage or a live writer (`heldByWriter`), is `TOOL_OUTCOME_UNKNOWN`, naming its recorded effects.
- **An effect is recorded by the code that caused it, after it happens** (`core/effects/events.ts`): `fs-local` and `shell-stdio` append `effect/recorded{fs-write | shell-command}` by `callId`. **Presence is proof; absence proves nothing.** No exactly-once.
- **A `session/event` listener may not append synchronously**: the JSONL writer refuses the early event and fails every later flush; the wire still sees it early. Queue a microtask (`core/session/store.ts`).
- **Model-visible ⟺ logged.** Every request equals `deriveMessages()` plus the folded `request/header`; checked at `llm/stream` preflight (`core/loop/invariant.ts`).
- **Logged text is well-formed UTF-16.** A lone surrogate becomes U+FFFD where a message is built (`core/llm/content.ts`). `core-session` refuses a live surface event holding one.
- **Persistence is a subscriber** (`persistence-jsonl`): `sessions/<id>.jsonl` (§9) under ONE writer: a `.lock` lease, reclaimed only from a provably dead holder on this host and platform; **reads never lock**. A torn final line moves to `.torn`; deeper corruption is `damaged` and refuses attach. **A resolved `session/flush` is on stable storage** (`durability: 'synced'`); a failed write or sync fails every later flush.

## 5. LLM vocabulary and the adapters

`core/llm/types.ts` is the provider-neutral vocabulary: closed `ContentBlock` and `StreamChunk` unions, `LlmFailure` (policies route on `code`, never message text) and DISJOINT `TokenUsage`.

- **Adapters** register on `llm` (§2): `llm-deepseek` (Chat Completions), `llm-anthropic` (Messages), `llm-openai` (Responses, `store: false`).
- **Refuse before I/O, never degrade.** An option or modality the provider cannot honour fails an `UNSUPPORTED_*` code, never dropped, aliased or clamped: the logged request is the served one.
- **Replay state reaches only its writer.** A signing provider's `ReplayEnvelope` is stripped for any other provider inside the `llm/stream` terminal continuation (`core/llm/runtime.ts`); OpenAI's encrypted reasoning replays only to the model that wrote it, foreign reasoning dropped, never forged (`llm-openai/serialize.ts`).
- **Retry is a capability** (`llm-retry`, on `agent/request-error`), so failed attempts stay durable.
- **Images: a reference plus a STORED descriptor** (`core/llm/content.ts`), committed before its event. **Refuse at admission** (`core/llm/admission.ts`, every producer, the STEP's route first), **substitute at projection** (a text-only route gets `block.text`); lost bytes fail `ATTACHMENT_UNREADABLE` (§13).
- **A catalog is a dated source snapshot, never fetched**, held to the provider by each adapter's live drift probe (`catalog.e2e.test.ts`; OpenAI's holds efforts only). An unknown id gets conservative facts and no output cap of ours (§13 for Anthropic).
- **One wire** (`core/llm/wire.ts`) for the adapters and `web_search`: SSE framing, capped bodies, the base-URL rule, the key redacted from every failure.

## 6. The loop and the tool pipeline

One agent driver (`core/loop/driver.ts`); one path from a model's call to a tool body (`core/tools/registry.ts`).

```
followup(m) → next-turn FIFO (wakes)   steer(m) → next-step (wakes)   inject(m) → next-step (no wake)
turn/start
  claim → resolveCallConfig (agent/request, once per step) → request/context when changed
        → agent/pre-step (waterfall: reject | enter{messages})   reject ⇒ turn/end{blocked}
  step/start → user/message per entered message
  prompt.assemble → request/header when changed
  CHECKPOINT → llm.stream(frozen request) → assistant/chunk{attempt}* → assistant/message{usage}
       finish error ⇒ agent/request-error (waterfall) → retry (next attempt, same route) | turn/end{error}
  tool calls, ONE lane in model order: tool/call → CHECKPOINT → tools.execute → [gate → tool/dispatch → CHECKPOINT → body*]
       → tool/result in model order   (* may overlap, below; cancel ⇒ ABORTED_BEFORE_DISPATCH; lost write ⇒ DURABILITY_LOST, none starts)
  step/end → next step while tools owe a request or next-step input exists (≤ maxSteps)
  agent/turn-stopping (serial) → re-read inbox
turn/end{reason} (exactly once) → session/flush → next turn or idle
```

- **No scheduler.** One sequential driver per agent; the inbox is the only queue. **Joined at the step**: a `concurrencySafe` tool's BODY overlaps its siblings', up to `AgentOptions.maxParallelToolCalls` (a child's is a log fact its row sets, bounding the tree); any other call is a barrier. Only the ordered commit appends `tool/result`; readers join by `callId` or cited seq, never adjacency.
- **Durable before every action.** A CHECKPOINT is `session.flush()` (§4). The DRIVER writes `tool/dispatch` through `ToolCall.onDispatch`, awaited INSIDE the `tools/execute` terminal continuation, so a middleware answering without `next()` replaces the body and writes none (`core/tools/registry.ts`).
- **A step never ends with a body running**: a cancel or lost write drains the lane and answers every call it never reached; a LIVE `step/end` over an unanswered call fails (`core/session/invariant.ts`).
- **Pipeline**: validate → `tools/pre-execute` → deny-only guards → `ask` ⇒ `approval.request` → deadline → `tools/execute` (around-middleware) → body → `render` → `tools/post-execute` → `tools/result`. The model sees only `{name, description, parameters}`. Deadline expiry is `TOOL_TIMEOUT`, the body abandoned, not awaited; `timeoutMs: null` opts out, as a `concurrencySafe` tool (`core/tools/types.ts`) and one asking consent in its body (`tool-web-search`) must.
- **Compaction** (`compaction-basic`) on pressure (`core/metering`), overflow or `compactNow`, keeps **the pairing rule**: the kept tail never begins with a `tool/result`; its replacing `user/message` cites every shadowed seq. **The hazard is the await**: `planIsLive` is re-checked with no `await` before the append.
- **Bounded recall** (`tool-history`): `history_read` reads only this session's shadowed seqs, hidden until the first applied compaction; over budget, refused, not truncated.
- **An `agent/pre-step` listener never fills the FIRST step's empty batch**: an empty first step ends the turn (`core/loop/driver.ts`). `AGENTS.md` and the skill list enter so, never as a prompt section (§3), and re-enter at the step after a compaction shadowed them.
- **Jobs** (`core/jobs/index.ts`): only a job's OWN end, with no stop asked for, may wake its owner, under the wake budget (`foldJobWakes`); other ends are quiet. Headless and a child stop their jobs at idle (`app/headless.ts`).
- **Lifecycle** (`core/loop/factory.ts`): `dispose` = cancel → `whenIdle` → owned work → scope unwind (jobs stopped) → agent, then session, detach. **Owned work** (`Agent.own`; the idle `/compact`) runs outside any turn: disposal aborts and joins it, bounded, so its end lands in an open log; a person's cancel and `whenIdle` ignore it.

## 7. Authority

The model proposes, policy decides, the effect boundary enforces.

- **One stamp.** `SandboxExecutionPolicy{mode, workspaceRoot}` resolves per call from `ctx.sandbox`, never caller-assembled; mode governs FILE EFFECTS only. The root is the immutable `SessionHeader.cwd`. `writableRoots(policy)` is a CEILING for `fs` and `shell`: grant less, never more (`core/sandbox/index.ts`).
- **Enforcement lives at the effect, not the gate.** `fs-local` canonicalizes and contains every write in process, refusing `FS_SANDBOX_DENIED` before any effect; reads always pass. It follows symbolic links itself and never acts on an unfollowed one (`core/sandbox/paths.ts`), checks the file it opened, not only the name, and cannot detect a hard link (§13).
- **Untrusted code is the shell's problem.** `shell-stdio/confine/` wraps the spawn: bwrap on Linux, Seatbelt on macOS, none on Windows (§13). Each is PROBED with its real `read-only` profile, and `enforcement` is recorded at agent creation (`enforcementFor`). The bwrap profile is DSH's plus `--new-session`, a masked user runtime directory (bus address withheld) and the row's `expose` re-bound read-only (`confine/bwrap.ts`).
- **Spawn-time binding.** A backend wraps the persistent child once; a durable `setMode` replaces it at its next command. An approved one-shot escalation and a job's process are throwaway children wrapped like any spawn (`danger-full-access` alone runs unwrapped) (`shell-stdio/process.ts`).
- **A record is not a fence.** `effect/recorded` (§4) sits beside the boundary; losing one loses evidence, never containment.
- **The escalation path.** A refusal is a fact with one legitimate move: the SAME command once more with `sandbox_permissions` (strictly wider) and a `justification`, `ctx.approval` consenting to that call. Under a backend a denial reads as a failing command; its words earn a hint, never a classification (`tool-shell`).
- **Consent is to the runtime's record.** An ask's `subject` is an `EffectIntent` (`core/effects/events.ts`) the REQUESTER builds from validated arguments, naming the authority the effect would run under; the model's `justification` stays in `reason`, clamped (§3), never in the subject.
- **Acceptance.** The `enforcement` beside a stamp is a HOST fact; `sandbox/acceptance` is a DECISION, `full` (default), `partial` or `none`, for exactly the mode it names (`core/sandbox/events.ts`). Read per call (`acceptsFor`), it relaxes the shell's REFUSAL, never a backend; the fs fence and ceiling stand. A weakened row default is stamped per confinable mode at a top-level opening (`stampAcceptance`).
- **A consent may outlive one call, never its lifecycle.** `approval/grant` is identified by `toolName` plus the exact subject's `intentKey`: a REPEATED IDENTICAL action, not a policy language. It is live only once its own ask is `allowed-once`, and until any authority event follows (`AUTHORITY_KINDS`) or the lifecycle ends (`session/end-seed`: a resume or a fork asks again) (`core/approval/events.ts`). Only an offer the fold (`openApprovals`) still makes is minted, and headless takes none; `revoke` ends one.
- **Every decision is durable.** The setter IS the event (`sandbox/mode`, `approval/policy`, acceptance, grants): `change` only on change, sandbox `resume` when a resumed host enforces differently; `context-runtime`, never the service, tells the model. Precedence: approved one-shot escalation > recorded fold > composition default. `approval-headless` fails closed (`unavailable`) except under `--approve` or an exact `allow` entry.
- **A delegated child opens under a ceiling.** `tool-subagent` captures the parent's authority and stamps it in `setup`: the mode as a CEILING, approvals pinned `never`, acceptance `strictest(parent, row)` as a PIN. Widening is refused and so is `setAcceptance` on any delegated session; narrowing is legal. A continuation keeps them: one whose seed lacks the opening stamps is refused (`core/agent/index.ts`). What the row NARROWS is the child's `agent/narrowing` (§4): scoping, not the fence.
- **A network tool asks per call and never reaches a child.** A `NETWORK_TOOL`-tagged tool asks consent in its body before any byte leaves, with exact grants (`tool-web-search`); `tool-subagent`'s narrowing hides every such tool from a child by kind (`core/tools/types.ts`; §13).
- **The browser is fenced, not consented** (`tool-browser`, deliberately not `NETWORK_TOOL`, so a child may use it). A harness process over a CDP pipe, never a port; a fresh profile; downloads denied. Chrome itself reaches and resolves only loopback (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`; no other `127/8` address) and row-config `allowHosts`, and loads `file:` only inside the workspace; a canary proves the fence per launch (`fence.ts`, `launch.ts`).
- **A job runs under the stamp its start resolved, never an escalation**, and a `change` of `sandbox/mode` or `sandbox/acceptance` ends its owner's jobs, a start in flight included (`core/jobs/index.ts`).
- **Presets select, the knobs decide.** `authority/preset` is a log-only intent written before `setMode`/`setPolicy` (`core/presets`). A SET of switches is held to a delegated session's ceiling and pins before any lands (`authoritySwitchRefusal`).
- **Consent-by-composition.** A preset-mounted (§9) answerer hears its own agent's `approval/request` (§2) and can auto-approve: code-equivalent trust, every pair audited. It cannot widen enforcement (the fence and shell resolve the global `SANDBOX`) nor reach a deployment-global registry.
- **`core-authority`** (`core/sandbox/invariant.ts`) refuses pre-commit a forged authority fact or subject, a second decision on one ask, a delegated session past its ceiling or pins, a grant naming no open `intentKey`-identical ask, any grant in a delegated session or on a truncated subject, and a decision crediting a grant not live for its exact subject (`GrantFold`).

## 8. Surfaces

A surface injects only `agents` and `sessions` (plus `llm`, `sandbox`, `approval` for catalog and authority), owns transport and process exit, renders from `session/event` and holds no authority state. Headless (`app/headless.ts`) drives core with no protocol host. Plain-text surfaces and the terminal's one cell writer neutralize control characters (`app/present.ts`, `terminal/screen.ts`, `core/text.ts`).

**Protocol** (`capabilities/protocol`; by example: [README](../src/capabilities/protocol/README.md)): JSON-RPC 2.0; one plugin, one host, N carriers. Control methods act only on a LIVE session; a child mid-delegation is read-only to every driving method.

| method | rule |
|---|---|
| `initialize` | catalog, live defaults, workspaces, presets, tool cards |
| `session/resume` | stored: resumed, no prompt; live: returned; owned |
| `session/fork` | live or stored, to an inclusive `atSeq`; owned |
| `session/prompt` | no id creates, and only then takes `cwd`/`workspaceId` and `authority` |
| `session/attach` | subscribes BEFORE the cut; a stored session is re-read per cut; `view`: folds a page cannot compute, nothing pending or running on a cold read |
| `session/page` | beneath the attach cut (a stored session: from that cut's parse) |
| `session/detach` | no id narrows to NOTHING |
| `session/events` | every tier; bounded gap repair; a stored session is re-read per call |
| `sessions/list` | live and stored (live wins) |
| `session/cancel` | `keepQueued` spares the durable inbox |
| `session/compact` | HUMAN command, never a model tool |
| `approval/answer` | first wins; only a connection that may see the session; only an `offer` the fold made |
| `approval/revoke` | ends one grant (§7) |
| `attachment/read` | an image the session's OWN log names, re-verified; no store oracle |
| `job/cancel` | a PERSON stops one job, its notice quiet |
| `control/subscribe` | live-session baseline, then `control.summary` beside the watch set |
| `session/authority` | each switch a durable event (§7) |
| `session/model` | no fields reads; else ONE `agent/options{change}` iff the base changes |
| `settings/describe`, `settings/get`, `settings/set` | `expectedRevision` REQUIRED |
| `shutdown` | refused on a socket unless its carrier says `allowShutdown` |

`session.event` is `{sessionId, event}`, verbatim, no DTO (headless `--json` too); an ask is its durable frame; no protocol version (`frames.ts`).

- **Attach contract.** A message-aligned tail page at a `cursor` (`core/session/page.ts`), never trace (§4); a reconnect re-attaches (no lower-bound cursor). No client folds the surface; a cold read never resumes.
- **Multi-client** (`protocol/host.ts`). A connection owns only its sink, watch set (narrowed by its first attach) and control subscription; a disconnect disposes nothing. An ask parks while a watcher or control subscriber COULD answer, else settles `unavailable`; the browser subscribes to the control plane BEFORE its attach narrows it, so an ask made during a reconnect's handshake parks (`app.js`).
- **One presentation model, two renderers.** `app/web/conversation.js` groups the log into blocks by logged ids for the browser and the full-screen terminal (`blocks.ts`), only growing (`transcript.js`). What the model wrote and the runtime acted on (a command, an edit, a write) is drawn whole, controls blanked, never tidied (`authored`, `blocks.ts`).
- **No composer key answers a consent** (`approval.js`, `tui.ts`, `line.ts`).
- **The terminal** continues sessions only over the wire (`terminal/controller.ts`).
- **`web` is an authority surface** (`app/web.ts`; its sign-in and fence: `SECURITY.md`). **Its `--json` is a supervisor's process contract** (`app/cli.ts`): stdout is one `ready` or one `error{code}` per exit before it. A stop (a signal; under `--json` also stdin's end) refuses a prompt, a resume and a fork at once (`ProtocolConfig.stopping`), cancels every top-level turn, then disposes, each bounded (`WebHostHandle.stop`). `--workspace` roots never overlap the home.
- **The desktop** never imports the runtime: it runs the bundled CLI's `web --json` on a bundled Node (`desktop/src/runtime.ts`). Its cookie rides only its web view's requests, never the jar (`guards.ts`); the Web UI has no preload, the shell overlay is the only desktop API (`main.ts`). Whether work is running is asked of the runtime per action, never by a standing `control/subscribe` (`inspect.ts`). Folders are authority: native dialog only, re-admitted per start (`folders.ts`).

## 9. Composition, configuration and packaging

MiniDSH IS data: composition rows plus disk layers (`app/compose.ts`, `app/config.ts`). Settings and credentials are separate planes; **authority is never configuration**: a recorded event beats any composition default (§7).

- **Home.** Only `app/home.ts` resolves `MINIDSH_HOME` and its paths, handed to plugins absolute, as config.
- **Layers.** built-ins (`compose()`) → app → home `composition.json` → `--patch` files; a patch replaces a row's WHOLE config. Then `withDeployment` (`app/config.ts`; boot and `minidsh config` share it) refills what such a patch dropped (skill roots, the global `AGENTS.md`, the shell's `expose`) and restates each explicit authority flag, which wins over every layer for its key and says so. A disk `plugin` is a builtin name or a module path (§13).
- **Trust.** `composition.json` is code-equivalent trust, never a persistence target; only a MISSING home file is absent, one that cannot be read stops the command. No workspace layer: a repository never says what the harness may do. `minidsh config` flags authority-sensitive rows a layer changed (`app/cli.ts`). An explicit authority flag is a durable switch on every resume or fork, the wire's too (`onContinued`), as its `opening`, before any wake.
- **Skills are data** (`capabilities/skills`): `SKILL.md` directories under user, bundled and repository roots, in that precedence; a repository skill never replaces another. Above the cwd a project root counts only where its marker and that directory are this user's, never at a filesystem root (`ownProjectRoot`).
- **Recomposition.** The spine `{session, llm, tools, prompt, agent, loop, persistence}` refuses removal or reconfiguration while agents are live (`app/compose.ts`).
- **Agent presets.** `agentPresets` mount per-agent worlds on the agent scope, named in the session header so a resume or delegated child composes the same world (§7).
- **Settings.** `agent` defaults: flags → `MINIDSH_MODEL` → `settings.json` → built-ins; a resume keeps the log's route unless a flag overrides it, as `agent/options{resume}` (`core/agent/index.ts`).
- **Defaults.** Authority `workspace-write` + `ask`. A shell child's environment omits the credential refs the mounted rows declared and `MINIDSH_*` (`core/process.ts`; §13). The shell row's `expose` keeps install directories readable under bwrap's private `/tmp` (`confine/bwrap.ts`).
- **Packaging.** npm ships the `scripts/build.ts` emit as a binary, no `main` or `exports` (BLUEPRINT §3). The desktop ships that package beside a SHA-256-pinned official Node, both outside the asar (`desktop/scripts/package.ts`). **Electron main runs no user code**: its fuses, read back from each packed binary (`desktop/scripts/check-fuses.ts`).

**Retention: content is never swept; an affordance may expire.** `spill-local` sweeps spill once at load, never on disposal (a fork inherits its parent's locators).

| store | class | lifetime |
|---|---|---|
| `sessions/` (children too) | content, replay oracle | never removed; owner-only on POSIX if 2.0 made it (§13) |
| `attachments/v1/objects/` | content, by address | never removed |
| `spill/<session>/` | affordance | age-swept at load, `cleanupPeriodDays` (30) |
| `browser/p-*` | affordance | removed at close; a dead owner's at the next launch |
| desktop `userData` | launcher state; folders are AUTHORITY (§8) | kept by uninstall |

## 10. Verification

Tests mount real compositions; only the model is scripted or replayed (`test-support/llm-replay.ts`). E2E asserts the world where one exists.

- **Runtime invariants run in every test and live**; cross-capability claims on the full composition (`app.test.ts`); every reader runs on old real logs (`fixtures.test.ts`).
- **Gates.** A tag publishes only after `check.yml` and an unfiltered `live.yml` passed its commit (`release.yml`; legs: `CONTRIBUTING.md`). A `MINIDSH_EXPECT_*` flag fails the skip it names.
- **Live arcs**: the OpenAI leg, its drift probe and `search` are LOCAL (`live.yml` holds no OpenAI or Tavily key).

| arc | what it proves |
|---|---|
| `live` | SIGKILL mid-call; repair matches cold `verify` |
| `authority` | an outside edit refused; unconfined escalation; no host write confined; `read-only` |
| `composition` | a disk composition's module tool; `settings.json` sets the route |
| `context` | compaction cites the shadowed seqs; AGENTS.md; spill read back |
| `routing` | DeepSeek → Anthropic, one route fact; a `compaction` role; cross-provider replay |
| `delegation` | a child's escalation decided by its pin; resumed over the wire, still narrow |
| `parallel` | delegations overlap, results in model order; replay binds by delegation |
| `verification` | a text-only parent's `view_image` refused; a role-routed child reads the PNG |
| `search` | consent per query; a URL from shown sources; `NETWORK_DENIED` |
| `web` | cookie sign-in; two clients; wire consent; paging to seq 0; socket reset mid-turn |
| `jobs` | an own end wakes the idle owner; a host killed mid-job: `lost`, the model told |
| `skills` | PDF + CSV → `report.docx` by the office skill; an outside reader agrees |
| `browser` | a runtime-only bug seen, fixed, re-verified over CDP; a verifier child's screenshot |
| `desktop` | the INSTALLED app (Windows, local): a fix by clicked approvals; a killed runtime resumed; a quit mid-turn |

**An arc's premise decays silently**: for its ONE separating assertion on model text, ask what a model knowing nothing would answer.

## 11. Where new things go

| New thing | Home |
|---|---|
| model provider | `capabilities/llm-<p>` |
| model-facing capability | `capabilities/tool-<x>` |
| plugin config | strict `Plugin.config` |
| execution world | `fs`/`shell` providers, tools untouched |
| confinement backend | `shell-stdio/confine/` |
| authority knob | log-only event, fold, default (§7), as `sandbox/acceptance` (pin, `auditLines`) |
| authority preset | presets-table entry |
| code-free capability | `composition.json` row |
| user default | `core/settings` if wire-set, else row config |
| secret | `CredentialRef` |
| per-agent bundle | `agentPresets` |
| policy or answerer | `tools/pre-execute`/`approval/request` listener (§6) |
| durable state | event kind (§4) |
| event's human line | `app/present.ts` AND `app/web/rows.js` |
| model context | `agent.inject()`/`agent/pre-step` (§6) |
| model know-how | `SKILL.md` directory: data, never code or authority |
| surface | `app/`, or a §8-contract package (`desktop/`); no semantics |
| terminal key/view/panel | `terminal/tui.ts`, `controller.ts` (wire), `commands.ts` |
| desktop window/menu/lifecycle | `desktop/src/main.ts`; rules in a pure sibling |
| desktop view around the Web UI | `desktop/shell/` overlay (§8) |
| supervising `web` | §8 `--json` contract |
| typed secret | `minidsh credentials set` → `credentials-local` |
| carrier | `Carrier` (`transport-ws.ts`: its tiering rule) |
| named workspace | `workspaces` entry: addressing, not a grant |
| remote client | §8 attach contract |
| per-agent variant | `agent.ctx` (`world` if inherited, else `setup`) or liftable `TOOLS.restrict` |
| kept narrowing | `CreateAgentOptions.narrowing` (§4), never `setup` |
| resumer's switches | `ResumeAgentOptions.opening` |
| delegated child | `tool-subagent` (§7) |
| context management | `core/compaction` provider (§6) |
| context pressure | `core/metering` |
| oversized tool output | `spill`, via the producing tool |
| attachment kind | raster: `attachments-local` probe; else `AttachmentRef`, `ModelModality`, `ContentBlock`, serializers, meter |
| network tool | `tool-<x>` tagged `NETWORK_TOOL` (§7) |
| image producer | `core/llm/admission.ts` → `attachments.saveImage` |
| spawned process | `core/process.ts` |
| second browser provider | `core/browser` Definition first |
| verifier | `tool-subagent` row + `model-roles` entry |
| model role | `model-roles` entry (§4) |
| aux model call | `resolveCallConfig` + `runAuxCall`, never bare `llm.stream` |
| shadowed-history recall | `tool-history` |
| tool KIND | `ToolDefinition.tags` constant, not a name |
| tool card | `ToolDefinition.display` |
| store's lifetime | retention row (§9) first |
| recorded effect | `core/effects` kind (§4) |
| its consent subject | `EffectIntent` (§7) |
| durable pipeline step | `ToolCall.onDispatch` (§6) |
| overlapping tool body | `concurrencySafe` (§6), never its own pool |
| work outliving its call | `jobs.start` with a `launch` |
| agent's out-of-turn work | `Agent.own` (§6), never a detached promise |
| background producer | a world's `start`; a second kind changes `JobKind` |
| session's name | `session/title`, by `session-title` |
| whole-log check | pure `check*Log` beside its invariant; `app/inspect.ts` runs it |
| format change | `core/session/format.ts` |

No row here → an architecture question first.

## 12. Divergences from DeepSeek Harness (the ones that still shape decisions)

Upstream facts and verdicts: `references/assumptions.md`.

- **Substrate.** Own kernel, not Cordis: five mechanisms (§2); one package plus a dependency gate (§1).
- **Concurrency.** Joined at the step (§6) as DSH's batch, but a child is a foreground body a cancel reaches (DSH: an async activation beyond Stop); replay binds a child by its delegating call (DSH: first-call order). Jobs wake bounded; a lost one closed and told (DSH: unbounded, left open).
- **The wire.** DSH's JSON-RPC SDK shape, bounded, unseen approvals settling `unavailable` (§8); `session/resume` returns a live session (DSH: refused as occupied).
- **Consent.** A trusted `subject` and the joined call on every ask (DSH: model prose); exact-subject session grants; accepting `none`.
- **Confinement.** bwrap and Seatbelt, each probed even alone; the bwrap profile is DSH's plus three additions (`confine/bwrap.ts`); no Landlock (a native launcher) or Windows backend (§13); a shell child's scrub by declared name (§9).
- **The ceiling.** The workspace root alone (why: `core/sandbox/index.ts`; DSH adds temp, operator roots).
- **Durability.** A durable `tool/dispatch` after the gate, recorded effects, a write lease and per-lifecycle writer claims on plain JSONL (DSH: no top-level dispatch, no writer named).
- **Delegation and routing.** An enforced ceiling (DSH: a seeded pin); a continuation re-applies the child's RECORDED narrowing (DSH: its descriptor); `subagent/start|end` in the parent's log, repair-closed (DSH: neither); `delegatedByCallId`; model roles over a durable base route.
- **Context.** No tool-result pruner (tools bound output), recall gated, not opt-in (§6).
- **Surfaces.** A full-screen terminal ships (§8; DSH: none in-tree).
- **Desktop.** An official Node beside Electron, RunAsNode off; main's own token exchange, a per-request cookie (DSH: a RunAsNode child over IPC, `dsh-app://`).
- **Providers.** Snapshot catalogs, conservative facts for an unknown id (§5; DSH: live `GET /models`).
- **Web.** One opt-in search tool, consent per query, structured sources, no fetch (DSH: both default, unconsented).
- **Browser.** Default where found, fenced and proved per launch (§7; DSH: experimental, unfenced).
- **Skills.** A listed path read with ordinary tools (DSH: a mandatory `skill` tool); a repository skill never shadows; documents on Node alone.

## 13. Known limitations (current)

**Authority**

- No Windows confinement backend (DSH's is `partial`; refused, BLUEPRINT §2): each command escalates to unfenced `danger-full-access` until a session accepts `none` (§7); a child runs none.
- Windows needs `pwsh` 7; a command reading stdin blocks until its deadline.
- Under an unwrapped persistent POSIX shell a tree kill misses a timed-out or backgrounded command's descendants.
- On Windows a kill-on-close Job per pwsh ends a one-shot's descendants with the call, the persistent shell's with it. WMI, Task Scheduler and break-away escape it, its body is logged at each start (security tooling may flag it), and under Constrained Language Mode it is not applied and the persistent pwsh runs no command (`shell-stdio/process.ts`).
- A job's tree outlives a killed host (SIGKILL, a signalled `serve`, a `web` stop past its bound) except under bwrap and on Windows: `lost`, never re-adopted or killed.
- Confinement fences file writes, not a service a command reaches: the system bus, a docker socket, abstract sockets, loopback. Under Seatbelt, launchd too (`shell-stdio/confine/`; `SECURITY.md`).
- A narrowing replaces the persistent shell only at its next command: what still runs in it keeps its confinement (`shell-stdio/process.ts`).
- Shell output past `maxCaptureChars` is dropped. A one-shot's pipes close with its call, breaking what it backgrounded on POSIX (`shell-stdio/process.ts`).
- **The fs fence races a concurrent process**: a link swapped in mid-write can leave an EMPTY file or directory outside (never content on Linux; best effort elsewhere).
- **A hard link defeats both fences**: an outside inode already linked in is written through; linking one in, or writing its outside path, stays refused (`confine.test.ts`).
- **Parallel children share one checkout**: `fs-local`'s version check orders only this process's `fs-local` writes, not a shell's, a job's or another host's.
- An `fs-local` write truncates, then writes: a failure between loses the old content, unrecorded (`fs-local/index.ts`).
- The editor refuses a file that is not UTF-8. One mixing CRLF and LF is edited byte for byte (`tool-editor/index.ts`).
- `full` is the probe's PROFILE claim, never measured per call; a failed probe leaves its process backend-less until restart.
- Under bwrap a path in the ephemeral `/tmp` is invisible, its denial unhinted; on macOS a tool needing a writable temp escalates.
- Composition changes need a restart; after a live `reconfigure` of `shell` (outside the spine, §9), `enforcementFor` and stamps describe a world no command runs in.
- A module-loaded plugin is arbitrary code, `minidsh config`'s warnings advisory; an installed package reaches seams only by deep path into `dist/` (§9).
- A shell child's environment withholds variables, not credentials (§9; `core/process.ts`): undeclared secrets, `SSH_AUTH_SOCK` and proxies pass; `credentials.json` is readable, the network open.
- A network tool is consented, never confined or recorded (§7); headless, only `--approve` allows one.
- `tool-browser` reaches EVERY loopback service, in any mode and from a child, unconsented and unrecorded (§7), each able to act or relay on its own authority.
- `tool-browser`'s `file:` fence is each page's own: what a popup loads before its close lands is neither paused nor read (`tool-browser/page.ts`).
- On Windows a project marker above the cwd is never owner-checked; only a filesystem root's is refused (§9).

**Context**

- Under DeepSeek's default 1M window only overflow recovery fires unless `budgetTokens` is set.
- Document skills check content, not appearance.
- The compaction budget sizes only the kept tail: a `compaction` role with a smaller window is asked to read past it (`compaction-basic`).
- The meter sees a prompt or tool-set change a step late and charges images on text-only routes.
- Workspace instructions are read once per entry, not watched; an overflow compaction's retried request lacks them and the skill list (`core/loop/driver.ts`).
- An unreadable user or bundled skill root freezes the skill list; no `/name` invokes a skill.
- A notice the wake budget held waits for a human message.

**Sessions and stores**

- The in-memory log keeps trace: 400 turns are tens of MB of heap.
- A long-running host's spill is swept only at restart (§9); a repeated `callId` overwrites.
- A lost attachment is turn-fatal (`ATTACHMENT_UNREADABLE`); image validation is header-only; no client upload; the image bound counts the surface until compaction.
- No session deletion or search index (refused, BLUEPRINT §2), rename or model-written title.
- **Crash repair is as sharp as the lifecycle (§4)**: without `synced`, "not started" holds only for a process crash; under salvage, closers are placeholders and damage between turns is invisible to the model.
- Effect records are no inventory (`core/effects/events.ts`): one may over-report a shell that died between commands or follow an abandoned body's result (§6).
- `synced` is as honest as the disk; Windows cannot sync a new log's directory; after a power cut a zero-filled tail reads torn, earlier zeros damaged (`--salvage`).
- `verify` reads structure, surface messages and its report's folds, no other payload.
- A fork boundary may split a compaction bracket from its replace; `fork --at` refuses one inside an open turn or below a delegated child's opening.
- A dead holder's lease is reclaimed only when provable: never across platforms under one hostname (WSL 2 and its host) and, off Linux, not always after a reboot. Two Linux instances on one kernel, or a pre-2.0 lock across platforms, read a LIVE lease as dead (`persistence-jsonl`).
- A log or `sessions/` directory an earlier version made keeps its wider mode (`persistence-jsonl`).

**Surfaces**

- `session/events` has no host ceiling, RPC deadline or client timeout; backpressure limits are unmeasured.
- A reconnect loses its paging position and a sole watcher's pending approval; only `control.summary` announces disposal.
- Detaching one session narrows an un-narrowed client to nothing (`protocol/connection.ts`).
- A tool with no `display` in reach (a preset's on a cold read) draws the generic card.
- The browser and the desktop have no fork or salvage control; a tab whose cookie went stale shows `Reconnecting…` without saying why (`app.js`).
- The full-screen terminal captures no mouse and loses its screen and scrollback at exit (`tty.ts`); on Windows Shift/Alt+Enter arrive as Enter (`keys.ts`).
- A session a wire client creates, resumes or forks stays live, idle and leased until its HOST exits (no method disposes one session): a CLI resume of it meanwhile is refused as locked.
- An unconfined POSIX shell shares the terminal: a command opening /dev/tty draws over the screen; Ctrl+L repaints (`tty.ts`).
- One principal, no accounts. The browser changes a stored session's route and authority only once a message resumes it (`app.js`).
- `web`'s cookie is scoped to the host name, not the port: any other server on that loopback name receives it, and with a matching `Host` and no `Origin` it opens the WebSocket (`app/web.ts`; `SECURITY.md`).
- `workspaceRoots` bounds only where a session is first CREATED: a wire client may resume or fork one outside them (`protocol/host.ts`).
- The Windows installer's is-it-running check is an exact PowerShell query, then the image name, then nothing where neither answers (`desktop/installer.nsh`).
- A killed or logged-off Windows desktop ends its runtime at once (libuv's Job); the next resume repairs and, the lease rule permitting, reclaims.
- The desktop's four installers carry no publisher signature and never self-update; the two macOS builds ran on CI runners only, the Intel one on an image GitHub will retire (`check.yml`).
- Its per-user install is user-writable (code-equivalent); Help's DevTools show the injected cookie; its runtime inherits `NODE_OPTIONS`; on Windows `credentials.json` keeps its folder's ACL.
- A macOS or Linux GUI launch lacks the login shell's environment; without unprivileged user namespaces an AppImage renders outside Chromium's sandbox (logged), and SIGTERM stops its wrapper, not the app.
- The agent's `node` is the person's own when on PATH (an old one fails the bundled skills), else the bundled one, which with the bundled skills sits under `/tmp` in the AppImage: a bwrap-confined command sees them only through the shell row's `expose` (§9).

**Delegation and providers**

- A child's cost is summed in `subagent/end` (none if repaired), not the parent's meter.
- A child delegated before S21.1 or continued by 1.2.0 runs un-narrowed, ceiling and pins intact (`core/session/format.ts`).
- A step is never preempted: a steer waits for its slowest pooled child; a person stops all its children (a turn cancel) or none, and narrowing a running parent reaches none of them (`tool-subagent/index.ts`).
- A replay reproduces decisions, not the workspace: an absolute path misses a fresh root, yet `assertConsumed()` passes.
- An Anthropic id lacking its minor version's row gets 200K with images; an account enforcing an unedited prefix before signed thinking may refuse a compacted 5.x session's later steps.
- `deepseek-v4-pro` silently ignores an image; retired `deepseek-v4-flash` names resolve to `deepseek-flash` while routed.

## 14. File map

```
key files; .ts omitted
src/kernel/ tokens · bus · context · errors
src/core/ scope · json · ids · text · process; a package per §3 row, plus effects/ (no service), metering/, llm/wire
  session/ store · session · surface · page · title · format · repair · invariant
  agent/ index · repair · invariant
  loop/ driver · factory · invariant
  jobs/ events · index · invariant
  sandbox/ events · index · paths · invariant
src/capabilities/
  llm-{deepseek,anthropic,openai,retry}/ · model-roles/ · tool-subagent/ · tool-history/
  fs-{local,observation-policy}/ · tool-editor/ · attachments-local/ · tool-view-image/ · tool-jobs/ · tool-web-search/ · tool-browser/
  shell-stdio/ · tool-shell/ · approval-headless/ · authority-presets/
  persistence-jsonl/ · credentials-local/ · settings-local/ · spill-local/ · composition-record/
  context-runtime/ · workspace-instructions/ · skills/ · compaction-basic/ · session-title/
  protocol/ (frames · host · connection · transport-*)
src/app/ cli · home · compose · config · settings · headless · serve · web · present · inspect
  web/ (conversation · cards · transcript · rows · wire …) · terminal/ (controller · tui · line · tty · keys · blocks · screen …) · *.e2e.test.ts
src/test-support/ scripted-adapter · harness · llm-replay · {serve,web}-process · desktop-app · fixtures/ (logs, plugins, pdf)
desktop/ src/ (main; pure runtime · inspect · folders · guards …) · shell/ · scripts/ (package · smoke-runtime · check-fuses) · e2e/
skills/ bundled office/ · pdf/ (README)
scripts/ build · check-deps (+ deps-graph) · check-docs · doc-registers · count-lines (counts: BLUEPRINT §4) · smoke-installed.sh
.github/ workflows/ (check, live, release) · actions/desktop-leg · templates
(root) bin/minidsh.js · README · CLAUDE · SECURITY · LICENSE …
docs/ · references/ · .claude/ · the reader documents: CLAUDE.md §4, §5, §8
```
