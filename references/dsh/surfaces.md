# DSH reference: Surfaces: host, clients, protocol, Desktop

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

Status is relative to the shipped `web` profile (`packages/bundle/base` plus `packages/bundle/web-app`). No TUI ships.

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| Profiles, launcher | `packages/bundle`, `apps/cli` | default-mounted | Sole supported Node launcher boots a named profile: an ordered stack of bundle patches. |
| HTTP carrier, static seat | `packages/host/webserver`, `packages/host/frontend-static` | default-mounted | Concept-free `node:http` route registry (127.0.0.1:3080); one fallback seat serves the SPA. |
| Connection | `packages/client/connection` | default-mounted | Browser wire: `/api` bridge, trust fence, browser-session auth, connection generations. |
| API Gateway, Remotes | `packages/api/gateway`, `packages/api/remotes` | default-mounted | Typert `@Remote` calls and streams, `/api/remote.mux` WebSocket, `$events` forwarding. |
| Session Controller | `packages/api/session-controller` | default-mounted | Host list, fork, prompt, cancel, page, follow, control; React-free Client mirrors. |
| Client Modules, Slots | `packages/client/modules`, `packages/client/ui-slots` | default-mounted | Boot graph, `/plugins` bundles, typed slots; components never receive `ctx`; 47 `ui-*` directories. |
| Commands, approvals | `packages/interaction/commands`, `packages/interaction/user-approval`, `packages/client/ui-approval` | default-mounted | Base rows: slash-command registry, approval dispatch and audit. Browser panel: allow-once or reject only. |
| PTY sessions | `packages/terminal`, `packages/api/terminal-controller` | opt-in | Not a TUI. The controller and sidebar panel ship in web-app; the PTY backend only in `minimal` and sdk-minimal. |
| SDK, ACP | `packages/sdk`, `packages/acp/acp` | opt-in | Newline JSON-RPC and Agent Client Protocol over stdio, selected as profiles. |
| Desktop | `apps/desktop`, `apps/desktop-host` | opt-in | Electron carrier, not a thin client: its own signed runtime plus a private Desktop Host. |

## Mechanisms worth knowing

- **Profiles**: `dsh --profile <name>` boots `$DSH_HOME/profiles/<name>`: ordered `dsh.profile.bundles` under the user's profile and home patches. Five auto-initialize (web, headless, sdk, sdk-minimal, acp); SDK and ACP are "profiles, not separate public bins"; the CLI rejects the Electron-owned `desktop`. `apps/cli/README.md`, `packages/bundle/README.md`
- **Carrier, trust, identity**: the carrier owns no harness concepts, TLS, auth or Origin policy. Connection adds a fence (Host loopback or in `trustedHosts`, Origin equal to Host, cross-site refused), then identity: a per-process launch token becomes a signed cookie every RPC and stream requires; no loopback tier. `docs/subsystems/web-server.md`, `packages/client/connection/README.md`
- **Listeners before baseline**: the Host attaches every `$events` listener, sends one `ready` frame, and only then the Client reads baselines (warning at 3 s, abort at 15 s). Carrier loss retries; business errors and protocol violations are terminal; notifications never replay. `packages/client/connection/README.md`, `packages/api/gateway/README.md`
- **Attach**: `follow()` yields one snapshot (header, tail page of `DEFAULT_MAX_MESSAGES = 50`, `cursor`, projection baseline, optional assistant-stream baseline), then events exactly `cursor+1` onward; a skipped seq throws `gateway/internal`. No lower-bound cursor: each generation replaces the Client window; `page()` (`beforeSeq`, `throughSeq`) serves history and gap repair. `packages/api/session-controller/src/history.ts`, `docs/subsystems/web-client.md`
- **Buffering and bounds**: each `follow()` owns a private `Deque` with no cap, drop or eviction; events are shared frozen objects, not copies. `maxMessages` counts message events but pages slice every event in range, log-only included, so page bytes are unbounded. The mux Ping (2 s) is liveness; no send bound is documented. `packages/api/session-controller/src/history.ts`, `packages/api/gateway/README.md`
- **Control stream**: a snapshot stream opens every generation with a complete process-local baseline, then replacement frames for queues, jobs and projections; the Client clears retained values each generation. Known Limitation: baselines "cannot reconstruct jobs after a Host restart". `packages/api/session-controller/README.md`
- **Approvals**: `ctx.approval.request` needs an open turn; it appends log-only `approval/asked`, runs the `approval/request` waterfall, appends `approval/decided`. Closed outcomes: `allowed-once`, `rejected`, `cancelled`, `unavailable`; a missing or throwing answerer yields `unavailable`; policy `never` rejects before dispatch. Pending asks survive reconnect. `docs/subsystems/approval.md`, `packages/api/gateway/README.md`
- **Desktop**: an Electron RunAsNode child runs the shared profile runner; the window loads packaged Web assets at `dsh-app://app/`, HTTP forwarded to the authenticated Web Host. The single-instance lock precedes any profile access; Electron alone owns `$DSH_HOME/profiles/desktop`; shell, runtime and pnpm are one signed update unit; native recovery works without a Host. `apps/desktop/README.md`

## Why it matters to MiniDSH

- **S17, the control-plane tier**: upstream separates a seq-validated durable journal from a transient snapshot stream that resends a full baseline each generation. Transferable: never dress job or queue state as pseudo-durable wire events, and keep the listeners-first order. Upstream accepts process-local job views as a limit; folding the tier from S17's durable job brackets (re-derived after an S14 recovery) has NO upstream oracle.
- **Attach cursor, confirmed**: upstream has no lower-bound resume cursor either (the `follow` JSDoc names a caller-held sequence the code never reads). MiniDSH's choice is parity; snapshot-replace stays the one recovery path.
- **Backpressure, deliberate difference**: upstream follower queues are uncapped with no documented mux bound, so MiniDSH's bounded, tier-aware shedding has NO oracle; keep it, and S17 places the control tier in the shedding order.
- **Pages, FALSIFIED**: "DSH packs the trace tier into pages" was wrong in vocabulary: upstream has surface and log-only events, and log-only ones ride pages because strict contiguity needs them. MiniDSH's trace-free pages are deliberate, so its contiguity checks must be tier-aware. Also falsified: "per-follower copies" (shared frozen references).
- **S15, approvals nobody can see**: upstream yields `unavailable` only when no answerer is composed; with the Web answerer composed and no browser attached, no timeout was found: the ask waits. MiniDSH settling `unavailable` has NO oracle. Transferable: the UI only answers; policy, audit and grants stay on the runtime's record. The upstream panel offers no grants, so session-lifetime grants lack a UI oracle.
- **S21 and S22, client verbs** (`packages/api/session-controller/README.md`): a child is followed through a direct-parent subagent address on the same journal stream: another attach, not a new channel. Fork copies through the selected completed turn and rejects an anchor inside an unfinished one; prompt retries are idempotent on a client-minted `requestId`.
- **S22, the truth rule**: Client models are "not a second source of business truth" (`docs/subsystems/web-client.md`). Slash commands stay Host-side: adapters get handler-free descriptors, and durable `command/run` and `command/done` events carry display facts as data, so clients never parse text (`docs/subsystems/commands.md`).
- **S22, Desktop launcher**: upstream Desktop adds native adapters and packaging, no second runtime protocol. Copy the invariants (one release identity, exclusive profile ownership, lock before profile I/O, recovery without a Host), not the Electron update machinery.
- **Terminal client, one protocol**: upstream ships no TUI (`tui` is only an example profile name in `apps/cli/README.md`), so the terminal client has NO oracle. PARTLY FALSIFIED: "five protocol profiles"; they are composition profiles (sdk and sdk-minimal share one protocol) in `packages/bundle`, not `packages/preset`. ONE JSON-RPC over three carriers is deliberate; keep carriers noun-free.

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `docs/subsystems/web-client.md` | Layer map, reconnection, the truth rule | 2026-09-19 |
| `packages/api/session-controller/src/history.ts` | `follow()`, `page()`: snapshot, cursor, contiguity, Deque | 2026-09-19 |
| `packages/api/session-controller/README.md` | Client journal, control stream, fork rule, Known Limitations | 2026-09-19 |
| `packages/api/gateway/README.md` | `/api/remote.mux`, `$events`, no replay, heartbeat | 2026-09-19 |
| `packages/client/connection/README.md` | Browser session, trust fence, generation handshake | 2026-09-19 |
| `docs/subsystems/web-server.md` | Carrier contract; a stale Electron sentence | 2026-09-19 |
| `apps/desktop/README.md` | Wrapper, profile ownership, recovery, update unit | 2026-09-19 |
| `apps/cli/README.md` | Launcher, five profiles, `tui` example, `profile-boot` | 2026-09-19 |
| `packages/bundle/README.md`, `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | Profile map; base and Web rows | 2026-09-19 |
| `docs/subsystems/approval.md`, `packages/client/ui-approval/README.md` | Closed outcomes, policy, audit pair; the panel | 2026-09-19 |
| `docs/subsystems/slots.md`, `docs/subsystems/client-modules.md`, `docs/subsystems/commands.md` | Slot axes, boot graph, command descriptors | 2026-09-19 |
| `docs/subsystems/web.md`, `docs/subsystems/terminal.md` | Naming traps: web search/fetch, not the GUI; PTYs, not a TUI | 2026-09-19 |

## Likely to go stale

- `history.ts`: changed 2026-09-09; a deprecated `snapshotEvents` read marked "migration deferred" and a stale JSDoc signal a pending rewrite.
- Desktop: `docs/subsystems/web-server.md` still says Electron loads `file://` through an IPC bridge, contradicting `apps/desktop/README.md`.
- Five profiles, no TUI: the bundle layout dates from 2026-08; a `tui` bundle needs no core change.
- Auth: cookie not `Secure`, no logout (Known Limitations in `packages/client/connection/README.md`); remote access would change both.
- Process-local control baselines are listed as deferred work; jobs may gain a durable projection.
- The approval panel and the `ui-*` set churn; `docs/subsystems/web-client.md` already disowns `HostFrame`, `events.mux` and `resync()`.

## Not read

- SDK subscription and resume (`packages/sdk/protocol/README.md`); ACP resume and permission timeouts (`packages/acp/acp/README.md`).
- The zero-client approval case and any timeout: `packages/api/remotes` (README and source).
- WebSocket mux send bounds (`packages/api/gateway/src`); `apps/web/stress-tests`; control frame types (`packages/api/session-controller/src/control.ts`).
- Job, subagent and grant presentation: `packages/client/ui-jobs`, `packages/client/ui-subagent`, `packages/client/ui-permission-presets`.
- `docs/api-gateway.md`, `docs/subsystems/client-resources.md`, `docs/subsystems/sidebar-right.md`, `docs/subsystems/boot.md`, `apps/cli/composition.md`.
- Desktop update feed, `apps/desktop-host` source, `apps/desktop/electron-builder.config.mjs`.
- What mounts `packages/terminal` (the base patch has no terminal row); decision-note bodies under `.agents/notes/`; the TUI removal history.
