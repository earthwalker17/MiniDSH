# DSH reference: LLM seam and providers

> Where to research DSH's LLM seam and adapters ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@86a40220` (master, 2026-10-15, dsh-0.2.1-alpha.4); checked 2026-10-16 (S18).

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| `dsh-llm` (`ctx.llm`) | `packages/llm/llm` | default-mounted | adapter registry, chunks, failure codes, label-only `purpose`; `prepareCall` with a pure `ConfigureCall` (the caller picks the least effort); no wire, no retries |
| `dsh-llm-deepseek` | `packages/llm/llm-deepseek` | library, no route | the shared DeepSeek Messages transport (`/anthropic` root, `/v1/messages`, `/v1/files`) |
| `dsh-llm-deepseek-api-key` | `packages/llm/llm-deepseek-api-key` | default-mounted (entry id `llm-deepseek`) | the `deepseek-official` route: `x-api-key`, a SOURCE catalog, never `GET /models` |
| `dsh-llm-deepseek-account` | `packages/llm/llm-deepseek-account` | default-mounted | the `deepseek-account` route: `x-dsh-auth-token`, a catalog read LIVE from `GET /models` |
| `dsh-llm-pi-ai` | `packages/llm/llm-pi-ai` | default-mounted, dormant | generic adapter over pi-ai `1.1.0` (patched); routes only from settings |
| `dsh-llm-retry` | `packages/llm/llm-retry` | default-mounted | route retry on `agent/request-error`; a direct `ctx.llm.stream()` caller is single-attempt |
| `token-meter` | `packages/llm/token-meter` | default-mounted | the cost layer (present since 2026-08-25) |
| DeepSeek request extensions | `packages/llm/deepseek-llm-api-extensions` | default-mounted | `dsh_session_log`, `dsh_plugin_packages`; never block a request (a failed extension sends the base body) |
| `dsh-agent-default-model` | `packages/core/agent-default-model` | default-mounted | the process-wide default: `deepseek-official`/`deepseek-flash` |
| subagent route selection | `packages/subagent/tool-subagent/src/model-selection.ts` | off by default | a per-delegation route from a user allowlist |

No first-party OpenAI or Anthropic adapter at the pin; no role seam (the ledger's provider rows).

## Open for the route

- **S21, continuable children.** A child route needs a user allowlist snapshotted as `subagent/model-selection-policy` before the first request; `child-agent.ts` inherits the parent's route and tracks `routeChanged`. `.agents/notes/implemented/feature/2026-08-24-user-authorized-subagent-model-routes.md`, `packages/subagent/subagent/src/child-agent.ts`
- **Any provider session, the Responses oracle.** pi-ai 1.1.0 (readable on unpkg) is the only upstream Responses encoding: `store:false`, `reasoning:{effort, summary:'auto'}` plus `include` when effort is on, `prompt_cache_key` = the session id, the whole reasoning item JSON stored as the block's signature, message `id`/`phase` in a text signature, `call_id|fc_id` folded into the tool-call id, foreign reasoning turned into plain TEXT. `unpkg.com/@earendil-works/pi-ai@1.1.0/dist/api/openai-responses-shared.js`
- **Any catalog session, the live listing.** The account route decodes `GET /models` entry by entry (`id`, `name`, modalities, `context_window`, `max_output_tokens`, `api_capabilities.anthropic_messages`, `client_requirements["deepseek-harness"].min_version`), overrides the bundled entry field by field, ignores the listed effort levels, waits ≤ 5 s on first access and refreshes after 600 s, keeping the last good listing. `packages/llm/llm-deepseek-account/src/listing.ts`
- **An unknown DeepSeek id** passes through text-only with a 1,000,000 window, a 256,000 cap and all four efforts; images become placeholders. `packages/llm/llm-deepseek/src/model-info.ts`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `packages/llm/README.md` | the LLM packages | 2026-10-16 |
| `packages/llm/llm/src/{types,call-config}.ts` | `GenerateOptions`, `purpose`, `ConfigureCall`, envelope | 2026-10-16 |
| `packages/llm/llm-deepseek/README.md`, `src/{models,defaults,model-info,replay}.ts` | Messages-only, catalog, unknown ids, signature replay | 2026-10-16 |
| `packages/llm/llm-deepseek-api-key/{README.md,src/index.ts}`, `llm-deepseek-account/{README.md,src/listing.ts}` | the two routes; source catalog vs live listing | 2026-10-16 |
| `.agents/notes/implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.md` | why the account route reads `/models` | 2026-10-16 |
| `packages/llm/llm-pi-ai/README.md`, `src/{adapter,config,provider,replay,stream}.ts`, `pnpm-workspace.yaml` | protocols, compat, refusals, envelope v2, pi-ai 1.1.0 and its patch | 2026-10-16 |
| `unpkg.com/@earendil-works/pi-ai@1.1.0/dist/api/{openai-responses,openai-responses-shared,transform-messages}.js` | the Responses encoding above | 2026-10-16 |
| `packages/llm/llm-retry/README.md` | `llm/retry` before the wait, `llm/retry-started` before the re-run, same open turn | 2026-10-16 |
| `packages/bundle/{base,acp-app}/cordis.patch.yml` | default rows, dormant pi-ai, acp's `deepseek-v4-flash` | 2026-10-16 |

## Likely to go stale

- pi-ai moves fast (0.85.1 → 0.87.1 → 1.0.0 → 1.0.2 → 1.1.0 between 09-29 and 10-12; npm `latest` is 1.3.0): each bump reopens protocols, compat flags and the patch.
- `deepseek-v4-flash` residue (`acp-app`, `web-search-deepseek`, `subagent-dsh-sdk`, the SDK and Python guide, `llm/README.md`): DeepSeek retired the model on 2026-09-10 and routes the name "temporarily", so expect a sweep.
- `agent-default-model/README.md` still shows `provider: deepseek`, `model: deepseek-chat`.
- `docs/subsystems/llm-streaming.md` says a retry "opens another durable numbered turn"; the retry README says the same open turn (unreconciled).
- ChatGPT sign-in for `openai` is withheld (e1878e41); Codex still signs in through OAuth.

## Not read

- `docs/deepseek-llm-api-wire-extensions.md`, `packages/session/session-log-deepseek`: what `dsh_session_log` sends of a session to the official API.
- The user guide's OAuth text; `llm-pi-ai/src/catalog.ts` beyond grep.
