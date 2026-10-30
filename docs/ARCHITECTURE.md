# MiniDSH Architecture

One runtime composed from plugins over a tiny kernel. Everything the model sees derives from an append-only session log; everything it does goes through one guarded tool pipeline, fenced at the effect boundary by an authority the log records. The model is a capability the runtime routes to, not the agent. Every surface only renders the log, by the page, and a session survives its process.

This is the map: what each layer owns and must not own, and where a new thing goes. History is in `BLUEPRINT.md` §4 and the commits, usage in `README.md`; §12 lists deliberate differences from DeepSeek Harness (DSH), §13 what is knowingly missing. Code comments cite section numbers, which are stable.

## 1. Layers and dependency direction

```
src/app/           assembly + surfaces (§14)
src/capabilities/  providers + consumers (§3)
src/core/          Definitions + default drivers (§3)
src/kernel/        substrate (§2)
src/test-support/  adapters + harness (§14)
```

`scripts/check-deps.ts` enforces three rules. **Direction:**

| from | may import |
|---|---|
| `kernel` | nothing internal |
| `core/<x>` | `kernel`, other `core`; **`core/loop` only by `app` and `test-support`** |
| `capabilities/<x>` | `kernel`, `core` except `core/loop`; no other capability, no `app`, no `test-support` |
| `app` | anything |
| `test-support`, `*.test.ts` | anything |

The table is a whitelist per layer; `kernel`, `core` and capabilities reach nothing outside `src/` and no non-literal `import()` (`scripts/deps-graph.ts`). **Payloads** are read via `matches(event, KIND)`, never a type assertion on `event.data`, outside tests. **Core is acyclic at file level** (packages may cycle): each package's `events.ts`/`types.ts` sits below its service. A capability is a directory, not a package; the browser client shares only the wire with the host.

## 2. Kernel (`src/kernel`)

Five mechanisms (`kernel/index.ts`).

- **Context and services.** `child({scope?})` derives a scoped context. `provide` is an effect, one claim per key per context; `get` needs the key `inject`ed or self-provided.
- **Plugins.** `config` is a structural `{parse}` contract, parsed before `apply`; `pending` until every injected key is provided, and a replaced provider reloads its dependents. Effects unwind before dependents unload: **a disposer must not read the services its plugin injected** (`kernel/context.ts`).
- **Events.** A token carries its dispatch mode (`kernel/tokens.ts`); a waterfall's `next()` is single-shot; `observe` runs before any listener. A dispatch reaches unscoped and `global` listeners plus its own scope's, so an agent-scoped listener hears `session/*` or `llm/stream` only with `global: true` (`kernel/bus.ts`).

**Scope contract** (`core/scope.ts`). Registration context = visibility = lifetime: a view is the globals plus one agent layer, a local entry shadows a global, nothing is inherited between scopes. An agent's operation events dispatch in its scope (`agent/*`, `tools/*`, `approval/request`, `system-prompt/assemble`, `fs/*`); `llm/stream` and `session/*` are unscoped. Deployment-global registries (`llm`, `invariants`) refuse a scoped owner. Consumers get the agent as subject, never services via `agent.ctx`.

## 3. Core contracts (`src/core`)

Nineteen service keys: eighteen `core` (below) + app-only `app-composition`; `loop` is a plugin, not a key. A seam needs all three roles: Definition (core), Provider (capability), Consumer (capability, usually a tool). Agent id = session id.

| ctx key | owns | must not own |
|---|---|---|
| `sessions` | `Session`: header + append-only log (§4) + surface; `repairInterruptedTail` (§4) | persistence backends, UI state, model |
| `persistence` | READ Definition: `load(id)` → the readable prefix (`damaged?`, `lease`); `list()`; `durability`, the flush guarantee it declares (§4) | the write path (the provider's); repair; deletion |
| `credentials` | `CredentialRef`: a validated env-var NAME, the only thing config, logs and errors carry; `resolve` fresh per call; the `declare`d refs are the secrets (§9) | storing or logging values; which layers exist |
| `presets` | key `authority-presets`: `presetTable`, pure `presetFor`, the log-only `authority/preset` intent (§7) | enforcement; knobs; a `defaultPreset` |
| `llm` | the provider-neutral vocabulary and a deployment-global adapter registry (§5); `stream` = the `llm/stream` waterfall, whose terminal continuation picks the adapter | API keys, session state, default model |
| `tools` | `defineTool` (`tags?` never model-facing, §11; `concurrencySafe` only with `timeoutMs: null`, §6); `restrict` (subtractive, own registrations exempt) through the one resolver: a hidden tool is unknown to the model and refused if called; `ToolCall.onDispatch` and the pipeline (§6) | policy |
| `prompt` | ordered named sections + strict `{{var}}` variables; `assemble(agent)` → `system-prompt/assemble`; sections stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request` → `allowed-once \| rejected \| cancelled \| unavailable` on the `approval/request` waterfall (default `unavailable`); the model-written `reason` neutralized and clamped before the log, `subject` its trusted half; `ApprovalPolicy` `ask \| never`; `grants`/`revoke` (§7) | answer logic; model-facing prose; a public `grant` |
| `fs` | `fs/edit-intent` (read-before-edit) and `fs/observed`; **fences every mutation** before any effect (`FS_SANDBOX_DENIED`), reads always pass (§7); `readBytes` emits no observation | tool schemas; policy itself |
| `shell` | `sessionFor(agent)` → `ShellSession`; `enforcementFor(mode)`; `exec` reports the `enforcement` it got and REFUSES what it cannot enforce (`SANDBOX_UNAVAILABLE`) unless the call `accepts` it (§7); optional `start` (a job's process), refused alike | model-facing descriptions; negotiation; a job's lifecycle |
| `sandbox` | the authority stamp (`SandboxMode`, `sandbox/mode`); the pure `writableRoots`/`allowsWrite` every fence derives from; the ACCEPTANCE knob (`sandbox/acceptance`). All §7 | enforcement backends; what any tool may do; **what the model is told of it** |
| `compaction` | `compactNow(agent)`; the log-only bracket `compaction/start\|applied\|end`; PURE `planCompaction` (the pairing rule, §6) | threshold, summary, trigger |
| `attachments` | content-addressed `AttachmentRef`; `saveImage/readImage/hostPath`; **an image is validated and durably committed before its event** (§5) | normalization; retention; who may look |
| `spill` | output with NO OTHER HOME: `save` → a path, `open` streams a job's; head/tail excerpt renderers | threshold (each tool's own) |
| `jobs` | owner-scoped background work: identity, admission (a cap), ONE terminal fact (first-wins), delivery through the owner's inbox (§6); `stopAll`; each job's output tail and capped spill file | processes (the producer's, which forwards chunks), wire state, a queue or scheduler |
| `settings` | REMOTE-writable defaults: `register/describe/read/write` (`expectedRevision`, §8); `settings/changed` | store; authority; composition; anything a resumed session recorded |
| `agents` | `create/resume/fork/get/list`. **Creation is a TRANSACTION** (`core/loop/factory.ts`): built unpublished, `world` before `setup`, published last; any failure rolls back and frees the id. `configure` is the durable route switch (§4); `resume` = `load` (refusing `damaged`) → `repairTail` (§4) → seed → that transaction; a continuation needs the header's preset and a child's opening stamps (§7); `fork` may `salvage` a damaged prefix (§4) | driver |
| `invariants` | `register(owner, name, installer)`: deployment-global, config-selected, validating pre-commit via `observe` | product logic |
| `loop` | the driver: its durability checkpoints and a step's ordered lane, concurrency-safe bodies up to the agent's width (§6); registers itself as the agent factory, which writes each lifecycle's `session/lifecycle` first (§4) | anything extensions do; a queue or scheduler |

## 4. Canonical facts: the session log

The log is the single source of truth: `{type, seq, time, data}`, `seq === log.length`, frozen at append.

- **Three tiers** (`core/session/types.ts`). **Surface** kinds (`user/message`, `assistant/message`, `tool/result`) carry `surfaceOp` and `sourceEventSeqs`; model history is their fold (`deriveEventMessage`). Every other kind is log-only: a **fact**, or **trace** (`TRACE_TYPES`) if nothing folds it at runtime; folds walk `Session.facts`, the log without its trace.
- **Vocabulary: 34 kinds**, by owner. session: `turn/start|end`, `step/start|end`, `user/message`, `assistant/chunk|message`, `tool/call|dispatch|result`, `request/header|context`, `session/title|end-seed|lifecycle`; agent: `agent/options`, `inbox/spliced`, `subagent/start|end` (the PARENT's log); `approval/asked|decided|grant|policy`; `sandbox/mode|acceptance`; presets: `authority/preset`; `compaction/start|applied|end`; `effect/recorded`; `job/start|end`; `llm/aux-call`; `composition/applied` (`capabilities/composition-record`).
- **Format** (`core/session/format.ts`): the header's `version` alone; a writer continues its own format, forks an older one, refuses a newer one (`SessionFormatError`, not damage). A change an older reader meets conservatively, or that leaves only the model less informed, is a note there, never a bump.
- **Every lifecycle opens with `session/lifecycle`** (seq 0, or right after its `session/end-seed`; placed and typed by `core/session/invariant.ts`): `dispatch` (a durable `tool/dispatch` precedes every body), `durability: 'synced'`, `salvage`. Readers use its claims, never its presence (`core/session/types.ts`).
- **The route is one fact in two records.** `agent/options` is the BASE (`configure` writes `change`); `request/context` the EFFECTIVE route, window and modalities per step (§6); a role rewrites header and context, never the base. Both `request/*` are written only on change; a field added to such a record reads as absent where never rewritten (`core/loop/driver.ts`).
- **The header** (`SessionHeader`) is immutable identity and lineage: fork, `delegatedByCallId`, `agentPreset`. **Opening facts** land before publication: `agent/options{initial}`, `approval/policy{initial}`, `sandbox/mode{initial}`, `composition/applied` (a delegated child's are §7's).
- **Arrival versus rewrite.** An arriving `user/message` sits in an open turn; a range REPLACE may land between turns (`core/session/invariant.ts`).
- **The durable inbox** is `inbox/spliced`, op-shaped (`core/agent/events.ts`): a claim commits after the messages it entered, so a crash re-delivers, never loses; disposal records late step input, a person's cancel keeps a job's end notice, both quiet; the Inbox holds an open claim, so a clear records it first; a rejected step requeues its notices, and a narrowing one holds them for the next turn (`Inbox.hold`). A resume wakes iff a WAKING insert was restored, a fork never (`core/loop/factory.ts`).
- **A job is a bracket outside every step** (`core/jobs/events.ts`): `job/start` once spawned, ONE `job/end`; its notice follows the end in one JS turn, only through the inbox.
- **Crash repair closes everything the log left open** (`repairTail`, `core/agent/repair.ts`). Resume and cold fork run a STATIC list, innermost first: `subagent/end{interrupted}`; `compaction/end{declined: unclosed}`; `repairInterruptedTail` (`core/session/repair.ts`); jobs LAST: `job/end{lost}` plus a QUIET notice, or the notice an end never got. Closers are pure (a cold read predicts a repair byte for byte) and state only what the log proves.
- **A synthetic result states the evidence** (`classify`, `core/session/repair.ts`): no `tool/call` ⇒ `TOOL_NOT_STARTED`; a `tool/dispatch` or a recorded effect ⇒ `TOOL_OUTCOME_UNKNOWN`; neither ⇒ not started only where the open turn's lifecycle claims `dispatch` and `synced`, else unknown. Under salvage, or in a log a live writer holds (`heldByWriter`), every owed call is unknown; an unknown result names the call's effects recorded in the step.
- **An effect is recorded by the code that caused it, after it happens** (`core/effects/events.ts`): `fs-local` and `shell-stdio` append `effect/recorded` (`fs-write | shell-command`, keyed by `callId`). **Presence is proof; absence proves nothing.** Closed families, no exactly-once (§13). `EffectIntent`, the "about to do" half (`shell-command`, `network-request`), is never logged alone: only as a consent's `subject` and a grant's identity (§7).
- **A `session/event` listener may not append synchronously**: a nested append persists before its cause (`damaged` at resume); queue a microtask (`core/session/store.ts`).
- **Model-visible ⟺ logged.** Every request equals `deriveMessages()` plus the folded `request/header`; checked at `llm/stream` preflight (`core/loop/invariant.ts`).
- **Persistence is a subscriber** (`persistence-jsonl`): `sessions/<id>.jsonl` (§9) under ONE writer: a `.lock` lease from publication to disposal, reclaimed only from a provably dead same-host holder, refuses a second resume before paid work; **reads never lock**. A torn final line moves to `.torn`; deeper corruption is `damaged` and refuses attach. **A resolved `session/flush` is on stable storage** (`durability: 'synced'`); a failed write or sync fails every later flush (§13).

## 5. LLM vocabulary and the adapters

`core/llm/types.ts` is the provider-neutral vocabulary: closed `ContentBlock` and `StreamChunk` unions, `LlmFailure` (policies route on `code`, never message text) and DISJOINT `TokenUsage`.

- **Adapters** register on the deployment-global `llm` (§2): `llm-deepseek` (Chat Completions), `llm-anthropic` (Messages), `llm-openai` (Responses, stateless: `store: false`).
- **Refuse before I/O, never degrade.** An option or modality the provider cannot honour fails an `UNSUPPORTED_*` code, never dropped, aliased or clamped: the logged request is the served one.
- **Replay state reaches only its writer.** A signing provider's `ReplayEnvelope` is stripped for any other provider inside the `llm/stream` terminal continuation (`core/llm/runtime.ts`); OpenAI's encrypted reasoning replays only to the model that wrote it, foreign reasoning dropped, never forged (`llm-openai/serialize.ts`).
- **Retry is a capability** (`llm-retry`, on `agent/request-error`), so failed attempts stay durable.
- **Images: a reference plus a STORED descriptor** (`core/llm/content.ts`), committed before its event. **Refuse at admission** (`core/llm/admission.ts`, every producer, the STEP's route first), **substitute at projection** (a text-only route gets `block.text`); lost bytes fail `ATTACHMENT_UNREADABLE` (§13).
- **A catalog is a dated source snapshot, never fetched** (`resolveModel` is synchronous), held to the provider by each adapter's live drift probe (`catalog.e2e.test.ts`). `contextWindow` is what compaction budgets against; an unknown id gets conservative facts and no output cap of ours (§13 for Anthropic).
- **One wire** (`core/llm/wire.ts`), pure, for the adapters and `web_search`: SSE framing, capped bodies, the base-URL rule, the key redacted from every failure, thrown or yielded.

## 6. The loop and the tool pipeline

`core/loop/driver.ts` is the one agent driver; `core/tools/registry.ts` is the only path from a model's call to a tool body.

```
followup(m) → next-turn FIFO (wakes)   steer(m) → next-step (wakes)   inject(m) → next-step (no wake)
turn/start
  claim → resolveCallConfig (agent/request; per step, retries too) → request/context when changed
        → agent/pre-step (waterfall: reject | enter{messages})   reject ⇒ turn/end{blocked}
  step/start → user/message per entered message
  prompt.assemble → request/header when changed
  CHECKPOINT → llm.stream(frozen request) → assistant/chunk{attempt}* → assistant/message{usage}
       finish error ⇒ agent/request-error (waterfall) → retry (next attempt, same route) | turn/end{error}
  tool calls, ONE lane in model order: tool/call → CHECKPOINT → tools.execute → [gate → tool/dispatch → CHECKPOINT → body*] ;
       tool/result in model order   (* a concurrencySafe body overlaps the next call's lane, ≤ width; any other call waits
       for every earlier result)   (cancel ⇒ ABORTED_BEFORE_DISPATCH; a lost write ⇒ DURABILITY_LOST, none starts)
  step/end → next step while tools owe a request or next-step input exists (≤ maxSteps)
  agent/turn-stopping (serial) → re-read inbox
turn/end{reason} (exactly once) → session/flush → next turn or idle
```

- **No scheduler; two forms of concurrency.** One sequential driver per agent: the inbox is the only queue, nothing waits past its step (a call past the width waits in the lane for a slot), and job admission refuses at its cap, never queues. **Joined at the step**: a `concurrencySafe` tool's BODY overlaps its siblings', up to `AgentOptions.maxParallelToolCalls` (default 4; a child's is its row's `childParallelCalls`, default 1, so a tree is bounded by a log fact); any other call is a barrier. Only the ordered commit appends `tool/result`: readers join by `callId` or cited seq, never adjacency (`core/loop/driver.ts`). **Delivered through the inbox**: jobs. Detached children: BLUEPRINT §3.
- **The route is resolved once per step**, fixed for its retries; a switch lands at the next step.
- **Durable before every action.** A CHECKPOINT is `session.flush()` (§4). The DRIVER writes `tool/dispatch` after the gate via `ToolCall.onDispatch`, awaited INSIDE the `tools/execute` terminal continuation: a middleware answering without `next()` replaces the body and writes no dispatch (`core/tools/registry.ts`), and its call holds the lane. After a lost write nothing starts; bodies in flight are aborted with its cause and drained. Every logged call is answered on every exit path, and a LIVE `step/end` over an unanswered one fails (`core/session/invariant.ts`).
- **Pipeline**, in the acting agent's scope: validate → `tools/pre-execute` → deny-only guards → `ask` ⇒ `approval.request` → deadline → `tools/execute` (around-middleware) → body → `render` → `tools/post-execute` → `tools/result`. A throw is an `isError` result `{name, code}`; the model sees only `{name, description, parameters}`.
- **Deadlines are the pipeline's**: `timeoutMs: null` opts out (a tool asking consent in its body must, on `callSignal`); expiry is `TOOL_TIMEOUT`, the signal aborted, the body abandoned, not awaited.
- **Compaction** (`compaction-basic`) runs on pressure (`core/metering`, §11), on overflow or on `compactNow`, and keeps **the pairing rule**: the kept tail never begins with a `tool/result`. An applied attempt writes `compaction/applied`, then one replacing `user/message` citing every shadowed seq. The summary request shows the tools and forbids calling them (`LlmRequest.toolChoice`). **The hazard is the await**: `planIsLive` is re-checked with no `await` before the append.
- **Bounded recall** (`tool-history`): `history_read` reads only this session's shadowed seqs, hidden until the first applied compaction; a call over budget is refused, not truncated.
- **Spill** (`core/spill`) is the producing tool's call (§3): an excerpt plus the path.
- **An `agent/pre-step` listener may add to a batch, never create one**: an empty first step ends the turn (`core/loop/driver.ts`). `AGENTS.md` and the skill list enter so, as durable plugin `user/message`s, never a prompt section (§3); the list, outermost, appends a fresh render only when it differs from the newest LIVE one, so a compaction re-enters it (`capabilities/skills`).
- **Jobs** (`core/jobs/index.ts`): only a job's OWN end, with no stop asked for, may wake its owner, under the wake budget (`foldJobWakes`); every other end is quiet; one a tool call reports (`reportedBy`) sends no notice. Headless and a delegated child `stopAll` in the `whenIdle` continuation, before any await (`app/headless.ts`, `tool-subagent`).
- **Lifecycle.** `dispose` = cancel → `whenIdle` → scope unwind (jobs stopped, recorded, synced) → agent, then session, detach (`core/loop/factory.ts`); a detached session refuses appends (`SESSION_CLOSED`).

## 7. Authority

The model proposes, policy decides, the effect boundary enforces; every decision is a fact in the log.

- **One stamp.** `SandboxExecutionPolicy{mode, workspaceRoot}` resolves per call from `ctx.sandbox`, never caller-assembled; mode governs FILE EFFECTS only. The root is the immutable `SessionHeader.cwd`. `writableRoots(policy)` is a CEILING for `fs` and `shell`: grant less, never more (`core/sandbox/index.ts`).
- **Enforcement lives at the effect, not the gate.** `fs-local` canonicalizes and contains every write in process, refusing `FS_SANDBOX_DENIED` before any effect; reads always pass. It follows symbolic links itself (`core/sandbox/paths.ts`), checks the file it opened, not only the name, and cannot detect a hard link (§13).
- **Untrusted code is the shell's problem.** `shell-stdio/confine/` wraps the spawn: bwrap on Linux, Seatbelt on macOS, none on Windows (§13). Each is PROBED with its real `read-only` profile, and `enforcement` is recorded at agent creation (`enforcementFor`).
- **Spawn-time binding.** A backend wraps the persistent child once, under the session's policy; a durable `setMode` replaces it. An approved one-shot escalation and a job's process are throwaway children wrapped like any spawn (`danger-full-access` alone runs unwrapped) and reaped at disposal, each leading its own POSIX process group (`shell-stdio/process.ts`).
- **A record is not a fence.** `effect/recorded` (§4) sits beside the boundary; losing one loses evidence, never containment.
- **The escalation path.** A refusal is a fact with one legitimate move: the SAME command once more with `sandbox_permissions` (strictly wider) and a `justification`, `ctx.approval` consenting to that call. Under a backend a denial reads as a failing command; its words earn a hint, never a classification (`tool-shell`; §13).
- **Consent is to the runtime's record.** An ask's `subject` is an `EffectIntent` (§4) the REQUESTER builds from validated arguments, naming the authority the effect would run under (for a network request, where it goes and as whom); the model's `justification` stays in `reason`, clamped (§3), never in the subject, whose every invisible or non-space blank is escaped (`clampIntent`).
- **Acceptance.** The `enforcement` beside a stamp is a HOST fact; `sandbox/acceptance` is a DECISION, `full` (default), `partial` or `none`, for exactly the mode it names (`core/sandbox/events.ts`). Read per call (`acceptsFor`), it relaxes the shell's REFUSAL, never a backend; the fs fence and ceiling stand. `--accept` sets the row's default; a weakened one is stamped per confinable mode at a top-level opening (`stampAcceptance`), a child's pin for its `forMode` alone (`open`).
- **A consent may outlive one call, never its lifecycle.** `approval/grant` is log-only, identified by `toolName` plus the exact subject's `intentKey`: a REPEATED IDENTICAL action, not a policy language. A grant is live only once its own ask is `allowed-once`, and until any `approval/policy`, `sandbox/mode`, `sandbox/acceptance` or `authority/preset` follows, or the lifecycle ends (`session/end-seed`: a resume or a fork asks again) (`core/approval/events.ts`). Only an offer the fold (`openApprovals`) still makes is minted, so no answerer buys one nobody was offered, and headless takes none; `grants` lists them, `revoke` ends one.
- **Every decision is durable.** The setter IS the event (`sandbox/mode`, `approval/policy`, acceptance, grants): `initial` before publication (§4), `change` only on change, sandbox `resume` when a resumed host enforces differently; `context-runtime`, never the service, tells the model. Precedence: approved one-shot escalation > recorded fold > composition default. `approval-headless` fails closed (`unavailable`) except under `--approve` or an exact `allow` entry.
- **A delegated child opens under a ceiling.** `tool-subagent` captures the parent's authority and stamps it in `setup`, `reason:'delegation'`: the mode as a CEILING, approvals pinned `never`, acceptance `strictest(parent, row)` as a PIN. Widening is refused (`SANDBOX_CEILING`, `APPROVAL_PINNED`) and so is `setAcceptance` on any delegated session; narrowing is legal. A continuation keeps them: `fork` refuses a boundary below the opening stamps (§13).
- **A network tool asks per call and never reaches a child.** No backend confines the network, so a `NETWORK_TOOL`-tagged tool asks consent in its body before any byte leaves, every call, with exact grants (`tool-web-search`); `tool-subagent` hides every such tool from a child at delegation, whose `never` pin refuses it anyway (`core/tools/types.ts`; §13).
- **The browser is fenced, not consented** (`tool-browser`, deliberately not `NETWORK_TOOL`, so a child may use it). A harness process over a CDP pipe, never a port; a fresh profile; downloads denied. Inside Chrome, a proxy this process owns refuses all but loopback and row-config `allowHosts`, resolver rules leave it no other name, and `file:` loads pass only inside the workspace; a canary proves the fence per launch, and only one that went elsewhere is a host fact (`launch.ts`).
- **A job runs under the stamp its start resolved, never an escalation**, and a `change` of `sandbox/mode` or `sandbox/acceptance` ends its owner's jobs, a start in flight included (`core/jobs/index.ts`).
- **Presets select, the knobs decide.** `authority/preset` is a log-only intent written before `setMode`/`setPolicy`; the current preset is DERIVED (`core/presets`). A SET of switches, the wire's or a resume's flags, is held to a delegated session's ceiling and pins before any lands (`authoritySwitchRefusal`).
- **Consent-by-composition.** `approval/request` dispatches in the asking agent's scope, so a preset-mounted (§9) answerer can auto-approve for its own agent: code-equivalent trust, every pair audited. It cannot widen enforcement (the fence and shell resolve the global `SANDBOX`) nor reach a deployment-global registry.
- **`core-authority`** (`core/sandbox/invariant.ts`) refuses pre-commit a forged authority fact or subject, a second decision on one ask, a delegated session past its ceiling or pins, a grant naming no open `intentKey`-identical ask in this log, nor one in a delegated session or on a truncated subject, and a decision crediting a grant not live for its exact subject (`GrantFold`, the rule `liveGrants` folds).

## 8. Surfaces

A surface injects only `agents` and `sessions` (plus `llm`, `sandbox`, `approval` for catalog and authority), owns transport and process exit, renders from `session/event` and holds no authority state: a switch it asks for is a durable event it reads back. Plain-text surfaces share `app/present.ts`, which neutralizes control characters; the cold readers (`app/inspect.ts`) neither lease nor repair.

- **Headless CLI** (`app/cli.ts`): exit 0 iff the turn completed, 2 on a usage failure; `--json` streams the wire's `{sessionId, event}` frame.

**Protocol** (`capabilities/protocol`): JSON-RPC 2.0; one plugin, one host, N carriers (stdio, in-process, WebSocket). Control-plane methods act only on a LIVE session; a child mid-delegation is read-only on every driving method.

| method | rule |
|---|---|
| `initialize` | the catalog, defaults (live from settings) and workspaces |
| `session/prompt` | no id creates, live delivers, stored resumes; `cwd`/`workspaceId` place a NEW session under `workspaceRoots` (not beside `sessionId`); a route no adapter serves is refused |
| `session/attach` | subscribes BEFORE the cut; `view` is the folds a page cannot compute, nothing pending or running on a cold read |
| `session/page` | beneath the attach cut |
| `session/detach` | no id narrows to NOTHING |
| `session/events` | every tier; the bounded gap repair |
| `sessions/list` | live and stored, live wins; derived `title`; a workspace label by spelling, no I/O |
| `session/cancel` | `keepQueued` spares the durable inbox |
| `session/compact` | HUMAN command, never a model tool |
| `approval/answer` | first answer wins; only from a connection that may see the session; an `offer` the fold did not make is refused |
| `approval/revoke` | ends one grant (§7) |
| `job/cancel` | a PERSON stops one job of a live session: `by: user`, notice quiet |
| `control/subscribe` | a live-session baseline, then `control.summary` whatever it watches |
| `session/authority` | each switch IS its durable event |
| `session/model` | no fields reads; the given fields are ONE `agent/options{change}`, iff the base changes |
| `settings/describe`, `settings/get`, `settings/set` | `expectedRevision` REQUIRED |
| `shutdown` | refused on a socket unless its carrier says `allowShutdown` |

Notifications: `session.event`, `session.status`, `session.view`, `settings.changed`, `control.summary`; approval frames ARE the durable events; no DTO layer or protocol version until a client ships apart (`frames.ts`).

- **Attach contract.** A message-aligned tail page at a `cursor` (`core/session/page.ts`), never the trace tier (`Session.facts`, §4), so a bare seq dedups. A client pages back, repairs a hole with a bounded `session/events` and re-attaches on reconnect, replacing its window: no lower-bound cursor, by design. No client folds the surface; a cold read never resumes.
- **Multi-client.** A connection owns only its sink, its watch set (narrowed by its first attach) and its control-plane subscription; a disconnect disposes nothing. A question stays parked while a watcher or control subscriber COULD answer it, else settles `unavailable`; only one that watches the session may answer (`protocol/host.ts`).
- **Backpressure is tier-aware** (`transport-ws.ts`): `session/event` is a synchronous contained emit, so no listener may suspend the loop; past a soft limit only the trace tier drops (summaries kept); past a hard one the socket closes `slow-client`.
- **The terminal** (`app/terminal`) is a protocol client that retains nothing of a session; a consent line shows the trusted subject, else the joined call, never a bare tool name. App assembly, not the wire, prepares its `resume`/`fork`: no wire method forks.
- **The browser** (`app/web/`, plain ES modules) GROWS its transcript, never rebuilds it (`wire.js`, `rows.js`). An authority surface (`app/web.ts`): loopback unless `--host`, a one-shot token traded for a signed cookie, a Host/Origin fence, no framing.

## 9. Composition, configuration and packaging

MiniDSH IS data: composition rows plus disk layers (`app/compose.ts`, `app/config.ts`). Settings (`core/settings`) and credentials (`core/credentials`) are separate planes; **authority is never configuration**: a recorded event beats any composition default by fold precedence (§7).

- **Home.** Only `app/home.ts` resolves `MINIDSH_HOME` (default `~/.minidsh`) and the paths under it; plugins get them, absolute, as config.
- **Layers.** built-ins (`compose()`) → app → home `composition.json` → `--patch` files; a patch replaces a row's WHOLE config. A disk `plugin` is a builtin name or a module path whose own imports are its problem (§13).
- **Trust.** `composition.json` is code-equivalent trust, never a persistence target. No workspace layer: a repository may say how it likes its code, never what the harness may do. `minidsh config` flags authority-sensitive rows a layer changed (`app/cli.ts`); an explicit authority flag is a durable per-session switch (`applyAuthority`) on every resume, a wire one included (`onResumed`).
- **Skills are data** (`capabilities/skills`): `SKILL.md` directories under user, bundled and repository roots, in that precedence; a repository skill never replaces another (`skills/README.md`). Above the cwd, a project root counts only where its marker and that marker's directory are this user's, never in a filesystem root (`ownProjectRoot`, skills and `workspace-instructions`).
- **Recomposition.** The spine `{session, llm, tools, prompt, agent, loop, persistence}` refuses removal or reconfiguration while agents are live (`app/compose.ts`).
- **Agent presets.** `agentPresets` in `composition.json` mount per-agent worlds on the agent scope, named in the session header so a resume or delegated child composes the same world (§7 for what they cannot reach).
- **Settings.** `agent` defaults: flags → `MINIDSH_MODEL` → `settings.json` → built-ins, read live per new session by a wire host (§8); on resume the log's route wins, and an explicit flag overrides it as `agent/options{resume}` (`core/agent/index.ts`).
- **Defaults.** Authority `workspace-write` + `ask`; `shell-stdio` `confinement: auto`. A shell child's environment is built, not inherited: the credential refs the mounted rows declared and `MINIDSH_*` removed, nothing for a name's shape (`core/process.ts`; §13). `tool-browser` is a default row that registers its tools only where Chrome, Edge or Chromium is found.
- **Packaging.** npm ships the `scripts/build.ts` emit as a binary, with no `main` or `exports` (BLUEPRINT §3).

**Retention: content is never swept; an affordance may expire.** Spill is the one affordance: its excerpt is already what the model saw. `spill-local` sweeps it once at load, never on disposal (a fork inherits its parent's locators).

| store | class | lifetime |
|---|---|---|
| `sessions/` (children too) | content, replay oracle | never removed by the harness |
| `attachments/v1/objects/` | content, shared by address | never removed |
| `spill/<session>/` (a job's output too) | affordance | age-swept at load, `cleanupPeriodDays` (default 30) |
| `browser/p-*` (a launch's profile) | affordance | removed at close; a dead owner's swept at the next launch on this host |

## 10. Verification

Tests mount real compositions; only the model is scripted or replayed (`test-support/llm-replay.ts`, whose `recorded` mode answers tool bodies too). E2E asserts the world where one exists.

- **Runtime invariants run in every test and live**; cross-capability claims are tested on the full composition (`app.test.ts`, `bootComposition`); real 1.0.0 and S16 logs (`test-support/fixtures/`) are verified, repaired, salvaged and replayed.
- **Gates.** `pnpm check` plus a packed-tarball install smoke on Ubuntu, macOS and Windows (`check.yml`); `release.yml` publishes a tag only after both it and an unfiltered `live.yml` passed that commit. Each `MINIDSH_EXPECT_*` flag fails a skip it names.
- **Live arcs** (`pnpm test:e2e`) run over `minidsh serve` (stdio) or `minidsh web`; the OpenAI leg, `search` and the OpenAI drift probe are LOCAL (`live.yml` holds only the DeepSeek and Anthropic keys).

| arc | what it proves |
|---|---|
| `live` | a SIGKILL inside a dispatched call: a second process repairs as a cold `verify` predicts, the call `TOOL_OUTCOME_UNKNOWN` |
| `authority` | an edit lands, recorded, one outside refused; the shell escalates unconfined, writes no host file confined; `read-only` refuses |
| `composition` | a disk composition loads a module tool; `settings.json` picks the route |
| `context` | a crossing made by reading compacts, citing exactly the shadowed seqs, and a note read is shadowed; AGENTS.md obeyed; a spilled value read back |
| `routing` | DeepSeek → Anthropic, one route fact; a `compaction` role off the base route after the switch; Anthropic's signature replayed; OpenAI encrypted reasoning and a tool-result image; three routes replayed |
| `delegation` | a child's demanded escalation decided by its pin, not widenable |
| `parallel` | delegations in one message: the children's turns overlap (their own logs' times), results in model order, each child's file written; replay bound by delegation, children handed over reversed |
| `verification` | a text-only parent's `view_image` refused; a role-routed child reads a test-drawn PNG |
| `search` | consent per query, its subject exact; the URL written came from the sources shown; a refusal is `NETWORK_DENIED` |
| `web` | cookie sign-in; two clients on one host; a wire consent; paging to seq 0; a socket reset mid-turn |
| `jobs` | a job's own end wakes an idle agent; a host killed mid-job: cold `verify` predicts `lost`, the resumed model is told |
| `skills` | a PDF and a CSV become `report.docx` via the listed office skill, read first; an outside reader agrees; byte-identical replay |
| `browser` | a runtime-only bug SEEN before the edit, fixed, re-verified by the test's own CDP; a verifier child screenshots test-drawn pixels |

**A live arc's premise, any assertion on the model's text, is an assumption about the model, and it decays silently**: with ONE separating assertion, ask what a model knowing nothing would answer.

## 11. Where new things go

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: an `llm` adapter (§5) |
| a model-facing capability | `capabilities/tool-<x>` on `tools` |
| a plugin's configuration | a strict `Plugin.config` schema (§2) |
| an execution world | `fs`/`shell` providers; tools untouched |
| a shell confinement backend | `shell-stdio/confine/` (§7) |
| an authority knob | a log-only event, a `findLast` fold, a default (§7); copy `sandbox/acceptance` (delegation pin, `auditLines`, both projections) |
| an authority preset | a presets-table entry (§7) |
| a capability, no code edit | a `composition.json` row (§9) |
| a user-adjustable default | `core/settings` if the wire sets it, else row config |
| a secret | a `CredentialRef` (§3) |
| a per-agent bundle | an `agentPresets` list (§9) |
| a policy/approval answerer | `tools/pre-execute` / `approval/request` listeners; guards (§6) |
| durable state | an event kind (§4) |
| an event's human line | `app/present.ts` AND `app/web/rows.js` |
| context for the model | `agent.inject()` or `agent/pre-step`, never prompt text |
| know-how the model may use | a `SKILL.md` directory, helpers inside: data, never code or authority (`skills/README.md`) |
| a surface | `app/` or a package under the §8 contract; zero semantics |
| a carrier | a protocol `Carrier`: framing, flow control only |
| a named place to work | a `workspaces` entry: addressing, not a grant |
| a remote client | the §8 attach contract |
| a per-agent variant | `agent.ctx` (`world` if inherited, else `setup`), or a `TOOLS.restrict` its owner lifts |
| a delegated child | `tool-subagent` (§7) |
| context management | a `core/compaction` provider (§6); a pruner keeps the pairing rule |
| a context-pressure number | `core/metering`: the one pure fold |
| oversized tool output | `core/spill`, via the producing tool (§6) |
| an attachment kind | raster: an `attachments-local` header probe; else a vocabulary change (`AttachmentRef`, `ModelModality`, `ContentBlock`, each serializer, the meter) |
| a network tool | a `tool-<x>` tagged `NETWORK_TOOL` (§7) |
| an image producer | `core/llm/admission.ts`, then `attachments.saveImage` (§5) |
| a process the harness spawns | `core/process.ts`: the environment rule, the tree kill |
| a second browser provider | a `core/browser` Definition first; until then `tool-browser` is both |
| a verifier | a `tool-subagent` row + `model-roles` entry |
| a model role | a `model-roles` entry; never the base route (§4) |
| an out-of-loop model call | `resolveCallConfig` + `runAuxCall`, never bare `llm.stream` |
| recall of shadowed history | `tool-history` (§6) |
| a cross-capability tool KIND | a `ToolDefinition.tags` constant, not a name |
| a store's lifetime | a retention row (§9) first |
| an effect worth recording | a `core/effects` vocabulary change (§4), written by the PROVIDER |
| a consent subject for one | an `EffectIntent` naming its AUTHORITY (§7) |
| a durable pipeline step | `ToolCall.onDispatch`: cannot replace the body (§6) |
| a tool whose body may overlap its siblings' | `concurrencySafe` on its definition, keeping its promise (`core/tools/types.ts`); never a queue or a pool of its own |
| work that outlives its call | `jobs.start` with the producer's `launch`, never a detached promise |
| a background producer | a world's `start` (§3); a second kind changes `JobKind` |
| a session's name | `core/session/title` (§4), written by `session-title` |
| a whole-log check | a pure `check*Log` beside its owner's invariant; `app/inspect.ts` composes |
| a format change | `core/session/format.ts` |

No row here → an architecture question first.

## 12. Divergences from DeepSeek Harness (the ones that still shape decisions)

Upstream mechanisms and verdicts at the pin: `references/assumptions.md`.

- **Substrate.** Own kernel, not Cordis: its two composability properties in five mechanisms (§2); one package plus a dependency gate (§1).
- **Concurrency.** Joined at the step: DSH's batch (one ordered lane, bodies pooled, results in model order), but a child stays a foreground body, so done is "idle" and a cancel reaches it (DSH: an async activation settling through the inbox, which Stop does not reach); replay binds a child by its delegating call (DSH: first-call order). Agent-owned jobs, waking bounded, a lost one closed and told (DSH: unbounded; left open).
- **The wire.** DSH's JSON-RPC SDK shape, bounded: trace-free pages under a ceiling, tier-aware drops, unseen approvals settling `unavailable` (§8).
- **Consent.** A trusted `subject` and the joined call on every ask (DSH: model prose); exact-subject session grants (DSH: none for tool calls); accepting `none` (DSH cannot express it).
- **Confinement.** bwrap and Seatbelt, each probed even alone; no Landlock (it needs a native launcher) or Windows backend (§13); a shell child's scrub by declared name (§9; DSH: by name pattern).
- **The ceiling.** The workspace root alone; DSH adds operator-named roots and the temp roots, where MiniDSH's test workspaces live.
- **Durability.** A durable `tool/dispatch` after the gate, recorded effects, a write lease and per-lifecycle writer claims over plain JSONL (DSH: no top-level dispatch; checksummed generations naming no writer).
- **Delegation and routing.** An enforced ceiling (DSH: a seeded pin); `subagent/start|end` in the parent's log, unpaired ones closed by repair (DSH: neither); `delegatedByCallId`; model roles over a durable base route.
- **Context.** No tool-result pruner (tools bound their output); recall gated, not opt-in (§6).
- **Surfaces.** A terminal ships (§8); DSH deleted its own.
- **Providers.** Snapshot catalogs (§5; DSH's DeepSeek routes read `GET /models` live); an unknown DeepSeek id gets conservative facts (DSH: text-only, the full 1M).
- **Web.** One opt-in search tool, consent per query, structured sources, no fetch (DSH: both default-mounted, unconsented, prose results).
- **Browser.** Default where found, a pipe, fenced and proved per launch (§7; DSH: experimental; Stagehand's debug port open to any local process; no fence).
- **Skills.** A listed path read with ordinary tools, optional (DSH: a mandatory `skill` tool); a repository skill never shadows (DSH: workspace first, ungated); documents on Node alone (DSH: Python, LibreOffice, no PDF).

## 13. Known limitations (current)

**Authority**

- Windows has no confinement backend, by decision (DSH's is `partial`: a hard-link escape, standing ACL changes). Until a session accepts `none` (§7) each shell command costs an escalation to `danger-full-access`, a mode that also drops the fs fence; a delegated child (pinned `never`) runs none.
- A tree kill misses a program a job leaves past its command on Windows (S21.1) and, on POSIX, a timed-out or backgrounded command's descendants under an unwrapped persistent child (`core/process.ts`).
- A job's process outlives a killed host (SIGKILL, an unhandled `serve`/`web` stop) except under bwrap; it reads `lost`, and nothing re-adopts or kills it.
- An acceptance is inert where a backend exists; a session carried onto one is told only that it is confined again.
- The web UI can take an offered grant scope but not list or revoke one.
- **The fs fence races a concurrent process**: a directory swapped for a link mid-write can leave an EMPTY file or directory outside, never content on Linux (`/proc/self/fd`); elsewhere the by-inode check is best effort.
- **Parallel children share one checkout**: only editor writes are versioned, and the per-path lock (`capabilities/fs-local`) orders this process's `fs-local` callers alone; shell and job writes take neither the lock nor a version check.
- **A hard link defeats both fences**: a workspace link to an outside inode is written through by the fs fence and a confined shell (`confine.test.ts`); a confined command can neither create one across the boundary nor write an outside path that also has a workspace name.
- `full` is a PROFILE claim the probe proves, not measured per call; no backend reports `partial`. A probe that could not run (out of descriptors, its bound) leaves its process unconfined-refusing until restart, with a warning. macOS is proven by CI alone.
- On Windows no owner is asked of a project marker above the cwd: only one in a filesystem root is refused (§9).
- Under bwrap a path beneath the ephemeral `/tmp` is invisible, not read-only, so its denial gets no hint; macOS has no writable temp: a tool needing one escalates.
- The `shell` row is outside the spine (§9): after a live `reconfigure`, `enforcementFor` and a stamp describe a world no command runs in.
- A shell child's environment withholds variables, not credentials (§9): undeclared secrets, `SSH_AUTH_SOCK` and proxy variables pass, `credentials.json` is readable, the network is open.
- A network tool is consented, never confined or recorded (§7); headless, only `--approve` allows one. One an agent preset registers, like a delegation tool, is the child's own: `restrict` cannot hide it nor the depth cap count it, a cost bound, not a fence.
- A module-loaded plugin is arbitrary code; `minidsh config`'s warnings are advisory.
- `tool-browser` reaches EVERY loopback service, in any mode and a delegated child, unconsented and unrecorded; a service may act or relay on its own authority, and no shell backend wraps the browser.

**Context**

- Under the DeepSeek default's 1M window only overflow recovery fires, unless `budgetTokens` is set.
- A summary can be wrong, and nothing makes the model call `history_read`.
- The meter sees a prompt or tool-set change a step late and charges images on text-only routes; a smaller role may be asked for a summary past its output cap.
- Workspace instructions are read once per entry, not watched.
- A notice the wake budget held waits for a human message; the terminal and the browser flag it.
- An unreadable user or bundled skill root freezes the skill list; no `/name` invokes a skill.
- Without a renderer the document skills check content, not appearance; `pdf build` writes Latin text only, `pdf read` has no OCR or decryption, `office build` no images or charts, and `office` refuses a package past 2M nodes a pass or 256 levels deep.

**Sessions and stores**

- The in-memory log keeps trace: a 400-turn session is tens of MB of heap.
- A long-running host's spill waits for a restart to be swept (§9); a repeated `callId` overwrites.
- A lost attachment is turn-fatal (`ATTACHMENT_UNREADABLE`); image validation is header-only; no client upload; the image bound is the whole surface's until a compaction shadows it.
- `tool-browser` shows no cross-origin frame's content and uploads no file.
- No session deletion, search, rename or model-written title (each needs a projection past `persistence.list()`).
- **Crash repair is as sharp as the lifecycle (§4)**: without `synced`, "not started" holds only for a process crash; salvage closers are placeholders, and salvage damage between turns leaves the model no sign (the CLI warns).
- Effect records are no inventory (`core/effects/events.ts`); one may over-report a shell that died between commands or follow an abandoned body's result (§6).
- `synced` is as honest as the disk, and Windows cannot sync a new log's directory; after a power cut a zero-filled tail reads torn, zeros before a surviving line damaged (`--salvage`).
- `verify` reads structure, surface messages and its report's folds, no other payload.
- A fork boundary may split a compaction bracket from the replace that realized it; `fork --at` refuses one inside an open turn or below a delegated child's opening.

**Surfaces**

- `session/events` has no host ceiling (any range, every tier); no RPC deadline or client timeout; the backpressure limits are unmeasured.
- `session.view`'s `status` goes stale; a reconnect loses the paging position and, for a sole watcher, a pending approval; only `control.summary` announces disposal.
- Detaching one session narrows an un-narrowed client to nothing (`protocol/connection.ts`).
- A pooled step's result lines are matched to their calls by order, not by name, on the plain-text surfaces and the browser (S22).
- `minidsh web` has no graceful stop: the next process repairs and reclaims the lease.
- `workspaceRoots` is always `[cwd]` and bounds only NEW sessions: a wire client may resume one outside it, and a resumed session its restored inbox wakes may begin its first request before the host's authority flags land.
- One principal, no accounts: the browser authenticates nobody (§8) and cannot switch a session's route.
- Windows needs `pwsh` 7, never 5.1; a command reading stdin blocks until its deadline.

**Delegation and providers**

- A delegated child's cost is summed in `subagent/end` (none in a repaired one), not the parent's meter; it dies with its tool call, its log stays.
- A resumed or forked child keeps its ceiling, pins, depth and width but loses what `setup` gave it: its tool filter, network denial, persona and the delegation tool's hiding at the cap (S21.1).
- A step is never preempted: a steer waits for its slowest pooled child, and a person stops all of a step's children (by cancelling the parent's turn) or none.
- An idle `/compact`'s summary call is bound to no agent's lifetime: a disposal neither aborts nor awaits it (S21.1).
- A replay reproduces decisions, not the workspace: a recorded absolute path cannot land in a fresh root, yet `assertConsumed()` passes, so arc prompts pin relative paths.
- An installed-package plugin (§9) reaches seams only by deep path into `dist/`; only an in-repo fixture is proven.
- OpenAI's drift probe holds only effort sets and defaults. An Anthropic id with no row of its own minor version gets 200K with images; whether a model thinks unasked is measured, not probed. Fable 5.1 took an edited prefix before a signed thinking block on this account (2026-10-25); an account enforcing that may refuse each later step of a compacted 5.x session (unmeasured).
- `deepseek-v4-pro` accepts an image and ignores it: admission is the catalog's. Retired `deepseek-v4-flash` names resolve to `deepseek-flash` while DeepSeek routes them.
- Composition changes need a restart.

## 14. File map

```
key files; .ts omitted
src/kernel/  tokens · bus · context · errors
src/core/    scope · json · ids · text · process; a package per §3 row, plus effects/ (no service), metering/, llm/wire
  session/   store · session · surface · page · title · format · repair · invariant
  agent/     index · repair · invariant
  loop/      driver · factory · marker · invariant
  jobs/      events · index · invariant
  sandbox/   events · index · paths · invariant
src/capabilities/
  llm-deepseek/ · llm-anthropic/ · llm-openai/ · llm-retry/ · model-roles/ · tool-subagent/ · tool-history/
  fs-local/ · fs-observation-policy/ · tool-editor/ · attachments-local/ · tool-view-image/ · tool-jobs/ · tool-web-search/ · tool-browser/
  shell-stdio/ · tool-shell/ · approval-headless/ · authority-presets/
  persistence-jsonl/ · credentials-local/ · settings-local/ · spill-local/ · composition-record/
  context-runtime/ · workspace-instructions/ · skills/ · compaction-basic/ · session-title/
  protocol/ (frames · host · connection · transport-*)
src/app/     cli · home · compose · config · settings · version · headless · serve · web · present · inspect
             web/ · terminal/ · *.e2e.test.ts
src/test-support/ scripted-adapter · harness · llm-replay · serve-process · web-process · fixtures/ (logs, plugins)
skills/      office/ · pdf/: bundled skills, zero-dependency helpers (README: authoring, provenance)
scripts/     build · check-deps (+ deps-graph) · check-docs · doc-registers · count-lines · smoke-installed.sh
.github/     workflows/ (check, live, release) · ISSUE_TEMPLATE/ · PULL_REQUEST_TEMPLATE
(root)       bin/minidsh.js · README · CLAUDE · CONTRIBUTING · SECURITY · CHANGELOG · CODE_OF_CONDUCT · LICENSE · NOTICE
docs/ · references/ · .claude/   named in CLAUDE.md §4, §5, §8
```

`scripts/count-lines.ts` measures the tree; the 1.0.0 line counts are in BLUEPRINT §4.
