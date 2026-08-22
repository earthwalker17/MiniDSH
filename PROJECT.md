# MiniDSH — Project Thesis and Direction

## 1. What MiniDSH Is

MiniDSH is an architecture-first experiment in building a **minimal but architecturally complete agent harness**.

It is inspired by DeepSeek Harness (DSH), but it should not be developed as a fork whose main strategy is deleting packages until the repository becomes smaller. DeepSeek Harness is instead treated as:

- an **architecture textbook** — a mature implementation to study;
- a **behavioral oracle** — a source of concrete behaviors, invariants, tests, and failure cases;
- a **design dataset** — evidence about what a modern agent harness eventually needs and where complexity tends to accumulate.

MiniDSH should then re-derive a smaller system from first principles.

The project is primarily a learning, research, and public-build project. A useful product should emerge from it, but product competition is not the objective.

The core thesis is:

> **Minimal surface. Complete architecture.**

The interesting question is not “How much of DeepSeek Harness can we delete?”

It is:

> **What is the minimum modern agent harness that still preserves the architectural properties required for long-term composition, observability, verification, multi-surface evolution, and maintainability?**

---

## 2. Why This Project Exists

Earlier agent projects proved that AI coding tools can build a large amount of working functionality quickly. They also exposed a recurring failure mode.

A common AI-assisted development pattern is:

1. define a product;
2. invent a sequence of features;
3. assign one feature cluster to each session;
4. implement locally reasonable modules;
5. repeat until the repository contains many capabilities.

The result can pass tests and appear feature-complete while becoming structurally weak.

The problem is not simply directory depth or file count. A repository with two directory levels can have excellent architecture, while a deeply nested repository can be badly coupled.

The deeper failure is **architectural accretion**:

- features acquire local homes rather than principled homes;
- ownership becomes ambiguous;
- state crosses subsystem boundaries;
- new capabilities require editing unrelated modules;
- application/UI concerns leak into runtime semantics;
- abstractions arise after the fact as compatibility patches;
- future agents must repeatedly rediscover why the system looks the way it does.

MiniDSH reverses this process.

The system space should be understood and designed first. Features should then enter that space through known seams.

Architecture decides what a session should do.

Sessions do not gradually invent the architecture.

---

## 3. What DeepSeek Harness Teaches

DeepSeek Harness is especially useful because its central idea goes deeper than “it has many plugins.”

Its public architecture is built around Cordis and the statement that major parts of the harness — model adapters, tools, session infrastructure, the agent loop, UI-related capabilities, and other services — can be composed as plugins.

The important lesson is not the word **plugin** itself.

The important lesson is that capabilities have explicit lifecycle, dependency, and composition semantics.

Cordis frames this in terms of **spatiotemporal composability**:

- **temporal composability** — a component’s effects can be unwound when it is removed;
- **spatial composability** — a component can declare dependencies on capabilities in its context and react as those capabilities appear, disappear, or change.

This suggests a different model from the conventional object that imports every feature it owns.

Instead of treating “the Agent” as one class containing search, tools, memory, sandboxing, models, and UI, the runtime can be understood as a composition of capabilities that are present for a particular scope.

A useful conceptual shift is:

> **Capabilities are mounted into the runtime; they are not permanently baked into a monolithic Agent.**

That makes replacement, experimentation, isolation, and evolution structurally easier.

Official references:

- DeepSeek Harness repository: https://github.com/deepseek-ai/deepseek-harness
- DeepSeek Harness architecture: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- Package hierarchy: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md
- Module dependency graph: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/module-graph.md
- Subsystem documentation: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/README.md
- Cordis paper: https://github.com/cordiverse/paper

These sources are actively changing. Claude Code should inspect the current repository and primary docs whenever a design decision depends on them.

---

## 4. “Self-Evolving” Should Be Treated Carefully

DeepSeek Harness is often described as enabling self-evolving agents. The direction is useful, but the architectural claim should be more precise.

A dynamically composable harness does not automatically solve:

- how an agent decides that it needs a new capability;
- whether generated extensions are safe;
- whether a replacement is better than the previous implementation;
- who grants authority to modify the runtime;
- how an unsuccessful mutation is evaluated and rolled back;
- how persistent self-modification is governed.

The architectural substrate is better understood as enabling a **self-recomposable runtime**.

Autonomous evolution can then be built on top of that substrate using policy, verification, evaluation, sandboxing, and durable state.

MiniDSH should preserve this distinction.

Dynamic composition is infrastructure.

Self-improvement is behavior built on infrastructure.

---

## 5. The Main Simplification Thesis

DeepSeek Harness already ships a minimal composition with a deliberately tiny model-facing tool surface. Its current minimal preset demonstrates an important point: a useful coding agent does not need dozens of overlapping tools.

The official minimal configuration exposes essentially a persistent shell and a structured file editor while omitting many higher-level conveniences.

References:

- Minimal preset: https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/agent-presets/minimal/agent.cordis.yml
- Minimal JSON-RPC example: https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/jsonrpc-agent
- Tool-surface simplification note: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-08-10-default-presets-single-editor.md

This means MiniDSH cannot justify itself merely by claiming to have a “minimal mode.”

The more interesting target is:

> **Capability minimalism with architectural completeness.**

DeepSeek’s minimal preset minimizes what the model sees.

MiniDSH should investigate how far the **whole system** can be simplified while preserving the important architectural properties.

The objective is therefore not primarily fewer lines or fewer files.

More meaningful simplification metrics include:

- how many concepts a contributor must understand;
- how many modules a new capability must touch;
- how clearly state ownership is defined;
- how many implementation details leak through contracts;
- how easily a provider or tool can be replaced;
- how easily a capability can be removed;
- how much schema/context is exposed to the model;
- how much code a new surface must duplicate;
- how much repository exploration a future coding agent needs;
- whether execution can be understood from canonical events rather than UI reconstruction.

The goal is:

> **fewer concepts + stronger invariants**

rather than merely:

> fewer source lines.

---

## 6. Everything Evolvable Has a Seam

MiniDSH should learn from “Everything is a Plugin” without copying it as a universal rule.

Plugin systems have costs:

- lifecycle machinery;
- service definitions;
- dependency resolution;
- configuration;
- package boundaries;
- debugging indirection;
- more concepts for contributors to learn.

DeepSeek Harness accepts much of this cost because it aims to support a broad, dynamically composable ecosystem.

MiniDSH can be more selective.

A better working principle is:

> **Everything evolvable has a seam.**

A capability deserves a first-class composition boundary when it may realistically need to be:

- replaced;
- isolated;
- scoped;
- dynamically enabled or disabled;
- supplied by another implementation;
- owned by a different lifecycle;
- independently tested or distributed.

Pure helpers, local algorithms, types, and implementation details do not need to become plugins merely for ideological consistency.

This is one of the most important research questions of the project:

> **Where should dynamic composition stop?**

---

## 7. The Long-Term Architectural Questions

MiniDSH should maintain explicit answers to a small number of durable questions.

### 7.1 Capability

What is a capability?

How is it declared, provided, discovered, scoped, replaced, and removed?

How does the runtime distinguish a capability seam from ordinary internal code?

### 7.2 State Ownership

Who owns:

- session history;
- agent state;
- workspace state;
- provider state;
- tool state;
- process state;
- policy/approval state;
- runtime configuration;
- client/UI state?

State should not drift between layers simply because sharing a mutable object is convenient.

### 7.3 Runtime Composition

Is an agent fundamentally a class with many imported features, or a runtime scope composed from capabilities?

Which parts are fixed kernel behavior?

Which parts are replaceable?

Which parts are merely application assembly?

### 7.4 Canonical Facts and Replay

What is the authoritative record of execution?

Can the system reconstruct what happened without reading UI state or scattered logs?

A durable event/session history should make inspection, resume, replay, fork, diagnostics, and verification natural rather than bolted-on.

DeepSeek Harness’s subsystem model and session/event design are important references here.

### 7.5 Effects, Authority, and Safety

Reasoning and authority are different concerns.

The model may propose an action. It must not become the security boundary merely because it believes an action is safe.

Tool execution, sandboxing, policy, approvals, and auditing should have explicit ownership and contracts.

### 7.6 Multiple Surfaces

The long-term product may expose:

- Web;
- TUI;
- Desktop GUI;
- headless/API/SDK entry points.

These should not become separate agent implementations.

They should be multiple surfaces over one runtime.

### 7.7 Evolution

A useful architectural test is:

> If a new capability arrives later, can the system explain exactly where it belongs before implementation begins?

If the answer is repeatedly “make another manager/module and connect it wherever needed,” the architecture is failing.

---

## 8. One Runtime, Multiple Surfaces

The eventual Web + TUI + Desktop direction is valuable, but only if it is treated as an architectural test rather than three product rewrites.

The desired model is conceptually:

```text
                       Web
                        │
TUI ───────────── Client/Surface Contract ─────────── Desktop
                        │
                  Harness Runtime
                        │
        ┌───────────────┼────────────────┐
      Models           Tools          Services
```

A future surface should primarily implement presentation, transport, and interaction behavior.

It should not reimplement:

- session semantics;
- model routing;
- tool execution;
- approval rules;
- event history;
- orchestration;
- verification logic.

DeepSeek Harness has already documented a similar host/client/carrier separation and explicitly reserves room for Web, headless, and future Electron clients.

Reference:

- GUI layering and RPC design note: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md
- Web client architecture note: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md

MiniDSH does not need to copy this structure. It should understand the invariant:

> **Surface transport and presentation must not own harness semantics.**

If adding a Desktop application later requires duplicating the runtime, the early architecture has failed.

---

## 9. Models Should Be Capability Providers

Multi-provider support is useful, but ordinary provider switching is no longer a distinctive idea by itself.

DeepSeek Harness already has:

- a provider-neutral LLM seam;
- a direct DeepSeek adapter;
- a generic multi-provider adapter;
- current configuration paths for providers such as Anthropic and OpenAI, with broader catalog/provider support.

References:

- LLM capability family: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/README.md
- Generic provider adapter: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md
- Provider configuration: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md
- Adding an LLM adapter: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-an-llm-adapter.md

MiniDSH should therefore view provider abstraction as a foundation, not a headline feature.

A more interesting long-term direction is **capability-aware model routing**.

For example:

- one model may be best for primary coding/reasoning;
- another may handle cheap bounded subtasks;
- a multimodal model may inspect screenshots;
- an independent model may perform verification or review.

This suggests:

> **The model is a capability provider; it is not identical to the Agent.**

One runtime may use different cognition providers for different needs without turning each provider into a separate “agent product.”

---

## 10. Multimodal Verification Is Architecturally Interesting

DeepSeek’s own model path is not the only possible cognition path, and image support should not be treated merely as a chat attachment feature.

DeepSeek Harness already contains a durable attachment seam where image bytes are persisted independently and session/model-visible state carries immutable references rather than temporary UI URLs or inline blobs.

Reference:

- Attachment subsystem: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md
- Attachment package family: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/README.md

MiniDSH can eventually explore a higher-level question:

> Can a text-oriented primary coding model delegate visual observation and verification to a model that is actually good at vision?

That fits naturally with prior browser-verification experience, but here it should be designed as an architectural capability rather than a late feature.

Potential future examples include:

- screenshot validation;
- browser-state inspection;
- visual regression judgment;
- document/image understanding;
- independent verifier models.

The exact implementation is intentionally deferred.

The important principle is that the architecture must have a clean place for such cognition specialization.

---

## 11. Architecture-First Development as the Real Experiment

The deepest purpose of MiniDSH is not the harness itself.

The project is also an experiment in how to build large AI-assisted systems without allowing architecture to dissolve into local feature patches.

AI coding agents are excellent at producing locally plausible implementations.

They are much less reliable at preserving a global conceptual model across months of feature growth unless that model is explicit, inspectable, and continuously enforced.

MiniDSH therefore tests a different development process:

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

The second process should make the repository increasingly easier to extend rather than increasingly harder to understand.

---

## 12. What MiniDSH Is Not

MiniDSH is not:

- a stripped fork whose success metric is deleting most of DeepSeek Harness;
- a clone of Claude Code, Codex, OpenCode, or DeepSeek Harness;
- a contest to support the largest number of tools;
- a “multi-agent swarm” project;
- an attempt to maximize plugins or packages;
- a project whose architecture is judged by directory depth;
- a sequence of unrelated sessions that each add a new feature;
- a product that needs three separate implementations for Web, TUI, and Desktop.

It should resist feature pressure when a feature does not improve the architectural experiment or the minimal useful harness.

---

## 13. Expected Value of the Project

MiniDSH has three useful layers of value.

### Layer 1 — Useful software

A lightweight agent harness that can perform real daily software-engineering tasks with low unnecessary overhead.

### Layer 2 — Reference architecture

A codebase small enough to study, with architectural boundaries clear enough that another developer can understand how a modern agent harness is assembled.

### Layer 3 — Systems-engineering experiment

A practical answer to a broader question:

> **Can an AI-assisted project be grown architecture-first, with strong boundaries and low conceptual entropy, instead of becoming a sequence of locally successful feature accretions?**

Even if MiniDSH never attempts to become a major commercial agent product, success at the third layer makes the project worthwhile.

---

## 14. How to Study DeepSeek Harness

Claude Code should use DeepSeek Harness selectively and deliberately.

Do not attempt to read the entire repository linearly.

Instead, use targeted architectural questions and trace them through:

1. official architecture docs;
2. subsystem docs;
3. package/group README files;
4. module/dependency graph;
5. service definitions and provider implementations;
6. composition/configuration;
7. tests;
8. implemented architecture notes explaining why boundaries exist.

Especially useful starting points:

- Repository root: https://github.com/deepseek-ai/deepseek-harness
- `AGENTS.md`: https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md
- Architecture: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- Packages: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md
- Module graph: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/module-graph.md
- Subsystems: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/README.md
- Cordis paper: https://github.com/cordiverse/paper
- Package regrouping rationale: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-29-package-regrouping.md
- Agent scope design: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md
- GUI/RPC layering: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md
- LLM family: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/README.md
- Minimal preset: https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/agent-presets/minimal/agent.cordis.yml
- Attachment subsystem: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md

Search the current repository for newer decisions when these files reference superseded or archived notes.

Historical notes are evidence of design evolution, not automatically the current contract.

---

## 15. Initial Strategic Direction

The first phase of the project should not begin by implementing a long feature checklist.

It should first establish:

- the architectural thesis;
- the system boundaries;
- the dependency direction;
- capability/composition rules;
- state ownership;
- the canonical session/event model;
- effect/authority boundaries;
- application/surface boundaries;
- provider/model boundaries;
- repository topology;
- verification philosophy;
- a realistic macro sequence for implementing the system.

Only then should concrete capabilities fill those spaces.

The first implementation skeleton should be valuable because it makes the architecture executable and testable — not because it prematurely creates every future feature.

A successful initial architecture should make future questions easier:

- “Where does this belong?”
- “What contract does it implement?”
- “What state may it own?”
- “What can depend on it?”
- “Can it be replaced?”
- “Can it be removed?”
- “How is it tested?”
- “Does a new UI need to know about it?”

The architecture should give mostly unambiguous answers.

---

## 16. Project Positioning

A concise description of MiniDSH is:

> **MiniDSH is an architecture-first, local-first reference harness that re-derives the essential structure of a modern coding agent from the minimum useful capability set. It studies DeepSeek Harness as an architectural reference rather than forking it, with the goal of building one small runtime that remains composable, observable, verifiable, provider-neutral, and extensible to multiple user surfaces.**

The project should be presented publicly as an independent educational and engineering experiment inspired by DeepSeek Harness, not as an official DeepSeek project.

---

## 17. Final Principle

The long-term success criterion is not that MiniDSH has many features.

It is that after the project grows, a new contributor — or a new coding-agent session — can still answer:

- what the system is;
- what each layer owns;
- where a capability belongs;
- how dependencies flow;
- where truth is stored;
- how effects are controlled;
- how execution is verified;
- how a surface talks to the runtime;
- how a component can evolve without destabilizing unrelated code.

If those answers remain clear, MiniDSH is succeeding.

If every new feature requires exceptions, cross-layer imports, compatibility glue, or new “manager” modules with ambiguous ownership, stop and repair the architecture before continuing.
