# MiniDSH Architecture

One runtime composed from plugins over a tiny kernel. Everything the model sees derives from an append-only session log; everything it does goes through one guarded tool pipeline, fenced at the effect boundary by an authority the log records. The model is a capability the runtime routes to, not the agent. Every surface only renders the log, by the page, and a session survives its process.

This is the map: what each layer owns and must not own, and where a new thing goes. History is in `BLUEPRINT.md` §4 and the commits, usage in `README.md`; §12 lists deliberate differences from DeepSeek Harness (DSH), §13 what is knowingly missing. Code comments cite section numbers.

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
| `test-support`, `*.test.ts` | anything |

**Payloads** are read via `matches(event, KIND)`, never `event.data as {…}`, outside tests. **Core is acyclic at file level** (packages may cycle): each package's `events.ts`/`types.ts` sits below its service. The browser client shares only the wire with the host.

## 2. Kernel (`src/kernel`)

Five mechanisms (`kernel/index.ts`).

- **Context and services.** `child({scope?})` derives a scoped context. `provide` is an effect, one claim per key per context; `get` needs the key `inject`ed or self-provided.
- **Plugins.** `config` is a structural `{parse}` contract, parsed before `apply`; `pending` until every injected key is provided, and a replaced provider reloads its dependents. Effects unwind before dependents unload: **a disposer must not read the services its plugin injected** (`kernel/context.ts`).
- **Events.** A token carries its dispatch mode (`kernel/tokens.ts`); a waterfall's `next()` is single-shot; `observe` runs before any listener. A dispatch reaches unscoped and `global` listeners plus its own scope's, so an agent-scoped listener hears `session/*` or `llm/stream` only with `global: true` (`kernel/bus.ts`).

**Scope contract** (`core/scope.ts`). Registration context = visibility = lifetime: a view is the globals plus one agent layer, a local entry shadows a global, nothing is inherited between scopes. An agent's operation events dispatch in its scope (`agent/*`, `tools/*`, `approval/request`, `system-prompt/assemble`, `fs/*`); `llm/stream` and `session/*` are unscoped. Deployment-global registries (`llm`, `invariants`) refuse a scoped owner. Consumers get the agent as subject, never services via `agent.ctx`.

## 3. Core contracts (`src/core`)

Eighteen service keys: seventeen `core` (below) + app-only `app-composition`; `loop` is a plugin, not a key. A seam needs all three roles: Definition (core), Provider (capability), Consumer (capability, usually a tool). Agent id = session id.

| ctx key | owns | must not own |
|---|---|---|
| `sessions` | `Session`: header + append-only log (§4) + surface; `repairInterruptedTail` (§4) | persistence backends, UI state, model |
| `persistence` | READ Definition: `load(id)` → the readable prefix (`damaged?`, `integrity`, `lease`); `list()` newest-first, titled from a bounded prefix; `durability`, the flush guarantee it declares (§4) | the write path (the provider's: format, materialization, attach); repair; deletion |
| `credentials` | `CredentialRef`: a validated env-var NAME, all that config, logs and errors carry; `resolve` fresh per call; `declare`/`declaredRefs`: the refs treated as secret (§9) | storing or logging values; which layers exist |
| `presets` | key `authority-presets`: `presetTable` (`custom` reserved), pure `presetFor`, the log-only `authority/preset` intent (§7) | enforcement; knobs; a `defaultPreset` |
| `llm` | the provider-neutral vocabulary and a deployment-global adapter registry (§5); `stream` = the `llm/stream` waterfall, whose terminal continuation picks the adapter | API keys, session state, default model |
| `tools` | `defineTool` (`tags?` never model-facing, §11); `restrict` (subtractive, own registrations exempt) through the one resolver: a hidden tool is unknown to the model and refused if called; `ToolCall.onDispatch` and the pipeline (§6) | policy |
| `prompt` | ordered named sections + strict `{{var}}` variables, one `complete` section; `assemble(agent)` → `system-prompt/assemble`; sections stable within a session (cache-safe) | history, time-varying text |
| `approval` | `request` → `allowed-once \| rejected \| cancelled \| unavailable` on the `approval/request` waterfall (default `unavailable`); `id` = the `approval/asked` seq; a trusted `subject` beside the model-written `reason`; `ApprovalPolicy` `ask \| never`; `grants`/`revoke` (§7) | answer logic; model-facing prose; a public `grant` |
| `fs` | `fs/edit-intent` (read-before-edit) and `fs/observed`; **fences every mutation** before any effect (`FS_SANDBOX_DENIED`), reads always pass (§7); `readBytes` emits no observation | tool schemas; policy itself |
| `shell` | `sessionFor(agent)` → `ShellSession`; `enforcementFor(mode)`; `exec` reports the `enforcement` it got and REFUSES what it cannot enforce unless the call `accepts` it (§7) | model-facing descriptions; negotiation |
| `sandbox` | the authority stamp (`SandboxMode`, `sandbox/mode`); the pure `writableRoots`/`allowsWrite` every fence derives from; the ACCEPTANCE knob (`sandbox/acceptance`). All §7 | enforcement backends; what any tool may do; **what the model is told of it** |
| `compaction` | `compactNow(agent)`; the log-only bracket `compaction/start\|applied\|end`; PURE `planCompaction` (the pairing rule, §6) | threshold, summary, trigger |
| `attachments` | content-addressed `AttachmentRef`; `saveImage/readImage/hostPath`; **an image is validated and durably committed before its owning session event is appended** (§5) | normalization; retention; who may look |
| `spill` | output with NO OTHER HOME: `save` → `{path, bytes}`; head/tail excerpt renderers | threshold (each tool's own) |
| `settings` | REMOTE-writable defaults: `register/describe/read/write` (`expectedRevision`, §8); `settings/changed` | store; authority; composition; anything a resumed session recorded |
| `agents` | `create/resume/fork/get/list`. **Creation is a TRANSACTION** (`core/loop/factory.ts`): built unpublished, `world` before `setup`, published last; a failure rolls back unannounced. `configure` is the durable route switch (§4); `resume` = `load` (refusing `damaged`) → `repairTail` (§4) → seed → the same transaction; `fork` needs a child's opening stamps in its seed (§7), or `salvage`s a damaged prefix | driver |
| `invariants` | `register(owner, name, installer)`: deployment-global, config-selected, validating pre-commit via `observe` | product logic |
| `loop` | the driver and its durability checkpoints (§6); registers itself as the agent factory, which writes each lifecycle's `session/lifecycle` first (§4) | anything extensions do |

## 4. Canonical facts: the session log

The log is the single source of truth: `{type, seq, time, data}`, `seq === log.length`, frozen at append.

- **Three tiers** (`core/session/types.ts`). **Surface** kinds (`user/message`, `assistant/message`, `tool/result`) carry `surfaceOp` and `sourceEventSeqs`; model history is their fold (`deriveEventMessage`). Every other kind is a log-only **fact**, except **trace** (`TRACE_TYPES`), never folded at runtime: folds walk `Session.facts`, the log without its trace. A new kind is a fact, or trace if nothing folds it.
- **Vocabulary: 32 kinds**, by owner under `core/`, fields at each declaration. session: `turn/start|end`, `step/start|end`, `user/message`, `assistant/chunk|message`, `tool/call|dispatch|result`, `request/header|context`, `session/title|end-seed|lifecycle`; agent: `agent/options`, `inbox/spliced`, `subagent/start|end` (the PARENT's log); approval: `approval/asked|decided|grant|policy`; sandbox: `sandbox/mode|acceptance`; presets: `authority/preset`; compaction: `compaction/start|applied|end`; effects: `effect/recorded`; llm: `llm/aux-call`; plus `composition/applied` (`capabilities/composition-record`).
- **Format** (`core/session/format.ts`): the header's `version` alone. A writer continues only its own format, forks an older one, refuses a newer one (`SessionFormatError`, not damage).
- **Every lifecycle opens with `session/lifecycle`** (seq 0, or right after its `session/end-seed`): `dispatch` (a durable `tool/dispatch` precedes every body), `durability: 'synced'` (the store's declared flush guarantee), `salvage`. Readers use its claims, never its presence (`core/session/types.ts`). The record's claims are type-checked at every append and `salvage` is held to its shape (`core/session/invariant.ts`), so a log `verify` calls sound is one `inspect` can render.
- **The route is one fact in two records.** `agent/options` is the BASE (`configure` writes `change`); `request/context` the EFFECTIVE route, window and modalities per step (§6), written on any difference; a role rewrites header and context, never the base. `request/header` is written only on change. A field added to a written-on-change record reads as absent in any session that never rewrites it (`core/loop/driver.ts`).
- **The header** (`SessionHeader`, JSONL line 1) is immutable identity and lineage: fork, delegation with `delegatedByCallId`, `agentPreset` (`core/session/types.ts`).
- **Opening facts** land before publication: `agent/options{initial}`, `approval/policy{initial}`, `sandbox/mode{initial}`, `composition/applied` (a delegated child's are §7's).
- **Arrival versus rewrite.** A `user/message` that ARRIVES sits inside an open turn; one that REPLACES a range may land between turns (`core/session/invariant.ts`).
- **The durable inbox** is `inbox/spliced`, op-shaped (`core/agent`): a claim commits after the messages it entered, so a crash re-delivers, never loses; only a resume wakes on restored input (`core/loop/factory.ts`).
- **Crash repair closes everything the log left open** (`repairTail`, `core/agent/repair.ts`). Resume and cold fork run a STATIC list, innermost first: unpaired `subagent/start` → `subagent/end{interrupted}`; unpaired `compaction/start` → `compaction/end{declined: unclosed}`; then `repairInterruptedTail` (`core/session/repair.ts`). Closers are pure (a cold read and a durable repair produce identical bytes) and state only what the log proves.
- **A synthetic result states the evidence** (`classify`, `core/session/repair.ts`): no `tool/call` ⇒ `TOOL_NOT_STARTED`; a `tool/dispatch` or a recorded effect ⇒ `TOOL_OUTCOME_UNKNOWN`; neither ⇒ `TOOL_NOT_STARTED` only where the open turn's own lifecycle claims `dispatch` and `synced`, else unknown. Under salvage, or a log a live writer holds (`heldByWriter`), every owed call is unknown; an unknown result names the call's effects recorded in the step.
- **An effect is recorded by the code that caused it, after it happens** (`core/effects/events.ts`): `fs-local` and `shell-stdio` append `effect/recorded` (`fs-write | shell-command`, keyed by `callId`). **Presence is proof; absence proves nothing.** Closed families, no exactly-once (§13). `EffectIntent` is the "about to do" half: never logged alone, only a consent's `subject` and a grant's identity (§7).
- **A `session/event` listener may not append synchronously**: a nested append reaches persistence before its cause (`damaged` at resume); queue it on a microtask (`core/session/store.ts`).
- **Model-visible ⟺ logged.** Every request equals `deriveMessages()` plus the folded `request/header`; checked in the `llm/stream` preflight (`core/loop/invariant.ts`).
- **Persistence is a subscriber** (`persistence-jsonl`): `sessions/<id>.jsonl` (§9), materialized on a session's first conversation fact. A torn final line moves to `.torn`; deeper corruption is `damaged` and refuses attach. **A resolved `session/flush` is on stable storage** (`durability: 'synced'`); a failed write or sync fails every later flush (§13).
- **Single writer per stored session.** A `<id>.jsonl.lock` lease is held from publication to disposal, reclaimed only from a provably dead same-host holder. **Reads never lock**; a resume flushes inside the creation transaction, so a held lease rejects it before paid work.

## 5. LLM vocabulary and the two adapters

`core/llm/types.ts` is the provider-neutral vocabulary: closed `ContentBlock` and `StreamChunk` unions, `LlmFailure` (policies route on `code`, never message text) and DISJOINT `TokenUsage`.

- **Adapters are deployment-global** (§2), registered on `llm` from an unscoped owner (`core/llm/runtime.ts`).
- **Refuse before I/O, never degrade.** An option or modality the provider cannot honour is `UNSUPPORTED_OPTION`, `UNSUPPORTED_REASONING_EFFORT` or `UNSUPPORTED_CONTENT` before any I/O, never dropped, aliased or clamped: the logged request is the served one.
- **Replay state.** A signing provider's opaque `ReplayEnvelope` rides the terminal `finish` onto the assistant source; the `llm/stream` terminal continuation strips it for any other provider AFTER the reconstruction observer.
- **Retry is a capability** (`llm-retry`, on `agent/request-error`), so failed attempts stay durable. A model call that is not a turn is `runAuxCall`: one log-only `llm/aux-call` (§4).
- **Images: a reference plus a STORED descriptor** (`core/llm/content.ts`), committed before the event that carries it is appended. **Refuse at admission** (before any I/O, when the STEP's route lacks `image`) and **substitute at projection** (a text-only route is sent `block.text`); lost bytes fail `ATTACHMENT_UNREADABLE` (§13).
- **The two adapters**, `llm-deepseek` (OpenAI-compatible) and `llm-anthropic` (Messages API), state their wire rules in their own code.

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

- **Durable before every action.** A CHECKPOINT is `session.flush()` (§4); a lost write ends the turn `DURABILITY_LOST` (the calls still owed get that result, none runs). The DRIVER writes `tool/dispatch` after the gate, via `ToolCall.onDispatch` awaited INSIDE the `tools/execute` terminal continuation, so a middleware answering without `next()` replaces the body and writes no dispatch (`core/tools/registry.ts`).
- **The route is resolved once per step**, before `agent/pre-step`, fixed for the step, retries included; a switch lands at the next step.
- **Pipeline**, in the acting agent's scope: validate → `tools/pre-execute` → deny-only guards → `ask` ⇒ `approval.request` → deadline → `tools/execute` (around-middleware) → body → `render` → `tools/post-execute` → `tools/result`. A throw is an `isError` result `{name, code}`; the model sees only `{name, description, parameters}`.
- **Deadlines are the pipeline's**, clocked after the gate; `timeoutMs: null` opts out (a tool asking consent in its body must, on `callSignal`); expiry is `TOOL_TIMEOUT`, the signal aborted, the body abandoned, not awaited.
- **Pressure** is `core/metering`, a pure fold over log facts (§11).
- **Compaction** (`compaction-basic`): pressure on `agent/pre-step`, `CONTEXT_WINDOW_EXCEEDED` on `agent/request-error`, explicit `compactNow`. The kept tail never begins with a `tool/result`. Its summary is an `llm/aux-call`; an applied attempt writes `compaction/applied`, then one replacing `user/message` citing every shadowed seq. **The hazard is the await**: `planIsLive` is re-checked with no `await` before the append.
- **Bounded recall** (`tool-history`): `history_read` reads only this session's shadowed seqs, hidden until the first applied compaction; a call over budget is refused, not truncated, and spend is a fold over the log.
- **Spill** (`core/spill`) is the producing tool's call (§3); the model gets an excerpt and the path.
- **An `agent/pre-step` listener may add to a batch, never create one**: an empty first step ends the turn (`core/loop/driver.ts`), so filling it revives a closed turn. `AGENTS.md` enters this way, as a durable `user/message`, never a prompt section (§3).
- **Lifecycle.** `dispose` = cancel → `whenIdle` → scope unwind → agent, then session, detach (`core/loop/factory.ts`); a detached session refuses appends (`SESSION_CLOSED`).

## 7. Authority

The model proposes, policy decides, the effect boundary enforces; every decision is a fact in the log.

- **One stamp.** `SandboxExecutionPolicy{mode, workspaceRoot}` resolves per call from `ctx.sandbox`, never caller-assembled; mode governs FILE EFFECTS only. The root is the immutable `SessionHeader.cwd` (§8). `writableRoots(policy)` is a CEILING for both families: grant less, never more (`core/sandbox/index.ts`).
- **Enforcement lives at the effect, not the gate.** `fs-local` canonicalizes and contains every write in process, refusing `FS_SANDBOX_DENIED` before any effect; reads always pass. It follows symbolic links itself (`core/sandbox/paths.ts`) but cannot detect a hard link (§13).
- **Untrusted code is the shell's problem.** `shell-stdio/confine/` wraps the spawn: bwrap on Linux, Seatbelt on macOS, none on Windows (§13). Each is PROBED with its real `read-only` profile, never by `which`, and `enforcement` is recorded at agent creation (`enforcementFor`).
- **Spawn-time binding.** A backend wraps the persistent child once, under the session's policy; a durable `setMode` replaces it. A confined child is spawned `detached` on POSIX (its own session: `--new-session`). An approved one-shot escalation is a throwaway child, wrapped like any spawn (`danger-full-access` alone runs unwrapped), leading its own POSIX process group, reaped at disposal (`shell-stdio/process.ts`).
- **A record is not a fence.** `effect/recorded` (§4) sits beside the boundary; losing one loses evidence, never containment.
- **The escalation path.** A refusal is a fact with one legitimate move: the SAME command once more with `sandbox_permissions` (strictly wider) and a `justification`, `ctx.approval` consenting to that call. Under a backend the kernel's refusal reads as a failing command; the backend's denial words earn a hint, never a classification (`tool-shell`; §13).
- **Consent is to the runtime's record.** An ask's `subject` is an `EffectIntent` (§4) the REQUESTER builds from validated arguments, naming the authority the effect would run under (`tool-shell`: `{command, mode, enforcement}`); the model's `justification` stays in `reason`, clamped (§3), never in the subject. A `truncated` subject has no `intentKey`, so it is never grantable (`core/effects/events.ts`).
- **Acceptance.** The `enforcement` beside a stamp is a HOST fact of the shell world; `sandbox/acceptance{accepts, forMode, reason}` is a DECISION, `full` (default), `partial` or `none` (the CLI and the wire offer `full|none`; `partial` reaches it from a row), for exactly `forMode`: `confine()` is mode-blind, so a bare `accepts` would void `read-only` too (`core/sandbox/events.ts`). Read per call (`acceptsFor`), it relaxes the REFUSAL, never a backend; the fs fence and ceiling stand. `--accept` sets the row's default, the only path into a wire-opened session; a weakened default is stamped per confinable mode at the opening, a child's pin for its `forMode` alone (`stampAcceptance`).
- **A consent may outlive one call, never its lifecycle.** `approval/grant` is log-only, identified by `toolName` plus the exact subject's `intentKey`: a REPEATED IDENTICAL action, not a policy language. A grant is live only once its own ask is `allowed-once`, and until any `approval/policy`, `sandbox/mode`, `sandbox/acceptance` or `authority/preset` follows, or the lifecycle ends (`session/end-seed`: a resume or a fork asks again) (`core/approval/events.ts`).
- **Offers are the fold's.** `openApprovals` computes `offers`; the seam re-runs it before minting, and only the host reports taking one (`approval/answer{offer}`), so headless mints none. No public `grant`; `grants`/`revoke` (`approval/revoke` on the wire) list and end one.
- **Every decision is durable.** The setter IS the event (`sandbox/mode`, `approval/policy`, acceptance, grants): `initial` before publication (§4), `change` only on change, sandbox `resume` when a resumed host enforces differently; `context-runtime`, never the service, writes what the model reads. Precedence: approved one-shot escalation > recorded fold > composition default. `approval-headless` fails closed (`unavailable`) except under `--approve` or an exact `allow` entry; `sessions show --audit` projects the plane.
- **A delegated child opens under a ceiling.** `tool-subagent` captures the parent's authority before the first await and stamps it in `setup`, `reason:'delegation'`: the mode as a CEILING, approvals pinned `never` (before dispatch and any grant), acceptance `strictest(parent, row)` as a PIN. Widening is refused (`SANDBOX_CEILING`, `APPROVAL_PINNED`) and so is `setAcceptance` on any delegated session; narrowing is legal. A continuation keeps them: `fork` refuses a boundary below the opening stamps (§13).
- **Presets select, the knobs decide.** `authority/preset` is a log-only intent written before `setMode`/`setPolicy`; the current preset is DERIVED (`core/presets`).
- **Consent-by-composition.** `approval/request` dispatches in the asking agent's scope, so a preset-mounted (§9) answerer can auto-approve for its own agent: code-equivalent trust, every pair audited. It cannot widen enforcement (the fence and shell resolve the global `SANDBOX`) nor reach a deployment-global registry.
- **`core-authority`** (`core/sandbox/invariant.ts`) rejects a forged authority fact or subject pre-commit, holds every approval to one decision and a delegated session to its ceiling and pins, and refuses an `approval/grant` naming no open `intentKey`-identical ask in this log, truncated, or written by a delegated session.

## 8. Surfaces

A surface injects only `agents` and `sessions` (plus `llm`, `sandbox`, `approval` for catalog and authority), owns transport and process exit, renders from `session/event` and holds no authority state: a switch it asks for is a durable event it reads back. Plain-text surfaces share `app/present.ts`, which neutralizes control characters; the cold readers `sessions verify`/`inspect` (`app/inspect.ts`) neither lease nor repair.

- **Headless CLI** (`app/cli.ts`): exit 0 iff the turn completed, 2 on a usage failure; an unlisted flag is refused; `--json` streams the wire's `{sessionId, event}` frame.

**Protocol** (`capabilities/protocol`): JSON-RPC 2.0; one plugin, one host, N carriers (stdio, in-process, WebSocket). Control-plane methods act only on a LIVE session.

| method | rule |
|---|---|
| `initialize` | the catalog, defaults (live from settings) and workspaces |
| `session/prompt` | no id creates, live delivers, stored resumes; `cwd`/`workspaceId` place a NEW session under `workspaceRoots`, refused beside `sessionId`; a route with no adapter here is refused; a child mid-delegation is read-only on every driving method |
| `session/attach` | subscribes BEFORE the cut; `view` is the folds a page cannot compute, none pending on a cold read |
| `session/page` | beneath the attach cut |
| `session/detach` | no id narrows to NOTHING |
| `session/events` | every tier; the bounded gap repair |
| `sessions/list` | live and stored, live wins; derived `title` |
| `session/cancel` | `keepQueued` spares the durable inbox |
| `session/compact` | HUMAN command, never a model tool |
| `approval/answer` | first answer wins; only from a connection that may see the session; an `offer` the fold did not make is refused |
| `approval/revoke` | ends one grant (§7) |
| `session/authority` | each switch IS its durable event |
| `session/model` | no fields reads; the given fields are ONE `agent/options{change}`, iff the base changes |
| `settings/describe`, `settings/get`, `settings/set` | `expectedRevision` REQUIRED |
| `shutdown` | refused on a socket unless its carrier says `allowShutdown` (the shipped web host never does) |

Notifications: `session.event`, `session.status`, `session.view`, `settings.changed`; approval frames ARE the durable events. No DTO layer or protocol version until a client ships independently.

- **Attach contract.** A message-aligned tail page at a `cursor` (`core/session/page.ts`), never the trace tier (`Session.facts`, §4), so a bare seq dedups. A client pages back, repairs a hole with a bounded `session/events` and re-attaches on reconnect, replacing its window: no lower-bound cursor, by design. No client folds the surface; a cold read never resumes.
- **Multi-client.** A connection owns only its sink and watch set, narrowed by its first attach; a disconnect disposes nothing. A parked question no connection can still see settles `unavailable` (`protocol/host.ts`).
- **Backpressure is tier-aware** (`transport-ws.ts`): `session/event` is a synchronous contained emit, so no listener may suspend the loop; the trace tier drops past a soft limit; the socket closes `slow-client` past a hard one.
- **The terminal** (`app/terminal`) is a protocol client that retains nothing of a session; a consent line shows the trusted subject, else the joined call, never a bare tool name. Interactive `resume`/`fork` run beside the wire, outside the host's `owned` set: no wire method forks.
- **The browser** (`app/web/`, plain ES modules) GROWS its transcript and never rebuilds it (`wire.js`, `rows.js`). It is an authority surface (`app/web.ts`): loopback unless `--host`, a one-shot token traded for a signed cookie, checked with a Host/Origin fence. One principal, no identity (§13).

## 9. Composition, configuration and packaging

MiniDSH IS data: composition rows plus disk layers (`app/compose.ts`, `app/config.ts`). Settings (`core/settings`) and credentials (`core/credentials`) are separate planes; **authority is never configuration**: a recorded event beats any composition default by fold precedence (§7).

- **Home.** `MINIDSH_HOME` (default `~/.minidsh`): `sessions/`, `spill/`, `attachments/v1/` (home-global: forks share objects), `composition.json`, `settings.json` (the only configuration file MiniDSH writes), `credentials.json`, `AGENTS.md`. Only `app/home.ts` resolves paths; plugins get them as config.
- **Layers.** built-ins (`compose()`) → app → home `composition.json` → `--patch` files; a patch replaces a row's WHOLE config. A disk `plugin` is a builtin name or a module path whose own imports are its problem (§13).
- **Trust.** `composition.json` is code-equivalent trust, never a persistence target. No workspace layer: a repository may say how it likes its code, never what the harness may do. `minidsh config` flags authority-sensitive rows a layer changed; explicit authority flags are a durable per-session switch (`applyAuthority`), a resumed session included.
- **Recomposition.** `composition-record` appends `composition/applied` at agent creation iff it changed. The spine `{session, llm, tools, prompt, agent, loop, persistence}` refuses removal or reconfiguration while agents are live (`app/compose.ts`).
- **Agent presets.** `agentPresets` in `composition.json` mount per-agent worlds on the agent scope, named in the session header so a resume or a delegated child composes the same world (§7 for what they cannot reach).
- **Settings.** `agent` defaults: flags → `MINIDSH_MODEL` → `settings.json` → built-ins, read live per new session by a wire host (§8); on resume the log's route wins, and an explicit flag overrides it as `agent/options{resume}` (`core/agent/index.ts`).
- **Defaults.** Authority `workspace-write` + `ask`; `shell-stdio` `confinement` `auto`. A shell child's environment is built, not inherited: the credential refs the mounted rows declared and `MINIDSH_*` removed, nothing for a name's shape (`shell-stdio/process.ts`; §13).
- **Packaging.** npm ships the `scripts/build.ts` emit with no `main` or `exports`: a binary, not an importable surface (BLUEPRINT §3); `bin/minidsh.js` picks source or `dist/` by package shape.

**Retention: content is never swept; an affordance may expire.** Spill is the one affordance: its excerpt is already what the model saw. `spill-local` sweeps it once at load, never on disposal (a fork inherits its parent's locators).

| store | class | lifetime |
|---|---|---|
| `sessions/` (children too) | content, replay oracle | never removed by the harness |
| `attachments/v1/objects/` | content, shared by address | never removed |
| `spill/<session>/` | affordance | age-swept at load, `cleanupPeriodDays` (default 30) |

## 10. Verification

Tests mount real compositions; only the model is scripted or replayed (`test-support/llm-replay.ts`; a log holding a repaired interruption is no oracle). E2E asserts the world, never the agent's report.

- **Runtime invariants run in every test and live**: `compose()` mounts them by default. Cross-capability claims are tested against the full composition (`app.test.ts` over `bootComposition`).
- **Gates.** `pnpm check` plus a packed-tarball install smoke on Ubuntu, macOS and Windows (`check.yml`); a `v*` tag publishes from CI through npm trusted publishing, smokes the public package and verifies its attestation (`release.yml`). A leg may not pass having proved nothing: `MINIDSH_EXPECT_CONFINEMENT=1` (Linux, macOS; `live.yml` too, where the authority arc must take its confined branch) fails a skipped confinement test, `MINIDSH_EXPECT_SHELL=1` a missing dialect.
- **Fixtures.** Real 1.0.0 and S16 logs (`test-support/fixtures/`) are verified, repaired, salvaged and replayed in `pnpm check`.
- **Live arcs.** `pnpm test:e2e`: seven over `minidsh serve` stdio, `web` over `minidsh web`.

| arc | what it proves |
|---|---|
| `live` | a mid-turn SIGKILL repaired and finished by a second process; a cold `verify` between them predicts its closers exactly; when the kill lands inside the call window, `TOOL_OUTCOME_UNKNOWN` iff a `tool/dispatch` names the call |
| `authority` | an edit lands, its `effect/recorded` sha256 matching; one outside is refused and absent; the shell branches on reported enforcement (unconfined: escalate, approve; confined: no host file, every approval `rejected`); `read-only` refuses a write; cold `inspect` equals the live authority |
| `composition` | a disk composition loads a module tool; `settings.json` picks the route |
| `context` | a real budget crossing compacts, the replace citing exactly the shadowed seqs; AGENTS.md obeyed; a spilled value read back |
| `routing` | DeepSeek → Anthropic mid-session, one route fact; a `compaction` role |
| `delegation` | a bounded child under `reason: 'delegation'`, approvals refused, not widenable |
| `verification` | a text-only parent's `view_image` refused `UNSUPPORTED_CONTENT`; a `model-roles`-routed child reads a test-drawn PNG |
| `web` | cookie sign-in; two clients on one host; a wire consent; paging to seq 0; a socket killed mid-turn |

**A live arc's premise is an assumption about the model, and it decays silently**: with ONE separating assertion, ask what a model knowing nothing would answer.

## 11. Where new things go

| New thing | Home |
|---|---|
| a model provider | `capabilities/llm-<p>`: an `llm` adapter (§5) |
| a model-facing capability | `capabilities/tool-<x>` on `tools` |
| a plugin's configuration | a strict `Plugin.config` schema (§2) |
| an execution world | `fs` and `shell` providers; tools untouched |
| a shell confinement backend | BUILT (§7): `shell-stdio/confine/`, bounded by `writableRoots` |
| an authority knob | a log-only event + `findLast` fold with a default; the setter IS the event, never a surface field (§7). Copy `sandbox/acceptance` (delegation pin, `auditLines`, both projections) |
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
| a verifier | BUILT: a `tool-subagent` row + a `model-roles` entry |
| a model role | a `model-roles` entry; the base route is never rerouted |
| an out-of-loop model call | `resolveCallConfig` + `runAuxCall`, never bare `llm.stream` |
| a recall of shadowed history | BUILT (§6): `tool-history` |
| a cross-capability tool KIND | a `ToolDefinition.tags` constant, not a name |
| a store's lifetime | a retention row (§9) first |
| an effect worth recording | a `core/effects` vocabulary change (§4), written by the PROVIDER, not the tool |
| a consent subject for one | an `EffectIntent` from validated args, naming its AUTHORITY (§7) |
| a durable step in the tool pipeline | `ToolCall.onDispatch`: cannot replace the body (§6) |
| a session's name | BUILT: `core/session/title` (§4), written by the `session-title` row |
| a whole-log check | a pure `check*Log` beside the owner's invariant; `app/inspect.ts` composes |
| a format change | the rule in `core/session/format.ts` |

No row here → an architecture question first.

## 12. Divergences from DeepSeek Harness (the ones that still shape decisions)

MiniDSH's decision and its reason; upstream's mechanism and each claim's verdict at the pin are in `references/assumptions.md`.

- **Scale and substrate.** Own kernel, not Cordis: the paper's two composability properties from the fewest mechanisms (§2); a `{parse}` config contract, not a schema library; one package plus a dependency gate (§1).
- **Concurrency.** Sequential tools, one foreground child, no background jobs (DSH's `minimal`).
- **The wire.** One JSON-RPC protocol in DSH's SDK shape, bounded where DSH's is not: trace-free pages under a ceiling, tier-aware drops instead of uncapped queues, unseen approvals settling `unavailable` (§8).
- **Consent.** A trusted `subject` and the joined call on every ask (DSH: model prose); exact-subject session grants (DSH: an open scope question); acceptance of `none` (DSH cannot express it).
- **Confinement.** bwrap and Seatbelt; no Landlock (a native launcher this no-build tree cannot carry), no Windows backend (§13); probed even alone, as `enforcement` is recorded before any command runs; a shell child's environment loses only declared credential names and `MINIDSH_*`, where DSH's `scrubbedParentEnv` pattern-matches names.
- **The ceiling.** `writableRoots` is the workspace root alone, for both families; DSH adds the temp roots, where MiniDSH's test workspaces live.
- **Durability.** A durable `tool/dispatch` after the gate and a recorded effect (DSH: no dispatch for a top-level call; snapshots); plain JSONL under a write lease, synced checkpoints and per-lifecycle writer claims (DSH: fsynced checksummed generations, no writer).
- **Delegation and routing.** An enforced delegation ceiling (DSH: a seeded pin); `subagent/start|end` in the parent's log, every unpaired bracket closed by repair (DSH brackets workflow members, not subagents, and repairs its own tail turn only); `delegatedByCallId`; model roles over a durable base route.
- **Context.** No tool-result pruner (the tools bound their output); recall gated, not opt-in, over this session's shadowed spans only.
- **Surfaces.** A terminal ships as a protocol client over an in-process carrier.
- **Not built.** PTC, model-written packages (`node:vm` is no boundary), an MCP bridge, a session search index, a workspace config layer (§9), per-user identity.

## 13. Known limitations (current)

Know these before changing the code near them. One line each; the owning code says more.

**Authority**

- Windows has no confinement backend and will not: DSH's is `partial`, with a hard-link escape and standing ACL changes.
- On Windows, until a session accepts `none` (§7), every shell command costs an escalation to `danger-full-access` in a throwaway shell, a delegated child (pinned `never`) can run none, and `danger-full-access` stops the prompts only by dropping the fs fence.
- Windows reaps no escalation's descendants as a group; on POSIX an unwrapped persistent child (`danger-full-access`, `confinement: none`) is not detached, so a backgrounded command's descendants outlive it.
- An acceptance is silently inert where a backend exists, by design: a session carried onto a confining host is confined again, and the model is told it is confined, not that its acceptance is inert.
- A grant ends with its lifecycle (§7): a resume or a fork asks again. The browser can take an offered scope but not list or revoke one.
- **A hard link defeats both families.** The fs fence cannot detect one: a hard link in the workspace to an outside inode passes it, and a write through it lands OUTSIDE the workspace. A confined shell writes through such a link too, because the OS confines paths (measured under bwrap and Seatbelt, 2026-09-26/27, `confine.test.ts`); neither backend lets a confined command create one across the boundary, nor write an outside path that also has a workspace name.
- `full` is a PROFILE claim proven by the probe, not measured per call; no backend reports `partial` (a row may accept it).
- Under bwrap a path beneath the ephemeral `/tmp` is invisible, not read-only, so its denial gets no hint; macOS has no writable temp: a tool needing one escalates.
- macOS is proven by CI alone.
- The `shell` row is outside the spine (`app/compose.ts`): after a live `reconfigure`, `enforcementFor` and a stamp answer for a world no command runs in.
- A shell child's environment withholds variables, not credentials (§9): every undeclared secret passes whatever its name, `SSH_AUTH_SOCK` and the proxy variables stay, `credentials.json` is readable, and the network is open.
- A delegation tool an agent preset registers lives in the child's scope, which `restrict` cannot hide and the depth cap does not count: a cost bound, not a fence.
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
- **Crash repair is as sharp as the lifecycle (§4).** Only one claiming `dispatch` and `synced` reads a gate death as not started; a 1.0.0 or unsynced one, a never-logged call, and a crash in `tool-shell`'s in-body consent read unknown. A repaired `subagent/end` has no cost, salvage closers are placeholders, and a cut between turns leaves the model no sign (the CLI warns).
- Effect records cover only `ctx.fs` and `ctx.shell` (not a command's own writes, spill or attachments), may over-report a shell that died between commands, and may follow an abandoned body's result (§6).
- `synced` is as honest as the disk, and Windows cannot sync a new log's directory; facts after the last checkpoint can be lost: a zero-filled tail reads torn, zeros before a surviving line damaged (`--salvage`).
- A pre-S16 log names no deployment-default acceptance, nor whether an error result came from the gate or a body.
- `verify` reads structure, surface messages and its report's folds, no other payload.
- A fork boundary may separate a compaction bracket from the replace that realized it; `fork --at` refuses a boundary inside an open turn or below a delegated child's opening.

**Surfaces**

- `session/events` has no host ceiling: any range, every tier (§8). No RPC deadlines or client timeouts; the backpressure limits are unmeasured.
- `session.view` is not re-sent on a status change, so its `status` goes stale; a reconnect loses the paging position and, for a sole watcher, a pending approval; nothing announces disposal.
- One watch set is subscription, control plane and answerer candidacy: narrowing hides other sessions' approvals; detaching one session narrows an un-narrowed client to nothing.
- `minidsh web` has no graceful stop (`shutdown` is refused on a socket): repair and lease reclaim fall to the next process.
- `workspaceRoots` is always `[cwd]` (nothing reaches the `workspaces` seam) and bounds only NEW sessions: a wire client may resume a stored one outside it.
- One principal, no accounts: the browser authenticates nobody (§8) and cannot switch a session's route.
- Windows needs `pwsh` (PowerShell 7), never 5.1; a command reading stdin blocks until its deadline.

**Delegation and providers**

- A delegated child's cost is summed in `subagent/end`, not the parent's meter; it dies with its tool call, its log stays.
- A resumed or forked child keeps its ceiling and pins but not its tool filter, depth-cap denial or persona: those live in `setup`, which no continuation re-runs (its `request/header` records what it saw; S21).
- Replay binds sessions to logs in first-request order: exact while delegation is serial, undefined once it is not (S21).
- A replay reproduces decisions, not the workspace: a recorded absolute path cannot land in a fresh root, yet `assertConsumed()` passes; arc prompts pin relative paths (steering, not a fence).
- An installed-package plugin (§9) reaches seams only by deep path into `dist/`; only an in-repo fixture is proven.
- No OpenAI or Moonshot adapter. Catalogs are snapshots: an unknown Anthropic id gets 200K/8192, a split family needs a row per member, `llm-deepseek` answers 1M and every effort for ANY id; DeepSeek serves `deepseek-v4-flash` and `-vision-exp` as `deepseek-flash` (the default since 1.1.0), which reads images the catalog does not yet admit, while `deepseek-v4-pro` accepts an image block and ignores it: admission is the catalog's.
- Composition changes need a restart.

## 14. File map

```
key files; .ts omitted
src/kernel/  tokens · bus · context · errors
src/core/    scope · json · ids · text; a package per §3 row, plus effects/ (no service) and metering/
  session/   store · session · surface · page · title · format · repair · invariant
  agent/     index (resolveCallConfig) · repair · invariant
  loop/      driver · factory · marker · invariant
  sandbox/   events · index (writableRoots) · paths (canonicalPath) · invariant
src/capabilities/
  llm-deepseek/ · llm-anthropic/ · llm-retry/ · model-roles/ · tool-subagent/ · tool-history/
  fs-local/ · fs-observation-policy/ · tool-editor/ · attachments-local/ · tool-view-image/
  shell-stdio/ (confine/) · tool-shell/ · approval-headless/ · authority-presets/
  persistence-jsonl/ · credentials-local/ · settings-local/ · spill-local/ · composition-record/
  context-runtime/ · workspace-instructions/ · compaction-basic/ · session-title/
  protocol/ (frames · host · connection · transport-*)
src/app/     cli · home · compose · config · settings · headless · serve · web · present · inspect (the cold readers)
             web/ · terminal/ · *.e2e.test.ts
src/test-support/ scripted-adapter · harness · llm-replay · serve-process · web-process · fixtures/
scripts/     build · check-deps · check-docs · doc-registers · count-lines
bin/         minidsh.js
.github/     workflows/ (check, live, release) · ISSUE_TEMPLATE/
(root)       README · CLAUDE · CONTRIBUTING · SECURITY · CHANGELOG · LICENSE · NOTICE
docs/        PROJECT · ARCHITECTURE · BLUEPRINT
references/  README · assumptions · dsh/
.claude/     hooks/guard-repo.mjs · skills/docs-maintenance/SKILL.md
```

`scripts/count-lines.ts` measures the tree; the 1.0.0 line counts are in BLUEPRINT §4.
