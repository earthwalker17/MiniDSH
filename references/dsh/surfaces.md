# DSH reference: Surfaces: host, clients, protocol, Desktop

> Where to research DSH's host, clients, carriers and Desktop ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@22ddee37` (2026-10-23); the Web client rows re-read at `2e39e704` (2026-11-18, `@deepseek-ai/dsh` 0.2.2-rc.5) in S22, 2026-11-19, the CLI's TUI question there in S22.1 (none ships in-tree; built here: resume and fork on the wire, children followed read-only, ARCH §8, §12), and the Desktop rows there in S22.2, 2026-11-20 (built here: ARCH §8, §12).

## What exists (at the pin)

Status `default` = mounted by the shipped `web` profile (`packages/bundle/base` plus `packages/bundle/web-app`); profiles are in [architecture-map.md](architecture-map.md). Every call speaks for a Peer whose `principal` (the owner, or e.g. a liveshare viewer) only Host code sets (`.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md`).

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| HTTP carrier, static seat | `packages/host/webserver`, `packages/host/frontend-static` | default | Concept-free `node:http`, `node:https` given `tls` (10-08); one concrete bind IP, wildcards refused |
| Connection | `packages/client/connection` | default | Trust fence, launch-token cookie (`Secure` iff TLS), generations; browsers share one owner Peer, `/connect` mints one per API socket |
| API Gateway, Remotes | `packages/api/gateway`, `packages/api/remotes` | default | Typert `@Remote` unary over POST, streams over the `/api/remote.mux` WebSocket; `$events` forwarding |
| Remote access | `packages/api/remote-access` | default | Method-level RBAC for non-owner principals, mounted wherever the Gateway is; the owner is never checked |
| Session Controller | `packages/api/session-controller` | default | List, fork, prompt, cancel, page, follow, control; Client mirrors; archive gate |
| Uploads | `packages/client/file-upload` | default | A streaming upload to a staged receipt a later prompt cites; also in `sdk-app` |
| Job, workspace, terminal controllers | `packages/api/job-controller`, `workspace-controller`, `workspace-files`, `terminal-controller` | default | Job roster and follow; workspace increments; file reads; PTY panel |
| Commands, approvals | `packages/interaction/commands`, `packages/interaction/user-approval`, `packages/client/ui-approval` | default | Slash commands, approval dispatch and audit; the panel: allow-once or reject |
| SDK | `packages/sdk/protocol`, `server`, `client` | opt-in | Newline JSON-RPC: seven requests (`session/resume`, `session/wait`), opt-in `approval/request` and `user-question/ask`, five notifications; no subscription, no fork |
| ACP | `packages/acp/acp` | opt-in | `session/list`, `resume`, `close`; one-shot permission; no fork |
| Liveshare | `packages/experimental/liveshare-protocol` | experimental | Frames and identity for an owner bundle and Relay kept outside the repository |
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron 44; the Host is `spawn(execPath)` under `ELECTRON_RUN_AS_NODE` running the Web profile (`--port 0`), its secret and `ready` over Node IPC; `dsh-app://app/` serves the bundle and forwards HTTP, the WebSocket dials loopback with Cookie/Origin rewritten by `webRequest`; quit asks the Host (2 s) then confirms; close hides to the tray on Windows; NSIS per-user, EV-token signing, electron-updater on a generic feed (none when unsigned); 286 MiB installer |
| Web client UI | `packages/client/ui-*` (`ui-theme`, `ui-chat`, `ui-tool`, `ui-approval`, `ui-conversation`) | default | React over Slots; tokens static → alias → specific; a tool view registered by WIRE NAME by its owning package |

## Open for the route

- **later, prompt retries.** Idempotent on a client-minted `requestId`, echoed as the user source's `rpcId`, which also binds the prompt's upload receipts. `packages/api/session-controller/src/commands.ts`
- **later, uploads.** One streaming request per file, not resumable; an image is bounded by the per-image and per-message limits and stored via `ctx.attachments` before any prompt. `packages/client/file-upload/README.md`
- **later, paging and the wire's bounds.** `turnWindow` asks 50 messages and two `turn/start` minima; the cap is the CLIENT's `maxMessages` (Web 500; Host default 50, no maximum); the uplink overflows at `streamInboxBytes` (`gateway/uplink-overflow`); the downlink awaits each socket write. `packages/api/gateway/src/stream-server.ts`
- **later, display facts.** `command/run` and `command/done` bracket the handler; `command/done.sourceEventSeq` joins a projection without parsing text. `docs/subsystems/commands.md`
- **later, an unseen approval.** It waits in the Gateway's Host-wide pending map, reaches each owner client that connects, and ends only on an answer, a cancel or the Agent's release: no timeout. `packages/api/gateway/src/index.ts`
- **later, a login-shell environment for a GUI launch** (macOS/Linux): `$SHELL -ilc` dumping `env -0` between delimiters, bounded at 10 s, merged once per process. `apps/desktop/src/login-shell-environment.ts`
- **later, signed updates.** electron-updater, download only on a person's action, install after the Host drained; Authenticode checked against the installed `publisherName`. `apps/desktop/src/update-coordinator.ts`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/web-client.md`, `web-server.md`, `docs/api-gateway.md` | Layers, the truth rule; the carrier; `@Remote` | 2026-10-25 |
| `packages/api/session-controller/README.md`, `src/{history,commands}.ts` | `follow()`, `page()`, `paginate()`; fork, prompt idempotency | 2026-10-25 |
| `packages/api/gateway/README.md`, `src/{index,stream-server}.ts`, `packages/api/remote-access/README.md` | Mux, pending waterfalls, write chain; RBAC | 2026-10-25 |
| `packages/client/connection/README.md`, `packages/host/webserver/README.md` | Peers, cookie, TLS, bind rules | 2026-10-25 |
| `apps/desktop/README.md`, `src/{main,host-process,web-document,single-instance,quit-confirmation,fatal-recovery}.ts`, `apps/desktop-host/src/index.ts`, `scripts/electron-builder-config.mjs` | Process topology, the IPC handoff, the scheme, quit and fatal paths, fuses (`runAsNode: true` only), NSIS | 2026-11-20 |
| `packages/sdk/protocol/README.md`, `packages/acp/acp/README.md`, `packages/client/file-upload/README.md` | The stdio carriers; uploads | 2026-10-25 |
| `packages/client/ui-chat/src/client/chat/use-scroll-follow.ts` | Follow intent as state; its own target and last sample mark its writes | 2026-10-25 |
| `apps/cli/README.md` | `--profile tui` is an example of an installable profile; no TUI package in the tree | 2026-11-19 |
| `packages/client/ui-theme/src/styles/design-platform.css`, `ui-chat/README.md`, `ui-tool/README.md`, `ui-approval/README.md`, `docs/cookbook/reviewing-ui-design.md` | Tokens, process groups, per-tool views, the approval takeover, the review principles | 2026-11-19 |

## Likely to go stale

- `history.ts` still reads the deprecated `snapshotEvents`.
- `packages/host/webserver/README.md` says Electron loads `file://` over IPC, against `apps/desktop/README.md`; `packages/api/remotes/README.md` says a listener set per Client stream, against the single source `registerRemoteEvents()` consumes.
- Remote access is new (10-12); the Web cookie still has no logout.
- The Web client's look (its tokens, the `deepseek-*` accent ramp, Chat vs Trajectory views, process-group titles) moves weekly; the repository holds no image of a live conversation, only onboarding composites and design-review crops. `packages/client/ui-theme/`

## Not read

- The liveshare owner bundle and Relay (outside the repository). `apps/desktop`: `update-*.ts`, `platform-view.ts`, `browser-guests.ts`, `command-management.ts`, the installer's C++ frame.
- `packages/experimental/webworker-runtime`: the Host-in-a-Worker preview that the upload carrier names.
