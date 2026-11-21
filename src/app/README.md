# src/app

This layer assembles the runtime and holds its surfaces. It may import anything, and no source file in `kernel`, `core` or `capabilities` imports it, tests excepted ([ARCHITECTURE section 1](../../docs/ARCHITECTURE.md#1-layers-and-dependency-direction), enforced by `scripts/check-deps.ts`, which also keeps each browser module in `web` to sibling imports).

One runtime, several surfaces. `main` in `cli.ts` maps a command to an entry function, and every surface boots the same rows through `bootComposition` in `headless.ts`.

- **Terminal** (`minidsh chat`, and `resume` or `fork` without `--headless`): `runTerminal` in `terminal/index.ts` starts the protocol host on an in-process stream pair and talks to it as a client.
- **Stdio** (`minidsh serve`): `startProtocolHost` in `serve.ts` puts the same host on the process's stdin and stdout.
- **Web** (`minidsh web`): `startWebHost` in `web.ts` serves it on a WebSocket at `/ws`. The desktop app spawns this command.
- **Headless** (`minidsh run`): `runTask` in `headless.ts` is the exception. It drives the agent registry directly, with no protocol host. Under `--json` it prints the frame the wire carries.

## Start here

- [`cli.ts`](cli.ts): `main` maps a command to its entry function. `planBoot` turns flags, settings and disk layers into one boot plan.
- [`headless.ts`](headless.ts): `bootComposition` is the boot. `runTask` is the shortest path from a task to an agent.
- [`compose.ts`](compose.ts): the default rows, and how a row is patched and mounted.

## Reading order

1. [`home.ts`](home.ts): where user data lives, and that only this file resolves `MINIDSH_HOME`.
2. [`settings.ts`](settings.ts): which model a new session gets, and in what precedence.
3. [`compose.ts`](compose.ts): what the default composition mounts.
4. [`config.ts`](config.ts): how `composition.json` and `--patch` layers change rows, and what a session records about them.
5. [`headless.ts`](headless.ts): how a process boots the rows and runs, resumes or forks one task.
6. [`serve.ts`](serve.ts): how the protocol host joins as one more row.
7. [`terminal/index.ts`](terminal/index.ts): how the terminal is a protocol client in the same process.
8. [`web.ts`](web.ts): what guards the HTTP and WebSocket surface.
9. [`cli.ts`](cli.ts): how flags become boot options, from `planBoot` down to each command.

## Modules

DSH paths are upstream paths, pinned in [`references/README.md`](../../references/README.md). "Not compared" means none is recorded there.

| Module | Owns | DSH counterpart | Where MiniDSH differs |
|---|---|---|---|
| `cli.ts` | argument parsing, the command table, exit codes | `apps/cli` | One CLI over rows in code. DSH launches named profiles. |
| `compose.ts`, `config.ts` | the default rows and the patch algorithm. Disk layers and the recorded descriptor | `packages/boot`, `packages/bundle/*`, `packages/boot/plugin-manager` | A row changes only when a person edits a file or passes `--patch`, and only at restart. DSH has config HMR and a model-facing `plugin_manager`. |
| `headless.ts`, `serve.ts` | the shared boot and the one-shot run. The stdio host assembly | `packages/bundle/*` | DSH composes named profiles from bundle patches. Here a surface adds one row to a shared base. |
| `home.ts`, `settings.ts`, `version.ts` | the home's paths. Boot-time agent defaults. The version string | Not compared | |
| `present.ts` | durable events as plain-text lines | None. DSH's `present` is an unrelated model tool | |
| `inspect.ts` | the cold readers behind `sessions verify` and `sessions inspect` | Not compared | |
| `web.ts`, `web` directory | the HTTP server, sign-in and request fence. The browser client | `packages/host`, `packages/client`, `packages/api`, `apps/web` | The browser speaks the same JSON-RPC protocol and draws cards the tools declare. DSH has a separate gateway and a React client. MiniDSH has one principal and no file upload. |
| `terminal` directory | a full-screen view and a line view over one controller | None in-tree | DSH ships no terminal UI. |

Reasons for a difference are in [section 12](../../docs/ARCHITECTURE.md#12-divergences-from-deepseek-harness-the-ones-that-still-shape-decisions). The desktop app is a separate package: [`desktop/README.md`](../../desktop/README.md).

## The contract

- Invariants: [8. Surfaces](../../docs/ARCHITECTURE.md#8-surfaces) (what a surface may hold, the attach contract, the `web --json` process contract) and [9. Composition, configuration and packaging](../../docs/ARCHITECTURE.md#9-composition-configuration-and-packaging) (home, layers, trust, defaults). Current gaps: [13. Known limitations](../../docs/ARCHITECTURE.md#13-known-limitations-current).
- Tests: `app.test.ts` and `composition.test.ts` on the full composition, `web.test.ts` for the fence, `web/rows.test.ts` for visibility parity between the browser and plain text, `terminal/terminal.test.ts` for the line view's wire behaviour, `fixtures.test.ts` for readers on old logs. The `*.e2e.test.ts` files are the live arcs of [10. Verification](../../docs/ARCHITECTURE.md#10-verification).
- A new surface, event line or terminal key: [11. Where new things go](../../docs/ARCHITECTURE.md#11-where-new-things-go).
- Using the surfaces: [the guide](../../docs/GUIDE.md#the-four-surfaces). The wire: [`../capabilities/protocol/README.md`](../capabilities/protocol/README.md).
