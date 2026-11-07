# MiniDSH Architecture

One runtime composed from plugins over a tiny kernel. Everything the model sees derives from an append-only session log; everything it does goes through one guarded tool pipeline, fenced at the effect boundary by an authority the log records. The model is a capability the runtime routes to, not the agent. Every surface only renders the log, by the page, and a session survives its process.

This is the map: what each layer owns and must not own, and where a new thing goes. History is in `BLUEPRINT.md` §4 and the commits, usage in `README.md`; §12 lists deliberate differences from DeepSeek Harness (DSH), §13 what is knowingly missing. Code comments cite section numbers, which are stable.

## 1. Layers and dependency direction

`scripts/check-deps.ts` enforces three rules. **Direction** (a whitelist, `scripts/deps-graph.ts`):

| from | may import |
|---|---|
| `kernel` (§2) | nothing internal |
| `core/<x>`: Definitions + default drivers (§3) | `kernel`, other `core`; **`core/loop` only by `app` and `test-support`** |
| `capabilities/<x>`: providers + consumers (§3) | `kernel`, `core` except `core/loop`; no other capability, no `app`, no `test-support` |
| `app`: assembly + surfaces (§14) | anything |
| `test-support` (adapters + harness, §14), `*.test.ts` | anything |

In `kernel`, `core` and capabilities a non-literal `import()` or a path out of `src/` fails. **Payloads** are read via `matches(event, KIND)`, never a type assertion on `event.data`, outside tests. **Core is acyclic at file level**: each package's `events.ts`/`types.ts` sits below its service. A capability is a directory, not a package; the browser client shares only the wire with the host.

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
| `sessions` | `Session`: header + append-only log + surface (§4); `repairInterruptedTail` | persistence backends, UI state, model |
| `persistence` | READ Definition: `load(id)` → the readable prefix (`damaged?`, `lease`); `list()`; `durability`, the flush guarantee it declares (§4) | the write path (the provider's); repair; deletion |
| `credentials` | `CredentialRef`: a validated env-var NAME, the only thing config, logs and errors carry; resolved per call; the `declare`d refs are the secrets (§9) | storing or logging values; which layers exist |
| `presets` | key `authority-presets`: `presetTable`, pure `presetFor`, the log-only `authority/preset` intent (§7) | enforcement; knobs; a `defaultPreset` |
| `llm` | the provider-neutral vocabulary and a deployment-global adapter registry (§5); `stream` = the `llm/stream` waterfall, whose terminal continuation picks the adapter | API keys, session state, default model |
| `tools` | `defineTool`; `restrict` (subtractive, by name or `tags` KIND; own registrations exempt unless `includeOwn`) through the one resolver: a hidden tool is unknown to the model and refused if called; `ToolCall.onDispatch` and the pipeline (§6) | policy |
| `prompt` | ordered named sections + strict `{{var}}` variables; `assemble(agent)` → `system-prompt/assemble`; sections stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request` → `allowed-once \| rejected \| cancelled \| unavailable` on the `approval/request` waterfall (default `unavailable`); the model-written `reason` neutralized and clamped before the log, `subject` its trusted half; `ApprovalPolicy` `ask \| never`; `grants`/`revoke` (§7) | answer logic; model-facing prose; a public `grant` |
| `fs` | `fs/edit-intent` (read-before-edit) and `fs/observed`; **fences every mutation**, reads always pass (§7); `readBytes` emits no observation | tool schemas; policy itself |
| `shell` | `sessionFor(agent)` → `ShellSession`; `enforcementFor(mode)`; `exec` reports the `enforcement` it got and REFUSES what it cannot enforce (`SANDBOX_UNAVAILABLE`) unless the call `accepts` it (§7); optional `start` (a job's process), refused alike | model-facing descriptions; negotiation; a job's lifecycle |
| `sandbox` | the authority stamp (`SandboxMode`, `sandbox/mode`); the pure `writableRoots`/`allowsWrite` every fence derives from; the ACCEPTANCE knob (`sandbox/acceptance`). All §7 | enforcement backends; what any tool may do; **what the model is told of it** |
| `compaction` | `compactNow(agent)`; the log-only bracket `compaction/start\|applied\|end`; PURE `planCompaction` (the pairing rule, §6) | threshold, summary, trigger |
| `attachments` | content-addressed `AttachmentRef`; `saveImage/readImage/hostPath`; **an image is validated and durably committed before its event** (§5) | normalization; retention; who may look |
| `spill` | output with NO OTHER HOME: `save` → a path, `open` streams a job's; head/tail excerpt renderers | threshold (each tool's own) |
| `jobs` | owner-scoped background work: identity, admission (a cap), ONE terminal fact (first-wins), delivery through the owner's inbox (§4); `stopAll`; each job's output tail and capped spill file | processes (the producer's), wire state, a queue or scheduler |
| `settings` | REMOTE-writable defaults: `register/describe/read/write` (`expectedRevision`, §8); `settings/changed` | store; authority; composition; anything a resumed session recorded |
| `agents` | `create/resume/fork/get/list`. **Creation is a TRANSACTION** (`core/loop/factory.ts`): `world` → narrowing → `setup` unpublished, published, then a continuer's `opening` before any wake; a failure rolls back, freeing the id. `resume` = `load` (refusing `damaged`) → `repairTail` → seed → that transaction, under the header's preset, a child's stamps (§7); `fork` may `salvage` a damaged prefix; `configure` switches the base route (§4) | driver |
| `invariants` | `register(owner, name, installer)`: deployment-global, config-selected, validating pre-commit via `observe` | product logic |
| `loop` | the driver (§6); the agent factory, which opens each lifecycle with `session/lifecycle`, writes and re-applies `agent/narrowing` (§4) and joins `Agent.own` work at disposal (§6) | anything extensions do; a queue or scheduler |

## 4. Canonical facts: the session log

The log is the single source of truth: `{type, seq, time, data}`, `seq === log.length`, frozen at append.

- **Three tiers** (`core/session/types.ts`). **Surface** kinds (`user/message`, `assistant/message`, `tool/result`) carry `surfaceOp` and `sourceEventSeqs`; model history is their fold. Every other kind is log-only: a **fact**, or **trace** (`TRACE_TYPES`) if nothing folds it at runtime; folds walk `Session.facts`, the log without its trace. An arriving `user/message` sits in an open turn; a range REPLACE may land between turns (`core/session/invariant.ts`).
- **Vocabulary: 35 kinds**, by owner. session: `turn/start|end`, `step/start|end`, `user/message`, `assistant/chunk|message`, `tool/call|dispatch|result`, `request/header|context`, `session/title|end-seed|lifecycle`; agent: `agent/options|narrowing`, `inbox/spliced`, `subagent/start|end` (the PARENT's log); `approval/asked|decided|grant|policy`; `sandbox/mode|acceptance`; presets: `authority/preset`; `compaction/start|applied|end`; `effect/recorded`; `job/start|end`; `llm/aux-call`; `composition/applied` (`capabilities/composition-record`).
- **Format** (`core/session/format.ts`): the header's `version` alone; a writer continues its own format, forks an older one, refuses a newer one (`SessionFormatError`, not damage). A change an older reader meets conservatively, or that leaves only the model less informed, is a note there, never a bump.
- **Every lifecycle opens with `session/lifecycle`** (after its `session/end-seed`, if any; `core/session/invariant.ts`): `dispatch` (a durable `tool/dispatch` precedes every body), `durability: 'synced'`, `salvage`. Readers use its claims, never its presence (`core/session/types.ts`).
- **The route is one fact in two records.** `agent/options` is the BASE; `request/context` the EFFECTIVE route, window and modalities per step (§6); a role rewrites header and context, never the base. Both `request/*` are written only on change; a field added to such a record reads as absent where never rewritten (`core/loop/driver.ts`).
- **The header** (`SessionHeader`) is immutable identity and lineage: fork, `delegatedByCallId`, `agentPreset`. **Opening facts** land before publication: `agent/options`, `approval/policy`, `sandbox/mode` (each `initial`), `composition/applied` (a delegated child's are §7's). **`agent/narrowing` is written once, in the first lifecycle's opening, and re-applied by every lifecycle**; a fold refuses one anywhere else (`core/agent/events.ts`).
- **The durable inbox** is `inbox/spliced`, op-shaped (`core/agent/events.ts`): a claim commits after the messages it entered, so a crash re-delivers, never loses; a turn its DISPOSAL stopped forgets its claim, the log still owing the prompt (`core/loop/driver.ts`). A job's end notice is never consumed unseen (`Inbox`); a disposing agent records late step input, quiet, and refuses a prompt. A resume wakes iff a WAKING insert was restored, a fork never (`core/loop/factory.ts`).
- **A job is a bracket outside every step** (`core/jobs/events.ts`): `job/start` once spawned, ONE `job/end`; its notice follows the end, only through the inbox.
- **Crash repair closes everything the log left open** (`repairTail`, `core/agent/repair.ts`): resume and cold fork run a STATIC list, innermost first: a delegation (`subagent/end{interrupted}`), a compaction, the turn (`repairInterruptedTail`), jobs LAST (`job/end{lost}`, a QUIET notice). Closers are pure (a cold read predicts a repair byte for byte) and state only what the log proves.
- **A synthetic result states the evidence** (`classify`, `core/session/repair.ts`): `TOOL_NOT_STARTED` only where the call has no `tool/call`, or has neither a `tool/dispatch` nor a recorded effect and the open turn's lifecycle claims `dispatch` and `synced`; every other owed call, and every one under salvage or a live writer (`heldByWriter`), is `TOOL_OUTCOME_UNKNOWN`, naming its recorded effects.
- **An effect is recorded by the code that caused it, after it happens** (`core/effects/events.ts`): `fs-local` and `shell-stdio` append `effect/recorded{fs-write | shell-command}` by `callId`. **Presence is proof; absence proves nothing.** No exactly-once (§13). `EffectIntent`, the "about to do" half, is never logged alone: only as a consent's `subject` and a grant's identity (§7).
- **A `session/event` listener may not append synchronously**: a nested append persists before its cause (`damaged` at resume); queue a microtask (`core/session/store.ts`).
- **Model-visible ⟺ logged.** Every request equals `deriveMessages()` plus the folded `request/header`; checked at `llm/stream` preflight (`core/loop/invariant.ts`).
- **Persistence is a subscriber** (`persistence-jsonl`): `sessions/<id>.jsonl` (§9) under ONE writer: a `.lock` lease from publication to disposal, reclaimed only from a provably dead same-host holder; **reads never lock**. A torn final line moves to `.torn`; deeper corruption is `damaged` and refuses attach. **A resolved `session/flush` is on stable storage** (`durability: 'synced'`); a failed write or sync fails every later flush.

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
- **An `agent/pre-step` listener may add to a batch, never create one**: an empty first step ends the turn (`core/loop/driver.ts`). `AGENTS.md` and the skill list enter so, never as a prompt section (§3).
- **Jobs** (`core/jobs/index.ts`): only a job's OWN end, with no stop asked for, may wake its owner, under the wake budget (`foldJobWakes`); other ends are quiet, and one a call reports (`reportedBy`) sends no notice. Headless and a child stop their jobs at idle (`app/headless.ts`).
- **Lifecycle** (`core/loop/factory.ts`): `dispose` = cancel → `whenIdle` → owned work → scope unwind (jobs stopped) → agent, then session, detach; a detached session refuses appends (`SESSION_CLOSED`). **Owned work** (`Agent.own`; the idle `/compact`) runs outside any turn: disposal aborts and joins it, bounded, so its end lands in an open log; a person's cancel and `whenIdle` ignore it.

## 7. Authority

The model proposes, policy decides, the effect boundary enforces.

- **One stamp.** `SandboxExecutionPolicy{mode, workspaceRoot}` resolves per call from `ctx.sandbox`, never caller-assembled; mode governs FILE EFFECTS only. The root is the immutable `SessionHeader.cwd`. `writableRoots(policy)` is a CEILING for `fs` and `shell`: grant less, never more (`core/sandbox/index.ts`).
- **Enforcement lives at the effect, not the gate.** `fs-local` canonicalizes and contains every write in process, refusing `FS_SANDBOX_DENIED` before any effect; reads always pass. It follows symbolic links itself (`core/sandbox/paths.ts`), checks the file it opened, not only the name, and cannot detect a hard link (§13).
- **Untrusted code is the shell's problem.** `shell-stdio/confine/` wraps the spawn: bwrap on Linux, Seatbelt on macOS, none on Windows (§13). Each is PROBED with its real `read-only` profile, and `enforcement` is recorded at agent creation (`enforcementFor`).
- **Spawn-time binding.** A backend wraps the persistent child once, under the session's policy; a durable `setMode` replaces it. An approved one-shot escalation and a job's process are throwaway children wrapped like any spawn (`danger-full-access` alone runs unwrapped) and reaped at disposal (`shell-stdio/process.ts`).
- **A record is not a fence.** `effect/recorded` (§4) sits beside the boundary; losing one loses evidence, never containment.
- **The escalation path.** A refusal is a fact with one legitimate move: the SAME command once more with `sandbox_permissions` (strictly wider) and a `justification`, `ctx.approval` consenting to that call. Under a backend a denial reads as a failing command; its words earn a hint, never a classification (`tool-shell`; §13).
- **Consent is to the runtime's record.** An ask's `subject` is an `EffectIntent` (§4) the REQUESTER builds from validated arguments, naming the authority the effect would run under; the model's `justification` stays in `reason`, clamped (§3), never in the subject, which `clampIntent` escapes.
- **Acceptance.** The `enforcement` beside a stamp is a HOST fact; `sandbox/acceptance` is a DECISION, `full` (default), `partial` or `none`, for exactly the mode it names (`core/sandbox/events.ts`). Read per call (`acceptsFor`), it relaxes the shell's REFUSAL, never a backend; the fs fence and ceiling stand. `--accept` sets the row's default; a weakened one is stamped per confinable mode at a top-level opening (`stampAcceptance`), a child's pin for its `forMode` alone.
- **A consent may outlive one call, never its lifecycle.** `approval/grant` is log-only, identified by `toolName` plus the exact subject's `intentKey`: a REPEATED IDENTICAL action, not a policy language. A grant is live only once its own ask is `allowed-once`, and until any `approval/policy`, `sandbox/mode`, `sandbox/acceptance` or `authority/preset` follows, or the lifecycle ends (`session/end-seed`: a resume or a fork asks again) (`core/approval/events.ts`). Only an offer the fold (`openApprovals`) still makes is minted, so no answerer buys one nobody was offered, and headless takes none; `grants` lists them, `revoke` ends one.
- **Every decision is durable.** The setter IS the event (`sandbox/mode`, `approval/policy`, acceptance, grants): `initial` before publication (§4), `change` only on change, sandbox `resume` when a resumed host enforces differently; `context-runtime`, never the service, tells the model. Precedence: approved one-shot escalation > recorded fold > composition default. `approval-headless` fails closed (`unavailable`) except under `--approve` or an exact `allow` entry.
- **A delegated child opens under a ceiling.** `tool-subagent` captures the parent's authority and stamps it in `setup`: the mode as a CEILING, approvals pinned `never`, acceptance `strictest(parent, row)` as a PIN. Widening is refused (`SANDBOX_CEILING`, `APPROVAL_PINNED`) and so is `setAcceptance` on any delegated session; narrowing is legal. A continuation keeps them: `fork` refuses a boundary below the opening stamps (§13). What the row NARROWS (its tool filter, hidden kinds, persona, the parent's own narrowing as a floor) is the child's `agent/narrowing` (§4), reaching a preset's own tools; scoping, not the fence.
- **A network tool asks per call and never reaches a child.** No backend confines the network, so a `NETWORK_TOOL`-tagged tool asks consent in its body before any byte leaves, with exact grants (`tool-web-search`); `tool-subagent`'s narrowing hides every such tool from a child by kind, whose `never` pin refuses it anyway (`core/tools/types.ts`; §13).
- **The browser is fenced, not consented** (`tool-browser`, deliberately not `NETWORK_TOOL`, so a child may use it). A harness process over a CDP pipe, never a port; a fresh profile; downloads denied. Inside Chrome, a proxy this process owns refuses all but loopback and row-config `allowHosts`, resolver rules leave it no other name, and `file:` loads pass only inside the workspace; a canary proves the fence per launch (`launch.ts`).
- **A job runs under the stamp its start resolved, never an escalation**, and a `change` of `sandbox/mode` or `sandbox/acceptance` ends its owner's jobs, a start in flight included (`core/jobs/index.ts`).
- **Presets select, the knobs decide.** `authority/preset` is a log-only intent written before `setMode`/`setPolicy`; the current preset is DERIVED (`core/presets`). A SET of switches, the wire's or a resume's flags, is held to a delegated session's ceiling and pins before any lands (`authoritySwitchRefusal`).
- **Consent-by-composition.** `approval/request` dispatches in the asking agent's scope, so a preset-mounted (§9) answerer can auto-approve for its own agent: code-equivalent trust, every pair audited. It cannot widen enforcement (the fence and shell resolve the global `SANDBOX`) nor reach a deployment-global registry.
- **`core-authority`** (`core/sandbox/invariant.ts`) refuses pre-commit a forged authority fact or subject, a second decision on one ask, a delegated session past its ceiling or pins, a grant naming no open `intentKey`-identical ask in this log, any grant in a delegated session or on a truncated subject, and a decision crediting a grant not live for its exact subject (`GrantFold`).

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
- **Trust.** `composition.json` is code-equivalent trust, never a persistence target. No workspace layer: a repository may say how it likes its code, never what the harness may do. `minidsh config` flags authority-sensitive rows a layer changed (`app/cli.ts`); an explicit authority flag is a durable per-session switch (`applyAuthority`) on every resume, a wire one included (`onResumed`), as its `opening`: after publication, before any wake.
- **Skills are data** (`capabilities/skills`): `SKILL.md` directories under user, bundled and repository roots, in that precedence; a repository skill never replaces another (`skills/README.md`). Above the cwd, a project root counts only where its marker and that marker's directory are this user's, never in a filesystem root (`ownProjectRoot`, skills and `workspace-instructions`).
- **Recomposition.** The spine `{session, llm, tools, prompt, agent, loop, persistence}` refuses removal or reconfiguration while agents are live (`app/compose.ts`).
- **Agent presets.** `agentPresets` in `composition.json` mount per-agent worlds on the agent scope, named in the session header so a resume or delegated child composes the same world (§7 for what they cannot reach).
- **Settings.** `agent` defaults: flags → `MINIDSH_MODEL` → `settings.json` → built-ins, read live per new session by a wire host (§8); on resume the log's route wins, and an explicit flag overrides it as `agent/options{resume}` (`core/agent/index.ts`).
- **Defaults.** Authority `workspace-write` + `ask`; `shell-stdio` `confinement: auto`. A shell child's environment is built, not inherited: the credential refs the mounted rows declared and `MINIDSH_*` removed, nothing for a name's shape (`core/process.ts`; §13). `tool-browser` is a default row that registers its tools only where Chrome, Edge or Chromium is found.
- **Packaging.** npm ships the `scripts/build.ts` emit as a binary, with no `main` or `exports` (BLUEPRINT §3).

**Retention: content is never swept; an affordance may expire.** `spill-local` sweeps spill once at load, never on disposal (a fork inherits its parent's locators).

| store | class | lifetime |
|---|---|---|
| `sessions/` (children too) | content, replay oracle | never removed by the harness |
| `attachments/v1/objects/` | content, shared by address | never removed |
| `spill/<session>/` (a job's output too) | affordance | age-swept at load, `cleanupPeriodDays` (default 30) |
| `browser/p-*` (a launch's profile) | affordance | removed at close; a dead owner's swept at the next launch here |

## 10. Verification

Tests mount real compositions; only the model is scripted or replayed (`test-support/llm-replay.ts`). E2E asserts the world where one exists.

- **Runtime invariants run in every test and live**; cross-capability claims on the full composition (`app.test.ts`); old real logs (`test-support/fixtures/`) are verified, repaired, salvaged, replayed.
- **Gates.** `pnpm check` and a packed-install smoke on 3 OSes (`check.yml`); a tag publishes (`release.yml`) only after it and an unfiltered `live.yml` passed its commit; a `MINIDSH_EXPECT_*` flag fails the skip it names.
- **Live arcs** (`pnpm test:e2e`): the OpenAI leg, its drift probe and `search` are LOCAL (`live.yml` holds no OpenAI or Tavily key).

| arc | what it proves |
|---|---|
| `live` | SIGKILL mid-call; repaired as cold `verify` predicts: `TOOL_OUTCOME_UNKNOWN` |
| `authority` | edits recorded, one outside refused; unconfined the shell escalates, confined it writes no host file; `read-only` refuses |
| `composition` | a disk composition's module tool runs; `settings.json` sets the route |
| `context` | reading compacts, citing exactly the shadowed seqs; AGENTS.md obeyed; spill read back |
| `routing` | DeepSeek → Anthropic, one route fact; a `compaction` role; signatures, encrypted reasoning, a tool-result image replayed |
| `delegation` | a child's escalation decided by its pin, not widenable; resumed over the wire, still narrow |
| `parallel` | one message's delegations overlap, results in model order, files written; replay binds by delegation |
| `verification` | a text-only parent's `view_image` refused; a role-routed child reads a test-drawn PNG |
| `search` | consent per query, subject exact; the URL written from sources shown; refusal `NETWORK_DENIED` |
| `web` | cookie sign-in; two clients, one host; a wire consent; paging to seq 0; a socket reset mid-turn |
| `jobs` | an own end wakes the idle owner; host killed mid-job: cold `verify` predicts `lost`, the model told; the Windows worker dies too |
| `skills` | PDF + CSV → `report.docx` via the office skill, read first; an outside reader agrees; replay byte-identical |
| `browser` | a runtime-only bug seen, fixed, re-verified via CDP; a verifier child screenshots test-drawn pixels |

**An arc's premise decays silently**: for its ONE separating assertion on model text, ask what a model knowing nothing would answer.

## 11. Where new things go

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: an `llm` adapter (§5) |
| a model-facing capability | `capabilities/tool-<x>` |
| a plugin's configuration | a strict `Plugin.config` schema (§2) |
| an execution world | `fs`/`shell` providers; tools untouched |
| a confinement backend | `shell-stdio/confine/` (§7) |
| an authority knob | a log-only event, a fold, a default (§7), as `sandbox/acceptance` (its pin, `auditLines`) |
| an authority preset | a presets-table entry (§7) |
| a capability, no code edit | a `composition.json` row (§9) |
| a user default | `core/settings` if the wire sets it, else row config |
| a secret | a `CredentialRef` (§3) |
| a per-agent bundle | an `agentPresets` list (§9) |
| a policy/answerer | `tools/pre-execute`/`approval/request` listeners (§6) |
| durable state | an event kind (§4) |
| an event's human line | `app/present.ts` AND `app/web/rows.js` |
| context for the model | `agent.inject()` or `agent/pre-step`, never prompt text |
| model know-how | a `SKILL.md` directory: data, never code or authority |
| a surface | `app/` or a package under the §8 contract; no semantics |
| a carrier | a protocol `Carrier`: framing, flow control only |
| a named place to work | a `workspaces` entry: addressing, not a grant |
| a remote client | the §8 attach contract |
| a per-agent variant | `agent.ctx` (`world` if inherited, else `setup`), or a liftable `TOOLS.restrict` |
| a narrowing continuations keep | `CreateAgentOptions.narrowing` (§4), never `setup` |
| a resumer's switches | `ResumeAgentOptions.opening` (§3) |
| a delegated child | `tool-subagent` (§7) |
| context management | a `core/compaction` provider, keeping the pairing rule (§6) |
| a context-pressure number | `core/metering`: the one pure fold |
| oversized tool output | `spill`, via the producing tool (§3) |
| an attachment kind | raster: an `attachments-local` probe; else `AttachmentRef`, `ModelModality`, `ContentBlock`, serializers, meter |
| a network tool | a `tool-<x>` tagged `NETWORK_TOOL` (§7) |
| an image producer | `core/llm/admission.ts`, then `attachments.saveImage` (§5) |
| a spawned process | `core/process.ts`: the environment rule, the tree kill |
| a second browser provider | a `core/browser` Definition first |
| a verifier | a `tool-subagent` row + `model-roles` entry |
| a model role | a `model-roles` entry; never the base route (§4) |
| an out-of-loop model call | `resolveCallConfig` + `runAuxCall`, never bare `llm.stream` |
| recall of shadowed history | `tool-history` (§6) |
| a tool KIND | a `ToolDefinition.tags` constant, not a name |
| a store's lifetime | a retention row (§9) first |
| an effect worth recording | a `core/effects` kind (§4), written by the PROVIDER |
| its consent subject | an `EffectIntent` naming its AUTHORITY (§7) |
| a durable pipeline step | `ToolCall.onDispatch`: cannot replace the body (§6) |
| an overlapping tool body | `concurrencySafe` (`core/tools/types.ts`), never its own pool |
| work that outlives its call | `jobs.start` with a `launch`, never a detached promise |
| work an agent owns outside a turn | `Agent.own` (§6), never a detached promise |
| a background producer | a world's `start` (§3); a second kind changes `JobKind` |
| a session's name | `session/title` (§4), written by `session-title` |
| a whole-log check | a pure `check*Log` beside its owner's invariant, composed by `app/inspect.ts` |
| a format change | `core/session/format.ts` |

No row here → an architecture question first.

## 12. Divergences from DeepSeek Harness (the ones that still shape decisions)

Upstream mechanisms and verdicts at the pin: `references/assumptions.md`.

- **Substrate.** Own kernel, not Cordis: two composability properties in five mechanisms (§2); one package plus a dependency gate (§1).
- **Concurrency.** Joined at the step, as DSH's batch (one ordered lane, pooled bodies, model-order results), but a child stays a foreground body: done is "idle", a cancel reaches it (DSH: an async activation settling through the inbox, beyond Stop); replay binds a child by its delegating call (DSH: first-call order). Owner-scoped jobs, waking bounded, a lost one closed and told (DSH: unbounded; left open).
- **The wire.** DSH's JSON-RPC SDK shape, bounded, unseen approvals settling `unavailable` (§8).
- **Consent.** A trusted `subject` and the joined call on every ask (DSH: model prose); exact-subject session grants; accepting `none`.
- **Confinement.** bwrap and Seatbelt, each probed even alone; no Landlock (it needs a native launcher) or Windows backend (§13); a shell child's scrub by declared name (§9).
- **The ceiling.** The workspace root alone (why: `core/sandbox/index.ts`; DSH adds temp and operator roots).
- **Durability.** A durable `tool/dispatch` after the gate, recorded effects, a write lease and per-lifecycle writer claims over plain JSONL (DSH: no top-level dispatch; checksummed generations naming no writer).
- **Delegation and routing.** An enforced ceiling (DSH: a seeded pin); a continuation re-applies the child's RECORDED narrowing (DSH: its descriptor under the saved preset, else the host's composition); `subagent/start|end` in the parent's log, closed by repair (DSH: neither); `delegatedByCallId`; model roles over a durable base route.
- **Context.** No tool-result pruner (tools bound their output); recall gated, not opt-in (§6).
- **Surfaces.** A terminal ships (§8); DSH deleted its own.
- **Providers.** Snapshot catalogs, conservative facts for an unknown id (§5; DSH: live `GET /models`).
- **Web.** One opt-in search tool, consent per query, structured sources, no fetch (DSH: both default, unconsented).
- **Browser.** Default where found, a pipe, fenced and proved per launch (§7; DSH: experimental, unfenced).
- **Skills.** A listed path read with ordinary tools (DSH: a mandatory `skill` tool); a repository skill never shadows; documents on Node alone.

## 13. Known limitations (current)

**Authority**

- No Windows confinement backend, by decision (DSH's is `partial`: a hard-link escape, standing ACL changes): until a session accepts `none` (§7) each command escalates to the unfenced `danger-full-access`; a child (pinned `never`) runs none.
- A tree kill misses a timed-out or backgrounded POSIX command's descendants under an unwrapped persistent child.
- On Windows a kill-on-close Job per pwsh ends an approved one-shot's descendants with the call, the persistent shell's with the shell (POSIX: the session); a process made by WMI or the Task Scheduler, one asking to break away, and all under Constrained Language Mode (one warning) escape it (`shell-stdio/process.ts`).
- On Windows each pwsh start logs the containment body, never the command, as suspicious (`shell-stdio/process.ts`); security tooling may flag it.
- A job's process tree outlives a killed host (SIGKILL, any `serve`/`web` stop) except under bwrap and on Windows: it reads `lost`, never re-adopted or killed.
- **The fs fence races a concurrent process**: a link swapped in mid-write can leave an EMPTY file or directory outside (never content on Linux; best effort elsewhere).
- **A hard link defeats both fences**: an outside inode linked into the workspace is written through by the fs fence and a confined shell; linking one in, or writing its outside path, stays refused (`confine.test.ts`).
- **Parallel children share one checkout**: `fs-local`'s lock and version check order only this process's `fs-local` writes, never a shell's or a job's.
- `full` is the probe's PROFILE claim, never measured per call; an unrun probe leaves its process unconfined-refusing until restart.
- Under bwrap a path beneath the ephemeral `/tmp` is invisible, so its denial gets no hint; macOS has no writable temp: a tool needing one escalates.
- After a live `reconfigure` of `shell` (outside the spine, §9), `enforcementFor` and a stamp describe a world no command runs in.
- A shell child's environment withholds variables, not credentials (§9; `core/process.ts`): undeclared secrets, `SSH_AUTH_SOCK` and proxies pass; `credentials.json` is readable, the network open.
- A network tool is consented, never confined or recorded (§7); headless, only `--approve` allows one.
- `tool-browser` reaches EVERY loopback service, in any mode and from a child, unconsented, unrecorded and unwrapped by a shell backend; such a service may act or relay on its own authority.
- On Windows a project marker above the cwd is never owner-checked; only a filesystem root's is refused (§9).
- A module-loaded plugin is arbitrary code; `minidsh config`'s warnings are advisory.
- The web UI takes an offered grant scope but cannot list or revoke one.

**Context**

- Under DeepSeek's default 1M window only overflow recovery fires unless `budgetTokens` is set.
- A summary can be wrong, and nothing makes the model call `history_read`.
- The meter sees a prompt or tool-set change a step late and charges images on text-only routes; a smaller role may be asked to summarize past its cap.
- Workspace instructions are read once per entry, not watched.
- A notice the wake budget held waits for a human message; the terminal and browser flag it.
- An unreadable user or bundled skill root freezes the skill list; no `/name` invokes a skill.
- Document skills check content, not appearance; `office` refuses a package past 2M nodes a pass or 256 levels (`ooxml.mjs`).

**Sessions and stores**

- The in-memory log keeps trace: 400 turns are tens of MB of heap.
- A long-running host's spill is swept only at restart (§9); a repeated `callId` overwrites.
- A lost attachment is turn-fatal (`ATTACHMENT_UNREADABLE`); image validation is header-only; no client upload; the image bound counts the surface until compaction.
- `tool-browser` shows no cross-origin frame's content and uploads no file.
- No session deletion or search index (refused, BLUEPRINT §2), rename or model-written title (projections past `persistence.list()`).
- **Crash repair is as sharp as the lifecycle (§4)**: without `synced`, "not started" holds only for a process crash; under salvage, closers are placeholders and damage between turns is invisible to the model (the CLI warns).
- Effect records are no inventory (`core/effects/events.ts`): one may over-report a shell that died between commands or follow an abandoned body's result (§6).
- `synced` is as honest as the disk; Windows cannot sync a new log's directory; after a power cut a zero-filled tail reads torn, earlier zeros damaged (`--salvage`).
- `verify` reads structure, surface messages and its report's folds, no other payload.
- A fork boundary may split a compaction bracket from its replace; `fork --at` refuses a boundary inside an open turn or below a delegated child's opening.

**Surfaces**

- `session/events` has no host ceiling (any range), no RPC deadline or client timeout; backpressure limits are unmeasured.
- `session.view`'s `status` goes stale; a reconnect loses its paging position and a sole watcher's pending approval; only `control.summary` announces disposal.
- Detaching one session narrows an un-narrowed client to nothing (`protocol/connection.ts`).
- A pooled step's result lines match calls by order, not name, on plain-text surfaces and the browser (S22).
- `minidsh web` has no graceful stop: the next process repairs and reclaims the lease.
- `workspaceRoots` is always `[cwd]` and bounds only NEW sessions: a wire client may resume one outside it.
- One principal, no accounts; the browser cannot switch a session's route.
- Windows needs `pwsh` 7, never 5.1; a command reading stdin blocks until its deadline.

**Delegation and providers**

- A child's cost is summed in `subagent/end` (none if repaired), not the parent's meter.
- A child delegated before S21.1 or continued by 1.2.0 runs un-narrowed, ceiling and pins intact (`core/session/format.ts`).
- A step is never preempted: a steer waits for its slowest pooled child; a person stops all its children (a turn cancel) or none.
- Disposal waits at most `ownedWorkBoundMs` (10 s) for owned work; work ignoring its signal is abandoned, its later records meeting a closed log.
- A replay reproduces decisions, not the workspace: an absolute path misses a fresh root, yet `assertConsumed()` passes (arcs pin relative paths).
- An installed-package plugin (§9) reaches seams only by deep path into `dist/`, proven only by an in-repo fixture.
- OpenAI's drift probe holds only effort sets and defaults. An Anthropic id lacking its minor version's row gets 200K with images; an account enforcing an unedited prefix before signed thinking may refuse a compacted 5.x session's later steps.
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
skills/      office/ · pdf/: bundled skills (README: helpers, authoring, provenance)
scripts/     build · check-deps (+ deps-graph) · check-docs · doc-registers · count-lines · smoke-installed.sh
.github/     workflows/ (check, live, release) · ISSUE_TEMPLATE/ · PULL_REQUEST_TEMPLATE
(root)       bin/minidsh.js (the entry point) · README · CLAUDE · CONTRIBUTING · SECURITY · CHANGELOG · CODE_OF_CONDUCT · LICENSE · NOTICE
docs/ · references/ · .claude/   named in CLAUDE.md §4, §5, §8
```

`scripts/count-lines.ts` measures the tree; the 1.0.0 line counts are in BLUEPRINT §4.
