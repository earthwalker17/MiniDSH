# src/core

Core holds the contracts capabilities are written against and the drivers that do not vary per deployment. It imports `kernel` and other `core`. The layers above import it, but only `app` and `test-support` may import `core/loop`. [ARCHITECTURE §1](../../docs/ARCHITECTURE.md#1-layers-and-dependency-direction) has the rule. [`scripts/check-deps.ts`](../../scripts/check-deps.ts) enforces it and keeps core acyclic at file level, so a package's `events.ts` and `types.ts` sit below its `index.ts`. A package with a service either defines a seam that a capability provides, or is a definition that ships its driver, as `jobs/index.ts` puts it: it exports the plugin that provides its own service.

## Start here

- [`session/types.ts`](session/types.ts): what an event is, and which kinds are model history.
- [`loop/driver.ts`](loop/driver.ts): the order of one turn's records.
- [`tools/registry.ts`](tools/registry.ts): the path from a model's call to a tool body.

## Reading order

1. `scope.ts`. How does a registration reach one agent only?
2. `session/types.ts`, `session/session.ts`. What is an event, and what happens on append?
3. `session/surface.ts`. How is model history derived from the log?
4. `llm/types.ts`, `llm/runtime.ts`. What is a provider-neutral request, and who picks the adapter?
5. `agent/index.ts`. What is an agent, and how is its inbox durable?
6. `loop/factory.ts`. What does creation write before anyone sees the agent?
7. `loop/driver.ts`. In what order does a turn write its records?
8. `tools/registry.ts`. What stands between a call and a body?
9. `sandbox/index.ts`. Under what authority does a call run?
10. `effects/events.ts`, `approval/index.ts`. What does a person consent to, and what is recorded after?
11. `session/repair.ts`, `agent/repair.ts`. What does a resume write for a turn a crash left open?
12. `jobs/index.ts`. How does work outlive its call and still report its end?
13. `compaction/index.ts`, `metering/index.ts`. How does history shrink, and who measures pressure?
14. Each `invariant.ts`. What is refused before it enters the log?

## Modules

| Module | Owns | DSH counterpart | Where MiniDSH differs |
|---|---|---|---|
| `session`, `persistence` | the append-only log, its surface, paging and own repair. The read seam over stored logs | `packages/core/session`, `packages/session/session-persistence` | Fewer event kinds, one header version where upstream has format generations. Core defines the read side only. |
| `agent`, `loop` | the `Agent` contract, registry, inbox, resume, fork, composed crash repair. The driver and the creation transaction | `packages/core/agent`, `packages/core/agent-loop` | A step joins its concurrent work, delegations included, before it ends. Upstream gets children's results later through inbox lanes. |
| `tools` | definitions, guards, restrictions, the pipeline from a call to a body | `packages/core/tools` | Same one-lane batch. MiniDSH adds a durable `tool/dispatch` after the gate. |
| `llm`, `metering` | the provider-neutral vocabulary, adapter registry, `llm/stream`. A pure fold of context pressure | `packages/llm/llm`, `packages/llm/token-meter` | Closed unions and a snapshot catalog. Upstream's blocks are extensible and its model lists live. The meter has no service key. |
| `prompt` | ordered sections, strict `{{var}}` variables, `assemble` | part of `packages/core` | Not compared. |
| `sandbox`, `presets` | the per-call authority stamp, the writable ceiling, the acceptance knob. Named pairs over the two knobs | `packages/sandbox/sandbox` and `sandbox-policy`, `packages/interaction/permission-presets` | The ceiling is the workspace root alone, and that root never moves. Upstream adds temp and operator roots and moves the root. Fewer presets. |
| `approval`, `effects` | the ask, its audit pair, the policy, exact-subject grants. The `effect/recorded` and `EffectIntent` vocabulary | `packages/interaction/user-approval`. `effects`: none | Same outcomes and policy. The ask carries a runtime-built subject and can mint a session grant. Upstream records no effect per call. |
| `fs`, `shell` | seams only: file access with its fence contract. A persistent shell per agent with its refusal contract | `packages/fs`, `packages/shell` | Not compared here. See the providers in [`capabilities`](../capabilities/README.md). |
| `jobs` | owner-scoped background work: identity, admission, one terminal fact, delivery through the inbox | `packages/jobs/jobs`, `packages/jobs/jobs-local` | A durable bracket, closed `lost` and reported after a crash, with a wake budget. Upstream's registry is in memory and wakes unbounded by default. |
| `compaction`, `spill` | seams only: `compactNow`, its bracket and the pure planner. A store for output with no other home | `packages/compaction`, `packages/spill` | Not compared. No tool-result pruner ([§12](../../docs/ARCHITECTURE.md#12-divergences-from-deepseek-harness-the-ones-that-still-shape-decisions)). |
| `attachments`, `credentials`, `settings` | seams only: image references committed before their event. Secret names resolved per call. Defaults a wire client may write | `packages/attachment/attachment`, `packages/credentials/credentials`. `settings`: not compared | Images only. Upstream also carries generic files, and its credential seam keeps per-plugin records and sign-in grants. |
| `invariants` | a deployment-global registry of pre-commit checks. `firstViolation` for stored logs | not researched | Not compared. |

Top-level files: `scope.ts` (per-agent registration layers), `json.ts` (the JSON check on every append), `ids.ts` (branded ids), `text.ts` (neutralizes text the runtime did not write), `process.ts` (a child process's start, environment and tree kill).

## The contract

- [§3 Core contracts (`src/core`)](../../docs/ARCHITECTURE.md#3-core-contracts-srccore): the ownership table.
- [§4 Canonical facts: the session log](../../docs/ARCHITECTURE.md#4-canonical-facts-the-session-log): `session/session.test.ts`, `loop/resume.test.ts`.
- [§5 LLM vocabulary and the adapters](../../docs/ARCHITECTURE.md#5-llm-vocabulary-and-the-adapters): `llm/llm.test.ts`.
- [§6 The loop and the tool pipeline](../../docs/ARCHITECTURE.md#6-the-loop-and-the-tool-pipeline): `loop/loop.test.ts`, `loop/dispatch.test.ts`, `tools/tools.test.ts`.
- [§7 Authority](../../docs/ARCHITECTURE.md#7-authority): `sandbox/sandbox.test.ts`, `approval/approval.test.ts`.

The scope contract in §2 is held by `scope.test.ts`. The `invariant.ts` files hold the pre-commit form of these rules. A new contract, event kind or fold goes where [§11 Where new things go](../../docs/ARCHITECTURE.md#11-where-new-things-go) says.
