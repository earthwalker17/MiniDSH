# The protocol, by example

`minidsh serve` speaks JSON-RPC 2.0 on stdin and stdout. `minidsh web` serves the same frames on a WebSocket. This page is for someone writing a client. Every shape is taken from [`frames.ts`](frames.ts), [`host.ts`](host.ts) or a recorded session log. `…` marks a value or fields left out.

## Frames

On stdio a frame is one line of compact JSON ended by `\n` ([`transport-ndjson.ts`](transport-ndjson.ts)). Unparseable lines are skipped. Stdout carries frames only, and the host logs to stderr. On the WebSocket, at path `/ws`, a frame is one text message ([`transport-ws.ts`](transport-ws.ts)). The upgrade needs the cookie set by opening the URL `minidsh web` prints ([`web.ts`](../../app/web.ts)).

- **Request**, client to host: `id` (number or string), `method`, optional `params`. A frame without an `id` is ignored.
- **Response**: the same `id` with `result`, or with `error` holding `code` and `message`. `-32601` is an unknown method, `-32602` the caller's mistake, `-32603` the host's failure.
- **Notification**, host to client: `method` and `params`, no `id`. The methods are `session.event`, `session.status`, `session.view`, `control.summary` and `settings.changed`.

There is no version negotiation. Skip event types and notification methods you do not know.

## A minimal session

The handshake. Its result also lists providers, defaults, workspaces, tools and presets.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"minidsh","version":"…"},…}}
```

A prompt with no `sessionId` creates a session. With one, it reaches a live session or resumes a stored one.

```json
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"text":"Fix slug.js"}}
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"session-a4a1…","messageId":"msg-8ded…"}}
```

Notifications follow. A `session.event` carries one log event verbatim, and `seq` orders them. A connection that has attached to nothing receives every session's frames (a child mid-delegation excepted).

```json
{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"session-a4a1…","status":"running"}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"session-a4a1…","event":{"type":"user/message","seq":9,"time":1795049290082,"data":{"message":{"id":"msg-8ded…","role":"user","content":[{"type":"text","text":"Fix slug.js"}],"source":{"kind":"user"}}},"surfaceOp":{"op":"append"}}}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"session-a4a1…","event":{"type":"turn/end","seq":1777,"time":1795049326764,"data":{"turn":1,"reason":{"kind":"completed"}}}}}
{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"session-a4a1…","status":"idle"}}
```

Other kinds arrive in between: `turn/start`, `assistant/chunk` (streamed text, the one kind a slow WebSocket may drop), `assistant/message`, `tool/call`, `tool/result`. The turn is over at `turn/end`, whose `reason.kind` is `completed`, `blocked`, `cancelled`, `max-tokens`, `max-steps`, `interrupted` or `error`. Wait for `idle` before treating the log as flushed. To end `serve`, send `shutdown` or close its stdin.

## Answering an approval

An ask has no notification of its own. It is the `approval/asked` event, answered by its `id`.

```json
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"session-a4a1…","event":{"type":"approval/asked","seq":745,"time":1795049298571,"data":{"id":"approval-745","toolName":"pwsh","callId":"call_00_…","reason":"…","subject":{"effect":"shell-command","command":"npm test","mode":"danger-full-access","enforcement":"none"}}}}}
{"jsonrpc":"2.0","id":3,"method":"approval/answer","params":{"sessionId":"session-a4a1…","id":"approval-745","outcome":"allowed-once"}}
{"jsonrpc":"2.0","id":3,"result":{"outcome":"accepted"}}
```

`outcome` is `allowed-once` or `rejected`. The result is `accepted`, or `not-pending` when another client answered first or nothing is waiting. The decision then arrives as an `approval/decided` event, whose `outcome` may also be `cancelled` or `unavailable`. `subject` is the runtime's account of the call and `reason` is the model's.

## Where to read more

- [`frames.ts`](frames.ts) has every params and result type. `dispatch` in [`host.ts`](host.ts) is the method table.
- [`protocol.test.ts`](protocol.test.ts) drives the wire over an in-memory stream pair.
- [`serve-process.ts`](../../test-support/serve-process.ts) is a small client for a spawned `minidsh serve`. [`live.e2e.test.ts`](../../app/live.e2e.test.ts) uses it end to end.
- [ARCHITECTURE section 8](../../../docs/ARCHITECTURE.md#8-surfaces) has one rule per method. Read it before calling `session/attach`: the first attach narrows what a connection receives.
