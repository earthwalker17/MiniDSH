# MiniDSH — Project Thesis and Direction

This is the project's thesis, first written on 2026-08-22 and since cut to what still positions it. Where a question has been answered, a line beginning "Outcome:" names where the answer lives.

## 1. What MiniDSH Is

MiniDSH is an architecture-first experiment in building a **minimal but architecturally complete agent harness**.

It is inspired by DeepSeek Harness (DSH). It should not be developed as a fork that gets smaller by deleting packages. DSH is treated as:

- an **architecture textbook**: a mature implementation to study
- a **behavioral oracle**: concrete behaviors, invariants, tests and failure cases
- a **design dataset**: what a modern agent harness ends up needing, and where complexity accumulates

MiniDSH should then re-derive a smaller system from first principles. It is a learning and research project. Product competition is not the objective.

> **Minimal surface. Complete architecture.**

The question it asks:

> **What is the minimum modern agent harness that still preserves the architectural properties required for long-term composition, observability, verification, multi-surface evolution, and maintainability?**

## 2. Why This Project Exists

AI coding tools build working functionality quickly. A common pattern splits a product's features across sessions, and each session implements locally reasonable modules. The result can pass its tests and look complete while becoming structurally weak. The failure is **architectural accretion**:

- features acquire local homes rather than principled homes
- ownership becomes ambiguous
- state crosses subsystem boundaries
- new capabilities require editing unrelated modules
- application and UI concerns leak into runtime semantics
- abstractions arise after the fact as compatibility patches
- future agents must repeatedly rediscover why the system looks the way it does

MiniDSH reverses the process. The system space is designed first. Features then enter it through known seams. Architecture decides what a session should do.

## 3. What DeepSeek Harness Teaches

DSH is built on Cordis, and its model adapters, tools, session infrastructure, agent loop and UI capabilities compose as plugins. The lesson is not the word **plugin**. It is that capabilities have explicit lifecycle, dependency and composition semantics. Cordis frames this as **spatiotemporal composability**:

- **temporal composability**: a component's effects can be unwound when it is removed
- **spatial composability**: a component declares dependencies on capabilities in its context and reacts as they appear, disappear or change

> **Capabilities are mounted into the runtime. They are not permanently baked into a monolithic Agent.**

Primary sources: the [repository](https://github.com/deepseek-ai/deepseek-harness) and the [Cordis paper](https://github.com/cordiverse/paper). Deep links into upstream go stale within weeks, so every other upstream path lives in [`references/`](../references/README.md), pinned to a commit and a date.

## 4. “Self-Evolving” Should Be Treated Carefully

DSH's `plugin_manager` lets an agent install persistent packages into its own runtime, behind full access or a per-call approval (in its default preset since 2026-10-21). This is sometimes summarised as self-evolution. The claim needs more care. A dynamically composable harness does not by itself solve:

- how an agent decides that it needs a new capability
- whether generated extensions are safe
- whether a replacement is better than the previous implementation
- who grants authority to modify the runtime
- how an unsuccessful mutation is evaluated and rolled back
- how persistent self-modification is governed

The substrate enables a **self-recomposable runtime**. Autonomous evolution can be built on it with policy, verification, evaluation, sandboxing and durable state. Dynamic composition is infrastructure. Self-improvement is behavior built on infrastructure.

Outcome: model-written extensions stay refused (BLUEPRINT §2, "Still refused"). What ships is a composition row that names a module (ARCHITECTURE §9).

## 5. The Main Simplification Thesis

DSH already ships a `minimal` preset with a small model-facing tool surface: a persona and one persistent shell, plus image-only file reading and compaction since 2026-10-12 (`references/assumptions.md`). A useful coding agent does not need dozens of overlapping tools. So MiniDSH cannot justify itself by having a "minimal mode".

DSH's minimal preset minimizes what the model sees. MiniDSH should investigate how far the **whole system** can be simplified while preserving the architectural properties. The measures that matter:

- concepts a contributor must understand
- modules a new capability must touch
- how clearly state ownership is defined
- implementation details that leak through contracts
- how easily a provider, tool or capability is replaced or removed
- schema and context exposed to the model
- code a new surface must duplicate
- repository exploration a future coding agent needs
- whether execution can be understood from canonical events, not UI reconstruction

The goal is **fewer concepts + stronger invariants**, not fewer source lines.

## 6. Everything Evolvable Has a Seam

MiniDSH should learn from "Everything is a Plugin" without copying it as a universal rule. Plugin systems cost lifecycle machinery, service definitions, dependency resolution, configuration, package boundaries, debugging indirection and more concepts to learn. MiniDSH can be more selective than DSH:

> **Everything evolvable has a seam.**

A capability deserves a first-class composition boundary when it may realistically need to be:

- replaced
- isolated
- scoped
- dynamically enabled or disabled
- supplied by another implementation
- owned by a different lifecycle
- independently tested or distributed

Pure helpers, local algorithms, types and implementation details do not become plugins for consistency. That leaves a research question:

> **Where should dynamic composition stop?**

Outcome: at a kernel of five mechanisms and nineteen service keys, with everything else ordinary code (ARCHITECTURE §2, §3).

## 7. The Long-Term Architectural Questions

MiniDSH should maintain explicit answers to a few durable questions. CLAUDE.md §3 holds them as session rules. The current answers are in ARCHITECTURE.md.

### 7.1 Capability

What is a capability, and how is it declared, provided, discovered, scoped, replaced and removed?

Outcome: ARCHITECTURE §2 and §3.

### 7.2 State Ownership

Who owns session, agent, workspace, provider, tool, process, policy, configuration and client state? State should not drift between layers because sharing a mutable object is convenient.

Outcome: the ownership table in ARCHITECTURE §3.

### 7.3 Runtime Composition

Is an agent a class with many imported features, or a runtime scope composed from capabilities? Which parts are fixed kernel, which replaceable, which application assembly?

Outcome: ARCHITECTURE §1, §2 and §9.

### 7.4 Canonical Facts and Replay

What is the authoritative record of execution? Can the system reconstruct what happened without reading UI state or scattered logs?

Outcome: ARCHITECTURE §4, and replay from recorded logs in §10.

### 7.5 Effects, Authority, and Safety

The model may propose an action. It must not become the security boundary because it believes the action is safe.

Outcome: ARCHITECTURE §7, with the known gaps in §13.

### 7.6 Multiple Surfaces

Web, TUI, desktop and headless entry points should be surfaces over one runtime, never separate agent implementations.

Outcome: ARCHITECTURE §8.

### 7.7 Evolution

> If a new capability arrives later, can the system explain exactly where it belongs before implementation begins?

Outcome: the table in ARCHITECTURE §11.

## 8. One Runtime, Multiple Surfaces

Web, TUI and desktop are worth building as an architectural test, not as three product rewrites. A surface implements presentation, transport and interaction. It reimplements nothing of session semantics, model routing, tool execution, approval rules, event history, orchestration or verification logic.

DSH documents a similar host, client and carrier separation, and ships web, headless and an Electron desktop application over one runtime's code (`references/dsh/surfaces.md`). MiniDSH need not copy that structure, only hold the invariant:

> **Surface transport and presentation must not own harness semantics.**

If adding a desktop application later requires duplicating the runtime, the early architecture has failed.

Outcome: the terminal and the browser are clients of one protocol. The desktop app (S22.2, 2026-11-20) runs the CLI's `web --json` and does not import the runtime (ARCHITECTURE §8).

## 9. Models Should Be Capability Providers

DSH has a provider-neutral LLM seam, a direct DeepSeek adapter and one generic multi-provider adapter, with no first-party adapter for OpenAI or Anthropic (`references/dsh/llm-providers.md`). MiniDSH should treat provider abstraction as a foundation, not a headline feature.

The more interesting direction is **capability-aware model routing**: one model for primary coding, a cheaper one for bounded subtasks, a multimodal one for screenshots, an independent one for review.

> **The model is a capability provider. It is not identical to the Agent.**

Outcome: three adapters behind one vocabulary, and model roles over a durable base route (ARCHITECTURE §4, §5, §11).

## 10. Multimodal Verification Is Architecturally Interesting

Image support should not be treated as a chat attachment feature only. The higher-level question:

> Can a text-oriented primary coding model delegate visual observation and verification to a model that is actually good at vision?

The architecture must have a clean place for such cognition specialization.

Outcome: built in S8 and S20. A verifier is a `tool-subagent` row plus a `model-roles` entry (ARCHITECTURE §11). The `verification` and `browser` live tests exercise it (§10).

## 11. Architecture-First Development as the Real Experiment

The deepest purpose of MiniDSH is not the harness. It is an experiment in building a large AI-assisted system without letting its architecture dissolve into local feature patches.

AI coding agents are good at locally plausible implementations. They are much less reliable at preserving a global conceptual model across months of growth, unless that model is explicit, inspectable and continuously enforced.

### Feature-first pattern

```text
Session N needs browser verification
→ create browser-verification modules
→ connect them to whatever currently exists
→ document later
```

### Architecture-first pattern

```text
A new capability is proposed
→ identify its layer, owner, contract, state, lifecycle, and dependencies
→ verify that the existing architecture has the correct seam
→ revise the architecture if the seam is conceptually missing
→ implement through that seam
```

Outcome: [CASE-STUDY.md](CASE-STUDY.md) tells how it went, including where it failed. The per-session record is BLUEPRINT §4.

## 12. What MiniDSH Is Not

MiniDSH is not:

- a stripped fork that succeeds by deleting most of DeepSeek Harness
- a clone of Claude Code, Codex, OpenCode or DeepSeek Harness
- a contest to support the largest number of tools
- a "multi-agent swarm" project
- an attempt to maximize plugins or packages
- a project whose architecture is judged by directory depth

It should resist feature pressure when a feature improves neither the architectural experiment nor the minimal useful harness.

## 13. Expected Value of the Project

### Layer 1 — Useful software

A lightweight agent harness that does real daily software-engineering work with low overhead.

### Layer 2 — Reference architecture

A codebase small enough to study, with boundaries clear enough to show another developer how a modern agent harness is assembled.

### Layer 3 — Systems-engineering experiment

> **Can an AI-assisted project be grown architecture-first, with strong boundaries and low conceptual entropy, instead of becoming a sequence of locally successful feature accretions?**

## 14. How to Study DeepSeek Harness

DSH should be read selectively, by tracing one architectural question through its primary sources, never linearly. Historical notes are evidence of design evolution, not automatically the current contract.

Outcome: [`references/`](../references/README.md) maps where each upstream subsystem lives. CLAUDE.md §4 holds the rules for using and refreshing it.

## 15. Initial Strategic Direction

The first phase should not begin with a feature checklist. It should first establish the system boundaries, the dependency direction, the composition rules, state ownership, the event model and a realistic macro sequence.

Outcome: session 1 (2026-08-22) did this. The current shape is ARCHITECTURE.md and the route is BLUEPRINT §2.

## 16. Project Positioning

> **MiniDSH is an architecture-first, local-first reference harness that re-derives the essential structure of a modern coding agent from the minimum useful capability set. It studies DeepSeek Harness as an architectural reference rather than forking it, with the goal of building one small runtime that remains composable, observable, verifiable, provider-neutral, and extensible to multiple user surfaces.**

The project should be presented publicly as an independent educational and engineering experiment inspired by DeepSeek Harness, not as an official DeepSeek project.

## 17. Final Principle

The long-term success criterion is not that MiniDSH has many features. It is that after the project grows, a new contributor, or a new coding-agent session, can still answer the questions of section 7 from the documents, and can say what the system is, how dependencies flow and how execution is verified.

If every new feature requires exceptions, cross-layer imports, compatibility glue or new "manager" modules with ambiguous ownership, stop and repair the architecture before continuing.
