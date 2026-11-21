# Reading the code

`src/` holds the runtime and its tests: a kernel, the core contracts, the capabilities that implement them, and the app that assembles the `minidsh` command. A checkout has no build step. Node strips the types and runs the `.ts` files directly. [`bin/minidsh.js`](../bin/minidsh.js) imports `src/app/cli.ts` when `src/` exists. An installed package has no `src/`, so it runs the JavaScript that [`scripts/build.ts`](../scripts/build.ts) emits into `dist/`.

## The four layers

Imports point one way: `app` → `capabilities` → `core` → `kernel`.

- [`kernel/`](kernel/README.md) is the composition substrate and imports nothing else in `src/`.
- [`core/`](core/README.md) defines sessions, agents, tools, model calls and authority, and imports only `kernel` and other `core`.
- [`capabilities/`](capabilities/README.md) has one directory per provider, tool or listener, each importing `kernel`, `core` except `core/loop`, and itself.
- [`app/`](app/README.md) picks the rows, owns the command line, the web host and the terminal, and may import anything.

`test-support/` is the fifth directory: test compositions, a scripted model, a replay adapter and stored-session fixtures. [ARCHITECTURE §1](../docs/ARCHITECTURE.md#1-layers-and-dependency-direction) has the rule and names its gate.

## Twelve files, in order

1. [`kernel/context.ts`](kernel/context.ts). Services, plugins, effects, scopes and the dispatch methods on one `Context`.
2. [`app/compose.ts`](app/compose.ts). `compose()` lists every default row, so read it as a table of contents.
3. [`core/session/types.ts`](core/session/types.ts). The event envelope, and which kinds are model history or trace.
4. [`core/session/session.ts`](core/session/session.ts). `commit` is the only way into the log: validate, let observers refuse, push, deliver.
5. [`core/loop/driver.ts`](core/loop/driver.ts). `turn`, `step` and `executeTools` fix the order of a turn's records.
6. [`core/tools/registry.ts`](core/tools/registry.ts). `execute` is the one path from a model's call to a tool body, and it awaits `onDispatch` before the body.
7. [`core/sandbox/index.ts`](core/sandbox/index.ts). `resolve` returns the per-call authority stamp, and every fence derives from `writableRoots`.
8. [`core/approval/index.ts`](core/approval/index.ts). `request` writes an ask and its decision, and settles some asks without any answerer.
9. [`capabilities/tool-editor/index.ts`](capabilities/tool-editor/index.ts). A whole tool: schemas, a body over the `fs` seam, no authority of its own.
10. [`capabilities/fs-local/index.ts`](capabilities/fs-local/index.ts). `writeText` fences the path, writes through the handle it verified, then records the effect.
11. [`capabilities/llm-deepseek/adapter.ts`](capabilities/llm-deepseek/adapter.ts). A provider adapter: a dated catalog, `validateOptions` before any I/O, a stream of neutral chunks.
12. [`capabilities/protocol/host.ts`](capabilities/protocol/host.ts). The JSON-RPC methods every surface except headless speaks.

## One turn, traced

A prompt arrives over the wire and the model answers with one `str_replace_editor` call. The driver is `core/loop/driver.ts` and the registry is `core/tools/registry.ts`. Other files not named here are in the list above.

1. **Arrival.** `ProtocolHost.onFrame` routes `session/prompt` through `dispatch` to `prompt`, which gets the agent from `acquire` and calls `agent.followup`. Headless has no wire: `drive` in `app/headless.ts` calls `followup` itself.
2. **Inbox.** `ReactLoopAgent.send` passes the message to `Inbox.append` in `core/agent/index.ts`, which records an `inbox/spliced` insert. An idle agent starts `run`.
3. **Claim.** The driver's `turn` appends `turn/start` and takes `inbox.claim`. `resolveCallConfig` picks the route. The `agent/pre-step` waterfall may add context. Then `step/start`, a `user/message` per entered message, and only then `commitClaim`.
4. **Request.** `step` calls `assemble` in `core/prompt/index.ts`, logs `request/header` if it changed, awaits `checkpoint`, and builds the request from `Session.deriveMessages`.
5. **Model.** `LlmRuntime.stream` in `core/llm/runtime.ts` runs the `llm/stream` waterfall, whose last link picks the adapter, here `DeepSeekAdapter.stream`. The driver appends each chunk as `assistant/chunk`, then one `assistant/message`.
6. **Call.** `executeTools` appends `tool/call`, checkpoints, and calls `ToolRegistry.execute`. That resolves the tool, validates the arguments and runs `gate`: the `tools/pre-execute` waterfall, the guards, and `approval.request` when a listener answered `ask`.
7. **Dispatch.** The registry's `dispatch` runs the `tools/execute` waterfall. Its last link awaits `onDispatch`, where the driver appends `tool/dispatch` and checkpoints. Then `runBody` calls the tool.
8. **Authority.** The editor's `strReplace` calls `fs.writeText`. `LocalFs.fence` asks `SandboxService.resolve` for the stamp folded from the log, and `allowsWrite` decides. A path outside throws `FS_SANDBOX_DENIED`, which becomes the result's error code.
9. **Effect.** After the bytes land, `LocalFs.record` appends `effect/recorded` with the call id, the canonical path and a hash.
10. **Result.** `runBody` renders the output. The driver's `commitResult` appends `tool/result` citing its call, then `step/end`. A second step sends the result to the model.
11. **End.** A step with no tool calls and no pending input ends the turn: `agent/turn-stopping`, `turn/end` with its reason, a last flush, and `agent/status` reports `idle`.
12. **Log and surface.** Each append went through `Session.commit`, where the mounted invariants saw it first. `session/event` then reached `capabilities/persistence-jsonl/index.ts`, which writes a line per event, and `ProtocolHost.onSessionEvent`, which forwards it unchanged as a `session.event` frame. Clients fold frames in `app/web/conversation.js`. Plain text goes through `describeEvent` in `app/present.ts`.

The rules each hop keeps are listed in [`core/README.md`](core/README.md#the-contract).

## How the tests work

[`vitest.config.ts`](../vitest.config.ts) defines the projects. `unit` takes the `*.test.ts` files under `src/`, `scripts/` and `desktop/src/`, except the live arcs and the browser suites. `browser` takes the suites that launch Chrome and runs them last, one file at a time. Tests mount real plugins through the kernel and replace only the model.

- `test-support/harness.ts` mounts the core plugins with invariants on. `scripted-adapter.ts` beside it is the model, a queue of chunk scripts.
- `test-support/llm-replay.ts` derives that script from a recorded log's `assistant/chunk` events. `assertConsumed()` fails if a recorded step was never requested.
- `test-support/fixtures/sessions/` holds real logs written by earlier builds. `app/fixtures.test.ts` reads, repairs and replays them.

The live arcs are the `*.e2e.test.ts` files. [`vitest.e2e.config.ts`](../vitest.e2e.config.ts) runs them one at a time against real providers, so they need a real key and cost money. An arc without its key skips itself, and a skip looks like a pass. Each `MINIDSH_EXPECT_*` flag turns one such skip into a failure: `_KEYS` for promised keys, the others for a shell, Python, a browser, a confinement backend or the desktop app. Commands are in [CONTRIBUTING.md](../CONTRIBUTING.md#toolchain).

## Where things go

[ARCHITECTURE §11](../docs/ARCHITECTURE.md#11-where-new-things-go) maps each kind of new thing to its home and says what to do when no row fits. [§14](../docs/ARCHITECTURE.md#14-file-map) is the repository's file map.
