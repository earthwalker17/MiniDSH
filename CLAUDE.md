# MiniDSH — Project Constitution
## 1. Mission
MiniDSH is an architecture-first, local-first, small-but-complete agent harness reference implementation.
It is a learning and systems-engineering project, not a competitor to Claude Code, Codex, DeepSeek Harness (DSH) or other general-purpose agents: study a mature harness, find the invariants that make it composable and evolvable, rebuild the minimum system that keeps them.
> **Minimal surface. Complete architecture.**

DSH is an **architecture textbook and behavioral oracle**, not a repository to fork and prune. Prefer independent implementation. Copied or adapted code keeps its required license/attribution and a provenance record.

## 2. Architecture First
Architecture defines sessions; sessions do not define architecture.
Before implementing a meaningful capability, identify:
- its layer and owning subsystem;
- its stable seam/contract;
- the state it owns and must not own;
- dependency direction;
- lifecycle and effects;
- how it is persisted, observed, verified and removed;
- whether it is a runtime capability, ordinary internal logic, or application assembly;
- how multiple surfaces interact with it.

A feature with no clear home is an architecture problem before an implementation task.
Architecture-first is **not** abstraction-first: no speculative frameworks, empty layers, or indirection without real boundaries. Pre-design the system space. Instantiate abstractions only when they express real invariants.

## 3. Durable Architectural Questions
Always preserve clear answers to:
1. **Capability**: how one is provided, discovered, replaced, scoped, composed.
2. **State ownership**: who owns session, workspace, provider, tool, runtime, policy, UI state.
3. **Composition**: what is fixed infrastructure, dynamically composable capability, or application assembly.
4. **Facts/history**: which canonical record explains what happened and supports inspection, resume, replay, fork.
5. **Effects/authority**: who authorizes side effects, with policy, sandboxing, approvals and reasoning kept separate.
6. **Surfaces**: how Web, TUI, Desktop, API and headless clients share one runtime.
7. **Evolution**: how a capability is added, replaced or removed without unrelated implementation knowledge.

Everything evolvable has a seam, and "everything is a plugin" is not dogma (`docs/PROJECT.md` §6).

## 4. DeepSeek Harness as Reference
For overlapping design questions, study the **current official repository and primary sources**, in this order of evidence: current official code/behavior → official architecture/subsystem docs → implemented architecture notes/tests → Cordis paper and official DeepSeek material → secondary commentary.
Verify current behavior. Do not freeze old assumptions. Reproduce principles and invariants, not implementation complexity.
`references/` is the curated local map of DSH, pinned to a commit and a date. A map, never a copy: no source dumps, every claim carries a repository path.
- An **ordinary session** reads the `references/` files its task touches FIRST, researches only those parts of the current DSH, and writes back what it falsified (the file and `references/assumptions.md`).
- A **`.5` hardening session** re-researches the current DSH broadly, reruns the assumptions ledger, works through each file's "Not read" list, and moves the pin.

## 5. Project Documents
Use exactly four primary context documents:
- `CLAUDE.md`: constitution and execution rules. Under 200 lines.
- `docs/PROJECT.md`: thesis, positioning, scope, research context.
- `docs/ARCHITECTURE.md`: the architecture MAP: current state, not history.
- `docs/BLUEPRINT.md`: the rolling long-term plan and compact development record.

The first two are stable and change rarely. `CLAUDE.md` and `README.md` stay at the repository root. The other three live in `docs/`.
There is no fifth context document. `references/` (§4) is consulted by topic, never reread whole. `.claude/skills/docs-maintenance/SKILL.md`, the maintenance procedure, is read only when maintaining documents.
Reader documents are NOT session context: `docs/GUIDE.md` (the user guide), `docs/CASE-STUDY.md` (the method, dated), `src/README.md`, the layer READMEs under `src/kernel`, `src/core`, `src/capabilities` and `src/app`, `src/capabilities/protocol/README.md`, `desktop/README.md`.
At every substantive session start, read the four documents and the session's brief in `docs/BLUEPRINT.md`, then the code the task touches: the architecture map says where. A full-repository read belongs to `.5` checkpoints (§6).
**The documents are maps.** Detail and rationale live in the owning code's comment, in tests and in commits. A paragraph stays only if a future session without it would misunderstand the system, choose the wrong home, or not know where to look next. Rewriting one shorter is not compaction.
**Growth rule.** A session adds rows and lines to `ARCHITECTURE.md`: an owner, an event kind, a home, an invariant with its owning file, a limitation. A reason stays only where its absence invites a plausible wrong change. The brief states the session's allowance (typically ≤ 3 KB), its record entry what it used.
After each substantive session, update `docs/ARCHITECTURE.md` to the actual implementation and `docs/BLUEPRINT.md` (compress completed work, move the next session to the top). Delete stale claims instead of accumulating contradictory history.
State a truth once. Each of the three `docs/` context documents has fixed section responsibilities: new material goes into the section that owns its topic, never into a parallel section, a chronological appendix, or a second statement in another section or document. Tables (ownership, RPC, change-location, file map, retention, arcs) are lookup material and keep every row.
**Budgets** live only in `scripts/check-docs.ts` (`--sections` prints them). A ceiling moves only with the user's agreement.
**Compaction is delegated** (the `docs-maintenance` skill). Past 90% of a ceiling, or on a section warning, the session runs that procedure in subagents (§8) and keeps working, queuing its own additions to the document. It judges the claim review (run by agents other than the authors; invariants, owners, must-not-own clauses, seams, homes, code-cited sections, pointers), not the prose, and rewrites text only where compaction surfaces an architectural decision.
`README.md` keeps eleven sections in order: what it is, quick start, what you get, status and limitations, the question, architecture, what it learned from DSH, the experiment, verification, documents and help, license. It is written for a first-time visitor. A user-facing command, flag, default or limitation goes into its quick start or status section, or into the guide. A claim that needs the architecture to parse belongs in `docs/ARCHITECTURE.md`, with a link.
Project docs are canonical. Documentation drift is a defect.

## 6. Blueprint and Session Policy
The blueprint's macro route may change when evidence changes the architecture. A new idea does not automatically deserve a new subsystem or session.
Use **Plan Mode** automatically for complex or architecture-affecting sessions.
Before implementation, the plan must state: the boundary being changed, why the change belongs there, invariants/contracts to preserve, implementation phases, verification strategy, and documentation impact.
Two kinds of session:
- An **ordinary session** advances one route entry. §4, §5 and §10 say what it researches, reads and validates.
- A **`.5` hardening checkpoint** reviews the system as one architecture: a repo-wide read, invariants re-audited against the code, assumptions falsified, DSH and `references/` refreshed (§4), documents past 90% compacted (§5), the broad live evidence rerun (§10).

Checkpoints follow a CLUSTER of architectural change, never mechanically after every session.

## 7. Execution and Commits
Implement in bounded phases or modules. After each meaningful phase:
1. run relevant verification;
2. fix failures before expanding scope;
3. make a focused Git commit when the phase is coherent and green.

Do not hold a large session in one uncommitted diff.

Keep simple work simple: for low-risk local tasks, the shortest clear solution, without ceremonial abstractions or analysis loops.

## 8. Sub-agents and Dynamic Workflows
Use sub-agents for bounded research, independent inspection, parallelizable implementation, test analysis and review, when this protects the main context. The parent remains the architectural decision-maker and integrator.
**Fix the agent count before the run, and never let it grow during one.**
- A workflow's total must be readable off its script without knowing a single result.
- A stage whose WIDTH comes from a previous stage's output is forbidden ("no per-finding fan-out"): no agent per file, failure, finding, candidate or trivial task.
- A review of N dimensions is N agents, not N × findings × verifiers.
- A prohibition without a number in the script did not hold (S9 reached 46). State the ceiling in the plan before launching: a dozen is generous, twenty is a lot.
- A stage that cannot be sized in advance is done in the parent.
- The S22.5 release checkpoint ran under a ceiling of 70 agents, fixed in its plan and approved by the user as an exception that leaves the rule unchanged.

**Verify and synthesize in the parent.** Adversarial checking is this agent reading the code, not another tier of agents. A finding worth keeping is one the parent can ground in a file and a line and, where it matters, reproduce. Prefer bounded reviewers or small fixed panels to recursive swarms.
Each delegated task needs a narrow scope, explicit boundaries and a compact expected return. If delegation materially raises token use without raising output quality, stop and simplify.
A killed workflow can leave files in the repository: check `git status` before continuing.
Never link this repository's `node_modules` into a worktree or scratch directory: a later recursive delete of that directory follows the link and destroys the real dependency tree. It has happened twice. `.claude/hooks/guard-repo.mjs` enforces the rule. A worktree that needs dependencies runs its own `pnpm install`. The source runs without a build, so `git show <rev>:<path>` usually replaces a worktree.

## 9. Persistent Memory
Use Claude Code's persistent memory mechanism for concise cross-session handoff.
At each substantive session end, persist: completion state; important architectural decisions not already in project docs; relevant environment facts; unresolved risks/questions; the next intended session/goal.
Consult that memory at the next session start. It is a handoff aid, not a competing source of project truth.

## 10. Verification Standard
Passing tests is necessary but not sufficient. Every substantive session must finish with:
- relevant automated tests;
- typecheck/lint/build or equivalent checks;
- targeted invariant checks where appropriate;
- a bounded adversarial review;
- a **live end-to-end run using a real model API**.

The live E2E must exercise the real MiniDSH runtime against a real workspace/task and prove that useful software-engineering work can be completed through it. Mock-only success does not count: never replace required live validation with mocks to save effort. Use paid API calls deliberately and keep them bounded.
DeepSeek is the default development provider unless the architecture under test requires another. Choose the current suitable official model at setup time. Never hard-code stale names.
**Validation is proportionate to what changed.**
- An ordinary session runs the FULL repository gates (`pnpm check` on Windows and under WSL 2 with the `MINIDSH_EXPECT_*` flags) and, live, once, the ONE arc that exercises its change or the few arcs whose premises it touches.
- Repeated full suites (every arc three times per host, `live.yml`) belong to `.5` hardening checkpoints, release candidates, and a change to the loop, the session log or the protocol host.
- A flake is never cleared by one lucky pass: an ordinary session that touches an arc with a recorded flake reruns THAT arc and reports the per-run numbers.

## 11. Environment and Secrets
Inspect the actual local toolchain when work depends on it.
If a missing runtime, dependency, credential, platform capability or tool would materially lower implementation or validation quality, do not silently degrade or work around it. Tell the user, or install/configure it after authorization.
Toolchain upgrades are acceptable when justified.
Never expose, print, commit or store secrets in the repository. Credentials belong in the machine/user environment or secure credential storage.

## 12. Git and Push Discipline
Remote: `https://github.com/earthwalker17/MiniDSH.git`
A session is eligible to push only after:
1. planned work is complete;
2. repository verification is green;
3. adversarial review is resolved;
4. real-model live E2E passes;
5. `docs/ARCHITECTURE.md` and `docs/BLUEPRINT.md` are current;
6. the user explicitly approves the session.

Do not push without explicit user approval.

## 13. Design Restraints
Do not optimize for raw feature count, package count, directory depth, or line-count reduction.
Optimize for fewer concepts, stronger invariants, explicit ownership, narrow dependency edges, replaceable seams, readable composition, bounded model-facing surface, observable behavior, testable contracts, and low future exploration cost.
Do not let UI state become runtime truth, provider-specific behavior leak through the system, or model reasoning become the authority/security boundary.
A deeper directory tree is not architecture: dependency topology and ownership matter more than nesting.
Do not build separate Web, TUI, and Desktop agents. Build one runtime with multiple surfaces.
Do not add compatibility layers for contracts with no real external consumer unless evidence requires them.

## 14. Final Decision Rule
When a locally convenient shortcut conflicts with a known architectural invariant, protect the invariant.
When an elaborate abstraction has no demonstrated need but a simple implementation preserves the seam, choose the simple implementation.
The goal is a small system whose shape remains clear as it grows.
