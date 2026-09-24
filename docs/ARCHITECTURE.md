# MiniDSH Architecture

One runtime composed from plugins over a tiny kernel. Everything the model sees derives from an append-only session log; everything it does goes through a guarded tool pipeline, fenced at the effect boundary by an authority the log records. The model is a capability the runtime routes to, not the agent: the route is a durable fact, a purpose may take a different one, a delegated child cannot widen its authority. Bytes the model was shown live beside the log, content-addressed, never in it. Every surface only renders the log — by the page, never whole — and drives the agent registry; a session survives its process.

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
| `capabilities/<x>` | `kernel`, `core` except `core/loop`; no other capability, no `app` |
| `app` | anything |
| `test-support`, `*.test.ts` | anything (test files are exempt from the gate) |

**Payloads** are read via `matches(event, KIND)`, never `event.data as {…}`, outside tests. **Core is acyclic at file level** (packages may cycle): each package's `events.ts`/`types.ts` sits below its service. A capability is a directory, not a package; the browser client shares only the wire with the host.

## 2. Kernel (`src/kernel`)

Five mechanisms (`kernel/index.ts`), no loader or HMR; registries take the owner context explicitly.

- **Context and services.** `child({scope?})` derives a scoped context; scopes are flat. `provide` is an effect; a key is claimed once per context chain (a child may shadow); `get` needs the key `inject`ed or self-provided. Deployment-global registries refuse a scoped owner.
- **Plugins.** `config` is a structural `{parse}` contract (the kernel imports no schema library), parsed before `apply` (`PLUGIN_CONFIG`). `pending` until every injected key is provided; a vanished dependency unloads, a replaced provider reloads. Effects dispose in strict reverse order and unwind before dependents unload: **a disposer must not read the services its plugin injected**.
- **Events.** A token carries its dispatch mode (`emit`, `waterfall`, `serial`, `parallel`); a waterfall's `next()` is single-shot, so no middleware can run a tool body twice. `observe` sees every dispatch before any listener, where runtime invariants hang.

**Scope contract** (`core/scope.ts`). Registration context = visibility = lifetime: unscoped is deployment-global, an agent's `ctx` registers into its layer. A registry view is the globals plus exactly one agent layer; a local entry shadows a global; no inheritance between scopes. An agent's operation events dispatch in its scope (`agent/*`, `tools/*`, `approval/request`, `system-prompt/assemble`, `fs/*`); `llm/stream` and `session/*` are unscoped. Consumers get the agent as subject, never services via `agent.ctx`.

## 3. Core contracts (`src/core`)

Eighteen service keys: seventeen `core` (below) + app-only `app-composition`; `loop` is a plugin, not a key. A seam needs all three roles: Definition (core), Provider (capability), Consumer (capability, usually a tool). Agent id = session id.

| ctx key | owns | must not own |
|---|---|---|
| `sessions` | `Session`: header + append-only log (§4) + surface; commit = validate → observe → push → deliver, so an invariant rejects before commit; **session publication follows agent publication** (`publish`); `repairInterruptedTail` (§4) | persistence backends, UI state, model |
| `persistence` | READ Definition: `load(id)` → the readable prefix (`damaged?`); `list()` newest-first, each titled from a bounded prefix | the write path (a provider owns format, materialization, attach); repair; deletion |
| `credentials` | `CredentialRef`: a validated env-var NAME, all that config, logs and errors carry; `resolve` fresh per call; `declare`/`declaredRefs`: the refs treated as secret (§9) | storing or logging values; which layers exist |
| `presets` | key `authority-presets`: `presetTable` (`custom` reserved), pure `presetFor`, the log-only `authority/preset` intent (§7) | enforcement; knobs; a `defaultPreset` |
| `llm` | the provider-neutral vocabulary and a deployment-global adapter registry (§5); `stream` = the `llm/stream` waterfall, whose terminal continuation picks the adapter | API keys, session state, default model |
| `tools` | `defineTool` (`tags?` never model-facing, §11); `restrict`: one resolver, so a hidden tool is unknown to the model and refused if called; `ToolCall.onDispatch` and the pipeline (§6) | policy |
| `prompt` | ordered named sections + strict `{{var}}` variables, one `complete` section; `assemble(agent)` → `system-prompt/assemble`; sections stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request` → `allowed-once \| rejected \| cancelled \| unavailable` on the `approval/request` waterfall (default `unavailable`); `id` = the `approval/asked` seq; `reason` clamped before the log, `subject` its trusted half; `ApprovalPolicy` `ask \| never`, `never` rejecting before dispatch and any grant; `grants`/`revoke` (§7) | answer logic; model-facing prose; a public `grant` |
| `fs` | `fs/edit-intent` (read-before-edit) and `fs/observed`; **fences every mutation** before any effect (`FS_SANDBOX_DENIED`), reads always pass (§7); `readBytes` emits no observation | tool schemas; policy itself |
| `shell` | `sessionFor(agent)` → `ShellSession`; `enforcementFor(mode)`; `exec` reports the `enforcement` it got and REFUSES what it cannot enforce (`SANDBOX_UNAVAILABLE`) unless the call's `accepts` admits it (§7), or an unstartable binary (`SHELL_UNAVAILABLE`) | model-facing descriptions; negotiation |
| `sandbox` | the authority stamp (`SandboxMode`, `sandbox/mode`); the pure `writableRoots`/`allowsWrite` every fence derives from; the ACCEPTANCE knob (`sandbox/acceptance`; `strictest` over enforcement is the INVERSE of `narrowest` over modes). All §7 | enforcement backends; what any tool may do; **what the model is told of it** |
| `compaction` | `compactNow(agent)`; the log-only bracket `compaction/start\|applied\|end`; PURE `planCompaction` (the pairing rule, §6) | threshold, summary, trigger |
| `attachments` | content-addressed `AttachmentRef`; `saveImage/readImage/hostPath`; **an image is validated and durably committed before its owning session event is appended** (§5) | normalization; retention; who may look |
| `spill` | output with NO OTHER HOME: `save` → `{path, bytes}`; head/tail excerpt renderers | threshold (each tool's own) |
| `settings` | REMOTE-writable defaults: `register/describe/read/write` (`expectedRevision`, §8); two layers merged one level deep; `settings/changed` | store; authority; composition; anything a resumed session recorded |
| `agents` | `create/resume/fork/get/list`. **Creation is a TRANSACTION**: session unpublished → agent + scope → opening `agent/options` → `world` → `setup` → register → publish; a failure rolls back unannounced. `configure` is the durable route switch (§4); `resume` = `load` (refusing `damaged`) → `repairTail` (§4) → seed → the same transaction; `fork` refuses a boundary below a delegated child's opening stamps (§7) | driver |
| `invariants` | `register(owner, name, installer)`: deployment-global, config-selected, validating pre-commit via `observe` | product logic |
| `loop` | the driver and its durability checkpoints (§6); registers itself as the agent factory | anything extensions do |

## 4. Canonical facts: the session log

The log is the single source of truth: `{type, seq, time, data}`, `seq === log.length`, frozen at append.

- **Three tiers** (`core/session/types.ts`). **Surface** kinds (`user/message`, `assistant/message`, `tool/result`) carry `surfaceOp` and `sourceEventSeqs` (a fact carries neither); model history is their fold (`deriveEventMessage`). Every other kind is a log-only **fact**, except **trace** (`TRACE_TYPES`), never folded at runtime (folds walk `Session.facts`). A new kind is a fact, or trace if nothing folds it.
- **Vocabulary: 31 kinds**, by owner under `core/`. session: `turn/start|end`, `step/start|end`, `user/message`, `assistant/chunk|message`, `tool/call|dispatch|result`, `request/header|context`, `session/title`, `session/end-seed`; agent: `agent/options`, `inbox/spliced`, `subagent/start|end` (the PARENT's log); approval: `approval/asked|decided|grant|policy`; sandbox: `sandbox/mode|acceptance`; presets: `authority/preset`; compaction: `compaction/start|applied|end`; effects: `effect/recorded`; llm: `llm/aux-call`; plus `composition/applied` (`capabilities/composition-record`); fields live at each declaration.
- **Format.** `SESSION_FORMAT_VERSION = 0`, additive; a newer stored version refuses at load and attach; an unknown kind loads as an opaque fact only while it carries neither surface field (§13).
- **Arrival versus rewrite.** A `user/message` that ARRIVES sits inside an open turn; one that REPLACES a range is a rewrite and may land between turns (`core/session/invariant.ts`).
- **The route is one fact in two records.** `agent/options` is the BASE (`configure` writes `change`); `request/context` the EFFECTIVE route per step (§6), written on any difference. Every reader takes the window and modalities from the log, never a live adapter. A role rewrites header and context, never the base. `request/header` is written only on change, so each request append-extends the last (prefix caches). A field added to a written-on-change record reads as absent in any session that never rewrites it.
- **Opening facts.** `agent/options{initial}`, `approval/policy{initial}`, `sandbox/mode{initial}` and `composition/applied` land before publication; a delegated child's are §7's.
- **The durable inbox** is `inbox/spliced`, op-shaped (`core/agent`). A claim commits after the entered `user/message`s, so a pre-step crash re-delivers, never loses; a resumed agent wakes iff a waking insert is queued, a fork never.
- **Crash repair closes everything the log left open** (`core/agent/repair.ts`). Resume and cold fork run a STATIC list, innermost first: unpaired `subagent/start` → `subagent/end{interrupted}`; unpaired `compaction/start` → `compaction/end{declined: unclosed}`; then the session's own `repairInterruptedTail` (`core/session/repair.ts`). Closers are pure, sharing one timestamp, so a cold read and a durable repair produce identical bytes.
- **A synthetic result states the evidence, in order**: no `tool/call` ⇒ `TOOL_NOT_STARTED`; a `tool/dispatch` or a recorded effect ⇒ `TOOL_OUTCOME_UNKNOWN`; neither, in a log that records dispatches AND kept an event written after the call ⇒ `TOOL_NOT_STARTED`; else `TOOL_OUTCOME_UNKNOWN`. Both third-row conditions are load-bearing (`classify`). An unknown result names that call's effects recorded in the step.
- **An effect is recorded by the code that caused it, after it happens** (`core/effects/events.ts`). `fs-local` and `shell-stdio` append `effect/recorded` (`fs-write | shell-command`, keyed by `callId`) from values they computed. **Presence is proof; absence proves nothing.** Closed families, no exactly-once (§13). `EffectIntent` is the "about to do" half: never logged alone, only a consent's `subject` and a grant's identity (§7).
- **A `session/event` listener may not append synchronously.** A nested append reaches persistence before its cause (seqs N+1, N: `damaged` at resume); queue it on a microtask.
- **Model-visible ⟺ logged.** Every request equals `deriveMessages()` plus the folded `request/header`; checked in the `llm/stream` preflight (`core/loop/invariant.ts`).
- **Persistence is a subscriber** (`persistence-jsonl`): `sessions/<id>.jsonl` (§9), materialized on a session's first conversation fact. A torn final line moves to `.torn`; deeper corruption is `damaged` and refuses attach. `session/flush` rethrows a remembered write error, every time. **No `fsync`**: the modelled failure is a crash, which the page cache survives (§13).
- **Single writer per stored session.** A `<id>.jsonl.lock` lease is held from publication to disposal, reclaimed only from a holder provably dead on this host, else refused by name. **Reads never lock**; a resume flushes inside the creation transaction, so a held lease rejects it before paid work.

## 5. LLM vocabulary and the two adapters

`core/llm/types.ts` is the provider-neutral vocabulary: `Message`, `ContentBlock`, a closed `StreamChunk` protocol ending in one `finish`, `LlmFailure` (policies route on `code`, never message text) and DISJOINT `TokenUsage`.

- **Adapters are deployment-global**: an `LlmAdapter` registers on `llm` from an unscoped owner, never a scoped one (`SCOPED_OWNER`, `core/llm/runtime.ts`).
- **Refuse before I/O, never degrade.** An option the provider cannot honour is `UNSUPPORTED_OPTION`, `UNSUPPORTED_REASONING_EFFORT` or `UNSUPPORTED_CONTENT` before any I/O, never dropped, aliased or clamped: the logged request is the served one.
- **Replay state.** A signing provider's opaque `ReplayEnvelope` rides the terminal `finish` and is stored on the assistant source; the `llm/stream` terminal continuation strips it for any other provider AFTER the reconstruction observer, so the log still records what the model saw.
- **Retry is a capability** (`llm-retry`, on `agent/request-error`), so failed attempts stay durable. A model call that is not a turn is `runAuxCall` (`core/llm/aux-call.ts`): one log-only `llm/aux-call` (§4).
- **Images: a reference plus a STORED descriptor** (`core/llm/content.ts`). Both hold: **refuse at admission** (a producer refuses when the STEP's route lacks `image`, before any I/O) and **substitute at projection** (a text-only route is sent `block.text`, since history outlives the model that first saw it). An image route with no store is `UNSUPPORTED_CONTENT`; lost bytes are `ATTACHMENT_UNREADABLE`, not retryable.
- **`llm-deepseek`**: cache hits subtracted from `prompt_tokens`; `reasoning_content` always sent, since thinking mode with tools refuses a tool-call turn without it.
- **`llm-anthropic`**: a catalog MEASURED against the live API; a signed thinking block is echoed only to the provider that produced it.

## 6. The loop and the tool pipeline

`core/loop/driver.ts` is the one agent driver; `core/tools/registry.ts` is the only path from a model's call to a tool body.

```
followup(m) → next-turn FIFO (wakes)   steer(m) → next-step (wakes)   inject(m) → next-step (no wake)
turn/start
  claim → resolveCallConfig (agent/request) → request/context when changed
        → agent/pre-step (waterfall: reject | enter{messages})   reject ⇒ turn/end{blocked}
  step/start → user/message per entered message
  prompt.assemble → request/header when changed
  CHECKPOINT → llm.stream(frozen request) → assistant/chunk{attempt}* → assistant/message{usage}
       finish error ⇒ agent/request-error (waterfall) → retry (next attempt, same route) | turn/end{error}
  tool calls in model order: tool/call → CHECKPOINT → tools.execute → [gate → tool/dispatch → CHECKPOINT → body] → tool/result
       (cancel ⇒ ABORTED_BEFORE_DISPATCH results; a lost write ⇒ DURABILITY_LOST results, none run)
  step/end → next step while tools owe a request or next-step input exists (≤ maxSteps)
  agent/turn-stopping (serial) → re-read inbox
turn/end{reason} (exactly once) → session/flush → next turn or idle
```

- **Durable before every action.** A CHECKPOINT is `session.flush()` (§4); a lost write ends the turn `DURABILITY_LOST`. A call's second makes `tool/dispatch` durable after the gate. The DRIVER writes it (one writer of the call family; a lost write must end the turn, not become a result), via `ToolCall.onDispatch`, awaited INSIDE the `tools/execute` terminal continuation: a middleware answering without `next()` replaces the body.
- **The route is resolved once per step**, before `agent/pre-step` (a pressure check measures this step's window), fixed for the step, retries included; a switch lands at the next step.
- **Pipeline**, in the acting agent's scope: validate → `tools/pre-execute` → deny-only guards → `ask` ⇒ `approval.request` → deadline → `tools/execute` (around-middleware) → body → `render` → `tools/post-execute` → `tools/result`. Guards run before the ask, so a call they refuse never interrupts a person. A throw is an `isError` result `{name, code}`; the model sees only `{name, description, parameters}`.
- **Deadlines are the pipeline's**, clocked after the gate: expiry is `TOOL_TIMEOUT`, the body abandoned, neither killed nor awaited.
- **Pressure** is `core/metering`, a pure fold over log facts (§11).
- **Compaction** (`compaction-basic`): pressure on `agent/pre-step`, `CONTEXT_WINDOW_EXCEEDED` on `agent/request-error`, explicit `compactNow`. The kept tail never begins with a `tool/result`. Each attempt is bracketed `compaction/start` → `compaction/end`, its summary an `llm/aux-call`; an applied one writes `compaction/applied`, then one replacing `user/message` citing every shadowed seq. **The hazard is the await**: `planIsLive` is re-checked with no `await` before the append. A summary not smaller than its span is refused; automatic triggers stop after `maxSummaryFailures`, `/compact` never does.
- **Bounded recall** (`tool-history`): `history_read` reads only this session's shadowed seqs, hidden until the first applied compaction. A call over budget is refused, not truncated; per-session spend is a fold over the log, so compacting cannot refill it.
- **Spill** (`core/spill`) takes only output with no other home; the model gets an excerpt and the path.
- **Workspace instructions**: `AGENTS.md` enters as a durable `user/message`, never a prompt section (§3), only into a non-empty first-step batch.

## 7. Authority

The model proposes, policy decides, the effect boundary enforces; every decision is a fact in the log.

- **One stamp.** `SandboxExecutionPolicy{mode, workspaceRoot}` resolves per call from `ctx.sandbox`, never caller-assembled; mode governs FILE EFFECTS only. The root is the immutable `SessionHeader.cwd`, so the wire may not choose it (§8). `writableRoots(policy)` is a CEILING for both families: grant less, never more (`core/sandbox/index.ts`).
- **Enforcement lives at the effect, not the gate.** `fs-local` canonicalizes and contains every write in process, refusing `FS_SANDBOX_DENIED` before any effect; reads always pass. It follows symbolic links itself (`core/sandbox/paths.ts`) but cannot detect a hard link (§13). Inside the provider, it needs no policy plugin at `tools/pre-execute`.
- **Untrusted code is the shell's problem.** `shell-stdio/confine/` wraps the spawn: bwrap on Linux, Seatbelt on macOS, none on Windows (§13). Each is PROBED with its real `read-only` profile, never by `which`: `enforcement` is recorded at agent creation (`enforcementFor`). A host with no working backend REFUSES a confined policy (`SANDBOX_UNAVAILABLE`). A confined child is spawned `detached` on POSIX.
- **Spawn-time binding.** A backend wraps the persistent child once, under the session's policy; a durable `setMode` replaces it. An approved one-shot escalation is a throwaway child leading its own POSIX process group, each group reaped at disposal (`core/shell/index.ts`).
- **The escalation path.** A refusal is a fact with one legitimate move: the SAME command once more with `sandbox_permissions` (strictly wider) and a `justification`, `ctx.approval` consenting to that call. An unstartable binary is `SHELL_UNAVAILABLE`, a failing wrapper `SANDBOX_UNAVAILABLE`. Under a backend the kernel's refusal reads as a failing command; the backend's denial words earn a hint, never a classification (`tool-shell`; §13).
- **Consent is to the runtime's record.** An ask's `subject` is an `EffectIntent` (§4) the REQUESTER builds from validated arguments, naming the authority the effect would run under (`tool-shell`: `{command, mode, enforcement}`). The model's `justification` stays in `reason`, clamped, never in the subject. The seam escapes subjects injectively (`escaped`); a cut one is `truncated` and has no `intentKey` (`core/effects/events.ts`). `openApprovals` joins each ask to its `tool/call`; past 16 KB the surfaces send a person to `sessions show --json` rather than hide the call's tail.
- **Acceptance.** The `enforcement` beside a stamp is a HOST fact of the shell world; `sandbox/acceptance{accepts, forMode, reason}` is a DECISION, `full` (default) or `none`, for exactly `forMode`, because `confine()` is mode-blind and a bare `accepts` would void `read-only` too (`core/sandbox/events.ts`). It rides `ShellExecRequest.accepts` per call (`acceptsFor`); it relaxes the REFUSAL, never a backend (`wrap()` is unconditional), and the fs fence and ceiling stand. `--accept` sets the row's default: its only path into a wire-opened session.
- **A consent may outlive one call, never its session.** `approval/grant` is log-only, identified by `toolName` plus the exact subject's `intentKey`: a REPEATED IDENTICAL action, not a policy language. It is live only once its own ask is `allowed-once`, and until any `approval/policy`, `sandbox/mode`, `sandbox/acceptance` or `authority/preset` follows (`core/approval/events.ts`). The fold runs inside `request` before `approval/asked` is appended, so a granted call is never shown as open.
- **The scope is the host's to offer.** `openApprovals` computes `offers`, and `approval/answer{offer}` is re-validated by the same fold; no host, no grant. There is no public `grant`; `grants`/`revoke` (`approval/revoke` on the wire) show and take one back.
- **A record is not a fence.** `effect/recorded` (§4) sits beside the boundary; losing one loses evidence, never containment.
- **Every decision is durable.** `sandbox/mode{mode, enforcement, reason}` and `approval/policy{policy, reason}`: `initial` at creation before publication, `change` only on change, sandbox `resume` when a resumed host enforces differently. The setter IS the event (acceptance and grants too); `context-runtime`, never the service, writes what the model reads. Precedence: approved one-shot escalation > recorded fold > composition default; a resume keeps what was recorded. `approval/decided` records who decided (`decidedBy`) and under which grant. `approval-headless` fails closed (`unavailable`) except under `--approve` or an exact `allow` entry. `sessions show --audit` projects the plane.
- **A delegated child opens under a ceiling.** `tool-subagent` captures the parent's authority before the first await, stamps it in `setup`, `reason:'delegation'`: the mode as a CEILING, approvals pinned `never` (before dispatch and any grant), acceptance `strictest(parent, row)` as a PIN. Widening is refused (`SANDBOX_CEILING`, `APPROVAL_PINNED`), and `setAcceptance` refuses on any delegated session; narrowing is legal. A resumed child keeps its ceiling; `fork` refuses a boundary below its opening stamps.
- **Presets select, the knobs decide.** `AuthorityPresets.apply` appends the log-only `authority/preset` intent, then writes through `setMode`/`setPolicy`; the current preset is DERIVED (`core/presets`).
- **Consent-by-composition.** `approval/request` dispatches in the asking agent's scope, so a preset-mounted (§9) answerer can auto-approve for its own agent: code-equivalent trust, every pair audited. It cannot widen enforcement (the fence and shell resolve the global `SANDBOX`) nor reach a deployment-global registry.
- **`core-authority`** (`core/sandbox/invariant.ts`) rejects a forged authority fact or subject pre-commit, holds every approval to one decision and a delegated session to its ceiling and pins, and refuses an `approval/grant` naming no open `intentKey`-identical ask in this log, truncated, or written by a delegated session.

## 8. Surfaces

A surface injects only `agents` and `sessions` (plus `llm`, `sandbox`, `approval` for the catalog and authority control), owns transport and process exit, renders from `session/event` and holds no authority state: a switch it asks for is a durable event it reads back. Plain-text surfaces share `app/present.ts`, which neutralizes control characters.

- **Headless CLI** (`app/cli.ts`): `run "<task>"`, `resume <id> "<task>" --headless`, `fork <id> "<task>" [--at seq] --headless` exit 0 iff the turn completed, 2 on a usage failure. An unlisted flag is refused; `--json` streams the wire's `{sessionId, event}` frame; explicit authority flags are a durable switch (§9). `minidsh config` shows the effective composition (§9), `sessions show --audit` the authority timeline (§7).

**Protocol** (`capabilities/protocol`): JSON-RPC 2.0; one plugin, one host, N carriers (stdio, in-process, WebSocket).

| method | params → result | rule |
|---|---|---|
| `initialize` | `{}` → catalog, defaults, workspaces | defaults live from settings |
| `session/prompt` | `{sessionId?, text, mode?: followup\|steer\|auto, agentOptions?, cwd?, workspaceId?, path?}` | no id creates, live delivers, stored resumes; the host resolves `auto`; `cwd`/`workspaceId` place a NEW session under `workspaceRoots`, refused beside `sessionId`; a route with no adapter here is refused |
| `session/attach` | `{sessionId, limit?} → {header, view, page, cursor}` | subscribes BEFORE the cut; `view` (`SessionView`) is the folds a page cannot compute, with no pending approvals on a cold read |
| `session/page` | `{sessionId, throughSeq, beforeSeq?, limit?}` | beneath the attach cut |
| `session/detach` | `{sessionId?}` | no id narrows to NOTHING |
| `session/events` | `{sessionId, fromSeq?, toSeq?, limit?, omitTrace?}` | every tier; the bounded gap repair |
| `sessions/list` | `{workspaceId?}` | live and stored, live wins; derived `title` |
| `session/cancel` | `{sessionId, keepQueued?}` | `keepQueued` spares the durable inbox |
| `session/compact` | `{sessionId} → compacted \| scheduled \| nothing-to-do` | HUMAN command, never a model tool |
| `approval/answer` | `{sessionId, id, outcome, offer?} → accepted \| not-pending` | first answer wins; only from a connection that may see the session; an `offer` the fold did not make is refused |
| `approval/revoke` | `{sessionId, grantId}` | ends one grant (§7) |
| `session/authority` | `{sessionId, sandbox?, approval?, accepts?, preset?}` | each switch IS its durable event |
| `session/model` | `{sessionId, provider?, model?, reasoningEffort?}` | each field one `agent/options{change}` |
| `settings/describe`, `settings/get`, `settings/set` | `{ns, patch, expectedRevision, replace?}` | `expectedRevision` REQUIRED |
| `shutdown` | `{}` | never from a socket |

Notifications: `session.event`, `session.status`, `session.view`, `settings.changed`. Approval frames ARE the durable events. No DTO layer or protocol version until a client ships independently.

- **Attach contract.** A message-aligned tail page at a `cursor` (`core/session/page.ts`). A client dedups by seq, pages back, repairs a hole with a bounded `session/events`, and on reconnect re-attaches, replacing its window: no lower-bound cursor, by design. **Pages never carry the trace tier**: `Session.facts` (§4) is the page source, so a bare seq is a sufficient dedup key. No client folds the surface; a cold read never resumes.
- **Multi-client.** A connection owns only its sink and watch set, narrowed by its first attach; a disconnect disposes nothing. A parked question no connection can still see settles `unavailable`.
- **A delegated child is its parent's while running**: read-only over the wire; resumed here, the host's under its ceiling (§7).
- **Backpressure is tier-aware** (`transport-ws.ts`): `session/event` is a synchronous contained emit, so no listener may suspend the loop; past a soft limit only the trace tier drops, past a hard limit the socket closes `slow-client`.
- **The terminal** (`app/terminal`) is a protocol client that retains nothing of a session; a consent line shows the trusted subject, else the joined call, never a bare tool name. Interactive `resume`/`fork` run beside the wire, outside the host's `owned` set: no wire method forks.
- **The browser** (`app/web/`, plain ES modules) GROWS its transcript and never rebuilds it (`wire.js` reports each change's shape); what a row says is `rows.js` (§11). It is an authority surface (`app/web.ts`): loopback unless `--host`, a one-shot token traded for a signed cookie, a Host/Origin fence on each request and upgrade. One principal, no identity (§13).

## 9. Composition, configuration and packaging

MiniDSH IS data: composition rows plus disk layers (`app/compose.ts`, `app/config.ts`). Settings (`core/settings`) and credentials (`core/credentials`) are separate planes; **authority is never configuration**: a recorded event beats any composition default by fold precedence (§7).

- **Home.** `MINIDSH_HOME` (default `~/.minidsh`) holds `sessions/`, `spill/`, `attachments/v1/` (home-global: forks share objects), `composition.json`, `settings.json` (the only configuration file MiniDSH writes), `credentials.json` and `AGENTS.md`. Only `app/home.ts` resolves paths; they reach plugins as config.
- **Layers.** built-ins (`compose()`) → app → home `composition.json` → `--patch` files; a patch replaces a row's WHOLE config. A disk `plugin` is a builtin name or a module path whose own imports are its problem (§13).
- **Trust.** `composition.json` is code-equivalent trust, never a persistence target. No workspace layer: a repository may say how it likes its code, never what the harness may do. Authority-sensitive rows a layer changed are flagged by `minidsh config`; explicit authority flags are a durable per-session switch (`applyAuthority`), so they govern a resumed session too.
- **Recomposition.** `composition-record` appends `composition/applied` at agent creation iff it changed. `mount()` returns the app-only `Composition` handle; `reconfigure` validates the row's config before it remounts; the spine `{session, llm, tools, prompt, agent, loop, persistence}` refuses removal or reconfiguration while agents are live.
- **Agent presets.** `agentPresets` in `composition.json` mount per-agent worlds on the agent scope, named in the session header so a resume or a delegated child composes the same world (§7 for what they cannot reach).
- **Settings.** `agent` defaults resolve once at entry (flags → `MINIDSH_MODEL` → `settings.json` → built-ins); on resume the log's route wins.
- **Defaults.** Authority `workspace-write` + `ask`; `shell-stdio` `confinement: auto | none | bwrap | seatbelt`. A shell child's environment is built, not inherited: declared credential refs, secret-shaped names and `MINIDSH_*` removed (`shell-stdio/process.ts`; §13).
- **Packaging.** Source runs natively; npm ships the `scripts/build.ts` emit with no `main` or `exports`: a binary, not an importable surface (BLUEPRINT §3). `bin/minidsh.js` picks source or `dist/` by package shape.

**Retention: content is never swept; an affordance may expire.** Spill is the one affordance: its excerpt is already what the model saw. `spill-local` sweeps it once at load, never on disposal (a fork inherits its parent's locators).

| store | class | lifetime |
|---|---|---|
| `sessions/` (children too) | content, replay oracle | never removed by the harness |
| `attachments/v1/objects/` | content, shared by address | never removed |
| `spill/<session>/` | affordance | age-swept at load, `cleanupPeriodDays` (default 30) |

## 10. Verification

Tests mount real compositions; only the model is scripted or replayed (`test-support/llm-replay.ts`, every recorded call consumed). E2E asserts the world, never the agent's report.

- **A live log is its own test oracle** for the session that wrote it, unless it holds a repaired interruption; sessions match logs in first-request order (§13).
- **Runtime invariants run in every test and live**: `compose()` mounts them by default.
- **Cross-capability claims are tested against the full composition** (`app.test.ts` over `bootComposition`). The browser's window rules and row projection have unit tests; its DOM rendering has none.
- **Gates.** `pnpm check` plus a packed-tarball install smoke on Ubuntu, macOS and Windows (`check.yml`). A leg may not pass having proved nothing: `MINIDSH_EXPECT_CONFINEMENT=1` (Linux, macOS) fails a skipped confinement test, `MINIDSH_EXPECT_SHELL=1` a missing dialect.
- **Live arcs.** `pnpm test:e2e` (`live.yml` by hand only): seven over `minidsh serve` stdio, `web` over `minidsh web`; each replays a log keylessly.

| arc | what it proves |
|---|---|
| `live` | a mid-turn SIGKILL repaired (`TOOL_OUTCOME_UNKNOWN` iff a `tool/dispatch` names the call), finished by a second process |
| `authority` | an edit lands, its `effect/recorded` sha256 matching; one outside is refused and absent; the shell branches on reported enforcement (unconfined: escalate, approve; confined: no host file, all approvals `rejected`); `read-only` refuses a write |
| `composition` | a disk composition loads a module tool; `settings.json` picks the route |
| `context` | a real budget crossing compacts, the replace citing exactly the shadowed seqs; AGENTS.md obeyed; a spilled value read back |
| `routing` | DeepSeek → Anthropic mid-session, one route fact; a `compaction` role |
| `delegation` | a bounded child under `reason: 'delegation'`, approvals refused, not widenable |
| `verification` | a text-only parent's `view_image` refused `UNSUPPORTED_CONTENT`; a `model-roles`-routed child reads a test-drawn PNG |
| `web` | cookie sign-in; two clients on one host; a wire consent; paging to seq 0; a socket killed mid-turn |

**Validation is proportionate** (CLAUDE.md §10). Green is not a diagnosis: a stalled arc names what it was parked on, and every asserted count names its producer. **A live arc's premise is an assumption about the model, and it decays silently**: with ONE separating assertion, ask what a model knowing nothing would answer.

## 11. Where new things go

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: an `llm` adapter (§5) |
| a model-facing capability | `capabilities/tool-<x>` on `tools` |
| a plugin's configuration | a strict `Plugin.config` schema (§2) |
| an execution world | `fs` and `shell` providers; tools untouched |
| a shell confinement backend | BUILT (§7): `shell-stdio/confine/`, bounded by `writableRoots` |
| an authority knob | a log-only event + `findLast` fold, opened at creation; the setter IS the event, never a surface field (§7). Copy `sandbox/acceptance`: its delegation pin, `auditLines` branch and both projections |
| an authority preset | a presets-table entry (§7) |
| a capability, no code edit | a `composition.json` row (§9) |
| a user-adjustable default | `core/settings` if the wire sets it, else row config; never authority |
| a secret | a `CredentialRef`, resolved per use |
| a per-agent bundle | a named `agentPresets` list (§9) |
| a policy/approval answerer | `tools/pre-execute` / `approval/request` listeners; guards (§6) |
| durable state | an event kind (§4): a fact, or trace if nothing folds it |
| an event's human line | `app/present.ts` AND `app/web/rows.js`, else `rows.test.ts` fails |
| context for the model | `agent.inject()` or `agent/pre-step`, never ad-hoc prompt text |
| a surface | `app/` or a package under the §8 contract; zero semantics |
| a carrier | a protocol `Carrier`: framing and flow control only |
| a named place to work | a `workspaces` entry: addressing, not a grant |
| a remote client | the §8 attach contract |
| a per-agent variant | `agent.ctx` (`world` if inherited, else `setup`) or a `TOOLS.restrict` its owner lifts |
| a delegated child | BUILT (§7): `tool-subagent` |
| context management | BUILT (§6): a `core/compaction` provider; a pruner keeps the pairing rule |
| a context-pressure number | `core/metering`: the one pure fold |
| oversized tool output | `core/spill`, via the producing tool (§6) |
| an attachment kind | raster: an `attachments-local` header probe; else a vocabulary change (`AttachmentRef`, `ModelModality`, `ContentBlock`, both serializers, the meter) |
| a non-text producer | as `tool-view-image` (§5): refuse before I/O, commit, return |
| a verifier | BUILT: a `tool-subagent` row + `model-roles` entry, patched together |
| a model role | a `model-roles` entry; the base route is never rerouted |
| an out-of-loop model call | `resolveCallConfig` + `runAuxCall`, never bare `llm.stream` |
| a recall of shadowed history | BUILT (§6): `tool-history` |
| a cross-capability tool KIND | a `ToolDefinition.tags` constant (`core/tools/types.ts`), not a name |
| a store's lifetime | a retention row (§9) first |
| an effect worth recording | a `core/effects` vocabulary change (§4), written by the PROVIDER, not the tool |
| a consent subject for one | an `EffectIntent` from validated args, naming its AUTHORITY (§7) |
| a durable step in the tool pipeline | `ToolCall.onDispatch`: cannot replace the body (§6) |
| a session's name | BUILT: `core/session/title` (§4); the `session-title` row writes it |

No row here → an architecture question first.

## 12. Divergences from DeepSeek Harness (the ones that still shape decisions)

MiniDSH's decision and its reason; upstream's mechanism and each claim's verdict at the pin are in `references/` (the ledger: `references/assumptions.md`).

- **Scale and substrate.** Own kernel, not Cordis: the paper's two composability properties from the fewest mechanisms (§2); a `{parse}` config contract, not a schema library; one package plus a dependency gate (§1).
- **Concurrency.** Sequential tools, one foreground child, no background jobs (DSH's `minimal` preset, not its `standard`).
- **The wire.** One JSON-RPC protocol in DSH's SDK shape (DSH ships five composition profiles), bounded where DSH's is not: trace-free pages under a ceiling, tier-aware drops instead of uncapped queues, unseen approvals settling `unavailable` (§8).
- **Consent.** A trusted `subject` and the joined call on every ask, where upstream shows model prose; exact-subject session grants, upstream's open scope question; acceptance of `none`, which upstream cannot express.
- **Confinement.** bwrap and Seatbelt; no Landlock (a native launcher this no-build tree cannot carry), no Windows backend (§13); probed even alone, as `enforcement` is recorded before any command runs.
- **The ceiling.** `writableRoots` is the workspace root alone, for both families; DSH adds the temp roots, where MiniDSH's test workspaces live.
- **Durability.** A durable `tool/dispatch` after the gate, where DSH writes none for a top-level call, and a recorded effect, where DSH keeps host snapshots; plain JSONL under a write lease, where DSH writes checksummed, fsynced generations.
- **Delegation and routing.** An enforced delegation ceiling where DSH trusts a seeded pin; `subagent/start|end` in the parent's log, every unpaired bracket closed by repair (DSH closes none), `delegatedByCallId` (DSH declines the question), model roles over a durable base route.
- **Context.** No tool-result pruner (the tools bound their output); recall gated, not opt-in, over this session's shadowed spans only.
- **Surfaces.** A terminal ships (DSH deleted its TUI) as a protocol client over an in-process carrier.
- **Not built.** PTC, model-written packages (`node:vm` is no boundary), an MCP bridge, a session search index, a workspace config layer (§9), per-user identity.

## 13. Known limitations (current)

Know these before changing the code near them. One line each; the owning code says more.

**Authority**

- Windows has no confinement backend and will not: DSH's is `partial`, with a hard-link escape and standing ACL changes.
- On Windows, until a session accepts `none` (§7), every shell command costs an escalation to `danger-full-access`, and a delegated child (pinned `never`) can run none; `danger-full-access` stops the prompts only by dropping the fs fence.
- `full` is a PROFILE claim proven by the probe, not measured per call; nothing reports `partial` today.
- Windows reaps no escalation's descendants as a group. On POSIX an unwrapped persistent child (`danger-full-access`, `confinement: none`) is not detached, so a timed-out or backgrounded command's descendants outlive it.
- An acceptance is silently inert where a backend exists, by design: a session carried onto a confining host is confined again, and nothing tells the model.
- A grant's one residual: `resume --headless` on the same host with no authority change reuses an interactive consent. The browser can take an offered scope but not list or revoke one.
- **A hard link defeats both families.** The fs fence cannot detect one: a hard link in the workspace to an outside inode passes it, and a write through it lands OUTSIDE the workspace. A confined shell writes through such a link too, because the OS confines paths (measured under bwrap, 2026-09-24); bwrap refuses to create a new one across its bind (`EXDEV`).
- Under bwrap a path beneath the ephemeral `/tmp` is invisible, not read-only, so its denial gets no hint; macOS has no writable temp: a tool needing one escalates.
- macOS is proven by CI alone.
- A shell child's environment withholds variables, not credentials (§9): an undeclared secret not named like one passes, `SSH_AUTH_SOCK` and the proxy variables stay, `credentials.json` is readable, and the network is open.
- A delegation tool an agent preset registers lives in the child's scope, which `restrict` cannot hide and the depth cap does not count: a cost bound, not a fence.
- `--audit` projects decisions, not attempts: a refused command the model never escalated is only in the transcript.
- A module-loaded plugin is arbitrary code; `minidsh config`'s warnings are advisory.

**Context**

- The DeepSeek default (1M window) never reaches the pressure trigger: only overflow recovery fires, unless `budgetTokens` is set.
- A summary can be wrong; nothing makes the model call `history_read`, which the frame names from the DEPLOYMENT registry, even to a child denied it.
- The meter sees a prompt or tool-set change a step late and charges images on text-only routes; a smaller-model role may be asked for a summary larger than it takes.
- Workspace instructions are read once per entry, not watched.

**Sessions and stores**

- The in-memory log keeps the trace tier: a 400-turn session is tens of MB of heap.
- Spill is swept only at load (§9): a long-running host stays unswept until restart; a repeated `callId` overwrites.
- A lost attachment is turn-fatal (`ATTACHMENT_UNREADABLE`); image validation is header-only; one image producer, no client upload.
- No session deletion, search, rename or model-written title: each needs a projection past `persistence.list()`'s bounded prefix (a first prompt over 64 KiB lists nameless).
- **Crash repair is as sharp as the log (§4).** A call dead at its gate before the log's first `tool/dispatch`, or whose `tool/call` is the last line, reads unknown (S16 targets both), as does a crash in `tool-shell`'s in-body consent. A repaired `subagent/end` has no cost.
- Effect records cover only `ctx.fs` and `ctx.shell` (not a command's own writes, spill or attachments), may over-report a shell that died between commands, and may follow an abandoned body's result (§6).
- The format version is never restamped at attach; an unknown kind with `surfaceOp` throws in the seed; `freezeEnvelope` drops unknown envelope fields; a power cut losing whole lines leaves a valid shorter log.
- A fork boundary may separate a compaction bracket from the replace that realized it.

**Surfaces**

- `session/events` has no host ceiling: any range, every tier (§8).
- No RPC deadlines or client timeouts; backpressure limits are unmeasured.
- `session.view` is not re-sent on a status change, so its `status` goes stale (the browser's override is wrong after a reconnect).
- One watch set is subscription, control plane and answerer candidacy: narrowing hides other sessions' approvals; detaching one session narrows an un-narrowed client to nothing.
- A reconnect loses the paging position and, for a sole watcher, a pending approval; nothing announces disposal.
- `minidsh web` has no graceful stop (no signal handler; `shutdown` refused on a socket): repair and lease reclaim fall to the next process.
- `workspaceRoots` is always `[cwd]` (nothing reaches the `workspaces` seam) and bounds only NEW sessions: a wire client may resume a stored one outside it.
- One principal, no accounts: the browser authenticates nobody (§8) and cannot switch a session's route.
- Windows needs PowerShell 7 (`pwsh`), never 5.1. A command reading stdin blocks until its deadline.

**Delegation and providers**

- A delegated child is foreground and sequential, its cost summed in `subagent/end`, not the parent's meter; it dies with its tool call, its log stays.
- Replay binds sessions to logs in first-request order: exact while delegation is serial, undefined once it is not (S21).
- A replay reproduces decisions, not the workspace: a recorded absolute path cannot land in a fresh root, yet `assertConsumed()` passes; arc prompts pin relative paths (steering, not a fence).
- An installed-package plugin (§9) reaches seams only by deep path into `dist/`; only an in-repo fixture is proven.
- No OpenAI or Moonshot adapter. Catalogs are snapshots: an unknown Anthropic id gets 200K/8192, a split family needs a row per member, `llm-deepseek` answers 1M and every effort for ANY id.
- Composition changes need a restart.

## 14. File map

```
key files; .ts omitted
src/kernel/  tokens · bus · context · errors
src/core/    scope · json · ids · text; a package per §3 row, plus effects/ (no service) and metering/
  session/   store · session · surface (the folds) · page · title · repair · invariant
  agent/     index (the registry, Inbox, resolveCallConfig) · repair (the closer list) · invariant
  loop/      driver · factory (the creation transaction) · marker · invariant
  sandbox/   events · index (writableRoots) · paths (canonicalPath) · invariant
src/capabilities/
  llm-deepseek/ · llm-anthropic/ · llm-retry/ · model-roles/ · tool-subagent/ · tool-history/
  fs-local/ (the fence) · fs-observation-policy/ · tool-editor/ · attachments-local/ · tool-view-image/
  shell-stdio/ (confine/: the probe, bwrap, seatbelt) · tool-shell/ · approval-headless/ · authority-presets/
  persistence-jsonl/ (the lease) · credentials-local/ · settings-local/ · spill-local/ · composition-record/
  context-runtime/ · workspace-instructions/ · compaction-basic/ · session-title/
  protocol/ (frames: methods, attach, SessionView · host · connection · transport-*)
src/app/     cli · home · compose · config · settings · headless · serve · web · present (the audit)
             web/ (plain JS) · terminal/ · *.e2e.test.ts (the eight arcs)
src/test-support/ scripted-adapter · harness · llm-replay · serve-process · web-process · fixtures/
scripts/     build · check-deps · check-docs · doc-registers · count-lines
bin/         minidsh.js
.github/     workflows/ (check, live) · ISSUE_TEMPLATE/
(root)       README · CLAUDE · CONTRIBUTING · SECURITY · CHANGELOG · LICENSE (MIT) · NOTICE
docs/        PROJECT · ARCHITECTURE · BLUEPRINT
references/  README · assumptions · dsh/ (area maps)
.claude/     hooks/guard-repo.mjs · skills/docs-maintenance/SKILL.md
```

`scripts/count-lines.ts` measures the tree; the 1.0.0 line counts are in BLUEPRINT §4.
