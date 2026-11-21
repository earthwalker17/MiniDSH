# DSH reference: Web tools, browser use, attachments

> Where to research DSH's web tools, browser and computer use, and attachments ([reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, `dsh-v0.2.2-rc.5`); re-researched whole in S22.5, 2026-11-21.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.web` seam | `packages/web/web` | default-mounted | Search and fetch registries; a pinned id (config or `DSH_WEB_*_PROVIDER`), else search follows the model route; `searchReady`/`fetchReady` |
| `web_search`, `web_fetch` | `packages/web/tool-web` | base; presets `cordis`, `ptc`, `standard` | `{queries}` (up to 10, merged round-robin, up to 10 sources, summaries to 800 chars), `{url}`; rendered to PROSE as untrusted content; declared only on a step whose route is ready |
| HTTP fetch | `packages/web/web-fetch-http` | default-mounted, selected | Anonymous, same-origin redirects, caps, coded transport failures (11-07); NO destination guard |
| Messages search | `packages/web/web-search-deepseek` | default-mounted | `deepseek-official`: one hidden Messages turn per search; preferred on DeepSeek model routes |
| Search and Fetch APIs | `packages/web/web-deepseek-api` | default-mounted | `deepseek-search-api` (search on every other route), `deepseek-fetch-api` (a settings choice): one direct request to `/v1/tools/{search,fetch}`; billing `auto\|account\|api-key` |
| `ctx.attachments` + local store | `packages/attachment/{attachment,attachment-local}` | default-mounted | Home-global content-addressed normalized images and verbatim generic files, fsynced before the event |
| `ctx.fileUploads` | `packages/client/file-upload` | Web bundle | Streamed intake to a per-Session receipt a later prompt cites |
| `read_image` | `packages/fs/tool-fs/src/read-image.ts` | every preset | A workspace image to the store, registered while one is mounted |
| image offload | `packages/compaction/compaction-image-offload` | default-mounted | Past a route's image budget the oldest images become path text, permanently (`image/offload`), and the request retries |
| MCP image bridge | `packages/mcp/mcp-client/src/tools.ts` | opt-in | MCP images to the store; no base64 in events |
| `ctx.browserUse`, `ctx.computerUse` | `packages/browser-use/browser-use`, `packages/computer-use/computer-use` | explicit composition | One provider-name slot each, no action API |
| Playwright, DevTools MCP, Stagehand | `packages/experimental/browser-use-*` | experimental, in no bundle | Pinned MCP servers; `stagehand_*` tools with their own model; `browser-use-runtime` gives each live Session its browser |
| CUA | `packages/experimental/{cua,cua-macos,cua-windows,cua-bundle}` | optional bundle, off | macOS and native Windows: raw `cua` for `ptc` Agents, `cua_run_code` for the rest |
| CUA as a server | `packages/experimental/cua-mcp` | optional bundle | `dsh --profile cua-mcp`: three tools to one MCP client, no model turn |
| sidebar browser | `packages/client/ui-sidebar-browser` | Desktop; Web opts in | A person's HTTP(S) tabs; no tool, prompt or event |

- **Authority.** No approval, mode or policy gates the web tools; only a missing credential withholds one. `docs/subsystems/web.md`
- **The record.** `tool/result` holds the rendered text plus presentation `meta` (`{sources, truncated, answer?}`); Messages search logs `web/deepseek-search-llm-request` first, the Search and Fetch APIs nothing. `packages/web/tool-web/src/search.ts`, `packages/web/web-deepseek-api/README.md`
- **Browser use is unfenced.** Stagehand starts Chrome on `--remote-debugging-port=0` with `--remote-allow-origins=*`; no network, download or `file:` rule. `packages/experimental/browser-use-stagehand-native/src/launch.ts`
- **Computer-use consent** is per application, before launch, observation, capture and input, apart from tool approval; a screenshot with no image route or configured target REJECTS the call. `packages/experimental/cua/README.md`

## Open for the route

- **`web_fetch`.** Still unguarded: the provider takes the process proxy policy and the system resolver, re-checks only scheme, credentials and length on each same-origin hop, and reaches loopback, private and metadata hosts. Upstream's remedy is network confinement, a `tools/pre-execute` policy, or no fetch tool. `packages/web/web-fetch-http/README.md`
- **An egress provider.** The one shared egress hop is a process-wide proxy policy over Node's `fetch` (LLM, search and HTTP MCP traffic, loopback direct): it routes, and neither fences nor records. `packages/util/http-proxy/README.md`
- **A document input kind.** A generic file is stored byte-for-byte with no type or size limit and reaches every route as one handle line (name, size, digest prefix, read-only path), never as bytes; nothing decodes a PDF. `packages/attachment/attachment/README.md`
- **Uploads.** The Host mints the receipt and keys it to the exact Session; a prompt cites receipts, so a client cannot cite an attachment it did not upload. An image receipt counts the upload's bytes against the per-message limit (20 images, 200 MiB; 50 MiB, 64 MP, 65,535 px a side each); the id addresses the NORMALIZED image; nothing is swept. `packages/client/file-upload/README.md`, `docs/subsystems/attachment.md`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/bundle/{base,web-app}/cordis.patch.yml`, `web-app/presets/*` | Web rows, per-preset `tool-web`, store, spill, image offload | 2026-11-21 |
| `docs/subsystems/web.md`, `packages/web/web/README.md` | Selection, readiness, the network-policy statement | 2026-11-21 |
| `packages/web/tool-web/{README.md,src/index.ts,src/search.ts}` | Limits, rendering, `meta`, activation | 2026-11-21 |
| `packages/web/{web-fetch-http,web-search-deepseek,web-deepseek-api}/README.md`, `web-fetch-http/src/{provider,policy}.ts` | No guard, in code; Messages search and its event; billing | 2026-11-21 |
| `docs/subsystems/attachment.md`, `packages/attachment/*/README.md` | Persist-before-event, ids, generic files, limits | 2026-11-21 |
| `docs/subsystems/{browser-use,computer-use}.md`, `packages/experimental/README.md` | Slots, per-Session resources, what is a bundle | 2026-11-21 |
| `packages/experimental/{cua,cua-bundle,cua-mcp,cua-windows}/README.md` | Consent, `cua_run_code`, the MCP profile | 2026-11-21 |
| `docs/persistence-catalog.md` | `web/deepseek-search-llm-request` and `image/offload` log-only; no CUA or upload event | 2026-11-21 |

## Likely to go stale

- The web family moves monthly (`docs/upgrade-guide/v0.2.2-*/web-*`): the Search API default without Exa or Perplexity (alpha.2), billing (rc.1), DeepSeek routes back on Messages search (rc.4). `web.md` still names a dead "Code" preset, and the base patch's comment still describes the fetch guard removed on 2026-10-20.
- `web-search-deepseek` still defaults to `deepseek-v4-flash`.
- Browser use stays experimental and unbundled; CUA gained Windows, a program tool and an MCP profile in four weeks, still under `experimental`.
- "Never deleted" and unlimited generic files are deferred, not decided; every image limit is a deployment default.

## Not read

- The `snapshots/session/{web-*,cua-*,computer-use-*,read-image-*}` oracles; `cua-macos` and `cua-windows` native code.
- `tool-web/src/fetch.ts`; the two MCP browser providers past their summaries; LiveShare's attachment uploads.
