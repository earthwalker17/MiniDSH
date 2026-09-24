# DSH reference: Web tools, browser use, attachments

> A map: verify against the current repository before relying on a line ([reading rules](../README.md)). Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17); checked 2026-09-19.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.web` seam | `packages/web/web` | default-mounted | Search and fetch registries; picked at execution |
| `web_search`, `web_fetch` | `packages/web/tool-web` | default-mounted | Schemas, bounds, markdown; untrusted notice in `src/trust.ts` |
| HTTP fetch backend | `packages/web/web-fetch-http` | default-mounted | Anonymous fetch behind an SSRF guard |
| DeepSeek search | `packages/web/web-search-deepseek` | default-mounted | One auxiliary model turn per search; Exa, Perplexity opt-in |
| `ctx.attachments` + local store | `packages/attachment/attachment-local` | default-mounted | Home-global content-addressed store |
| MCP image bridge | `packages/mcp/mcp-client/src/tools.ts` | opt-in | Only path from MCP screenshots to attachments |
| `ctx.browserUse` | `packages/browser-use/browser-use` | opt-in | One provider-name slot, no action API |
| Playwright, Chrome DevTools MCP | `packages/experimental/browser-use-playwright-mcp` | experimental | Pinned upstream MCP server; catalog passed through |
| Stagehand native | `packages/experimental/browser-use-stagehand-native` | experimental | Six `stagehand_*` tools over CDP; its own model |
| Browser runtime library | `packages/experimental/browser-use-runtime` | experimental | Per-live-Agent resources, per-Session queue |

## Open for the route

- **S16, verify and salvage.** Objects live outside the session directory, fsynced and hard-link-published BEFORE their event; reads re-verify the digest. A crash leaves an orphan, never a dangling ref. `packages/attachment/attachment-local/README.md`
- **S18, search registration.** Tools register from config enablement, so a missing backend is a structured error result and the tool prefix never moves. `docs/subsystems/web.md`
- **S18, search results.** Sources come only from structured blocks, never provider prose; a log-only `web/deepseek-search-llm-request` precedes the hidden model turn. `packages/web/web-search-deepseek/README.md`
- **S18, fetch guard.** Resolve, reject the WHOLE answer set if any address is non-public, pin, repeat per same-origin redirect; a cross-origin redirect needs a new call. `packages/web/web-fetch-http/README.md`
- **S20, lifetime.** Resources key on the live Agent, not the Session: fresh after reload or fork, never restored from the log; startup runs inside serial `agent/created`, a failure rolling creation back. `packages/experimental/browser-use-runtime/README.md`
- **S20, screenshots.** An image block is admitted only after exact route-capability proof, else bounded diagnostic text; base64 never enters a session event. `packages/mcp/mcp-client/README.md`
- **S20, authority.** Endpoint, mode, profile and native model are composition config, never tool arguments; Stagehand scrubs Chromium's environment but runs its model outside request capture and accounting. `packages/experimental/browser-use-stagehand-native/README.md`
- **S21, parallel calls.** One Session's browser operations serialize through one queue. `packages/experimental/browser-use-runtime/README.md`
- **S22, uploads.** The digest addresses the NORMALIZED image, not the uploaded bytes: decide what MiniDSH's addresses. `packages/attachment/attachment-local/README.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/bundle/base/cordis.patch.yml` | Default rows, image offload (`packages/compaction/compaction-image-offload`); no browser, `mcp-client` | 2026-09-19 |
| `packages/bundle/web-app/cordis.patch.yml` | Upload staging row (`packages/client/file-upload`, S22); store in base | 2026-09-19 |
| `packages/preset/agent-presets/presets/standard/agent.cordis.yml` | `tool-web` row; `minimal` has none | 2026-09-19 |
| `docs/subsystems/web.md` | Selection, fetch policy, no-approval statement | 2026-09-19 |
| `packages/web/tool-web/README.md` | Tool contracts, query merge | 2026-09-19 |
| `packages/web/web-fetch-http/README.md` | SSRF guard, pinning, redirects, caps | 2026-09-19 |
| `packages/web/web-search-deepseek/README.md` | Messages-call search, log-only event | 2026-09-19 |
| `docs/subsystems/attachment.md` | Attachment and upload API | 2026-09-19 |
| `packages/attachment/attachment/src/types.ts` | `ImageAttachmentRef`, `FileAttachmentRef` | 2026-09-19 |
| `packages/attachment/attachment-local/README.md` | Disk layout, fsync chain, retention | 2026-09-19 |
| `packages/mcp/mcp-client/README.md` | Image admission; local namespaces | 2026-09-19 |
| `docs/subsystems/browser-use.md` | Registration-only API, ownership | 2026-09-19 |
| `packages/experimental/browser-use-runtime/README.md` | Live-Agent keying, queue, cleanup | 2026-09-19 |
| `packages/experimental/browser-use-stagehand-native/README.md` | Native model, env scrub, accounting gap | 2026-09-19 |
| `.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.md` | Why no unified browser API | 2026-09-19 |

## Likely to go stale

- Browser use landed 2026-09-12: promotion, removal, new providers, Stagehand's deferred accounting are likely soon.
- Search defaults (`deepseek-official`, `deepseek-v4-flash`, the Anthropic-compatible endpoint); the README expects a retrieval endpoint.
- No-approval `web_fetch` is a security default; `docs/subsystems/web.md` names a "Code" preset the presets directory (cordis, minimal, ptc, standard) lacks.
- "Never deleted", unlimited generic files and image-only MCP results are deferred; every numeric limit is a deployment default.

## Not read

- `packages/experimental/browser-use-chrome-devtools-mcp`, `packages/web/web-search-exa`, `packages/web/web-search-perplexity`.
- Computer use (`docs/subsystems/computer-use.md`): reportedly a registration-only desktop twin of the browser seam.
- `packages/document/office-to-pdf`: does conversion feed attachments?
- A vision subagent or verifier in `packages/subagent` or `packages/experimental/auto-review`.
- The ptc and cordis presets' `tool-web` rows (researcher's claim); what the Web app bundle disables.
- `packages/client/file-upload/src/index.ts`; `src` files beyond `trust.ts`, `types.ts` (a researcher's only).
- The exact image diagnostic and file handle line.
- A browser download policy or network allowlist: absence unverified in code.
- `snapshots/session/browser-use-playwright-mcp`, `snapshots/session/read-image-text-route` (recorded oracles).
