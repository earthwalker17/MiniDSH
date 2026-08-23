# MiniDSH Architecture

MiniDSH is one runtime composed from plugins over a tiny kernel. Everything the model can see is derived from an append-only session log; everything the model can do goes through a guarded tool pipeline and is fenced at the effect boundary by an authority the log records; every surface (the headless CLI, the JSON-RPC client protocol and the interactive terminal riding on it, GUIs later) only renders the log and drives the agent registry — and a session survives its process: resume attaches to the stored log append-only and continues. The reference it re-derives from is DeepSeek Harness (DSH); §12 lists where MiniDSH deliberately differs.

## 1. Layers and dependency direction

```
src/app/           application assembly + surfaces: compose.ts (rows + patches), headless.ts, cli.ts,
                   serve.ts (protocol host), terminal/ (interactive client), home.ts
src/capabilities/  providers and consumers over core seams (never import each other, never app)
src/core/          the spine: Service Definitions + default drivers as plugins
src/kernel/        composition substrate: Context, plugin lifecycle, services, effects, events
src/test-support/  scripted adapter, replay-from-log adapter, composition harness
```

Dependencies point downward only, enforced by `scripts/check-deps.ts` (part of `pnpm check`):

| from | may import |
|---|---|
| `kernel` | nothing internal |
| `core/<x>` | `kernel`, other `core` contracts — **except `core/loop`, which nothing imports but `app`** |
| `capabilities/<x>` | `kernel`, `core` (Definitions only; providers never import other providers or consumers) |
| `app` | anything |
| `test-support`, `*.test.ts` | their own layer and below; `test-support` may import `app` to mount real compositions |

A deeper tree is not more architecture: the layers are the whole topology, and a capability is a directory, not a package. A workspace split is planned for the first out-of-process consumer (protocol client, browser client).

## 2. Kernel (`src/kernel`)

The kernel realizes the two composability properties from the Cordis paper with the smallest mechanism set DSH actually relies on:

- **Context** — a non-mutating tree. `child({scope?})` derives a context carrying a scope tag; registrations made through a context are attributed to it and unwound with it (registration context = visibility = lifetime). Scopes are flat: a child beneath a scoped context inherits that scope and cannot be re-tagged. A scope disposed early releases its record on the parent. Root-derived scopes read any service; a scope derived from a plugin context shares that plugin's declared reads (it cannot widen them), because reload tracking is keyed on `inject`.
- **Services** — `provide(key, value)` is an effect; a key is claimed once per context chain (a child may shadow). `get(key)` is strict: a plugin may only read keys it declared in `inject` or provided itself (its own key is readable, from the plugin context or its scopes, while it is still loading); `tryGet` is the optional read. Keys are typed tokens (`serviceKey<T>('sessions')`), not declaration merging.
- **Plugins** — `{ name, inject?, apply(ctx, config) }`. An instance is `pending` until every injected key is provided, then `loading → active`. Its activation epoch is the tuple of providing instances; when a dependency disappears the plugin unloads (effects unwound), when a provider is replaced it reloads. Transitions are serialized per instance. A provider's effects unwind before its dependents unload, so a disposer must not read the services its plugin injected. `settle(filter?)` waits for root-wide quiescence and reports the plugins still pending with their unmet keys so boot can fail loud; `filter` narrows the report (e.g. to the plugins mounted under one scope, via `PluginHandle.scope`).
- **Effects** — `effect(fn → disposer, label?)` pushes onto the owning instance's disposer stack; disposal is strict reverse order (temporal composability).
- **Events** — typed tokens carry their dispatch mode: `emit` (sync notification, listener exceptions contained), `waterfall` (around-middleware; listeners receive `next()` and may short-circuit), `serial` (awaited in order), `parallel` (`allSettled`, aggregate error). Dispatching with the wrong method is a compile error. A dispatch may carry a `scope`: it reaches unscoped listeners, `global: true` listeners, and the listeners of that same scope — a scoped listener observes its own subject only and never sees a dispatch about another scope or about none. `observe(hook)` sees every dispatch before delivery — the seam runtime invariants hang on; `prepareEmit` splits that preflight from delivery so an observer can reject a fact before it is committed.

There is no loader, HMR, isolate realm, proxy, mixin, or accessor. Registries take the owner context explicitly (`tools.register(ctx, def)`) instead of inferring it through a proxy.

**Scope contract** (`core/scope.ts`). Registration origin decides visibility and lifetime together: through an unscoped context → deployment-global; through an agent's `ctx` (or a plugin mounted on it) → that agent's layer, unwound with it. Tool definitions, guards, prompt sections and variables are layered: a view is the globals plus exactly one agent layer, a local entry shadows a same-named global, and there is no inheritance between scopes. Every event about an agent's operation is dispatched in that agent's scope — `agent/*`, `tools/*`, `approval/request`, `system-prompt/assemble`, `fs/*` — so a listener registered through agent A's context never sees agent B. Subject-less seams (`llm/stream`, `session/*`) and registry-membership notifications (`tools/change`, `agent/created|disposed`) are unscoped and reach only unscoped (or `global`) listeners; a per-agent plugin that needs them registers globally and filters by id. Consumers receive the agent as the operation subject (`tools.get(name, agent)`, `prompt.assemble(agent)`, `FsActor.agent`) and never read services through `agent.ctx`. A per-agent execution world is composed by mounting plugins on `agent.ctx` during `setup`; a service provided in that scope's realm is seen by those plugins alone. Adapter and invariant registries are deployment-global. A scope tag must be an object (the `Agent` itself); a string tag is refused rather than filed globally.

## 3. Core contracts (`src/core`)

| ctx key | owns | must not own |
|---|---|---|
| `sessions` | `Session` = header + append-only log + surface + derivation; commit is validate → observe → push → deliver, so an invariant rejects a malformed event before it enters the log; store `create/publish/get/list/flush/detach` — `publish: false` defers announcement (the session claims its id and blocks duplicates but is invisible to `get`/`list` and detaches silently; the factory uses this so **session publication follows agent publication** and a rolled-back creation is never announced); `Session.origin` (`new | seeded | resumed`, live-only, never in the durable header) tells a persistence provider how to write at publication; events `session/created` (= published), `session/event` (contained), `session/flush` (parallel durability checkpoint), `session/disposed`; seed construction marked by `session/end-seed` (one per seeded lifecycle — a resumed log accumulates one per pickup); crash repair (`repairInterruptedTail`, applied by resume/cold-fork); the pure `deriveEventMessage`, `foldRequestHeader`, `sliceForkSeed` | persistence backends, UI state, the model |
| `persistence` | the read Definition over stored logs: `load(id) → StoredSession {header, events, damaged?}` (the contiguous readable prefix; `damaged` marks corruption deeper than a torn final line), `list()` newest-first — so resume/fork/CLI read stored sessions without importing a capability | the write path (a provider subscribes to `session/*` and owns its format and attach behavior); repair semantics |
| `llm` | provider-neutral vocabulary (§5); adapter registry; `stream(request)` as the `llm/stream` waterfall whose terminal continuation looks up the adapter; normalization of adapter failures into a terminal `finish{error|aborted}`; the stream-protocol validator; `BlockAssembler`; `resolveModel(provider, model)` | API keys, session state, the default model (application assembly) |
| `tools` | `defineTool` (zod input → JSON Schema; zod output; `render(args, value)`; `execute(args, exec)`; `presentCall?`; `timeoutMs?`); `register(owner, def)` and `guard(owner, g)` layered by owner scope; `schemas(agent?)` and `get(name, agent?)` with the viewing scope passed explicitly; the execution pipeline (§6), dispatched in the acting agent's scope, its deadlines, and total error normalization (an error that names its own `code` keeps it) | policy |
| `prompt` | ordered named sections and strict `{{var}}` variables, both layered by owner scope (a scoped section shadows a same-named global — a subagent persona); exactly one `complete` section (restored after the waterfall); tool-schema provider; `assemble(agent)` → `system-prompt/assemble` (in the agent's scope) → `{system, tools}`; sections are stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request({agent, toolName, callId?, reason?, signal?}) → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` over the `approval/request` waterfall (default `unavailable`); answerers see `ApprovalPrompt` = request + `id`, the same id as the `approval/asked` audit event (its seq — stable across resume and fork); the seam settles `cancelled` on the signal even if no answerer ever does; audit pair `approval/asked` / `approval/decided`; the durable `ApprovalPolicy` (`ask` \| `never`) with `setPolicy`/`policyFor` — `never` decides `rejected` **before** dispatch, so no answerer composed later can reopen the gate | answer logic |
| `fs` | `resolve(path, cwd)`, `stat`, `readText`, `writeText(target, text, intent)`, `listDir`; the `fs/edit-intent` single-slot waterfall (read-before-edit supplies the expected version or refuses) and the `fs/observed` live emit, both in the actor's agent scope; `FsError{code}`; and the contract that a provider **fences every mutation** with the acting session's sandbox policy before any effect (`FS_SANDBOX_DENIED`), while reads always pass | tool schemas; the policy itself |
| `shell` | `sessionFor(agent) → ShellSession{exec, restart, dispose}` where every `exec` carries the caller's resolved `SandboxExecutionPolicy` and every result reports the `enforcement` it actually got; `enforcementFor(mode)`; the provider owns the process table, binds each shell's disposal to the owning agent's context, and must REFUSE (`SANDBOX_UNAVAILABLE`) a confined policy it cannot enforce | model-facing descriptions; negotiation |
| `sandbox` | the one authority stamp — `SandboxMode` (`read-only` \| `workspace-write` \| `danger-full-access`), `SandboxExecutionPolicy{mode, workspaceRoot}`, and the pure `writableRoots`/`allowsWrite` every fence derives from; `canonicalPath`/`isInside` (one canonicalization for the whole system); `resolve(request)`, which records the effective stamp when it differs from the last one; `setMode` (the durable switch); `enforcementFor(mode)`, asked of the mounted execution world; `sandbox/mode` and its fold | enforcement backends; what any particular tool may do |
| `agents` | `Agent{id, session, status, ctx, send/followup/steer/inject, cancel, whenIdle}`; `AgentHandle{agent, dispose}`; registry `create/resume/fork(owner, …)/get/list` through the registered factory — creation is a transaction (session unpublished, scope, agent, `setup`, register agent, publish session; any failure rolls back unannounced) and one memoized disposal is bound to both `owner` and the loop plugin that owns the scope, so whichever dies first runs cancel → idle → unwind scope → detach agent → detach session. `resume(owner, id)` = `persistence.load` (refusing `damaged`) → repair → seed → the same transaction with `origin:'resumed'` and provenance from the stored header; model config = caller overrides > the log's folded `request/header` > surface defaults; the store's duplicate-id throw is the liveness guard. `fork(owner, source, boundary?)` slices a live session as-is or a stored one after repair into a child with `parentId`/`seedLength`. The durable inbox (`inbox/spliced` op records + `foldInbox`) restores silently at attach; the factory wakes a resumed agent iff waking work is pending. The `agent/*` event vocabulary | the driver |
| `invariants` | `register(owner, name, installer)` in a child context; selection by config; pre-commit validation through kernel `observe` applied on publication | product logic |
| `loop` | the driver (§6); registers itself as the agent factory | anything extensions do |

Agent id = session id. A capability seam is complete only with all three roles: Definition (core), Provider (capability), Consumer (capability, usually a tool).

## 4. Canonical facts: the session log

The log is the single source of truth. Envelope `{type, seq, time, data}`, `seq === log.length`, data JSON-lossless and deep-frozen at append. The three **surface** events — `user/message`, `assistant/message`, `tool/result` — additionally carry `surfaceOp: 'append' | {op:'replace', start, end}` and `sourceEventSeqs`; model history is the fold of surface nodes through `deriveEventMessage`, never a filter over raw events. This is what lets a later compaction provider replace a range without mutating history.

Vocabulary: `turn/start`, `turn/end{reason}` (`completed | blocked | cancelled | error | max-tokens | max-steps | interrupted`), `step/start`, `step/end`, `user/message`, `request/header{provider, model, reasoningEffort?, maxTokens?, temperature?, system, tools; reason: initial|change|resume}` (a header changing at the first step of a resumed lifecycle logs `reason:'resume'`; an unchanged header logs nothing, so the provider prefix cache survives restarts), `assistant/chunk{turn, step, attempt, chunk}` (replay/UI fidelity, never derived; a retried step logs each attempt under its own `attempt`), `assistant/message{message, usage?, interrupted?}`, `tool/call`, `tool/result`, `inbox/spliced`, `approval/asked{id}`, `approval/decided{id, outcome}`, `approval/policy{policy, reason}`, `sandbox/mode{mode, enforcement, reason}` (§7), `session/end-seed`. The header `{version, id, createdAt, cwd, parentId?, seedLength?}` lives beside the log, not in it. `SESSION_FORMAT_VERSION = 0`.

**The durable inbox.** `inbox/spliced` is log-only, op-shaped — `{op:'insert', queue, message, waking?} | {op:'claim', steps, turns} | {op:'clear'}` — never positional: claim drains counts from the *front*, so the fold stays correct when a steer logged during the pre-step await lands before the deferred claim record. Discipline: inserts and clears log at mutation time; the claim record is committed *after* the entered `user/message`s (a crash inside the pre-step window re-delivers a prompt on resume — the accepted failure mode is a rare double-delivery, never a loss) or with the block/stop that consumed it; a disposed-cancel does **not** durably clear (graceful teardown preserves the queue for the next resume — a user/hook cancel does), and an empty clear logs nothing. `foldInbox(events)` reconstructs both queues; the driver restores them silently at attach. The vocabulary is merge-extensible: an unknown event type loads as an opaque log-only record and is skipped by derivation (a client applies the same default), while the three surface kinds are closed and session-owned — a plugin that needs durable state adds a log-only kind, never a surface kind. Changes to the vocabulary are additive.

**Model-visible ⟺ logged.** Every request the loop sends equals `deriveMessages()` plus the folded `request/header` — every model-visible field outside `messages` (provider, model, system, tools, effort, maxTokens, temperature) is in the header, and adding one to `LlmRequest` means adding it to the header and its canon; a runtime invariant rebuilds both at `llm/stream` and fails on any divergence. Persistence is a subscriber, stored under `MINIDSH_HOME` (default `~/.minidsh`) as `sessions/<id>.jsonl` with the header as line 1: publication decides the write mode — a `resumed` session **attaches** to its existing file append-only (an offset-tracking scan; a torn final line, the expected crash artifact, moves to a `<id>.jsonl.torn` sidecar rather than being destroyed; corruption deeper than that marks the store `damaged` on read and refuses attach), everything else snapshots header + events-so-far (the fresh/fork path). `session/event` → append one JSON line; `session/flush` awaited at turn end, where a swallowed write error is rethrown; `session/disposed` of a session that never recorded a fact removes its header-only file — and since publication follows agent publication, a rolled-back creation writes nothing at all.

Prefix stability is a corollary, not a feature: because the log is append-only and the header is written only when it actually changes, consecutive requests are append-extensions of their predecessors. The Session 1 live run showed this directly — one `request/header` across seven steps, and 18,816 cache-read tokens against 3,372 uncached input tokens.

## 5. LLM vocabulary and the DeepSeek adapter

`Message{id, role: system|user|assistant, content: ContentBlock[], source}` where a tool result is a user-role message with `source{kind:'tool', callId}`. `ContentBlock = text | reasoning | tool-call{id, name, arguments: string} | tool-result{toolCallId, content, isError?}`. The stream is a closed union `block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish{reason}` with `reason ∈ stop | tool-calls | max-tokens | aborted{failure} | error{failure}` and `LlmFailure{message, code, status?, retryAfterMs?, requestId?}` — codes, never message text, are what policies route on. Protocol invariants: usage before finish, exactly one finish, deltas only into open blocks.

Adapters implement `stream(request)` and `resolveModel(model) → {contextWindow, defaultMaxTokens, reasoning:{efforts, defaultEffort?}}`; effort ids are adapter-owned and opaque elsewhere. The DeepSeek adapter speaks the OpenAI-compatible `POST /chat/completions` with `stream: true`, `stream_options.include_usage`, `thinking` + `reasoning_effort`, passes `reasoning_content` back on every reasoning-carrying assistant message, serializes assistant `content` as `""` never `null`, keys tool-call fragments by wire index, and defers block ends, usage, and finish to the `[DONE]` sentinel. Retry is a capability on `agent/request-error`, so failed attempts are durable.

## 6. The loop and the tool pipeline

```
followup(m) → next-turn FIFO (wakes)   steer(m) → next-step (wakes)   inject(m) → next-step (no wake)
turn/start
  claim → agent/pre-step (waterfall: reject | enter{messages})   reject ⇒ turn/end{blocked}
  step/start → user/message per entered message
  prompt.assemble → agent/request → request/header when changed
  llm.stream(frozen request) → assistant/chunk{attempt}* → assistant/message{usage}
       finish error ⇒ agent/request-error (waterfall) → retry (next attempt, same request) | turn/end{error}
  tool calls in model order: tool/call → tools.execute → tool/result      (cancel ⇒ ABORTED_BEFORE_DISPATCH results)
  step/end → next step while tools owe a request or next-step input exists (≤ maxSteps)
  agent/turn-stopping (serial) → re-read inbox
turn/end{reason} (exactly once) → session/flush → next turn or idle
```

`agent/status` is emitted only on real `idle ↔ running` transitions; one `AbortController` per turn; `cancel(cause)` clears the inbox and aborts; `whenIdle()` is quiescence; dispose = cancel → whenIdle → unwind scope → detach agent → detach session. One `send()` never shares a turn with another.

Tool execution (every event in the acting agent's scope): validate args → `tools/pre-execute` (`allow | deny | ask`; `ask` → `approval.request`, anything but `allowed-once` denies) → monotonic deny-only guards (globals, then the agent's) → **deadline armed** → `tools/execute` (around-middleware over the body) → body → validate + freeze value → `render` → `tools/post-execute` (`accept{content?} | block{feedback}`) → normalized `ToolExecutionResult` → `tools/result`. Every throw becomes an `isError` result with `Error: …` content and `{name, code}` — an error that names its own `code` keeps it, so a policy denial reads as `FS_SANDBOX_DENIED` in the durable record. Only `{name, description, parameters}` of a tool ever reaches the model.

**Deadlines are the pipeline's, not a plugin's.** `ToolDefinition.timeoutMs` declares a budget (omitted takes the registry default, `null` opts out) and the registry enforces it, because the kernel waterfall passes `next()` no arguments — a `tools/execute` middleware cannot substitute the signal the body will see. The clock starts *after* the gate, so a human deliberating over an approval never spends a tool's budget; when it fires the call ends as `TOOL_TIMEOUT` and the body's signal is aborted so it can release what it holds, and a late result is discarded. It is a backstop: a tool with something useful to say about running out of time owns a shorter deadline itself, as the shell executor does (it kills its child and returns the tail).

## 7. Authority

The model proposes, policy decides, the effect boundary enforces, and every decision is a fact in the log. Authority is one plane with four parts.

**One stamp.** `SandboxExecutionPolicy{mode, workspaceRoot}` is resolved per call from `ctx.sandbox`, never assembled by a caller, and shared by every execution world. The mode vocabulary is `read-only | workspace-write | danger-full-access` and governs FILE EFFECTS only — network and process visibility are outside it, so these modes are not a general-purpose security boundary. The workspace boundary needs no event of its own: the immutable `SessionHeader.cwd` recorded at creation IS the root for every call in that session. `writableRoots(policy)` is the one allow-list both families derive from, so no two worlds can disagree about what `workspace-write` means. Precedence: an approved one-shot escalation > the session's folded `sandbox/mode` > the composition default.

**Enforcement lives at the effect, not at the gate.** `fs-local` fences `writeText` in process: canonicalize, contain, refuse with `FS_SANDBOX_DENIED` before ANY effect (creating a parent directory is already one), then canonicalize and contain again immediately before the write, because only the last check governs it. It is a check in trusted code over a model-controlled path — the operations are the seam's own and only the target is untrusted, so canonicalize-then-contain is the complete answer for that surface. Reads always pass. Because the fence is inside the provider, no tool can be the boundary and no tool needs to know about one; there is no policy plugin at `tools/pre-execute` at all (that seam remains for operators and hooks).

**Kernel-grade isolation of untrusted CODE is the shell's problem, and MiniDSH has no backend for it.** `shell-stdio` enforces nothing, says so through `enforcementFor(mode) → 'none'`, and REFUSES a confined policy with `SANDBOX_UNAVAILABLE` rather than running unconfined: silent passthrough is never legal for a mode the host cannot deliver. The executor never negotiates. The refusal is a reported fact, not a tool failure, and it carries the one legitimate move: the model may retry the SAME command once with `sandbox_permissions` (strictly wider) and a `justification`, `ctx.approval` is the consent step, and the grant covers that one call — it is never recorded as a session switch, so the audit reads it as the `approval/asked{callId}` → `tool/call{callId}` join it is.

**Every decision is durable.** `sandbox/mode{mode, enforcement, reason}` and `approval/policy{policy, reason}` are log-only, folded by `findLast`, and written only when they change — the same discipline as `request/header`. Resolving a policy IS the audit act: the stamp is recorded when it differs from the last one, so every effect is preceded by a recorded stamp without eagerly stamping a session that never acts. A switch IS its event; nothing mutates authority out of band, and a resumed session keeps what it recorded rather than inheriting the deployment default. `ApprovalPolicy` is `ask | never`, and `never` decides `rejected` inside the service before dispatch, so an answerer composed later cannot reopen the gate. The audit pair `approval/asked`/`approval/decided` is logged with a durable id a remote answerer echoes back, cancellation is owned by the seam, and `approval-headless` answers `allowed-once` only under `--approve` — otherwise the fail-closed `unavailable` stands. `minidsh sessions show <id> --audit` projects the whole plane back out of any stored log.

The `core-authority` invariant rejects a forged `sandbox/mode` or `approval/policy` before it enters the log and holds every approval to exactly one decision.

## 8. Surfaces

A surface is a plugin (or app entry) that injects only `agents` and `sessions` — plus `llm` for the catalog handshake and `sandbox`/`approval` for the authority control plane — owns transport and process exit, and renders from `session/event`. It holds no authority state of its own: a switch it asks for becomes a durable event it then reads back like any other. Two surfaces share the one runtime:

- **The headless CLI**: `minidsh run "<task>"`, `minidsh resume <id> "<task>" --headless`, `minidsh fork <id> "<task>" [--at seq] --headless` — boot → `settle()` → `agents.create/resume/fork` → `followup` → `whenIdle` → `flush` → last assistant text on stdout, exit 0 iff the turn completed. `--json` streams `{sessionId, event}` frames (`SessionEventFrame`, defined once beside the vocabulary); `--sandbox <mode>` / `--ask <ask|never>` set this run's authority (explicitly given, they are applied as a durable switch, so they also govern a resumed session that recorded something else); `minidsh sessions list/show` read through the persistence Definition on a bare composition, and `sessions show <id> --audit` projects the authority timeline.
- **The client protocol** (`capabilities/protocol-stdio`): newline-delimited JSON-RPC 2.0, DSH's SDK-protocol shape. Requests `initialize {} → {serverInfo, providers (Llm.providers()), defaultAgentOptions, defaultAuthority}`, `session/prompt {sessionId?, text, mode?: followup|steer, agentOptions?, cwd?} → {sessionId, messageId}` (absent id creates; live id delivers; stored id resumes — an in-flight table makes racing prompts share one resume), `session/events {sessionId, fromSeq?}` (history for an attaching client; live log or `persistence.load`), `session/cancel`, `approval/answer {sessionId, id, outcome} → accepted|not-pending`, `session/authority {sessionId, sandbox?, approval?} → {sandbox, approval, enforcement}` (no arguments reads; each switch IS its durable event), `shutdown` (dispose-to-idle: owned turns close as `cancelled` and flush; durable queues survive for the next resume). Notifications `session.event {sessionId, event}` and `session.status {sessionId, status}`. Malformed lines are ignored, unknown methods answer `-32601`, stdout is reserved for frames, host logs go to stderr. **One plugin, two carriers**: `minidsh serve` mounts it on real process stdio; the terminal mounts the identical plugin on an in-process duplex pair — same bytes, no shared objects. Agents created over the wire are owned by the plugin's context; the config (`cwd`, `defaultAgentOptions`, `onClose`) keeps process exit in the app.
- **The interactive terminal** (`app/terminal`): a protocol *client* — streaming render straight from durable `assistant/chunk` text deltas, tool lines, typed input steers a running turn, `y/N` answers approval frames, `/sandbox` and `/ask` switch authority over the wire, Ctrl+C cancels then exits. Attaching to a stored session (`minidsh chat` / `resume` / `fork` interactive) is prepared host-side by the app assembly; the client then drives the live session over the wire and renders its transcript from `session/events` first.

**The log is the interchange format.** A surface, in-process or remote, consumes durable events — on the wire, `{sessionId, event}` verbatim, with core types reaching the client as type-only imports — plus the small live control plane the protocol owns: the status projection, approval answers, cancel/steer. **Approval frames are the durable events**: `approval/asked`/`approval/decided` streaming over `session.event` are the answerable frames, keyed by the durable id; the protocol holds a pending table (first answer wins, disposal fails pending prompts closed, no client ⇒ delegate down the waterfall). There is no DTO layer, no protocol version until a client ships independently of the host, and clients ignore unknown event types. Presentation (`presentCall`) is computed host-side by whoever holds the tool registry; no card is rendered yet, so it still has no caller. Because every durable payload is frozen JSON at append, no in-process object can ever reach a wire.

## 9. Composition

`Row{id, plugin, config?, disabled?}`; `Patch = {id, config?|disabled?} | {insert: Row[]}`; `applyPatches(rows, patches)` replaces a row's whole config, warns and skips unknown ids, and appends inserts. It is the one algorithm used for boot and for `--dump-config`. `app/compose.ts` declares the default rows and `defaultAgentOptions()` (`deepseek` / `MINIDSH_MODEL` ?? `deepseek-v4-flash`) — the one place the default provider/model live; every surface (CLI, protocol `initialize`, terminal) shares them. The shipped authority default is `workspace-write` + `ask`: the filesystem is genuinely fenced and the shell must be escalated, which is the boundary, not an inconvenience to route around. `serve`/`terminal` add the protocol row by insert patch through the shared `bootComposition`. Environment: `DEEPSEEK_API_KEY` (referenced by name only), `DEEPSEEK_BASE_URL`, `MINIDSH_HOME`, `MINIDSH_MODEL`.

## 10. Verification

Tests mount real compositions through the kernel; only the model is scripted (`test-support/scripted-adapter`) or replayed from a recorded session log (`test-support/llm-replay`, which derives the script from `assistant/chunk` groups per (turn, step), keeps the attempt the agent acted on, drops a trailing finish-less group — a crash mid-stream the agent never acted on — and asserts every recorded call was consumed). Because the replay script is derived from the same JSONL the harness persists, **a live session log is its own test oracle** — including sessions that retried or crashed: recording costs one real run. The protocol is tested byte-level over an in-memory duplex pair; the terminal's render folds are pure functions plus scripted end-to-end runs over the loopback carrier.

Runtime invariants — the session relational trace (seq contiguity, turn/step balance, numbering, call/result pairing; pre-commit, so a rejected event never enters the log), agent status no-repeat, and request reconstruction (registered with `prepend` so nothing can silence it) — run in every test *and* in live runs, because `compose()` mounts them by default. End-to-end verification asserts the world (re-run the test suite, byte-compare untouched files), never the agent's self-report.

Gates: `pnpm check` = `tsc --noEmit` + `oxlint` + `check-deps` + `vitest`; `pnpm test:e2e` runs the two live arcs (gated on `DEEPSEEK_API_KEY`), both driving the real runtime as a `minidsh serve` child process over real stdio JSON-RPC through the shared `test-support/serve-process.ts` client:

- `live.e2e.test.ts` — complete a task, SIGKILL mid-turn, resume in a second process (crash repair + byte-prefix attach asserted), finish the work, replay a fresh log keylessly.
- `authority.e2e.test.ts` — with no `--approve`, so every consent is a real decision answered over the wire: an edit inside the workspace lands; one outside it is refused and probed ABSENT on disk; a shell command is refused as unconfinable, the model escalates with a justification, the client approves, and it runs; a `session/authority` switch to `read-only` refuses the next write; and the fresh log still replays keylessly.

Every session close requires both live runs green.

## 11. Where new things go

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: register an adapter on `llm` |
| a model-facing capability | `capabilities/tool-<x>`: register on `tools` (+ a prompt guidance section) |
| an execution world (sandbox, remote) | providers for `fs` and `shell`; tools untouched |
| a shell confinement backend | a `shell` provider (or a spawn wrapper inside one) that confines the argv under the stamp and reports the truth from `enforcementFor`; if it needs writable roots the fence does not grant, they go in `writableRoots` — once, for both families |
| an authority knob | a log-only event with a `findLast` fold and a setter that IS the event, beside `sandbox/mode` and `approval/policy`; never a field a surface holds |
| a policy or approval answerer | listeners on `tools/pre-execute` / `approval/request`; guards |
| durable state | a new session event type, rendered and replayed from the log |
| context for the model | `agent.inject()` or an `agent/pre-step` listener — never ad-hoc prompt text |
| a surface | `app/` or a new package: consume `session/event`, drive `agents`; zero semantics; owns only the live control plane (§8) |
| a remote client (web, IDE, script) | speak the protocol (§8): ndjson JSON-RPC to `minidsh serve` (or a future carrier over the same server); render `{sessionId, event}` frames; ignore unknown event types |
| a per-agent variant | registrations or plugins through `agent.ctx` during `setup` — tools, guards, sections, variables, listeners — visible to that agent alone (§2 scope contract) |
| context management | a compaction provider: a log-only summary record plus a `user/message{source.kind:'plugin'}` with `surfaceOp: replace` inside the turn; the log is never rewritten |
| an attachment / binary plane | a `core/attachments` Definition: bytes content-addressed under `MINIDSH_HOME`, blocks carry `{type:'image', attachment:{id, mediaType, bytes, width, height}}`; bytes never enter the log; adapters resolve refs at serialization under a per-route size policy |
| a model role (cheap / verifier / vision) | an `agent/request` listener rewriting `{provider, model}` — identity is the exact route plus an optional request `purpose` tag, not a role registry; `MessageSource` and `request/header` already attribute mixed-model history |
| a model call outside the loop (summary, verification) | its owner logs a log-only request/result pair with route and usage; bare `llm.stream` is neither durable nor retried |

If a new thing has no row here, that is an architecture question to settle before implementation.

## 12. Divergences from DeepSeek Harness

- Own kernel instead of Cordis (DSH uses a small subset; proxies, realms, loader, HMR are dispensable at this scale).
- One package with a dependency gate instead of ~150 packages.
- Sequential tool execution; no scheduler.
- Persistent shell over piped stdio with marker framing instead of a PTY.
- One client protocol instead of DSH's two (its GUI wire + its SDK stdio protocol): MiniDSH's matches the SDK shape and adds what DSH's lacks — `session/cancel`, `approval/answer` (frames keyed by the durable id, where DSH's GUI wire uses rpcIds), `session/authority`, and a catalog-returning `initialize` (DSH's takes provider/model as *input* and exposes no catalog on any wire).
- No confinement backend at all, where DSH ships four (bwrap, Landlock, Seatbelt, a Windows ACL restricted-token runner). MiniDSH keeps DSH's invariant — refuse rather than run unconfined — and ships the seam and the escalation path instead; enforcement is recorded in the stamp so a log never overstates what a host actually delivered.
- `writableRoots` grants the workspace root only. DSH also grants `/tmp` and `os.tmpdir()` so its confined shell keeps working; MiniDSH has no confined shell, so no asymmetry can arise, and granting the platform temp root would hand the editor authority it has no use for.
- Escalation is not required to be "grounded in an actual denial" as DSH's is (that needs per-session denial tracking); strictly-wider plus approval is the whole gate.
- Tool deadlines are registry-owned rather than a wrapper plugin, because the kernel waterfall cannot substitute a listener's arguments; in exchange every tool has a default budget, where DSH's shipped tools mostly declare none.
- An interactive terminal client ships (DSH has web + a headless dispatcher, no TUI); it is a protocol client on an in-process carrier, DSH's own documented pattern.
- Plain JSONL lines instead of checksummed zstd frames and chunk-row packing.
- No YAML loader, presets, settings/credentials services, attachments, Code Mode, subagents, compaction backend, workspace entity, or session projections until a session needs them.

## 13. Known limitations (current)

- **No host can confine the shell, so `workspace-write` buys the filesystem a real fence and the shell an approval.** The seam is complete — the stamp, `enforcementFor`, the refusal, the escalation, the durable record — but every platform reports `none`, so a shell command under a confined mode always costs a round trip and a human decision. A backend (§11) is what removes that, not a change to the plane.
- **The mode vocabulary claims file effects only.** Network access is unrestricted in every mode and process visibility is unspecified; these are not general-purpose security modes.
- **Escalation depends on model compliance.** A model that ignores the refusal guidance simply cannot use the shell; nothing coerces it, and nothing should.
- The fence is a policy check in trusted code, not a kernel boundary: it is complete for paths a tool passes through `ctx.fs`, and says nothing about code the shell runs.
- Session events are appended synchronously inside the `session/event` listener; a write failure is remembered and rethrown at the next `session/flush`, but there is no write-behind batching.
- A PowerShell command that reads stdin still blocks until its deadline (PowerShell has no stdin redirect operator); bash commands run with stdin from `/dev/null` and cannot.
- Single provider (DeepSeek), text only: the attachment plane and model roles are decided designs (§11), not built. A reasoning block has no provider-opaque continuation slot (needed by a second adapter whose thinking must be echoed with a signature) and `ResolvedModel` carries no modality facts — both S6.
- No compaction: a long enough session grows its request until the provider's context window rejects it.
- The protocol serves exactly one client per plugin instance (one stdio pair); `session/events` returns the whole log (no pagination); there are no RPC deadlines. A multi-client carrier is the S7 web surface's problem.
- The terminal renders plain lines: `presentCall` still has no caller and `ToolResult.value` is not durable — both deferred until the first structured card is rendered.
- Interactive `resume`/`fork` attach is prepared host-side by the app assembly (the wire equivalent — `session/prompt` with a stored id — is what `serve` clients use; a wire-level fork method does not exist yet, mirroring DSH's still-reserved `session.fork`).
- A `steer` delivered to an idle agent wakes it (send semantics); the surface decides mode by observed status, so a steer racing turn-end becomes a fresh turn's prompt.
- **The resume liveness guard is process-local.** The duplicate-id throw lives in one process's session store, and the stored plane guards only against snapshot overwrites (a non-resumed publication refuses an existing file); two *processes* resuming the same id would interleave appends and damage the log. Single host per `MINIDSH_HOME` is an assumption until a per-session lock seam lands (S4's home-layout work).

## 14. File map

```
src/kernel/     tokens.ts (service/event keys) · bus.ts (listeners, scope filter, observers)
                context.ts (Context, plugin instances, effects, realms) · errors.ts · index.ts
src/core/       json.ts (JSON discipline) · ids.ts (branded ids) · scope.ts (per-agent registration layers)
  session/      types.ts (event kinds, envelope, header) · session.ts (the log) · surface.ts
                (deriveEventMessage, foldRequestHeader, Surface) · store.ts (ctx.sessions + events)
                repair.ts (interrupted-tail closers) · invariant.ts (relational trace)
  llm/          types.ts (vocabulary, adapter contract) · message.ts · assembler.ts
                runtime.ts (ctx.llm, llm/stream waterfall, protocol validator)
  tools/        types.ts · registry.ts (ctx.tools + pipeline) · presentation.ts · index.ts (defineTool)
  prompt/       index.ts (ctx.prompt, sections, variables, assemble)
  approval/     index.ts (ctx.approval, approval/request waterfall, audit events, approval/policy)
  sandbox/      index.ts (the stamp, writableRoots, ctx.sandbox, sandbox/mode) · paths.ts
                (canonicalPath, isInside) · invariant.ts (the closed authority vocabulary)
  fs/           index.ts (Definition: FsTarget, intents, fs/* events)
  shell/        index.ts (Definition: ShellSession)
  agent/        types.ts · index.ts (Agent, ctx.agents, Inbox, agent/* events) · invariant.ts
  loop/         driver.ts (the turn/step machine) · factory.ts (ctx.agents factory + plugin)
                marker.ts (loop-request identity) · invariant.ts (request reconstruction)
  invariants/   index.ts (ctx.invariants registry)
  persistence/  index.ts (the read Definition: PERSISTENCE, StoredSession)
src/capabilities/
  llm-deepseek/ sse.ts · translate.ts · serialize.ts · adapter.ts · index.ts
  llm-retry/ · fs-local/ · fs-observation-policy/ · tool-editor/ · shell-stdio/ (index + process)
  tool-shell/ (the escalation) · persistence-jsonl/ · approval-headless/ · context-runtime/
  protocol-stdio/ frames.ts (JSON-RPC + method vocabulary) · transport.ts (ndjson framing)
                server.ts (handlers, pending approvals, resume table) · index.ts (the plugin)
src/app/        home.ts · compose.ts (rows, applyPatches, mount, defaultAgentOptions)
                headless.ts (bootComposition, runTask/resumeTask/forkTask) · serve.ts (protocol host)
                terminal/ (client.ts · render.ts · index.ts) · cli.ts (+ the --audit view)
                live.e2e.test.ts · authority.e2e.test.ts
src/test-support/ scripted-adapter.ts · harness.ts (real composition) · llm-replay.ts
                serve-process.ts (the external JSON-RPC client both live arcs drive)
scripts/        check-deps.ts (dependency-direction gate)
```

About 7,900 lines of implementation and 5,000 lines of tests and harness across 96 files.
