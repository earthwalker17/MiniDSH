# MiniDSH Architecture

MiniDSH is one runtime composed from plugins over a tiny kernel. Everything the model can see is derived from an append-only session log; everything the model can do goes through a guarded tool pipeline; every surface (headless CLI today, protocol clients and GUIs later) only renders the log and drives the agent registry. The reference it re-derives from is DeepSeek Harness (DSH); §12 lists where MiniDSH deliberately differs.

## 1. Layers and dependency direction

```
src/app/           application assembly + surfaces: compose.ts (rows + patches), headless.ts, cli.ts, home.ts
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

- **Context** — a non-mutating tree. `child({scope?})` derives a context carrying a scope tag; registrations made through a context are attributed to it and unwound with it (registration context = visibility = lifetime).
- **Services** — `provide(key, value)` is an effect; a key is claimed once per context chain (a child may shadow). `get(key)` is strict: a plugin may only read keys it declared in `inject` or provided itself; `tryGet` is the optional read. Keys are typed tokens (`serviceKey<T>('sessions')`), not declaration merging.
- **Plugins** — `{ name, inject?, apply(ctx, config) }`. An instance is `pending` until every injected key is provided, then `loading → active`. Its activation epoch is the tuple of providing instances; when a dependency disappears the plugin unloads (effects unwound), when a provider is replaced it reloads. Transitions are serialized per instance. `settle()` resolves when nothing is loading and reports plugins still pending with their unmet keys so boot can fail loud.
- **Effects** — `effect(fn → disposer, label?)` pushes onto the owning instance's disposer stack; disposal is strict reverse order (temporal composability).
- **Events** — typed tokens carry their dispatch mode: `emit` (sync notification, listener exceptions contained), `waterfall` (around-middleware; listeners receive `next()` and may short-circuit), `serial` (awaited in order), `parallel` (`allSettled`, aggregate error). Dispatching with the wrong method is a compile error. A dispatch may carry a `scope`; listeners registered from a scoped context are admitted only for their scope (or `global: true`). `observe(hook)` sees every dispatch before delivery — the seam runtime invariants hang on.

There is no loader, HMR, isolate realm, proxy, mixin, or accessor. Registries take the owner context explicitly (`tools.register(ctx, def)`) instead of inferring it through a proxy.

## 3. Core contracts (`src/core`)

| ctx key | owns | must not own |
|---|---|---|
| `sessions` | `Session` = header + append-only log + surface + derivation; store `create/get/list/fork/flush/detach`; events `session/created`, `session/event` (post-commit, contained), `session/flush` (parallel durability checkpoint), `session/disposed`; seed construction (replay and fork; resume later) marked by `session/end-seed`; crash repair closing an open tail turn; the pure `deriveEventMessage` and `foldRequestHeader` | persistence backends, UI state, the model |
| `llm` | provider-neutral vocabulary (§5); adapter registry; `stream(request)` as the `llm/stream` waterfall whose terminal continuation looks up the adapter; normalization of adapter failures into a terminal `finish{error|aborted}`; the stream-protocol validator; `BlockAssembler`; `resolveModel(provider, model)` | API keys, session state, the default model (application assembly) |
| `tools` | `defineTool` (zod input → JSON Schema; zod output; `render(args, value)`; `execute(args, exec)`; `presentCall?`); `register(owner, def)`; `schemas(agent?)` and `get(name, agent?)` with the viewing scope passed explicitly; the execution pipeline (§6) and total error normalization | policy |
| `prompt` | ordered named sections, exactly one `complete` section (restored after the waterfall), strict `{{var}}` variables, tool-schema provider, `assemble(agent)` → `system-prompt/assemble` → `{system, tools}`; sections are stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request({agent, toolName, callId?, reason?, signal?}) → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` over the `approval/request` waterfall (default `unavailable`); requires an open turn; audit events `approval/asked` / `approval/decided` | answer logic |
| `fs` | `resolve(path, cwd)`, `stat`, `readText`, `writeText(target, text, intent)`, `listDir`; `fs/write-intent` and `fs/edit-intent` single-slot waterfalls, `fs/observed` live emit; `FsError{code}`; `workspaceRoot(session)` | tool schemas |
| `shell` | `sessionFor(agent) → ShellSession{exec, restart, dispose}`; the provider owns the process table and binds each shell's disposal to the owning agent's context | model-facing descriptions |
| `agents` | `Agent{id, session, inbox, status, ctx, send/followup/steer/inject, cancel, whenIdle}`; `AgentHandle{agent, dispose}`; registry `create/get/list` through the registered factory; durable inbox projection (`inbox/spliced`); the `agent/*` event vocabulary | the driver |
| `invariants` | `register(owner, name, installer)` in a child context; selection by config; pre-commit validation through kernel `observe` applied on publication | product logic |
| `loop` | the driver (§6); registers itself as the agent factory | anything extensions do |

Agent id = session id. A capability seam is complete only with all three roles: Definition (core), Provider (capability), Consumer (capability, usually a tool).

## 4. Canonical facts: the session log

The log is the single source of truth. Envelope `{type, seq, time, data}`, `seq === log.length`, data JSON-lossless and deep-frozen at append. The three **surface** events — `user/message`, `assistant/message`, `tool/result` — additionally carry `surfaceOp: 'append' | {op:'replace', start, end}` and `sourceEventSeqs`; model history is the fold of surface nodes through `deriveEventMessage`, never a filter over raw events. This is what lets a later compaction provider replace a range without mutating history.

Vocabulary (Session 1): `turn/start`, `turn/end{reason}` (`completed | blocked | cancelled | error | max-tokens | max-steps | interrupted`), `step/start`, `step/end`, `user/message`, `request/header{provider, model, reasoningEffort?, maxTokens?, system, tools; reason: initial|change|resume}`, `assistant/chunk` (replay/UI fidelity, never derived), `assistant/message{message, usage?, interrupted?}`, `tool/call`, `tool/result`, `inbox/spliced`, `approval/asked`, `approval/decided`, `session/end-seed`. The header `{version, id, createdAt, cwd, parentId?, seedLength?}` lives beside the log, not in it. `SESSION_FORMAT_VERSION = 0`; unknown event types are refused on load unless marked `ignorable`.

**Model-visible ⟺ logged.** Every request the loop sends equals `deriveMessages()` plus the folded `request/header`; a runtime invariant rebuilds both at `llm/stream` and fails on any divergence. Persistence is a subscriber (`session/event` → append one JSON line; `session/flush` awaited at turn end, where a swallowed write error is rethrown), stored under `MINIDSH_HOME` (default `~/.minidsh`) as `sessions/<id>.jsonl` with the header as line 1.

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
  llm.stream(frozen request) → assistant/chunk* → assistant/message{usage}
       finish error ⇒ agent/request-error (waterfall) → retry | turn/end{error}
  tool calls in model order: tool/call → tools.execute → tool/result      (cancel ⇒ ABORTED_BEFORE_DISPATCH results)
  step/end → next step while tools owe a request or next-step input exists (≤ maxSteps)
  agent/turn-stopping (serial) → re-read inbox
turn/end{reason} (exactly once) → session/flush → next turn or idle
```

`agent/status` is emitted only on real `idle ↔ running` transitions; one `AbortController` per turn; `cancel(cause)` clears the inbox and aborts; `whenIdle()` is quiescence; dispose = cancel → whenIdle → unwind scope → detach agent → detach session. One `send()` never shares a turn with another.

Tool execution: validate args → `tools/pre-execute` (`allow | deny | ask`; `ask` → `approval.request`, anything but `allowed-once` denies) → monotonic deny-only guards → `tools/execute` (around; may replace only the signal) → body → validate + freeze value → `render` → `tools/post-execute` (`accept{content?|value?} | block{feedback}`) → normalized `ToolExecutionResult` → `tools/result`. Every throw becomes an `isError` result with `Error: …` content and optional `{name, code}`. Only `{name, description, parameters}` of a tool ever reaches the model.

## 7. Authority

The model proposes; plugins decide. In Session 1 the seam is complete and the boundary is minimal: `policy-workspace` denies editor targets outside the canonical session cwd; `approval-headless` answers `allowed-once` only under `--approve`, otherwise the default `unavailable` fails closed; audit pairs are logged. Sandbox modes, per-call policy shared by fs and shell, and durable policy switching arrive in Session 3 (see §13).

## 8. Surfaces

A surface is a plugin that injects only `agents` and `sessions`, owns transport and process exit, and renders from `session/event`. Session 1 ships the headless CLI: `minidsh run "<task>" [--cwd] [--model] [--effort] [--max-steps] [--approve] [--json]` — boot → `settle()` → `agents.create` → `followup` → `whenIdle` → `flush` → last assistant text on stdout, exit 0 iff the turn completed; `--json` streams raw session events; `minidsh sessions show <id>` reads the log. The wire types are the core types; there is no DTO layer.

## 9. Composition

`Row{id, plugin, config?, disabled?}`; `Patch = {id, config?|disabled?} | {insert: Row[]}`; `applyPatches(rows, patches)` replaces a row's whole config, warns and skips unknown ids, and re-indexes inserts. It is the one algorithm used for boot and for `--dump-config`. `app/compose.ts` declares the default rows (including the default model); CLI flags become patches. Environment: `DEEPSEEK_API_KEY` (referenced by name only), `DEEPSEEK_BASE_URL`, `MINIDSH_HOME`, `MINIDSH_MODEL`.

## 10. Verification

Tests mount real compositions through the kernel; only the model is scripted (`test-support/scripted-adapter`) or replayed from a recorded session log (`test-support/llm-replay`, which derives the script from `assistant/chunk` groups and asserts every recorded call was consumed). Because the replay script is derived from the same JSONL the harness persists, **a live session log is its own test oracle**: recording costs one real run.

Runtime invariants — the session relational trace (seq contiguity, turn/step balance, numbering, call/result pairing), agent status no-repeat, and request reconstruction (registered with `prepend` so nothing can silence it) — run in every test *and* in live runs, because `compose()` mounts them by default. End-to-end verification asserts the world (re-run the test suite, byte-compare untouched files), never the agent's self-report.

Gates: `pnpm check` = `tsc --noEmit` + `oxlint` + `check-deps` + `vitest`; plus a live run against the real provider before a session closes.

## 11. Where new things go

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: register an adapter on `llm` |
| a model-facing capability | `capabilities/tool-<x>`: register on `tools` (+ a prompt guidance section) |
| an execution world (sandbox, remote) | providers for `fs` and `shell`; tools untouched |
| a policy or approval answerer | listeners on `tools/pre-execute` / `approval/request`; guards |
| durable state | a new session event type, rendered and replayed from the log |
| context for the model | `agent.inject()` or an `agent/pre-step` listener — never ad-hoc prompt text |
| a surface | `app/` or a new package: consume `session/event`, drive `agents`; zero semantics |
| a per-agent variant | registrations through `agent.ctx` |
| context management | a compaction provider appending `surfaceOp: replace` events |

If a new thing has no row here, that is an architecture question to settle before implementation.

## 12. Divergences from DeepSeek Harness

- Own kernel instead of Cordis (DSH uses a small subset; proxies, realms, loader, HMR are dispensable at this scale).
- One package with a dependency gate instead of ~150 packages.
- Sequential tool execution; no scheduler.
- Persistent shell over piped stdio with marker framing instead of a PTY.
- No YAML loader, presets, settings/credentials services, attachments, Code Mode, subagents, compaction backend, workspace entity, session projections, or chunk-row packing until a session needs them.

## 13. Known limitations (current)

- **The shell is unconfined while the editor is workspace-fenced.** `policy-workspace` is a seam demonstration, not a boundary: a model can write outside the workspace through the shell tool. DSH's single `writableRoots` exists precisely to forbid this asymmetry; Session 3 replaces the plugin with per-call sandbox policy shared by fs and shell.
- **No `resume`.** Persistence writes and reads logs and the seed path is exercised by fork/replay, but the core has no persistence Definition, so `agents.resume(id)` does not exist yet (Session 2).
- Session events are appended synchronously inside the `session/event` listener; a write failure is remembered and rethrown at the next `session/flush`, but there is no write-behind batching.
- A shell command that reads stdin blocks until the tool timeout, then resets the shell.
- Single provider (DeepSeek), text only: no images, no attachment plane.
- The inbox is in-memory; its splices are not yet durable events, so a resumed session would not reconstruct pending input.
- No compaction: a long enough session grows its request until the provider's context window rejects it.

## 14. File map

```
src/kernel/     tokens.ts (service/event keys) · bus.ts (listeners, scope filter, observers)
                context.ts (Context, plugin instances, effects, realms) · errors.ts · index.ts
src/core/       json.ts (JSON discipline) · ids.ts (branded ids)
  session/      types.ts (event kinds, envelope, header) · session.ts (the log) · surface.ts
                (deriveEventMessage, foldRequestHeader, Surface) · store.ts (ctx.sessions + events)
                repair.ts (interrupted-tail closers) · invariant.ts (relational trace)
  llm/          types.ts (vocabulary, adapter contract) · message.ts · assembler.ts
                runtime.ts (ctx.llm, llm/stream waterfall, protocol validator)
  tools/        types.ts · registry.ts (ctx.tools + pipeline) · presentation.ts · index.ts (defineTool)
  prompt/       index.ts (ctx.prompt, sections, variables, assemble)
  approval/     index.ts (ctx.approval, approval/request waterfall, audit events)
  fs/           index.ts (Definition: FsTarget, intents, fs/* events)
  shell/        index.ts (Definition: ShellSession)
  agent/        types.ts · index.ts (Agent, ctx.agents, Inbox, agent/* events) · invariant.ts
  loop/         driver.ts (the turn/step machine) · factory.ts (ctx.agents factory + plugin)
                marker.ts (loop-request identity) · invariant.ts (request reconstruction)
  invariants/   index.ts (ctx.invariants registry)
src/capabilities/
  llm-deepseek/ sse.ts · translate.ts · serialize.ts · adapter.ts · index.ts
  llm-retry/ · fs-local/ · fs-observation-policy/ · tool-editor/ · shell-stdio/ (index + process)
  tool-shell/ · persistence-jsonl/ · approval-headless/ · policy-workspace/ · context-runtime/
src/app/        home.ts · compose.ts (rows, applyPatches, mount) · headless.ts (runTask) · cli.ts
src/test-support/ scripted-adapter.ts · harness.ts (real composition) · llm-replay.ts
scripts/        check-deps.ts (dependency-direction gate)
```

About 5,500 lines of implementation and 1,700 lines of tests across 70 files.
