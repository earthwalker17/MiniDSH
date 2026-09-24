# DSH reference: Surfaces: host, clients, protocol, Desktop

> Where to research DSH's host, clients, carriers and Desktop ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19.

## What exists (at the pin)

Status `default` = mounted by the shipped `web` profile (`packages/bundle/base` plus `packages/bundle/web-app`). No TUI ships.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Profiles, launcher | `packages/bundle`, `apps/cli` | default | Sole Node launcher; `dsh --profile <name>` boots an ordered stack of bundle patches |
| HTTP carrier, static seat | `packages/host/webserver`, `packages/host/frontend-static` | default | Concept-free `node:http` routes (127.0.0.1:3080); serves the SPA |
| Connection | `packages/client/connection` | default | Browser wire: trust fence, launch-token cookie, connection generations |
| API Gateway, Remotes | `packages/api/gateway`, `packages/api/remotes` | default | Typert `@Remote` calls and streams over `/api/remote.mux`; `$events` forwarding |
| Session Controller | `packages/api/session-controller` | default | List, fork, prompt, cancel, page, follow, control; Client mirrors |
| Client Modules, Slots | `packages/client/modules`, `packages/client/ui-slots` | default | Boot graph, typed slots; components never receive `ctx` |
| Commands, approvals | `packages/interaction/commands`, `packages/interaction/user-approval`, `packages/client/ui-approval` | default | Slash commands, approval dispatch and audit; panel: allow-once or reject only |
| PTY sessions | `packages/terminal`, `packages/api/terminal-controller` | opt-in | Not a TUI: controller and panel in web-app, PTY backend only in `minimal` and sdk-minimal |
| SDK, ACP | `packages/sdk`, `packages/acp/acp` | opt-in | Newline JSON-RPC and Agent Client Protocol over stdio, as profiles |
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron carrier: its own signed runtime and a private Desktop Host |

## Open for the route

- **S17, the control-plane tier.** The control stream is transient: each generation opens with a full process-local baseline, then replacement frames for queues, jobs and projections; baselines "cannot reconstruct jobs after a Host restart". `packages/api/session-controller/README.md`
- **S17, subscription order.** The Host attaches every `$events` listener and sends one `ready` frame before the Client reads any baseline; notifications never replay. `packages/client/connection/README.md`
- **S21, following a child.** A child is followed through a direct-parent subagent address on the same journal stream: another attach, not a new channel. `packages/api/session-controller/README.md`
- **S22, fork on the wire.** Fork copies through the selected completed turn and rejects an anchor inside an unfinished one. `packages/api/session-controller/README.md`
- **S22, display facts.** Commands stay Host-side: durable `command/run` and `command/done` events carry display facts as data, so clients never parse text. `docs/subsystems/commands.md`
- **S22, the Desktop launcher.** No second protocol: the window loads packaged Web assets and forwards HTTP to the authenticated Web Host; one signed update unit, the single-instance lock before any profile I/O, recovery without a Host. `apps/desktop/README.md`
- **Built.** Attach without a lower-bound cursor, bounded trace-free pages, tier-aware shedding, unseen approvals settling `unavailable`, the terminal client: ARCH §12; verdicts in [assumptions.md](../assumptions.md).

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/web-client.md` | Layer map, reconnection, the truth rule | 2026-09-19 |
| `packages/api/session-controller/src/history.ts` | `follow()`, `page()`: snapshot, cursor, queues | 2026-09-19 |
| `packages/api/session-controller/README.md` | Control stream, child follow, fork rule, limitations | 2026-09-19 |
| `packages/api/gateway/README.md` | Mux, `$events`, no replay, heartbeat | 2026-09-19 |
| `packages/client/connection/README.md` | Trust fence, cookie, listeners-first handshake | 2026-09-19 |
| `docs/subsystems/web-server.md` | Carrier contract; a stale Electron sentence | 2026-09-19 |
| `apps/desktop/README.md` | Wrapper, profile ownership, update unit, recovery | 2026-09-19 |
| `apps/cli/README.md` | Launcher, profiles, `tui` only as an example name | 2026-09-19 |
| `packages/bundle/README.md`, `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | Profile map; base and Web rows | 2026-09-19 |
| `docs/subsystems/approval.md`, `packages/client/ui-approval/README.md` | Closed outcomes, audit pair; the panel | 2026-09-19 |
| `docs/subsystems/slots.md`, `docs/subsystems/client-modules.md`, `docs/subsystems/commands.md` | Slots, boot graph, command descriptors | 2026-09-19 |

## Likely to go stale

- `history.ts` (changed 2026-09-09): a deprecated `snapshotEvents` read and a stale `follow` JSDoc signal a rewrite.
- `docs/subsystems/web-server.md` says Electron loads `file://` through IPC, against `apps/desktop/README.md`.
- Five profiles, no TUI: a `tui` bundle needs no core change.
- Auth: cookie not `Secure`, no logout (`packages/client/connection/README.md`); remote access changes both.
- Process-local control baselines are deferred work; jobs may gain a durable projection.
- The panel and `ui-*` set churn; `web-client.md` already disowns `HostFrame`, `events.mux`, `resync()`.

## Not read

- SDK subscription and resume (`packages/sdk/protocol/README.md`); ACP resume and permission timeouts (`packages/acp/acp/README.md`).
- The zero-client approval case and any timeout: `packages/api/remotes`.
- Mux send bounds (`packages/api/gateway/src`); `apps/web/stress-tests`; control frames (`packages/api/session-controller/src/control.ts`).
- `packages/client/ui-jobs`, `packages/client/ui-subagent`, `packages/client/ui-permission-presets`.
- `docs/api-gateway.md`, `docs/subsystems/client-resources.md`, `docs/subsystems/sidebar-right.md`, `docs/subsystems/boot.md`, `apps/cli/composition.md`.
- Desktop update feed, `apps/desktop-host` source, `apps/desktop/electron-builder.config.mjs`.
- What mounts `packages/terminal`; notes under `.agents/notes/`; the TUI removal history.
- Where the Web client keeps its ledger of its own scroll writes (`app/web/app.js` contrasts MiniDSH's sampling with it).
