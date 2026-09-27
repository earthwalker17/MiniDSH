# DSH reference: Web tools, browser use, attachments

> A map: verify against the current repository before relying on a line ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2); checked 2026-09-26.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.web` seam | `packages/web/web` | default-mounted | Search and fetch registries; picked at execution |
| `web_search`, `web_fetch` | `packages/web/tool-web` | every preset but `minimal` | Schemas (4 queries, 8 sources), markdown; untrusted-data guidance |
| HTTP fetch backend | `packages/web/web-fetch-http` | default-mounted | Anonymous fetch behind an SSRF guard; text only, PDF deferred |
| DeepSeek search | `packages/web/web-search-deepseek` | default-mounted | One Messages-API turn per search; Exa, Perplexity opt-in |
| `ctx.attachments` + local store | `packages/attachment/attachment-local` | default-mounted | Home-global content-addressed images and files |
| `ctx.fileUploads` | `packages/client/file-upload` | Web bundle | Streamed intake, staged receipts |
| Image offload | `packages/compaction/compaction-image-offload` | default-mounted | Over-budget images become text handles, then retry |
| MCP image bridge | `packages/mcp/mcp-client/src/tools.ts` | opt-in | MCP images to the store; no base64 in events |
| `ctx.browserUse` | `packages/browser-use/browser-use` | explicit composition | One provider-name slot, no action API |
| `ctx.computerUse` | `packages/computer-use/computer-use` | explicit composition | The desktop twin; Cua Driver MCP or native, experimental |
| Playwright, Chrome DevTools MCP | `packages/experimental/browser-use-playwright-mcp`, `-chrome-devtools-mcp` | experimental | Pinned upstream MCP servers; `mcp__<server>__<tool>` names |
| Stagehand native | `packages/experimental/browser-use-stagehand-native` | experimental | Six `stagehand_*` tools over CDP; own model |
| Browser runtime library | `packages/experimental/browser-use-runtime` | experimental | Per-live-Agent resources, per-Session queue |

## Open for the route

- **S18, search registration.** Tools register from config enablement, so a missing backend is a structured error result and the tool prefix never moves; the Web app disables the host `tool-web` row so presets own it. `docs/subsystems/web.md`
- **S18, search results.** Sources come only from structured blocks, never provider prose; a log-only `web/deepseek-search-llm-request` precedes the hidden model turn. Oracle: `snapshots/session/web-search-endpoint-guidance`. `packages/web/web-search-deepseek/README.md`
- **S18, fetch guard.** Resolve once, reject the WHOLE answer set if any address is non-public (DNS64 prefixes included), pin, repeat per same-origin redirect; a cross-origin redirect needs a new call; only textual content decodes. Oracle: `snapshots/session/web-fetch`. `packages/web/web-fetch-http/README.md`
- **S20, lifetime.** Resources key on the live Agent, not the Session: fresh after reload or fork, never restored from the log; startup runs inside serial `agent/created`, a failure rolling creation back. `packages/experimental/browser-use-runtime/README.md`
- **S20, screenshots.** An image block is admitted only after exact route-capability proof, else bounded diagnostic text; base64 never enters a session event. `packages/mcp/mcp-client/README.md`
- **S20, authority.** Endpoint, mode, profile and native model are composition config, never tool arguments; Stagehand scrubs Chromium's environment but runs its model outside request capture and accounting. `packages/experimental/browser-use-stagehand-native/README.md`
- **S21, parallel calls.** One Session's browser operations serialize through one queue. `packages/experimental/browser-use-runtime/README.md`
- **S22, uploads.** The digest addresses the NORMALIZED image, not the uploaded bytes; a generic file is verbatim: decide what MiniDSH's addresses. `packages/attachment/attachment-local/README.md`
- **S22, image budget.** Over a route's image budget, the oldest images become text naming a read-only path, permanently, and the request retries. `packages/compaction/compaction-image-offload/README.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | Default web rows, store, image offload; no browser, no `mcp-client`; upload row, host `tool-web` off | 2026-09-26 |
| `docs/subsystems/web.md` | Selection, fetch policy, no-approval statement | 2026-09-26 |
| `packages/web/tool-web/README.md` | Tool contracts, query merge, guidance | 2026-09-26 |
| `packages/web/web-fetch-http/README.md` | SSRF guard, pinning, redirects, caps | 2026-09-26 |
| `packages/web/web-search-deepseek/README.md` | Messages-call search, log-only event | 2026-09-26 |
| `docs/subsystems/attachment.md`, `packages/attachment/attachment/src/types.ts` | Attachment and upload API, persist-before-event; `ImageAttachmentRef`, `FileAttachmentRef` | 2026-09-26 |
| `packages/attachment/attachment-local/README.md` | Disk layout, fsync chain, hard-link publish, retention | 2026-09-26 |
| `packages/mcp/mcp-client/README.md` | Image admission; local namespaces | 2026-09-26 |
| `docs/subsystems/browser-use.md`, `docs/subsystems/computer-use.md` | Registration-only APIs, ownership | 2026-09-26 |
| `packages/experimental/browser-use-runtime/README.md` | Live-Agent keying, queue, cleanup | 2026-09-26 |
| `packages/experimental/browser-use-stagehand-native/README.md`, `browser-use-playwright-mcp/README.md` | Native model, env scrub, accounting gap; launch or attach, screenshots as attachments | 2026-09-26 |

## Likely to go stale

- Since 2026-09-17: tool text and images retained within a token budget (09-21, `mcp-client`, `tool-web`); the runtime library shares one scope and MCP client per installation (09-18). `packages/attachment` had no commit.
- Browser and computer use are twelve days old and experimental: a fourth provider, Stagehand accounting, or a bundle are plausible.
- `docs/subsystems/web.md` still names a "Code" preset that no longer exists.
- "Never deleted", unlimited generic files and image-only MCP results are deferred; every limit is a deployment default.

## Not read

- `packages/web/web-search-exa`, `web-search-perplexity` beyond their summaries; the two Cua Driver provider READMEs.
- The recorded oracles' contents (`snapshots/session/browser-use-*`, `computer-use-*`, `web-fetch`, `read-image-*`).
- A vision verifier: `packages/experimental/auto-review` (now an optional bundle) and `packages/subagent`.
- A browser download policy or network allowlist: only environment scrubbing found in READMEs; code unverified.
