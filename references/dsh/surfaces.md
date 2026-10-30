# DSH reference: Surfaces: host, clients, protocol, Desktop

> Where to research DSH's host, clients, carriers and Desktop ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, dsh-v0.2.1-rc.3); checked 2026-10-25.

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
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron shell over packaged Web assets; the `desktop` profile on an OS-assigned port |

## Open for the route

- **S22, following a child.** Only through its direct-parent address: header `origin: 'subagent'` and `parentSession` must match, and the `subagent` projection must lie in the child's own range. `packages/api/session-controller/src/history.ts`
- **S22, fork on the wire.** An explicit `atSeq` copies the exact inclusive prefix, even inside an open turn; omitted, the latest completed turn and its tail. Since rc.3 an ordinary fork records no source (no `parentSession`); subagents keep their creator. `docs/upgrade-guide/v0.2.1-rc.3/independent-session-forks/guide.md`
- **S22, resume without a prompt.** SDK `session/resume` restores a persisted session without input, refusing a missing, incompatible or occupied one. `packages/sdk/protocol/README.md`
- **S22, prompt retries.** Idempotent on a client-minted `requestId`, echoed as the user source's `rpcId`, which also binds the prompt's upload receipts. `packages/api/session-controller/src/commands.ts`
- **S22, uploads.** One streaming request per file, not resumable; an image is bounded by the per-image and per-message limits and stored via `ctx.attachments` before any prompt. `packages/client/file-upload/README.md`
- **S22, tool KIND.** `ToolCallKind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `fetch`, `other`): a per-call render category from the tool's `presentCall` (`web_search` is `search`), UI-only, on a `Generic | Terminal | Diff` view; the approval panel parses only `args.command`. `packages/core/tools/src/presentation.ts`
- **S22, paging and the wire's bounds.** `turnWindow` asks 50 messages and two `turn/start` minima; the cap is the CLIENT's `maxMessages` (Web 500; Host default 50, no maximum); the uplink overflows at `streamInboxBytes` (`gateway/uplink-overflow`); the downlink awaits each socket write. `packages/api/gateway/src/stream-server.ts`
- **S22, display facts.** `command/run` and `command/done` bracket the handler; `command/done.sourceEventSeq` joins a projection without parsing text. `docs/subsystems/commands.md`
- **S22, an unseen approval.** It waits in the Gateway's Host-wide pending map, reaches each owner client that connects, and ends only on an answer, a cancel or the Agent's release: no timeout. `packages/api/gateway/src/index.ts`
- **S22, the Desktop launcher.** No second protocol: the window loads `dsh-app://app/` and forwards HTTP and WebSocket to the authenticated Host; one signed update unit (shell, dsh, pnpm); the single-instance lock precedes profile I/O; installers ship from `download.deepseek.com`. `apps/desktop/README.md`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/web-client.md`, `web-server.md`, `docs/api-gateway.md` | Layers, the truth rule; the carrier; `@Remote` | 2026-10-25 |
| `packages/api/session-controller/README.md`, `src/{history,commands}.ts` | `follow()`, `page()`, `paginate()`; fork, prompt idempotency | 2026-10-25 |
| `packages/api/gateway/README.md`, `src/{index,stream-server}.ts`, `packages/api/remote-access/README.md` | Mux, pending waterfalls, write chain; RBAC | 2026-10-25 |
| `packages/client/connection/README.md`, `packages/host/webserver/README.md` | Peers, cookie, TLS, bind rules | 2026-10-25 |
| `apps/desktop/README.md`, `apps/desktop/publishing/README.md` | Loading, ownership, updates, publication | 2026-10-25 |
| `packages/sdk/protocol/README.md`, `packages/acp/acp/README.md`, `packages/client/file-upload/README.md` | The stdio carriers; uploads | 2026-10-25 |
| `packages/client/ui-chat/src/client/chat/use-scroll-follow.ts` | Follow intent as state; its own target and last sample mark its writes | 2026-10-25 |

## Likely to go stale

- `history.ts` still reads the deprecated `snapshotEvents`.
- `packages/host/webserver/README.md` says Electron loads `file://` over IPC, against `apps/desktop/README.md`; `packages/api/remotes/README.md` says a listener set per Client stream, against the single source `registerRemoteEvents()` consumes.
- Remote access is new (10-12); the Web cookie still has no logout.

## Not read

- `apps/desktop-host/src` (outside the snapshot); the liveshare owner bundle and Relay (outside the repository).
- `packages/experimental/webworker-runtime`: the Host-in-a-Worker preview that the upload carrier names.
