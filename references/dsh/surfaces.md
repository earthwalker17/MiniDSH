# DSH reference: Surfaces: host, clients, protocol, Desktop

> Where to research DSH's host, clients, carriers and Desktop ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, dsh-v0.2.2-rc.5); checked 2026-11-21.

## What exists (at the pin)

Status `default` = mounted by the shipped `web` profile (base plus `packages/bundle/web-app`); profiles are in [architecture-map.md](architecture-map.md). Every call speaks for a Peer whose `principal` (the owner, or e.g. a liveshare viewer) only Host code sets (`.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md`).

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| HTTP carrier, static seat | `packages/host/webserver`, `packages/host/frontend-static` | default | Concept-free `node:http`, `node:https` given `tls`; one concrete bind IP literal |
| Connection, authentication | `packages/client/connection`, `packages/host/authentication-token` | default | The trust fence (Host, Origin), generations, and since 2026-11-12 a provider registry (`connection.authentication`); the token provider owns the launch-token cookie (`Secure` iff TLS) and `/connect`: browsers share one owner Peer, each API socket gets its own |
| API Gateway, Remotes | `packages/api/gateway` (a base row), `packages/api/remotes` | default | Typert `@Remote` unary over POST, streams over the `/api/remote.mux` WebSocket: one write queue per connection, sources paused past `streamOutboxBytes`, an uplink failing past `streamInboxBytes`; `$events` forwarding |
| Remote access | `packages/api/remote-access` (a base row) | default | Method-level RBAC for non-owner principals; the owner is never checked |
| Session Controller | `packages/api/session-controller` | default | List, fork, prompt, cancel, page, follow; archive gate. `page` takes upper bounds only; a window is 50 messages and two turns, capped at 500 |
| Uploads | `packages/client/file-upload` | default | A streaming upload to a staged receipt; also in `sdk-app` |
| Job, workspace, terminal controllers | `packages/api/job-controller`, `workspace-controller`, `workspace-files`, `terminal-controller` | default | Job roster and follow; workspace increments; file reads; PTY panel |
| Commands, approvals | `packages/interaction/commands`, `packages/interaction/user-approval`, `packages/client/ui-approval` | default | Slash commands bracketed by log-only `command/run` and `command/done`; the panel: allow-once or reject. An unseen ask waits in the Gateway's pending map for the next owner client, with no timeout |
| SDK | `packages/sdk/protocol`, `server`, `client` | opt-in | Newline JSON-RPC: eight requests (`session/resume` takes a `permissionMode` since 2026-11-13 and still rejects an occupied session; `session/wait`; a working-directory pair), opt-in `approval/request` and `user-question/ask`, six notifications; no subscription, fork, cancel or close |
| ACP | `packages/acp/acp` | opt-in | `session/list`, `resume`, `close`; one-shot permission; no fork |
| Liveshare | `packages/experimental/liveshare`, `liveshare-protocol` | experimental, bundle off | The owner bundle (sign-in, sharing controls, an outgoing gateway, viewer surfaces), in-tree since 2026-10-27; the Relay that authenticates viewers lives outside the repository |
| Desktop | `apps/desktop`, `apps/desktop-host`, `packages/host/authentication-desktop` | opt-in | Electron 44; the Host is `spawn(execPath)` under `ELECTRON_RUN_AS_NODE` running the Web profile (`--port 0`), its secret and `ready` over Node IPC; `dsh-app://app/` serves the bundle and forwards HTTP with a private `dsh-desktop-session` cookie attached in main, never in the jar; the WebSocket dials loopback, Cookie/Origin rewritten by `webRequest`; quit asks the Host (2 s) then confirms; close hides to the Windows tray; NSIS per-user |
| Web client UI | `packages/client/ui-*` | default | React over Slots; tokens static → alias → specific; a tool view registered by WIRE NAME by its owning package |

## Open for the route

- **later, uploads.** One streaming request per file, not resumable; an image is admitted and stored through `ctx.attachments` before any prompt. A prompt is idempotent on a client-minted `requestId`, echoed as the user source's `rpcId`, which also binds the receipts it cites. `packages/client/file-upload/README.md`, `packages/api/session-controller/src/commands.ts`
- **later, a GUI launch's environment** (macOS/Linux): the ACCOUNT's login shell from the user database (not `$SHELL`), then fixed system shells, each run `-ilc` dumping `env -0` between delimiters, 10 s per candidate, merged once before the first Host starts. `apps/desktop/src/login-shell-environment.ts`
- **later, signing then an updater.** An unsigned build gets NO feed (`publish: null`); a signed one a generic feed on a `nightly` or `stable` channel sealed into the manifest, Authenticode checked against the certificate's `publisherName`, macOS notarized. Checks are automatic, a download starts only on a person's action, install waits for the Host to lock admission and drain; a packaged policy origin can make an update mandatory. `apps/desktop/scripts/electron-builder-config.mjs`, `apps/desktop/src/update-coordinator.ts`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/web-client.md`, `web-server.md`, `docs/api-gateway.md` | Layers; the carrier and `ctx.connection.authentication`; `@Remote` | 2026-11-21 |
| `packages/api/session-controller/README.md`, `src/{history,commands,types}.ts` | `follow`, `page`, the turn window; fork, cancel, prompt idempotency | 2026-11-21 |
| `packages/api/gateway/src/{index,stream-server}.ts`, `packages/api/remote-access/README.md` | Mux, pending waterfalls, the write queue; RBAC | 2026-11-21 |
| `packages/client/connection/README.md`, `packages/host/webserver/README.md`, `packages/host/authentication-{token,desktop}/README.md` | Peers, providers, cookie, TLS, bind rules | 2026-11-21 |
| `apps/desktop/README.md`, `src/{main,host-process,web-document,quit-confirmation,fatal-recovery}.ts`, `apps/desktop-host/src/index.ts`, `apps/desktop/scripts/electron-builder-config.mjs` | Topology, the IPC handoff, the scheme, quit and fatal paths, updates, fuses (`runAsNode: true` only), NSIS, signing | 2026-11-21 |
| `packages/sdk/{protocol,server}/README.md`, `packages/acp/acp/README.md`, `packages/client/file-upload/README.md`, `packages/experimental/liveshare/README.md` | The stdio carriers, the resume contract; uploads; the owner bundle | 2026-11-21 |
| `packages/client/ui-tool/README.md`, `ui-chat/README.md`, `ui-theme/src/styles/design-platform.css` | Per-tool views, process groups, tokens | 2026-11-21 |

## Likely to go stale

- The SDK method set grows (seven requests on 10-23). Authentication providers are new; the Token one documents no logout: a cookie lives 30 days (`cookieMaxAgeDays`).
- Liveshare (76 commits in three weeks) and the Web client's look (tokens, Chat vs Trajectory views) move weekly; the repository holds no image of a live conversation.

## Not read

- The Relay (outside the repository); `packages/experimental/liveshare/src`; `liveshare-protocol` beyond its summary.
- `apps/desktop`: `mandatory-update-policy.ts`, the other `update-*.ts`, `platform-view.ts`, `browser-guests.ts`, `command-management.ts`, `windows-signing/`, `publishing/`, the installer's C++ frame; `apps/desktop-publisher`.
- `packages/experimental/webworker-runtime`: the Host-in-a-Worker preview that the upload carrier names.
