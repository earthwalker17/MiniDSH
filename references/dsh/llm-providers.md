# DSH reference: LLM seam and providers

> Pinned to `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19. A map, not a copy: DSH changes weekly, so verify against the current repository before relying on any line here (see [the reading rules](../README.md)).

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| `dsh-llm` (`ctx.llm`) | `packages/llm/llm` | default-mounted | Adapter registry, chunk vocabulary, frozen one-shot calls, failure codes; no wire code, no retries. |
| `dsh-llm-deepseek` | `packages/llm/llm-deepseek` | default-mounted | Hand-rolled adapter owning the single `deepseek-official` route; Messages by default. |
| its Chat Completions protocol | `packages/llm/llm-deepseek/src/protocols` | opt-in | Cordis YAML only; replays no signatures. |
| `dsh-llm-pi-ai` | `packages/llm/llm-pi-ai` | default-mounted | The one generic adapter, over the pi-ai library; dormant (zero routes) until settings supply profiles. |
| `dsh-llm-retry` | `packages/llm/llm-retry` | default-mounted | Runs route retry policy on the loop's `agent/request-error` waterfall; ships an `./invariant` checker. |
| `dsh-token-meter` | `packages/llm/token-meter` | default-mounted | Context pressure from the durable log; no model table. |
| DeepSeek wire extensions | `packages/llm/deepseek-llm-api-extensions` | default-mounted | `dsh_*` body fields (session-log upload, plugin inventory) on official DeepSeek requests only. |
| `dsh-agent-default-model` | `packages/core/agent-default-model` | default-mounted | Process-wide default route for fresh agents: `deepseek-official` / `deepseek-flash`, settings override. |
| subagent route selection | `.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md` | disabled-by-default | Model picks a user-authorized route per delegation; forks always inherit. |
| Typert API gateway | `packages/api/gateway` | default-mounted | UI-to-host RPC (`docs/api-gateway.md`); not an LLM proxy. |

Absent at the pin: a first-party OpenAI or Anthropic adapter, a role or per-purpose router, a cost layer (`packages/llm/README.md`, `packages/llm/llm/src/types.ts`).

## Mechanisms worth knowing

- **Adapter contract**: `registerAdapter(providers, adapter)` keys by provider route, never model id. A closed `StreamChunk` union: usage before finish, nothing after it, tool arguments raw JSON strings, one call is one provider attempt with library retries disabled. Failures normalize to stable codes; a `stop` with no blocks is `EMPTY_RESPONSE`, retried by default. `docs/subsystems/llm-streaming.md`, `packages/llm/llm/src/types.ts`
- **Replay envelope**: a successful finish may carry `ReplayEnvelope`: a response half plus entries aligned to emitted blocks, stored on the assistant message. It returns only to "the exact same adapter instance", which validates it or degrades that one message to neutral content. pi-ai's is kind `pi-ai`, version 2: `responseId` and three signature kinds. `docs/subsystems/llm-streaming.md`, `packages/llm/llm-pi-ai/src/replay.ts`
- **How OpenAI is reached**: only through pi-ai. A catalog route (`providers.openai`, `apiKeyEnv` as a per-request key reference, optional `baseURL`) takes endpoint, models and wire protocol from the installed catalog, so Responses versus Chat Completions is pi-ai's per-model choice. Custom routes name `api`: `openai-completions`, `openai-responses` or `anthropic-messages`. `packages/llm/llm-pi-ai/README.md`
- **Custom-route facts**: `api`, `baseURL`, `models`; per model: window, output cap, modalities, `reasoningEfforts`, `compat` switches (`supportsDeveloperRole`, `maxTokensField`). Undescribed models get 262,144 window, 32,768 output, text only. Declarations are unverified claims. `packages/llm/llm-pi-ai/README.md`
- **Catalog currency**: facts come at runtime from the installed `@earendil-works/pi-ai` registry via `getBuiltinModels`, refreshed only by upgrading it; `Record` drift gates fail the build until new fields are classified. `/models` discovery is advisory: "A route's catalog never refreshes itself". `packages/llm/llm-pi-ai/src/catalog.ts`, `packages/llm/llm-pi-ai/README.md`
- **One owner for model facts**: `resolveModel()` on the serving adapter returns exact facts (window, output default, ordered opaque efforts, modalities); `listModels()` is advisory, never a whitelist. `docs/subsystems/llm-streaming.md`
- **Routing, no roles**: a route is an explicit provider, model and optional effort logged in each request header; a session "retains the model recorded in its own log"; `agent/request` may replace it per step. `purpose` drives only transport metadata and thinking-off. `packages/llm/llm/src/types.ts`, `docs/user/guide/providers.md`, `docs/subsystems/llm-streaming.md`
- **Retries**: default policy: 5 retries of `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, 500 ms to 10 s, 10% jitter, bounded `Retry-After` wins. `llm/retry` is appended before the wait, `llm/retry-started` before re-running the step in the same open turn. Direct `ctx.llm.stream()` callers stay single-attempt. `packages/llm/llm/src/retry-policy.ts`, `packages/llm/llm-retry/README.md`
- **Usage**: disjoint counts (uncached input, cache read, cache write; reasoning a subset of output); pi-ai cost is zeroed, no spend reporting. `packages/llm/llm/src/types.ts`, `packages/llm/llm-pi-ai/src/catalog.ts`
- **Direct DeepSeek adapter**: `protocol` defaults to `messages` at `https://api.deepseek.com/anthropic` and replays signatures; `chat-completions` does not. Defaults: `deepseek-flash`, `deepseek-v4-pro`, 1,000,000 window, 256,000 output cap; unlisted ids pass through text-only. `systemPromptUpdate: in-history` appends a changed system prompt after cached history. `packages/llm/llm-deepseek/README.md`

## Why it matters to MiniDSH

- **S18, OpenAI on Responses**: NO upstream oracle: reasoning-item encoding, item ids and `store` handling live inside the pi-ai dependency and reach DSH as opaque strings. MiniDSH must own them. Transfer the envelope discipline: block-aligned entries, returned only to the producing adapter, validated on read, one message degraded, never a failed request.
- **S18, generic routing (later)**: the custom-route fields are the checklist; expect gateways to reject the developer role and `max_completion_tokens`; give unlisted models explicit fallbacks.
- **FALSIFIED in part, "a durable base route is no upstream seam"**: roles are absent, but the route IS durable upstream: each logged request header carries it, a session keeps what its log records, and `dsh-agent-default-model` is a mounted base. MiniDSH's per-purpose roles stay a deliberate difference with no oracle (as does spend metering: upstream zeroes cost); upstream uses explicit per-consumer pairs.
- **FALSIFIED in part, "model facts come from a source snapshot"**: true only of `llm-deepseek`'s two entries; elsewhere a dependency registry, overrides, fallbacks and drift gates. MiniDSH keeps its measured snapshot deliberately, so it must say who refreshes it and when.
- **New at the pin**: the direct adapter DEFAULTS to DeepSeek's Anthropic-style Messages endpoint; MiniDSH's Chat Completions path is now upstream's opt-in one and replays no signatures. S16.5 should measure what that costs.
- **S14, S16**: "durable before wait" is the recovery contract in miniature: `llm/retry` then `llm/retry-started` is a bracket a crash can leave open. MiniDSH's step-boundary retries match; recovery must close a scheduled, never-started retry. For S16, the versioned envelope (old versions degrade, never fail) and the `./invariant` companion are precedents.
- **S17, S20**: off-loop stream callers get no retries: a job calling a model needs its own durable step boundary. Text-only routes get placeholders while durable history keeps image references (`packages/llm/llm-deepseek/README.md`): the rule for screenshots.
- **S21**: child route choice is off by default, user-authorized, snapshotted as a durable `subagent/model-selection-policy` event; forks keep the parent route for KV-cache reuse.

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `packages/llm/README.md` | The seven LLM packages. | 2026-09-19 |
| `packages/llm/llm/src/types.ts` | `GenerateOptions`, `purpose`, chunks, envelope, usage. | 2026-09-19 |
| `packages/llm/llm/src/retry-policy.ts` | Retry constants and modes. | 2026-09-19 |
| `docs/subsystems/llm-streaming.md` | Adapter contract, same-instance replay, `agent/request`. | 2026-09-19 |
| `packages/llm/llm-deepseek/README.md` | Dual protocol, defaults, codes, images. | 2026-09-19 |
| `packages/llm/llm-pi-ai/README.md` | Profiles, fallbacks, compat, discovery, sign-in. | 2026-09-19 |
| `packages/llm/llm-pi-ai/src/catalog.ts` | Builtin registry, drift gates, zeroed cost. | 2026-09-19 |
| `packages/llm/llm-pi-ai/src/replay.ts` | Envelope kind, version, validation, degrade. | 2026-09-19 |
| `packages/llm/llm-retry/README.md` | Durable before wait; always-mode hazards. | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | Default rows, dormant pi-ai, default route. | 2026-09-19 |
| `packages/core/agent-default-model/README.md` | Process-wide default, `saveSelection()`. | 2026-09-19 |
| `docs/user/guide/providers.md` | User setup, protocols, route retention. | 2026-09-19 |
| `.agents/notes/implemented/architecture/2026-07-14-provider-routed-llm-adapters.md` | WHY provider keys registration; stale names. | 2026-09-19 |
| `.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md` | WHY child routes are gated and logged. | 2026-09-19 |

## Likely to go stale

- `llm-deepseek` defaults (models, window, Messages protocol, base-URL rules): changed 2026-09-14 to 2026-09-16; `packages/core/agent-default-model/README.md` still shows `deepseek-chat`.
- pi-ai `^0.85.1` (`packages/llm/llm-pi-ai/package.json`) is pre-1.0; protocols and compat sets move with each upgrade.
- Route name `deepseek-official`: renamed once (the 2026-07-14 note says `deepseek`); saved selections key on it.
- Retry constants, the 262,144 / 32,768 fallbacks, envelope version 2 (bumped once already).
- OAuth: `docs/user/guide/providers.md` says such providers "are not supported here yet"; `packages/llm/llm-pi-ai/README.md` says Codex signs in through OAuth.

## Not read

- The `@earendil-works/pi-ai` dependency: how Responses reasoning items are encoded, whether `store: false` is sent, which `openai` models use which protocol.
- `packages/llm/llm/src/index.ts`, `src/assembler.ts`, `src/call-config.ts`: `LlmAdapter` members and block pruning come from docs, not code.
- `packages/llm/llm-deepseek/src/common/models.ts`, `src/protocols/messages/adapter.ts`: catalog and native replay come from the README.
- `packages/llm/llm-pi-ai/src/adapter.ts`, `src/provider.ts`: where pi-ai is invoked (no `streamSimple()` in `src/stream.ts`, against the 2026-07-14 note); whether library retries are disabled in code.
- Other bundles (`packages/bundle/headless`, `sdk-app`, `sdk-minimal`, `acp-app`, `web-app`): may reconfigure LLM rows. `.agents/notes/proposed`: unopened; a role proposal may exist.
- How `dsh-session-title-first-prompt-llm`, `dsh-compaction-basic` and `dsh-tool-subagent` pick a route, in code.
- Reconcile: `docs/subsystems/llm-streaming.md` says recovery "opens another durable numbered turn"; the retry README says the same open turn.
