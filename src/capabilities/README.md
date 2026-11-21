# src/capabilities

Each directory here is one plugin: a provider of a `core` seam, a consumer of one (usually a model-facing tool), or a listener on core events. A capability is what a composition row can add, replace or remove. The default rows are `compose()` in [`../app/compose.ts`](../app/compose.ts). Not every directory is a default row: the surfaces add `protocol`, the boot adds `composition-record`, and a layer must insert `tool-view-image` or `tool-web-search`.

A capability imports `kernel`, `core` except `core/loop`, and itself. Only `app`, `test-support` and tests import one. The rule is [ARCHITECTURE section 1](../../docs/ARCHITECTURE.md#1-layers-and-dependency-direction), enforced by `scripts/check-deps.ts`, which also refuses a non-literal `import()` here.

## Start here

- [`../app/compose.ts`](../app/compose.ts): which rows are mounted, in what order, with what config.
- [`fs-observation-policy/index.ts`](fs-observation-policy/index.ts): the smallest capability. No service, two `fs` event listeners.
- [`tool-editor/index.ts`](tool-editor/index.ts): a model-facing tool built with `defineTool` over the `fs` seam.

## Reading order

After the three files above:

1. [`fs-local/index.ts`](fs-local/index.ts): where a write is fenced and its effect recorded.
2. [`llm-deepseek/index.ts`](llm-deepseek/index.ts): how an adapter registers and declares its key.
3. [`llm-retry/index.ts`](llm-retry/index.ts): how a policy joins the loop as one listener on `agent/request-error`.
4. [`tool-shell/index.ts`](tool-shell/index.ts): what happens when a command cannot be confined.
5. [`tool-subagent/index.ts`](tool-subagent/index.ts): how a child agent opens under its parent's authority.
6. [`protocol/index.ts`](protocol/index.ts): how clients reach all of it. Continue in [`protocol/README.md`](protocol/README.md).

## Modules

DSH paths are upstream paths, pinned in [`references/README.md`](../../references/README.md). "Not compared" means none is recorded there. Reasons for a difference are in [section 12](../../docs/ARCHITECTURE.md#12-divergences-from-deepseek-harness-the-ones-that-still-shape-decisions).

| Module | Owns | DSH counterpart | Where MiniDSH differs |
|---|---|---|---|
| `llm-deepseek`, `llm-anthropic`, `llm-openai` | one `llm` adapter each | `packages/llm/llm-deepseek`. `packages/llm/llm-pi-ai` reaches the other two | DeepSeek's OpenAI-compatible chat API and a dated catalog. DSH uses the Messages transport and a live model listing. |
| `llm-retry`, `model-roles` | bounded retry of a failed request. Routing a call by purpose | `packages/llm/llm-retry`. None for roles | DSH's retry also has an unlimited mode and logs each wait. |
| `fs-local`, `fs-observation-policy` | the `fs` provider and its write fence. The read-before-edit policy | `packages/fs/fs-sandbox` for the fence. Policy not compared | Writes are fenced to the workspace root alone. DSH adds temp and extra roots. |
| `tool-editor`, `tool-view-image` | the `str_replace_editor` and `view_image` tools | `packages/fs/tool-fs` holds `read_image`. Editor not compared | `view_image` is its own row and refuses before any I/O on a text-only route. |
| `shell-stdio`, `tool-shell` | the persistent shell and its confinement. The `bash` or `pwsh` tool and its escalation | `packages/shell`, `packages/sandbox/sandbox-local` | bwrap and Seatbelt only. DSH also has Landlock and a Windows backend. |
| `tool-jobs` | `job_start`, `job_output`, `job_cancel` | `packages/jobs/tool-jobs` | The owner's wake is bounded by default. In DSH only when configured. |
| `tool-subagent` | delegation to a child under a ceiling | `packages/subagent/tool-subagent`, `packages/subagent/tool-subagent-control` | A foreground call its parent's cancel reaches. DSH's child is continuable, with fork and control tools MiniDSH lacks. |
| `tool-web-search`, `tool-browser` | `web_search` with consent per query. The `browser_*` tools over a fenced browser | `packages/web/tool-web`. `packages/experimental/browser-use-*` | Search is opt-in and has no fetch. DSH mounts search and fetch by default with no approval. Its browsers are experimental and unfenced. |
| `approval-headless`, `authority-presets` | the unattended approval answerer. The preset table | None for the answerer. `packages/interaction/permission-presets` | `--approve` or an exact-subject allow list. Fewer presets than DSH's base bundle. |
| `persistence-jsonl`, `attachments-local`, `spill-local`, `credentials-local`, `settings-local` | session logs under a write lease, image bytes, oversized output, secrets, settings | `packages/session/session-persistence-jsonl`, `packages/attachment/attachment-local`, `packages/credentials/credentials-local`. Spill and settings not compared | Plain JSONL under a `.lock` file. DSH writes checksummed frames under a kernel lock. Attachments are images only. |
| `compaction-basic`, `tool-history` | summarising compaction. `history_read` over what it shadowed | `packages/compaction`. `packages/experimental/tool-session-query` | No tool-result pruner, no image offload. Recall is one tool, for this session only. |
| `context-runtime`, `workspace-instructions`, `skills` | the persona and runtime-context prompt text. `AGENTS.md` and the skill list as durable messages | `packages/context/agent-instructions`, `packages/skill/tool-skill`. `context-runtime` not compared | No `skill` loader tool, no `/name` gesture. Instruction files are not watched. |
| `session-title`, `composition-record` | the one writer of `session/title`. The `composition/applied` record | `packages/session/session-title`. Record not compared | The title is cut from the first prompt. DSH also has a model-written title and a rename. |
| `protocol` | the JSON-RPC host and its carriers | `packages/sdk/protocol`, `packages/sdk/server` | One host, several carriers. `session/resume` returns a live session. Fork is on the wire. |

## The contract

- Invariants: [3. Core contracts](../../docs/ARCHITECTURE.md#3-core-contracts-srccore), [5. LLM vocabulary and the adapters](../../docs/ARCHITECTURE.md#5-llm-vocabulary-and-the-adapters), [6. The loop and the tool pipeline](../../docs/ARCHITECTURE.md#6-the-loop-and-the-tool-pipeline) and [7. Authority](../../docs/ARCHITECTURE.md#7-authority).
- Tests: `src/app/app.test.ts` on the full composition, then `fs-local/fence.test.ts`, `shell-stdio/confine.test.ts`, `tool-shell/escalation.test.ts`, `tool-subagent/subagent.test.ts`.
- A new provider, tool, store or policy: [11. Where new things go](../../docs/ARCHITECTURE.md#11-where-new-things-go).
