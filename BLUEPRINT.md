# MiniDSH Blueprint

Rolling long-term route plus a compact development record. The next session is always at the top; completed work is compressed into the record at the bottom. `ARCHITECTURE.md` describes the current shape; this file says what comes next and why.

## Next session — S2 Surface contract

Goal: prove that surfaces own no harness semantics, by putting a second surface on the same runtime — and make sessions resumable.

Planned work, in dependency order:
1. **`core/persistence` Definition** (`load(id) → {header, events}`, `append`) so the core can seed from a stored log without importing a capability; `persistence-jsonl` becomes its provider. This is the blocker for everything else here.
2. **`agents.resume(id)`** through the existing seed path (the driver already continues turn numbering over a seed), plus CLI `resume` and `fork`.
3. **The client protocol**: newline-delimited JSON-RPC over stdio — requests `initialize`, `session/prompt`, `session/cancel`, `approval/answer`, `shutdown`; notifications `session.event`, `session.status`. It ships as a plugin injecting only `agents`/`sessions`, and the wire carries core types verbatim (no DTO layer).
4. **An interactive terminal surface** over that protocol: streaming render from `session/event`, approval prompts answered through `approval/answer`, steering mid-turn, and the wake latch (input arriving between abort and convergence must not be lost — see the S1 risk list).
5. **Durable inbox**: promote inbox splices to session events so a resumed session reconstructs pending input.

Exit criteria: two surfaces (CLI + terminal) over one unchanged runtime; a session survives process restart and continues; `pnpm check` green; live E2E through the interactive surface.

## Completed — S1 Foundation (2026-08-22)

Delivered: the kernel (contexts, plugin instances with epoch-gated activation, reversible effects, typed event bus with scope filtering and a pre-dispatch observe hook); the core spine (event-sourced session with surface projection, LLM seam with protocol validation, tool pipeline, prompt assembly, approval/fs/shell Definitions, agent registry, the one loop driver); capabilities (DeepSeek adapter, retry, fs-local + read-before-edit, `str_replace_editor`, persistent stdio shell + tool, JSONL persistence, headless approval, workspace policy, runtime context); the app layer (composition rows + one patch algorithm, headless runner, CLI, home); and verification (three runtime invariants, replay-from-log, dependency gate).

Outcome: every durable architectural question from PROJECT.md §7 has a code answer, and the architecture is executable — see `ARCHITECTURE.md`.

## Macro route (dependency-ordered; sessions are approximate)

| Session | Architectural outcome | Depends on |
|---|---|---|
| ~~**S1 Foundation**~~ | ✅ Kernel, spine, DeepSeek adapter, minimal tools, JSONL persistence, headless CLI, runtime invariants, replay-from-log, live E2E. | — |
| **S2 Surface contract** | A formal client protocol (JSON-RPC over stdio) as a plugin injecting only `agents`/`sessions`; an interactive terminal surface over it (streaming render, approval prompts, steering, wake latch); `core/persistence` Definition, `agents.resume`, CLI `resume`/`fork`, durable inbox. Two surfaces, one runtime; sessions resumable. | S1 |
| **S3 Effects & authority** | Sandbox policy seam (`read-only` / `workspace-write` / `danger-full-access`, one `writableRoots`), in-process fs fence, shell confinement where the platform allows, tool timeouts/guards, durable `approval/policy` + `sandbox/mode` switching, audit views. Authority is a complete, replayable plane. | S1 (S2 for interactive approval) |
| **S4 Composition & configuration** | Declarative composition files + patch layers on disk, MiniDSH home layout, settings + credentials seams (env / .env / keychain providers), per-session presets via scoped contexts, runtime mount/unmount — the self-recomposable substrate. Capabilities change without code edits; "which tools did this session run" is answerable on replay. | S1, S3 |
| **S5 Context management** | Token metering, compaction seam + basic provider (tool-result pruning and summaries as `surfaceOp: replace`), large-output spill, workspace instructions (AGENTS.md) injection. Long tasks stay in budget without breaking reconstruction. | S1 |
| **S6 Cognition routing & delegation** | Second adapter (OpenAI/Anthropic-compatible generic), model roles (primary / cheap / verifier / vision), subagent seam (in-process child with scoped tools), bounded parallel tools. The model is a capability provider, not the agent. | S4, S5 |
| **S7 Web surface** | Host/client split over the S2 protocol (WebSocket carrier), minimal browser client rendering from events. Web + terminal + headless share one runtime. | S2 |
| **S8 Verification capabilities** | Vision-model verification of screenshots and browser state, an independent verifier role, verification events. Verification is a first-class capability. | S6, S7 |
| **S9+** | Extension authoring and governance (model-written plugins behind approval, evaluation, rollback), desktop shell, MCP bridge if evidence demands. | S4, S8 |

Ordering rationale: the protocol (S2) must exist before any GUI so surfaces never grow semantics; authority (S3) before configuration (S4) so presets cannot widen permissions silently; compaction (S5) before delegation (S6) so child agents inherit bounded context; verification (S8) after routing (S6) because a verifier is a model role.

## Open risks and questions

- **The editor/shell authority asymmetry is real today** (ARCHITECTURE.md §13). It is the single most important thing S3 fixes; until then MiniDSH should not be pointed at a workspace whose surroundings matter.
- The wake latch is unimplemented: input arriving between `cancel()` and driver convergence can be dropped. Harmless for a one-shot CLI, load-bearing for S2's interactive surface.
- No compaction (S5): a long session eventually exceeds the context window with no recovery path.
- Windows shell confinement has no clean backend; S3 may accept `partial` enforcement on win32 as DSH does.
- TypeScript 7 native `tsc` is new (GA 2026-07-08); fallback is 6.0.3 with identical checking. No issues so far.
- When to promote to a workspace: the first out-of-process consumer (the S2 client or the S7 browser client).

## Development record

- **S1 Foundation (2026-08-22)** — Research: DSH `b150a55` studied via core docs, 12 architecture/simplification notes, and a bounded 8-dimension research panel; the Cordis subset DSH actually uses was measured before deciding to write our own kernel. Built in 6 verified phases (kernel → session+llm → seams → agent+loop → capabilities → app+gates). A 3-lens adversarial panel produced 16 findings; 10 were fixed with 7 permanent regressions (the load-bearing one: a cancelled stream persisted tool calls without results, which would have poisoned every later request in the session). Live E2E against `deepseek-v4-flash`: fixed a real bug in a separate workspace and added a test, verified externally (`node --test` exit 0, untouched files byte-identical), 1,397 events, 11/11 tool calls paired, one `request/header` across 7 steps with 18,816 cache-read tokens, ~$0.002. The live log then replayed keylessly (7/7 steps consumed), confirming the log is its own test oracle. Final state: `pnpm check` green (97 tests), 6 commits, not pushed.
