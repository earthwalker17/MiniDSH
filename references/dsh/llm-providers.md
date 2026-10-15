# DSH reference: LLM seam and providers

> Where to research DSH's LLM seam and adapters ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@477b4f42` (master, 2026-09-24, dsh-v0.1.7-rc.2); checked 2026-09-26.

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| `dsh-llm` (`ctx.llm`) | `packages/llm/llm` | default-mounted | adapter registry, chunks, failure codes, `GenerateOptions.purpose`; no wire, no retries |
| `dsh-llm-deepseek` | `packages/llm/llm-deepseek` | library, no route | the shared DeepSeek Messages transport, Messages-ONLY since 2026-09-20 |
| `dsh-llm-deepseek-api-key` | `packages/llm/llm-deepseek-api-key` | default-mounted (entry id `llm-deepseek`) | the `deepseek-official` route: `x-api-key`, catalog, discovery |
| `dsh-llm-deepseek-account` | `packages/llm/llm-deepseek-account` | default-mounted | the `deepseek-account` route on a stored grant; no fallback between routes |
| `dsh-llm-pi-ai` | `packages/llm/llm-pi-ai` | default-mounted, dormant | generic adapter over pi-ai `0.85.1` (patched); routes only from settings |
| `dsh-llm-retry` | `packages/llm/llm-retry` | default-mounted | route retry policy on `agent/request-error`; a direct `ctx.llm.stream()` caller is single-attempt |
| DeepSeek request extensions | `packages/llm/deepseek-llm-api-extensions`, `plugin-package-inventory-deepseek` | default-mounted | `dsh_session_log`, `dsh_plugin_packages` outside model input |
| `dsh-agent-default-model` | `packages/core/agent-default-model` | default-mounted | the process-wide default: base `deepseek-official`/`deepseek-flash` |
| subagent route selection | `packages/subagent/tool-subagent/src/model-selection.ts` | off by default | a per-delegation route from a user allowlist |

Absent at the pin: a cost layer and a role mechanism (`packages/llm/README.md`); the ledger's provider rows hold the adapter set and the purpose routes.

## Open for the route

- **S18, the OpenAI adapter.** Upstream reaches OpenAI only through pi-ai, which picks Responses or Chat Completions per model; reasoning items, item ids and `store` stay inside that dependency, so the Responses wire has no upstream oracle (only `supportsMaxOutputTokens` is a switch). `packages/llm/llm-pi-ai/README.md`
- **S18, DeepSeek model facts.** The catalog is `deepseek-flash` (text+image) and `deepseek-v4-pro` (text), a 1,000,000 window and a 256,000 output cap; `deepseek-v4-flash` left the defaults on 2026-09-16 and still passes through text-only. `packages/llm/llm-deepseek/src/models.ts`
- **S18, DeepSeek protocol.** Messages only (`/anthropic` root, `/v1/messages`), effort as `output_config.effort`, off as `thinking.type: disabled`; thinking signatures replay through a `deepseek-messages` v1 envelope validated per block and per model, degraded to no signatures with a warning. With Chat Completions gone, MiniDSH's wire has no upstream oracle. `packages/llm/llm-deepseek/README.md`, `packages/llm/llm-deepseek/src/replay.ts`
- **S18, the default route.** `selectModel` installs the session selection and saves the default in the background, serialized; a failed save logs and keeps the session selection. `packages/api/session-controller/README.md`
- **S21, continuable children.** A child route needs a user allowlist snapshotted as `subagent/model-selection-policy` before the first request; a fork keeps its parent's route for KV-cache reuse. `.agents/notes/implemented/feature/2026-08-24-user-authorized-subagent-model-routes.md`, `packages/subagent/subagent/src/child-agent.ts`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `packages/llm/README.md` | the nine LLM packages | 2026-09-26 |
| `packages/llm/llm/src/types.ts` | `GenerateOptions`, `purpose`, `toolHistory`, envelope | 2026-09-26 |
| `docs/subsystems/llm-streaming.md` | adapter contract, same-instance replay | 2026-09-26 |
| `packages/llm/llm-deepseek/README.md`, `llm-deepseek-api-key/README.md`, `llm-deepseek-account/README.md` | Messages-only, defaults, images, the two routes | 2026-09-26 |
| `packages/llm/llm-deepseek/src/{models,defaults,replay,serialize}.ts` | catalog, caps, signature replay | 2026-09-26 |
| `packages/llm/llm-pi-ai/README.md`, `src/{adapter,config,replay}.ts` | profiles, protocols, compat, sign-in, discovery; `maxRetries: 0`, 262,144 / 32,768, envelope v2 | 2026-09-26 |
| `packages/llm/llm-retry/README.md` | durable: `llm/retry` before the wait, `llm/retry-started` before the re-run, in the same open turn | 2026-09-26 |
| `docs/persistence-catalog.md` | the retry, model-selection-policy and aux-request events | 2026-09-26 |
| `packages/bundle/{base,sdk-minimal,acp-app}/cordis.patch.yml` | default rows, dormant pi-ai, acp's `deepseek-v4-flash` | 2026-09-26 |
| `packages/core/agent-default-model/README.md`, `packages/api/session-controller/README.md` | background saves; `selectModel` semantics | 2026-09-26 |
| `.agents/notes/implemented/simplification/2026-09-19-deepseek-messages-only.md` | why Chat Completions went | 2026-09-26 |

## Likely to go stale

- The DeepSeek adapter split: Messages-only 2026-09-20, api-key/account plugins 2026-09-23, dynamic tool updates (`toolUpdate`, beta header) 2026-09-23, oversized request extensions 2026-09-24.
- `deepseek-v4-flash` residue (acp-app, SDK child, web search, Python guide, tests) against a catalog without it: expect a sweep.
- pi-ai pinned at 0.85.1 with a patch (`pnpm-workspace.yaml`, `patches/`); a bump reopens protocols and compat.
- Route names `deepseek-official`, `deepseek-account`; `agent-default-model/README.md` still says `deepseek`.
- `docs/subsystems/llm-streaming.md` says a retry "opens another durable numbered turn"; the retry README says the same open turn (unreconciled). OAuth: the user guide says unsupported, the pi-ai README says Codex signs in through it.

## Not read

- The `@earendil-works/pi-ai` dependency itself: Responses reasoning-item encoding, `store`, the protocol per `openai` model (not in the repository).
- `packages/llm/llm/src/{assembler,call-config}.ts`, `packages/llm/llm-deepseek/src/{adapter,translate,files-api}.ts`: read from docs and READMEs only.
- `docs/deepseek-llm-api-wire-extensions.md`, `packages/session/session-log-deepseek`: what `dsh_session_log` sends of a session to the official API.
