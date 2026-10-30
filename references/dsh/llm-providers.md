# DSH reference: LLM seam and providers

> Where to research DSH's LLM seam and adapters ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@22ddee37` (master, 2026-10-23, dsh-v0.2.1-rc.3); checked 2026-10-25 (S20.5).

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| `dsh-llm` (`ctx.llm`) | `packages/llm/llm` | default-mounted | adapter registry, chunks, failure codes; `purpose` (`compaction`, `session-title`) may map to model-hidden transport metadata; no wire, no retries |
| `dsh-llm-deepseek` | `packages/llm/llm-deepseek` | library | the Messages transport (`/anthropic`, `/v1/messages`, `/v1/files`); the built-in catalog `deepseek-flash` (text+image) and `deepseek-v4-pro` (text), both 1,048,576; the shared `/models` listing (moved here 2026-10-22) |
| `dsh-llm-deepseek-api-key` | `packages/llm/llm-deepseek-api-key` | default-mounted (entry `llm-deepseek`) | `deepseek-official`, `x-api-key`; FOLLOWS the official listing while `models` equals the built-in catalog on `api.deepseek.com`, else serves `models` |
| `dsh-llm-deepseek-account` | `packages/llm/llm-deepseek-account` | default-mounted | `deepseek-account`, `x-dsh-auth-token`; a listing per token, `modelOverrides` only |
| `dsh-llm-pi-ai` | `packages/llm/llm-pi-ai` | default-mounted, dormant | pi-ai `1.3.0`, patched; routes only from settings; an undescribed model gets 1,000,000 / 128,000 (2026-10-19) |
| `dsh-llm-retry` | `packages/llm/llm-retry` | default-mounted | retry on `agent/request-error` inside the same open turn; a direct `ctx.llm.stream()` is single-attempt |
| request extensions | `packages/llm/{deepseek-llm-api-extensions,plugin-package-inventory-deepseek}`, `packages/session/session-log-deepseek` | default-mounted | `dsh_plugin_packages`; `dsh_session_log`: the log past the last accepted watermark, ≤ 8 MiB a request |
| session route | `packages/core/agent` (`agent.model`) | core | log-only `model/selection`, applied from the next step, kept on resume; separate from the deployment default (`dsh-agent-default-model`: `deepseek-official`/`deepseek-flash`) |
| subagent route selection | `packages/subagent/tool-subagent/src/model-selection.ts` | off by default | a per-delegation route from a user allowlist |

No first-party OpenAI or Anthropic adapter (pi-ai reaches both); no role seam.

## Open for the route

- **later, continuable children.** A child starts on the parent's latest `request/header` route, drops an inherited effort when its route changes, and reaches another only through an allowlist snapshotted as `subagent/model-selection-policy`. `packages/subagent/subagent/src/child-agent.ts`, `packages/core/agent/README.md`
- **Any provider session, the Responses oracle.** pi-ai 1.3.0 sends `store:false`, `reasoning:{effort, summary:'auto'}` with `include:['reasoning.encrypted_content']`, `prompt_cache_key` = the clamped session id; keeps the reasoning item JSON as the thinking signature, `{id, phase}` as a text signature, `call_id|id` as the tool-call id; thinking from another provider, API or model is now DROPPED (1.1.0 made it text). `unpkg.com/@earendil-works/pi-ai@1.3.0/dist/api/{openai-responses,transform-messages}.js`
- **Any catalog session, the live listing.** Both DeepSeek routes decode `GET /models` (`id`, `name`, modalities, `context_window`, `max_output_tokens`, `api_capabilities.anthropic_messages`, `client_requirements["deepseek-harness"].min_version`), wait ≤ 5 s on first access, refresh after 600 s, keep the last good listing, refuse an unservable model before I/O (`CLIENT_UPGRADE_REQUIRED`, `MODEL_UNSUPPORTED`), ignore listed efforts; an unlisted id passes through. `packages/llm/llm-deepseek/src/{listing,listed-catalog}.ts`
- **An unknown DeepSeek id** passes text-only with the 1,000,000 default window, the 256,000 default cap and all four efforts; images become placeholders. `packages/llm/llm-deepseek/src/model-info.ts`
- **Provider identity (BLUEPRINT §3).** Headers `x-deepseek-harness-user-id` (anonymous, per home), `-session-id`, `-compact: 1`; by default the whole session log as `dsh_session_log`, to a `baseURL` gateway too. `docs/deepseek-llm-api-wire-extensions.md`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `packages/llm/README.md`, `packages/llm/llm/src/types.ts`, `docs/subsystems/core.md` | the packages; `purpose`, `sessionId`; `agent.model`, `model/selection` | 2026-10-25 |
| `packages/llm/llm-deepseek/README.md`, `src/{model-info,listing,listed-catalog}.ts` | transport, built-in catalog, unknown ids, the shared listing | 2026-10-25 |
| `packages/llm/llm-deepseek-{api-key,account}/README.md` | which route follows which listing; gating; overrides | 2026-10-25 |
| `packages/llm/llm-pi-ai/README.md`, `src/catalog.ts` | protocols, replay, discovery, defaults, catalog merge | 2026-10-25 |
| `docs/upgrade-guide/v0.2.1-rc.2/pi-ai-{default-capacities,model-catalog,protocol-replay}/guide.md` | 1.3.0: removed ids, capacities, foreign thinking, `MALFORMED_RESPONSE` | 2026-10-25 |
| `docs/deepseek-llm-api-wire-extensions.md`, `packages/session/session-log-deepseek/README.md` | headers, extension transaction, log upload and watermark | 2026-10-25 |
| `packages/llm/llm-retry/README.md` | `llm/retry` before the wait, then `llm/retry-started` | 2026-10-25 |
| `packages/bundle/{base,acp-app}/cordis.patch.yml` | default rows, dormant pi-ai, acp's `deepseek-v4-flash` | 2026-10-25 |

## Likely to go stale

- pi-ai: 1.1.0 → 1.3.0 on 10-17; npm `latest` is 1.4.0 (10-21); each bump reopens ids, protocols, replay and `patches/@earendil-works__pi-ai@1.3.0.patch`.
- The api-key listing is new (#6944, 10-22); a `models` list saved from an older built-in catalog stops following it.
- `deepseek-v4-flash` residue: the `acp-app`, `web-search-deepseek` and `subagent-dsh-sdk` defaults.
- `agent-default-model/README.md` still shows `provider: deepseek`, `model: deepseek-chat`.
- `docs/subsystems/llm-streaming.md` says a retry "opens another durable numbered turn"; the retry README says the same open turn (unreconciled).
- `openai` signs in by API key only; Codex by OAuth.

## Not read

- `.agents/notes/implemented/architecture/2026-10-22-deepseek-official-model-listing.md` (outside the snapshot); pi-ai 1.4.0.
