# MiniDSH Blueprint

Rolling long-term route plus a compact development record. The next session is always at the top; completed work is compressed into the record at the bottom. `ARCHITECTURE.md` describes the current shape; this file says what comes next and why.

## Current session — S1 Foundation (in progress)

Goal: make the architecture executable and testable with the minimum capability set, and prove it with a live DeepSeek run on a real workspace.

Phases: 0 repo/docs/env → 1 kernel → 2 session + llm → 3a tools/prompt/seams → 3b agent + loop → 4 capabilities (DeepSeek, retry, fs, editor, shell, persistence, approval, policy, context) → 5 app + gates → 6 adversarial review → 7 live E2E → 8 docs + memory.

Exit criteria: `pnpm check` green; invariants on in tests; live E2E completes a real coding task through the CLI with the world verified externally; `ARCHITECTURE.md` reconciled to code; memory handoff written; no push.

## Macro route (dependency-ordered; sessions are approximate)

| Session | Architectural outcome | Depends on |
|---|---|---|
| **S1 Foundation** | Kernel, spine (session log, llm seam, tools pipeline, prompt, approval/fs/shell seams, agent, loop), DeepSeek adapter, minimal tools (persistent shell + `str_replace_editor`), JSONL persistence, headless CLI, runtime invariants, replay-from-log tests, live E2E. Every durable architectural question has a code answer. | — |
| **S2 Surface contract** | A formal client protocol (JSON-RPC over stdio: `initialize`, `session/prompt`, `session/cancel`, `approval/answer`, `shutdown`; notifications `session.event`, `session.status`) as a plugin injecting only `agents`/`sessions`; an interactive terminal surface over it (streaming render, approval prompts, steering, wake latch); `core/persistence` Definition, `agents.resume`, CLI `resume`/`fork`. Two surfaces, one runtime; sessions resumable. | S1 |
| **S3 Effects & authority** | Sandbox policy seam (`read-only` / `workspace-write` / `danger-full-access`, one `writableRoots`), in-process fs fence, shell confinement where the platform allows, tool timeouts/guards, durable `approval/policy` + `sandbox/mode` switching, audit views. Authority is a complete, replayable plane. | S1 (S2 for interactive approval) |
| **S4 Composition & configuration** | Declarative composition files + patch layers on disk, MiniDSH home layout, settings + credentials seams (env / .env / keychain providers), per-session presets via scoped contexts, runtime mount/unmount — the self-recomposable substrate. Capabilities change without code edits; "which tools did this session run" is answerable on replay. | S1, S3 |
| **S5 Context management** | Token metering, compaction seam + basic provider (tool-result pruning and summaries as `surfaceOp: replace`), large-output spill, workspace instructions (AGENTS.md) injection. Long tasks stay in budget without breaking reconstruction. | S1 |
| **S6 Cognition routing & delegation** | Second adapter (OpenAI/Anthropic-compatible generic), model roles (primary / cheap / verifier / vision), subagent seam (in-process child with scoped tools), bounded parallel tools. The model is a capability provider, not the agent. | S4, S5 |
| **S7 Web surface** | Host/client split over the S2 protocol (WebSocket carrier), minimal browser client rendering from events. Web + terminal + headless share one runtime. | S2 |
| **S8 Verification capabilities** | Vision-model verification of screenshots and browser state, an independent verifier role, verification events. Verification is a first-class capability. | S6, S7 |
| **S9+** | Extension authoring and governance (model-written plugins behind approval, evaluation, rollback), desktop shell, MCP bridge if evidence demands. | S4, S8 |

Ordering rationale: the protocol (S2) must exist before any GUI so surfaces never grow semantics; authority (S3) before configuration (S4) so presets cannot widen permissions silently; compaction (S5) before delegation (S6) so child agents inherit bounded context; verification (S8) after routing (S6) because a verifier is a model role.

## Open risks and questions

- TypeScript 7 native `tsc` is new (GA 2026-07-08); fallback is 6.0.3 with identical checking.
- Windows shell confinement has no clean backend; S3 may accept `partial` enforcement on win32 as DSH does.
- DeepSeek V4 thinking + tool-call loops depend on `reasoning_content` passback; the live E2E pins it.
- When to promote to a workspace: the first out-of-process consumer (S2 client or S7 browser client).

## Development record

- **S1 (2026-08-22, in progress)** — Research: DSH `b150a55` studied (core docs, notes, 8-dimension panel); system space designed; docs created. Implementation record appended at session end.
