# DSH reference: Web tools, browser use, attachments

> Where to research DSH's web tools, browser use and attachments ([reading rules](../README.md)). Web rows pinned to `deepseek-ai/deepseek-harness@86a40220` (master, 2026-10-15, dsh-0.2.1-alpha.4), checked 2026-10-16 (S18); browser, computer use and attachment rows still at `477b4f42` (2026-09-24), checked 2026-09-26.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.web` seam | `packages/web/web` | default-mounted | Search and fetch registries; provider from config or `DSH_WEB_*_PROVIDER` |
| `web_search`, `web_fetch` | `packages/web/tool-web` | every preset but `minimal` | `{queries}` (≤ 4, merged, ≤ 8 sources), `{url}`; rendered to PROSE |
| HTTP fetch backend | `packages/web/web-fetch-http` | default-mounted | Anonymous fetch behind an SSRF guard; text only, PDF deferred |
| DeepSeek search | `packages/web/web-search-deepseek` | default-mounted | One Messages turn per search; Exa, Perplexity mounted by no composition |
| `ctx.attachments` + local store | `packages/attachment/attachment-local` | default-mounted | Home-global content-addressed images and files |
| `ctx.fileUploads` | `packages/client/file-upload` | Web bundle | Streamed intake, staged receipts |
| MCP image bridge | `packages/mcp/mcp-client/src/tools.ts` | opt-in | MCP images to the store; no base64 in events |
| `ctx.browserUse` | `packages/browser-use/browser-use` | explicit composition | One provider-name slot, no action API |
| `ctx.computerUse` | `packages/computer-use/computer-use` | explicit composition | The desktop twin; Cua Driver MCP or native, experimental |
| Playwright, Chrome DevTools MCP | `packages/experimental/browser-use-playwright-mcp`, `-chrome-devtools-mcp` | experimental | Pinned upstream MCP servers; `mcp__<server>__<tool>` names |
| Stagehand native | `packages/experimental/browser-use-stagehand-native` | experimental | Six `stagehand_*` tools over CDP; own model |
| Browser runtime library | `packages/experimental/browser-use-runtime` | experimental | Per-live-Agent resources, per-Session queue |

## Open for the route

- **Any network tool, the fetch guard.** Resolve once, reject the WHOLE answer set if any address is non-public (ipaddr.js 2.5.0 `range() === 'unicast'`, plus an RFC 7050 `ipv4only.arpa` probe for DNS64 prefixes), pin each request through its own undici `Agent` with a `connect.lookup` serving only the validated set, repeat per same-origin redirect (≤ 5), refuse a cross-origin one. A PROXIED hop skips resolution and pinning entirely; only a non-public IP literal is still refused. Oracle: `snapshots/session/web-fetch` (bypasses the guard with an injected resolver). `packages/web/web-fetch-http/src/{policy,network,provider}.ts`
- **Any network tool, authority.** No approval, sandbox mode or network policy gates web tools ("every sandbox and approval mode without per-call confirmation"); no backend confines the network (bwrap `--unshare-pid` only, Seatbelt `allow default`, Windows ACL leaves network alone); only experimental auto-review would see a call. `docs/subsystems/web.md`, `packages/sandbox/sandbox-local/src/profiles.ts`
- **Any network tool, the record.** `tool/result` stores the rendered text plus `meta` (`{sources, truncated, answer?}`); DeepSeek search writes a log-only `web/deepseek-search-llm-request` before its hidden turn; base spills a result over 12,500 tokens (`spill-policy`). `docs/persistence-catalog.md`, `packages/bundle/base/cordis.patch.yml`
- **S20, lifetime.** Resources key on the live Agent, not the Session: fresh after reload or fork, never restored from the log; startup runs inside serial `agent/created`, a failure rolling creation back. `packages/experimental/browser-use-runtime/README.md`
- **S20, screenshots.** An image block is admitted only after exact route-capability proof, else bounded diagnostic text; base64 never enters a session event. `packages/mcp/mcp-client/README.md`
- **S20, authority.** Endpoint, mode, profile and native model are composition config, never tool arguments; Stagehand scrubs Chromium's environment but runs its model outside request capture and accounting. `packages/experimental/browser-use-stagehand-native/README.md`
- **S21, parallel calls.** One Session's browser operations serialize through one queue; `tool-web` declares `isConcurrencySafe: () => true`. `packages/experimental/browser-use-runtime/README.md`
- **S22, uploads.** The digest addresses the NORMALIZED image, not the uploaded bytes; a generic file is verbatim: decide what MiniDSH's addresses. `packages/attachment/attachment-local/README.md`
- **S22, image budget.** Over a route's image budget, the oldest images become text naming a read-only path, permanently, and the request retries. `packages/compaction/compaction-image-offload/README.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` | Default web rows (`deepseek-official` search, `http` fetch), store, spill, image offload | 2026-10-16 |
| `docs/subsystems/web.md` | Selection, the no-confirmation statement | 2026-10-16 |
| `packages/web/tool-web/src/{index,search,fetch,trust}.ts` | Schemas, limits, the fixed notice, the guidance text | 2026-10-16 |
| `packages/web/web-fetch-http/src/*`, `packages/util/http-proxy/README.md` | SSRF guard, pinning, redirects, caps, the proxy path | 2026-10-16 |
| `packages/web/web-search-{deepseek,exa,perplexity}/README.md` | Backends; Perplexity passes its answer through as `content` | 2026-10-16 |
| `docs/subsystems/attachment.md`, `packages/attachment/attachment/src/types.ts` | Attachment and upload API, persist-before-event; `ImageAttachmentRef`, `FileAttachmentRef` | 2026-09-26 |
| `docs/subsystems/browser-use.md`, `docs/subsystems/computer-use.md` | Registration-only APIs, ownership | 2026-09-26 |
| `packages/experimental/browser-use-stagehand-native/README.md`, `browser-use-playwright-mcp/README.md` | Native model, env scrub, accounting gap; launch or attach, screenshots as attachments | 2026-09-26 |

## Likely to go stale

- The web family is quiet: since 2026-09-24 only `web-search-deepseek` changed (account-token auth, 09-25); `web.md` and the `tool-web` README still name a "Code" preset that no longer exists.
- `web-search-deepseek` still defaults to `deepseek-v4-flash`, a name DeepSeek routes only temporarily; its own live probe is `it.skip` (the endpoint can answer without structured source blocks).
- Browser and computer use are experimental: a fourth provider, Stagehand accounting, or a bundle are plausible.
- "Never deleted", unlimited generic files and image-only MCP results are deferred; every limit is a deployment default.

## Not read

- `docs/config-catalog.md` web rows; `packages/web/web/tests/web.spec.ts`; the bodies of `tool-web/tests/{tool-web,integration}.spec.ts`; the two Cua Driver provider READMEs.
- The recorded oracles `snapshots/session/browser-use-*`, `computer-use-*`, `read-image-*`.
- A vision verifier: `packages/experimental/auto-review` (an optional bundle) and `packages/subagent`.
- A browser download policy or network allowlist: only environment scrubbing found in READMEs; code unverified.
