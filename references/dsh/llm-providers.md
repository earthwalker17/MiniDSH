# DSH reference: LLM seam and providers

> A map, not a copy: verify against the current repository before relying on any line ([the reading rules](../README.md)). Pin: `deepseek-ai/deepseek-harness@ddefc45f` (master, 2026-09-17, release 0.1.6-alpha.2); checked 2026-09-19.

## What exists (at the pin)

| Component | Path | Status | Purpose |
| --- | --- | --- | --- |
| `dsh-llm` (`ctx.llm`) | `packages/llm/llm` | default-mounted | adapter registry, chunks, failure codes; no wire, no retries |
| `dsh-llm-deepseek` | `packages/llm/llm-deepseek` | default-mounted | the `deepseek-official` route; Messages by default |
| its Chat Completions protocol | `packages/llm/llm-deepseek/src/protocols` | opt-in | Cordis YAML only |
| `dsh-llm-pi-ai` | `packages/llm/llm-pi-ai` | default-mounted | generic adapter over pi-ai; dormant until settings add profiles |
| `dsh-llm-retry` | `packages/llm/llm-retry` | default-mounted | route retry policy on `agent/request-error` |
| `dsh-token-meter` | `packages/llm/token-meter` | default-mounted | context pressure from the log |
| DeepSeek wire extensions | `packages/llm/deepseek-llm-api-extensions` | default-mounted | `dsh_*` body fields on official DeepSeek requests |
| `dsh-agent-default-model` | `packages/core/agent-default-model` | default-mounted | the process-wide default route |
| subagent route selection | `.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md` | disabled-by-default | a per-delegation route choice |
| Typert API gateway | `packages/api/gateway` | default-mounted | UI-to-host RPC, not an LLM proxy |

Absent at the pin: a first-party OpenAI or Anthropic adapter, and a cost layer (`packages/llm/README.md`, `packages/llm/llm/src/types.ts`).

## Open for the route

- **S16, format evolution.** pi-ai's replay envelope carries a kind and a version and returns only to the adapter instance that produced it, which validates it or degrades that one message to neutral content. `packages/llm/llm-pi-ai/src/replay.ts`
- **S16, brackets a crash leaves open.** Retry is durable before the wait. `llm/retry` is appended before sleeping and `llm/retry-started` before re-running the step in the same open turn; a crash between them leaves a scheduled, never-started retry. `packages/llm/llm-retry/README.md`
- **S17, a job that calls a model.** Retries run only on the loop's `agent/request-error` waterfall; a direct `ctx.llm.stream()` caller stays single-attempt, so off-loop work needs its own durable step boundary. `packages/llm/llm-retry/README.md`
- **S18, the OpenAI adapter.** Upstream reaches OpenAI only through pi-ai, which picks Responses or Chat Completions per model; reasoning items, item ids and `store` stay inside that dependency, so the Responses wire has no upstream oracle. `packages/llm/llm-pi-ai/README.md`
- **S18, DeepSeek model facts.** The defaults are `deepseek-flash` and `deepseek-v4-pro`, a 1,000,000 window and a 256,000 output cap; an unlisted id passes through text-only. `packages/llm/llm-deepseek/README.md`
- **S18, DeepSeek protocol.** The opt-in Chat Completions protocol (MiniDSH's) replays no signatures; the default Messages protocol does. Its cost is unmeasured. `packages/llm/llm-deepseek/README.md`
- **S21, continuable children.** Model-selected child routes are off by default, user-authorized and snapshotted as a durable `subagent/model-selection-policy` event; a fork always keeps its parent's route, for KV-cache reuse. `.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md`

## Sources

| Path | What it establishes | Checked |
| --- | --- | --- |
| `packages/llm/README.md` | the LLM packages | 2026-09-19 |
| `packages/llm/llm/src/types.ts` | options, `purpose`, chunks, envelope, usage | 2026-09-19 |
| `docs/subsystems/llm-streaming.md` | adapter contract, same-instance replay | 2026-09-19 |
| `packages/llm/llm-deepseek/README.md` | both protocols, defaults, images | 2026-09-19 |
| `packages/llm/llm-pi-ai/README.md` | profiles, fallbacks, compat, sign-in | 2026-09-19 |
| `packages/llm/llm-pi-ai/src/catalog.ts` | builtin registry, drift gates, zeroed cost | 2026-09-19 |
| `packages/llm/llm-pi-ai/src/replay.ts` | envelope kind, version, degrade | 2026-09-19 |
| `packages/llm/llm-retry/README.md` | durable before the wait | 2026-09-19 |
| `packages/bundle/base/cordis.patch.yml` | default rows, dormant pi-ai | 2026-09-19 |
| `packages/core/agent-default-model/README.md` | the process-wide default | 2026-09-19 |
| `docs/user/guide/providers.md` | user setup, route retention | 2026-09-19 |
| `.agents/notes/implemented/architecture/2026-07-14-provider-routed-llm-adapters.md` | why the provider keys registration; stale names | 2026-09-19 |
| `.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md` | why child routes are gated and logged | 2026-09-19 |

## Likely to go stale

- `llm-deepseek` defaults (models, window, protocol): changed 2026-09-14 to 16; `packages/core/agent-default-model/README.md` still shows `deepseek-chat`.
- pi-ai `^0.85.1` (`packages/llm/llm-pi-ai/package.json`) is pre-1.0; protocols and compat sets move with it.
- The route name `deepseek-official`, renamed once (the 2026-07-14 note says `deepseek`); saved selections key on it.
- The 262,144 / 32,768 fallbacks and envelope version 2.
- OAuth: `docs/user/guide/providers.md` says unsupported; `packages/llm/llm-pi-ai/README.md` says Codex signs in through it.

## Not read

- The `@earendil-works/pi-ai` dependency: its Responses reasoning-item encoding, whether it sends `store: false`, which `openai` models use which protocol.
- `packages/llm/llm/src/{index,assembler,call-config}.ts`: `LlmAdapter` members and block pruning come from docs, not code.
- `packages/llm/llm-deepseek/src/{common/models,protocols/messages/adapter}.ts`: the catalog and native replay come from the README.
- `packages/llm/llm-pi-ai/src/{adapter,provider}.ts`: where pi-ai is invoked (no `streamSimple()` in `src/stream.ts`, against the 2026-07-14 note), and whether library retries are off in code.
- Other bundles (`packages/bundle/{headless,sdk-app,sdk-minimal,acp-app,web-app}`), which may change LLM rows; `.agents/notes/proposed` (a role proposal may exist).
- How `dsh-session-title-first-prompt-llm`, `dsh-compaction-basic` and `dsh-tool-subagent` pick a route, in code.
- Reconcile: `docs/subsystems/llm-streaming.md` says recovery "opens another durable numbered turn"; the retry README says the same open turn.
