# MiniDSH Architecture

One runtime composed from plugins over a tiny kernel. Everything the model sees derives from an append-only session log; everything it does goes through a guarded tool pipeline, fenced at the effect boundary by an authority the log records. The model is a capability the runtime routes to, not the agent: the route is a durable fact, a purpose may take a different one, a delegated child cannot widen its authority. Bytes the model was shown live beside the log, content-addressed, never in it. Every surface only renders the log — by the page, never whole — and drives the agent registry; a session survives its process.

This is the architecture contract: what each layer owns, what it may not own, where a new thing goes. History lives in `BLUEPRINT.md` §4 (beside this file) and the commits; usage in the root `README.md`; §12 lists deliberate differences from DeepSeek Harness (DSH), §13 what is knowingly missing. Section numbers are cited from code comments and are stable. Size budget: 84 KB, enforced by `pnpm check` (CLAUDE.md §5); past 75 KB, compress the owning section before adding.

## 1. Layers and dependency direction

```
src/app/           assembly + surfaces (§14)
src/capabilities/  providers + consumers (§3)
src/core/          Definitions + default drivers (§3)
src/kernel/        substrate (§2)
src/test-support/  adapters + harness (§14)
```

Three rules (`scripts/check-deps.ts` in `pnpm check`):

| from | may import |
|---|---|
| `kernel` | nothing internal |
| `core/<x>` | `kernel`, other `core`; **`core/loop` only by `app`** |
| `capabilities/<x>` | `kernel`, `core` Definitions only; never another capability, never `app` |
| `app` | anything |
| `test-support`, `*.test.ts` | own layer and below (`test-support`: also `app`) |

Second, outside tests payloads are read via `matches(event, KIND)`, never `event.data as {…}`, so a renamed field is a type error rather than a `NaN` on a screen. Third, **core is acyclic at file level** (packages may cycle): each package's vocabulary (`events.ts`, `types.ts`) sits below its service, so no file's value imports close a loop.

The layers are the whole topology; a capability is a directory, not a package. The browser client shares no code with the host — plain JS, no build step — only the wire.

## 2. Kernel (`src/kernel`)

The Cordis paper's two composability properties with the smallest mechanism set: no loader, HMR, isolate realm, proxy, mixin or accessor; registries take the owner context explicitly (`tools.register(ctx, def)`).

- **Context**: a non-mutating tree; `child({scope?})` derives a scoped one. *Registration context = visibility = lifetime.* Scopes are flat: a child beneath a scoped context inherits that scope and cannot be re-tagged. A plugin-derived scope reads *through* its plugin's declared and provided keys.
- **Services**: `provide(key, value)` is an effect; a key is claimed once per context chain (a child may shadow). `get(key)` is strict (only `inject`ed or self-provided keys); `tryGet` is optional. Keys: typed tokens (`serviceKey<T>`), not declaration merging. Deployment-global registries refuse a scoped owner.
- **Plugins**: `{ name, inject?, config?, apply(ctx, config) }`; `config` is a structural `{parse(unknown) → C}` contract (a zod schema qualifies; the kernel imports none, §12), parsed BEFORE `apply`; a bad row fails `PLUGIN_CONFIG` naming the plugin. `pending` until all injected keys are provided, then `loading → active`; a vanished dependency unloads, a replaced provider reloads; transitions are serialized per instance. Effects unwind before dependents unload: **a disposer must not read the services its plugin injected**. `settle(filter?)` awaits quiescence and reports pending plugins with their unmet keys and failed ones with their errors.
- **Effects**: `effect(fn → disposer, label?)` pushes onto the instance's disposer stack, disposed in strict reverse order; a disposer's synchronous part runs eagerly, so `off(); register(sameName)` in one tick is legal.
- **Events**: tokens carry a dispatch mode: `emit` (sync, contained), `waterfall` (around-middleware; `next()` single-shot, so no middleware can run a tool body twice against one durable record), `serial`, `parallel`; the wrong method is a compile error. A scoped dispatch reaches unscoped, `global: true` and that scope's listeners. `observe(hook)` sees every dispatch in the preflight, before listeners — where runtime invariants hang, since a listener can be ordered behind another and an observer cannot; `prepareEmit` splits preflight from delivery (reject before commit).

**Scope contract** (`core/scope.ts`). Unscoped registers deployment-global; an agent's `ctx` into its layer. Tools, guards, prompt sections, variables: globals plus exactly one agent layer, a local entry shadows a same-named global, no inheritance between scopes. An agent's operation events dispatch in its scope (`agent/*`, `tools/*`, `approval/request`, `system-prompt/assemble`, `fs/*`); subject-less seams (`llm/stream`, `session/*`) and registry-membership notifications are unscoped. Consumers get the agent as subject, never services via `agent.ctx`. The per-agent execution world mounts on `agent.ctx` in `setup(agentCtx, agent)` — agent unpublished, session appendable: the slot a creator seeds durable opening facts into before the first effect. A scope tag must be an object (the `Agent` itself).

## 3. Core contracts (`src/core`)

Eighteen service keys: seventeen `core` (below) + app-only `app-composition`; `loop` is a plugin, not a key. A seam needs all three roles: Definition (core), Provider (capability), Consumer (capability, usually a tool). Agent id = session id.

| ctx key | owns | must not own |
|---|---|---|
| `sessions` | `Session` = header + append-only log + surface + derivation; commit = validate → observe → push → deliver (an invariant rejects pre-commit); tiers (§4); `create/publish/get/list/flush/detach` (`publish: false` defers announcement: **session publication follows agent publication**); `Session.origin` (`new \| seeded \| resumed`, live-only); `session/created\|event\|flush\|disposed\|end-seed` (`event` contained, `flush` parallel); `repairInterruptedTail`; folds `deriveEventMessage/foldRequestHeader/foldRequestContext/foldLastAssistantText/foldLastTurnEnd/sliceForkSeed` | persistence backends, UI state, model |
| `persistence` | READ Definition: `load(id) → StoredSession {header, events, damaged?}` (readable prefix); `list()` newest-first as `StoredSessionSummary {header, title?}` (bounded prefix) | the write path (a provider owns format, materialization and attach); repair; deletion |
| `credentials` | branded `CredentialRef` = a validated env-var *name* (all config, logs or errors carry); `resolve(ref)` fresh per call (the per-operation read IS rotation); `describe(ref)` (remedy); empty stored value is ABSENT (falls through) | storing/logging values; which layers exist |
| `presets` | `presetTable` validating a configured table (`custom` reserved, derived-only); pure `presetFor`; log-only `authority/preset{name}` intent; `AuthorityPresets.apply` (§7) | enforcement; knobs; a `defaultPreset` |
| `llm` | the provider-neutral vocabulary (§5); deployment-global adapter registry; `stream(request)` = the `llm/stream` waterfall, whose terminal continuation looks up the adapter and strips foreign `replayState` (§5); adapter failure → terminal `finish{error\|aborted}`; validator; `BlockAssembler`; `resolveModel`; `providers()` | API keys, session state, default model |
| `tools` | `defineTool` (zod input → JSON Schema, zod output, `render`, `execute`, `timeoutMs?`, non-model-facing `tags?` §11); `register/guard`; `restrict(owner, {allow?, deny?})` — subtractive per scope, intersecting, own registrations exempt, in ONE resolver behind `schemas/get/list/execute`, so a hidden tool is unknown to the model and refused if called; pipeline (§6) | policy |
| `prompt` | ordered named sections + strict `{{var}}` variables; exactly one `complete` section; `assemble(agent)` → `system-prompt/assemble` → `{system, tools}`; sections stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request({agent, toolName, callId?, reason?, signal?}) → 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` on the `approval/request` waterfall (default `unavailable`); durable `id` = the `approval/asked` seq, stable across resume and fork; settles `cancelled` on the signal unanswered; `reason` control-stripped and clamped before the log (model-written text a terminal renders into a consent line); the audit pair `approval/asked`/`approval/decided`; `ApprovalPolicy` (`ask \| never`): `open` (§4), `request` records one if absent before deciding, so every decision is preceded by its policy; `never` decides `rejected` BEFORE dispatch; `setPolicy` refuses to leave a pin | answer logic; model-facing prose |
| `fs` | `resolve/stat/readText/readBytes/listDir`, `writeText(target, text, intent)`; `fs/edit-intent` waterfall (read-before-edit: expected version or refusal), `fs/observed` emit; **fences every mutation** before any effect (`FS_SANDBOX_DENIED`), reads always pass (§7); `readBytes` emits NO observation (an observation is a licence to overwrite) | tool schemas; policy itself |
| `shell` | `sessionFor(agent) → ShellSession{exec, restart, dispose}`; `exec` carries the resolved policy, reports the `enforcement` it got; `enforcementFor(mode)`; REFUSES unenforceable confinement (`SANDBOX_UNAVAILABLE`), unstartable binary (`SHELL_UNAVAILABLE`), §7; dispatches nothing for a cancelled call | model-facing descriptions; negotiation |
| `sandbox` | authority stamp: `SandboxMode` (`read-only \| workspace-write \| danger-full-access`), `SandboxExecutionPolicy{mode, workspaceRoot}`, the pure `writableRoots`/`allowsWrite` every fence derives from, `canonicalPath`/`isInside`; `open(session)`, `open(session, {mode, reason:'delegation'})`, `resolve(request)`, `setMode`, `enforcementFor(mode)` (§7); `sandbox/mode` + folds `lastSandboxStamp/effectiveSandboxMode/openingSandboxStamp/delegationCeiling` | enforcement backends; what any tool may do; **what the model is told of it** |
| `compaction` | `compactNow(agent)`; log-only bracket `compaction/start\|applied\|end`; `foldCompactionFailures`; PURE `planCompaction`: contiguous head run, a tail kept against `min(budget, live surface) × retainRatio`, one pairing rule (the tail never begins with a `tool/result`); `planIsLive` (§6) | threshold, summary, trigger |
| `attachments` | content-addressed `AttachmentRef{id, mediaType, bytes, width, height, name?}`, `imageLimits` (sync), `saveImage/readImage/hostPath`; **validate and durably commit an image before its owning session event is appended**; `AttachmentError` does not extend `LlmError`, route on `code` | normalization; retention; who may look |
| `spill` | output with NO OTHER HOME: `save({sessionId, callId, label, text}) → {path, bytes}`; head/tail excerpt renderers | threshold (each tool's own) |
| `settings` | REMOTE-writable defaults: `register/describe/read/write` (`expectedRevision`, §8); two layers merged one level deep; `settings/changed` | store; authority; composition; anything a resumed session recorded |
| `agents` | `Agent{id, session, status, ctx, options, configure, world, send/followup/steer/inject, cancel, whenIdle}`; `create/resume/fork/get/list`. Creation: TRANSACTION (session unpublished → scope → agent → opening `agent/options` → `setup` → register → publish; failure rolls back unannounced), one memoized disposal (owner+loop). `Agent.options` folds the BASE route; `configure(partial)` is the durable switch (one `agent/options{change}`, §4) and drops unrestated sampling knobs (whether a model honours one is adapter-owned). `resume` = `load` (refusing `damaged`) → repair → seed → same transaction, `origin:'resumed'`; model config = caller overrides > seed's folded `agent/options` > its `request/header` > surface defaults. `fork(owner, source, boundary?)` slices a live or repaired log into a child (`parentId`/`seedLength`), refusing a boundary below a delegated child's opening stamps (§7). `resolveCallConfig(agent, call)` = ONE route resolution. Inbox `inbox/spliced`+`foldInbox` (§4) | driver |
| `invariants` | `register(owner, name, installer)` in a child context (deployment-global); selected by config; pre-commit validation via `observe` | product logic |
| `loop` | driver (§6) + durability checkpoints; registers itself as agent factory | anything extensions do |

## 4. Canonical facts: the session log

The log is the single source of truth: `{type, seq, time, data}`, `seq === log.length`, data JSON-lossless, deep-frozen at append.

**Three tiers.** **Surface** `user/message`, `assistant/message`, `tool/result` carry `surfaceOp: 'append' | {op:'replace', start, end}` and `sourceEventSeqs`; model history is their fold (`deriveEventMessage`), so a compaction provider replaces a range without mutating history. Others are log-only **facts**; **trace** (`TRACE_TYPES`) is never folded at runtime and is the bulk of a long session by two orders of magnitude, so runtime folds walk `Session.facts` (seqs kept); persistence, replay and the wire keep `events`.

**Vocabulary** (27 kinds): `turn/start`, `turn/end{reason: completed | blocked | cancelled | error{code,message} | max-tokens | max-steps | interrupted}`, `step/start`, `step/end`, `user/message`, `agent/options{options, reason: initial|change|resume}`, `request/header{provider, model, reasoningEffort?, maxTokens?, temperature?, system, tools; reason}` (written only when it changes, so a provider prefix cache survives restarts), `request/context{provider, model, contextWindow?, inputModalities?}` (`inputModalities` absent MEANS text only), `assistant/chunk{turn, step, attempt, chunk}` (trace), `assistant/message{message, usage?, interrupted?}`, `tool/call`, `tool/result`, `inbox/spliced`, `approval/asked{id}`, `approval/decided{id, outcome}`, `approval/policy{policy, reason}`, `sandbox/mode{mode, enforcement, reason}`, `authority/preset{name}` (intent, §7), `composition/applied{hash, layers, rows}` (hashed, never inlined), `llm/aux-call{purpose, provider, model, maxTokens?, inputSeqs?, usage?, outcome}`, `compaction/start|applied|end`, `subagent/start|end` (PARENT's log), `session/title{title, messageSeqs, source: fallback|provider|user}` (log-only, last-wins; only `fallback` is produced today, but a rename must stay distinguishable from a generated title), `session/end-seed`.

Header `{version, id, createdAt, cwd, parentId?, seedLength?, delegatedBy?, delegationDepth?, agentPreset?}`, beside the log. `SESSION_FORMAT_VERSION = 0`, additive; a NEWER stored version refuses loudly at load and attach. Unknown types load as opaque log-only records, skipped by derivation; plugin state is a log-only kind, never surface.

**The route is one durable fact, in two records.** `agent/options` is the BASE (written at creation, by `configure`, by an override at resume; folded by `findLast`); `request/context` the EFFECTIVE route per step (§6), outside header equality (a capacity change never forces a header snapshot), written only when the WHOLE record differs — so a field added to it must also be written on a resumed session whose route never changed, or it reads as absent for that session's life. Every reader learns the window from the log, never a live adapter; an adapter that cannot resolve a model records neither window nor modalities; the next successful step rewrites the record. A role rewrite moves header and context, never the base.

**What a session opens with.** `agent/options{initial}`, `approval/policy{initial}`, `sandbox/mode{initial}` and `composition/applied`, before publication (delegated child: §7; nothing a resumed log already says).

**The durable inbox.** `inbox/spliced` is op-shaped — `{op:'insert', queue, message, waking?} | {op:'claim', steps, turns} | {op:'clear'}` — never positional; a claim drains counts from the front. Inserts and clears log at mutation time (an empty clear logs nothing); the claim commits after the entered `user/message`s: a pre-step crash re-delivers, never loses. A disposed-cancel does not durably clear (teardown preserves the queue). A RESUMED agent wakes at publication iff a waking insert is queued; a fork is a passive branch, never woken by creation.

**Arrival versus rewrite.** A `user/message` that ARRIVES must sit inside an open turn; one that REPLACES a range is a rewrite, not input, and may land between turns. `Surface.apply` throws on a replace naming a dead node, in the fold as at append.

**Crash repair closes the surface.** The driver commits an assistant message with ALL its tool-call blocks and logs each `tool/call` only when its turn comes, so `repairInterruptedTail` answers every tool-call block of the open step — `TOOL_OUTCOME_UNKNOWN` for a logged `tool/call`, `TOOL_NOT_STARTED` if never dispatched — cancels the turn's undecided approvals, and closes step and turn `interrupted` — a history every OpenAI-compatible wire accepts.

**A `session/event` listener may not append synchronously.** A nested append reaches persistence, protocol and invariant BEFORE its cause; seqs N+1, N read `damaged` at the next resume. Queue it on a microtask.

**Model-visible ⟺ logged.** Every request equals `deriveMessages()` plus the folded `request/header`; a runtime invariant rebuilds both in the `llm/stream` preflight and fails on divergence.

**Persistence is a subscriber**: `sessions/<id>.jsonl` under `MINIDSH_HOME` (§9), header as line 1. A fresh or forked session **materializes on its first conversation fact**; a `resumed` one attaches append-only; a torn final line moves to `.torn`, deeper corruption is `damaged` and refuses attach. `session/flush` (every durability checkpoint) rethrows a remembered write error, every time. No `fsync`: the modelled failure is a crash, which the page cache survives; a power loss lands in the torn-tail repair.

**Single writer per stored session.** A `<id>.jsonl.lock` lease (exclusive create, `{pid, host, acquiredAt}`) is held from publication to disposal. A holder is stale only when provably dead on THIS host (`ESRCH`); else refuse, naming it: manual `rm`, never two writers. Attach re-checks seed plus tail identity, refusing a foreign append in the read→publish gap. Reads never lock; a resumed publication is flushed inside the creation transaction, so a held lease or damaged attach rejects `agents.resume` before paid work.

Corollary: append-only log, header only on change, so each request append-extends its predecessor — what provider prefix caches reward.

## 5. LLM vocabulary and the two adapters

`Message{id, role: system|user|assistant, content: ContentBlock[], source}`; a tool result is user-role with `source{kind:'tool', callId}`, an assistant source carries `{provider, model, replayState?}`. `ContentBlock = text | reasoning | image{attachment, text} | tool-call{id, name, arguments} | tool-result{toolCallId, content, isError?}`. Stream, closed: `block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish{reason, replayState?}`, `reason ∈ stop | tool-calls | max-tokens | aborted{failure} | error{failure}`, `LlmFailure{message, code, status?, retryAfterMs?, requestId?}`; policies route on codes, never message text. Usage before finish, exactly one finish, deltas only into open blocks. `TokenUsage` counts are DISJOINT: billed prompt = `inputTokens + cacheReadTokens + cacheWriteTokens`. `RETRYABLE_CODES` (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, `STREAM_CLOSED`) is the default recovery set: after each, nothing but trace chunks was appended, so the next attempt re-derives an identical history.

**Replay state.** A signing provider's state returns verbatim: an opaque `ReplayEnvelope{response, blocks?}` on the terminal `finish`, pruned by `BlockAssembler` with any block it drops (misaligned → discarded whole), stored by the driver on the assistant source, stripped by `LlmRuntime` for another provider inside the terminal continuation, after the reconstruction observer, so the log still records exactly what the model was shown.

`LlmRequest.purpose` joins `signal` and `sessionId` as a field the provider never sees, absent from `RequestHeader`. **A model call that is not a turn** is `runAuxCall`: ONE log-only `llm/aux-call` (§4) carrying route, usage and answer, a failure recorded before it is thrown; no `assistant/chunk`; the messages are not copied (`inputSeqs` names them).

Adapters implement `stream(request)` and `resolveModel(model) → {contextWindow, defaultMaxTokens, reasoning:{efforts, defaultEffort?}, inputModalities?}`; effort ids are adapter-owned and opaque elsewhere; a catalog is ADVISORY (an unlisted id is accepted under conservative defaults; a known family's prefix lends its facts to a dated snapshot). **An option the provider cannot honour is refused BEFORE any I/O** (`UNSUPPORTED_OPTION`, `UNSUPPORTED_REASONING_EFFORT`, `UNSUPPORTED_CONTENT`), never dropped, aliased or clamped: the request the log records is the request the provider served. Retry is a capability on `agent/request-error`, not the driver's, so failed attempts are durable.

- **`llm-deepseek`** — OpenAI-compatible `POST /chat/completions`, `stream: true`, `stream_options.include_usage`, `thinking` + `reasoning_effort`; tool-call fragments keyed by wire index; block ends, usage and finish deferred to `[DONE]`; cache hits subtracted from `prompt_tokens`; `reasoning_content` always sent (empty when none): in thinking mode with tools the provider refuses an assistant tool-call turn without it.
- **`llm-anthropic`** — the Messages API: named SSE events, one `signature_delta` per thinking block, `input_json_delta` tool fragments, usage split uncached / cache-read / cache-created; a catalog MEASURED against the live API (1M or 200K windows, 128K or 64K output caps, effort sets differing by minor version, adaptive `output_config.effort` vs manual `budget_tokens`, `temperature` a 400 on some models); strict user/assistant turns, tool results first, a signed thinking block echoed only if this provider produced it.

**Images are a reference plus a descriptor.** An `image` block carries an `AttachmentRef`, never bytes, plus `text`: the descriptor, computed once and STORED, so a later change of wording cannot rewrite what an old log says the model saw. `core/llm/content.ts` (`blockText`, exhaustive with a `never` default) is the one block→text projection. Images are user- and tool-side only: `validateStream` refuses an assistant stream that opens one. **Refuse at admission; substitute at projection — both**: a producer refuses an image block when the STEP's route lacks `image`, before any I/O; an adapter serializing one for a model that cannot take it sends `block.text`, because durable history outlives the model that first consumed it. Each adapter resolves refs itself, per request: a text-only route gets the descriptor; an image-capable route with no store mounted is `UNSUPPORTED_CONTENT` before any I/O; missing or corrupt bytes are `ATTACHMENT_UNREADABLE`, not retryable. Array-shaped wire content is emitted ONLY for a message holding an image. The meter charges an image as `min(⌈w·h/750⌉, 1600)`.

## 6. The loop and the tool pipeline

```
followup(m) → next-turn FIFO (wakes)   steer(m) → next-step (wakes)   inject(m) → next-step (no wake)
turn/start
  claim → resolveCallConfig (agent/request) → request/context when changed
        → agent/pre-step (waterfall: reject | enter{messages})   reject ⇒ turn/end{blocked}
  step/start → user/message per entered message
  prompt.assemble → request/header when changed
  CHECKPOINT → llm.stream(frozen request) → assistant/chunk{attempt}* → assistant/message{usage}
       finish error ⇒ agent/request-error (waterfall) → retry (next attempt, same request) | turn/end{error}
  tool calls in model order: tool/call → CHECKPOINT → tools.execute → tool/result
       (cancel ⇒ ABORTED_BEFORE_DISPATCH results; a lost write ⇒ DURABILITY_LOST results, none run)
  step/end → next step while tools owe a request or next-step input exists (≤ maxSteps)
  agent/turn-stopping (serial) → re-read inbox
turn/end{reason} (exactly once) → session/flush → next turn or idle
```

**Durable before every action.** A CHECKPOINT is `session.flush()` (§4); a lost write ends the turn `turn/end{error, code:'DURABILITY_LOST'}` before the next paid request or tool effect, every remaining call answered and none run — the same shape as a cancellation, so the surface stays balanced.

**The route is resolved once per step**, before the pre-step listeners, `request/context` written immediately after (so a pressure check measures against THIS step's route and window), and fixed for the step, every retry attempt included, so a header and its context record can never describe different requests; a switch lands at the NEXT step. The request is built per ATTEMPT, because a recovery listener may change the log between attempts.

`agent/status` only on `idle ↔ running` transitions; one `AbortController` per turn; `cancel(cause)` clears the inbox and aborts; `whenIdle()` is quiescence; dispose = cancel → whenIdle → unwind scope → detach agent → detach session. The driver promise is fire-and-forget and reports (`agent/error`) instead of rejecting unobserved.

**Tool execution**, every event in the acting agent's scope: validate args → `tools/pre-execute` (`allow | deny | ask`) → monotonic deny-only guards (globals, then the agent's) → `ask` → `approval.request`, anything but `allowed-once` denies → **deadline armed** → `tools/execute` (around-middleware over the body) → body → validate, freeze → `render` → `tools/post-execute` (`accept{content?} | block{feedback}`) → normalized result → `tools/result`. Guards run BEFORE the ask, so a call they would refuse never interrupts a person. Every throw becomes an `isError` result `{name, code}`. Only `{name, description, parameters}` reaches the model.

**Deadlines are the pipeline's.** `ToolDefinition.timeoutMs` (omitted = registry default, `null` opts out) is enforced by the registry, because the kernel waterfall passes `next()` no arguments, clocked from *after* the gate; expiry ends the body `TOOL_TIMEOUT`, signal aborted, late result discarded. Consent INSIDE a body waits on `ToolExecution.callSignal` (cancellation, no deadline) and owns its clock (`timeoutMs: null`).

**Context pressure** is `core/metering` (§11), a pure fold over log facts: the last provider charge plus ~4 chars/token per surface node since; a `replace` or a later `request/header` invalidates the anchor and the whole surface is re-estimated. Session totals also fold `llm/aux-call` usage. Estimating low right after a compaction is the safe direction.

**Compaction** has three ways in and one implementation (`compaction-basic`): **pressure** on `agent/pre-step` (the only hook inside an open turn with no step open and no request built); **context-overflow** on `agent/request-error` for `CONTEXT_WINDOW_EXCEEDED`, answered `{kind:'retry'}`; **explicit** `compactNow`, deferred to the next step boundary while running. Budget: the window the log names for the next step's route, or `budgetTokens`. The summary routes via `resolveCallConfig` with `purpose: 'compaction'`, replays the shadowed conversation verbatim under the CURRENT system prompt and tool schemas (prefix byte-identical to the loop's), then writes `llm/aux-call`, then `compaction/applied`, then ONE `user/message{source:{kind:'plugin', form:'summary'}, surfaceOp:{op:'replace'}}` citing every shadowed seq; the retained tail never begins with a `tool/result` (§3). The summary's frame names the union of every shadowed range and the recall tool when mounted.

**Every attempt is bracketed.** `compaction/start` opens once a plan exists, BEFORE the paid call; `compaction/end{startSeq, outcome}` closes it with `applied` or a decline: `summary-failed | summary-empty | summary-not-smaller | turn-started | plan-stale | agent-gone | cancelled`. The applied record carries `projectedTokens` (what the threshold compared) and the estimator pair `surfaceTokensBefore`/`surfaceTokensAfter`, the only pair valid to compare (hence no single "saved" figure). **A summary at least as large as the span it would replace is refused.** Automatic triggers stop after `maxSummaryFailures` consecutive fruitless summaries, counted by a fold bounded to this lifecycle and cleared by an applied compaction; `/compact` is a human asking again and is never disabled.

**The hazard is the await, not the mutation.** An explicit compaction on a RUNNING agent defers to the next step boundary, AND the plan is re-validated (`planIsLive`, plus the agent's status) in a window with no `await` — registry identity first, because it alone says whether an append is legal. No durable lock bracket: the mutation is one append.

**Bounded recall** (`capabilities/tool-history`). `history_read{fromSeq, toSeq}` renders shadowed nodes via `deriveEventMessage`, within the union of `compaction/applied.shadowedSeqs` for THIS session minus its own prior results: not a log reader, not a session search, never another session. Registered in the deployment globals (a summary names it by tag), hidden by a `TOOLS.restrict` on each agent's scope until its first applied compaction. Two budgets, because recalled text re-enters the live surface: a call over `maxCallTokens` is REFUSED, not truncated (the recorded arguments describe what came back); per-session spend is a FOLD over the log, not counter state — durable across a resume, exact on replay, monotonic — so recall cannot refill itself by compacting.

**Spill.** Only output with NO OTHER HOME goes to `core/spill` (§3, §11): a shell's stdout is saved, the model gets a head/tail excerpt plus the path; a file on disk gets a line range. The executor's cap is a MEMORY bound; what the model sees is the tool's decision. Reads are never fenced: retrieval needs no new tool or authority.

**Workspace instructions.** `AGENTS.md` (and `CLAUDE.md`) enter as a durable `user/message`, never a prompt section: sections must be stable within a session (§3), and a repository file is not the composition's to guarantee. Discovery is least-specific first (home file, project root, down to cwd); under a tight budget broad files drop whole before the nearest is truncated. The re-entry guard folds the LIVE SURFACE, not the log (a compaction that shadowed the entry re-enters it). It enters only a NON-EMPTY first-step batch: an `agent/pre-step` listener may add to a batch, never create one (or it revives closed turns).

## 7. Authority

The model proposes, policy decides, the effect boundary enforces; every decision is a fact in the log.

**One stamp.** `SandboxExecutionPolicy{mode, workspaceRoot}` resolves per call from `ctx.sandbox`, never caller-assembled, shared by every execution world; mode governs FILE EFFECTS only. The boundary needs no event of its own: the immutable `SessionHeader.cwd` recorded at creation IS the root for every call in that session, which is why the wire may not choose it (§8). `writableRoots(policy)` is a CEILING for both families: grant LESS, never more. `resolve(request)` records the effective stamp when it differs and refuses an escalation past a ceiling. Precedence: approved one-shot escalation > folded `sandbox/mode` > composition default.

**Enforcement lives at the effect, not at the gate.** `fs-local` fences `writeText` in process: canonicalize, contain, refuse `FS_SANDBOX_DENIED` before ANY effect (creating a parent directory is already one), and again before the write. Canonicalization uses `lstat` and follows links itself, dangling included; **a HARD link has no link to follow** (§13). Reads always pass. Because the fence is inside the provider, no tool can be the boundary and none needs to know of one: no policy plugin at `tools/pre-execute`.

**Isolation of untrusted CODE is the shell's problem, and the backend is a spawn wrapper inside the shell provider.** `shell-stdio/confine/` picks by platform (`bwrap` Linux, `sandbox-exec` macOS, none Windows) and PROBES it functionally — the real `read-only` profile around `true`, from the builder a real wrap uses — never by `which` or version, because a backend that is installed and cannot enforce is the case that matters; `enforcement` is RECORDED at agent creation, before any command exists to fail closed; `enforcementFor` and the stamp report it. A host with no usable mechanism REFUSES a confined policy (`SANDBOX_UNAVAILABLE`) rather than running unconfined.

Both apply only at spawn and inherit across `execve`: the persistent child is wrapped once, bound to the SESSION's policy. A durable `setMode` replaces it, the result saying `restarted` — never `reset`, a real neighbouring field that would tell the model its own command killed the shell; an approved ONE-SHOT escalation is no session fact: a throwaway child.

bwrap: `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --new-session`, `--tmpfs /tmp`, a `--bind` per ceiling root under `workspace-write` (`--unshare-pid` and `--new-session` close write-free escapes: a procfs magic link, `TIOCSTI`). Seatbelt: `(allow default)` `(deny file-write*)`, one re-allowed subpath per ceiling root, roots as `-D` PARAMETERS so no workspace spelling can close the profile; no new session there, so **a confined child is spawned `detached` on POSIX**. `TMPDIR` is the temp the profile granted.

**A one-shot escalation may not outlive the scope that granted it.** Never wrapped (`danger-full-access` never is): unconfined under a session's widest authority. It leads its own POSIX process group; every group it opened is reaped at disposal (a disowned descendant outlives its exited parent).

**The escalation path.** A refusal is a reported fact, not a tool failure, with one legitimate move: retry the SAME command once with `sandbox_permissions` (strictly wider, runnable on this host) and a `justification` (clamped by the seam, §3). `ctx.approval` consents to that one call, never a session switch (audit: `approval/asked{callId}` → `tool/call{callId}`). A shell whose binary will not start is `SHELL_UNAVAILABLE`, naming the binary and the remedy, never a command that printed nothing; a failing WRAPPER is `SANDBOX_UNAVAILABLE`, so the model keeps the escalation path on exactly the host with a backend. **On a confined host the kernel's refusal reads like any failing command**: the mounted backend's own denial dialect, never a cross-backend union, earns the hint (never a classification; §13).

**The plane records; a capability speaks.** No service here writes model-facing prose: a switch IS its event; `context-runtime` writes the durable message the model reads, one per agent per microtask. The runtime-context section folds only the log: the stamp THIS lifecycle opened under, `enforcement` included, and the CANONICAL workspace root every denial names.

**Every decision is durable.** `sandbox/mode{mode, enforcement, reason}` and `approval/policy{policy, reason}` are log-only, folded by `findLast` (and by `openingSandboxStamp`/`openingApprovalPolicy` where a lifecycle's opening matters): `initial` at creation, before publication; `change` only on change; sandbox `resume` when a resumed host enforces differently. `enforcement` is what the SHELL world reports (the fs fence is in-process and always complete). Nothing mutates authority out of band; a resumed session keeps what it recorded, never the deployment default. `approval-headless` answers `allowed-once` only under `--approve`, else the fail-closed `unavailable`. `minidsh sessions show <id> --audit` projects the whole plane back out of any stored log.

**A delegated child opens under a ceiling.** A child (`capabilities/tool-subagent`) captures its parent's authority BEFORE the first await; both knobs are stamped inside `setup`, before publication, `reason: 'delegation'`: a CEILING, approvals pinned `never` and enforced before dispatch, `setMode`, `setPolicy` and the escalation path refusing to widen (`SANDBOX_CEILING`, `APPROVAL_PINNED`). Narrowing stays legal (a delegation ROW too). The ceiling is durable: a resumed child comes back under it, and a fork boundary below a delegated session's opening stamps is refused.

**Presets select, the knobs decide.** `apply(session, name)` validates against a delegated ceiling and pin, appends the log-only intent, then writes through `setMode`/`setPolicy`. The preset is DERIVED from the two folds (`custom` when unmatched). Shipped: `workspace-write` = workspace-write + ask, `danger-full-access` = danger-full-access + never.

**Consent-by-composition.** `approval/request` dispatches in the asking agent's scope, so a preset-mounted (§9) answerer CAN auto-approve for its own agent — not a bypass: composition is code-equivalent trust (§9), and the audit records every pair. It CANNOT widen enforcement (a scoped `SANDBOX` shadows only scope-mounted plugins; the fs fence and the shell resolve the global one) nor reach a deployment-global registry.

`core-authority` rejects a forged `sandbox/mode` or `approval/policy` pre-commit, holds every approval to exactly one decision and a delegated session to its ceiling and pin; the presets capability's own invariant rejects an `authority/preset` naming no table entry.

## 8. Surfaces

A surface injects only `agents` and `sessions` — plus `llm` for the catalog handshake and `sandbox`/`approval` for the authority control plane — owns transport and process exit, renders from `session/event`, and holds no authority state: a switch it asks for is a durable event it reads back. Plain-text surfaces share ONE projection, `app/present.ts`, which neutralizes control characters in model text (a terminal executes what it is written); the browser renders structured DOM per event type, a different projection duplicating no fold.

### The headless CLI

`minidsh run "<task>"`, `resume <id> "<task>" --headless`, `fork <id> "<task>" [--at seq] --headless`: boot → `settle()` → create/resume/fork → `followup` → `whenIdle` → `flush` → last assistant text on stdout, exit 0 iff the turn completed.

- `prepareBoot` is the one preamble (flags, settings, the disk layers layered ONCE, `--preset`, `--agent-preset`), so `config`, `--preset` validation and `sessions` read exactly the rows a boot mounts.
- One flag table: values, per-command acceptance (an unlisted flag is refused, never ignored), usage; a wrong VALUE is refused in the wire's words (`--cwd` an existing directory, `--max-steps` a positive integer, `--at` an integer seq, `--port` a number).
- `--help`/`-h` and `--version`/`-v` (`minidsh <version>`, answered before help, boot-free, from the one string `app/version.ts` reads out of `package.json` and passes to both protocol hosts) exit 0; a preamble failure exits 2, except that `sessions` downgrades a broken settings file to a warning (a stored log must stay readable).
- `--json` streams `{sessionId, event}` frames; explicit `--sandbox`/`--ask`/`--preset` are a durable switch (§9), so they govern a resumed session too; `--patch <file>` (repeatable, §9); `--agent-preset <name>` composes the agent's world.
- `minidsh config [--json]`: the *effective* composition with per-row provenance, authority-sensitive rows a layer changed flagged by capability (so an inserted row too), every enabled row's config parsed against its contract; `sessions list/show` read the effective persistence row; `show --audit` projects the authority timeline (§7).

### The client protocol (`capabilities/protocol`)

JSON-RPC 2.0 (§12), newline-delimited on a stream carrier, one text message per frame on a socket; malformed frames ignored, unknown methods `-32601`, stdout reserved for frames. **One plugin, ONE host, N carriers**: `serve` on stdio, the terminal on an in-process duplex pair, `web` on a WebSocket. Agents created over the wire are owned by the plugin's context.

| method | params → result | rule |
|---|---|---|
| `initialize` | `{} → {serverInfo, providers, defaultAgentOptions, defaultAuthority, workspaceRoots, workspaces}` | catalog; defaults LIVE from a mounted settings store |
| `session/prompt` | `{sessionId?, text, mode?: followup\|steer\|auto, agentOptions?, cwd?, workspaceId?, path?} → {sessionId, messageId}` | absent id creates, live delivers (`agentOptions` as a durable switch), stored resumes (racing prompts share one resume); `cwd` (absolute, existing, inside `workspaceRoots`) or `workspaceId`+`path` says WHERE, never the policy, refused beside `sessionId`; the RESOLVED route must have an adapter here |
| `session/attach` | `{sessionId, limit?} → {header, view, page, cursor, damaged?}` | paged (below); subscribes BEFORE the cut |
| `session/page` | `{sessionId, throughSeq, beforeSeq?, limit?} → {page}` | back beneath the attach cut; `throughSeq` past the cursor refused |
| `session/detach` | `{sessionId?} → {}` | no id narrows to NOTHING |
| `session/events` | `{sessionId, fromSeq?, toSeq?, limit?, omitTrace?} → {header, events, damaged?}` | every tier; bounded both ends, the gap repair |
| `sessions/list` | `{workspaceId?} → {sessions}` | live and stored, newest first, live wins; derived `title` |
| `session/cancel` | `{sessionId, keepQueued?} → {}` | `keepQueued` spares the durable inbox: one client's cancel is not licence to discard another's prompts |
| `session/compact` | `{sessionId} → {kind: compacted{…} \| scheduled \| nothing-to-do{reason?}}` | HUMAN command, never a model tool; `scheduled` mid-turn |
| `approval/answer` | `{sessionId, id, outcome} → {outcome: accepted \| not-pending}` | keyed by the durable `approval/asked` id; first answer wins |
| `session/authority` | `{sessionId, sandbox?, approval?, preset?} → AuthorityView` | no args reads; each switch IS its durable event; `preset` exclusive with the pair |
| `session/model` | `{sessionId, provider?, model?, reasoningEffort?} → AgentOptions` | no fields reads the base route; each field one `agent/options{change}` |
| `settings/describe`, `settings/get`, `settings/set` | `{ns, patch, expectedRevision, replace?}` | `expectedRevision` REQUIRED; stale or invalid is the caller's error |
| `shutdown` | `{} → {}` | host-wide dispose-to-idle; never from a socket |

Notifications: `session.event {sessionId, event}`, `session.status`, `session.view`, `settings.changed`. **Approval frames are the durable events.** No DTO layer or protocol version until a client ships independently; unknown types ignored.

- **The attach contract.** A **message-aligned tail page** at the **cursor**: only `user/message` and `assistant/message` that ARRIVED spend the budget (a `tool/result` is not a message, a compaction summary not an arrival), the cut pulled back to `min(seq, ...sourceEventSeqs)` so a message is never split from what produced it, a replacement's citations NOT honoured; `limit` is clamped, an event ceiling applies. **Pages never carry the trace tier**, so `Session.facts` (§4) IS the page source and a bare seq a sufficient dedup key. **No lower-bound cursor**, by design: a reconnecting client re-attaches and replaces its window; a hole inside one connection is repaired with a both-ends-bounded `session/events`. A cold read never resumes the session.
- **`SessionView`**: what one PAGE cannot fold — `{status, context?, pendingApprovals, authority, options?, route?}`; `pendingApprovals` empty for a COLD read. **No surface node list crosses the wire, because no client folds the surface.**
- **Multi-client.** The host is per-DEPLOYMENT; a `ClientConnection` owns only its frame sink and watch set; a fresh connection receives every session and narrows on its first attach; a disconnect disposes nothing. Approvals broadcast; answerers recomputed from LIVE connections per watch-set change; a question none can see settles `unavailable`, one NO connection could see goes down the waterfall.
- **A delegated child is its parent's while the parent is running it.** `delegatedBy` live and not resumed here: READ-ONLY over the wire, streamed only to a client attached by name; RESUMED here, the host's to drive under its recorded ceiling (§7).
- **Backpressure is tier-aware.** `session/event` is a synchronous contained emit, so a listener cannot suspend the loop: past a per-connection soft limit the TRACE tier drops, facts and surface events never; past a hard limit the socket closes as `slow-client` and the client reattaches.

### The two interactive clients

- **The terminal** is a protocol *client*: streams durable `assistant/chunk` deltas, answers approval frames with `y`/`N`, offers `/sandbox`, `/ask`, `/preset`, `/model`, `/compact`, `/history`, `/sessions`, `/cancel`, sends typed input as `mode: 'auto'` (the host, not the client, decides steer-vs-followup in the tick it delivers), and **retains nothing of the session**. Interactive `resume`/`fork` are prepared host-side by the app assembly, not the protocol plugin; there is no wire-level fork method, and a stored id in `session/prompt` resumes.
- **The browser** (`minidsh web`), a static client of plain ES modules with no build step: **its transcript GROWS rather than being rebuilt**: `SessionWindow` reports which of `reset`, `append`, `prepend`, `view` it performed, and a compaction's `replace` appends one note above what it shadowed. Scroll ownership is sampled just BEFORE each mutation, never stored (§12): an append follows a reader at the bottom and leaves one who is not; a prepend restores `scrollTop` by the height it added. **It is an authority surface**: loopback unless `--host`; `GET /?token=…` exchanges the one-shot launch token for a signed HttpOnly SameSite=Strict cookie and redirects to a clean `/`, the cookie checked on every request and upgrade behind a Host/Origin fence from the actual bind (WILDCARD: Origin must match Host; the printed URL is a loopback authority, IPv6 bracketed). An unparseable request-target is `400` after the fence, never a throw. One principal, no identity (§13).

## 9. Composition, configuration and packaging

MiniDSH IS data: rows plus disk layers. Four planes: **composition**, **settings**, **credentials**, **authority** (never configuration: recorded events beat composition defaults by fold precedence).

**Home layout** (`MINIDSH_HOME`, default `~/.minidsh`): `sessions/*.jsonl(.torn|.lock|.lock.steal)`, `spill/<session>/*.txt`, `attachments/v1/objects/<xx>/<sha256>` (the LOG is its metadata), `composition.json`, `settings.json(.lock|.writing)` (the only CONFIGURATION file MiniDSH writes), `credentials.json`, `AGENTS.md` (never configuration). Only `app/home.ts` resolves paths, which travel down as plugin config; nothing below `app` imports the home.

**Composition.** `Row{id, plugin, config?, disabled?}`; `Patch = {id, config?|disabled?} | {insert: Row[]}`. `applyPatches` replaces a row's whole config, warns and skips unknown ids, appends inserts; `applyLayers` runs it per layer, provenance only where CHANGED, duplicate ids refused. **built-ins** (`compose()`, 35 rows, plus surface-contributed rows: serve's protocol row may be targeted by a disk layer but neither disabled nor reconfigured, its config carrying live streams) → **app** → **home** `composition.json` → **`--patch`** files. Authority flags are disk-overridable `compose()` inputs; explicit ones win via `applyAuthority`, a durable per-session switch after creation (a `change`, never the opening stamp). A disk `plugin` is a builtin name or a module specifier resolved from the file's directory (Node type-strips `.ts` outside `node_modules`; the module exports exactly one plugin, erasable syntax); its OWN imports are its own problem: in a checkout it may reach the repo by absolute `file://` URL; from an installed package there is no repo, so one needing `zod` or a core seam sits in a directory with its own `package.json` and `node_modules` (§13). **Every shipped plugin with a config declares its contract**, so a stale key fails boot naming the row. **composition.json is code-equivalent trust**, never a persistence target. No workspace-level layer: a repository may say how it likes its code, never what the harness is allowed to do. The home layer may patch authority-sensitive rows — it IS the deployment — never silently: `minidsh config` flags them.

**The composition record.** `composition-record`, a row *outside* the layers, appends log-only `composition/applied` (§4) on agent creation, pre-publication, iff it differs from the log's last.

**Runtime recomposition.** `mount()` returns the app-only `Composition` handle: `insert`, `remove` (dependents park pending), `reconfigure` (validates against the row's contract FIRST, then disposes and remounts), serialized. The spine `{session, llm, tools, prompt, agent, loop, persistence}` refuses removal or reconfiguration while agents are live.

**Agent presets.** `agentPresets: {name: DiskRow[]}` in `composition.json`: per-agent worlds on the agent scope, recorded as `agentPreset` in the session header so a resume or a delegated child composes the same world; they die with the agent; the factory's scoped fail-loud settle gates unmet deps and bad configs; a preset row reaching a deployment-global registry fails its agent's setup (§7).

**Settings.** `settings.json` `{agent: {provider?, model?, reasoningEffort?, maxSteps?, maxTokens?, temperature?}, revisions?}`, resolved ONCE at entry (flags → `MINIDSH_MODEL` → file → built-ins) into `BootOptions.agentDefaults`; on resume the log's folded route wins. The boot claims the `agent` namespace over the PURE BUILT-INS (the store re-applies the file as its own user layer); `MINIDSH_MODEL` applies above the store. The store owns the document: every write re-reads it inside the lock, validates the MERGED value before persisting, and replaces the file by rename.

**Retention: content is never swept; an affordance may expire.** Attachments and session logs are content (a log is the only script its arc replays from; deleting one needs an authority above the append-only seam, which does not exist). A spill file is an affordance (the excerpt beside it is already what the model saw), the one store a sweep may touch. `spill-local` sweeps in **one pass at load**, awaited at disposal, never ON disposal (a fork inherits its parent's locators): per file, STRICTLY older than one pre-walk cutoff; exact generated names only; `lstat` (symlinks skipped); `unlink`; non-recursive `rmdir` only if empty AND older (mtime read before any delete, since deleting bumps it). `cleanupPeriodDays` (default 30; `0` disables); failures never fail a boot.

| store | class | lifetime |
|---|---|---|
| `sessions/` (children too) | content, replay oracle | never removed by the harness |
| `attachments/v1/objects/` | content, shared by address | never removed |
| `spill/<session>/` | affordance | age-swept at load, `cleanupPeriodDays` (default 30) |

**Defaults and environment.** Authority default `workspace-write` + `ask`; with a confinement backend an ordinary task costs zero prompts. `shell` knob `confinement: auto | none | bwrap | seatbelt` (default `auto`); `shell-stdio` is authority-sensitive, so a disk layer changing it is flagged by `minidsh config`; `none` is not a weakening but a name for what every host without a backend already does. Env: `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` (*references*; `credentials.json` fallback), `DEEPSEEK_BASE_URL` / `ANTHROPIC_BASE_URL`, `MINIDSH_HOME`, `MINIDSH_MODEL`.

**Packaging.** Development and tests run the `.ts` source natively; Node won't strip types under `node_modules`, so what SHIPS is an emit: `pnpm build` (`scripts/build.ts`, `prepack`) runs `tsc -p tsconfig.build.json` with `rewriteRelativeImportExtensions`, copies the browser client's four files verbatim, then smoke-imports `dist/app/cli.js`. `package.json` ships `bin`, `dist`, `README.md`, `LICENSE`, `NOTICE` only — no `main`, no `exports`: a binary, not an importable surface (BLUEPRINT §3). `bin/minidsh.js` picks by package SHAPE, never staleness (`../src/app/cli.ts` beside it, else `../dist/app/cli.js`) and refuses below Node 24. `app/version.ts` resolves `../../package.json` from `import.meta.url`, valid in both layouts.

## 10. Verification

Tests mount real compositions through the kernel; only the model is scripted (`test-support/scripted-adapter`) or replayed (`test-support/llm-replay`: the script derived from `assistant/chunk` groups per (turn, step), EVERY terminally-finished attempt replayed, out-of-loop calls served from `llm/aux-call` records through a second cursor, every recorded call asserted consumed). **A live session log is its own test oracle** for the session that WROTE it; sessions are matched to logs in first-request order (§13). The protocol is tested byte-level over an in-memory duplex pair; the terminal's render folds are pure functions plus scripted runs over the loopback carrier; the browser client's window rules have unit tests, its rendering does not.

Runtime invariants (session relational trace, pre-commit; agent status no-repeat; request reconstruction) run in every test *and* live, because `compose()` mounts them by default. **Cross-capability claims are tested against the full composition** (`app.test.ts` over `bootComposition`), where such claims were found false in a partial one. E2E asserts the world, never the agent's self-report.

**Gates.** `pnpm check` = `tsc --noEmit` + `oxlint` + `check-deps` + `check-docs` (document budgets, internal links, table rows; CLAUDE.md §5) + `vitest`, run by `.github/workflows/check.yml` on ubuntu, macos and windows, each followed by an install smoke: pack the `prepack` tarball, install it into an empty directory outside the checkout, start the installed bin. **A leg that exists to prove something may not go green having proved nothing**: `MINIDSH_EXPECT_CONFINEMENT=1` (Linux, macOS) fails a skipped confinement test; `MINIDSH_EXPECT_SHELL=1` (all three), a missing dialect. `live.yml`: `workflow_dispatch` only, refused without both provider secrets.

`pnpm test:e2e` runs the eight live arcs (`DEEPSEEK_API_KEY`-gated; routing also `ANTHROPIC_API_KEY`): seven through a `minidsh serve` child (real stdio JSON-RPC), one through `minidsh web` (real WebSocket). Both harnesses bound every request with a deadline naming the method, and the child lacks `MINIDSH_MODEL`: its settings are its only route input.

| arc | what it proves |
|---|---|
| `live` | completes; mid-turn SIGKILL repaired; second process finishes; keyless replay |
| `authority` | a workspace edit lands, one outside is refused and probed ABSENT; the shell BRANCHES on the enforcement `initialize` reports (unconfined: refused, the model escalates, the client approves, the approved call's own result proves it ran; confined: no decision, no host file, every approval `rejected`, the attempt scoped to that turn and naming its target); then `read-only`: the next write attempted and refused |
| `composition` | a from-disk composition inserts a module-loaded tool, settings.json chooses the route; tool output, header, `composition/applied` and a wire preset switch asserted from the log; keyless replay asserted from the replayed session's own log, not cursors alone |
| `context` | a real budget crossing; AGENTS.md demands a header the written file carries; output spills and the model reports a value present only in the omitted middle, shown to have READ the saved file; shadowed seqs are exactly what the replace cites |
| `routing` | DeepSeek → Anthropic mid-session, one route fact; `compaction` role on DeepSeek; mixed log replays |
| `delegation` | bounded child search under `reason: 'delegation'`; approvals refused, no client; resumed child not widenable |
| `verification` | parent `view_image` refused `UNSUPPORTED_CONTENT`; child via one `model-roles` entry reads a TEST-drawn PNG; binding asserted first |
| `web` | token-for-cookie sign-in; two clients on one host; a real consent over the wire; the transcript paged to seq 0 losing nothing; the socket killed mid-turn with the host still serving |

Session close needs all eight arcs green on an idle machine; green is not a diagnosis; a stalled arc names what the session was parked on, and every asserted count names its producer. **A live arc's premise is an assumption about the model, and it decays silently**: with ONE separating assertion, ask what a model knowing nothing would answer.

`.claude/hooks/guard-repo.mjs` (not MiniDSH) refuses to link anything to a `node_modules` tree and refuses a recursive delete of a path that is such a link or holds one (CLAUDE.md §8).

## 11. Where new things go

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: an adapter on `llm` from an unscoped owner (§5) |
| a model-facing capability | `capabilities/tool-<x>`, registered on `tools` with a prompt guidance section |
| a plugin's configuration | a strict zod schema on `Plugin.config` (§2, §9) |
| an execution world | providers for `fs` and `shell`; tools untouched |
| a shell confinement backend | BUILT (§7): a dialect in `shell-stdio/confine/` (`argv → argv`, a functional probe, a denial dialect, any env the grant needs); `writableRoots` stays its ceiling |
| an authority knob | a log-only event + `findLast` fold + `open` at `agent/created`; the setter IS the event (§7); never a field a surface holds (§8) |
| an authority preset | an entry in the presets table (§7) |
| a capability, no code edit | a `composition.json` row (§9), patched to disable/reconfigure |
| a user-adjustable default | `core/settings` if a WIRE client changes it, a row-config patch if capability config; never both, never authority |
| a secret | a `CredentialRef` in config, resolved by `ctx.credentials` per operation |
| a per-agent bundle | a named `agentPresets` list (§9) mounted on `agent.ctx` at setup |
| a policy/approval answerer | listeners on `tools/pre-execute` / `approval/request`; guards |
| durable state | a new session event type (§4): a fact, or trace if nothing folds it |
| an event's human line | one branch in `app/present.ts`, narrowed with `matches()` |
| context for the model | `agent.inject()` or an `agent/pre-step` listener, never ad-hoc prompt text (§7 for authority prose) |
| a surface | `app/` or a new package under the §8 surface contract; zero semantics |
| a carrier | a `Carrier` variant in `capabilities/protocol`: framing and flow control alone |
| a named place to work | a `workspaces` entry on the protocol row: addressing only, nothing beyond `workspaceRoots` |
| a remote client | the §8 attach contract (page backwards, dedup by seq, bounded gap repair, re-attach) |
| a per-agent variant | `agent.ctx` — `world` if a child inherits, `setup` if not; later a `TOOLS.restrict` the owner lifts |
| a delegated child | BUILT (§7): `tool-subagent`; another policy is another tool over the same seams |
| context management | BUILT (§6): `core/compaction` + a provider — a policy is a provider, a trigger a listener; a model-free pruner is a second surface writer and must carry the pairing rule |
| a context-pressure number | `core/metering`, a pure fold over `Session.facts`; never a second definition |
| oversized tool output | `core/spill` + a store, consumed by the TOOL that produced it (§6) |
| an attachment kind | `core/attachments` + `attachments-local`: a media-type family + header probe, not a seam |
| a non-text producer | as `tool-view-image` (§5): refuse on the STEP's route before any I/O; bound against `imageLimits`, commit durably, then return a block |
| a verifier | BUILT: a second `tool-subagent` row (own `toolName`, `purpose`, `description`, a narrowing `sandbox`) + its `model-roles` entry, patched TOGETHER — an unknown purpose passes silently |
| a model role | `purpose → route` in the `model-roles` row's config (§4); the base route is never rerouted |
| an out-of-loop model call | `resolveCallConfig(agent, {purpose})` for the route, then `runAuxCall` |
| a recall of shadowed history | BUILT (§6): `tool-history` |
| a cross-capability tool KIND | `ToolDefinition.tags` + a constant in `core/tools/types.ts` (`DELEGATION_TOOL`, `RECALL_TOOL`), never a hard-coded name or module map; a tag is scoped to one deployment |
| a store's lifetime | a row in the retention table (§9) before it is code |
| a session's name | BUILT (§8): `core/session/title` holds kind + fold; the WRITER is a capability row, so a different policy replaces one row and the log format does not move |

No row here → an architecture question first.

## 12. Divergences from DeepSeek Harness (the ones that still shape decisions)

- **Scale and substrate.** Own kernel, not Cordis; a structural `{parse}` config contract, not a schema library; one package plus a dependency gate, not hundreds.
- **Concurrency.** Sequential tools, one foreground child, no background jobs, as DSH's `minimal` preset.
- **The wire.** One protocol (DSH's SDK shape), not three, plus `session/cancel`, `approval/answer`, `session/authority` and a catalog-returning `initialize`; No lower-bound attach cursor (DSH's shape too), but a both-ends-bounded gap repair and a host page ceiling; trace-free pages where DSH packs the tier; watch sets and tier-aware drops where DSH keeps per-follower copies and unbounded queues; approvals settle `unavailable` when unseen where DSH's stay pending forever (§8).
- **Confinement.** Two backends, not four, the bwrap profile adopted flag for flag; no Landlock (a native launcher a no-native, no-build tree cannot carry); no Windows backend (§13). Unlike DSH (§7): a functional probe, since `enforcement` is recorded before any command runs; `-D` Seatbelt parameters, not an SBPL escaper; a POSIX session per confined child on both backends.
- **The ceiling.** `writableRoots` grants the workspace root ONLY (DSH adds `/tmp` and `os.tmpdir()`, where the tests live) and binds BOTH families where DSH lets each spell its own. `SandboxEnforcement` keeps `none`: a supported posture, not an error.
- **Durability.** Plain JSONL through one held descriptor with a session-lifetime write lease, a `.torn` sidecar where DSH salvages in place; JSON config, two layers, read at boot, not YAML, four, watched; a per-boot `composition/applied` record DSH lacks; no session deletion in either.
- **Delegation and routing.** A delegation opening is an enforced ceiling where DSH trusts the pin alone; `subagent/start|end` live in the parent's LOG, not runtime events; model roles and a durable BASE route are seams here, not upstream.
- **Context.** No deterministic tool-result pruner: DSH's runs only once a compaction trigger qualifies, and the shipped tools bound their own output. Recall is GATED, not opt-in: DSH's `session-query` (a service, a SQLite FTS5 backend, five model-facing tools) mounts nothing by default, for the cost its README names ("fixed guidance plus five tool schemas to every model request"); here one tool over THIS SESSION's shadowed spans, never cross-session by `cwd` equality.
- **Surfaces.** A terminal client ships (DSH deleted its TUI) as a protocol client on an in-process carrier; the browser samples scroll ownership before each mutation, not a ledger — sound only while the write lands in the sample's tick.
- **Not built.** No PTC (DSH's renamed "Code Mode"), model-written packages (DSH: its opt-in `cordis` preset only, session-scoped, explicitly not a security boundary), MCP bridge (DSH's ships disabled), session search index, workspace config layer, per-user identity.

## 13. Known limitations (current)

Know these before changing the code near them.

**Authority**

- Windows has no confinement backend and will not (DSH's is a restricted-token subsystem, permanently `partial`, with an `Everyone` ACE and an NTFS hard-link escape): every shell command costs an escalation, headless without `--approve` cannot run a shell, escalated descendants are not reaped as a group.
- **The fs fence follows symbolic links and cannot follow a hard one.** A hard link in the workspace to an outside inode passes `canonicalPath`/`allowsWrite` and the write lands outside; detection needs inode identity per write, not portable; on a confined host the shell is unaffected (the kernel bounds the process). Upstream's edge too.
- `full` is a PROFILE claim, proven by a functional probe, not measured per call; nothing reports `partial` today.
- The `shell` row is outside the spine set: a live `reconfigure` lets `enforcementFor` answer for a world no command runs in.
- Under bwrap a path beneath the ephemeral `/tmp` is invisible, not read-only, so its denial earns no escalation hint; macOS gets no writable temp at all, so a tool needing one must escalate.
- **macOS is proven by CI alone.**
- A confined command inherits the harness's environment: it can read provider credentials and reach the network. Deliberate.
- A durable mode switch replaces the persistent shell (cwd, environment lost); an approved escalation runs in a separate shell.
- The runtime-context section states only the LIFECYCLE's opening stamp, so a mid-session switch reaches the model as a message; `sandbox/mode{resume}` alone moves it, at one prefix-cache invalidation.
- A delegation tool registered by an AGENT PRESET lives in the child's scope, which `restrict` cannot hide and the depth cap does not count: a cost bound, not a fence.
- The fs fence is a policy check in trusted code over a model-supplied path; a confined shell is a real kernel boundary — the two families enforce one mode differently, and escalation is voluntary either way (the model must ask). `--audit` projects decisions, not attempts: a refused command the model never escalated is in the transcript, not the audit.
- A module-loaded plugin is arbitrary code; `minidsh config`'s warnings are advisory.

**Context**

- The shipped DeepSeek default never reaches the pressure trigger (0.8 of a 1M window); only overflow recovery fires unless `budgetTokens` is set.
- A compaction summary is one model call that can be wrong; `history_read` can read the span back, nothing forces the model to.
- The frame names the recall tool from the DEPLOYMENT registry, so a delegation row `deny`ing it while children compact names a tool the child cannot call.
- The frame's `min–max` range OVERSTATES the shadowed set; the tool intersects rather than trusting it.
- The recall tool appears at the first applied compaction even if the summary dropped nothing.
- The meter changes units at a compaction (safe in direction), meters a prompt or tool-set change one step late, charges an image on a text-only route as an image, and may ask a smaller-model role for a summary larger than it takes.
- Workspace instructions are read once per entry, not watched; the two `agent/pre-step` listeners run in load-bearing row order (instructions first).

**Sessions and stores**

- The in-memory log retains the trace tier deliberately (`seq === array index` at many sites); a 400-turn session is tens of MB of heap.
- The FIRST listing over a large store is one read per file; later ones are memoized by size and mtime.
- Spill is swept only at load (§9), so a long-running host is unswept until restart; a repeated `callId` overwrites.
- An attachment write interrupted between staging and rename leaves a `.part` under `attachments/v1/tmp/` unreclaimed.
- A lost attachment object is turn-fatal (`ATTACHMENT_UNREADABLE`, no retry); image validation is header-only; one image producer, no client upload.
- No session deletion, search, rename or model-written title: each needs a projection past `persistence.list()`'s bounded prefix, which also lists a first prompt over 64 KiB nameless.
- A pid-space wraparound within one agent's lifetime could in principle make pgid reaping signal an unrelated group: the lease's unreachable edge, needing millions of process creations in between.
- The lease degrades to manual cleanup at its unreachable edges (pid reuse, foreign hosts); a process killed mid-reclaim leaves a `.lock.steal` mutex that blocks later reclaims until removed.
- A turn that loses durability ends but leaves the agent `idle`; only a provider or driver bug reaches it.
- A fork boundary may separate the compaction bracket from the replace that realized it.

**Surfaces**

- `session/events` returns any range asked for, every tier (§8); the paged path is what every rendering client uses.
- No host-side RPC deadlines or client timeouts; backpressure limits are fixed, unmeasured numbers.
- The browser authenticates nobody (its fences are reachability, not identity, §8) and cannot switch a session's route.
- A STORED session opened in the browser shows `compact` and `cancel` enabled; neither acts until a prompt resumes it — the refusal is honest rather than pre-empted, because liveness is the host's fact.
- A wire client may resume a STORED session whose cwd lies outside `workspaceRoots`: the roots bound only NEW sessions; a resumed one adopts what its log records.
- A reconnecting client loses its paging position and, as sole watcher, a pending approval; `session/detach` naming one session narrows an un-narrowed client to nothing; nothing announces disposal.
- A rolled-back creation's opening facts still reach a watching client; a prompt between `cancel({disposed})` and registry detach is dropped, answered as success. Both deliberate: fixes invert test-pinned orderings.
- `--preset` on a headless run leaves the stable prompt section stating the composition default; the injected switch note tells the model. `ToolResult.value` is not durable.
- On Windows the shell dialect is `pwsh`: PowerShell 7 required, refused loudly without it, never 5.1. A command reading stdin blocks until its deadline.

**Delegation and providers**

- A delegated child is foreground and sequential; its cost is summed in `subagent/end`, not the parent's meter; it dies with its tool call, its log stays.
- First-request-order replay matching is exact while delegation is serial and undefined once it is not.
- A replay reproduces decisions, not the workspace they named: a recorded absolute path cannot land in a fresh root, yet the turn completes and `assertConsumed()` passes; arc prompts pin relative paths, and that steering is a prompt, not a fence.
- An installed-package plugin (§9) reaches seams only by deep path into `dist/`; the only proven extension path is an in-repo fixture.
- No OpenAI or Moonshot adapter. A provider catalog is a snapshot: an unknown model id gets conservative facts (200K window, 8192 output cap); a divided family needs a row per member.
- Composition changes need a restart; of the one-off tools only `minidsh sessions` reads the effective composition.

## 14. File map

```
src/kernel/ tokens.ts · bus.ts · context.ts · errors.ts · index.ts
src/core/   json.ts · ids.ts · scope.ts
  session/  types.ts · session.ts · page.ts · surface.ts (deriveEventMessage) · title.ts · store.ts · repair.ts · invariant.ts
  llm/      types.ts · message.ts · content.ts · assembler.ts · runtime.ts · aux-call.ts (runAuxCall)
  agent/    types.ts · events.ts · index.ts (Agent, ctx.agents, Inbox, resolveCallConfig, mergeAgentOptions) · invariant.ts
  loop/     driver.ts · factory.ts · marker.ts · invariant.ts
  sandbox/  events.ts · index.ts (writableRoots) · paths.ts (canonicalPath) · invariant.ts
  approval/ events.ts · index.ts
  tools/ · prompt/ · presets/ · credentials/ · fs/ · shell/
  compaction/ (planCompaction) · metering/ · spill/ · attachments/ · invariants/ · persistence/ · settings/
src/capabilities/
  llm-deepseek/ · llm-anthropic/ (sse · translate · serialize · adapter · index)
  attachments-local/ (objects · image.ts: four media types from their headers) · tool-view-image/ · model-roles/ · tool-subagent/ · tool-history/
  llm-retry/ · fs-local/ (the fence) · fs-observation-policy/ · tool-editor/
  shell-stdio/ (index · process · confine/: the probe, bwrap.ts, seatbelt.ts) · tool-shell/
  persistence-jsonl/ (the lease) · context-runtime/ (persona, the runtime-context section) · approval-headless/ · credentials-local/ · authority-presets/
  composition-record/ · session-title/ · compaction-basic/ · spill-local/ · workspace-instructions/ · settings-local/
  protocol/ frames.ts (the method vocabulary, the attach contract, SessionView) · host.ts (the paged sources + cold LRU,
            pending approvals) · connection.ts · transport-ndjson.ts · transport-ws.ts · index.ts
src/app/    home.ts · compose.ts (rows, applyPatches, the builtin catalog) · config.ts (the disk layers) · settings.ts
            present.ts (describeEvent, transcriptLines, auditLines) · version.ts
            headless.ts (bootComposition) · serve.ts · web.ts · web/ (index.html · style.css · wire.js · app.js)
            terminal/ (client.ts · render.ts · index.ts) · cli.ts (prepareBoot) · *.e2e.test.ts (the eight arcs)
src/test-support/ scripted-adapter.ts · harness.ts · llm-replay.ts · images.ts · serve-process.ts · web-process.ts
scripts/    build.ts · check-deps.ts + deps-graph.ts · check-docs.ts (budgets, links, table rows) · count-lines.ts
bin/        minidsh.js (refuses Node < 24)
.github/    workflows/check.yml · workflows/live.yml · ISSUE_TEMPLATE/ · PULL_REQUEST_TEMPLATE.md · dependabot.yml
(root)      README.md · CLAUDE.md · CONTRIBUTING.md · SECURITY.md · CHANGELOG.md · CODE_OF_CONDUCT.md
            LICENSE (pure MIT, so GitHub detects it) · NOTICE (the attribution)
docs/       PROJECT.md · ARCHITECTURE.md · BLUEPRINT.md · images/README_hero.png
.claude/    hooks/guard-repo.mjs
```

`scripts/count-lines.ts` at 1.0.0: 19,777 lines of TypeScript in 110 files under `src/` (tests, test-support excluded); 1,277 lines of browser JS/HTML/CSS; 18,027 lines of tests and harness in 71 files; 8 live arcs. Re-derived from the tree: 18 service keys, 27 session log kinds, 35 composition rows, 16 RPC methods.
