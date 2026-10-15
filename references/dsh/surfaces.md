# DSH reference: Surfaces: host, clients, protocol, Desktop

> Where to research DSH's host, clients, carriers and Desktop ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2); checked 2026-09-26; the S17 rows rechecked at `57190202` on 2026-10-15.

## What exists (at the pin)

Status `default` = mounted by the shipped `web` profile (`packages/bundle/base` plus `packages/bundle/web-app`).

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Profiles, launcher | `packages/bundle`, `apps/cli` | default | Sole Node launcher; `dsh --profile <name>` boots an ordered stack of bundle patches |
| HTTP carrier, static seat | `packages/host/webserver`, `packages/host/frontend-static` | default | Concept-free `node:http` routes; `dsh web` refuses `0.0.0.0` |
| Connection | `packages/client/connection` | default | Browser wire: trust fence, launch-token cookie, generations; every request is admitted as the one operator Peer |
| API Gateway, Remotes | `packages/api/gateway`, `packages/api/remotes` | default | Typert `@Remote` unary over POST, streams over the `/api/remote.mux` WebSocket with a per-stream uplink cap; `$events` forwarding |
| Session Controller | `packages/api/session-controller` | default | List, fork, prompt, cancel, page, follow, control; Client mirrors; archive gate |
| Job, workspace, terminal controllers | `packages/api/job-controller`, `workspace-controller`, `workspace-files`, `terminal-controller` | default | `job.list`, `job.follow`, `job.kill` (web-app only); workspace baseline plus increments; bounded file reads; PTY panel |
| Commands, approvals | `packages/interaction/commands`, `packages/interaction/user-approval`, `packages/client/ui-approval` | default | Slash commands, approval dispatch and audit; the panel: allow-once or reject |
| Jobs, subagent, permission UI | `packages/client/ui-jobs`, `ui-subagent`, `ui-permission-presets` | default | Job roster; child catalog and continuation; `/permission` picker over log-only `permission/preset` |
| SDK, ACP | `packages/sdk`, `packages/acp/acp` | opt-in | Newline JSON-RPC (three requests, four notifications, no subscription); ACP (`session/list`, `resume`, `close`; one-shot permission; no fork) |
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron shell over packaged Web assets; the `desktop` profile on port 19387 |

## Open for the route

- **S17, the control-plane tier.** The control stream is transient and carries projections only: each generation opens with a baseline from `ctx.sessions.list()`, then sequenced frames, in an unbounded per-stream queue (no drop, no coalescing). `packages/api/session-controller/src/control.ts`
- **S17, subscription order.** The Host attaches every `$events` listener and sends one `ready` frame first; one-way notifications never replay, but a still-pending approval waterfall IS replayed after a reconnect; non-page clients default to `interactions:'none'` since 2026-10-14. `packages/api/remotes/README.md`
- **S17, jobs on the wire.** The roster is NOT on the control stream (a bundle comment says it is): `job.list` streams whole-set rows coalesced over 100 ms, `job.follow` one job's ring then its status, and both are empty after a Host restart. `packages/api/job-controller/README.md`
- **S21, following a child.** A child is followed through a direct-parent subagent address on the same journal stream, validated against the header's `parentSession` and the `subagent` projection identity. `packages/api/session-controller/src/history.ts`
- **S22, fork on the wire.** An explicit `atSeq` copies the exact inclusive prefix, even inside an open turn; omitted, the latest completed turn and its tail; the chat action offers completed turns. `packages/api/session-controller/README.md`
- **S22, prompt retries.** Idempotent on a client-minted `requestId`, echoed as the user source's `rpcId`. `packages/api/session-controller/README.md`
- **S22, paging and uplink.** `turnWindow` asks 50 messages and two `turn/start` minima under the 500-message cap; a stream's Client-to-Host inbox is capped at `streamInboxBytes`, overflow failing that logical stream (`gateway/uplink-overflow`), never the carrier. `packages/api/gateway/src/stream-server.ts`
- **S22, display facts.** Commands stay Host-side: `command/run` and `command/done` bracket the handler, and `command/done` carries a `sourceEventSeq` so clients join a projection without parsing text. `docs/subsystems/commands.md`
- **S22, the Desktop launcher.** No second protocol: HTTP and WebSocket forward to the authenticated Web Host; one signed update unit; the single-instance lock precedes any profile I/O; installers ship off-GitHub. `apps/desktop/README.md`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/web-client.md`, `docs/subsystems/web-server.md` | Layer map, the truth rule; carrier contract | 2026-09-26 |
| `packages/api/session-controller/src/history.ts`, `src/control.ts` | `follow()`, `page()`, `paginate()`; control baseline | 2026-09-26 |
| `packages/api/gateway/README.md`, `src/index.ts` | Mux, `$events`, no replay, heartbeat | 2026-09-26 |
| `apps/desktop-host/src/index.ts` | Profile ownership, recovery | 2026-09-26 |
| `packages/bundle/README.md`, `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | Profile map; base and Web rows | 2026-09-26 |
| `packages/sdk/protocol/README.md`, `packages/acp/acp/README.md` | The two stdio carriers' method sets | 2026-09-26 |

## Likely to go stale

- `history.ts` (turn-boundary paging 09-22) still reads the deprecated `snapshotEvents`; cancellation retention was bounded 09-23.
- `docs/subsystems/web-server.md` says Electron loads `file://` through IPC, against `apps/desktop/README.md`.
- Auth: cookie not `Secure`, no logout (`packages/client/connection/README.md`); remote access changes both.

## Not read

- Downlink send bounds in `packages/api/gateway/src` (only the uplink cap and the heartbeat were read).
- `docs/api-gateway.md`, `docs/subsystems/{client-resources,sidebar-right,boot}.md`: heads only.
- Where the Web client keeps its ledger of its own scroll writes (`packages/client/ui-chat`; `src/app/web/app.js` contrasts MiniDSH's sampling with it).
