# DSH reference: LLM seam and providers

> Where to research DSH's LLM seam and adapters ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@2e39e704` (master, 2026-11-18, dsh-v0.2.2-rc.5); checked 2026-11-21 (S22.5).

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| `dsh-llm` (`ctx.llm`) | `packages/llm/llm` | default-mounted | adapter registry, chunks, a closed failure-code set; `purpose` (producer-declared) is only model-hidden transport metadata; no wire, no retries |
| `dsh-llm-deepseek` | `packages/llm/llm-deepseek` | library | the Messages transport (`/anthropic`, `/v1/messages`, images via `/v1/files`); the built-in catalog `deepseek-flash` (text+image) and `deepseek-v4-pro` (text), both 1,048,576; the shared `/models` listing; a `refusal` stop fails `CONTENT_REFUSED`, unretried |
| `dsh-deepseek-auth` (`ctx.deepseekAuth`) | `packages/account/deepseek-auth` | default-mounted (rc.3) | releases the API key or the account sign-in for ONE request, only to its route's origin; the key check moved to `dsh-credentials` |
| `dsh-llm-deepseek-api-key` | `packages/llm/llm-deepseek-api-key` | default-mounted (entry `llm-deepseek`) | `deepseek-official`, `x-api-key`; FOLLOWS the official listing while `models` equals the built-in catalog on `api.deepseek.com`, else serves `models` |
| `dsh-llm-deepseek-account` | `packages/llm/llm-deepseek-account` | default-mounted | `deepseek-account`, `x-dsh-auth-token`; a listing per token, `modelOverrides` only; a sign-out revokes in-flight requests |
| `dsh-llm-pi-ai` | `packages/llm/llm-pi-ai` | default-mounted, dormant | pi-ai `1.3.0`, patched; routes only from settings; an undescribed model gets 1,000,000 / 128,000 |
| `dsh-llm-retry` | `packages/llm/llm-retry` | default-mounted | retry on `agent/request-error` inside the same open turn; a direct `ctx.llm.stream()` is single-attempt |
| `dsh-token-meter` | `packages/llm/token-meter` | default-mounted | context pressure replayed from the log |
| request extensions | `packages/llm/{deepseek-llm-api-extensions,plugin-package-inventory-deepseek}`, `packages/session/session-log-deepseek` | default-mounted | `dsh_plugin_packages`; `dsh_session_log`: the log past the last accepted watermark, ≤ 8 MiB a request |
| session route | `packages/core/agent` (`agent.model`) | core | log-only `model/selection`, applied from the next step, kept on resume; separate from the deployment default (`packages/core/agent-default-model`: `deepseek-official`/`deepseek-flash`) |
| subagent route selection | `packages/subagent/tool-subagent/src/model-selection.ts` | off by default | a per-delegation route from a user allowlist, read at each call (rc.3) |

No first-party OpenAI or Anthropic adapter (pi-ai reaches both); no role seam; no safety-check request field.

## Open for the route

- **What a session presents to a provider (BLUEPRINT §3).** Headers `x-deepseek-harness-user-id` (anonymous, per home), `-session-id`, `-compact: 1`; `user-agent` names the booted profile (11-10); by default the whole session log as `dsh_session_log`, to a `baseURL` gateway too. `docs/deepseek-llm-api-wire-extensions.md`
- **A document input kind (BLUEPRINT §3).** `FileBlock` is durable user content no provider receives: request assembly projects each to a handle line (name, size, read-only saved path); `/v1/files` carries images only. `packages/llm/llm/src/types.ts`
- **An egress provider (BLUEPRINT §3).** No shared egress upstream: the adapter calls raw `fetch` with no proxy or interception seam and rejects redirects. `packages/llm/llm-deepseek/README.md` (Known limitations)
- **Detached children (BLUEPRINT §3).** A child starts on the parent's latest `request/header` route and drops an inherited effort when its route changes; another route needs the Host allowlist, read live, no longer the per-session `subagent/model-selection-policy` snapshot. `packages/subagent/subagent/src/child-agent.ts`
- **Any provider session, the Responses oracle.** pi-ai 1.3.0 sends `store:false`, `include:['reasoning.encrypted_content']` and `prompt_cache_key` = the clamped session id; another model's thinking is dropped, Anthropic signed thinking too once its prefix changed (`prefixDigest`). `unpkg.com/@earendil-works/pi-ai@1.3.0/dist/api/{openai-responses,transform-messages}.js`
- **Any catalog session, the live listing.** Both DeepSeek routes follow `GET /models` (≤ 5 s first wait, a 600 s refresh even idle since rc.4, the last good listing kept), refuse an unservable model before I/O and ignore listed efforts; an unlisted id passes text-only with 1,000,000 / 256,000 and all four efforts. `packages/llm/llm-deepseek/src/{listing,listed-catalog,model-info}.ts`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `packages/llm/README.md`, `packages/llm/llm/{README.md,src/types.ts}` | the packages; `purpose`, `sessionId`, `FileBlock` | 2026-11-21 |
| `packages/core/{agent,agent-default-model}/README.md` | `agent.model`, `model/selection`; the default | 2026-11-21 |
| `packages/llm/llm-deepseek/README.md`, `src/{models,defaults,model-info,listing,listed-catalog,translate}.ts` | transport, built-in catalog, unknown ids, the listing, `refusal` | 2026-11-21 |
| `packages/llm/llm-deepseek-{api-key,account}/README.md`, `packages/account/deepseek-auth/README.md` | which route follows which listing; gating; who releases a credential | 2026-11-21 |
| `docs/upgrade-guide/v0.2.2-rc.3/{deepseek-request-auth,deepseek-refusal-code,subagent-model-selection-live-setting}`, `v0.2.1-rc.4/model-listing-refresh`, `v0.2.2-alpha.2/llm-{error-builtin-codes,request-purpose-declarations}` | what changed since `22ddee37` | 2026-11-21 |
| `packages/llm/llm-pi-ai/{README.md,package.json,src/adapter.ts}`, `pnpm-workspace.yaml` | pi-ai pinned and patched at 1.3.0; replay, defaults, the session id | 2026-11-21 |
| `docs/deepseek-llm-api-wire-extensions.md`, `packages/session/session-log-deepseek/README.md` | headers, log upload, exclusions, watermark | 2026-11-21 |
| `packages/llm/{llm-retry,token-meter}/README.md` | `llm/retry` before the wait, then `llm/retry-started`; the meter | 2026-11-21 |
| `packages/bundle/{base,sdk-minimal,acp-app}/cordis.patch.yml` | default rows, dormant pi-ai, `deepseek-auth`, acp's `deepseek-v4-flash` | 2026-11-21 |

## Likely to go stale

- pi-ai: pinned at 1.3.0 since 10-17 while npm `latest` is 1.6.0 (11-20); a bump reopens ids, protocols, replay and `patches/@earendil-works__pi-ai@1.3.0.patch`.
- `safety_check` was added, made unconditional and removed on 2026-11-16 (`f250e232`, `15762ffc`, `e68c0334`); only `CONTENT_REFUSED` stayed.
- `ctx.deepseekAuth` dates from 2026-11-15 and is still moving.
- A `models` list saved from an older built-in catalog stops following the listing.
- `deepseek-v4-flash` residue: the `acp-app`, `web-search-deepseek`, `subagent-dsh-sdk` and `sdk/client` defaults; since rc.4 a search on a DeepSeek route is an auxiliary Messages request on it (`docs/upgrade-guide/v0.2.2-rc.4/web-search-deepseek-model-default`).
- `agent-default-model/README.md` still shows `provider: deepseek`, `model: deepseek-chat`.
- `docs/subsystems/llm-streaming.md` says a retry "opens another durable numbered turn"; the retry README says the same open turn (unreconciled).

## Not read

- pi-ai 1.4.0 to 1.6.0; `packages/llm/llm-pi-ai/src/{auth,login,prefix-binding}.ts` (README only).
- `packages/llm/llm-deepseek/src/{adapter,config,file-store,serialize}.ts` beyond a search; `docs/user/guide/providers.md`; the `deepseek-auth` decision note under `.agents/notes`.
