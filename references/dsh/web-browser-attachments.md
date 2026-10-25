# DSH reference: Web tools, browser use, attachments

> Where to research DSH's web tools, browser and computer use, and attachments ([reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, dsh-v0.2.1-rc.3); checked 2026-10-25 (S20.5). Browser code unchanged since `687f282e`.

## What exists (at the pin)

| Component | Path | Status | Purpose |
|---|---|---|---|
| `ctx.web` seam | `packages/web/web` | default-mounted | Search and fetch registries; provider from config or `DSH_WEB_*_PROVIDER`; `searchReady`/`fetchReady` per chat route |
| `web_search`, `web_fetch` | `packages/web/tool-web` | presets `cordis`, `ptc`, `standard` | `{queries}` (≤ 4, merged, ≤ 8 sources, summaries ≤ 800 chars), `{url}`; rendered to PROSE; declared only on a step whose route has a credential (10-22) |
| HTTP fetch | `packages/web/web-fetch-http` | default-mounted, selected | Anonymous, same-origin redirects, caps; NO destination guard since 2026-10-20 |
| DeepSeek search | `packages/web/web-search-deepseek` | default-mounted, selected | One hidden Messages turn per search; Exa, Perplexity mounted by no composition |
| DeepSeek Search/Fetch APIs | `packages/web/web-deepseek-api` | default-mounted, unselected | `deepseek-search-api`, `deepseek-fetch-api`: one direct request to `/v1/tools/{search,fetch}`, behind a settings switch (10-17) |
| `ctx.attachments` + local store | `packages/attachment/attachment-local` | default-mounted | Home-global content-addressed normalized images and verbatim generic files |
| `ctx.fileUploads` | `packages/client/file-upload` | Web bundle | Streamed intake to a per-Session receipt; composer images upload when added (10-21) |
| MCP image bridge | `packages/mcp/mcp-client/src/tools.ts` | opt-in | MCP images to the store; no base64 in events |
| `ctx.browserUse`, `ctx.computerUse` | `packages/browser-use/browser-use`, `packages/computer-use/computer-use` | explicit composition | One provider-name slot each, no action API; Cua Driver MCP or native (`experimental/computer-use-cua-driver-*`) |
| Playwright, DevTools MCP, Stagehand | `packages/experimental/browser-use-*` | experimental | Pinned MCP servers (`mcp__<server>__<tool>`); six `stagehand_*` tools with their own model |
| CUA | `packages/experimental/{cua,cua-macos,cua-bundle}` | experimental bundle, off | macOS only: one `cua` tool and app/window objects, for `ptc` Agents by default |

## Open for the route

- **Any network tool, fetch is unguarded.** Since 2026-10-20 `web_fetch` takes the process proxy policy and the system resolver and reaches loopback, private and metadata hosts; `HttpFetchResolver` is gone. Upstream's remedy: confine the network, a `tools/pre-execute` policy, or no fetch tool. Oracle: `snapshots/session/web-fetch`. `docs/upgrade-guide/v0.2.1-rc.2/web-fetch-private-destinations/guide.md`, `packages/web/web-fetch-http/src/provider.ts`
- **Any network tool, authority.** No approval, mode or policy gates web tools, no backend confines the network (bwrap `--unshare-pid` only, Seatbelt `allow default`); only a missing credential withholds one. `docs/subsystems/web.md`, `packages/sandbox/sandbox-local/src/profiles.ts`
- **Any network tool, the record.** `tool/result` holds the rendered text plus `meta` (`{sources, truncated, answer?}`); Messages search logs `web/deepseek-search-llm-request` first, the Search API nothing; base spills over 12,500 tokens. `docs/persistence-catalog.md`, `packages/web/web-deepseek-api/README.md`
- **S21, parallel calls.** Both web tools declare `isConcurrencySafe: () => true`, a multi-query search runs concurrently; one Session's browser operations share one queue; computer use reserves no desktop and serializes nothing. `packages/web/tool-web/src/search.ts`, `packages/experimental/browser-use-runtime/README.md`, `docs/subsystems/computer-use.md`
- **S21, lifetime.** Browser resources key on the live Agent, fresh after reload or fork, never restored; MCP providers start in serial `agent/created`, Stagehand at its first call; CUA holds one connection per Agent. `packages/experimental/browser-use-runtime/src/{index,mcp}.ts`, `packages/experimental/cua/README.md`
- **Browser authority (S20's divergence).** Stagehand runs Chrome with `--remote-debugging-port=0`, `--remote-allow-origins=*`, `--enable-unsafe-extension-debugging`, a temp profile, a scrubbed env, its model outside DSH accounting; the MCP servers run `--isolated` (Playwright's `PLAYWRIGHT_MCP_*` blanked) or attach to a configured endpoint. No origin, proxy, resolver, download or `file:` rule, no mode or approval check; both spawn paths bypass `ctx.subprocess`. `packages/experimental/browser-use-stagehand-native/src/launch.ts`, `browser-use-{playwright,chrome-devtools}-mcp/src/index.ts`
- **Computer-use authority.** CUA asks per application (User Questions) before launch, observation, capture or input, apart from tool approval; session grants live in memory, saved ones need a platform-verified executable. A screenshot without an image route REJECTS the call; an MCP image gets a non-error diagnostic. `packages/experimental/cua/README.md`, `packages/mcp/mcp-client/src/tools.ts`
- **S22, uploads.** The digest addresses the NORMALIZED image, not the uploaded bytes; a generic file is verbatim and reaches the model as one path line; admission limits: 50 MiB an image, 20 and 200 MiB a message, 64 MP, 65,535 px a side (2026-10-21). `packages/attachment/attachment-local/README.md`, `packages/client/file-upload/README.md`
- **S22, image budget.** Past a route's image budget the oldest images become path text, permanently, and the request retries. `packages/compaction/compaction-image-offload/README.md`
- **S22, tool KIND.** A tool names its own display kind in `presentCall` from a closed `ToolCallKind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `fetch`, `other`); `web_search` is `search`, `web_fetch` `fetch`. `packages/core/tools/src/presentation.ts`

## Sources

| Path | What it establishes | Checked |
|---|---|---|
| `packages/bundle/{base,web-app}/cordis.patch.yml`, `web-app/presets/*` | Web rows, presets, store, spill, image offload | 2026-10-25 |
| `docs/subsystems/web.md`, `packages/web/web/{src/index.ts,tests/web.spec.ts}` | Selection, readiness, the network-policy statement | 2026-10-25 |
| `packages/web/tool-web/{src,tests}/*` | Schemas, limits, rendering, `meta`, activation | 2026-10-25 |
| `packages/web/{web-fetch-http,web-search-deepseek,web-deepseek-api}/README.md` | No guard; Messages search; the Search and Fetch APIs | 2026-10-25 |
| `docs/subsystems/attachment.md`, `packages/attachment/*/README.md` | Persist-before-event, ids, generic files, limits | 2026-10-25 |
| `docs/subsystems/{browser-use,computer-use}.md`, `packages/experimental/browser-use-*/src/*` | Slots, per-Agent resources, launch flags | 2026-10-25 |
| `packages/experimental/{cua,cua-bundle,computer-use-cua-driver-*}/README.md`, `docs/upgrade-guide/v0.2.1-rc.2/cua-*` | CUA consent, `agentPreset: ptc`, 0–999 relative coordinates | 2026-10-25 |

## Likely to go stale

- The web family moves fast: Search API (10-17), guard dropped (10-20), readiness (10-22); `web.md` still names a dead "Code" preset.
- `web-search-deepseek` still defaults to `deepseek-v4-flash`, a name DeepSeek routes only temporarily.
- Browser use stays experimental and unbundled (`a3480857`, 2026-09-24); CUA leaves `experimental` with a Windows provider.
- "Never deleted" and unlimited generic files are deferred; every limit is a deployment default.

## Not read

- The `snapshots/session/{cua-*,computer-use-*}` oracles (outside the snapshot); `packages/experimental/cua-macos` native code.
